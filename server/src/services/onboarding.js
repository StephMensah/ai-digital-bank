import { query } from '../db/pool.js';
import { mambu } from '../core/mambu.js';
import { config, isConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { enqueue } from '../core/outbox.js';

/**
 * Open a local account immediately so the customer is never blocked, then
 * mirror the client and account into Mambu. If Mambu is unreachable the
 * mirroring is queued in the outbox rather than failing the signup.
 */
export async function openCustomerAccount(customer, { productName = null, segment = 'personal' } = {}) {
  const accountNumber = generateAccountNumber();
  const { rows } = await query(
    `INSERT INTO accounts (customer_id, account_number, product_type, product_id, currency,
                           product_name, segment)
     VALUES ($1,$2,'deposit',$3,'GHS',$4,$5) RETURNING *`,
    [customer.id, accountNumber, config.mambu.depositProductId, productName, segment]
  );
  const account = rows[0];

  if (isConfigured.mambu()) {
    try {
      await mirrorToMambu({ customer, account });
    } catch (err) {
      logger.warn({ err: err.message, customerId: customer.id }, 'deferring Mambu mirror to outbox');
      await enqueue('mambu.mirror_customer', { customerId: customer.id, accountId: account.id });
    }
  } else {
    await enqueue('mambu.mirror_customer', { customerId: customer.id, accountId: account.id });
  }
  return account;
}

export async function mirrorToMambu({ customer, account }) {
  const [firstName, ...rest] = String(customer.full_name).trim().split(/\s+/);
  const lastName = rest.join(' ') || firstName;

  let clientKey = customer.mambu_client_key;
  if (!clientKey) {
    const created = await mambu.createClient({
      firstName, lastName,
      msisdn: customer.msisdn,
      email: customer.email,
      birthDate: customer.date_of_birth || undefined,
      externalId: `cust-${customer.id}`
    });
    clientKey = created.encodedKey || created.id;
    await query('UPDATE customers SET mambu_client_key=$2, updated_at=now() WHERE id=$1', [customer.id, clientKey]);
  }

  if (!account.mambu_account_key) {
    const deposit = await mambu.createDepositAccount({
      clientKey,
      name: `${customer.full_name} — Everyday`,
      externalId: `acct-${account.id}`
    });
    await query('UPDATE accounts SET mambu_account_key=$2, synced_at=now() WHERE id=$1',
      [account.id, deposit.encodedKey || deposit.id]);
  }
  return clientKey;
}

function generateAccountNumber() {
  // 10 digits, Ghana-style: 3-digit institution prefix + 7 random
  const random = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
  return `501${random}`;
}
