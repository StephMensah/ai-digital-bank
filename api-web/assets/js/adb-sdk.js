/*!
 * Digital Bank — browser SDK
 * Drop into any page: <script src="/assets/js/adb-sdk.js"></script>
 * Then: const adb = ADB.client();
 *
 * Handles token storage, silent refresh, idempotency keys and typed errors
 * so index.html, web.html, app.html, reviewer-console.html and
 * control-tower.html all talk to the API the same way.
 */
(function (global) {
  'use strict';

  const STORE = 'adb.session';

  class ApiError extends Error {
    constructor(status, payload) {
      super(payload?.error?.message || 'Something went wrong. Try again.');
      this.status = status;
      this.code = payload?.error?.code || 'unknown';
      this.details = payload?.error?.details || null;
    }
  }

  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); }
    catch { return null; }
  }
  function saveSession(s) {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  }

  function idempotencyKey() {
    return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, '');
  }

  function client(options) {
    const baseUrl = (options && options.baseUrl) || '/api/v1';
    const listeners = new Set();
    const emit = (event, data) => listeners.forEach((fn) => fn(event, data));

    async function raw(path, { method = 'GET', body, auth = true, idempotent = false, headers = {} } = {}) {
      const session = loadSession();
      const h = { 'Content-Type': 'application/json', ...headers };
      if (auth && session?.accessToken) h.Authorization = `Bearer ${session.accessToken}`;
      if (idempotent) h['Idempotency-Key'] = headers['Idempotency-Key'] || idempotencyKey();

      const res = await fetch(baseUrl + path, {
        method, headers: h, body: body ? JSON.stringify(body) : undefined
      });
      const payload = res.status === 204 ? null : await res.json().catch(() => null);

      if (res.status === 401 && auth) {
        saveSession(null);
        emit('signed-out', { reason: payload?.error?.code });
      }
      if (!res.ok) throw new ApiError(res.status, payload);
      return payload;
    }

    const api = {
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      session: loadSession,
      signOut() { saveSession(null); emit('signed-out', { reason: 'user' }); },
      isSignedIn: () => Boolean(loadSession()?.accessToken),

      // ---- auth ----
      async register(input) {
        const out = await raw('/auth/register', { method: 'POST', body: input, auth: false });
        saveSession({ ...out.tokens, subject: out.customer, type: 'customer' });
        emit('signed-in', out.customer);
        return out;
      },
      async login(msisdn, password) {
        const out = await raw('/auth/login', { method: 'POST', body: { msisdn, password }, auth: false });
        saveSession({ ...out.tokens, subject: out.customer, type: 'customer' });
        emit('signed-in', out.customer);
        return out;
      },
      async staffLogin(email, password) {
        const out = await raw('/auth/staff/login', { method: 'POST', body: { email, password }, auth: false });
        saveSession({ ...out.tokens, subject: out.staff, type: 'staff' });
        emit('signed-in', out.staff);
        return out;
      },
      me: () => raw('/auth/me'),
      setPin: (pin) => raw('/auth/pin', { method: 'POST', body: { pin } }),

      // ---- accounts ----
      accounts: () => raw('/accounts'),
      account: (id) => raw(`/accounts/${id}`),
      syncAccount: (id) => raw(`/accounts/${id}/sync`, { method: 'POST' }),
      transactions: (id, { limit = 25, cursor } = {}) =>
        raw(`/accounts/${id}/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
      statement: (id) => raw(`/accounts/${id}/statement`),

      // ---- money movement ----
      deposit: (input) => raw('/payments/deposits', { method: 'POST', body: input, idempotent: true }),
      payout: (input) => raw('/payments/payouts', { method: 'POST', body: input, idempotent: true }),
      transfer: (input) => raw('/transfers', { method: 'POST', body: input, idempotent: true }),
      resolveInternal: (accountNumber) => raw(`/transfers/resolve/${accountNumber}`),
      nameEnquiry: (input) => raw('/payments/name-enquiry', { method: 'POST', body: input }),
      banks: () => raw('/payments/banks'),
      trackPayment: (reference) => raw(`/payments/transactions/${reference}`),

      /** Poll a pending payment until it settles or fails. */
      async awaitSettlement(reference, { timeoutMs = 120000, intervalMs = 3000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { transaction } = await api.trackPayment(reference);
          if (['posted', 'failed', 'reversed'].includes(transaction.status)) return transaction;
          emit('payment-pending', transaction);
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        throw new ApiError(408, { error: { code: 'timeout', message: 'This is taking longer than usual. We will text you when it lands.' } });
      },

      // ---- kyc ----
      kycStatus: () => raw('/kyc/status'),
      submitGhanaCard: (input) => raw('/kyc/ghana-card', { method: 'POST', body: input }),

      // ---- insights ----
      insights: (accountId) => raw(`/ai/insights/${accountId}`),
      assist: (question, accountId) => raw('/ai/assist', { method: 'POST', body: { question, accountId } }),

      // ---- reviewer console ----
      reviewer: {
        cases: (params = {}) => raw(`/reviewer/cases?${new URLSearchParams(params)}`),
        case: (id) => raw(`/reviewer/cases/${id}`),
        claim: (id) => raw(`/reviewer/cases/${id}/claim`, { method: 'POST' }),
        decide: (id, decision, note) => raw(`/reviewer/cases/${id}/decide`, { method: 'POST', body: { decision, note } }),
        metrics: () => raw('/reviewer/metrics')
      },

      // ---- control tower ----
      tower: {
        overview: () => raw('/control-tower/overview'),
        throughput: (hours = 6) => raw(`/control-tower/throughput?hours=${hours}`),
        healthCheck: () => raw('/control-tower/health-check', { method: 'POST' }),
        reconciliation: () => raw('/control-tower/reconciliation'),
        openIncident: (input) => raw('/control-tower/incidents', { method: 'POST', body: input }),
        resolveIncident: (id) => raw(`/control-tower/incidents/${id}/resolve`, { method: 'POST' }),
        retryJob: (id) => raw(`/control-tower/outbox/${id}/retry`, { method: 'POST' })
      },

      /** Re-fetch on an interval; returns a stop function. */
      poll(fn, ms = 10000) {
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          try { await fn(); } catch (err) { emit('poll-error', err); }
          if (!stopped) setTimeout(tick, ms);
        };
        tick();
        return () => { stopped = true; };
      },

      raw
    };
    return api;
  }

  const money = {
    /** Parse a typed amount ("120.50") into pesewas. */
    toMinor: (input) => Math.round(Number(String(input).replace(/[^0-9.]/g, '')) * 100),
    format: (minor, currency = 'GHS') =>
      new Intl.NumberFormat('en-GH', { style: 'currency', currency }).format(Number(minor || 0) / 100),
    formatCompact: (minor) =>
      new Intl.NumberFormat('en-GH', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(minor || 0) / 100)
  };

  const validate = {
    msisdn: (v) => /^\+233\d{9}$/.test(String(v).trim()),
    ghanaCard: (v) => /^GHA-\d{9}-\d$/.test(String(v).trim().toUpperCase()),
    accountNumber: (v) => /^\d{10}$/.test(String(v).trim())
  };

  const ADB = { client, money, validate, ApiError };
  if (typeof module !== 'undefined' && module.exports) module.exports = ADB;
  global.ADB = ADB;
})(typeof window !== 'undefined' ? window : globalThis);
