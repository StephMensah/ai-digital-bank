// All money is stored and moved as integer minor units (pesewas for GHS).
export const toMinor = (major) => Math.round(Number(major) * 100);
export const toMajor = (minor) => Number(minor) / 100;
export const formatGHS = (minor) =>
  new Intl.NumberFormat('en-GH', { style: 'currency', currency: 'GHS' }).format(toMajor(minor));

export function assertPositiveMinor(minor, field = 'amount') {
  if (!Number.isInteger(minor) || minor <= 0) {
    const e = new Error(`${field} must be a positive whole number of minor units`);
    e.status = 400; e.code = 'bad_request';
    throw e;
  }
}
