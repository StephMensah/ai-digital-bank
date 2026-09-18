import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { healthSnapshot } from '../providers/index.js';

export const towerRouter = Router();
towerRouter.use(authenticate('staff'), requireRole('ops', 'supervisor', 'admin'));

/** Live operating picture: volumes, failure rates, queue pressure, rail health. */
towerRouter.get('/overview', async (_req, res, next) => {
  try {
    const [volumes, rails, queues, incidents] = await Promise.all([
      query(
        `SELECT
           count(*) FILTER (WHERE created_at > now() - interval '1 hour')                       AS tx_last_hour,
           count(*) FILTER (WHERE created_at > now() - interval '24 hours')                     AS tx_last_day,
           COALESCE(sum(amount_minor) FILTER (WHERE status='posted' AND created_at > now() - interval '24 hours'),0) AS value_last_day_minor,
           count(*) FILTER (WHERE status='failed'   AND created_at > now() - interval '1 hour')  AS failed_last_hour,
           count(*) FILTER (WHERE status IN ('pending','processing') AND created_at < now() - interval '15 minutes') AS stuck,
           count(*) FILTER (WHERE status='held')                                                AS held
         FROM transactions`
      ),
      query(
        `SELECT DISTINCT ON (component) component, status, latency_ms, detail, checked_at
           FROM service_health ORDER BY component, checked_at DESC`
      ),
      query(
        `SELECT count(*) FILTER (WHERE status IN ('open','assigned')) AS open_cases,
                count(*) FILTER (WHERE status IN ('open','assigned') AND sla_due_at < now()) AS breached,
                (SELECT count(*) FROM outbox WHERE status='queued') AS outbox_queued,
                (SELECT count(*) FROM outbox WHERE status='dead')   AS outbox_dead
           FROM review_cases`
      ),
      query(`SELECT * FROM incidents WHERE status='open' ORDER BY opened_at DESC LIMIT 20`)
    ]);

    res.json({
      volumes: volumes.rows[0],
      rails: rails.rows,
      queues: queues.rows[0],
      incidents: incidents.rows,
      generatedAt: new Date().toISOString()
    });
  } catch (err) { next(err); }
});

/** Throughput and failure rate by 5-minute bucket, for the live chart. */
towerRouter.get('/throughput',
  validate(z.object({ hours: z.coerce.number().int().min(1).max(72).default(6) }), 'query'),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT date_trunc('hour', created_at)
                  + (floor(extract(minute from created_at)/5)::int * interval '5 minutes') AS bucket,
                count(*) AS total,
                count(*) FILTER (WHERE status='posted') AS posted,
                count(*) FILTER (WHERE status='failed') AS failed,
                COALESCE(sum(amount_minor) FILTER (WHERE status='posted'),0) AS value_minor
           FROM transactions
          WHERE created_at > now() - ($1 || ' hours')::interval
          GROUP BY 1 ORDER BY 1`,
        [req.query.hours]
      );
      res.json({ buckets: rows });
    } catch (err) { next(err); }
  });

/** Re-probe every rail on demand and store the result. */
towerRouter.post('/health-check', async (_req, res, next) => {
  try {
    const results = await healthSnapshot();
    for (const r of results) {
      await query(
        'INSERT INTO service_health (component, status, latency_ms, detail) VALUES ($1,$2,$3,$4)',
        [r.component, r.status, r.latencyMs, r.detail]
      );
    }
    res.json({ components: results });
  } catch (err) { next(err); }
});

towerRouter.get('/reconciliation', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.account_number, a.balance_minor AS platform_minor,
              COALESCE(l.net_minor, 0) AS ledger_minor,
              a.balance_minor - COALESCE(l.net_minor, 0) AS variance_minor,
              a.synced_at
         FROM accounts a
         LEFT JOIN (
           SELECT account_id,
                  sum(CASE WHEN side='CR' THEN amount_minor ELSE -amount_minor END) AS net_minor
             FROM ledger_entries WHERE gl_code='2010' GROUP BY account_id
         ) l ON l.account_id = a.id
        WHERE a.balance_minor <> COALESCE(l.net_minor, 0)
        ORDER BY abs(a.balance_minor - COALESCE(l.net_minor, 0)) DESC
        LIMIT 100`
    );
    res.json({ breaks: rows, clean: rows.length === 0 });
  } catch (err) { next(err); }
});

towerRouter.post('/incidents',
  validate(z.object({
    title: z.string().min(4),
    severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
    component: z.string().optional(),
    notes: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        'INSERT INTO incidents (title, severity, component, notes) VALUES ($1,$2,$3,$4) RETURNING *',
        [req.body.title, req.body.severity, req.body.component || null, req.body.notes || null]
      );
      res.status(201).json({ incident: rows[0] });
    } catch (err) { next(err); }
  });

towerRouter.post('/incidents/:id/resolve', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE incidents SET status='resolved', resolved_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ incident: rows[0] });
  } catch (err) { next(err); }
});

towerRouter.post('/outbox/:id/retry', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE outbox SET status='queued', next_run_at=now(), attempts=0 WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    res.json({ job: rows[0] });
  } catch (err) { next(err); }
});
