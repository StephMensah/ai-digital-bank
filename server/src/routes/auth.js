import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../db/pool.js';
import { hashSecret, verifySecret } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { normaliseMsisdn } from '../lib/msisdn.js';
import { validate } from '../middleware/validate.js';
import { signAccessToken, signRefreshToken, authenticate } from '../middleware/auth.js';
import { audit, auditFrom } from '../middleware/audit.js';

export const authRouter = Router();

/* Ten attempts per fifteen minutes in production. The test suite registers a
   dozen customers in seconds and would trip it, so AUTH_RATE_LIMIT can raise
   it there — never set it on the live service. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT || 10),
  standardHeaders: true, legacyHeaders: false
});

/* Accepts 0241234567, 241234567 or +233241234567 and hands on the canonical
   +233 form, so the number a customer types is never the number we store. */
const msisdn = z.string().transform((v, ctx) => {
  const norm = normaliseMsisdn(v);
  if (!norm) {
    ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Enter a Ghana mobile number, for example 024 123 4567' });
    return z.NEVER;
  }
  return norm;
});
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
      /* An abandoned signup leaves a customer with a password and nothing
         else: no PIN, no verification, no account. Blocking that number
         forever strands the person, so a signup that never got anywhere is
         resumable — the new details replace the old ones and onboarding
         starts again. The moment there is a PIN, a verification or an
         account, the number is taken and stays taken.

         In production this needs an OTP to the number first, or someone
         could claim a stranger's abandoned signup. There is nothing behind
         one to claim today, but the check belongs here before real money. */
      const { rows: existing } = await query(
        `SELECT c.id, c.pin_hash, c.kyc_status,
                (SELECT count(*) FROM accounts a WHERE a.customer_id = c.id) AS accounts
           FROM customers c
          WHERE c.msisdn=$1 OR (c.email IS NOT NULL AND c.email=$2)`,
        [phone, email || null]
      );
      const prior = existing[0];
      /* Unfinished means no account and verification never submitted. Whether a
         PIN was set along the way no longer matters: someone who set a PIN and
         then walked away was locked out of starting again, which is the exact
         case the restart exists for. */
      const incomplete = prior && Number(prior.accounts) === 0 && prior.kyc_status === 'pending';
      if (prior && !incomplete) throw conflict('An account already exists for that number or email');

      const { rows } = incomplete
        ? await query(
            `UPDATE customers
                SET full_name=$2, email=$3, date_of_birth=$4, password_hash=$5,
                    pin_hash=NULL, must_change_pin=true, updated_at=now()
              WHERE id=$1
              RETURNING id, msisdn, email, full_name, kyc_status, kyc_tier, created_at`,
            [prior.id, fullName, email || null, dateOfBirth || null, hashSecret(pw)]
          )
        : await query(
            `INSERT INTO customers (msisdn, email, full_name, date_of_birth, password_hash)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING id, msisdn, email, full_name, kyc_status, kyc_tier, created_at`,
            [phone, email || null, fullName, dateOfBirth || null, hashSecret(pw)]
          );
      const customer = rows[0];
      /* No account yet. A customer exists, and can sign in, but the account
         number is issued once the Ghana Card check and screening clear — which
         is the order a bank actually opens accounts in. */
      await audit({ ...auditFrom(req), actorId: customer.id, actorType: 'customer', action: incomplete ? 'customer.registration_resumed' : 'customer.registered',
        entity: 'customer', entityId: customer.id });

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
