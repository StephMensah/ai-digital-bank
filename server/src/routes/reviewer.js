import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { openCustomerAccount } from '../services/onboarding.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { settleTransaction, failTransaction, loadAccount, GL } from '../core/ledger.js';
import { dispatchPayout } from './payments.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { notFound, conflict } from '../lib/errors.js';

export const reviewerRouter = Router();
reviewerRouter.use(authenticate('staff'), requireRole('reviewer', 'supervisor', 'ops', 'admin'));

/** Work queue, newest breaches of SLA first. */
reviewerRouter.get('/cases',
  validate(z.object({
    status: z.enum(['open', 'assigned', 'escalated', 'approved', 'declined', 'closed']).optional(),
    caseType: z.enum(['transaction', 'kyc', 'fraud_alert', 'dispute', 'limit_breach']).optional(),
    mine: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  }), 'query'),
  async (req, res, next) => {
    try {
      const { status, caseType, mine, limit } = req.query;
      const { rows } = await query(
        `SELECT rc.id, rc.case_number, rc.case_type, rc.priority, rc.status, rc.risk_score,
                rc.summary, rc.sla_due_at, rc.created_at, rc.model_rationale,
                rc.sla_due_at < now() AS breached,
                c.full_name AS customer_name, c.msisdn, c.kyc_status,
                t.reference, t.amount_minor, t.currency, t.counterparty, t.kind,
                s.full_name AS assignee
           FROM review_cases rc
           LEFT JOIN customers c ON c.id = rc.customer_id
           LEFT JOIN transactions t ON t.id = rc.transaction_id
           LEFT JOIN staff_users s ON s.id = rc.assigned_to
          WHERE ($1::text IS NULL OR rc.status = $1)
            AND ($2::text IS NULL OR rc.case_type = $2)
            AND ($3::boolean IS NOT TRUE OR rc.assigned_to = $4)
          ORDER BY (rc.sla_due_at < now()) DESC,
                   array_position(ARRAY['critical','high','medium','low'], rc.priority),
                   rc.created_at
          LIMIT $5`,
        [status || null, caseType || null, mine === true, req.staff.id, limit]
      );
      res.json({ cases: rows });
    } catch (err) { next(err); }
  });

reviewerRouter.get('/cases/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT rc.*, c.full_name, c.msisdn, c.email, c.kyc_status, c.kyc_tier, c.created_at AS customer_since,
              t.reference, t.amount_minor, t.fee_minor, t.currency, t.counterparty, t.kind, t.channel,
              t.provider, t.status AS tx_status, t.risk_reasons, t.metadata, t.account_id
         FROM review_cases rc
         LEFT JOIN customers c ON c.id=rc.customer_id
         LEFT JOIN transactions t ON t.id=rc.transaction_id
        WHERE rc.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound('Case not found');

    const { rows: events } = await query(
      `SELECT ce.action, ce.detail, ce.created_at, s.full_name AS actor
         FROM case_events ce LEFT JOIN staff_users s ON s.id=ce.actor_id
        WHERE ce.case_id=$1 ORDER BY ce.created_at`,
      [req.params.id]
    );

    const history = rows[0].customer_id ? (await query(
      `SELECT t.reference, t.kind, t.direction, t.amount_minor, t.status, t.created_at
         FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE a.customer_id=$1 ORDER BY t.created_at DESC LIMIT 10`,
      [rows[0].customer_id]
    )).rows : [];

    res.json({ case: rows[0], events, recentActivity: history });
  } catch (err) { next(err); }
});

reviewerRouter.post('/cases/:id/claim', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE review_cases SET assigned_to=$2, status='assigned'
        WHERE id=$1 AND status IN ('open','assigned') RETURNING *`,
      [req.params.id, req.staff.id]
    );
    if (!rows[0]) throw conflict('Another reviewer already has this case');
    await logEvent(req.params.id, req.staff.id, 'claimed');
    res.json({ case: rows[0] });
  } catch (err) { next(err); }
});

reviewerRouter.post('/cases/:id/decide',
  validate(z.object({
    decision: z.enum(['approve', 'decline', 'escalate']),
    note: z.string().min(3).max(1000)
  })),
  async (req, res, next) => {
    try {
      const { decision, note } = req.body;
      const { rows: found } = await query(
        `SELECT rc.*, t.id AS tx_id, t.account_id, t.counterparty, t.metadata, t.provider
           FROM review_cases rc LEFT JOIN transactions t ON t.id=rc.transaction_id
          WHERE rc.id=$1`,
        [req.params.id]
      );
      const c = found[0];
      if (!c) throw notFound('Case not found');
      if (['approved', 'declined', 'closed'].includes(c.status)) throw conflict('This case is already closed');

      if (decision === 'escalate') {
        await query(`UPDATE review_cases SET status='escalated', priority='high' WHERE id=$1`, [req.params.id]);
        await logEvent(req.params.id, req.staff.id, 'escalated', { note });
        return res.json({ status: 'escalated' });
      }

      const status = decision === 'approve' ? 'approved' : 'declined';
      await query(
        `UPDATE review_cases SET status=$2, decision=$3, decision_note=$4, decided_by=$5, decided_at=now()
          WHERE id=$1`,
        [req.params.id, status, decision, note, req.staff.id]
      );

      if (c.tx_id) {
        if (decision === 'approve') {
          const account = await loadAccount(c.account_id);
          const method = c.provider === 'mtn_momo' ? 'mobile_money' : 'bank';
          const { rows: txRows } = await query('SELECT * FROM transactions WHERE id=$1', [c.tx_id]);
          await dispatchPayout({
            transaction: txRows[0], method, destination: c.counterparty,
            narration: c.metadata?.narration, account
          });
        } else {
          await failTransaction({ transactionId: c.tx_id, reason: `Declined in review: ${note}` });
        }
      } else if (c.customer_id && c.case_type === 'kyc') {
        await query(
          `UPDATE customers SET kyc_status=$2, kyc_tier = CASE WHEN $2='verified' THEN GREATEST(kyc_tier,2) ELSE kyc_tier END
            WHERE id=$1`,
          [c.customer_id, decision === 'approve' ? 'verified' : 'rejected']
        );
        /* Approving a referred customer has to open their account too, or they
           end up verified with nowhere to hold money. */
        if (decision === 'approve') {
          const { rows: held } = await query(
            'SELECT id FROM accounts WHERE customer_id=$1 LIMIT 1', [c.customer_id]
          );
          if (!held[0]) {
            const { rows: cust } = await query('SELECT * FROM customers WHERE id=$1', [c.customer_id]);
            if (cust[0]) await openCustomerAccount(cust[0]);
          }
        }
      }

      await logEvent(req.params.id, req.staff.id, decision, { note });
      await audit({ ...auditFrom(req), action: `review.${decision}`, entity: 'review_case', entityId: req.params.id, after: { note } });
      res.json({ status });
    } catch (err) { next(err); }
  });

reviewerRouter.get('/metrics', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         count(*) FILTER (WHERE status IN ('open','assigned'))                          AS queue_depth,
         count(*) FILTER (WHERE status IN ('open','assigned') AND sla_due_at < now())   AS sla_breached,
         count(*) FILTER (WHERE decided_at > now() - interval '24 hours')               AS decided_today,
         count(*) FILTER (WHERE decision='approve' AND decided_at > now() - interval '24 hours') AS approved_today,
         COALESCE(avg(EXTRACT(epoch FROM (decided_at - created_at))) FILTER (WHERE decided_at > now() - interval '7 days'), 0) AS avg_handle_seconds
       FROM review_cases`
    );
    res.json({ metrics: rows[0] });
  } catch (err) { next(err); }
});

async function logEvent(caseId, actorId, action, detail = {}) {
  await query('INSERT INTO case_events (case_id, actor_id, action, detail) VALUES ($1,$2,$3,$4)',
    [caseId, actorId, action, detail]);
}
