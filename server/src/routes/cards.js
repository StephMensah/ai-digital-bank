import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { audit, auditFrom } from '../middleware/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { randomUUID } from 'node:crypto';
import { requireIdempotencyKey } from '../middleware/idempotency.js';
import { newReference } from '../lib/crypto.js';
import { railFor } from '../providers/index.js';
import { loadAccount, openTransaction } from '../core/ledger.js';

/**
 * Cards.
 *
 * Two kinds: the ones we issue, and the ones a customer links from another
 * bank to fund their account.
 *
 * For linked cards we keep the scheme, the last four, the expiry and a
 * provider token — never a PAN, never a CVV. Storing card numbers would put
 * this service inside PCI scope for nothing a customer can see; the token is
 * what the rail needs to charge the card, and it is the rail's job to hold the
 * rest. The full number is accepted here only long enough to read its scheme
 * and last four, and is never written down.
 */
export const cardsRouter = Router();
cardsRouter.use(authenticate('customer'));

/* Tiers. Real card tiers are about what happens when something goes wrong
   abroad, so the benefits are the ones people actually claim. */
export const TIERS = {
  classic: {
    name: 'Classic', scheme: 'visa',
    dailyLimitMinor: 500_000, fxMarkupBps: 250, lounge: 0,
    benefits: ['Free instant freeze', 'Two free ATM withdrawals a month']
  },
  platinum: {
    name: 'Platinum', scheme: 'visa',
    dailyLimitMinor: 2_500_000, fxMarkupBps: 150, lounge: 4,
    benefits: [
      'Four airport lounge visits a year, Kotoka included',
      'Travel medical cover to $250,000',
      'Purchase protection for 90 days',
      'No ATM fee anywhere in Ghana'
    ]
  },
  infinite: {
    name: 'Infinite', scheme: 'visa',
    dailyLimitMinor: 10_000_000, fxMarkupBps: 75, lounge: -1,
    benefits: [
      'Unlimited lounge access worldwide, with a guest',
      'Travel medical cover to $1,000,000',
      'Concierge, 24 hours',
      'No FX markup above interbank plus 0.75%',
      'Dedicated line — a person, first ring'
    ]
  }
};

const shape = (c) => ({
  id: c.id, scheme: c.scheme, last4: c.last4, expiry: c.expiry,
  holderName: c.holder_name, issuer: c.issuer,
  isDefault: c.is_default, status: c.status
});

/** Luhn, so an obvious typo is caught before the rail charges for the attempt. */
function luhnOk(pan) {
  const digits = String(pan).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d; double = !double;
  }
  return sum % 10 === 0;
}

const schemeOf = (pan) => {
  const d = String(pan).replace(/\D/g, '');
  if (/^4/.test(d)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(d)) return 'mastercard';
  return null;
};

cardsRouter.get('/tiers', (_req, res) => res.json({ tiers: TIERS }));

/**
 * Charge a linked card to fund the account.
 *
 * A card linked and never usable is decoration, so this is the point of
 * linking one. The token is what the rail charges — the PAN was never stored
 * and is not needed here.
 *
 * The money lands the way every other deposit does: a pending transaction the
 * rail settles, not an instant credit. A card can be declined, reversed, or
 * charged back weeks later, and crediting first would mean lending money to
 * anyone with an expired card.
 */
cardsRouter.post('/linked/:id/charge', requireIdempotencyKey,
  validate(z.object({
    accountId: z.string().uuid(),
    amountMinor: z.number().int().min(100, 'Charge GH₵1.00 or more')
  })),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        "SELECT * FROM linked_cards WHERE id=$1 AND customer_id=$2 AND status='active'",
        [req.params.id, req.customer.id]
      );
      const card = rows[0];
      if (!card) throw notFound('No such card');

      const [mm, yy] = String(card.expiry).split('/').map(Number);
      if (new Date(2000 + yy, mm, 1) <= new Date()) {
        await query("UPDATE linked_cards SET status='expired' WHERE id=$1", [card.id]);
        throw badRequest('That card has expired — link a new one');
      }

      const account = await loadAccount(req.body.accountId, req.customer.id);
      const rail = railFor('card');
      const reference = newReference('CRD');

      const { transaction } = await openTransaction({
        account, direction: 'credit', kind: 'deposit', amountMinor: req.body.amountMinor,
        channel: 'card', provider: rail.name,
        counterparty: { name: `${card.scheme.toUpperCase()} •••• ${card.last4}`, token: card.provider_token },
        metadata: { narration: `Top up from ${card.scheme} ending ${card.last4}`, linkedCardId: card.id },
        idempotencyKey: req.get('Idempotency-Key'), reference, status: 'processing'
      });

      /* A tokenised charge, not a hosted checkout: the customer already gave
         us the card, so sending them to a payment page to type it again would
         be theatre. The mock rail settles on its own clock. */
      /* The ledger issues the reference — openTransaction does not take one.
         Quoting our own here meant the rail settled against a reference no
         transaction carried, so the money never arrived. */
      const charged = await (rail.chargeToken
        ? rail.chargeToken({ token: card.provider_token, amountMinor: req.body.amountMinor, reference: transaction.reference })
        : rail.initializeCharge({ amountMinor: req.body.amountMinor, reference: transaction.reference, description: 'Top up' }));

      await query('UPDATE transactions SET provider_ref=$2 WHERE id=$1',
        [transaction.id, charged.providerRef || null]);

      await audit({ ...auditFrom(req), action: 'card.charged', entity: 'transaction', entityId: transaction.id });
      res.status(202).json({
        transaction, reference: transaction.reference,
        card: `${card.scheme.toUpperCase()} •••• ${card.last4}`,
        message: 'Charging the card. Your balance updates when it settles.'
      });
    } catch (err) { next(err); }
  });

cardsRouter.get('/linked', async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM linked_cards WHERE customer_id=$1 AND status='active' ORDER BY is_default DESC, created_at",
      [req.customer.id]
    );
    res.json({ cards: rows.map(shape) });
  } catch (err) { next(err); }
});

cardsRouter.post('/linked',
  validate(z.object({
    pan: z.string().min(13).max(23),
    expiry: z.string().regex(/^(0[1-9]|1[0-2])\/\d{2}$/, 'Expiry looks like 09/28'),
    holderName: z.string().min(2).max(60),
    issuer: z.string().max(60).optional(),
    makeDefault: z.boolean().optional()
  })),
  async (req, res, next) => {
    try {
      const { pan, expiry, holderName, issuer } = req.body;
      if (!luhnOk(pan)) throw badRequest('Check the card number — those digits do not add up');

      const scheme = schemeOf(pan);
      if (!scheme) throw badRequest('We can only link Visa or Mastercard right now');

      const [mm, yy] = expiry.split('/').map(Number);
      const expired = new Date(2000 + yy, mm, 1) <= new Date();
      if (expired) throw badRequest('That card has expired');

      const last4 = String(pan).replace(/\D/g, '').slice(-4);

      /* This is where a real integration tokenises with the acquirer. Until
         Hubtel's card vault is live we mint a local token — the point is that
         nothing downstream ever sees a PAN, so swapping in the real call
         changes this line and nothing else. */
      const providerToken = `tok_${randomUUID().replace(/-/g, '')}`;

      const { rows: existing } = await query(
        "SELECT id FROM linked_cards WHERE customer_id=$1 AND last4=$2 AND expiry=$3 AND status='active'",
        [req.customer.id, last4, expiry]
      );
      if (existing[0]) throw badRequest('That card is already linked');

      const { rows: count } = await query(
        "SELECT count(*)::int AS n FROM linked_cards WHERE customer_id=$1 AND status='active'", [req.customer.id]
      );
      const makeDefault = req.body.makeDefault || count[0].n === 0;
      if (makeDefault) {
        await query('UPDATE linked_cards SET is_default=false WHERE customer_id=$1', [req.customer.id]);
      }

      const { rows } = await query(
        `INSERT INTO linked_cards (customer_id, scheme, last4, expiry, holder_name, issuer, provider_token, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.customer.id, scheme, last4, expiry, holderName, issuer || null, providerToken, makeDefault]
      );
      await audit({ ...auditFrom(req), action: 'card.linked', entity: 'linked_card', entityId: rows[0].id });
      res.status(201).json({ card: shape(rows[0]) });
    } catch (err) { next(err); }
  });

cardsRouter.delete('/linked/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "UPDATE linked_cards SET status='removed' WHERE id=$1 AND customer_id=$2 AND status='active'",
      [req.params.id, req.customer.id]
    );
    if (!rowCount) throw notFound('No such card');
    await audit({ ...auditFrom(req), action: 'card.unlinked', entity: 'linked_card', entityId: req.params.id });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

/** Upgrade the bank's own card. */
cardsRouter.post('/tier',
  validate(z.object({ accountId: z.string().uuid(), tier: z.enum(['classic', 'platinum', 'infinite']) })),
  async (req, res, next) => {
    try {
      const { rows } = await query(
        `UPDATE cards SET tier=$2 WHERE account_id=$1 AND kind='physical' RETURNING *`,
        [req.body.accountId, req.body.tier]
      );
      if (!rows[0]) throw notFound('No card on that account');
      await audit({ ...auditFrom(req), action: 'card.tier_changed', entity: 'card', entityId: rows[0].id });
      res.json({ tier: req.body.tier, benefits: TIERS[req.body.tier].benefits });
    } catch (err) { next(err); }
  });
