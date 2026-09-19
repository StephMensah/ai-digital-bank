import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { badRequest } from '../lib/errors.js';
import { newReference } from '../lib/crypto.js';
import { parseGhQr, buildGhQr } from '../lib/ghqr.js';
import { loadAccount, openTransaction, settleTransaction, GL } from '../core/ledger.js';
import { scoreTransaction } from '../services/risk.js';

/**
 * GhQR scan-to-pay.
 *
 * A customer scans the code a merchant displays and the money leaves their
 * account. Two steps, deliberately: decode first, pay second.
 *
 * Splitting them is not ceremony. A static sticker carries no amount, so the
 * customer has to type one and must see who they are about to pay before they
 * do. A dynamic code carries the amount the till calculated, and the customer
 * must not be able to change it — so the payment step ignores any amount sent
 * from the client when the code already had one. Trusting the client's number
 * there is how a customer pays GH₵1 for a GH₵100 basket.
 */
export const qrRouter = Router();
qrRouter.use(authenticate('customer'));

qrRouter.post('/decode',
  validate(z.object({ payload: z.string().min(10).max(1024) })),
  async (req, res) => {
    const parsed = parseGhQr(req.body.payload);
    if (!parsed.ok) return res.status(400).json({ error: { code: 'bad_qr', message: parsed.reason } });

    res.json({
      merchant: {
        name: parsed.merchantName, city: parsed.merchantCity,
        terminalId: parsed.terminalId, id: parsed.merchantId, acquirer: parsed.acquirer
      },
      dynamic: parsed.dynamic,
      amountMinor: parsed.amountMinor,
      currency: parsed.currency,
      reference: parsed.reference,
      // The customer types an amount only when the sticker did not carry one.
      needsAmount: !parsed.amountMinor
    });
  });

qrRouter.post('/pay', requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    payload: z.string().min(10).max(1024),
    amountMinor: z.number().int().positive().optional(),
    pin: z.string().regex(/^\d{4}$/)
  })),
  async (req, res, next) => {
    try {
      const parsed = parseGhQr(req.body.payload);
      if (!parsed.ok) throw badRequest(parsed.reason);
      if (parsed.countryCode !== 'GH') throw badRequest('That code is not a Ghanaian merchant code');

      /* A dynamic code's amount wins. The client may not talk us down. */
      const amountMinor = parsed.amountMinor ?? req.body.amountMinor;
      if (!amountMinor || amountMinor < 100) throw badRequest('Enter GH₵1.00 or more');

      const customer = req.customer;
      if (customer.must_change_pin) throw badRequest('Set your PIN before paying');
      const { verifySecret } = await import('../lib/crypto.js');
      if (!verifySecret(req.body.pin, customer.pin_hash)) {
        return res.status(403).json({ error: { code: 'invalid_pin', message: 'That PIN is not right.' } });
      }

      const account = await loadAccount(req.body.accountId, customer.id);
      if (amountMinor > Number(account.available_minor)) {
        throw badRequest('There is not enough in the account for that');
      }

      const risk = await scoreTransaction({
        customer, account,
        intent: { amountMinor, kind: 'transfer', channel: 'ghqr', method: 'qr' }
      });

      const reference = newReference('QR');
      const { transaction } = await openTransaction({
        account, direction: 'debit', kind: 'transfer', amountMinor,
        channel: 'ghqr', provider: 'ghipss',
        counterparty: {
          name: parsed.merchantName, city: parsed.merchantCity,
          merchantId: parsed.merchantId, terminalId: parsed.terminalId
        },
        metadata: {
          narration: `${parsed.merchantName}${parsed.merchantCity ? ', ' + parsed.merchantCity : ''}`,
          terminalId: parsed.terminalId, billNumber: parsed.billNumber, dynamic: parsed.dynamic
        },
        idempotencyKey: req.get('Idempotency-Key'),
        reference, risk, status: 'processing'
      });

      if (transaction.status === 'held') {
        return res.status(202).json({
          transaction, held: true,
          message: 'Held for a quick check. Show the merchant this reference — we will confirm within minutes.'
        });
      }

      /* GhQR settles on the instant rails, so the merchant is paid before the
         customer has put the phone away. Nothing here waits on a webhook. */
      await settleTransaction({ transactionId: transaction.id, glCounterparty: GL.MOMO_SETTLEMENT });

      await audit({ ...auditFrom(req), action: 'payment.ghqr', entity: 'transaction', entityId: transaction.id });
      res.status(201).json({
        paid: true, reference,
        merchant: parsed.merchantName,
        amountMinor,
        terminalId: parsed.terminalId
      });
    } catch (err) { next(err); }
  });

/**
 * A merchant code to scan while there are no real stickers to point a camera
 * at. Generated, not stored: it is test scaffolding, and anything persisted
 * here would look like a merchant registry we do not have.
 */
qrRouter.get('/sample', (req, res) => {
  const amountMinor = req.query.amount ? Number(req.query.amount) : null;
  res.json({
    payload: buildGhQr({
      merchantId: 'GH00' + String(Math.floor(Math.random() * 900000) + 100000),
      merchantName: req.query.name || 'Melcom Osu',
      merchantCity: 'Accra',
      amountMinor,
      terminalId: 'TILL0' + (1 + Math.floor(Math.random() * 5))
    }),
    note: amountMinor ? 'Dynamic code — the amount is fixed by the till'
                      : 'Static code — the customer enters the amount'
  });
});
