/**
 * Remittance corridors — outbound from Ghana.
 *
 * This is a mock partner, in the same shape the real one will take: a list of
 * corridors, a priced quote, and a payout that either accepts or rejects. When
 * a licensed partner is connected (Onafriq, Thunes, a correspondent bank), only
 * the three functions at the bottom change; nothing that calls them does.
 *
 * Rates here are indicative and deterministic so tests and demos repeat. They
 * are NOT market rates and must never be shown to a customer on a live rail.
 */

import { randomUUID } from 'node:crypto';

/* Sell rates: how many GHS one unit of the destination currency costs us to
   buy, before the spread below. Replace wholesale with the partner's feed. */
const CORRIDORS = [
  { code: 'NG', country: 'Nigeria',        currency: 'NGN', rate: 0.0893, methods: ['bank', 'mobile_money'], minutes: 10 },
  { code: 'KE', country: 'Kenya',          currency: 'KES', rate: 0.0932, methods: ['mobile_money'],         minutes: 10 },
  { code: 'CI', country: "Côte d'Ivoire",  currency: 'XOF', rate: 0.0213, methods: ['mobile_money'],         minutes: 15 },
  { code: 'GB', country: 'United Kingdom', currency: 'GBP', rate: 16.42,  methods: ['bank'],                 minutes: 1440 },
  { code: 'US', country: 'United States',  currency: 'USD', rate: 12.85,  methods: ['bank'],                 minutes: 1440 }
];

/* Our margin on the wholesale rate, plus a flat handling fee in pesewas.
   Both belong in a pricing table per partner and per corridor before launch. */
const SPREAD = 0.025;
const FEE_MINOR = 1500; // GHS 15.00

export const corridors = () =>
  CORRIDORS.map(({ code, country, currency, methods, minutes }) =>
    ({ code, country, currency, methods, deliveryMinutes: minutes }));

export const findCorridor = (code) =>
  CORRIDORS.find((c) => c.code === String(code || '').toUpperCase()) || null;

/**
 * Price a send. amountMinor is what leaves the customer's account in pesewas,
 * inclusive of the fee, so the debit and the quote can never disagree.
 */
export function quote({ corridor, amountMinor }) {
  const sendMinor = amountMinor - FEE_MINOR;
  if (sendMinor <= 0) return null;
  const customerRate = corridor.rate * (1 + SPREAD);
  const receives = sendMinor / 100 / customerRate;
  return {
    id: randomUUID(),
    corridor: corridor.code,
    country: corridor.country,
    currency: corridor.currency,
    debitMinor: amountMinor,
    feeMinor: FEE_MINOR,
    sendMinor,
    rate: Number(customerRate.toFixed(6)),
    receives: Number(receives.toFixed(2)),
    /* the corridor record calls this `minutes`; only the wire format renames it */
    deliveryMinutes: corridor.minutes,
    /* A quote is a price held for a period, not forever. The send re-reads it
       and refuses once it has passed. */
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
  };
}

/**
 * Hand the payout to the partner. The mock accepts everything except an
 * obviously bad destination, which is how the real one behaves too.
 */
export async function payout({ reference, quote: q, recipient }) {
  if (!recipient || !recipient.name) {
    return { accepted: false, reason: 'recipient_incomplete' };
  }
  return {
    accepted: true,
    providerRef: `RMT-${reference}`,
    expectedBy: new Date(Date.now() + q.deliveryMinutes * 60_000).toISOString()
  };
}
