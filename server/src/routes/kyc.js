import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { providers } from '../providers/index.js';
import { mambu } from '../core/mambu.js';
import { isConfigured } from '../config.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { logger } from '../lib/logger.js';

export const kycRouter = Router();
kycRouter.use(authenticate('customer'));

kycRouter.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT check_type, provider, result, score, created_at FROM kyc_checks WHERE customer_id=$1 ORDER BY created_at DESC',
      [req.customer.id]
    );
    const { rows: limits } = await query('SELECT * FROM limit_profiles WHERE tier=$1', [req.customer.kyc_tier]);
    res.json({ status: req.customer.kyc_status, tier: req.customer.kyc_tier, limits: limits[0], checks: rows });
  } catch (err) { next(err); }
});

kycRouter.post('/ghana-card',
  validate(z.object({
    idNumber: z.string().regex(/^GHA-\d{9}-\d$/, 'Enter your Ghana Card number as GHA-000000000-0'),
    selfieBase64: z.string().optional()
  })),
  async (req, res, next) => {
    try {
      const identity = await providers.kyc.ghanaCard({ idNumber: req.body.idNumber });
      let matchScore = null;
      if (req.body.selfieBase64 && identity?.picture) {
        const match = await providers.kyc.selfieMatch({
          selfieBase64: req.body.selfieBase64, idBase64: identity.picture
        });
        matchScore = Number(match?.confidence_value ?? match?.match_score ?? 0);
      }

      const nameMatches = normalise(identity?.full_name || `${identity?.first_name || ''} ${identity?.surname || ''}`)
        === normalise(req.customer.full_name);
      const passed = Boolean(identity) && nameMatches && (matchScore === null || matchScore >= 70);

      await query(
        `INSERT INTO kyc_checks (customer_id, check_type, provider, provider_ref, result, score, payload)
         VALUES ($1,'ghana_card','identity',$2,$3,$4,$5)`,
        [req.customer.id, req.body.idNumber, passed ? 'passed' : 'referred', matchScore,
         JSON.stringify({ nameMatches, matchScore })]
      );

      if (passed) {
        await query(
          `UPDATE customers SET kyc_status='verified', kyc_tier=GREATEST(kyc_tier,2), updated_at=now() WHERE id=$1`,
          [req.customer.id]
        );
        if (isConfigured.mambu() && req.customer.mambu_client_key) {
          mambu.patchClientState(req.customer.mambu_client_key, 'ACTIVE')
            .catch((err) => logger.warn({ err: err.message }, 'mambu client activation deferred'));
        }
      } else {
        await query(`UPDATE customers SET kyc_status='in_review', updated_at=now() WHERE id=$1`, [req.customer.id]);
        await query(
          `INSERT INTO review_cases (case_type, customer_id, priority, summary, sla_due_at)
           VALUES ('kyc',$1,'medium',$2, now() + interval '4 hours')`,
          [req.customer.id, 'Ghana Card details need a manual look']
        );
      }
      await audit({ ...auditFrom(req), action: 'kyc.ghana_card_submitted', entity: 'customer', entityId: req.customer.id });

      res.json({
        status: passed ? 'verified' : 'in_review',
        tier: passed ? 2 : req.customer.kyc_tier,
        message: passed
          ? 'You are verified. Your limits have gone up.'
          : 'We need a closer look at your details. This usually takes a few hours.'
      });
    } catch (err) { next(err); }
  });

const normalise = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).sort().join(' ').trim();
