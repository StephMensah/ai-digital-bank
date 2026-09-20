import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

/**
 * The Python service owns the models and automations. This module is the bank's
 * side of that contract: it assembles features, calls the model, and falls back
 * to deterministic rules when the model is unreachable so payments never stall
 * on an ML outage.
 */
export async function scoreTransaction({ customer, account, intent }) {
  const features = await buildFeatures({ customer, account, intent });

  if (isConfigured.python()) {
    try {
      /* /score/transaction never existed on the decision service — the path is
         /api/score/transaction, and every call has been 404ing silently since
         this was written, so the fraud agent was never once consulted and every
         payment was scored by the fallback rules. */
      const res = await request(`${config.python.url}/api/score/transaction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.python.token ? { Authorization: `Bearer ${config.python.token}` } : {})
        },
        body: features,
        timeoutMs: 2500,
        retries: 1,
        label: 'risk model'
      });
      if (res.ok && res.body?.available === false) {
        // The engine answered and said it cannot score. That is not the same as
        // being unreachable, and it should be visible rather than swallowed.
        logger.warn({ reason: res.body.reason }, 'decision engine declined to score');
      } else if (res.ok && typeof res.body?.score === 'number') {
        return decide({
          score: res.body.score,
          reasons: res.body.reasons || [],
          model: res.body.model_version || 'python',
          /* The engine publishes a confidence floor per use case. Below it, the
             governance rule is that nothing decides alone — so a low-confidence
             answer goes to a person even when the score itself looks calm. */
          forceReview: Boolean(res.body.below_floor || res.body.adverse),
          features
        });
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'risk model unavailable, using fallback rules');
    }
  }
  return decide({ ...fallbackRules(features), model: 'rules_v1', features });
}

async function buildFeatures({ customer, account, intent }) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE created_at > now() - interval '1 hour')          AS tx_last_hour,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours')        AS tx_last_day,
       COALESCE(sum(amount_minor) FILTER (WHERE created_at > now() - interval '24 hours'), 0) AS sum_last_day,
       COALESCE(avg(amount_minor) FILTER (WHERE created_at > now() - interval '90 days'), 0)  AS avg_amount_90d,
       count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours') AS failed_last_day
     FROM transactions WHERE account_id = $1`,
    [account.id]
  );
  const s = rows[0] || {};
  const accountAgeDays = (Date.now() - new Date(customer.created_at).getTime()) / 86_400_000;

  return {
    amount_minor: intent.amountMinor,
    currency: intent.currency || 'GHS',
    kind: intent.kind,
    channel: intent.channel,
    method: intent.method || null,
    counterparty_new: Boolean(intent.counterpartyIsNew),
    kyc_tier: customer.kyc_tier,
    kyc_status: customer.kyc_status,
    account_age_days: Number(accountAgeDays.toFixed(2)),
    balance_minor: account.balance_minor,
    tx_last_hour: Number(s.tx_last_hour || 0),
    tx_last_day: Number(s.tx_last_day || 0),
    sum_last_day_minor: Number(s.sum_last_day || 0),
    avg_amount_90d_minor: Number(s.avg_amount_90d || 0),
    failed_last_day: Number(s.failed_last_day || 0),
    hour_of_day: new Date().getUTCHours()
  };
}

function fallbackRules(f) {
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push(reason); };

  if (f.kyc_status !== 'verified') add(25, 'Customer is not KYC verified');
  if (f.account_age_days < 3) add(20, 'Account opened in the last 3 days');
  if (f.counterparty_new && f.amount_minor > 50_000) add(15, 'Large payment to a new counterparty');
  if (f.avg_amount_90d_minor > 0 && f.amount_minor > f.avg_amount_90d_minor * 8) {
    add(25, 'Amount is far above this customer\u2019s normal');
  }
  if (f.tx_last_hour >= 6) add(20, 'Unusual burst of payments in the last hour');
  if (f.failed_last_day >= 3) add(15, 'Repeated failed attempts today');
  if (f.hour_of_day >= 1 && f.hour_of_day <= 4) add(8, 'Payment outside normal active hours');
  if (f.amount_minor > f.balance_minor) add(10, 'Amount exceeds current balance');

  return { score: Math.min(score, 100), reasons };
}

function decide({ score, reasons, model, features, forceReview = false }) {
  let action = 'allow';
  if (score >= config.risk.decline) action = 'decline';
  else if (score >= config.risk.review) action = 'review';
  /* Below the model's published confidence floor, or adverse to the customer,
     nothing decides alone — that is the governance rule the engine exists to
     enforce, and a calm-looking score does not override it. */
  if (forceReview && action === 'allow') action = 'review';
  return { score: Number(score.toFixed(2)), reasons, action, model, features };
}

/** Optional hand-off to Python automations (statement parsing, reconciliation, insights). */
export async function runAutomation(name, payload) {
  if (!isConfigured.python()) return { queued: false, reason: 'python service not configured' };
  /* Same path bug as the scorer: the decision service serves everything under
     /api, and these were pointed one level up. */
  const res = await request(`${config.python.url}/api/automations/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.python.token ? { Authorization: `Bearer ${config.python.token}` } : {})
    },
    body: payload,
    timeoutMs: 20000,
    retries: 1,
    label: `automation ${name}`
  });
  return res.body;
}
