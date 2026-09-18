import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Saved payees.
 *
 * A customer confirms who they are sending to before the money moves, and then
 * chooses whether to keep them. Saving is deliberately a separate step from
 * sending: a one-off payment should not quietly leave a record behind, and a
 * beneficiary a customer keeps should be one they chose to keep.
 */
export const payeesRouter = Router();

payeesRouter.use(authenticate('customer'));

const shape = (row) => ({
  id: row.id,
  name: row.name,
  bank: row.bank,
  acct: row.account_ref,
  method: row.method,
  bankCode: row.bank_code,
  last: row.last_amount_minor ? `GHS ${(Number(row.last_amount_minor) / 100).toFixed(2)}` : 'no payments yet'
});

payeesRouter.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT * FROM payees WHERE customer_id=$1 ORDER BY created_at DESC', [req.customer.id]
    );
    res.json({ payees: rows.map(shape) });
  } catch (err) { next(err); }
});

payeesRouter.post('/',
  validate(z.object({
    name: z.string().min(2).max(80),
    method: z.enum(['internal', 'bank', 'mobile_money']),
    accountRef: z.string().min(3).max(40),
    bank: z.string().max(60).optional(),
    bankCode: z.string().max(20).optional()
  })),
  async (req, res, next) => {
    try {
      const { name, method, accountRef, bank, bankCode } = req.body;
      if (method === 'bank' && !bankCode) throw badRequest('Choose the bank before saving this payee');

      /* The same person saved twice is a mess to send to later, so a repeat
         save updates the name rather than adding a second row. */
      const { rows } = await query(
        `INSERT INTO payees (customer_id, name, bank, account_ref, method, bank_code)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (customer_id, method, account_ref)
         DO UPDATE SET name = EXCLUDED.name, bank = EXCLUDED.bank, bank_code = EXCLUDED.bank_code
         RETURNING *`,
        [req.customer.id, name, bank || null, accountRef, method, bankCode || null]
      );
      await audit({ ...auditFrom(req), action: 'payee.saved', entity: 'payee', entityId: rows[0].id });
      res.status(201).json({ payee: shape(rows[0]) });
    } catch (err) { next(err); }
  });

payeesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM payees WHERE id=$1 AND customer_id=$2', [req.params.id, req.customer.id]
    );
    if (!rowCount) throw notFound('No such payee');
    await audit({ ...auditFrom(req), action: 'payee.removed', entity: 'payee', entityId: req.params.id });
    res.json({ removed: true });
  } catch (err) { next(err); }
});
