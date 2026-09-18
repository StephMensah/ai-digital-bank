import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../db/pool.js';
import { hashSecret, verifySecret } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { signAccessToken, signRefreshToken, authenticate } from '../middleware/auth.js';
import { audit, auditFrom } from '../middleware/audit.js';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

const msisdn = z.string().regex(/^\+233\d{9}$/, 'Use a Ghana mobile number in +233 format');
const password = z.string().min(10, 'Use at least 10 characters');

authRouter.post('/register',
  loginLimiter,
  validate(z.object({
    fullName: z.string().min(3),
    msisdn,
    email: z.string().email().optional(),
    password,
    dateOfBirth: z.string().date().optional()
  })),
  async (req, res, next) => {
    try {
      const { fullName, msisdn: phone, email, password: pw, dateOfBirth } = req.body;
      const { rows: dupe } = await query('SELECT id FROM customers WHERE msisdn=$1 OR (email IS NOT NULL AND email=$2)', [phone, email || null]);
      if (dupe[0]) throw conflict('An account already exists for that number or email');

      const { rows } = await query(
        `INSERT INTO customers (msisdn, email, full_name, date_of_birth, password_hash)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, msisdn, email, full_name, kyc_status, kyc_tier, created_at`,
        [phone, email || null, fullName, dateOfBirth || null, hashSecret(pw)]
      );
      const customer = rows[0];
      /* No account yet. A customer exists, and can sign in, but the account
         number is issued once the Ghana Card check and screening clear — which
         is the order a bank actually opens accounts in. */
      await audit({ ...auditFrom(req), actorId: customer.id, actorType: 'customer', action: 'customer.registered', entity: 'customer', entityId: customer.id });

      res.status(201).json({
        customer,
        account: null,
        nextStep: 'verify_identity',
        tokens: issueTokens(customer)
      });
    } catch (err) { next(err); }
  });

authRouter.post('/login',
  loginLimiter,
  validate(z.object({ msisdn, password: z.string().min(1) })),
  async (req, res, next) => {
    try {
      const { rows } = await query('SELECT * FROM customers WHERE msisdn=$1', [req.body.msisdn]);
      const customer = rows[0];
      if (!customer || !verifySecret(req.body.password, customer.password_hash)) {
        throw unauthorized('That number and password do not match');
      }
      if (customer.status !== 'active') throw unauthorized('This profile is not active. Contact support.');
      await audit({ ...auditFrom(req), actorId: customer.id, actorType: 'customer', action: 'customer.login' });
      res.json({ customer: publicCustomer(customer), tokens: issueTokens(customer) });
    } catch (err) { next(err); }
  });

authRouter.post('/staff/login',
  loginLimiter,
  validate(z.object({ email: z.string().email(), password: z.string().min(1) })),
  async (req, res, next) => {
    try {
      const { rows } = await query('SELECT * FROM staff_users WHERE email=$1', [req.body.email.toLowerCase()]);
      const staff = rows[0];
      if (!staff || !verifySecret(req.body.password, staff.password_hash)) {
        throw unauthorized('That email and password do not match');
      }
      await audit({ ...auditFrom(req), actorId: staff.id, actorType: 'staff', action: 'staff.login' });
      res.json({
        staff: { id: staff.id, email: staff.email, fullName: staff.full_name, role: staff.role },
        tokens: {
          accessToken: signAccessToken({ sub: staff.id, type: 'staff', role: staff.role }),
          refreshToken: signRefreshToken({ sub: staff.id, type: 'staff' })
        }
      });
    } catch (err) { next(err); }
  });

authRouter.get('/me', authenticate(), (req, res) => {
  res.json({ customer: req.customer || null, staff: req.staff || null });
});

authRouter.post('/pin',
  authenticate('customer'),
  validate(z.object({ pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits') })),
  async (req, res, next) => {
    try {
      await query('UPDATE customers SET pin_hash=$2, updated_at=now() WHERE id=$1',
        [req.customer.id, hashSecret(req.body.pin)]);
      res.json({ updated: true });
    } catch (err) { next(err); }
  });

function issueTokens(customer) {
  return {
    accessToken: signAccessToken({ sub: customer.id, type: 'customer', tier: customer.kyc_tier }),
    refreshToken: signRefreshToken({ sub: customer.id, type: 'customer' }),
    expiresIn: 900
  };
}

function publicCustomer(c) {
  return {
    id: c.id, msisdn: c.msisdn, email: c.email, full_name: c.full_name,
    kyc_status: c.kyc_status, kyc_tier: c.kyc_tier, created_at: c.created_at
  };
}
