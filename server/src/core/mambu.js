import { randomUUID } from 'node:crypto';
import { config, isConfigured } from '../config.js';
import { request } from '../lib/http.js';
import { upstream, badRequest, notFound, conflict } from '../lib/errors.js';
import { mambuMock } from './mambu-mock.js';

/**
 * Mambu API v2.
 *
 * Written against the published OpenAPI specs rather than from memory. Three
 * things the spec is explicit about, and all three matter:
 *
 *  - Responses are negotiated with `Accept: application/vnd.mambu.v2+json`.
 *    Ask for plain JSON and you get v1 semantics by accident.
 *  - POSTs carry an `Idempotency-Key` that must be a UUID, and a repeat of an
 *    in-flight request answers 102, not 2xx. Treating 102 as success books the
 *    same payment twice.
 *  - Errors are {errors:[{errorCode, errorReason, errorSource}]} where
 *    errorReason is a machine-readable enum. We branch on the enum, never on
 *    the message, which is free to change.
 *
 * With no credentials configured, every call is served by the in-memory mock,
 * which speaks the same shapes — so the core is exercised before a sandbox
 * exists rather than skipped.
 */

/* Mambu's reasons mapped onto ours. Unmapped stays a 502: an error we have not
   thought about is not one to translate confidently. */
const REASONS = {
  INSUFFICIENT_BALANCE: () => badRequest('There is not enough in the account for that'),
  BALANCE_BELOW_ZERO: () => badRequest('That would take the account below zero'),
  INVALID_DEPOSIT_AMOUNT: () => badRequest('That amount is not valid'),
  INVALID_AMOUNT: () => badRequest('That amount is not valid'),
  OBJECT_NOT_FOUND: () => notFound('Not found in the core'),
  INVALID_DEPOSIT_ACCOUNT_ID: () => notFound('No such account in the core'),
  INVALID_CLIENT_ID: () => notFound('No such client in the core'),
  INVALID_DEPOSIT_ACCOUNT_STATE: () => badRequest('The account is not in a state that allows this'),
  INVALID_CLIENT_STATE: () => badRequest('The client is not in a state that allows this'),
  DUPLICATE_CLIENT: () => conflict('That client already exists in the core'),
  ACCOUNT_ID_ALREADY_IN_USE: () => conflict('That account number is already in use'),
  TRANSACTION_ALREADY_REVERSED: () => conflict('That transaction was already reversed'),
  MAXIMUM_WITHDRAWAL_AMOUNT_EXCEEDED: () => badRequest('That is over the withdrawal limit'),
  USER_TRANSACTION_LIMIT_EXCEEDED: () => badRequest('That is over the transaction limit'),
  BLOCKING_OPERATION_IN_PROGRESS: () => conflict('The core is busy with this account, try again'),
  LOCK_ACCOUNT_WAIT_TIMEOUT: () => conflict('The core is busy with this account, try again')
};

function translate(status, body, path) {
  const reason = body?.errors?.[0]?.errorReason;
  if (reason && REASONS[reason]) return REASONS[reason]();
  if (status === 404) return notFound('Not found in the core');
  if (status === 409) return conflict('The core is busy with this record, try again');
  return upstream(`Mambu rejected ${path}${reason ? `: ${reason}` : ` (${status})`}`, body);
}

async function call(path, { method = 'GET', body, idempotent = false, query, label } = {}) {
  if (!isConfigured.mambu()) {
    // The mock raises the same envelope a tenant does, so it goes through the
    // same translation — a test sees the error a customer would.
    try { return await mambuMock.handle(path, { method, body, query }); }
    catch (err) { throw err.body ? translate(err.status, err.body, path) : err; }
  }

  const qs = query
    ? '?' + Object.entries(query).filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';

  const headers = {
    Accept: 'application/vnd.mambu.v2+json',
    'Content-Type': 'application/json',
    apikey: config.mambu.apiKey
  };
  if (idempotent) headers['Idempotency-Key'] = randomUUID();

  const res = await request(`${config.mambu.baseUrl}${path}${qs}`, {
    method, headers, body,
    label: label || `mambu ${method} ${path}`,
    retries: method === 'GET' ? 3 : 0
  });

  /* 102: an identical request is still in flight. Not success, not failure —
     wait and re-read, never re-post, or the same money moves twice. */
  if (res.status === 102) {
    const err = conflict('The core is still processing that request');
    err.retryable = true;
    throw err;
  }
  if (res.status === 429) {
    const err = upstream('Mambu is rate limiting us');
    err.retryable = true;
    throw err;
  }
  if (!res.ok) throw translate(res.status, res.body, path);
  return res.body;
}

const major = (m) => Number((Number(m) / 100).toFixed(2));
const toMinor = (a) => Math.round(Number(a || 0) * 100);
const channel = (c) => c || config.mambu.channelId || undefined;

/** Counterparty in ISO 20022 shape — what makes a core statement readable. */
const party = (cp, side) => {
  if (!cp) return undefined;
  const acct = cp.account
    ? { currency: cp.currency || 'GHS', identification: { other: { identification: cp.account, scheme: cp.scheme || 'LOCAL' } } }
    : undefined;
  return side === 'creditor'
    ? { creditor: { name: cp.name }, creditorAccount: acct,
        creditorAgent: cp.bic ? { financialInstitutionIdentification: { bic: cp.bic } } : undefined,
        paymentIdentification: { endToEndIdentification: cp.reference } }
    : { debtor: { name: cp.name }, debtorAccount: acct,
        paymentIdentification: { endToEndIdentification: cp.reference } };
};

export const mambu = {
  configured: () => isConfigured.mambu(),
  usingMock: () => !isConfigured.mambu(),

  ping: () => call('/currencies', { query: { limit: 1 }, label: 'mambu ping' }).then(() => ({ status: 'up' })),

  /* --------------------------------------------------------------- clients */
  createClient: ({ firstName, lastName, msisdn, email, birthDate, externalId, branchKey }) =>
    call('/clients', {
      method: 'POST', idempotent: true,
      body: {
        firstName, lastName, mobilePhone: msisdn, emailAddress: email,
        birthDate: birthDate || undefined, id: externalId || undefined,
        assignedBranchKey: branchKey || config.mambu.branchId || undefined,
        state: 'PENDING_APPROVAL', preferredLanguage: 'ENGLISH'
      }
    }),

  getClient: (clientId, detailsLevel = 'FULL') =>
    call(`/clients/${encodeURIComponent(clientId)}`, { query: { detailsLevel } }),

  patchClient: (clientId, operations) =>
    call(`/clients/${encodeURIComponent(clientId)}`, { method: 'PATCH', body: operations }),

  patchClientState: (clientId, state) =>
    mambu.patchClient(clientId, [{ op: 'REPLACE', path: '/state', value: state }]),

  searchClients: (filterCriteria, { limit = 50, cursor } = {}) =>
    call('/clients:search', { method: 'POST', body: { filterCriteria }, query: { limit, cursor, detailsLevel: 'BASIC' } }),

  /* ------------------------------------------------------ deposit accounts */
  createDepositAccount: ({ clientKey, productTypeKey, accountHolderType = 'CLIENT', name, currency = 'GHS', externalId }) =>
    call('/deposits', {
      method: 'POST', idempotent: true,
      body: {
        accountHolderKey: clientKey, accountHolderType,
        productTypeKey: productTypeKey || config.mambu.depositProductId,
        name: name || 'Current account', currencyCode: currency,
        id: externalId || undefined, accountState: 'APPROVED'
      }
    }),

  getDepositAccount: (accountId, detailsLevel = 'FULL') =>
    call(`/deposits/${encodeURIComponent(accountId)}`, { query: { detailsLevel } }),

  /** APPROVED → ACTIVE, or LOCKED / DORMANT / CLOSED. */
  changeDepositState: (accountId, action, notes) =>
    call(`/deposits/${encodeURIComponent(accountId)}:changeState`, { method: 'POST', idempotent: true, body: { action, notes } }),

  patchDepositAccount: (accountId, operations) =>
    call(`/deposits/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: operations }),

  searchDepositAccounts: (filterCriteria, { limit = 50, cursor } = {}) =>
    call('/deposits:search', { method: 'POST', body: { filterCriteria }, query: { limit, cursor, detailsLevel: 'BASIC' } }),

  /* -------------------------------------------------------- money movement */
  makeDeposit: ({ accountKey, accountId, amountMinor, externalId, notes, channelKey, counterparty }) =>
    call(`/deposits/${encodeURIComponent(accountKey || accountId)}/deposit-transactions`, {
      method: 'POST', idempotent: true,
      body: {
        amount: major(amountMinor), externalId, notes,
        transactionDetails: { transactionChannelId: channel(channelKey) },
        paymentDetails: party(counterparty && { ...counterparty, reference: externalId }, 'debtor')
      }
    }),

  makeWithdrawal: ({ accountKey, accountId, amountMinor, externalId, notes, channelKey, counterparty }) =>
    call(`/deposits/${encodeURIComponent(accountKey || accountId)}/withdrawal-transactions`, {
      method: 'POST', idempotent: true,
      body: {
        amount: major(amountMinor), externalId, notes,
        transactionDetails: { transactionChannelId: channel(channelKey) },
        paymentDetails: party(counterparty && { ...counterparty, reference: externalId }, 'creditor')
      }
    }),

  makeTransfer: ({ fromAccountKey, toAccountKey, amountMinor, externalId, notes, channelKey }) =>
    call(`/deposits/${encodeURIComponent(fromAccountKey)}/transfer-transactions`, {
      method: 'POST', idempotent: true,
      body: {
        amount: major(amountMinor), externalId, notes,
        transferDetails: { linkedAccountKey: toAccountKey, linkedAccountType: 'DEPOSIT' },
        transactionDetails: { transactionChannelId: channel(channelKey) }
      }
    }),

  applyFee: ({ accountKey, amountMinor, externalId, notes, predefinedFeeKey }) =>
    call(`/deposits/${encodeURIComponent(accountKey)}/fee-transactions`, {
      method: 'POST', idempotent: true,
      body: { amount: major(amountMinor), externalId, notes, predefinedFeeKey }
    }),

  /** Reversal. Mambu requires a reason, and so should we. */
  adjustTransaction: (transactionId, notes) =>
    call(`/deposits/transactions/${encodeURIComponent(transactionId)}:adjust`, {
      method: 'POST', idempotent: true, body: { notes }
    }),

  seizeAmount: ({ accountKey, amountMinor, notes, externalId }) =>
    call(`/deposits/${encodeURIComponent(accountKey)}/seizure-transactions`, {
      method: 'POST', idempotent: true, body: { amount: major(amountMinor), notes, externalId }
    }),

  getTransaction: (transactionId) =>
    call(`/deposits/transactions/${encodeURIComponent(transactionId)}`, { query: { detailsLevel: 'FULL' } }),

  listTransactions: (accountKey, { limit = 50, offset = 0 } = {}) =>
    call(`/deposits/${encodeURIComponent(accountKey)}/transactions`, { query: { limit, offset, detailsLevel: 'FULL' } }),

  searchTransactions: (filterCriteria, { limit = 100, cursor, sortBy = 'creationDate', order = 'DESC' } = {}) =>
    call('/deposits/transactions:search', {
      method: 'POST', body: { filterCriteria, sortingCriteria: { field: sortBy, order } },
      query: { limit, cursor, detailsLevel: 'FULL' }
    }),

  /* ------------------------------------------------------------- reference */
  branches: () => call('/branches', { query: { limit: 200 } }),
  currencies: () => call('/currencies', { query: { limit: 200 } }),
  transactionChannels: () => call('/organization/transactionChannels', { query: { limit: 200 } }),
  depositProducts: () => call('/depositproducts', { query: { limit: 200, detailsLevel: 'BASIC' } }),
  glAccounts: (type) => call('/glaccounts', { query: { type, limit: 200 } }),
  journalEntries: (filterCriteria, { limit = 100 } = {}) =>
    call('/gljournalentries:search', { method: 'POST', body: { filterCriteria }, query: { limit } }),

  /* ----------------------------------------------------------------- cards */
  listCards: (accountKey) => call(`/deposits/${encodeURIComponent(accountKey)}/cards`),
  createCard: ({ accountKey, cardType, referenceToken }) =>
    call(`/deposits/${encodeURIComponent(accountKey)}/cards`, {
      method: 'POST', idempotent: true, body: { cardType, referenceToken }
    }),
  blockCard: (accountKey, referenceToken) =>
    call(`/deposits/${encodeURIComponent(accountKey)}/cards/${encodeURIComponent(referenceToken)}`, { method: 'DELETE' }),

  /** What the core thinks the balance is — the reconciliation input. */
  async balance(accountKey) {
    const a = await mambu.getDepositAccount(accountKey, 'BASIC');
    return {
      accountKey: a.encodedKey, accountNumber: a.id, state: a.accountState,
      balanceMinor: toMinor(a.balances?.totalBalance),
      availableMinor: toMinor(a.balances?.availableBalance),
      holdMinor: toMinor(a.balances?.holdBalance),
      currency: a.currencyCode
    };
  }
};

/* The outbox has called these names since the first deposit was posted.
   Renaming them in place would have been a migration for no gain. */
mambu.deposit = mambu.makeDeposit;
mambu.withdraw = mambu.makeWithdrawal;
mambu.transfer = mambu.makeTransfer;
