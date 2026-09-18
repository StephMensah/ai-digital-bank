# AI Digital Bank — platform

JavaScript front ends, a Node API, Postgres, and a Mambu-backed core.
Python keeps the models and automations; this service calls them over HTTP.

## Shape

```
web/                     served as static files by the API (same origin, no CORS)
  index.html             marketing site
  web.html               web banking
  app.html               mobile app shell
  reviewer-console.html  fraud / KYC decisioning
  control-tower.html     operations
  assets/js/adb-sdk.js   one client for all five pages

server/
  src/core/mambu.js      Mambu API v2 client (apikey + Accept header, idempotency)
  src/core/ledger.js     holds, settlement, shadow double-entry ledger
  src/core/outbox.js     at-least-once delivery to the core with backoff
  src/providers/         Hubtel, MTN MoMo, Paystack, GhIPSS GIP, identity/KYC
  src/services/risk.js   feature assembly + call to the Python model, rules fallback
  src/routes/            auth, accounts, payments, transfers, kyc, reviewer, tower, webhooks, ai
  src/db/schema.sql      the whole database
```

## How money moves

1. A request arrives with an `Idempotency-Key`. Replays return the original result.
2. Risk scores it. `allow` proceeds, `review` opens a reviewer case and holds the funds,
   `decline` stops it. If the Python service is down, deterministic rules take over so
   payments do not stall on a model outage.
3. Funds are reserved against `available_minor` inside one transaction.
4. The rail is called — Hubtel for wallets and cards (MTN MoMo direct and
   Paystack stay wired as fallbacks if Hubtel is not configured), GhIPSS GIP for interbank (name enquiry
   first, and its session id is quoted on the transfer), Paystack for cards.
   If GhIPSS is not configured, bank transfers fall back to Paystack.
5. The provider webhook settles the transaction, writes ledger lines, and queues the
   posting to Mambu through the outbox.
6. Mambu is the book of record. `POST /accounts/:id/sync` and the reconciliation view
   in the control tower surface any drift.

Money is stored as integer minor units (pesewas). Never floats.

## Run it locally

```bash
cd server
cp ../.env.example .env && edit .env        # DATABASE_URL at minimum
npm install
npm run migrate                              # applies schema.sql, seeds limit tiers
BOOTSTRAP_ADMIN_EMAIL=you@pokz.com BOOTSTRAP_ADMIN_PASSWORD='...' npm run migrate
npm run dev
```

Then open http://localhost:10000/index.html.

## Deploy to Render

`render.yaml` provisions the Postgres instance and the web service together.
Push the repo, point Render at it as a Blueprint, then fill the `sync: false`
secrets in the dashboard. `buildCommand` runs the migration on every deploy;
`schema.sql` is idempotent so this is safe to repeat.

## Webhooks to register

| Provider | URL |
|---|---|
| MTN MoMo | `POST /api/v1/webhooks/momo` |
| Paystack | `POST /api/v1/webhooks/paystack` |
| Mambu    | `POST /api/v1/webhooks/mambu` |

Paystack and Mambu callbacks are signature-checked. Every callback is stored once
in `webhook_events`, so replays are harmless.

## What the Python service must expose

| Route | Purpose |
|---|---|
| `POST /score/transaction` | returns `{ score: 0-100, reasons: [], model_version }` in under 2.5s |
| `POST /automations/insights` | returns `{ narrative }` from spend and trend aggregates |
| `POST /automations/assist` | the in-app assistant |

Set `PYTHON_SERVICE_URL` and `PYTHON_SERVICE_TOKEN` to wire it up. Leave them blank
and the bank runs on rules alone.

## Security notes

- Passwords and PINs use scrypt with per-secret salts; no native build step.
- Access tokens last 15 minutes; staff and customer tokens are separate types and
  cannot be used across areas.
- Every reviewer decision and staff action writes to `audit_log`.
- Logs redact authorization headers, PINs, card data and OTPs.
