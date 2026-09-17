import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream } from '../lib/errors.js';

// Identity provider for Ghana Card lookup, phone-to-name match and liveness/selfie match.
function headers() {
  return {
    AppId: config.kyc.appId,
    Authorization: config.kyc.secretKey,
    'Content-Type': 'application/json'
  };
}

async function call(path, { method = 'GET', body, label } = {}) {
  const res = await request(`${config.kyc.baseUrl}${path}`, {
    method, headers: headers(), body, label: label || `kyc ${path}`, retries: method === 'GET' ? 2 : 0
  });
  if (!res.ok) throw upstream('Identity check failed', res.body);
  return res.body?.entity ?? res.body;
}

export const kyc = {
  name: 'identity',
  configured: () => isConfigured.kyc(),

  ping: () => Promise.resolve({ status: isConfigured.kyc() ? 'up' : 'down' }),

  /** Ghana Card (PIN format GHA-XXXXXXXXX-X). */
  ghanaCard: ({ idNumber }) =>
    call(`/api/v1/kyc/ghana/id?id=${encodeURIComponent(idNumber)}`, { label: 'kyc ghana card' }),

  phoneLookup: ({ msisdn }) =>
    call(`/api/v1/kyc/phone_number?phone_number=${encodeURIComponent(msisdn)}`, { label: 'kyc phone' }),

  /** Selfie against the ID photo; returns a confidence score. */
  selfieMatch: ({ selfieBase64, idBase64 }) =>
    call('/api/v1/kyc/photoid/verify', {
      method: 'POST',
      body: { selfie_image: selfieBase64, photoid_image: idBase64 },
      label: 'kyc selfie match'
    }),

  amlScreen: ({ fullName, dateOfBirth }) =>
    call('/api/v1/aml/screening', {
      method: 'POST',
      body: { full_name: fullName, date_of_birth: dateOfBirth },
      label: 'aml screening'
    })
};
