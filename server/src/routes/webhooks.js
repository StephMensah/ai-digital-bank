import { Router } from 'express';
import { query } from '../db/pool.js';
import { providers } from '../providers/index.js';
import { settleTransaction, failTransaction, GL } from '../core/ledger.js';
import { enqueue } from '../core/outbox.js';
import { isConfigured } from '../config.js';
import { logger } from '../lib/logger.js';
import { sha256Hmac, safeEqual } from '../lib/crypto.js';
import { config } from '../config.js';

export const webhooksRouter = Router();

/** Record every callback once, then process. Replays are no-ops. */
async function record({ provider, externalId, eventType, payload, signatureOk }) {
  const { rows } = await query(
    `INSERT INTO webhook_events (provider, external_id, event_type, payload, signature_ok)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [provider, externalId, eventType || null, payload, signatureOk]
  );
  return rows[0]?.id || null;
}

const markProcessed = (id) =>
  id && query('UPDATE webhook_events SET processed_at=now() WHERE id=$1', [id]);

// ---------- MTN MoMo ----------
webhooksRouter.post('/momo', async (req, res, next) => {
  try {
    const body = req.body || {};
    const externalId = body.externalId || body.referenceId || body.financialTransactionId;
    if (!externalId) return res.status(400).json({ received: false });

    const eventId = await record({
      provider: 'mtn_momo', externalId: String(externalId),
      eventType: body.status, payload: body, signatureOk: true
    });
    res.status(200).json({ received: true }); // acknowledge fast; process after

    if (!eventId) return;
    const { rows } = await query(
      'SELECT * FROM transactions WHERE reference=$1 OR provider_ref=$1',
      [String(externalId)]
    );
    const t = rows[0];
    if (!t) return logger.warn({ externalId }, 'momo callback for unknown transaction');

    if (body.status === 'SUCCESSFUL') {
      await settleTransaction({
        transactionId: t.id,
        providerRef: body.financialTransactionId,
        glCounterparty: GL.MOMO_SETTLEMENT
      });
      await postToCore(t);
    } else if (body.status === 'FAILED') {
      await failTransaction({ transactionId: t.id, reason: body.reason?.message || body.reason || 'MoMo declined' });
    }
    await markProcessed(eventId);
  } catch (err) { next(err); }
});

// ---------- Paystack ----------
webhooksRouter.post('/paystack', async (req, res, next) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body);
    const signatureOk = providers.paystack.verifySignature(raw, req.get('x-paystack-signature'));
    if (!signatureOk) {
      logger.warn('rejected paystack webhook with bad signature');
      return res.status(401).json({ received: false });
    }
    const body = req.body || {};
    const reference = body.data?.reference;
    const eventId = await record({
      provider: 'paystack', externalId: String(body.data?.id || reference),
      eventType: body.event, payload: body, signatureOk: true
    });
    res.status(200).json({ received: true });

    if (!eventId || !reference) return;
    const { rows } = await query('SELECT * FROM transactions WHERE reference=$1', [reference]);
    const t = rows[0];
    if (!t) return logger.warn({ reference }, 'paystack callback for unknown transaction');

    if (['charge.success', 'transfer.success'].includes(body.event)) {
      await settleTransaction({
        transactionId: t.id, providerRef: String(body.data?.id),
        glCounterparty: GL.CARD_SETTLEMENT
      });
      await postToCore(t);
    } else if (['charge.failed', 'transfer.failed', 'transfer.reversed'].includes(body.event)) {
      await failTransaction({ transactionId: t.id, reason: body.data?.gateway_response || body.event });
    }
    await markProcessed(eventId);
  } catch (err) { next(err); }
});

// ---------- Hubtel ----------
webhooksRouter.post('/hubtel', async (req, res, next) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body);
    if (!providers.hubtel.verifySignature(raw, req.get('x-hubtel-signature'))) {
      logger.warn('rejected hubtel callback with bad signature');
      return res.status(401).json({ received: false });
    }

    const event = providers.hubtel.readCallback(req.body);
    if (!event.reference) return res.status(400).json({ received: false });

    const eventId = await record({
      provider: 'hubtel', externalId: String(event.providerRef || event.reference),
      eventType: event.status, payload: req.body, signatureOk: true
    });
    res.status(200).json({ received: true }); // acknowledge fast; process after

    if (!eventId) return;
    const { rows } = await query(
      'SELECT * FROM transactions WHERE reference=$1 OR provider_ref=$1', [event.reference]
    );
    const t = rows[0];
    if (!t) return logger.warn({ reference: event.reference }, 'hubtel callback for unknown transaction');

    if (event.status === 'posted') {
      await settleTransaction({
        transactionId: t.id,
        providerRef: event.providerRef,
        // Wallet money settles into the MoMo control account, cards into the card one.
        glCounterparty: /card/i.test(t.channel || '') ? GL.CARD_SETTLEMENT : GL.MOMO_SETTLEMENT
      });
      await postToCore(t);
    } else if (event.status === 'failed') {
      await failTransaction({ transactionId: t.id, reason: event.reason || 'Hubtel declined the payment' });
    }
    await markProcessed(eventId);
  } catch (err) { next(err); }
});

// ---------- Mambu streaming / event webhooks ----------
webhooksRouter.post('/mambu', async (req, res, next) => {
  try {
    const signature = req.get('x-mambu-signature');
    const signatureOk = !config.mambu.webhookSecret
      || safeEqual(sha256Hmac(config.mambu.webhookSecret, req.rawBody || JSON.stringify(req.body)), signature);
    if (!signatureOk) return res.status(401).json({ received: false });

    const body = req.body || {};
    const externalId = body.encodedKey || body.eventId || `${Date.now()}`;
    const eventId = await record({
      provider: 'mambu', externalId: String(externalId),
      eventType: body.event || body.type, payload: body, signatureOk: true
    });
    res.status(200).json({ received: true });
    if (!eventId) return;

    // keep cached balances honest when the core moves money outside our flows
    const accountKey = body.accountKey || body.parentAccountKey || body.encodedKey;
    if (accountKey) {
      await enqueue('mambu.refresh_account', { accountKey });
    }
    await markProcessed(eventId);
  } catch (err) { next(err); }
});

async function postToCore(t) {
  if (!isConfigured.mambu()) return;
  const { rows } = await query('SELECT mambu_account_key FROM accounts WHERE id=$1', [t.account_id]);
  const accountKey = rows[0]?.mambu_account_key;
  if (!accountKey) return;
  await enqueue(t.direction === 'credit' ? 'mambu.post_deposit' : 'mambu.post_withdrawal', {
    transactionId: t.id, accountKey, amountMinor: Number(t.amount_minor), reference: t.reference
  });
}
