import { momo } from './momo.js';
import { paystack } from './paystack.js';
import { kyc } from './kyc.js';
import { ghipss } from './ghipss.js';
import { hubtel } from './hubtel.js';
import { mambu } from '../core/mambu.js';
import { mock } from './mock.js';
import { config } from '../config.js';
import { isConfigured } from '../config.js';
import { badRequest } from '../lib/errors.js';

export const providers = { momo, paystack, kyc, ghipss, hubtel, mock };

export const usingMocks = () => config.mockProviders;

/** Route a money-in/out instruction to the right rail. */
export function railFor(method) {
  if (config.mockProviders && ['mobile_money', 'card', 'bank'].includes(method)) return mock;
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
  if (config.mockProviders) {
    // Labelled mock, never up: the control tower should never imply a live rail.
    const detail = {
      mambu: isConfigured.mambu() ? 'live core, mock rails' : 'not configured, core postings skipped',
      mtn_momo: 'sandbox rail', hubtel: 'sandbox rail', decision_engine: 'not probed under mocks',
      paystack: 'sandbox rail', ghipss_gip: 'sandbox rail', identity: 'sandbox rail'
    };
    return Object.keys(detail).map((component) => ({
      component, status: 'mock', detail: detail[component], latencyMs: 1
    }));
  }

  const components = [
    ['mambu', isConfigured.mambu(), () => mambu.ping()],
    ['mtn_momo', momo.configured(), () => momo.ping()],
    ['hubtel', hubtel.configured(), () => hubtel.ping()],
    ['paystack', paystack.configured(), () => paystack.ping()],
    ['ghipss_gip', ghipss.configured(), () => ghipss.ping()],
    ['identity', kyc.configured(), () => kyc.ping()],
    /* The decision engine was never probed, which is why a scorer calling a
       path that did not exist went unnoticed for as long as it did. */
    ['decision_engine', Boolean(config.python.url), async () => {
      const { request } = await import('../lib/http.js');
      const res = await request(`${config.python.url}/api/score/transaction`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { amountMinor: 100, hour: 12 }, timeoutMs: 2500, label: 'engine probe'
      });
      if (!res.ok) throw new Error(`engine answered ${res.status}`);
      if (res.body?.available === false) throw new Error(res.body.reason || 'engine cannot score');
      return { status: 'up', detail: res.body?.model_version };
    }]
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
