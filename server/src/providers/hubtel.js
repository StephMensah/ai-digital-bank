import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream, badRequest } from '../lib/errors.js';
import { sha256Hmac, safeEqual } from '../lib/crypto.js';

/**
 * Hubtel — Ghanaian payment rails.
 *
 * Three surfaces, three hosts, one credential pair:
 *   payproxy  — hosted checkout (card, wallet, bank) for top-ups
 *   rmp       — direct mobile-money debit and send-money payouts
 *   txnstatus — status enquiry, used by the outbox and the control tower
 *
 * Hubtel authenticates with Basic auth over the client id and secret, and it
 * keys everything off our own clientReference, so our transaction reference is
 * the join key end to end. Amounts go over the wire in cedis, not pesewas.
 */

function basic() {
  return 'Basic ' + Buffer.from(`${config.hubtel.clientId}:${config.hubtel.clientSecret}`).toString('base64');
}

async function call(url, { method = 'POST', body, label } = {}) {
  const res = await request(url, {
    method,
    headers: { Authorization: basic(), 'Content-Type': 'application/json' },
    body,
    label: label || `hubtel ${url}`,
    retries: method === 'GET' ? 3 : 0
  });

  // Hubtel answers 2xx with a ResponseCode that carries the real outcome.
  const code = res.body?.ResponseCode ?? res.body?.responseCode;
  const ok = res.ok && (code === undefined || ['0000', '0001'].includes(String(code)));
  if (!ok) {
    throw upstream(res.body?.Message || res.body?.message || 'Hubtel request failed', res.body);
  }
  return res.body?.Data ?? res.body?.data ?? res.body;
}

const toMajor = (minor) => Number((Number(minor) / 100).toFixed(2));

// 0000 succeeded, 0001 is still in flight, everything else is terminal.
const STATUS = { '0000': 'posted', '0001': 'processing', '0005': 'failed', '2001': 'failed', '2000': 'failed' };
const readStatus = (code) => STATUS[String(code)] || 'failed';

// Hubtel names the network on direct debits; derive it from the prefix so the
// customer never has to pick their own network from a dropdown.
const NETWORKS = {
  mtn: ['24', '54', '55', '59', '25', '53'],
  vodafone: ['20', '50'],       // Telecel Ghana, still 'vodafone' on the API
  airteltigo: ['27', '57', '26', '56']
};
export function networkFor(msisdn) {
  const local = String(msisdn).replace(/^\+233/, '').replace(/^0/, '').slice(0, 2);
  for (const [network, prefixes] of Object.entries(NETWORKS)) {
    if (prefixes.includes(local)) return network;
  }
  return null;
}

export const hubtel = {
  name: 'hubtel',
  configured: () => isConfigured.hubtel(),

  ping: () =>
    call(`${config.hubtel.statusUrl}/transactions/${config.hubtel.merchantId}/status?clientReference=ping`, {
      method: 'GET', label: 'hubtel ping'
    }).then(() => ({ status: 'up' })).catch((err) => {
      // An unknown reference still proves the credentials and the host are good.
      if (/not found|no transaction/i.test(err.message)) return { status: 'up' };
      throw err;
    }),

  /** Hosted checkout — card, wallet or bank, whichever the customer picks. */
  async initializeCharge({ amountMinor, reference, description, callbackUrl, returnUrl, msisdn }) {
    const data = await call(`${config.hubtel.checkoutUrl}/items/initiate`, {
      body: {
        totalAmount: toMajor(amountMinor),
        description: (description || 'Account top up').slice(0, 100),
        callbackUrl: callbackUrl || config.hubtel.callbackUrl,
        returnUrl: returnUrl || config.hubtel.returnUrl,
        cancellationUrl: returnUrl || config.hubtel.returnUrl,
        merchantAccountNumber: config.hubtel.merchantId,
        clientReference: reference,
        payeeMobileNumber: msisdn || undefined
      },
      label: 'hubtel checkout'
    });
    return {
      providerRef: data.checkoutId || reference,
      authorizationUrl: data.checkoutDirectUrl || data.checkoutUrl,
      accessCode: data.checkoutId
    };
  },

  /**
   * Direct mobile-money debit. The customer approves a prompt on their handset,
   * so this returns processing and settles on the callback.
   */
  async chargeWallet({ amountMinor, msisdn, reference, description }) {
    const channel = networkFor(msisdn);
    if (!channel) throw badRequest('That number is not on MTN, Telecel or AirtelTigo.');

    const data = await call(
      `${config.hubtel.rmpUrl}/merchantaccount/merchants/${config.hubtel.merchantId}/receive/mobilemoney`,
      {
        body: {
          CustomerName: description || 'Customer',
          CustomerMsisdn: String(msisdn).replace(/^\+233/, '0'),
          CustomerEmail: config.hubtel.merchantEmail || undefined,
          Channel: channel,
          Amount: toMajor(amountMinor),
          PrimaryCallbackUrl: config.hubtel.callbackUrl,
          Description: (description || 'Top up').slice(0, 100),
          ClientReference: reference
        },
        label: 'hubtel receive momo'
      }
    );
    return { providerRef: data.TransactionId || data.transactionId, status: 'processing', channel };
  },

  /** Send money out to a wallet. */
  async payout({ amountMinor, msisdn, reference, narration, recipientName }) {
    const channel = networkFor(msisdn);
    if (!channel) throw badRequest('That number is not on MTN, Telecel or AirtelTigo.');

    const data = await call(
      `${config.hubtel.rmpUrl}/merchantaccount/merchants/${config.hubtel.merchantId}/send/mobilemoney`,
      {
        body: {
          RecipientName: recipientName || 'Beneficiary',
          RecipientMsisdn: String(msisdn).replace(/^\+233/, '0'),
          Channel: channel,
          Amount: toMajor(amountMinor),
          PrimaryCallbackUrl: config.hubtel.callbackUrl,
          Description: (narration || 'Transfer').slice(0, 100),
          ClientReference: reference
        },
        label: 'hubtel send momo'
      }
    );
    return { providerRef: data.TransactionId || data.transactionId, status: 'processing', channel };
  },

  /** Who owns this wallet — shown to the customer before they send. */
  async accountHolderName(msisdn) {
    const channel = networkFor(msisdn);
    if (!channel) throw badRequest('That number is not on MTN, Telecel or AirtelTigo.');
    const data = await call(
      `${config.hubtel.rmpUrl}/merchantaccount/merchants/${config.hubtel.merchantId}/name-enquiry`,
      { body: { Msisdn: String(msisdn).replace(/^\+233/, '0'), Channel: channel }, label: 'hubtel name enquiry' }
    );
    return data.Name || data.name || data.AccountName;
  },

  /** Status enquiry by our own reference. */
  async verify(reference) {
    const data = await call(
      `${config.hubtel.statusUrl}/transactions/${config.hubtel.merchantId}/status?clientReference=${encodeURIComponent(reference)}`,
      { method: 'GET', label: 'hubtel status' }
    );
    const row = Array.isArray(data) ? data[0] : data;
    return {
      status: readStatus(row?.TransactionStatus === 'Paid' ? '0000' : row?.ResponseCode ?? '0001'),
      amountMinor: row?.Amount ? Math.round(Number(row.Amount) * 100) : null,
      currency: 'GHS',
      channel: row?.PaymentMethod || row?.Channel,
      providerRef: row?.TransactionId,
      raw: row
    };
  },

  /** Read a callback body into the shape the webhook handler settles on. */
  readCallback(body) {
    const data = body?.Data || body?.data || body || {};
    const code = body?.ResponseCode ?? data.ResponseCode ?? data.Status;
    return {
      reference: data.ClientReference || data.clientReference,
      providerRef: data.TransactionId || data.transactionId,
      status: data.Status === 'Success' || data.TransactionStatus === 'Paid' ? 'posted' : readStatus(code),
      amountMinor: data.Amount ? Math.round(Number(data.Amount) * 100) : null,
      reason: data.Description || body?.Message
    };
  },

  verifySignature(rawBody, signatureHeader) {
    // Hubtel signs callbacks only when a secret is set on the merchant account.
    if (!config.hubtel.webhookSecret) return true;
    return safeEqual(sha256Hmac(config.hubtel.webhookSecret, rawBody), signatureHeader || '');
  }
};
