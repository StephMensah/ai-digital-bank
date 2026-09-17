import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const handlers = new Map();
export const onTopic = (topic, fn) => handlers.set(topic, fn);

export async function enqueue(topic, payload, client) {
  const runner = client || { query };
  await runner.query('INSERT INTO outbox (topic, payload) VALUES ($1,$2)', [topic, payload]);
}

const MAX_ATTEMPTS = 8;

export async function drainOnce(batch = 20) {
  const { rows } = await query(
    `UPDATE outbox SET locked_at = now()
      WHERE id IN (
        SELECT id FROM outbox
         WHERE status='queued' AND next_run_at <= now()
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
      RETURNING *`,
    [batch]
  );

  for (const job of rows) {
    const handler = handlers.get(job.topic);
    if (!handler) {
      await query('UPDATE outbox SET status=$2, last_error=$3 WHERE id=$1',
        [job.id, 'dead', `no handler for ${job.topic}`]);
      continue;
    }
    try {
      await handler(job.payload);
      await query('UPDATE outbox SET status=$2, locked_at=NULL WHERE id=$1', [job.id, 'done']);
    } catch (err) {
      const attempts = job.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(2 ** attempts * 5, 3600);
      await query(
        `UPDATE outbox SET attempts=$2, status=$3, last_error=$4, locked_at=NULL,
                next_run_at = now() + ($5 || ' seconds')::interval
          WHERE id=$1`,
        [job.id, attempts, dead ? 'dead' : 'queued', err.message, backoffSeconds]
      );
      logger.warn({ jobId: job.id, topic: job.topic, attempts, err: err.message }, 'outbox job failed');
    }
  }
  return rows.length;
}

export function startOutboxWorker(intervalMs = 5000) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await drainOnce(); }
    catch (err) { logger.error({ err }, 'outbox drain failed'); }
    finally { running = false; }
  }, intervalMs);
}
