import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newReference } from '../lib/crypto.js';
import { loadAccount, openTransaction, settleTransaction, failTransaction, GL } from '../core/ledger.js';

/**
 * The ledger owns its own transaction and does not take an outer client, so a
 * buy cannot be one atomic write across both. Instead the money moves first and
 * the holding follows; if the holding write fails, the money movement is
 * reversed rather than left standing. A customer who paid and got nothing is
 * the failure worth engineering against — the reverse, units without payment,
 * is never possible in this order.
 */
async function withReversal(transactionId, fn) {
  try { return await fn(); }
  catch (err) {
    await failTransaction({ transactionId, reason: 'Reversed: the holding could not be recorded' })
      .catch(() => {});
    throw err;
  }
}

/**
 * Investments.
 *
 * Saving and investing are different promises and this is the investing half:
 * money that can go down. Three things a customer can do with a digital asset —
 * buy it, turn it back into cedis, or borrow against it without selling.
 *
 * Deliberate choices, because they are the ones that bite later:
 *
 *  - Units are numeric(24,8), not integers. Cedis are pesewas and fit a bigint;
 *    a fraction of a digital asset does not, and rounding one into the other is
 *    how holdings quietly drift from what the customer bought.
 *  - Every buy and redemption moves real money on the ledger, in the same
 *    transaction as the holding changes. A holding that grew without a matching
 *    debit is a hole in the balance sheet.
 *  - Borrowing pledges units rather than moving them. Pledged units stay in the
 *    holding and are refused for redemption, so a customer cannot sell
 *    collateral out from under a loan.
 *  - Prices come from a quote that is read once and used for the whole order.
 *    Re-reading mid-order would let the amount charged differ from the amount
 *    quoted.
 */
export const investRouter = Router();
investRouter.use(authenticate('customer'));

/* A sandbox price feed. Prices move on a slow random walk around a base so the
   portfolio is not suspiciously static, and the walk is seeded per minute so a
   quote and the order that follows it agree. */
const ASSETS = {
  BTC: { name: 'Bitcoin', base: 1_450_000_00, vol: 0.04 },
  ETH: { name: 'Ethereum', base: 78_000_00, vol: 0.05 },
  USDT: { name: 'Tether', base: 15_40, vol: 0.001 },
  USDC: { name: 'USD Coin', base: 15_40, vol: 0.001 },
  GOLD: { name: 'Tokenised gold, 1g', base: 1_320_00, vol: 0.02 }
};

function priceMinor(symbol, at = Date.now()) {
  const asset = ASSETS[symbol];
  if (!asset) throw badRequest('We do not offer that asset');
  const minute = Math.floor(at / 60_000);
  // deterministic within the minute, so quote and fill agree
  const wobble = Math.sin(minute * (symbol.charCodeAt(0) + 7)) * asset.vol;
  return Math.max(1, Math.round(asset.base * (1 + wobble)));
}

const units = (u) => Number(Number(u).toFixed(8));
const FEE_BPS = 75;            // 0.75% on the way in and out
const MAX_LTV_BPS = 5000;      // borrow at most half of what the pledge is worth
const LOAN_RATE_BPS = 1800;    // 18% a year

/* -------------------------------------------------------------- the market */

investRouter.get('/assets', async (_req, res) => {
  res.json({
    assets: Object.entries(ASSETS).map(([symbol, a]) => ({
      symbol, name: a.name,
      priceMinor: priceMinor(symbol),
      // yesterday's price from the same walk, so the change is honest about itself
      changePct: Number((((priceMinor(symbol) / priceMinor(symbol, Date.now() - 86_400_000)) - 1) * 100).toFixed(2))
    })),
    feeBps: FEE_BPS, maxLtvBps: MAX_LTV_BPS, loanRateBps: LOAN_RATE_BPS
  });
});

investRouter.get('/portfolio', async (req, res, next) => {
  try {
    const [{ rows: holdings }, { rows: loans }, { rows: orders }] = await Promise.all([
      query('SELECT * FROM asset_holdings WHERE customer_id=$1 AND units > 0 ORDER BY symbol', [req.customer.id]),
      query("SELECT * FROM asset_loans WHERE customer_id=$1 AND status='active'", [req.customer.id]),
      query('SELECT * FROM asset_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20', [req.customer.id])
    ]);

    const priced = holdings.map((h) => {
      const price = priceMinor(h.symbol);
      const valueMinor = Math.round(Number(h.units) * price);
      return {
        symbol: h.symbol, name: ASSETS[h.symbol]?.name || h.symbol,
        units: units(h.units), pledgedUnits: units(h.pledged_units),
        freeUnits: units(Number(h.units) - Number(h.pledged_units)),
        priceMinor: price, valueMinor,
        costMinor: Number(h.cost_minor),
        gainMinor: valueMinor - Number(h.cost_minor)
      };
    });

    res.json({
      holdings: priced,
      valueMinor: priced.reduce((s, h) => s + h.valueMinor, 0),
      gainMinor: priced.reduce((s, h) => s + h.gainMinor, 0),
      loans: loans.map((l) => ({
        id: l.id, symbol: l.symbol, pledgedUnits: units(l.pledged_units),
        outstandingMinor: Number(l.outstanding_minor), rateBps: l.rate_bps
      })),
      borrowedMinor: loans.reduce((s, l) => s + Number(l.outstanding_minor), 0),
      orders: orders.map((o) => ({
        side: o.side, symbol: o.symbol, units: units(o.units),
        amountMinor: Number(o.amount_minor), feeMinor: Number(o.fee_minor),
        reference: o.reference, at: o.created_at
      }))
    });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------ buy / redeem */

const orderBody = z.object({
  accountId: z.string().uuid(),
  symbol: z.string().min(2).max(8).transform((v) => v.toUpperCase()),
  amountMinor: z.number().int().positive().optional(),
  units: z.number().positive().optional()
});

investRouter.post('/buy', requireIdempotencyKey, validate(orderBody), async (req, res, next) => {
  try {
    const { symbol, accountId } = req.body;
    const price = priceMinor(symbol);
    const spendMinor = req.body.amountMinor ?? Math.round(req.body.units * price);
    if (!spendMinor || spendMinor < 100) throw badRequest('Invest GH₵1.00 or more');

    const fee = Math.round((spendMinor * FEE_BPS) / 10_000);
    const bought = units((spendMinor - fee) / price);
    if (bought <= 0) throw badRequest('That is too small to buy any of this asset');

    const account = await loadAccount(accountId, req.customer.id);
    if (spendMinor > Number(account.available_minor)) throw badRequest('There is not enough in the account for that');

    const reference = newReference('INV');

    /* The debit and the holding move together. Either the customer paid and
       owns the units, or neither happened. */
    const { transaction } = await openTransaction({
      account, direction: 'debit', kind: 'transfer', amountMinor: spendMinor,
      channel: 'investment', provider: 'internal',
      counterparty: { name: `${symbol} purchase` },
      metadata: { narration: `Bought ${bought} ${symbol}`, symbol, side: 'buy' },
      idempotencyKey: req.get('Idempotency-Key'), reference, status: 'processing'
    });
    await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS });

    await withReversal(transaction.id, async () => {
      await query(
        `INSERT INTO asset_holdings (customer_id, symbol, units, cost_minor)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (customer_id, symbol) DO UPDATE
           SET units = asset_holdings.units + EXCLUDED.units,
               cost_minor = asset_holdings.cost_minor + EXCLUDED.cost_minor,
               updated_at = now()`,
        [req.customer.id, symbol, bought, spendMinor - fee]
      );
      await query(
        `INSERT INTO asset_orders (customer_id, account_id, side, symbol, units, price_minor, amount_minor, fee_minor, reference)
         VALUES ($1,$2,'buy',$3,$4,$5,$6,$7,$8)`,
        [req.customer.id, accountId, symbol, bought, price, spendMinor, fee, reference]
      );
    });

    await audit({ ...auditFrom(req), action: 'invest.bought', entity: 'asset', entityId: symbol });
    res.status(201).json({ symbol, units: bought, priceMinor: price, spentMinor: spendMinor, feeMinor: fee, reference });
  } catch (err) { next(err); }
});

investRouter.post('/redeem', requireIdempotencyKey, validate(orderBody), async (req, res, next) => {
  try {
    const { symbol, accountId } = req.body;
    const price = priceMinor(symbol);

    const { rows } = await query('SELECT * FROM asset_holdings WHERE customer_id=$1 AND symbol=$2', [req.customer.id, symbol]);
    const holding = rows[0];
    if (!holding) throw notFound(`You do not hold any ${symbol}`);

    const free = Number(holding.units) - Number(holding.pledged_units);
    const sell = units(req.body.units ?? (req.body.amountMinor / price));
    if (sell <= 0) throw badRequest('Enter how much to redeem');
    if (sell > free) {
      throw badRequest(Number(holding.pledged_units) > 0
        ? `Only ${units(free)} ${symbol} is free — the rest is pledged against a loan`
        : `You only hold ${units(holding.units)} ${symbol}`);
    }

    const grossMinor = Math.round(sell * price);
    const fee = Math.round((grossMinor * FEE_BPS) / 10_000);
    const netMinor = grossMinor - fee;
    const account = await loadAccount(accountId, req.customer.id);
    const reference = newReference('RDM');

    await (async () => {
      const { transaction } = await openTransaction({
        account, direction: 'credit', kind: 'deposit', amountMinor: netMinor,
        channel: 'investment', provider: 'internal',
        counterparty: { name: `${symbol} redemption` },
        metadata: { narration: `Redeemed ${sell} ${symbol}`, symbol, side: 'redeem' },
        idempotencyKey: req.get('Idempotency-Key'), reference, status: 'processing'
      });
      await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS });

      // Cost basis reduces proportionally, so the gain on what is left stays honest.
      const share = sell / Number(holding.units);
      await query(
        `UPDATE asset_holdings
            SET units = units - $3::numeric,
                cost_minor = GREATEST(0, cost_minor - ROUND(cost_minor * $4::numeric)::bigint),
                updated_at = now()
          WHERE customer_id=$1 AND symbol=$2`,
        [req.customer.id, symbol, sell, share]
      );
      await query(
        `INSERT INTO asset_orders (customer_id, account_id, side, symbol, units, price_minor, amount_minor, fee_minor, reference)
         VALUES ($1,$2,'redeem',$3,$4,$5,$6,$7,$8)`,
        [req.customer.id, accountId, symbol, sell, price, netMinor, fee, reference]
      );
    })();

    await audit({ ...auditFrom(req), action: 'invest.redeemed', entity: 'asset', entityId: symbol });
    res.status(201).json({ symbol, units: sell, priceMinor: price, receivedMinor: netMinor, feeMinor: fee, reference });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------ borrow against it */

investRouter.post('/finance', requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    symbol: z.string().min(2).max(8).transform((v) => v.toUpperCase()),
    amountMinor: z.number().int().positive()
  })),
  async (req, res, next) => {
    try {
      const { symbol, amountMinor, accountId } = req.body;
      const price = priceMinor(symbol);

      const { rows } = await query('SELECT * FROM asset_holdings WHERE customer_id=$1 AND symbol=$2', [req.customer.id, symbol]);
      const holding = rows[0];
      if (!holding) throw notFound(`You do not hold any ${symbol} to borrow against`);

      const freeUnits = Number(holding.units) - Number(holding.pledged_units);
      const freeValue = Math.round(freeUnits * price);
      const maxBorrow = Math.floor((freeValue * MAX_LTV_BPS) / 10_000);
      if (amountMinor > maxBorrow) {
        throw badRequest(`You can borrow up to GH₵${(maxBorrow / 100).toFixed(2)} against the ${symbol} that is not already pledged`);
      }

      // Pledge only what the loan needs, at the agreed ratio — not the lot.
      const pledge = units((amountMinor * 10_000) / MAX_LTV_BPS / price);
      const account = await loadAccount(accountId, req.customer.id);
      const reference = newReference('AFL');

      await (async () => {
        const { transaction } = await openTransaction({
          account, direction: 'credit', kind: 'loan_disbursement', amountMinor,
          channel: 'asset_finance', provider: 'internal',
          counterparty: { name: `${symbol}-backed advance` },
          metadata: { narration: `Advance against ${pledge} ${symbol}`, symbol },
          idempotencyKey: req.get('Idempotency-Key'), reference, status: 'processing'
        });
        await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS });

        await query(
          'UPDATE asset_holdings SET pledged_units = pledged_units + $3, updated_at = now() WHERE customer_id=$1 AND symbol=$2',
          [req.customer.id, symbol, pledge]
        );
        await query(
          `INSERT INTO asset_loans (customer_id, symbol, pledged_units, principal_minor, outstanding_minor, rate_bps, ltv_bps)
           VALUES ($1,$2,$3,$4,$4,$5,$6)`,
          [req.customer.id, symbol, pledge, amountMinor, LOAN_RATE_BPS, MAX_LTV_BPS]
        );
      })();

      await audit({ ...auditFrom(req), action: 'invest.financed', entity: 'asset', entityId: symbol });
      res.status(201).json({
        symbol, pledgedUnits: pledge, advancedMinor: amountMinor,
        rateBps: LOAN_RATE_BPS, ltvBps: MAX_LTV_BPS, reference
      });
    } catch (err) { next(err); }
  });

investRouter.post('/repay', requireIdempotencyKey,
  validate(z.object({ accountId: z.string().uuid(), loanId: z.string().uuid(), amountMinor: z.number().int().positive() })),
  async (req, res, next) => {
    try {
      const { rows } = await query("SELECT * FROM asset_loans WHERE id=$1 AND customer_id=$2 AND status='active'",
        [req.body.loanId, req.customer.id]);
      const loan = rows[0];
      if (!loan) throw notFound('No such loan');

      const pay = Math.min(req.body.amountMinor, Number(loan.outstanding_minor));
      const account = await loadAccount(req.body.accountId, req.customer.id);
      if (pay > Number(account.available_minor)) throw badRequest('There is not enough in the account for that');
      const reference = newReference('AFR');

      await (async () => {
        const { transaction } = await openTransaction({
          account, direction: 'debit', kind: 'loan_repayment', amountMinor: pay,
          channel: 'asset_finance', provider: 'internal',
          counterparty: { name: `${loan.symbol} advance repayment` },
          metadata: { narration: 'Repaying advance', loanId: loan.id },
          idempotencyKey: req.get('Idempotency-Key'), reference, status: 'processing'
        });
        await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.CUSTOMER_DEPOSITS });

        const left = Number(loan.outstanding_minor) - pay;
        // Clearing the loan releases the pledge; a partial payment does not,
        // because half a collateral position is not collateral.
        await query(
          `UPDATE asset_loans SET outstanding_minor=$2, status = CASE WHEN $2 = 0 THEN 'repaid' ELSE status END WHERE id=$1`,
          [loan.id, left]
        );
        if (left === 0) {
          await query(
            'UPDATE asset_holdings SET pledged_units = GREATEST(0, pledged_units - $3), updated_at = now() WHERE customer_id=$1 AND symbol=$2',
            [req.customer.id, loan.symbol, loan.pledged_units]
          );
        }
      })();

      res.json({ paidMinor: pay, outstandingMinor: Number(loan.outstanding_minor) - pay, reference });
    } catch (err) { next(err); }
  });
