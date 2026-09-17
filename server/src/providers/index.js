import { momo } from './momo.js';
import { paystack } from './paystack.js';
import { kyc } from './kyc.js';
import { ghipss } from './ghipss.js';
import { hubtel } from './hubtel.js';
import { mambu } from '../core/mambu.js';
import { isConfigured } from '../config.js';
import { badRequest } from '../lib/errors.js';

export const providers = { momo, paystack, kyc, ghipss, hubtel };

/** Route a money-in/out instruction to the right rail. */
export function railFor(method) {
  switch (method) {
    // Hubtel covers every Ghanaian network on one contract, so it leads when it
    // is configured; the direct MTN MoMo integration stays as the fallback.
    case 'mobile_money': return hubtel.configured() ? hubtel : momo;
    case 'card': return hubtel.configured() ? hubtel : paystack;
    // Interbank goes over GIP when GhIPSS is live; Paystack is the fallback
    // so bank transfers keep working before the scheme connection is signed off.
    case 'bank': return ghipss.configured() ? ghipss : paystack;
    default: throw badRequest(`Unsupported payment method: ${method}`);
  }
}

export async function healthSnapshot() {
  const components = [
    ['mambu', isConfigured.mambu(), () => mambu.ping()],
    ['mtn_momo', momo.configured(), () => momo.ping()],
    ['hubtel', hubtel.configured(), () => hubtel.ping()],
    ['paystack', paystack.configured(), () => paystack.ping()],
    ['ghipss_gip', ghipss.configured(), () => ghipss.ping()],
    ['identity', kyc.configured(), () => kyc.ping()]
  ];

  return Promise.all(components.map(async ([component, ready, probe]) => {
    if (!ready) return { component, status: 'down', detail: 'not configured', latencyMs: null };
    const started = Date.now();
    try {
      await probe();
      const latencyMs = Date.now() - started;
      return { component, status: latencyMs > 3000 ? 'degraded' : 'up', latencyMs, detail: null };
    } catch (err) {
      return { component, status: 'down', latencyMs: Date.now() - started, detail: err.message };
    }
  }));
}
