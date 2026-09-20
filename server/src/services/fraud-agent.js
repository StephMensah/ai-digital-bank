/**
 * Fraud scoring, in-process.
 *
 * This is the FraudAgent from aibank_engine.py, ported rather than called. The
 * Python service was a second thing to deploy, keep warm and pay for, and the
 * scoring path could not tolerate its cold start: a payment decision that waits
 * fifty seconds for a sleeping service is a payment decision that falls back to
 * rules, which is exactly what was happening.
 *
 * The governance the Python engine carried comes with it, because that is the
 * part that matters:
 *
 *  - a published confidence floor per use case, below which nothing decides
 *    alone and the payment goes to a person
 *  - an adverse-action flag: a decision against the customer is never taken
 *    automatically without a route to a human
 *  - a reason in words, because a decline nobody can explain is the thing the
 *    whole layer exists to prevent
 *
 * PYTHON_SERVICE_URL still wins when set, so a real model can be put in front
 * of this without touching the callers.
 */

export const USE_CASE = {
  key: 'retail.fraud_detection',
  name: 'Fraud detection for retail transactions',
  confidenceFloor: 0.80,
  dpiaRef: 'DPIA-2026-014',
  automatedDecision: true,
  dataCategories: ['account', 'transaction', 'device', 'geolocation'],
  model: 'adb://retail-fraud/v3:score'
};

/**
 * The same shape the Python agent used: amount dominates, a foreign leg and the
 * small hours each add weight. Deterministic — the jitter in the original was
 * there to make a demo look alive, and a payment decision that differs between
 * two identical requests is not something to reproduce.
 */
function infer({ amountMajor, foreign, hour, newBeneficiary, velocity }) {
  let score = 0.05;
  score += foreign ? 0.35 : 0;
  score += hour < 5 ? 0.20 : 0;
  score += Math.min(0.35, amountMajor / 60_000);
  // Two signals the Python agent did not have, and both matter more than the hour
  score += newBeneficiary ? 0.12 : 0;
  score += Math.min(0.15, Math.max(0, (velocity - 3) * 0.05));

  const reasons = [];
  if (amountMajor >= 5_000) reasons.push({ label: `Large amount, GHS ${amountMajor.toLocaleString('en-GH')}`, weight: Math.min(0.35, amountMajor / 60_000).toFixed(2) });
  if (foreign) reasons.push({ label: 'Destination outside Ghana', weight: '0.35' });
  if (hour < 5) reasons.push({ label: `Sent at ${String(hour).padStart(2, '0')}:00`, weight: '0.20' });
  if (newBeneficiary) reasons.push({ label: 'First payment to this beneficiary', weight: '0.12' });
  if (velocity > 3) reasons.push({ label: `${velocity} payments in the last hour`, weight: '0.10' });

  if (score > 0.55) {
    return {
      action: 'BLOCK_AND_STEP_UP',
      confidence: Math.min(0.99, 0.62 + score / 3),
      adverse: true,
      reasons: reasons.length ? reasons : [{ label: 'Pattern outside this customer’s usual behaviour', weight: '0.55' }]
    };
  }
  return {
    action: 'APPROVE',
    confidence: Math.max(0.5, 0.96 - score / 2),
    adverse: false,
    reasons: reasons.length ? reasons : [{ label: 'Within this customer’s behavioural envelope', weight: '0.05' }]
  };
}

/**
 * Returns the same envelope the Python endpoint did, so the caller does not
 * care which one answered.
 */
export function scoreLocally(features) {
  const amountMajor = Number(features.amountMinor || 0) / 100;
  const verdict = infer({
    amountMajor,
    foreign: Boolean(features.foreign),
    hour: Number.isInteger(features.hour) ? features.hour : new Date().getHours(),
    newBeneficiary: Boolean(features.newBeneficiary),
    velocity: Number(features.velocity || 0)
  });

  // The engine speaks confidence in its own decision; the ledger wants risk.
  const score = verdict.action === 'APPROVE'
    ? Math.round((1 - verdict.confidence) * 100)
    : Math.round(verdict.confidence * 100);

  return {
    available: true,
    score: Math.max(0, Math.min(100, score)),
    action: verdict.action,
    confidence: Number(verdict.confidence.toFixed(4)),
    below_floor: verdict.confidence < USE_CASE.confidenceFloor,
    adverse: verdict.adverse,
    reasons: verdict.reasons,
    model_version: USE_CASE.model,
    use_case: USE_CASE.key,
    dpia: USE_CASE.dpiaRef
  };
}
