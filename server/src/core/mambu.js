import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream } from '../lib/errors.js';
import { toMajor } from '../lib/money.js';

/**
 * Mambu API v2 client.
 * Auth: apikey header on an API-consumer key.
 * Versioning: every v2 request must carry an Accept header.
 */
const ACCEPT = 'application/vnd.mambu.v2+json';

function headers(extra = {}) {
  if (!isConfigured.mambu()) throw upstream('Mambu is not configured');
  return {
    apikey: config.mambu.apiKey,
    Accept: ACCEPT,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function call(path, { method = 'GET', body, idempotencyKey, label } = {}) {
  const res = await request(`${config.mambu.baseUrl}${path}`, {
    method,
    headers: headers(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    body,
    label: label || `mambu ${method} ${path}`,
    // POSTs that carry an Idempotency-Key are safe to retry; others are not
    retries: method === 'GET' || idempotencyKey ? 3 : 0
  });
  if (!res.ok) throw upstream(`Mambu ${method} ${path} failed (${res.status})`, res.body);
  return res.body;
}

export const mambu = {
  ping: () => call('/clients?limit=1', { label: 'mambu ping' }),

  // ----- clients -----
  createClient: ({ firstName, lastName, msisdn, email, birthDate, externalId }) =>
    call('/clients', {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        firstName, lastName, birthDate,
        preferredLanguage: 'ENGLISH',
        state: 'PENDING_APPROVAL',
        assignedBranchKey: config.mambu.branchId || undefined,
        addresses: [{ country: 'Ghana', city: 'Accra' }],
        emailAddress: email,
        mobilePhone: msisdn
      }
    }),
  getClient: (clientKey) => call(`/clients/${clientKey}`),
  patchClientState: (clientKey, state) =>
    call(`/clients/${clientKey}`, { method: 'PATCH', body: [{ op: 'REPLACE', path: '/state', value: state }] }),

  // ----- deposit accounts -----
  createDepositAccount: ({ clientKey, productTypeKey, name, currency = 'GHS', externalId }) =>
    call('/deposits', {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        accountHolderKey: clientKey,
        accountHolderType: 'CLIENT',
        productTypeKey: productTypeKey || config.mambu.depositProductId,
        name,
        currencyCode: currency,
        accountState: 'APPROVED'
      }
    }),
  getDepositAccount: (accountKey) => call(`/deposits/${accountKey}`),

  deposit: ({ accountKey, amountMinor, notes, externalId, channelKey }) =>
    call(`/deposits/${accountKey}/deposit-transactions`, {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        amount: toMajor(amountMinor),
        externalId,
        notes,
        transactionDetails: channelKey ? { transactionChannelId: channelKey } : undefined
      }
    }),

  withdraw: ({ accountKey, amountMinor, notes, externalId, channelKey }) =>
    call(`/deposits/${accountKey}/withdrawal-transactions`, {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        amount: toMajor(amountMinor),
        externalId,
        notes,
        transactionDetails: channelKey ? { transactionChannelId: channelKey } : undefined
      }
    }),

  transfer: ({ fromAccountKey, toAccountKey, amountMinor, notes, externalId }) =>
    call(`/deposits/${fromAccountKey}/transfer-transactions`, {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        amount: toMajor(amountMinor),
        externalId,
        notes,
        transferDetails: { linkedAccountKey: toAccountKey, linkedAccountType: 'DEPOSIT' }
      }
    }),

  searchDepositTransactions: ({ accountKey, limit = 50, offset = 0 }) =>
    call(`/deposits/transactions:search?limit=${limit}&offset=${offset}&detailsLevel=FULL`, {
      method: 'POST',
      body: {
        filterCriteria: [{ field: 'parentAccountKey', operator: 'EQUALS', value: accountKey }],
        sortingCriteria: { field: 'creationDate', order: 'DESC' }
      }
    }),

  // ----- loans -----
  createLoanAccount: ({ clientKey, amountMinor, productTypeKey, externalId }) =>
    call('/loans', {
      method: 'POST',
      idempotencyKey: externalId,
      body: {
        accountHolderKey: clientKey,
        accountHolderType: 'CLIENT',
        productTypeKey: productTypeKey || config.mambu.loanProductId,
        loanAmount: toMajor(amountMinor),
        currencyCode: 'GHS'
      }
    }),
  disburseLoan: ({ loanKey, amountMinor, externalId }) =>
    call(`/loans/${loanKey}/disbursement-transactions`, {
      method: 'POST',
      idempotencyKey: externalId,
      body: { amount: toMajor(amountMinor), externalId }
    }),
  repayLoan: ({ loanKey, amountMinor, externalId }) =>
    call(`/loans/${loanKey}/repayment-transactions`, {
      method: 'POST',
      idempotencyKey: externalId,
      body: { amount: toMajor(amountMinor), externalId }
    }),

  // ----- general ledger -----
  searchJournalEntries: (body) =>
    call('/gljournalentries:search?detailsLevel=FULL', { method: 'POST', body })
};
