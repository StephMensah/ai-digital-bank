import { Router } from 'express';
import { z } from 'zod';
import { query, tx as withTx } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { loadAccount, assertWithinLimits, openTransaction, settleTransaction, GL } from '../core/ledger.js';
import { scoreTransaction } from '../services/risk.js';
import { mambu } from '../core/mambu.js';
import { isConfigured } from '../config.js';
import { enqueue } from '../core/outbox.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit, auditFrom } from '../middleware/audit.js';

export const transfersRouter = Router();
transfersRouter.use(authenticate('customer'));

/** Book-to-book transfer between two accounts on this platform. Settles instantly. */
transfersRouter.post('/',
  requireIdempotencyKey,
  validate(z.object({
    fromAccountId: z.string().uuid(),
    toAccountNumber: z.string().min(6),
    amountMinor: z.number().int().positive(),
    narration: z.string().max(120).optional(),
    channel: z.enum(['app', 'web', 'ussd', 'agent']).default('app')
  })),
  async (req, res, next) => {
    try {
      const { fromAccountId, toAccountNumber, amountMinor, narration, channel } = req.body;
      const from = await loadAccount(fromAccountId, req.customer.id);
      if (from.account_number === toAccountNumber) throw badRequest('Pick a different account to send to');

      const { rows: dest } = await query(
        `SELECT a.*, c.full_name FROM accounts a JOIN customers c ON c.id=a.customer_id
          WHERE a.account_number=$1 AND a.status='active'`,
        [toAccountNumber]
      );
      if (!dest[0]) throw notFound('We could not find that account number');
      await assertWithinLimits(from, amountMinor);

      const risk = await scoreTransaction({
        customer: req.customer, account: from,
        intent: { amountMinor, kind: 'transfer', channel, counterpartyIsNew: true }
      });
      if (risk.action === 'decline') {
        return res.status(422).json({
          error: { code: 'payment_blocked', message: 'We stopped this transfer for your safety. Contact support to release it.', details: { reasons: risk.reasons } }
        });
      }

      const { transaction, replayed } = await openTransaction({
        account: from, direction: 'debit', kind: 'transfer', amountMinor, channel,
        provider: 'internal',
        counterparty: { accountNumber: toAccountNumber, name: dest[0].full_name },
        metadata: { narration: narration || null, internal: true },
        idempotencyKey: req.idempotencyKey, risk
      });
      if (replayed) return res.json({ transaction, replayed: true });

      // credit leg for the beneficiary, then settle both sides atomically
      await withTx(async (client) => {
        await client.query(
          `INSERT INTO transactions (reference, account_id, counterparty, direction, kind,
              amount_minor, currency, channel, provider, status, metadata, posted_at)
           VALUES ($1,$2,$3,'credit','transfer',$4,$5,$6,'internal','posted',$7, now())`,
          [`${transaction.reference}-C`, dest[0].id,
           { accountNumber: from.account_number, name: req.customer.full_name },
           amountMinor, from.currency, channel, { narration: narration || null, internal: true }]
        );
        await client.query(
          'UPDATE accounts SET balance_minor = balance_minor + $2, available_minor = available_minor + $2 WHERE id=$1',
          [dest[0].id, amountMinor]
        );
      });

      const posted = await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS });

      if (isConfigured.mambu() && from.mambu_account_key && dest[0].mambu_account_key) {
        await enqueue('mambu.post_transfer', {
          transactionId: transaction.id,
          fromAccountKey: from.mambu_account_key,
          toAccountKey: dest[0].mambu_account_key,
          amountMinor, reference: transaction.reference
        });
      }
      await audit({ ...auditFrom(req), action: 'transfer.posted', entity: 'transaction', entityId: transaction.id });
      res.status(201).json({ transaction: posted, beneficiary: { name: dest[0].full_name, accountNumber: toAccountNumber } });
    } catch (err) { next(err); }
  });

transfersRouter.get('/resolve/:accountNumber', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.full_name FROM accounts a JOIN customers c ON c.id=a.customer_id
        WHERE a.account_number=$1 AND a.status='active'`,
      [req.params.accountNumber]
    );
    if (!rows[0]) throw notFound('We could not find that account number');
    res.json({ name: rows[0].full_name });
  } catch (err) { next(err); }
});
