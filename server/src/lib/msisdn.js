/**
 * Ghana mobile numbers.
 *
 * People type the number the way they say it: 024 123 4567. Nobody dictates a
 * phone number as +233 24 123 4567, and asking them to is a needless way to
 * lose a signup. So every entry point accepts the local form, the international
 * form, spaces, dashes and brackets, and stores one canonical shape.
 *
 * Canonical storage stays +233XXXXXXXXX: the rails want E.164, the number has
 * to match across MoMo, Hubtel and GIP, and one stored shape means a customer
 * who signs up as 0241234567 can log in as +233241234567 and vice versa.
 */

/* Allocated mobile prefixes, without the trunk zero.
   MTN 24 54 55 59 25 53 · Telecel 20 50 · AirtelTigo 27 57 26 56 · Glo 23 */
export const MOBILE_PREFIXES = ['20', '23', '24', '25', '26', '27', '28', '50', '53', '54', '55', '56', '57', '59'];

export const NETWORKS = {
  mtn: ['24', '54', '55', '59', '25', '53'],
  telecel: ['20', '50'],
  airteltigo: ['27', '57', '26', '56'],
  glo: ['23']
};

/**
 * Returns +233XXXXXXXXX, or null if it is not a Ghanaian mobile number.
 * Accepts 0241234567, 241234567, 233241234567, +233 24 123 4567, (024) 123-4567.
 */
export function normaliseMsisdn(input) {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, '');

  let local;
  if (digits.length === 10 && digits.startsWith('0')) local = digits.slice(1);       // 0241234567
  else if (digits.length === 9) local = digits;                                      // 241234567
  else if (digits.length === 12 && digits.startsWith('233')) local = digits.slice(3); // 233241234567
  else if (digits.length === 13 && digits.startsWith('2330')) local = digits.slice(4); // 2330241234567, a common slip
  else return null;

  if (!MOBILE_PREFIXES.includes(local.slice(0, 2))) return null;
  return `+233${local}`;
}

/** 0241234567 — how a Ghanaian reads their own number back. */
export function localMsisdn(msisdn) {
  const norm = normaliseMsisdn(msisdn);
  return norm ? `0${norm.slice(4)}` : String(msisdn || '');
}

export function networkOf(msisdn) {
  const norm = normaliseMsisdn(msisdn);
  if (!norm) return null;
  const prefix = norm.slice(4, 6);
  return Object.keys(NETWORKS).find((n) => NETWORKS[n].includes(prefix)) || null;
}

export const NETWORK_NAMES = {
  mtn: 'MTN MoMo', telecel: 'Telecel Cash', airteltigo: 'AirtelTigo Money', glo: 'Glo Mobile Money'
};
