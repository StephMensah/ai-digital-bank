-- AI Digital Bank :: Postgres schema (idempotent)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- identity ----------
CREATE TABLE IF NOT EXISTS customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  msisdn            text UNIQUE NOT NULL,
  email             text UNIQUE,
  full_name         text NOT NULL,
  date_of_birth     date,
  password_hash     text,
  pin_hash          text,
  kyc_status        text NOT NULL DEFAULT 'pending'
                    CHECK (kyc_status IN ('pending','in_review','verified','rejected')),
  kyc_tier          smallint NOT NULL DEFAULT 0,
  mambu_client_key  text UNIQUE,
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','frozen','closed')),
  risk_rating       text NOT NULL DEFAULT 'low',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('reviewer','supervisor','ops','admin')),
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id   uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('customer','staff')),
  refresh_hash text NOT NULL,
  device       text,
  ip           text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_subject_idx ON sessions(subject_id, subject_type);

-- ---------- accounts ----------
CREATE TABLE IF NOT EXISTS accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  mambu_account_key text UNIQUE,
  account_number    text UNIQUE NOT NULL,
  product_type      text NOT NULL CHECK (product_type IN ('deposit','loan','wallet')),
  product_id        text NOT NULL,
  currency          char(3) NOT NULL DEFAULT 'GHS',
  balance_minor     bigint NOT NULL DEFAULT 0,
  available_minor   bigint NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active',
  synced_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS accounts_customer_idx ON accounts(customer_id);

-- ---------- money movement ----------
CREATE TABLE IF NOT EXISTS transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text UNIQUE NOT NULL,
  idempotency_key  text,
  account_id       uuid REFERENCES accounts(id),
  counterparty     jsonb NOT NULL DEFAULT '{}'::jsonb,
  direction        text NOT NULL CHECK (direction IN ('credit','debit')),
  kind             text NOT NULL CHECK (kind IN ('deposit','withdrawal','transfer','bill','airtime','loan_disbursement','loan_repayment','fee','reversal')),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor        bigint NOT NULL DEFAULT 0,
  currency         char(3) NOT NULL DEFAULT 'GHS',
  channel          text NOT NULL DEFAULT 'app',
  provider         text,
  provider_ref     text,
  mambu_tx_key     text,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','held','processing','posted','failed','reversed')),
  risk_score       numeric(5,2),
  risk_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS tx_idem_idx ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_account_idx ON transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_status_idx ON transactions(status);
CREATE INDEX IF NOT EXISTS tx_provider_ref_idx ON transactions(provider, provider_ref);

-- shadow double-entry ledger; Mambu stays the book of record
CREATE TABLE IF NOT EXISTS ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_id     uuid REFERENCES accounts(id),
  gl_code        text NOT NULL,
  side           char(2) NOT NULL CHECK (side IN ('DR','CR')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       char(3) NOT NULL DEFAULT 'GHS',
  value_date     date NOT NULL DEFAULT current_date,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_tx_idx ON ledger_entries(transaction_id);

-- reliable delivery to Mambu / providers
CREATE TABLE IF NOT EXISTS outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  next_run_at  timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','dead')),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox(status, next_run_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  external_id  text NOT NULL,
  event_type   text,
  payload      jsonb NOT NULL,
  signature_ok boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- ---------- KYC ----------
CREATE TABLE IF NOT EXISTS kyc_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  check_type   text NOT NULL,
  provider     text NOT NULL,
  provider_ref text,
  result       text NOT NULL DEFAULT 'pending',
  score        numeric(5,2),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------- reviewer console ----------
CREATE TABLE IF NOT EXISTS review_cases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_number    bigserial,
  case_type      text NOT NULL CHECK (case_type IN ('transaction','kyc','fraud_alert','dispute','limit_breach')),
  transaction_id uuid REFERENCES transactions(id),
  customer_id    uuid REFERENCES customers(id),
  priority       text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','assigned','escalated','approved','declined','closed')),
  assigned_to    uuid REFERENCES staff_users(id),
  sla_due_at     timestamptz,
  risk_score     numeric(5,2),
  summary        text,
  model_rationale jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision       text,
  decision_note  text,
  decided_by     uuid REFERENCES staff_users(id),
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_queue_idx ON review_cases(status, priority, sla_due_at);

CREATE TABLE IF NOT EXISTS case_events (
  id         bigserial PRIMARY KEY,
  case_id    uuid NOT NULL REFERENCES review_cases(id) ON DELETE CASCADE,
  actor_id   uuid,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- control tower ----------
CREATE TABLE IF NOT EXISTS service_health (
  id         bigserial PRIMARY KEY,
  component  text NOT NULL,
  status     text NOT NULL CHECK (status IN ('up','degraded','down')),
  latency_ms int,
  detail     text,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS health_recent_idx ON service_health(component, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('sev1','sev2','sev3','sev4')),
  component   text,
  status      text NOT NULL DEFAULT 'open',
  opened_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notes       text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  actor_type  text,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  ip          text,
  before_data jsonb,
  after_data  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log(entity, entity_id, created_at DESC);

-- ---------- limits ----------
CREATE TABLE IF NOT EXISTS limit_profiles (
  tier              smallint PRIMARY KEY,
  per_tx_minor      bigint NOT NULL,
  daily_minor       bigint NOT NULL,
  monthly_minor     bigint NOT NULL,
  max_balance_minor bigint NOT NULL
);
INSERT INTO limit_profiles (tier, per_tx_minor, daily_minor, monthly_minor, max_balance_minor)
VALUES (0, 10000, 30000, 100000, 100000),
       (1, 100000, 200000, 600000, 1000000),
       (2, 500000, 1000000, 5000000, 2000000000),
       (3, 5000000, 20000000, 100000000, 100000000000)
ON CONFLICT (tier) DO NOTHING;
