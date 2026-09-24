import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { validate } from '../middleware/validate.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { authenticate } from '../middleware/auth.js';
import { verifySecret, hashSecret, newReference, uuid } from '../lib/crypto.js';
import { openTransaction, settleTransaction, loadAccount, GL } from '../core/ledger.js';
import { openCustomerAccount } from '../services/onboarding.js';
import { loadProducts } from '../services/products.js';
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
      `SELECT id, account_number, mambu_account_key, balance_minor, available_minor,
              COALESCE(product_name, product_id) AS product_name, segment, currency
         FROM accounts WHERE customer_id=$1 ORDER BY created_at`,
      [req.customer.id]
    );
    const { rows: txs } = await query(
      `SELECT t.* FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.customer_id=$1 ORDER BY t.created_at DESC LIMIT 50`,
      [req.customer.id]
    );

    const products = await loadProducts(req.customer, accounts);
    const asCard = (c) => c && ({
      num: '•••• •••• •••• ' + c.pan.slice(-4),
      fullNum: c.pan, cvv: c.cvv, exp: c.expiry,
      frozen: c.frozen, locked: c.locked_to || undefined,
      tier: c.tier || 'classic', scheme: (c.scheme || 'visa').toUpperCase()
    });

    res.json({
      entity: req.params.entity,
      mustChangePin: Boolean(req.customer.must_change_pin),
      kycStatus: req.customer.kyc_status,
      /* Finished means verified or awaiting a reviewer, with a PIN. Anything
         short of that is an abandoned signup, and the app restarts it. */
      onboardingComplete: !req.customer.must_change_pin &&
        ['verified', 'in_review', 'approved'].includes(req.customer.kyc_status),
      goals: products.goals.map((g) => ({
        id: g.id, name: g.name, icon: g.icon, due: g.due,
        target: asMajor(g.target_minor), saved: asMajor(g.saved_minor),
        monthly: asMajor(g.monthly_minor)
      })),
      beneficiaries: products.payees.map((p) => ({
        name: p.name, bank: p.bank, acct: p.account_ref,
        last: p.last_amount_minor ? `GHS ${asMajor(p.last_amount_minor)}` : 'no payments yet'
      })),
      accounts: accounts.map((a) => ({
        name: a.product_name || 'Current account',
        // The full number, not the last four: a customer needs to be able to
        // read their own account number off the landing page and give it out.
        num: a.account_number,
        accountNumber: a.account_number,
        // Present once the account is mirrored into the core.
        mambuRef: a.mambu_account_key || null,
        balance: asMajor(a.available_minor ?? a.balance_minor),
        type: a.segment === 'business' ? 'business'
              : /sav/i.test(a.product_name || '') ? 'savings' : 'current',
        card: asCard((products.cards[a.id] || []).find((c) => c.kind === 'physical')),
        virtualCards: (products.cards[a.id] || []).filter((c) => c.kind === 'virtual').map(asCard),
        payroll: (products.payroll[a.id] || []).map((r) => ({
          name: r.name, role: r.role, amount: asMajor(r.amount_minor)
        })),
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
    type: z.enum(['current', 'savings', 'business'])
  })),
  async (req, res, next) => {
    try {
      const account = await openCustomerAccount(req.customer, {
        productName: req.body.name,
        segment: req.body.type === 'business' ? 'business' : 'personal'
      });
      res.status(201).json({
        account: {
          name: req.body.name,
          num: account.account_number,
          accountNumber: account.account_number,
          balance: 0,
          type: req.body.type,
          currency: account.currency
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

export function readStepUp(token, customerId, purpose) {
  try {
    const claims = jwt.verify(token, config.jwt.secret);
    return claims.kind === 'step_up' && claims.sub === customerId && claims.purpose === purpose;
  } catch { return false; }
}

/* Bare {error:'invalid_pin'} gives the screen nothing to say. Every failure now
   carries the same shape as the rest of the API — a code to branch on and a
   sentence a customer can act on. */
const SAYS = {
  otp_expired: 'That code has expired. Ask for a new one.',
  otp_locked: 'Too many wrong codes. Wait a few minutes and try again.',
  invalid_otp: 'That code is not right. Check the message and try again.',
  invalid_pin: 'That PIN is not right.',
  invalid_step_up: 'That confirmation has expired. Start again.',
  pin_change_required: 'Set your PIN before moving money.',
  unknown_account: 'We could not find that account.',
  insufficient_funds: 'There is not enough in the account for that.'
};
const fail = (res, code, status = 400) =>
  res.status(status).json({ error: { code, message: SAYS[code] || 'That did not work.' } });

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
      // The counterparty is the rail the money faces. It must not be the
      // customer's own deposit code, or the two lines cancel on one account.
      const method = String(req.body.method || '').toLowerCase();
      const counterGl = /momo|mobile|wallet/.test(method) ? GL.MOMO_SETTLEMENT
                      : /card/.test(method)               ? GL.CARD_SETTLEMENT
                      : /bank|ghipss|gip/.test(method)    ? GL.BANK_SETTLEMENT
                      /* Rail unknown on this surface: suspense is what an
                         unidentified counterparty is for. Transfer clearing is
                         reserved for on-us pairs, which must net to zero. */
                      : GL.SUSPENSE;
      const settled = await settleTransaction({
        transactionId: transaction.id, glCounterparty: counterGl
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

/* ---------------------------------------------------------------- disputes */

/**
 * Raising a problem with a transaction. This opens a real review case against
 * the customer's own transaction, which is what "Problem" has to mean: a
 * button that only shows a confirmation and files nothing is worse than no
 * button, because the customer believes someone is looking.
 */
compatRouter.post('/disputes',
  authenticate('customer'),
  validate(z.object({
    reference: z.string().min(4).max(40),
    reason: z.enum(['not_recognised', 'wrong_amount', 'never_arrived', 'duplicate', 'other']),
    detail: z.string().max(500).optional()
  })),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE t.reference=$1 AND a.customer_id=$2`,
        [req.body.reference, req.customer.id]
      );
      const t = rows[0];
      if (!t) return fail(res, 'unknown_transaction', 404);

      const { rows: existing } = await query(
        "SELECT id FROM review_cases WHERE transaction_id=$1 AND status <> 'closed'", [t.id]
      );
      if (existing[0]) {
        return res.json({ caseId: existing[0].id, alreadyOpen: true,
          message: 'We are already looking at this one.' });
      }

      const WHY = {
        not_recognised: 'Customer does not recognise this transaction',
        wrong_amount: 'Customer says the amount is wrong',
        never_arrived: 'Customer says the money never arrived',
        duplicate: 'Customer says they were charged twice',
        other: 'Customer raised a problem'
      };

      const { rows: created } = await query(
        `INSERT INTO review_cases (case_type, transaction_id, customer_id, priority, summary, sla_due_at)
         VALUES ('dispute',$1,$2,$3,$4, now() + interval '24 hours')
         RETURNING id, case_number`,
        [t.id, req.customer.id,
         req.body.reason === 'not_recognised' ? 'high' : 'medium',
         `${WHY[req.body.reason]}${req.body.detail ? ': ' + req.body.detail : ''}`]
      );

      await audit({ ...auditFrom(req), action: 'dispute.raised', entity: 'transaction', entityId: t.id });
      res.status(201).json({
        caseId: created[0].id, caseNumber: created[0].case_number,
        message: 'Raised. A colleague picks this up within 24 hours and you will hear from us either way.'
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
