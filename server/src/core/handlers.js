import { onTopic } from './outbox.js';
import { mambu } from './mambu.js';
import { query } from '../db/pool.js';
import { mirrorToMambu } from '../services/onboarding.js';
import { logger } from '../lib/logger.js';

/** Everything that must eventually reach the core banking system lands here. */
export function registerOutboxHandlers() {
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
