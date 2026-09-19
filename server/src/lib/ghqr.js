/**
 * GhQR — Ghana's universal QR, which is EMVCo merchant-presented QR underneath.
 *
 * The payload is tag-length-value: two digits of tag, two digits of length,
 * then that many characters. Templates nest the same structure inside a value,
 * which is why parsing is recursive rather than a flat scan.
 *
 * Two details decide whether a real terminal accepts what we produce:
 *
 *  - The CRC is CRC-16/CCITT-FALSE (polynomial 0x1021, seed 0xFFFF) taken over
 *    the whole payload *including* the trailing "6304" tag and length, but not
 *    the four checksum characters themselves. Getting the range wrong is the
 *    usual reason a hand-built QR scans as garbage.
 *  - Currency is ISO 4217 numeric — 936 for the cedi, not "GHS" — and country
 *    is alpha-2. A terminal that reads "GHS" in tag 53 rejects the code.
 *
 * Tag 01 says whether the code is static (11) or dynamic (12). A static code
 * is a sticker on a counter with no amount, so the customer types one; a
 * dynamic code is generated per sale and carries the amount, which the
 * customer must not be able to edit.
 */

const CURRENCY_NUMERIC = { GHS: '936', USD: '840', EUR: '978', GBP: '826' };
const NUMERIC_CURRENCY = Object.fromEntries(Object.entries(CURRENCY_NUMERIC).map(([k, v]) => [v, k]));

export function crc16ccitt(input) {
  /* Over UTF-8 bytes, not JavaScript's UTF-16 code units. With an ASCII
     merchant name the two agree, so the bug hides until the first name with an
     accent in it — and then every code that merchant prints fails to scan. */
  const bytes = new TextEncoder().encode(input);
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Flat TLV read. Returns a map of tag to raw value, in order. */
export function readTlv(payload) {
  const out = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isInteger(len) || i + 4 + len > payload.length) break;
    out[tag] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

const tlv = (tag, value) => `${tag}${String(value).length.toString().padStart(2, '0')}${value}`;

/**
 * Parse a scanned GhQR. Throws nothing — returns {ok, reason} so the caller can
 * tell a customer what is wrong with the sticker rather than a stack trace.
 */
export function parseGhQr(raw) {
  const payload = String(raw || '').trim();
  if (payload.length < 20) return { ok: false, reason: 'That does not look like a payment code' };

  const crcAt = payload.lastIndexOf('6304');
  if (crcAt < 0 || crcAt !== payload.length - 8) {
    return { ok: false, reason: 'That code is incomplete — ask the merchant to show it again' };
  }
  const expected = crc16ccitt(payload.slice(0, crcAt + 4));
  const found = payload.slice(crcAt + 4).toUpperCase();
  if (expected !== found) {
    // A wrong checksum means a misread or a tampered sticker. Either way the
    // money should not move on it.
    return { ok: false, reason: 'That code did not scan cleanly. Try again, or check the sticker.' };
  }

  const root = readTlv(payload.slice(0, crcAt));
  if (root['00'] !== '01') return { ok: false, reason: 'Unsupported QR version' };

  const dynamic = root['01'] === '12';
  const currency = NUMERIC_CURRENCY[root['53']] || 'GHS';
  const extra = readTlv(root['62'] || '');

  /* Merchant account templates live anywhere in 26–51. GhIPSS assigns the
     scheme its own template; we read whichever is present rather than assuming
     a slot, because acquirers do not all use the same one. */
  let acquirer = null;
  let merchantId = null;
  for (let t = 26; t <= 51; t += 1) {
    const tag = String(t).padStart(2, '0');
    if (!root[tag]) continue;
    const inner = readTlv(root[tag]);
    acquirer = inner['00'] || acquirer;
    merchantId = inner['01'] || inner['02'] || merchantId;
    if (merchantId) break;
  }

  return {
    ok: true,
    dynamic,
    merchantName: root['59'] || 'Merchant',
    merchantCity: root['60'] || '',
    merchantCategory: root['52'] || null,
    countryCode: root['58'] || 'GH',
    currency,
    // Amount is major units in the payload; we work in pesewas everywhere else.
    amountMinor: root['54'] ? Math.round(Number(root['54']) * 100) : null,
    terminalId: extra['07'] || null,
    billNumber: extra['01'] || null,
    reference: extra['05'] || null,
    acquirer,
    merchantId,
    raw: payload
  };
}

/** Build a code — used to generate test merchants and for our own acquiring. */
export function buildGhQr({
  merchantId, merchantName, merchantCity = 'Accra', amountMinor = null,
  terminalId = null, reference = null, currency = 'GHS', acquirer = 'GH.GHIPSS.QR',
  merchantCategory = '5999'
}) {
  let payload = tlv('00', '01') + tlv('01', amountMinor ? '12' : '11');
  payload += tlv('26', tlv('00', acquirer) + tlv('01', merchantId));
  payload += tlv('52', merchantCategory);
  payload += tlv('53', CURRENCY_NUMERIC[currency] || '936');
  if (amountMinor) payload += tlv('54', (amountMinor / 100).toFixed(2));
  payload += tlv('58', 'GH');
  payload += tlv('59', String(merchantName).slice(0, 25));
  payload += tlv('60', String(merchantCity).slice(0, 15));

  const extra = (reference ? tlv('05', reference) : '') + (terminalId ? tlv('07', terminalId) : '');
  if (extra) payload += tlv('62', extra);

  payload += '6304';
  return payload + crc16ccitt(payload);
}
