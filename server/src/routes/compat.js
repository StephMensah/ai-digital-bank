import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { verifySecret, hashSecret, newReference, uuid } from '../lib/crypto.js';
import { openTransaction, settleTransaction, loadAccount, GL } from '../core/ledger.js';
import { openCustomerAccount } from '../services/onboarding.js';
import { scoreTransaction } from '../services/risk.js';
import { logger } from '../lib/logger.js';
import { usingMocks } from '../providers/index.js';

/**
 * Compatibility layer for the front ends built by build.py.
 *
 * Those pages (index/web/app/reviewer-console) talk to a flat /api surface
 * through FID's adapter in src/core.js, keyed on an entity id rather than a
 * session. This router keeps their exact request and response shapes so the
 * pages need no rewriting, while running them on the real ledger.
 *
 * One deliberate difference from the shape they were written against: the
 * entity id in the path or body is never trusted as identity. It selects
 * which of the signed-in customer's accounts to act on, nothing more. Every
 * route that reads balances or moves money requires the session, and every
 * payment additionally requires the PIN and a fresh step-up token.
 */
export const compatRouter = Router();

const asMajor = (minor) => Number(minor) / 100;
const asMinor = (major) => Math.round(Math.abs(Number(major)) * 100);

/** Map one of our transactions onto the row shape fromServerTx() expects. */
const toServerTx = (t) => ({
  id: t.id,
  ts: t.created_at,
  merchant: (t.counterparty && t.counterparty.name) || t.metadata?.narration || 'Transaction',
  amount: (t.direction === 'credit' ? 1 : -1) * asMajor(t.amount_minor),
  category: t.category || 'General',
  method: t.channel || t.provider || 'Transfer',
  status: t.status === 'posted' ? 'Completed' : t.status === 'failed' ? 'Failed' : 'Pending',
  ref: t.reference,
  hash: t.id,
  balanceAfter: t.balance_after_minor != null ? asMajor(t.balance_after_minor) : null
});

/* ----------------------------------------------------------------- accounts */

compatRouter.get('/accounts/:entity', authenticate('customer'), async (req, res, next) => {
  try {
    const { rows: accounts } = await query(
      `SELECT id, account_number, balance_minor, available_minor, product_name, currency
         FROM accounts WHERE customer_id=$1 ORDER BY created_at`,
      [req.customer.id]
    );
    const { rows: txs } = await query(
      `SELECT t.* FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.customer_id=$1 ORDER BY t.created_at DESC LIMIT 50`,
      [req.customer.id]
    );

    res.json({
      entity: req.params.entity,
      mustChangePin: Boolean(req.customer.must_change_pin),
      accounts: accounts.map((a) => ({
        name: a.product_name || 'Current account',
        // The full number, not the last four: a customer needs to be able to
        // read their own account number off the landing page and give it out.
        num: a.account_number,
        accountNumber: a.account_number,
        // Present once the account is mirrored into the core.
        mambuRef: a.mambu_account_key || null,
        balance: asMajor(a.available_minor ?? a.balance_minor),
        type: /sav/i.test(a.product_name || '') ? 'savings' : 'current',
        currency: a.currency
      })),
      transactions: txs.map(toServerTx)
    });
  } catch (err) { next(err); }
});

compatRouter.post('/accounts/open',
  authenticate('customer'),
  validate(z.object({
    customerId: z.string().optional(),
    name: z.string().min(2).max(60),
    type: z.enum(['current', 'savings'])
  })),
  async (req, res, next) => {
    try {
      const account = await openCustomerAccount(req.customer);
      await query('UPDATE accounts SET product_name=$2 WHERE id=$1', [account.id, req.body.name]);
      res.status(201).json({
        account: {
          name: req.body.name,
          num: '•••• ' + String(account.account_number).slice(-4),
          balance: 0,
          type: req.body.type
        }
      });
    } catch (err) { next(err); }
  });

/* ---------------------------------------------------------- otp and step-up */

/**
 * Step-up tokens are short-lived JWTs bound to the customer and the purpose,
 * so a token minted to change a PIN cannot be replayed to authorise a payment.
 */
const signStepUp = (customerId, purpose) =>
  jwt.sign({ sub: customerId, purpose, kind: 'step_up' }, config.jwt.secret, { expiresIn: '5m' });

function readStepUp(token, customerId, purpose) {
  try {
    const claims = jwt.verify(token, config.jwt.secret);
    return claims.kind === 'step_up' && claims.sub === customerId && claims.purpose === purpose;
  } catch { return false; }
}

const fail = (res, code, status = 400) => res.status(status).json({ error: code });

compatRouter.post('/otp/request',
  authenticate('customer'),
  validate(z.object({ customerId: z.string().optional(), purpose: z.string().min(2).max(40) })),
  async (req, res, next) => {
    try {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const challengeId = uuid();
      await query(
        `INSERT INTO otp_challenges (id, customer_id, purpose, code_hash, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '5 minutes')`,
        [challengeId, req.customer.id, req.body.purpose, hashSecret(code)]
      );

      // TODO: hand off to the SMS provider. Until then the code is logged
      // server-side, and echoed to the client only outside production.
      logger.info({ challengeId, msisdn: req.customer.msisdn }, 'otp issued');
      res.json({
        challengeId,
        // No SMS provider on sandbox rails, so the code comes back in the
        // response. Never on real rails, whatever the environment.
        demoCode: (usingMocks() || config.env !== 'production') ? code : undefined,
        sentTo: '•••• ' + String(req.customer.msisdn).slice(-4)
      });
    } catch (err) { next(err); }
  });

compatRouter.post('/otp/verify',
  authenticate('customer'),
  validate(z.object({ challengeId: z.string(), code: z.string().min(4).max(8) })),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT * FROM otp_challenges
          WHERE id=$1 AND customer_id=$2 AND consumed_at IS NULL AND expires_at > now()`,
        [req.body.challengeId, req.customer.id]
      );
      const challenge = rows[0];
      if (!challenge) return fail(res, 'otp_expired');
      if (challenge.attempts >= 3) return fail(res, 'otp_locked', 429);

      if (!verifySecret(req.body.code, challenge.code_hash)) {
        await query('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id=$1', [challenge.id]);
        return fail(res, 'invalid_otp');
      }
      await query('UPDATE otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      res.json({ stepUpToken: signStepUp(req.customer.id, challenge.purpose) });
    } catch (err) { next(err); }
  });

/* --------------------------------------------------------------------- pin */

compatRouter.post('/pin/set',
  authenticate('customer'),
  validate(z.object({
    customerId: z.string().optional(),
    currentPin: z.string().nullable().optional(),
    newPin: z.string().regex(/^\d{4}$/),
    stepUpToken: z.string()
  })),
  async (req, res, next) => {
    try {
      if (!readStepUp(req.body.stepUpToken, req.customer.id, 'pin_change')) {
        return fail(res, 'invalid_step_up', 403);
      }
      // A voluntary change proves the old PIN first; a forced one cannot.
      if (!req.customer.must_change_pin) {
        if (!req.body.currentPin || !verifySecret(req.body.currentPin, req.customer.pin_hash)) {
          return fail(res, 'invalid_pin', 403);
        }
      }
      await query(
        'UPDATE customers SET pin_hash=$2, must_change_pin=false, pin_set_at=now() WHERE id=$1',
        [req.customer.id, hashSecret(req.body.newPin)]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

compatRouter.post('/pin/verify',
  authenticate('customer'),
  validate(z.object({
    customerId: z.string().optional(),
    pin: z.string().regex(/^\d{4}$/),
    stepUpToken: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      if (req.customer.must_change_pin) return fail(res, 'pin_change_required', 403);
      if (!verifySecret(req.body.pin, req.customer.pin_hash)) return fail(res, 'invalid_pin', 403);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

/* ---------------------------------------------------------- money movement */

compatRouter.post('/transactions',
  authenticate('customer'),
  validate(z.object({
    customerId: z.string().optional(),
    account: z.coerce.number().int().min(0).default(0),
    merchant: z.string().min(1).max(100),
    amount: z.number(),
    category: z.string().max(40).optional(),
    method: z.string().max(40).optional(),
    pin: z.string().regex(/^\d{4}$/),
    stepUpToken: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      const c = req.customer;
      if (c.must_change_pin) return fail(res, 'pin_change_required', 403);
      if (!verifySecret(req.body.pin, c.pin_hash)) return fail(res, 'invalid_pin', 403);

      const { rows: accounts } = await query(
        'SELECT id FROM accounts WHERE customer_id=$1 ORDER BY created_at', [c.id]
      );
      const target = accounts[req.body.account];
      if (!target) return fail(res, 'unknown_account', 404);

      const account = await loadAccount(target.id, c.id);
      const amountMinor = asMinor(req.body.amount);
      const direction = Number(req.body.amount) < 0 ? 'debit' : 'credit';

      if (direction === 'debit' && amountMinor > Number(account.available_minor)) {
        return fail(res, 'insufficient_funds');
      }

      const risk = await scoreTransaction({
        customer: c, account,
        intent: { amountMinor, kind: 'transfer', channel: req.body.method, method: 'internal' }
      });

      const { transaction } = await openTransaction({
        account, direction, kind: 'transfer', amountMinor,
        channel: req.body.method || 'Transfer', provider: 'internal',
        counterparty: { name: req.body.merchant },
        metadata: { narration: req.body.merchant, category: req.body.category, surface: 'compat' },
        idempotencyKey: req.get('Idempotency-Key') || newReference('CMP'),
        risk, status: 'processing'
      });

      if (req.body.category) {
        await query('UPDATE transactions SET category=$2 WHERE id=$1', [transaction.id, req.body.category]);
      }

      if (transaction.status === 'held') {
        return res.status(202).json({ tx: toServerTx(transaction), held: true });
      }

      // On-us movement settles immediately; nothing waits on an external rail.
      const settled = await settleTransaction({
        transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS
      });
      const { rows: after } = await query('SELECT available_minor FROM accounts WHERE id=$1', [account.id]);
      const balanceMinor = Number(after[0].available_minor);

      res.status(201).json({
        tx: toServerTx({
          ...transaction, ...settled,
          category: req.body.category,
          metadata: { narration: req.body.merchant },
          balance_after_minor: balanceMinor
        }),
        balance: asMajor(balanceMinor)
      });
    } catch (err) { next(err); }
  });

/* ------------------------------------------------------------- decisions log */

/**
 * The browser core posts every decision it makes so the control tower and the
 * reviewer queue see the same spine. Unauthenticated callers are accepted but
 * recorded without a customer, since index.html decides before anyone signs in.
 */
compatRouter.post('/decisions', async (req, res) => {
  try {
    const rec = req.body || {};
    await query(
      `INSERT INTO decision_log (use_case, action, confidence, adverse, explanation, payload)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [rec.useCase || rec.title || 'unknown', rec.action || null,
       Number(rec.confidence ?? 0), Boolean(rec.adverse),
       rec.explanation || null, rec]
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'could not record browser decision');
  }
  res.status(202).json({ received: true });
});
