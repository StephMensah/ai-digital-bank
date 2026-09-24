/**
 * Cross-border remittance — behind the FEATURE_REMITTANCE flag.
 *
 * The flag is checked on every request rather than at mount time, so turning it
 * on or off is a restart with a changed variable, not a code change. With the
 * flag off the whole surface answers 404 feature_disabled: a switched-off
 * feature should look absent, not merely forbidden, because "forbidden" tells a
 * stranger the thing exists.
 *
 * Money leaves through the same ledger, the same risk scoring and the same
 * review queue as any other payment. Nothing here posts on its own.
 */

import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { loadAccount, assertWithinLimits, openTransaction, settleTransaction, failTransaction, GL } from '../core/ledger.js';
import { scoreTransaction } from '../services/risk.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { verifySecret } from '../lib/crypto.js';
import { normaliseMsisdn } from '../lib/msisdn.js';
import { readStepUp } from './compat.js';
import * as remit from '../providers/remittance.js';

export const remittanceRouter = Router();

/** The flag gate. First middleware, before authentication: an off feature
 *  reveals nothing at all, not even whether you are signed in. */
remittanceRouter.use((_req, res, next) => {
  if (!config.features.remittance) {
    return res.status(404).json({
      error: { code: 'feature_disabled', message: 'Not found' }
    });
  }
  next();
});

remittanceRouter.use(authenticate('customer'));

const sendLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

/* A quote is priced here and held here. Letting the client send back a price it
   claims we quoted would let it choose its own rate. */
const QUOTES = new Map();
const rememberQuote = (customerId, q) => {
  QUOTES.set(q.id, { ...q, customerId });
  /* bounded: quotes expire in ten minutes, so sweeping on write is enough */
  const now = Date.now();
  for (const [id, held] of QUOTES) if (Date.parse(held.expiresAt) < now) QUOTES.delete(id);
  return q;
};

/** Where money can go, and how it arrives. */
remittanceRouter.get('/corridors', (_req, res) =>
  res.json({ corridors: remit.corridors() }));

/** Price a send. Nothing is reserved and nothing moves. */
remittanceRouter.post('/quotes',
  validate(z.object({
    corridor: z.string().min(2).max(2),
    amountMinor: z.number().int().positive().max(100_000_000)
  })),
  (req, res, next) => {
    try {
      const corridor = remit.findCorridor(req.body.corridor);
      if (!corridor) throw notFound('We do not send to that country yet');
      const quote = remit.quote({ corridor, amountMinor: req.body.amountMinor });
      if (!quote) throw badRequest('That is less than the fee. Send a larger amount.');
      res.json({ quote: rememberQuote(req.customer.id, quote) });
    } catch (err) { next(err); }
  });

/**
 * Send. PIN and a step-up token are both required and both verified here — the
 * screen asking for them is not the thing that enforces them.
 */
remittanceRouter.post('/transfers',
  sendLimiter, requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid().optional(),
    quoteId: z.string().uuid(),
    recipient: z.object({
      name: z.string().min(2).max(100),
      msisdn: z.string().optional().transform((v) => (v ? normaliseMsisdn(v) || v : v)),
      accountNumber: z.string().min(4).max(34).optional(),
      bankName: z.string().max(80).optional(),
      relationship: z.string().max(40).optional()
    }),
    purpose: z.string().min(2).max(60),
    pin: z.string().regex(/^\d{4}$/),
    stepUpToken: z.string()
  })),
  async (req, res, next) => {
    try {
      const c = req.customer;
      if (c.must_change_pin) throw badRequest('Set your PIN before sending money');
      if (!verifySecret(req.body.pin, c.pin_hash)) {
        return res.status(403).json({ error: { code: 'invalid_pin', message: 'That PIN is not right. Nothing has moved.' } });
      }
      if (!readStepUp(req.body.stepUpToken, c.id, 'commit')) {
        return res.status(403).json({ error: { code: 'invalid_step_up', message: 'That confirmation has expired. Start again.' } });
      }

      const held = QUOTES.get(req.body.quoteId);
      if (!held || held.customerId !== c.id) throw notFound('That quote is no longer available. Get a new one.');
      if (Date.parse(held.expiresAt) < Date.now()) {
        QUOTES.delete(held.id);
        return res.status(409).json({ error: { code: 'quote_expired', message: 'That rate has expired. Get a new quote.' } });
      }

      const accountId = req.body.accountId
        || (await query('SELECT id FROM accounts WHERE customer_id=$1 ORDER BY created_at LIMIT 1', [c.id])).rows[0]?.id;
      if (!accountId) throw notFound('No account to send from');

      const account = await loadAccount(accountId, c.id);
      await assertWithinLimits(account, held.debitMinor);

      /* Cross-border is inherently higher risk than an on-us transfer: a new
         country and a new recipient both belong in the score, not in a note. */
      const risk = await scoreTransaction({
        customer: c, account,
        intent: {
          amountMinor: held.debitMinor, kind: 'remittance', channel: 'app',
          method: 'cross_border', crossBorder: true, destinationCountry: held.corridor,
          counterpartyIsNew: true
        }
      });

      if (risk.action === 'decline') {
        await audit({ ...auditFrom(req), action: 'remittance.declined_by_risk', entity: 'account', entityId: account.id, after: risk });
        return res.status(422).json({
          error: { code: 'payment_blocked', message: 'We stopped this transfer for your safety. Contact support to release it.', details: { reasons: risk.reasons } }
        });
      }

      const { transaction, replayed } = await openTransaction({
        account, direction: 'debit', kind: 'remittance', amountMinor: held.debitMinor,
        channel: 'app', provider: 'remittance',
        counterparty: { ...req.body.recipient, country: held.corridor },
        metadata: {
          narration: `To ${req.body.recipient.name}, ${held.country}`,
          purpose: req.body.purpose,
          quote: { rate: held.rate, feeMinor: held.feeMinor, receives: held.receives, currency: held.currency }
        },
        idempotencyKey: req.idempotencyKey, risk,
        status: risk.action === 'review' ? 'held' : 'processing'
      });
      if (replayed) return res.json({ transaction, replayed: true });

      /* A held cross-border transfer waits for a person. The money is reserved,
         not taken — exactly as a held domestic payment behaves. */
      if (risk.action === 'review') {
        await audit({ ...auditFrom(req), action: 'remittance.held_for_review', entity: 'transaction', entityId: transaction.id });
        return res.status(202).json({
          transaction,
          next: { type: 'in_review', message: 'This transfer is with our team for a quick check. We will text you shortly.' }
        });
      }

      /* Money is reserved from here on. Anything that throws before the
         transfer settles must release the reservation: an unhandled error used
         to leave the transaction in 'processing' for ever, with the customer's
         money neither sent nor returned. */
      let out, settled;
      try {
        out = await remit.payout({ reference: transaction.reference, quote: held, recipient: req.body.recipient });
        if (!out.accepted) {
          await failTransaction({ transactionId: transaction.id, reason: out.reason || 'partner_rejected' });
          return res.status(502).json({ error: { code: 'upstream_error', message: 'Our partner could not accept this transfer. Nothing has moved.' } });
        }
        QUOTES.delete(held.id);
        settled = await settleTransaction({
          transactionId: transaction.id, providerRef: out.providerRef, glCounterparty: GL.REMITTANCE_SETTLEMENT
        });
      } catch (err) {
        await failTransaction({ transactionId: transaction.id, reason: 'send_failed' }).catch(() => {});
        throw err;
      }
      await audit({ ...auditFrom(req), action: 'remittance.sent', entity: 'transaction', entityId: transaction.id });

      res.status(202).json({
        transaction: { ...transaction, ...settled },
        quote: { receives: held.receives, currency: held.currency, rate: held.rate, feeMinor: held.feeMinor },
        next: { type: 'processing', expectedBy: out.expectedBy }
      });
    } catch (err) { next(err); }
  });

/** Where a transfer has got to. */
remittanceRouter.get('/transfers/:reference', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.reference=$1 AND a.customer_id=$2`,
      [req.params.reference, req.customer.id]
    );
    if (!rows[0]) throw notFound('No such transfer');
    res.json({ transaction: rows[0] });
  } catch (err) { next(err); }
});
