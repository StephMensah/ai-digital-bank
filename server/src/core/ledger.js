import { query, tx as withTx } from '../db/pool.js';
import { newReference } from '../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';

// GL codes for the shadow ledger. Mambu holds the authoritative books; these
// entries exist so the platform can prove its own view and reconcile daily.
/*
 * Both lines of a settlement are written against the SAME account row (see
 * settleTransaction). So the counterparty GL must never be CUSTOMER_DEPOSITS:
 * that posts a DR and a CR of equal size on one account's own deposit code,
 * which nets to zero on the ledger while the balance really moves. Every such
 * payment then shows for ever as a reconciliation break. The counterparty is
 * whatever the money actually faces — a rail, a clearing account, an asset.
 */
export const GL = {
  CUSTOMER_DEPOSITS: '2010',
  MOMO_SETTLEMENT: '1210',
  CARD_SETTLEMENT: '1220',
  BANK_SETTLEMENT: '1230',
  REMITTANCE_SETTLEMENT: '1240',
  INVESTMENTS: '1300',
  /* Both legs of an on-us transfer face this, so it nets to zero across the
     pair while each customer's own deposit balance stays true. */
  TRANSFER_CLEARING: '1910',
  FEE_INCOME: '4010',
  SUSPENSE: '1900'
};

export async function loadAccount(accountId, customerId) {
  const { rows } = await query(
    `SELECT a.*, c.kyc_tier, c.kyc_status, c.status AS customer_status, c.msisdn, c.full_name,
            c.created_at AS customer_created_at, c.id AS cust_id, c.mambu_client_key
       FROM accounts a JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1 ${customerId ? 'AND a.customer_id = $2' : ''}`,
    customerId ? [accountId, customerId] : [accountId]
  );
  if (!rows[0]) throw notFound('Account not found');
  return rows[0];
}

export async function assertWithinLimits(account, amountMinor) {
  const { rows } = await query('SELECT * FROM limit_profiles WHERE tier = $1', [account.kyc_tier]);
  const limit = rows[0];
  if (!limit) return;

  if (amountMinor > limit.per_tx_minor) {
    throw unprocessable('This amount is above your per-payment limit. Upgrade your tier to raise it.', {
      perTransactionMinor: limit.per_tx_minor
    });
  }
  const { rows: used } = await query(
    `SELECT COALESCE(sum(amount_minor),0) AS today
       FROM transactions
      WHERE account_id = $1 AND direction = 'debit'
        AND status IN ('pending','held','processing','posted')
        AND created_at >= date_trunc('day', now())`,
    [account.id]
  );
  if (Number(used[0].today) + amountMinor > limit.daily_minor) {
    throw unprocessable('This payment would pass your daily limit.', {
      dailyMinor: limit.daily_minor, usedTodayMinor: Number(used[0].today)
    });
  }
}

/** Reserve funds and record the transaction in one atomic step. */
export async function openTransaction({
  account, direction, kind, amountMinor, feeMinor = 0, channel, provider, counterparty = {},
  idempotencyKey, metadata = {}, risk, status = 'pending'
}) {
  return withTx(async (client) => {
    if (idempotencyKey) {
      const { rows: existing } = await client.query(
        'SELECT * FROM transactions WHERE idempotency_key = $1', [idempotencyKey]
      );
      if (existing[0]) return { transaction: existing[0], replayed: true };
    }

    if (direction === 'debit') {
      const { rows: locked } = await client.query(
        'SELECT available_minor FROM accounts WHERE id = $1 FOR UPDATE', [account.id]
      );
      const available = Number(locked[0].available_minor);
      if (available < amountMinor + feeMinor) {
        throw unprocessable('Not enough available balance for this payment.', {
          availableMinor: available, requiredMinor: amountMinor + feeMinor
        });
      }
      await client.query(
        'UPDATE accounts SET available_minor = available_minor - $2 WHERE id = $1',
        [account.id, amountMinor + feeMinor]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO transactions
         (reference, idempotency_key, account_id, counterparty, direction, kind, amount_minor,
          fee_minor, currency, channel, provider, status, risk_score, risk_reasons, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        newReference(), idempotencyKey || null, account.id, counterparty, direction, kind,
        amountMinor, feeMinor, account.currency || 'GHS', channel, provider || null, status,
        risk?.score ?? null, JSON.stringify(risk?.reasons || []), metadata
      ]
    );
    return { transaction: rows[0], replayed: false };
  });
}

/** Settle a transaction: move cached balance, write double-entry lines, stamp Mambu key. */
export async function settleTransaction({ transactionId, mambuTxKey, providerRef, glCounterparty }) {
  return withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]
    );
    const t = rows[0];
    if (!t) throw notFound('Transaction not found');
    if (t.status === 'posted') return t;
    if (t.status === 'reversed') throw conflict('Transaction was already reversed');

    const total = Number(t.amount_minor) + Number(t.fee_minor);
    if (t.direction === 'debit') {
      await client.query('UPDATE accounts SET balance_minor = balance_minor - $2 WHERE id = $1', [t.account_id, total]);
    } else {
      await client.query(
        'UPDATE accounts SET balance_minor = balance_minor + $2, available_minor = available_minor + $2 WHERE id = $1',
        [t.account_id, Number(t.amount_minor)]
      );
    }

    const counterGl = glCounterparty || GL.SUSPENSE;
    const lines = t.direction === 'debit'
      ? [[GL.CUSTOMER_DEPOSITS, 'DR', t.amount_minor], [counterGl, 'CR', t.amount_minor]]
      : [[counterGl, 'DR', t.amount_minor], [GL.CUSTOMER_DEPOSITS, 'CR', t.amount_minor]];
    if (Number(t.fee_minor) > 0) {
      lines.push([GL.CUSTOMER_DEPOSITS, 'DR', t.fee_minor], [GL.FEE_INCOME, 'CR', t.fee_minor]);
    }
    for (const [gl, side, amount] of lines) {
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, gl_code, side, amount_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.id, t.account_id, gl, side, amount, t.currency]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE transactions
          SET status='posted', posted_at=now(),
              mambu_tx_key = COALESCE($2, mambu_tx_key),
              provider_ref = COALESCE($3, provider_ref)
        WHERE id=$1 RETURNING *`,
      [t.id, mambuTxKey || null, providerRef || null]
    );
    return updated[0];
  });
}

/** Release a hold when a payment fails upstream. */
export async function failTransaction({ transactionId, reason }) {
  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM transactions WHERE id=$1 FOR UPDATE', [transactionId]);
    const t = rows[0];
    if (!t || t.status === 'posted' || t.status === 'failed') return t;
    if (t.direction === 'debit') {
      await client.query(
        'UPDATE accounts SET available_minor = available_minor + $2 WHERE id = $1',
        [t.account_id, Number(t.amount_minor) + Number(t.fee_minor)]
      );
    }
    const { rows: updated } = await client.query(
      `UPDATE transactions SET status='failed',
              metadata = metadata || jsonb_build_object('failure_reason', $2::text)
        WHERE id=$1 RETURNING *`,
      [t.id, reason || 'upstream declined']
    );
    return updated[0];
  });
}
