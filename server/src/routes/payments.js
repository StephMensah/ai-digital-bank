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
import { railFor, providers, usingMocks } from '../providers/index.js';
import { mambu } from '../core/mambu.js';
import { isConfigured, config } from '../config.js';
import { enqueue } from '../core/outbox.js';
import { badRequest, notFound } from '../lib/errors.js';

export const paymentsRouter = Router();
paymentsRouter.use(authenticate('customer'));

const payLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const amountMinor = z.number().int().positive().max(100_000_000);

/** Money in: mobile money, card or bank. */
paymentsRouter.post('/deposits',
  payLimiter, requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    amountMinor,
    method: z.enum(['mobile_money', 'card', 'bank']),
    msisdn: z.string().regex(/^\+233\d{9}$/).optional(),
    channel: z.enum(['app', 'web', 'ussd', 'agent']).default('app')
  })),
  async (req, res, next) => {
    try {
      const { accountId, amountMinor: amount, method, msisdn, channel } = req.body;
      const account = await loadAccount(accountId, req.customer.id);

      const risk = await scoreTransaction({
        customer: req.customer, account,
        intent: { amountMinor: amount, kind: 'deposit', channel, method }
      });

      const { transaction, replayed } = await openTransaction({
        account, direction: 'credit', kind: 'deposit', amountMinor: amount, channel,
        provider: railFor(method).name,
        counterparty: { method, msisdn: msisdn || req.customer.msisdn },
        idempotencyKey: req.idempotencyKey, risk, status: 'processing'
      });
      if (replayed) return res.json({ transaction, replayed: true });

      const rail = railFor(method);
      let upstreamResult;
      if (method === 'mobile_money' && rail.name === 'hubtel') {
        upstreamResult = await rail.chargeWallet({
          amountMinor: amount, msisdn: msisdn || req.customer.msisdn,
          reference: transaction.reference, description: 'Top up your account'
        });
      } else if (method === 'mobile_money') {
        upstreamResult = await rail.requestToPay({
          amountMinor: amount, msisdn: msisdn || req.customer.msisdn,
          reference: transaction.reference, payerMessage: 'Top up your account'
        });
      } else if (rail.name === 'hubtel') {
        upstreamResult = await rail.initializeCharge({
          amountMinor: amount, reference: transaction.reference,
          description: 'Account top up', msisdn: req.customer.msisdn,
          returnUrl: `${config.webOrigin[0]}/app.html?deposit=${transaction.reference}`
        });
      } else {
        upstreamResult = await rail.initializeCharge({
          email: req.customer.email || `${req.customer.msisdn.replace('+', '')}@customers.local`,
          amountMinor: amount, reference: transaction.reference,
          callbackUrl: `${config.webOrigin[0]}/app.html?deposit=${transaction.reference}`,
          channels: method === 'card' ? ['card'] : ['bank', 'mobile_money']
        });
      }

      await query('UPDATE transactions SET provider_ref=$2 WHERE id=$1', [transaction.id, upstreamResult.providerRef]);
      await audit({ ...auditFrom(req), action: 'payment.deposit_initiated', entity: 'transaction', entityId: transaction.id });

      res.status(202).json({
        transaction: { ...transaction, provider_ref: upstreamResult.providerRef },
        next: upstreamResult.authorizationUrl
          ? { type: 'redirect', url: upstreamResult.authorizationUrl }
          : { type: 'approve_on_phone', message: 'Approve the prompt on your phone to finish.' }
      });
    } catch (err) { next(err); }
  });

/** Money out: payout to a wallet or bank account. */
paymentsRouter.post('/payouts',
  payLimiter, requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    amountMinor,
    method: z.enum(['mobile_money', 'bank']),
    destination: z.object({
      msisdn: z.string().regex(/^\+233\d{9}$/).optional(),
      accountNumber: z.string().min(6).optional(),
      bankCode: z.string().min(2).optional(),
      name: z.string().min(2).optional()
    }),
    narration: z.string().max(120).optional(),
    channel: z.enum(['app', 'web', 'ussd', 'agent']).default('app')
  })),
  async (req, res, next) => {
    try {
      const { accountId, amountMinor: amount, method, destination, narration, channel } = req.body;
      if (method === 'mobile_money' && !destination.msisdn) throw badRequest('Add the wallet number to send to');
      if (method === 'bank' && !(destination.accountNumber && destination.bankCode)) {
        throw badRequest('Add the account number and bank to send to');
      }

      const account = await loadAccount(accountId, req.customer.id);
      await assertWithinLimits(account, amount);

      const { rows: seen } = await query(
        `SELECT 1 FROM transactions
          WHERE account_id=$1 AND status='posted'
            AND counterparty->>'msisdn' IS NOT DISTINCT FROM $2 LIMIT 1`,
        [account.id, destination.msisdn || null]
      );

      const risk = await scoreTransaction({
        customer: req.customer, account,
        intent: { amountMinor: amount, kind: 'transfer', channel, method, counterpartyIsNew: seen.length === 0 }
      });

      if (risk.action === 'decline') {
        await audit({ ...auditFrom(req), action: 'payment.declined_by_risk', entity: 'account', entityId: account.id, after: risk });
        return res.status(422).json({
          error: { code: 'payment_blocked', message: 'We stopped this payment for your safety. Contact support to release it.', details: { reasons: risk.reasons } }
        });
      }

      const { transaction, replayed } = await openTransaction({
        account, direction: 'debit', kind: 'transfer', amountMinor: amount, channel,
        provider: railFor(method).name,
        counterparty: destination,
        metadata: { narration: narration || null },
        idempotencyKey: req.idempotencyKey, risk,
        status: risk.action === 'review' ? 'held' : 'processing'
      });
      if (replayed) return res.json({ transaction, replayed: true });

      if (risk.action === 'review') {
        await openReviewCase({ transaction, customer: req.customer, risk });
        return res.status(202).json({
          transaction,
          next: { type: 'in_review', message: 'This payment is with our team for a quick check. We will text you shortly.' }
        });
      }

      await dispatchPayout({ transaction, method, destination, narration, account });
      const { rows } = await query('SELECT * FROM transactions WHERE id=$1', [transaction.id]);
      await audit({ ...auditFrom(req), action: 'payment.payout_sent', entity: 'transaction', entityId: transaction.id });
      res.status(202).json({ transaction: rows[0], next: { type: 'processing' } });
    } catch (err) { next(err); }
  });

paymentsRouter.get('/transactions/:reference', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT t.* FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE t.reference=$1 AND a.customer_id=$2`,
      [req.params.reference, req.customer.id]
    );
    if (!rows[0]) throw notFound('We could not find that payment');
    res.json({ transaction: rows[0] });
  } catch (err) { next(err); }
});

paymentsRouter.get('/banks', async (_req, res, next) => {
  try {
    if (usingMocks()) return res.json({ banks: await providers.mock.banks(), rail: 'mock' });
    // Prefer the GIP member directory when GhIPSS is live — it is the
    // authoritative list of banks we can actually settle with.
    if (providers.ghipss.configured()) {
      return res.json({ banks: await providers.ghipss.banks(), rail: 'gip' });
    }
    res.json({ banks: await providers.paystack.listBanks(), rail: 'paystack' });
  } catch (err) { next(err); }
});

paymentsRouter.post('/name-enquiry',
  validate(z.object({
    method: z.enum(['mobile_money', 'bank']),
    msisdn: z.string().optional(),
    accountNumber: z.string().optional(),
    bankCode: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      const { method, msisdn, accountNumber, bankCode } = req.body;
      if (method === 'mobile_money') {
        const rail = railFor('mobile_money');
        return res.json({ name: await rail.accountHolderName(msisdn), rail: rail.name });
      }
      if (providers.ghipss.configured()) {
        const enquiry = await providers.ghipss.nameEnquiry({ accountNumber, bankCode });
        // The session id has to travel back with the transfer request, so hand
        // it to the client and let it round-trip.
        return res.json({ name: enquiry.accountName, enquiry, rail: 'gip' });
      }
      const resolved = await providers.paystack.resolveAccount({ accountNumber, bankCode });
      res.json({ name: resolved.account_name, rail: 'paystack' });
    } catch (err) { next(err); }
  });

export async function dispatchPayout({ transaction, method, destination, narration, account }) {
  try {
    let result;
    if (usingMocks()) {
      result = await providers.mock.payout({
        amountMinor: Number(transaction.amount_minor),
        msisdn: destination.msisdn, reference: transaction.reference, narration
      });
    } else if (method === 'mobile_money' && providers.hubtel.configured()) {
      result = await providers.hubtel.payout({
        amountMinor: Number(transaction.amount_minor), msisdn: destination.msisdn,
        reference: transaction.reference, narration, recipientName: destination.name
      });
    } else if (method === 'mobile_money') {
      result = await providers.momo.transfer({
        amountMinor: Number(transaction.amount_minor), msisdn: destination.msisdn,
        reference: transaction.reference, note: narration
      });
    } else if (providers.ghipss.configured()) {
      const enquiry = destination.enquiry?.sessionId
        ? destination.enquiry
        : await providers.ghipss.nameEnquiry({
            accountNumber: destination.accountNumber, bankCode: destination.bankCode
          });
      result = await providers.ghipss.payout({
        amountMinor: Number(transaction.amount_minor),
        reference: transaction.reference,
        narration,
        enquiry,
        originator: { accountNumber: account.account_number, name: account.holder_name || 'AI Digital Bank' }
      });
    } else {
      const recipient = await providers.paystack.createRecipient({
        name: destination.name || 'Beneficiary',
        accountNumber: destination.accountNumber, bankCode: destination.bankCode
      });
      result = await providers.paystack.payout({
        amountMinor: Number(transaction.amount_minor), recipientCode: recipient.recipient_code,
        reference: transaction.reference, reason: narration || 'Transfer'
      });
    }
    await query('UPDATE transactions SET provider_ref=$2, status=$3 WHERE id=$1',
      [transaction.id, result.providerRef, 'processing']);

    if (isConfigured.mambu() && account?.mambu_account_key) {
      await enqueue('mambu.post_withdrawal', {
        transactionId: transaction.id,
        accountKey: account.mambu_account_key,
        amountMinor: Number(transaction.amount_minor),
        reference: transaction.reference
      });
    }
    return result;
  } catch (err) {
    await failTransaction({ transactionId: transaction.id, reason: err.message });
    throw err;
  }
}

async function openReviewCase({ transaction, customer, risk }) {
  await query(
    `INSERT INTO review_cases (case_type, transaction_id, customer_id, priority, risk_score, summary, model_rationale, sla_due_at)
     VALUES ('transaction',$1,$2,$3,$4,$5,$6, now() + interval '30 minutes')`,
    [transaction.id, customer.id,
     risk.score >= 75 ? 'high' : 'medium', risk.score,
     `Payout of ${transaction.amount_minor} pesewas held for review`,
     JSON.stringify({ model: risk.model, reasons: risk.reasons, features: risk.features })]
  );
}

export { settleTransaction, GL };
