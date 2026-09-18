import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loadAccount } from '../core/ledger.js';
import { mambu } from '../core/mambu.js';
import { isConfigured } from '../config.js';
import { logger } from '../lib/logger.js';

export const accountsRouter = Router();
accountsRouter.use(authenticate('customer'));

accountsRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, account_number, product_type, product_id, currency,
              balance_minor, available_minor, status, synced_at
         FROM accounts WHERE customer_id=$1 ORDER BY created_at`,
      [req.customer.id]
    );
    res.json({ accounts: rows });
  } catch (err) { next(err); }
});

accountsRouter.get('/:id', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id, req.customer.id);
    res.json({ account: strip(account) });
  } catch (err) { next(err); }
});

/** Pull fresh balances from Mambu, which is the book of record. */
accountsRouter.post('/:id/sync', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id, req.customer.id);
    if (!isConfigured.mambu() || !account.mambu_account_key) {
      return res.json({ account: strip(account), synced: false, reason: 'core banking link not ready' });
    }
    const core = await mambu.getDepositAccount(account.mambu_account_key);
    const balance = Math.round(Number(core?.balances?.totalBalance || 0) * 100);
    const available = Math.round(Number(core?.balances?.availableBalance || 0) * 100);
    const { rows } = await query(
      `UPDATE accounts SET balance_minor=$2, available_minor=$3, synced_at=now()
        WHERE id=$1 RETURNING *`,
      [account.id, balance, available]
    );
    res.json({ account: strip(rows[0]), synced: true });
  } catch (err) { next(err); }
});

accountsRouter.get('/:id/transactions',
  validate(z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().datetime().optional()
  }), 'query'),
  async (req, res, next) => {
    try {
      const account = await loadAccount(req.params.id, req.customer.id);
      const { limit, cursor } = req.query;
      const { rows } = await query(
        `SELECT id, reference, direction, kind, amount_minor, fee_minor, currency, channel,
                provider, status, counterparty, created_at, posted_at
           FROM transactions
          WHERE account_id=$1 ${cursor ? 'AND created_at < $3' : ''}
          ORDER BY created_at DESC LIMIT $2`,
        cursor ? [account.id, limit, cursor] : [account.id, limit]
      );
      res.json({
        transactions: rows,
        nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null
      });
    } catch (err) { next(err); }
  });

accountsRouter.get('/:id/statement', async (req, res, next) => {
  try {
    const account = await loadAccount(req.params.id, req.customer.id);
    const { rows } = await query(
      `SELECT date_trunc('month', created_at) AS month,
              sum(amount_minor) FILTER (WHERE direction='credit') AS credits_minor,
              sum(amount_minor) FILTER (WHERE direction='debit')  AS debits_minor,
              count(*) AS entries
         FROM transactions
        WHERE account_id=$1 AND status='posted' AND created_at > now() - interval '12 months'
        GROUP BY 1 ORDER BY 1 DESC`,
      [account.id]
    );
    res.json({ accountNumber: account.account_number, months: rows });
  } catch (err) { next(err); }
});

function strip(a) {
  const { password_hash, pin_hash, ...rest } = a;
  return rest;
}
