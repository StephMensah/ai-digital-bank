import { randomUUID } from 'node:crypto';

/**
 * A Mambu-shaped core, in memory.
 *
 * Not a set of canned replies: it keeps clients, deposit accounts and
 * transactions, moves balances, and refuses what the real core refuses. The
 * point is that code written against it does not have to be rewritten when a
 * sandbox tenant arrives — same paths, same payloads, same encodedKeys, same
 * error envelope.
 *
 * What it deliberately reproduces:
 *  - encodedKey: 32 hex characters, the shape everything downstream stores
 *  - accountState APPROVED → ACTIVE, and the refusal to move money before that
 *  - INSUFFICIENT_BALANCE rather than a negative balance
 *  - externalId uniqueness, which is how a retry stops becoming a double post
 *  - the {errors:[{errorCode, errorReason, errorSource}]} envelope
 *
 * What it does not reproduce: interest accrual, end-of-day, accounting
 * closures, anything scheduled. Those need a real tenant, and pretending
 * otherwise would teach the wrong lesson about what has been tested.
 */

const key = () => randomUUID().replace(/-/g, '');
const now = () => new Date().toISOString();

const db = {
  clients: new Map(),      // encodedKey -> client
  accounts: new Map(),     // encodedKey -> deposit account
  transactions: new Map(), // encodedKey -> transaction
  byExternalId: new Map(), // externalId -> transaction encodedKey
  cards: new Map()         // accountKey -> [cards]
};

class MambuError extends Error {
  constructor(status, errorCode, errorReason, errorSource) {
    super(errorReason);
    this.status = status;
    this.body = { errors: [{ errorCode, errorReason, errorSource }] };
  }
}

const notFound = (what) => new MambuError(404, 3, 'OBJECT_NOT_FOUND', what);
const invalid = (reason, source) => new MambuError(400, 4, reason, source);

/** Accepts an encodedKey or the human id, as the real API does. */
function findAccount(idOrKey) {
  if (db.accounts.has(idOrKey)) return db.accounts.get(idOrKey);
  for (const a of db.accounts.values()) if (a.id === idOrKey) return a;
  throw notFound('depositAccountId');
}

function findClient(idOrKey) {
  if (db.clients.has(idOrKey)) return db.clients.get(idOrKey);
  for (const c of db.clients.values()) if (c.id === idOrKey) return c;
  throw notFound('clientId');
}

const round = (n) => Number(Number(n).toFixed(2));

function post(account, type, amount, body, extra = {}) {
  if (account.accountState !== 'ACTIVE' && account.accountState !== 'APPROVED') {
    throw invalid('INVALID_DEPOSIT_ACCOUNT_STATE', 'accountState');
  }
  if (!(amount > 0)) throw invalid('INVALID_DEPOSIT_AMOUNT', 'amount');

  // A repeat of the same externalId returns the original, exactly as a real
  // core does — this is what stops a retry becoming a second payment.
  if (body.externalId && db.byExternalId.has(body.externalId)) {
    return db.transactions.get(db.byExternalId.get(body.externalId));
  }

  const debit = ['WITHDRAWAL', 'TRANSFER', 'FEE_APPLIED', 'SEIZED_AMOUNT'].includes(type);
  if (debit && round(account.balances.availableBalance - amount) < 0) {
    throw invalid('INSUFFICIENT_BALANCE', 'amount');
  }

  const signed = debit ? -amount : amount;
  account.balances.totalBalance = round(account.balances.totalBalance + signed);
  account.balances.availableBalance = round(account.balances.availableBalance + signed);

  const tx = {
    encodedKey: key(),
    id: String(Math.floor(Math.random() * 9_000_000) + 1_000_000),
    type,
    amount: round(amount),
    currencyCode: account.currencyCode,
    parentAccountKey: account.encodedKey,
    externalId: body.externalId,
    notes: body.notes,
    paymentDetails: body.paymentDetails,
    transactionDetails: body.transactionDetails,
    transferDetails: body.transferDetails,
    accountBalances: { totalBalance: account.balances.totalBalance },
    affectedAmounts: { fundsAmount: round(amount) },
    valueDate: body.valueDate || now(),
    bookingDate: body.bookingDate || now(),
    creationDate: now(),
    ...extra
  };
  db.transactions.set(tx.encodedKey, tx);
  if (tx.externalId) db.byExternalId.set(tx.externalId, tx.encodedKey);
  return tx;
}

const ROUTES = [
  // ---- clients
  ['POST', /^\/clients$/, (_m, body) => {
    const client = {
      encodedKey: key(),
      id: body.id || String(Math.floor(Math.random() * 900000) + 100000),
      firstName: body.firstName, lastName: body.lastName,
      mobilePhone: body.mobilePhone, emailAddress: body.emailAddress,
      birthDate: body.birthDate,
      state: body.state || 'PENDING_APPROVAL',
      assignedBranchKey: body.assignedBranchKey,
      creationDate: now()
    };
    db.clients.set(client.encodedKey, client);
    return client;
  }],
  ['GET', /^\/clients\/([^/]+)$/, (m) => findClient(decodeURIComponent(m[1]))],
  ['PATCH', /^\/clients\/([^/]+)$/, (m, body) => {
    const client = findClient(decodeURIComponent(m[1]));
    (body || []).forEach((op) => {
      const field = String(op.path || '').replace(/^\//, '');
      if (op.op === 'REPLACE' || op.op === 'ADD') client[field] = op.value;
      if (op.op === 'REMOVE') delete client[field];
    });
    return null; // 204, as the real API answers
  }],
  ['POST', /^\/clients:search$/, () => [...db.clients.values()]],

  // ---- deposit accounts
  ['POST', /^\/deposits$/, (_m, body) => {
    if (!db.clients.has(body.accountHolderKey)) throw invalid('INVALID_CLIENT_ID', 'accountHolderKey');
    const account = {
      encodedKey: key(),
      id: body.id || String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
      name: body.name,
      accountHolderKey: body.accountHolderKey,
      accountHolderType: body.accountHolderType || 'CLIENT',
      productTypeKey: body.productTypeKey,
      currencyCode: body.currencyCode || 'GHS',
      accountState: body.accountState || 'APPROVED',
      balances: { totalBalance: 0, availableBalance: 0, holdBalance: 0, lockedBalance: 0 },
      creationDate: now()
    };
    db.accounts.set(account.encodedKey, account);
    return account;
  }],
  ['GET', /^\/deposits\/([^/:]+)$/, (m) => findAccount(decodeURIComponent(m[1]))],
  ['PATCH', /^\/deposits\/([^/:]+)$/, (m, body) => {
    const a = findAccount(decodeURIComponent(m[1]));
    (body || []).forEach((op) => {
      const field = String(op.path || '').replace(/^\//, '');
      if (op.op === 'REPLACE' || op.op === 'ADD') a[field] = op.value;
    });
    return null;
  }],
  ['POST', /^\/deposits\/([^/]+):changeState$/, (m, body) => {
    const a = findAccount(decodeURIComponent(m[1]));
    const next = { APPROVE: 'APPROVED', ACTIVATE: 'ACTIVE', LOCK: 'LOCKED',
                   UNLOCK: 'ACTIVE', CLOSE: 'CLOSED', DORMANT: 'DORMANT' }[body.action];
    if (!next) throw invalid('INVALID_SAVINGS_ACCOUNT_STATE_TRANSITION', 'action');
    if (next === 'CLOSED' && a.balances.totalBalance !== 0) {
      throw invalid('ACCOUNT_HAS_REMAINING_BALANCE', 'accountState');
    }
    a.accountState = next;
    return a;
  }],
  ['POST', /^\/deposits:search$/, () => [...db.accounts.values()]],

  // ---- money movement
  ['POST', /^\/deposits\/([^/]+)\/deposit-transactions$/, (m, body) =>
    post(findAccount(decodeURIComponent(m[1])), 'DEPOSIT', body.amount, body)],

  ['POST', /^\/deposits\/([^/]+)\/withdrawal-transactions$/, (m, body) =>
    post(findAccount(decodeURIComponent(m[1])), 'WITHDRAWAL', body.amount, body)],

  ['POST', /^\/deposits\/([^/]+)\/transfer-transactions$/, (m, body) => {
    const from = findAccount(decodeURIComponent(m[1]));
    const toKey = body.transferDetails?.linkedAccountKey;
    if (!toKey) throw invalid('MISSING_LINKED_ACCOUNT', 'transferDetails.linkedAccountKey');
    const to = findAccount(toKey);
    if (to.encodedKey === from.encodedKey) throw invalid('CANNOT_MAKE_TRANSFER_TO_SOURCE_ACCOUNT', 'transferDetails');

    const out = post(from, 'TRANSFER', body.amount, body);
    // the credit side carries its own external id, or it would collide
    post(to, 'DEPOSIT', body.amount, { ...body, externalId: body.externalId ? `${body.externalId}-CR` : undefined },
      { originalTransactionKey: out.encodedKey });
    return out;
  }],

  ['POST', /^\/deposits\/([^/]+)\/fee-transactions$/, (m, body) =>
    post(findAccount(decodeURIComponent(m[1])), 'FEE_APPLIED', body.amount, body)],

  ['POST', /^\/deposits\/([^/]+)\/seizure-transactions$/, (m, body) =>
    post(findAccount(decodeURIComponent(m[1])), 'SEIZED_AMOUNT', body.amount, body)],

  ['POST', /^\/deposits\/transactions\/([^/]+):adjust$/, (m, body) => {
    const original = db.transactions.get(decodeURIComponent(m[1]));
    if (!original) throw notFound('depositTransactionId');
    if (original.adjustmentTransactionKey) throw invalid('TRANSACTION_ALREADY_REVERSED', 'transactionId');
    if (!body?.notes) throw invalid('INVALID_NOTES', 'notes');

    const account = db.accounts.get(original.parentAccountKey);
    const reverse = original.type === 'DEPOSIT' ? 'WITHDRAWAL' : 'DEPOSIT';
    const adjustment = post(account, reverse, original.amount,
      { notes: body.notes, externalId: original.externalId ? `${original.externalId}-ADJ` : undefined },
      { originalTransactionKey: original.encodedKey,
        type: original.type === 'DEPOSIT' ? 'ADJUSTMENT' : 'WITHDRAWAL_ADJUSTMENT' });
    original.adjustmentTransactionKey = adjustment.encodedKey;
    return adjustment;
  }],

  ['GET', /^\/deposits\/transactions\/([^/]+)$/, (m) => {
    const tx = db.transactions.get(decodeURIComponent(m[1]));
    if (!tx) throw notFound('depositTransactionId');
    return tx;
  }],

  ['GET', /^\/deposits\/([^/]+)\/transactions$/, (m, _b, query) => {
    const a = findAccount(decodeURIComponent(m[1]));
    const all = [...db.transactions.values()]
      .filter((t) => t.parentAccountKey === a.encodedKey)
      .sort((x, y) => new Date(y.creationDate) - new Date(x.creationDate));
    const offset = Number(query?.offset || 0);
    return all.slice(offset, offset + Number(query?.limit || 50));
  }],

  ['POST', /^\/deposits\/transactions:search$/, (_m, body) => {
    // Enough of Mambu's filter grammar to be useful: the operators a
    // statement screen actually sends.
    const rows = [...db.transactions.values()];
    const match = (t, c) => {
      const v = c.field.split('.').reduce((o, k) => (o == null ? o : o[k]), t);
      switch (c.operator) {
        case 'EQUALS': return String(v) === String(c.value);
        case 'IN': return (c.values || []).map(String).includes(String(v));
        case 'MORE_THAN': return Number(v) > Number(c.value);
        case 'LESS_THAN': return Number(v) < Number(c.value);
        case 'BETWEEN': return Number(v) >= Number(c.value) && Number(v) <= Number(c.secondValue);
        case 'AFTER': return new Date(v) > new Date(c.value);
        case 'BEFORE': return new Date(v) < new Date(c.value);
        case 'EMPTY': return v == null;
        case 'NOT_EMPTY': return v != null;
        default: return true;
      }
    };
    return rows.filter((t) => (body.filterCriteria || []).every((c) => match(t, c)));
  }],

  // ---- cards
  ['GET', /^\/deposits\/([^/]+)\/cards$/, (m) => db.cards.get(findAccount(decodeURIComponent(m[1])).encodedKey) || []],
  ['POST', /^\/deposits\/([^/]+)\/cards$/, (m, body) => {
    const a = findAccount(decodeURIComponent(m[1]));
    const card = { referenceToken: body.referenceToken || key(), cardType: body.cardType || 'DEBIT', state: 'ACTIVE' };
    db.cards.set(a.encodedKey, [...(db.cards.get(a.encodedKey) || []), card]);
    return card;
  }],
  ['DELETE', /^\/deposits\/([^/]+)\/cards\/([^/]+)$/, (m) => {
    const a = findAccount(decodeURIComponent(m[1]));
    const token = decodeURIComponent(m[2]);
    db.cards.set(a.encodedKey, (db.cards.get(a.encodedKey) || []).filter((c) => c.referenceToken !== token));
    return null;
  }],

  // ---- reference data
  ['GET', /^\/branches$/, () => [{ encodedKey: key(), id: 'ACCRA', name: 'Accra', state: 'ACTIVE' }]],
  ['GET', /^\/currencies$/, () => [{ code: 'GHS', name: 'Ghana Cedi', symbol: 'GH₵', currencyCode: 'GHS' }]],
  ['GET', /^\/organization\/transactionChannels$/, () => [
    { encodedKey: key(), id: 'momo', name: 'Mobile money' },
    { encodedKey: key(), id: 'gip', name: 'GIP interbank' },
    { encodedKey: key(), id: 'card', name: 'Card' },
    { encodedKey: key(), id: 'internal', name: 'Internal transfer' }
  ]],
  ['GET', /^\/depositproducts$/, () => [
    { encodedKey: key(), id: 'SAVINGS_GHS', name: 'Current account', productState: 'ACTIVE', type: 'CURRENT_ACCOUNT', currencyCode: 'GHS' }
  ]],
  ['GET', /^\/glaccounts$/, () => [
    { glCode: '1000', name: 'Customer deposits', type: 'LIABILITY' },
    { glCode: '2000', name: 'Mobile money settlement', type: 'ASSET' },
    { glCode: '2100', name: 'Card settlement', type: 'ASSET' },
    { glCode: '2200', name: 'GIP settlement', type: 'ASSET' }
  ]],
  ['POST', /^\/gljournalentries:search$/, () => []]
];

export const mambuMock = {
  isMock: true,

  /** Same call surface as a live tenant, minus the network. */
  async handle(path, { method = 'GET', body, query } = {}) {
    // A real core is not instant, and code that assumes it is breaks later.
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 90));

    for (const [verb, pattern, fn] of ROUTES) {
      if (verb !== method) continue;
      const m = path.match(pattern);
      if (m) return fn(m, body, query);
    }
    throw notFound(path);
  },

  /** For tests and the control tower: what the mock core is currently holding. */
  snapshot: () => ({
    clients: db.clients.size,
    accounts: db.accounts.size,
    transactions: db.transactions.size
  }),

  reset() {
    db.clients.clear(); db.accounts.clear();
    db.transactions.clear(); db.byExternalId.clear(); db.cards.clear();
  }
};
