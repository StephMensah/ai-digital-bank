import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream, badRequest } from '../lib/errors.js';
import { sha256Hmac, safeEqual } from '../lib/crypto.js';

/**
 * GhIPSS — Ghana Interbank Payment and Settlement Systems.
 *
 * Covers GIP (instant pay) for interbank credit transfers and name enquiry.
 * GhIPSS issues per-institution specs, so every path is overridable from env
 * (GHIPSS_PATH_*) rather than hard-coded. Defaults follow the common GIP
 * REST profile: OAuth2 client-credentials, then name enquiry before transfer.
 *
 * GIP rules this client enforces so the scheme does not reject us:
 *  - a funds transfer must quote the session id returned by name enquiry
 *  - session ids are institution code + timestamp + sequence, 12+ chars
 *  - amounts are sent in major units with two decimals, not minor units
 */

let cachedToken = null; // { value, expiresAt }

async function token() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const res = await request(`${config.ghipss.baseUrl}${config.ghipss.paths.token}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${config.ghipss.clientId}:${config.ghipss.clientSecret}`).toString('base64')}`
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'gip' }).toString(),
    label: 'ghipss token',
    retries: 2
  });

  if (!res.ok || !res.body?.access_token) {
    throw upstream('Could not authenticate with GhIPSS', res.body);
  }
  cachedToken = {
    value: res.body.access_token,
    expiresAt: Date.now() + (Number(res.body.expires_in || 3000) * 1000)
  };
  return cachedToken.value;
}

async function call(path, { method = 'POST', body, label } = {}) {
  const bearer = await token();
  const res = await request(`${config.ghipss.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'X-Institution-Code': config.ghipss.institutionCode
    },
    body,
    label: label || `ghipss ${path}`,
    retries: method === 'GET' ? 3 : 0
  });

  // A 401 usually means the cached token was revoked early — drop it so the
  // next call re-authenticates instead of failing the whole batch.
  if (res.status === 401) {
    cachedToken = null;
    throw upstream('GhIPSS rejected the session, retry', res.body);
  }
  if (!res.ok || (res.body?.responseCode && res.body.responseCode !== '000')) {
    throw upstream(res.body?.responseMessage || 'GhIPSS request failed', res.body);
  }
  return res.body;
}

/** institutionCode + yyyymmddHHMMSS + 6 random digits, per GIP session id rules. */
function sessionId() {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const seq = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `${config.ghipss.institutionCode}${ts}${seq}`;
}

const toMajor = (minor) => (Number(minor) / 100).toFixed(2);

// GIP returns scheme response codes; map them onto our transaction states.
const STATUS = {
  '000': 'posted',       // approved / completed
  '001': 'processing',   // in progress
  '909': 'processing',   // pending settlement
  '912': 'failed',       // invalid account
  '913': 'failed',       // account closed
  '914': 'failed',       // limit exceeded
  '916': 'failed'        // insufficient funds at counterparty
};

export const ghipss = {
  name: 'ghipss',
  configured: () => isConfigured.ghipss(),

  ping: () => token().then(() => ({ status: 'up' })),

  /** Directory of GIP member banks, so the UI can offer a picker. */
  async banks() {
    const body = await call(config.ghipss.paths.banks, { method: 'GET', label: 'ghipss banks' });
    return (body.banks || body.data || []).map((b) => ({
      code: b.bankCode || b.code,
      name: b.bankName || b.name,
      rail: 'gip'
    }));
  },

  /**
   * Name enquiry. GIP requires this before any transfer, and the session id it
   * returns must be quoted on the transfer itself.
   */
  async nameEnquiry({ accountNumber, bankCode }) {
    if (!accountNumber || !bankCode) throw badRequest('Account number and bank are both required');
    const body = await call(config.ghipss.paths.nameEnquiry, {
      body: {
        sessionId: sessionId(),
        destinationBankCode: bankCode,
        accountNumber,
        channelCode: config.ghipss.channelCode
      }
    });
    return {
      accountName: body.accountName || body.customerName,
      accountNumber: body.accountNumber || accountNumber,
      bankCode,
      sessionId: body.sessionId,
      kycLevel: body.kycLevel || null
    };
  },

  /**
   * Interbank credit transfer. `enquiry` is the object returned by nameEnquiry —
   * passing it through keeps the session id, name and account tied together.
   */
  async payout({ amountMinor, reference, narration, enquiry, originator }) {
    if (!enquiry?.sessionId) throw badRequest('Run a name enquiry before sending to a bank account');

    const body = await call(config.ghipss.paths.transfer, {
      body: {
        sessionId: enquiry.sessionId,
        originatorAccountNumber: originator.accountNumber,
        originatorName: originator.name,
        originatorBankCode: config.ghipss.institutionCode,
        destinationAccountNumber: enquiry.accountNumber,
        destinationAccountName: enquiry.accountName,
        destinationBankCode: enquiry.bankCode,
        amount: toMajor(amountMinor),
        currency: 'GHS',
        narration: (narration || 'Transfer').slice(0, 100),
        paymentReference: reference,
        channelCode: config.ghipss.channelCode
      }
    });

    return {
      providerRef: body.sessionId || enquiry.sessionId,
      status: STATUS[body.responseCode] || 'processing',
      responseCode: body.responseCode,
      raw: body
    };
  },

  /** Transaction status enquiry — used by the outbox and the control tower. */
  async status(providerRef) {
    const body = await call(`${config.ghipss.paths.status}/${encodeURIComponent(providerRef)}`, {
      method: 'GET',
      label: 'ghipss status'
    });
    return {
      status: STATUS[body.responseCode] || 'processing',
      responseCode: body.responseCode,
      amountMinor: body.amount ? Math.round(Number(body.amount) * 100) : null,
      providerRef,
      raw: body
    };
  },

  verifySignature(rawBody, signatureHeader) {
    if (!config.ghipss.webhookSecret) return false;
    return safeEqual(sha256Hmac(config.ghipss.webhookSecret, rawBody), signatureHeader || '');
  }
};
