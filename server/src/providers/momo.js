import { randomUUID } from 'node:crypto';
import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream } from '../lib/errors.js';
import { toMajor } from '../lib/money.js';

// MTN MoMo Open API: Collections (pull from customer) + Disbursements (push to customer).
// Access tokens are short-lived, so cache per product.
const tokens = { collection: null, disbursement: null };

async function accessToken(product) {
  const cached = tokens[product];
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;

  const creds = config.momo[product];
  const basic = Buffer.from(`${creds.userId}:${creds.apiKey}`).toString('base64');
  const segment = product === 'collection' ? 'collection' : 'disbursement';
  const res = await request(`${config.momo.baseUrl}/${segment}/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Ocp-Apim-Subscription-Key': creds.key
    },
    label: `momo ${product} token`
  });
  if (!res.ok) throw upstream('MoMo token request failed', res.body);
  tokens[product] = {
    value: res.body.access_token,
    expiresAt: Date.now() + (Number(res.body.expires_in || 3600) * 1000)
  };
  return tokens[product].value;
}

function authHeaders(product, token, referenceId) {
  return {
    Authorization: `Bearer ${token}`,
    'X-Reference-Id': referenceId,
    'X-Target-Environment': config.momo.targetEnv,
    'Ocp-Apim-Subscription-Key': config.momo[product].key,
    'Content-Type': 'application/json',
    ...(config.momo.callbackUrl ? { 'X-Callback-Url': config.momo.callbackUrl } : {})
  };
}

export const momo = {
  name: 'mtn_momo',
  configured: () => isConfigured.momo(),

  async ping() {
    await accessToken('collection');
    return { status: 'up' };
  },

  /** Pull funds from a customer wallet into the bank. Async: poll or await webhook. */
  async requestToPay({ amountMinor, msisdn, reference, payerMessage, payeeNote }) {
    const token = await accessToken('collection');
    const referenceId = randomUUID();
    const res = await request(`${config.momo.baseUrl}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: authHeaders('collection', token, referenceId),
      body: {
        amount: String(toMajor(amountMinor)),
        currency: config.momo.targetEnv === 'sandbox' ? 'EUR' : 'GHS',
        externalId: reference,
        payer: { partyIdType: 'MSISDN', partyId: msisdn.replace(/^\+/, '') },
        payerMessage: payerMessage || 'Digital Bank deposit',
        payeeNote: payeeNote || reference
      },
      label: 'momo requesttopay',
      retries: 0
    });
    if (res.status !== 202) throw upstream('MoMo collection request rejected', res.body);
    return { providerRef: referenceId, status: 'processing' };
  },

  async requestToPayStatus(referenceId) {
    const token = await accessToken('collection');
    const res = await request(`${config.momo.baseUrl}/collection/v1_0/requesttopay/${referenceId}`, {
      headers: authHeaders('collection', token, referenceId),
      label: 'momo requesttopay status'
    });
    if (!res.ok) throw upstream('MoMo status lookup failed', res.body);
    return normaliseStatus(res.body);
  },

  /** Push funds from the bank out to a customer wallet. */
  async transfer({ amountMinor, msisdn, reference, note }) {
    const token = await accessToken('disbursement');
    const referenceId = randomUUID();
    const res = await request(`${config.momo.baseUrl}/disbursement/v1_0/transfer`, {
      method: 'POST',
      headers: authHeaders('disbursement', token, referenceId),
      body: {
        amount: String(toMajor(amountMinor)),
        currency: config.momo.targetEnv === 'sandbox' ? 'EUR' : 'GHS',
        externalId: reference,
        payee: { partyIdType: 'MSISDN', partyId: msisdn.replace(/^\+/, '') },
        payerMessage: note || 'Digital Bank payout',
        payeeNote: reference
      },
      label: 'momo transfer',
      retries: 0
    });
    if (res.status !== 202) throw upstream('MoMo disbursement rejected', res.body);
    return { providerRef: referenceId, status: 'processing' };
  },

  async accountHolderName(msisdn) {
    const token = await accessToken('collection');
    const referenceId = randomUUID();
    const res = await request(
      `${config.momo.baseUrl}/collection/v1_0/accountholder/msisdn/${msisdn.replace(/^\+/, '')}/basicuserinfo`,
      { headers: authHeaders('collection', token, referenceId), label: 'momo name enquiry' }
    );
    if (!res.ok) return null;
    return res.body?.name || [res.body?.given_name, res.body?.family_name].filter(Boolean).join(' ');
  }
};

function normaliseStatus(body) {
  const map = { SUCCESSFUL: 'posted', FAILED: 'failed', PENDING: 'processing' };
  return {
    status: map[body?.status] || 'processing',
    providerRef: body?.financialTransactionId || null,
    reason: body?.reason?.code || body?.reason || null,
    raw: body
  };
}
