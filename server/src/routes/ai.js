import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { runAutomation } from '../services/risk.js';
import { isConfigured } from '../config.js';

export const aiRouter = Router();
aiRouter.use(authenticate('customer'));

/** Spending breakdown computed in Postgres; the narrative comes from the Python service. */
aiRouter.get('/insights/:accountId', async (req, res, next) => {
  try {
    const { rows: owned } = await query(
      'SELECT id FROM accounts WHERE id=$1 AND customer_id=$2', [req.params.accountId, req.customer.id]
    );
    if (!owned[0]) return res.status(404).json({ error: { code: 'not_found', message: 'Account not found' } });

    const { rows: spend } = await query(
      `SELECT kind,
              count(*) AS count,
              sum(amount_minor) AS total_minor,
              round(avg(amount_minor)) AS avg_minor
         FROM transactions
        WHERE account_id=$1 AND direction='debit' AND status='posted'
          AND created_at > now() - interval '30 days'
        GROUP BY kind ORDER BY total_minor DESC`,
      [req.params.accountId]
    );

    const { rows: trend } = await query(
      `SELECT date_trunc('week', created_at) AS week,
              sum(amount_minor) FILTER (WHERE direction='debit')  AS out_minor,
              sum(amount_minor) FILTER (WHERE direction='credit') AS in_minor
         FROM transactions
        WHERE account_id=$1 AND status='posted' AND created_at > now() - interval '12 weeks'
        GROUP BY 1 ORDER BY 1`,
      [req.params.accountId]
    );

    let narrative = null;
    if (isConfigured.python()) {
      const out = await runAutomation('insights', { spend, trend, customerId: req.customer.id }).catch(() => null);
      narrative = out?.narrative || null;
    }
    res.json({ spendByCategory: spend, weeklyTrend: trend, narrative });
  } catch (err) { next(err); }
});

aiRouter.post('/assist',
  validate(z.object({ question: z.string().min(3).max(500), accountId: z.string().uuid().optional() })),
  async (req, res, next) => {
    try {
      if (!isConfigured.python()) {
        return res.status(503).json({
          error: { code: 'assistant_offline', message: 'The assistant is not available right now. Try again shortly.' }
        });
      }
      const out = await runAutomation('assist', {
        question: req.body.question,
        customerId: req.customer.id,
        accountId: req.body.accountId || null
      });
      res.json(out);
    } catch (err) { next(err); }
  });
