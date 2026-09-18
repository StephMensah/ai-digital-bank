import { randomInt } from 'node:crypto';
import { query } from '../db/pool.js';

/**
 * Product data a customer expects to find waiting for them: a card, a couple of
 * savings goals, a few payees, and — on a business account — a payroll run.
 *
 * These are sandbox contents, not real instruments. But they belong to one
 * customer and nobody else, which is the point: the bundled sample profile used
 * to hand every screen the same card and the same payees, so a new customer saw
 * somebody else's. Each account gets its own set, seeded once when it opens.
 *
 * Card numbers come from 4000 00, an IIN reserved for testing, so nothing here
 * can ever resemble a live PAN.
 */

const pick = (list) => list[randomInt(list.length)];
const pickSome = (list, n) => [...list].sort(() => Math.random() - 0.5).slice(0, n);

const FIRST = ['Kojo', 'Adjoa', 'Yaw', 'Efua', 'Kwabena', 'Akua', 'Kofi', 'Abena', 'Kwesi', 'Esi'];
const LAST = ['Mensah', 'Nyarko', 'Darko', 'Sarpong', 'Owusu', 'Boateng', 'Asare', 'Frimpong'];
const BANKS = ['GCB Bank', 'Ecobank Ghana', 'Fidelity Bank', 'Absa Bank Ghana', 'CalBank', 'MoMo'];
const MERCHANTS = ['Melcom Osu', 'Shoprite Accra Mall', 'Electro World Accra', 'Papaye East Legon'];
const ROLES = ['Head chef', 'Sous chef', 'Server', 'Driver', 'Storekeeper', 'Contract cleaning'];

const person = () => `${pick(FIRST)} ${pick(LAST)}`;
const digits = (n) => Array.from({ length: n }, () => randomInt(10)).join('');

/** 4000 00 is the reserved test IIN — never a routable card. */
function pan() {
  return `4000 00${digits(2)} ${digits(4)} ${digits(4)}`;
}

function expiry() {
  const d = new Date();
  return `${String(randomInt(1, 13)).padStart(2, '0')}/${String((d.getFullYear() + randomInt(3, 6)) % 100).padStart(2, '0')}`;
}

async function seedCards(account) {
  await query(
    `INSERT INTO cards (account_id, kind, pan, cvv, expiry) VALUES ($1,'physical',$2,$3,$4)`,
    [account.id, pan(), digits(3), expiry()]
  );
  await query(
    `INSERT INTO cards (account_id, kind, pan, cvv, expiry, locked_to)
     VALUES ($1,'virtual',$2,$3,$4,$5)`,
    [account.id, pan(), digits(3), expiry(), pick(['one merchant', 'subscriptions', 'online only'])]
  );
}

async function seedGoals(customerId) {
  const goals = [
    { name: 'Emergency fund', target: 2_000_000, icon: 'shield', due: 'open' },
    { name: `Rent — ${pick(['Dansoman', 'East Legon', 'Tema', 'Madina', 'Achimota'])}`,
      target: 1_440_000, icon: 'home', due: 'Mar 2027' },
    { name: `${pick(FIRST)} — school fees`, target: 600_000, icon: 'school', due: 'Jan 2027' }
  ];
  for (const g of pickSome(goals, 2 + randomInt(2))) {
    // Part-saved, so the progress rings have something to show.
    const saved = Math.round(g.target * (0.15 + Math.random() * 0.6));
    await query(
      `INSERT INTO goals (customer_id, name, target_minor, saved_minor, monthly_minor, due, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [customerId, g.name, g.target, saved, Math.round(g.target / 24 / 100) * 100, g.due, g.icon]
    );
  }
}

async function seedPayees(customerId) {
  const rows = [
    { name: person(), bank: pick(BANKS), ref: `•••• ${digits(4)}`, last: randomInt(50, 800) * 100 },
    { name: person(), bank: 'MoMo', ref: `0${digits(9)}`, last: randomInt(20, 300) * 100 },
    { name: pick(MERCHANTS), bank: pick(BANKS), ref: `•••• ${digits(4)}`, last: randomInt(100, 1500) * 100 }
  ];
  for (const p of pickSome(rows, 2 + randomInt(2))) {
    await query(
      `INSERT INTO payees (customer_id, name, bank, account_ref, last_amount_minor)
       VALUES ($1,$2,$3,$4,$5)`,
      [customerId, p.name, p.bank, p.ref, p.last]
    );
  }
}

async function seedPayroll(account) {
  const staff = 3 + randomInt(4);
  for (let i = 0; i < staff; i += 1) {
    await query(
      `INSERT INTO payroll_lines (account_id, name, role, amount_minor) VALUES ($1,$2,$3,$4)`,
      [account.id, person(), pick(ROLES), randomInt(1200, 4000) * 100]
    );
  }
}

/** Called once, when an account opens. Never fails the account opening. */
export async function seedAccountProducts(customer, account) {
  try {
    await seedCards(account);
    if (account.segment === 'business') await seedPayroll(account);
    // Goals and payees belong to the customer, not the account, so only seed
    // them the first time — a second account must not double them up.
    const { rows } = await query('SELECT count(*)::int AS n FROM goals WHERE customer_id=$1', [customer.id]);
    if (rows[0].n === 0) {
      await seedGoals(customer.id);
      await seedPayees(customer.id);
    }
  } catch (err) {
    // A missing goal is not a reason to fail opening an account.
    const { logger } = await import('../lib/logger.js');
    logger.warn({ err: err.message, customerId: customer.id }, 'could not seed product data');
  }
}

/** Everything the app's screens need beyond balances and transactions. */
export async function loadProducts(customer, accounts) {
  const ids = accounts.map((a) => a.id);
  if (!ids.length) return { cards: {}, goals: [], payees: [], payroll: {} };

  const [cards, goals, payees, payroll] = await Promise.all([
    query('SELECT * FROM cards WHERE account_id = ANY($1) ORDER BY kind DESC, created_at', [ids]),
    query('SELECT * FROM goals WHERE customer_id=$1 ORDER BY created_at', [customer.id]),
    query('SELECT * FROM payees WHERE customer_id=$1 ORDER BY created_at', [customer.id]),
    query('SELECT * FROM payroll_lines WHERE account_id = ANY($1) ORDER BY created_at', [ids])
  ]);

  const byAccount = (rows) => rows.reduce((acc, r) => {
    (acc[r.account_id] = acc[r.account_id] || []).push(r);
    return acc;
  }, {});

  return {
    cards: byAccount(cards.rows),
    payroll: byAccount(payroll.rows),
    goals: goals.rows,
    payees: payees.rows
  };
}
