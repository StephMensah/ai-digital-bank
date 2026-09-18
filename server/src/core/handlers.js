import { onTopic } from './outbox.js';
import { mambu } from './mambu.js';
import { query } from '../db/pool.js';
import { mirrorToMambu } from '../services/onboarding.js';
import { logger } from '../lib/logger.js';

/** Everything that must eventually reach the core banking system lands here. */
export function registerOutboxHandlers() {
  /* Wallet to bank, second leg. The job waits for the collection to post
     before it sends anything onward: paying a bank account out of money the
     wallet never gave us is the one failure this design exists to prevent. */
  onTopic('payments.onward_bank_leg', async ({ transactionId, accountId, amountMinor, destination, narration }) => {
    const { query } = await import('../db/pool.js');
    const { rows } = await query('SELECT status FROM transactions WHERE id=$1', [transactionId]);
    const status = rows[0]?.status;

    if (status === 'failed' || status === 'reversed') return;          // nothing collected, nothing to send
    if (status !== 'posted') throw new Error('collection still pending');  // retried by the outbox

    const { loadAccount, openTransaction } = await import('./ledger.js');
    const { dispatchPayout } = await import('../routes/payments.js');
    const { rows: acct } = await query('SELECT customer_id FROM accounts WHERE id=$1', [accountId]);
    const account = await loadAccount(accountId, acct[0].customer_id);

    const { transaction } = await openTransaction({
      account, direction: 'debit', kind: 'withdrawal', amountMinor,
      channel: 'wallet_to_bank', provider: 'bank',
      counterparty: destination,
      metadata: { narration, leg: 'onward', collectedBy: transactionId },
      idempotencyKey: `onward-${transactionId}`,
      status: 'processing'
    });

    await dispatchPayout({
      transaction, method: 'bank', destination, narration, account
    });
  });

  onTopic('mambu.mirror_customer', async ({ customerId, accountId }) => {
    const { rows: c } = await query('SELECT * FROM customers WHERE id=$1', [customerId]);
    const { rows: a } = await query('SELECT * FROM accounts WHERE id=$1', [accountId]);
    if (!c[0] || !a[0]) return;
    await mirrorToMambu({ customer: c[0], account: a[0] });
  });

  onTopic('mambu.post_deposit', async ({ transactionId, accountKey, amountMinor, reference }) => {
    const result = await mambu.deposit({ accountKey, amountMinor, notes: reference, externalId: reference });
    await query('UPDATE transactions SET mambu_tx_key=$2 WHERE id=$1',
      [transactionId, result.encodedKey || result.id || null]);
  });

  onTopic('mambu.post_withdrawal', async ({ transactionId, accountKey, amountMinor, reference }) => {
    const result = await mambu.withdraw({ accountKey, amountMinor, notes: reference, externalId: reference });
    await query('UPDATE transactions SET mambu_tx_key=$2 WHERE id=$1',
      [transactionId, result.encodedKey || result.id || null]);
  });

  onTopic('mambu.post_transfer', async ({ transactionId, fromAccountKey, toAccountKey, amountMinor, reference }) => {
    const result = await mambu.transfer({ fromAccountKey, toAccountKey, amountMinor, notes: reference, externalId: reference });
    await query('UPDATE transactions SET mambu_tx_key=$2 WHERE id=$1',
      [transactionId, result.encodedKey || result.id || null]);
  });

  onTopic('mambu.refresh_account', async ({ accountKey }) => {
    const core = await mambu.getDepositAccount(accountKey);
    await query(
      `UPDATE accounts SET balance_minor=$2, available_minor=$3, synced_at=now() WHERE mambu_account_key=$1`,
      [accountKey,
       Math.round(Number(core?.balances?.totalBalance || 0) * 100),
       Math.round(Number(core?.balances?.availableBalance || 0) * 100)]
    );
  });

  logger.info('outbox handlers registered');
}
