import { randomBytes, scryptSync, timingSafeEqual, createHmac, randomUUID } from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashSecret(plain) {
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifySecret(plain, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, rr, pp, salt, key] = stored.split('$');
  const derived = scryptSync(plain, Buffer.from(salt, 'base64'), KEYLEN, {
    N: Number(n), r: Number(rr), p: Number(pp)
  });
  const expected = Buffer.from(key, 'base64');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export const sha256Hmac = (secret, payload) =>
  createHmac('sha256', secret).update(payload).digest('hex');

export function safeEqual(a = '', b = '') {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const uuid = () => randomUUID();

// ADB + yyMMdd + 10 random base32 chars
export function newReference(prefix = 'ADB') {
  const d = new Date();
  const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = randomBytes(7).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
  return `${prefix}${stamp}${rand}`;
}
