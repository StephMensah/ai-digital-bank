import { badRequest } from '../lib/errors.js';

/** Money-moving endpoints require a client-supplied Idempotency-Key. */
export function requireIdempotencyKey(req, _res, next) {
  const key = req.get('Idempotency-Key') || req.body?.idempotencyKey;
  if (!key || String(key).length < 8) {
    return next(badRequest('Send an Idempotency-Key header (at least 8 characters) with this request'));
  }
  req.idempotencyKey = String(key).slice(0, 128);
  next();
}
