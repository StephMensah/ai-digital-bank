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
import { newReference } from '../lib/crypto.js';

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

const NETWORKS = { mtn: 'MTN MoMo', vodafone: 'Telecel Cash', airteltigo: 'AirtelTigo Money' };
function networkName(msisdn) {
  const local = String(msisdn || '').replace(/^\+233/, '').replace(/^0/, '').slice(0, 2);
  if (['24', '54', '55', '59', '25', '53'].includes(local)) return NETWORKS.mtn;
  if (['20', '50'].includes(local)) return NETWORKS.vodafone;
  if (['27', '57', '26', '56'].includes(local)) return NETWORKS.airteltigo;
  return 'Mobile wallet';
}

/** The picker sends a code; the confirmation screen needs the name back. */
async function bankNameFor(bankCode) {
  try {
    const list = providers.ghipss.configured()
      ? await providers.ghipss.banks()
      : usingMocks() ? await providers.mock.banks() : await providers.paystack.listBanks();
    return (list.find((b) => String(b.code) === String(bankCode)) || {}).name || 'Selected bank';
  } catch { return 'Selected bank'; }
}

paymentsRouter.post('/name-enquiry',
  validate(z.object({
    method: z.enum(['mobile_money', 'bank', 'internal']),
    msisdn: z.string().optional(),
    accountNumber: z.string().optional(),
    bankCode: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      const { method, msisdn, accountNumber, bankCode } = req.body;

      /* On-us: the account is in our own ledger, so no rail is involved. The
         answer says whether it is one of the caller's own accounts, because
         sending to yourself and sending to someone else are different
         intentions and the screen asks which before it asks for a number. */
      if (method === 'internal') {
        const { rows } = await query(
          `SELECT a.id, a.account_number, a.customer_id, a.segment,
                  COALESCE(a.product_name, 'Current account') AS product_name,
                  c.full_name
             FROM accounts a JOIN customers c ON c.id = a.customer_id
            WHERE a.account_number = $1 AND a.status = 'active'`,
          [String(accountNumber || '').trim()]
        );
        const found = rows[0];
        if (!found) throw notFound('No Digital Bank account with that number');
        return res.json({
          name: found.segment === 'business' ? found.product_name : found.full_name,
          bank: 'Digital Bank',
          branch: 'Digital — no branch',
          accountNumber: found.account_number,
          self: found.customer_id === req.customer.id,
          rail: 'internal'
        });
      }

      if (method === 'mobile_money') {
        const rail = railFor('mobile_money');
        return res.json({
          name: await rail.accountHolderName(msisdn),
          bank: networkName(msisdn), branch: 'Mobile wallet',
          accountNumber: msisdn, rail: rail.name
        });
      }
      if (usingMocks()) {
        const enquiry = await providers.mock.nameEnquiry({ accountNumber, bankCode });
        return res.json({
          name: enquiry.accountName, enquiry, accountNumber,
          bank: await bankNameFor(bankCode), branch: 'Not returned by the rail',
          rail: 'mock'
        });
      }
      if (providers.ghipss.configured()) {
        const enquiry = await providers.ghipss.nameEnquiry({ accountNumber, bankCode });
        const bankName = await bankNameFor(bankCode);
        // The session id has to travel back with the transfer request, so hand
        // it to the client and let it round-trip.
        return res.json({
          name: enquiry.accountName, enquiry, accountNumber,
          bank: bankName,
          /* GIP answers with the account name; it does not carry a branch.
             Saying so is better than inventing one. */
          branch: enquiry.branch || 'Not returned by GIP',
          rail: 'gip'
        });
      }
      const resolved = await providers.paystack.resolveAccount({ accountNumber, bankCode });
      res.json({
        name: resolved.account_name, accountNumber,
        bank: await bankNameFor(bankCode), branch: 'Not returned by the rail',
        rail: 'paystack'
      });
    } catch (err) { next(err); }
  });

/**
 * Wallet to bank: pull from the customer's mobile wallet and push the same
 * amount to a bank account, in that order.
 *
 * It is two legs, not one, and the order matters: nothing is sent to the bank
 * until the wallet debit has actually settled, because the alternative is
 * paying a stranger with money we never collected. The customer's own account
 * is the waypoint, so the movement is on the ledger at every moment and the
 * statement shows both halves rather than a sum that appeared from nowhere.
 */
paymentsRouter.post('/wallet-to-bank',
  payLimiter, requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    amountMinor,
    msisdn: z.string().regex(/^\+233\d{9}$/, 'Use a Ghana mobile number in +233 format'),
    destination: z.object({
      accountNumber: z.string().min(5),
      bankCode: z.string().min(2),
      name: z.string().optional(),
      enquiry: z.object({}).passthrough().optional()
    }),
    narration: z.string().max(100).optional()
  })),
  async (req, res, next) => {
    try {
      const account = await loadAccount(req.body.accountId, req.customer.id);
      const rail = railFor('mobile_money');
      const reference = newReference('W2B');

      const { transaction } = await openTransaction({
        account, direction: 'credit', kind: 'deposit',
        amountMinor: req.body.amountMinor,
        channel: 'wallet_to_bank', provider: rail.name,
        counterparty: { msisdn: req.body.msisdn, onward: req.body.destination },
        metadata: { narration: req.body.narration || 'Wallet to bank', leg: 'collection' },
        idempotencyKey: req.get('Idempotency-Key'),
        status: 'processing', reference
      });

      const collection = rail.chargeWallet
        ? await rail.chargeWallet({
            amountMinor: req.body.amountMinor, msisdn: req.body.msisdn,
            reference: transaction.reference, description: 'Wallet to bank'
          })
        : await rail.requestToPay({
            amountMinor: req.body.amountMinor, msisdn: req.body.msisdn,
            reference: transaction.reference, payerMessage: 'Wallet to bank'
          });

      await query('UPDATE transactions SET provider_ref=$2 WHERE id=$1',
        [transaction.id, collection.providerRef || null]);

      /* The onward leg is queued against the collection, not fired now. The
         settlement path releases it once the wallet debit lands. */
      await enqueue('payments.onward_bank_leg', {
        transactionId: transaction.id, accountId: account.id,
        amountMinor: req.body.amountMinor, destination: req.body.destination,
        narration: req.body.narration || 'Wallet to bank'
      });

      await audit({ ...auditFrom(req), action: 'payment.wallet_to_bank', entity: 'transaction', entityId: transaction.id });
      res.status(202).json({
        transaction,
        awaiting: 'Approve the prompt on your phone. The bank leg follows once it clears.'
      });
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
        originator: { accountNumber: account.account_number, name: account.holder_name || 'Digital Bank' }
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
