import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export async function audit({ actorId, actorType, action, entity, entityId, ip, before, after }) {
  try {
    await query(
      `INSERT INTO audit_log (actor_id, actor_type, action, entity, entity_id, ip, before_data, after_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [actorId || null, actorType || null, action, entity || null, entityId || null, ip || null,
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  } catch (err) {
    logger.error({ err, action }, 'audit write failed');
  }
}

export const auditFrom = (req) => ({
  actorId: req.customer?.id || req.staff?.id || null,
  actorType: req.customer ? 'customer' : req.staff ? 'staff' : 'anonymous',
  ip: req.ip
});
