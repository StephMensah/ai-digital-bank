import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export function signAccessToken({ sub, type, role, tier }) {
  return jwt.sign({ sub, type, role, tier }, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl, issuer: 'ai-digital-bank'
  });
}

export function signRefreshToken({ sub, type }) {
  return jwt.sign({ sub, type }, config.jwt.refreshSecret, {
    expiresIn: `${config.jwt.refreshTtlDays}d`, issuer: 'ai-digital-bank'
  });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7);
}

export function authenticate(expectedType) {
  return async (req, _res, next) => {
    try {
      const token = readToken(req);
      if (!token) throw unauthorized();
      const claims = jwt.verify(token, config.jwt.secret, { issuer: 'ai-digital-bank' });
      if (expectedType && claims.type !== expectedType) throw forbidden('Wrong credential type for this area');

      if (claims.type === 'customer') {
        const { rows } = await query(
          `SELECT id, msisdn, full_name, email, kyc_status, kyc_tier, status, mambu_client_key,
                  pin_hash, must_change_pin, created_at
             FROM customers WHERE id=$1`,
          [claims.sub]
        );
        if (!rows[0]) throw unauthorized('Session no longer valid');
        if (rows[0].status !== 'active') throw forbidden('This profile is not active. Contact support.');
        req.customer = rows[0];
      } else {
        const { rows } = await query(
          'SELECT id, email, full_name, role, status FROM staff_users WHERE id=$1', [claims.sub]
        );
        if (!rows[0] || rows[0].status !== 'active') throw unauthorized('Session no longer valid');
        req.staff = rows[0];
      }
      req.auth = claims;
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') return next(unauthorized('Session expired. Sign in again.'));
      if (err.name === 'JsonWebTokenError') return next(unauthorized());
      next(err);
    }
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.staff || !roles.includes(req.staff.role)) return next(forbidden());
    next();
  };
}
