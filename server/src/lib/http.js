import { logger } from './logger.js';
import { upstream } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with timeout, retry and exponential backoff + jitter.
 * Retries idempotent verbs and 5xx/429 only.
 */
export async function request(url, {
  method = 'GET', headers = {}, body, timeoutMs = 15000,
  retries = 3, label = 'upstream', retryOn = [408, 425, 429, 500, 502, 503, 504]
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body && typeof body !== 'string' ? JSON.stringify(body) : body,
        signal: ctrl.signal
      });
      const latency = Date.now() - started;
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }

      if (!res.ok && retryOn.includes(res.status) && attempt < retries) {
        lastErr = upstream(`${label} returned ${res.status}`, json);
        logger.warn({ label, status: res.status, attempt, latency }, 'retrying upstream call');
        await sleep(2 ** attempt * 250 + Math.random() * 200);
        continue;
      }
      logger.debug({ label, status: res.status, latency }, 'upstream call');
      return { ok: res.ok, status: res.status, body: json, headers: res.headers, latency };
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;
      logger.warn({ label, attempt, err: err.message }, 'upstream call errored, retrying');
      await sleep(2 ** attempt * 250 + Math.random() * 200);
    } finally {
      clearTimeout(timer);
    }
  }
  throw upstream(`${label} unreachable`, { cause: lastErr?.message });
}
