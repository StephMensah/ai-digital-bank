import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream } from '../lib/errors.js';
import { sha256Hmac, safeEqual } from '../lib/crypto.js';

// Paystack: card and bank rails (Ghana supports card, bank and mobile-money channels).
function headers() {
  return {
    Authorization: `Bearer ${config.paystack.secretKey}`,
    'Content-Type': 'application/json'
  };
}

async function call(path, { method = 'GET', body, label } = {}) {
  const res = await request(`${config.paystack.baseUrl}${path}`, {
    method, headers: headers(), body, label: label || `paystack ${path}`,
    retries: method === 'GET' ? 3 : 0
  });
  if (!res.ok || res.body?.status === false) {
    throw upstream(res.body?.message || 'Paystack request failed', res.body);
  }
  return res.body.data;
}

export const paystack = {
  name: 'paystack',
  configured: () => isConfigured.paystack(),

  ping: () => call('/bank?currency=GHS&perPage=1', { label: 'paystack ping' }).then(() => ({ status: 'up' })),

  /** Hosted checkout for card / bank / momo top-ups. */
  async initializeCharge({ email, amountMinor, reference, callbackUrl, channels }) {
    const data = await call('/transaction/initialize', {
      method: 'POST',
      body: {
        email,
        amount: amountMinor,
        currency: 'GHS',
        reference,
        callback_url: callbackUrl,
        channels: channels || ['card', 'bank', 'mobile_money']
      }
    });
    return { providerRef: data.reference, authorizationUrl: data.authorization_url, accessCode: data.access_code };
  },

  async verify(reference) {
    const data = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
    const map = { success: 'posted', failed: 'failed', abandoned: 'failed', reversed: 'reversed' };
    return {
      status: map[data.status] || 'processing',
      amountMinor: data.amount,
      currency: data.currency,
      channel: data.channel,
      providerRef: String(data.id),
      raw: data
    };
  },

  listBanks: () => call('/bank?currency=GHS'),

  resolveAccount: ({ accountNumber, bankCode }) =>
    call(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`),

  async payout({ amountMinor, recipientCode, reference, reason }) {
    const data = await call('/transfer', {
      method: 'POST',
      body: { source: 'balance', amount: amountMinor, recipient: recipientCode, reference, reason, currency: 'GHS' }
    });
    return { providerRef: data.transfer_code, status: 'processing' };
  },

  createRecipient: ({ type = 'ghipss', name, accountNumber, bankCode }) =>
    call('/transferrecipient', {
      method: 'POST',
      body: { type, name, account_number: accountNumber, bank_code: bankCode, currency: 'GHS' }
    }),

  verifySignature(rawBody, signatureHeader) {
    if (!config.paystack.webhookSecret) return false;
    return safeEqual(sha256Hmac(config.paystack.webhookSecret, rawBody), signatureHeader || '');
  }
};
