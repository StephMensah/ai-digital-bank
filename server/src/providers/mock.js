import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { badRequest, upstream } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Sandbox rail.
 *
 * Stands in for Hubtel, GhIPSS, MTN MoMo, Paystack and the identity provider
 * while the real contracts are still being signed, so the whole platform can be
 * demonstrated end to end without moving a pesewa.
 *
 * It is deliberately not a stub that always says yes. Real rails are slow,
 * occasionally reject, and settle out of band, and a demo that hides all three
 * teaches everyone the wrong thing about the system. So this one:
 *
 *  - answers a payout as `processing`, then settles a second or two later
 *    through the same settlement path a provider webhook would use
 *  - fails deterministically on chosen amounts, so a decline can be shown
 *    on demand rather than waited for
 *  - takes a realistic moment to answer, so spinners and held states are
 *    visible rather than theoretical
 *
 * Every response carries mock: true, and the control tower labels these rails
 * as mock rather than up, so nobody mistakes a sandbox run for a live one.
 */

const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 400);
const SETTLE_MS = Number(process.env.MOCK_SETTLE_MS || 2000);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Demo controls, by the pesewa part of the amount:
 *   .13 → the rail declines
 *   .77 → the rail accepts, then settlement fails (the awkward one)
 *   .99 → the rail times out
 * Everything else succeeds.
 */
function scripted(amountMinor) {
  const pesewas = Math.abs(Number(amountMinor)) % 100;
  if (pesewas === 13) return 'decline';
  if (pesewas === 77) return 'settle_fail';
  if (pesewas === 99) return 'timeout';
  return 'ok';
}

const HOLDERS = [
  'Ama Boateng', 'Kwame Mensah', 'Efua Danso', 'Yaw Owusu', 'Akosua Frimpong',
  'Kofi Asare', 'Adjoa Nyarko', 'Kojo Antwi', 'Abena Osei', 'Kwesi Appiah'
];

/** Same number always resolves to the same name, so demos stay coherent. */
function holderFor(identifier) {
  const digits = String(identifier).replace(/\D/g, '');
  const sum = [...digits].reduce((a, d) => a + Number(d), 0);
  return HOLDERS[sum % HOLDERS.length];
}

// GIP member institutions, so the bank picker looks like the real thing.
const BANKS = [
  { code: '300302', name: 'Absa Bank Ghana' },
  { code: '300303', name: 'GCB Bank' },
  { code: '300304', name: 'Standard Chartered Bank Ghana' },
  { code: '300305', name: 'Ecobank Ghana' },
  { code: '300307', name: 'Fidelity Bank Ghana' },
  { code: '300309', name: 'Stanbic Bank Ghana' },
  { code: '300310', name: 'Absa Bank' },
  { code: '300312', name: 'CalBank' },
  { code: '300317', name: 'Zenith Bank Ghana' },
  { code: '300323', name: 'Access Bank Ghana' },
  { code: '300329', name: 'Consolidated Bank Ghana' },
  { code: 'MTN', name: 'MTN Mobile Money' },
  { code: 'VODAFONE', name: 'Telecel Cash' },
  { code: 'AIRTELTIGO', name: 'AirtelTigo Money' }
];

const ref = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/**
 * Settle later, through the same code the webhook handlers call. Imported
 * lazily because the ledger imports the provider registry, and a static import
 * here would close that loop.
 */
function settleLater(reference, outcome) {
  setTimeout(async () => {
    try {
      const [{ query }, ledger] = await Promise.all([
        import('../db/pool.js'),
        import('../core/ledger.js')
      ]);
      const { rows } = await query('SELECT id FROM transactions WHERE reference=$1', [reference]);
      if (!rows[0]) return;

      if (outcome === 'settle_fail') {
        await ledger.failTransaction({
          transactionId: rows[0].id,
          reason: 'Mock rail: the counterparty rejected the credit after accepting it'
        });
      } else {
        await ledger.settleTransaction({
          transactionId: rows[0].id,
          providerRef: ref('MOCKSETTLE'),
          glCounterparty: ledger.GL.MOMO_SETTLEMENT
        });
      }
      logger.info({ reference, outcome }, 'mock rail settled');
    } catch (err) {
      logger.error({ err: err.message, reference }, 'mock settlement failed');
    }
  }, SETTLE_MS).unref?.();
}

async function act(amountMinor, reference, { settles = true } = {}) {
  await pause(LATENCY_MS);
  const outcome = scripted(amountMinor);

  if (outcome === 'timeout') {
    await pause(1500);
    throw upstream('Mock rail: no response from the provider');
  }
  if (outcome === 'decline') {
    throw upstream('Mock rail: declined by the provider (insufficient funds at counterparty)');
  }
  if (settles) settleLater(reference, outcome);

  return { providerRef: ref('MOCK'), status: 'processing', mock: true };
}

export const mock = {
  name: 'mock',
  configured: () => config.mockProviders,
  isMock: true,

  ping: async () => {
    await pause(40);
    return { status: 'up', mock: true };
  },

  // ----- money in -----
  async chargeWallet({ amountMinor, msisdn, reference }) {
    if (!msisdn) throw badRequest('A wallet number is required');
    return act(amountMinor, reference);
  },

  async requestToPay({ amountMinor, msisdn, reference }) {
    return this.chargeWallet({ amountMinor, msisdn, reference });
  },

  async initializeCharge({ amountMinor, reference }) {
    await pause(LATENCY_MS);
    if (scripted(amountMinor) === 'decline') throw upstream('Mock rail: the card was declined');
    settleLater(reference, 'ok');
    // A hosted checkout would send the customer away and bring them back; the
    // mock returns them straight to the app with the reference intact.
    return {
      providerRef: ref('MOCKCO'),
      authorizationUrl: `${config.webOrigin[0]}/app.html?deposit=${encodeURIComponent(reference)}&mock=1`,
      mock: true
    };
  },

  // ----- money out -----
  payout: ({ amountMinor, reference }) => act(amountMinor, reference),
  transfer: ({ amountMinor, reference }) => act(amountMinor, reference),

  // ----- lookups -----
  async accountHolderName(msisdn) {
    await pause(LATENCY_MS);
    if (!/^(\+233|0)\d{9}$/.test(String(msisdn))) throw badRequest('That is not a Ghanaian mobile number');
    return holderFor(msisdn);
  },

  async banks() {
    await pause(120);
    return BANKS.map((b) => ({ ...b, rail: 'mock' }));
  },

  async listBanks() {
    return this.banks();
  },

  async nameEnquiry({ accountNumber, bankCode }) {
    await pause(LATENCY_MS);
    if (!accountNumber || !bankCode) throw badRequest('Account number and bank are both required');
    if (String(accountNumber).endsWith('0000')) throw upstream('Mock rail: account not found at that bank');
    return {
      accountName: holderFor(accountNumber),
      accountNumber,
      bankCode,
      sessionId: ref('MOCKSESS'),
      mock: true
    };
  },

  async status(providerRef) {
    await pause(120);
    return { status: 'posted', providerRef, mock: true };
  },

  async verify(reference) {
    await pause(120);
    return { status: 'posted', reference, currency: 'GHS', mock: true };
  },

  // ----- identity -----
  async verifyIdentity({ idNumber, fullName }) {
    await pause(LATENCY_MS * 2);
    // Ghana Card numbers ending 0 fail, so a rejected KYC case can be demoed.
    const ok = /^GHA-\d{9}-\d$/.test(String(idNumber || '')) && !String(idNumber).endsWith('-0');
    return {
      verified: ok,
      score: ok ? 0.94 : 0.21,
      matchedName: ok ? fullName || holderFor(idNumber) : null,
      reason: ok ? null : 'Mock identity check: the card number did not match NIA records',
      mock: true
    };
  },

  async ghanaCard({ idNumber, fullName }) {
    return this.verifyIdentity({ idNumber, fullName });
  },

  async selfieMatch() {
    await pause(LATENCY_MS * 2);
    return { match: true, score: 0.91, mock: true };
  },

  // Callbacks are generated internally, so there is nothing to verify.
  verifySignature: () => true
};
