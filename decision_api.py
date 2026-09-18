#!/usr/bin/env python3
"""
DECISION SERVICE — the seam between the engine, the customer products and the reviewers.

Until now the three front-ends were islands: the customer apps decided locally, the control
tower read a static export, and nothing carried an escalation to the person who has to clear
it. This service is the shared spine.

    customer products  --POST /api/decisions-->  service  --> queue --> reviewer console
                                                    |
                                                    +--> audit log --> control tower

Standard library only for local use — no setup, no dependencies, in-memory. Run it and open
http://localhost:8765/ — the same HTML files work with or without it, but with it the
escalation a customer triggers appears in the reviewer's queue within a second, and the
reviewer's override comes back as a model-quality signal.

Set DATABASE_URL (Postgres) and every write also lands there, so a restart — a redeploy,
a free-tier host waking from idle — comes back with the same queue and audit log instead
of an empty one. Needs psycopg2-binary; without DATABASE_URL nothing changes.

    python3 decision_api.py [--port 8765] [--seed-queue 12]
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import aibank_engine as engine
except Exception:                                    # service still runs without the engine
    engine = None

DATABASE_URL = os.environ.get("DATABASE_URL")
try:
    import psycopg2
    import psycopg2.extras
except Exception:                                     # service still runs without Postgres
    psycopg2 = None


def db_connect():
    """None unless both DATABASE_URL and psycopg2 are available — every caller already
    treats 'no database' as a normal, supported mode, not an error."""
    if not (DATABASE_URL and psycopg2):
        return None
    conn = psycopg2.connect(DATABASE_URL, sslmode="require")
    conn.autocommit = True
    return conn

CAPACITY_PER_DAY = 120

# SLA in minutes, by the kind of decision a person is being asked to make
SLA = {
    "chat_handover": 2,
    "fraud_confirm": 15,
    "sanctions_l2": 60,
    "credit_adjudication": 240,
    "aml_triage": 1440,
    "doc_review": 480,
}

# which engine use case produces which kind of case for a person
KIND_OF = {
    "retail.chatbot": "chat_handover",
    "cx.complaint_resolution": "chat_handover",
    "retail.fraud_detection": "fraud_confirm",
    "fcc.fraud_ring": "fraud_confirm",
    "fcc.sanctions": "sanctions_l2",
    "fcc.aml": "aml_triage",
    "fcc.sar": "aml_triage",
    "retail.loan_preapproval": "credit_adjudication",
    "credit.scoring": "credit_adjudication",
    "credit.risk_pricing": "credit_adjudication",
    "sme.loan_risk": "credit_adjudication",
    "sme.doc_verification": "doc_review",
    "corp.trade_fraud": "doc_review",
}

QUEUES = {
    "chat_handover": "Contact centre",
    "fraud_confirm": "Fraud operations",
    "sanctions_l2": "Financial crime",
    "credit_adjudication": "Retail credit",
    "aml_triage": "Financial crime",
    "doc_review": "Trade operations",
}


def now() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- pin + otp
# Every screen that moves money goes through here. Standard library only, matching the
# rest of this file: PBKDF2 for PIN hashing, no bcrypt/argon2 dependency.
PBKDF2_ITER = 260_000
OTP_TTL_MINUTES = 5
DEMO_OTP_CODE = "000000"          # DEMO ONLY — every challenge accepts this fixed code so the
                                   # flow can be tested end-to-end with no SMS/email provider.
DEFAULT_PIN = "1234"              # seeded PIN; mustChangePin forces a real one before first use

# Mirrors src/core.js PERSONAL/BUSINESS exactly, so the database starts identical to the
# long-standing demo figures and only diverges once real transactions post.
DEFAULT_ACCOUNTS = {
    "personal": {"holder": "Ama Boateng", "accounts": [
        {"name": "Current account", "num": "•••• 3391", "balance": 4182.60, "type": "current"},
        {"name": "Target savings",  "num": "•••• 7742", "balance": 11500.00, "type": "savings"},
    ]},
    "business": {"holder": "Ama's Kitchen Ltd", "accounts": [
        {"name": "Business current", "num": "•••• 5108", "balance": 38470.15, "type": "current"},
        {"name": "Tax reserve",      "num": "•••• 5109", "balance": 9200.00, "type": "savings"},
    ]},
}


def _hash_pin(pin: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ITER)
    return dk.hex(), salt.hex()


def _verify_pin(pin: str, pin_hash: str, salt_hex: str) -> bool:
    dk, _ = _hash_pin(pin, bytes.fromhex(salt_hex))
    return hmac.compare_digest(dk, pin_hash)


# Where the customer-facing pages actually live. Set BANKING_URL to the custom
# domain once it is pointed at the Node service.
BANKING_URL = os.environ.get("BANKING_URL", "https://ai-digital-bank-api.onrender.com")

class Store:
    """Everything the three products share, behind one lock. self.cases/audit/resolved are
    the working copy every read is served from; when a database is configured, writes also
    go there and __init__ reloads from it, so state survives a restart instead of an
    in-memory dict resetting to empty."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cases: dict[str, dict] = {}
        self.audit: list[dict] = []
        self.resolved: list[dict] = []
        self.accounts: dict[str, dict] = {}
        self.transactions: list[dict] = []
        self.auth: dict[str, dict] = {}
        self.challenges: dict[str, dict] = {}
        self.seq = 4400
        self.tx_seq = 9000
        self.db = db_connect()
        if self.db:
            self._migrate()
            self._load()
        self._seed_accounts()

    # -- database ---------------------------------------------------------------
    def _migrate(self) -> None:
        with self.db.cursor() as cur:
            cur.execute("CREATE TABLE IF NOT EXISTS audit "
                        "(id BIGSERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS cases (ref TEXT PRIMARY KEY, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS resolved "
                        "(id BIGSERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS accounts (ref TEXT PRIMARY KEY, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS transactions "
                        "(id BIGSERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS auth (ref TEXT PRIMARY KEY, data JSONB NOT NULL)")
            cur.execute("CREATE TABLE IF NOT EXISTS challenges (ref TEXT PRIMARY KEY, data JSONB NOT NULL)")

    def _load(self) -> None:
        with self.db.cursor() as cur:
            cur.execute("SELECT data FROM audit ORDER BY id")
            self.audit = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT ref, data FROM cases")
            self.cases = {r[0]: r[1] for r in cur.fetchall()}
            cur.execute("SELECT data FROM resolved ORDER BY id")
            self.resolved = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT ref, data FROM accounts")
            self.accounts = {r[0]: r[1] for r in cur.fetchall()}
            cur.execute("SELECT data FROM transactions ORDER BY id")
            self.transactions = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT ref, data FROM auth")
            self.auth = {r[0]: r[1] for r in cur.fetchall()}
            cur.execute("SELECT ref, data FROM challenges")
            self.challenges = {r[0]: r[1] for r in cur.fetchall()}
        nums = [int(r["ref"].split("-")[1]) for r in self.audit if str(r.get("ref", "")).startswith("DEC-")]
        self.seq = max(nums) if nums else 4400
        tx_nums = [int(t["id"][2:]) for t in self.transactions if str(t.get("id", "")).startswith("TX")]
        self.tx_seq = max(tx_nums) if tx_nums else 9000

    def _seed_accounts(self) -> None:
        """First boot only — mirrors src/core.js's long-standing demo balances so the database
        starts identical to what the UI has always shown, then diverges as real transactions
        post. Also seeds a default PIN that must be changed (with OTP) before first use."""
        with self.lock:
            for customer_id, seed in DEFAULT_ACCOUNTS.items():
                if customer_id not in self.accounts:
                    data = {"customerId": customer_id, "holder": seed["holder"],
                             "accounts": [dict(a) for a in seed["accounts"]]}
                    self.accounts[customer_id] = data
                    self._persist("accounts", customer_id, data)
                if customer_id not in self.auth:
                    pin_hash, pin_salt = _hash_pin(DEFAULT_PIN)
                    auth = {"pinHash": pin_hash, "pinSalt": pin_salt, "pinIterations": PBKDF2_ITER,
                            "mustChangePin": True, "updatedAt": now().isoformat(timespec="seconds")}
                    self.auth[customer_id] = auth
                    self._persist("auth", customer_id, auth)

    def _persist(self, table: str, ref: str, data: dict) -> None:
        if not self.db:
            return
        try:
            with self.db.cursor() as cur:
                cur.execute(f"INSERT INTO {table} (ref, data) VALUES (%s, %s) "
                            f"ON CONFLICT (ref) DO UPDATE SET data = EXCLUDED.data",
                            (ref, psycopg2.extras.Json(data)))
        except Exception as e:                        # a DB hiccup shouldn't take the API down
            print(f"  db write failed ({table}/{ref}): {e}")

    def _delete(self, table: str, ref: str) -> None:
        if not self.db:
            return
        try:
            with self.db.cursor() as cur:
                cur.execute(f"DELETE FROM {table} WHERE ref = %s", (ref,))
        except Exception as e:
            print(f"  db delete failed ({table}/{ref}): {e}")

    # -- writes ---------------------------------------------------------------
    def record(self, d: dict) -> dict:
        """A decision from any product. Escalations become a case for a person."""
        with self.lock:
            self.seq += 1
            ts = now()
            rec = {
                "ts": ts.isoformat(timespec="seconds"),
                "ref": d.get("ref") or f"DEC-{self.seq}",
                "useCase": d.get("useCase", "unknown"),
                "action": d.get("action", "UNKNOWN"),
                "confidence": float(d.get("confidence", 0)),
                "explanation": d.get("explanation", ""),
                "review": bool(d.get("review")),
                "title": d.get("title") or d.get("useCase", "Decision"),
                "customer": d.get("customer", "Ama Boateng"),
                "channel": d.get("channel", "app"),
                "amount": d.get("amount"),
                "evidence": d.get("evidence") or {},
            }
            self.audit.append(rec)
            self._persist("audit", rec["ref"], rec)
            if rec["review"]:
                kind = KIND_OF.get(rec["useCase"], "credit_adjudication")
                sla = SLA[kind]
                case = {
                    **rec,
                    "kind": kind,
                    "queue": QUEUES[kind],
                    "opened": ts.isoformat(timespec="seconds"),
                    "dueBy": (ts + timedelta(minutes=sla)).isoformat(timespec="seconds"),
                    "slaMinutes": sla,
                    "status": "open",
                }
                self.cases[rec["ref"]] = case
                self._persist("cases", rec["ref"], case)
            return rec

    def resolve(self, ref: str, outcome: str, note: str, reviewer: str) -> dict | None:
        """outcome: agree | override | return. An override is the ground truth the
        model never gets from production traffic on its own."""
        with self.lock:
            case = self.cases.pop(ref, None)
            if case is None:
                return None
            case["status"] = outcome
            case["note"] = note
            case["reviewer"] = reviewer
            case["closed"] = now().isoformat(timespec="seconds")
            opened = datetime.fromisoformat(case["opened"])
            case["minutesToClose"] = round((now() - opened).total_seconds() / 60, 1)
            case["breachedSla"] = case["minutesToClose"] > case["slaMinutes"]
            self.resolved.append(case)
            self._delete("cases", ref)
            self._persist("resolved", ref, case)
            return case

    # -- money movement: pin + otp --------------------------------------------
    def create_otp(self, customer_id: str, purpose: str) -> dict:
        with self.lock:
            cid = f"OTP-{uuid.uuid4().hex[:10]}"
            ts = now()
            row = {"id": cid, "customerId": customer_id, "purpose": purpose, "code": DEMO_OTP_CODE,
                   "createdAt": ts.isoformat(timespec="seconds"),
                   "expiresAt": (ts + timedelta(minutes=OTP_TTL_MINUTES)).isoformat(timespec="seconds"),
                   "consumed": False, "stepUpToken": None, "redeemed": False}
            self.challenges[cid] = row
            self._persist("challenges", cid, row)
            return row

    def verify_otp(self, challenge_id: str, code: str) -> dict:
        with self.lock:
            row = self.challenges.get(challenge_id)
            if row is None:
                return {"error": "no such code"}
            if row["consumed"]:
                return {"error": "code already used"}
            if now() > datetime.fromisoformat(row["expiresAt"]):
                return {"error": "code expired"}
            if code != row["code"]:
                return {"error": "incorrect code"}
            row["consumed"] = True
            row["stepUpToken"] = uuid.uuid4().hex
            self._persist("challenges", challenge_id, row)
            return {"stepUpToken": row["stepUpToken"], "purpose": row["purpose"]}

    def _redeem_step_up(self, customer_id: str, purpose: str, token: str) -> dict | None:
        """The verified, unredeemed, unexpired challenge this token belongs to, marked redeemed
        on the way out so the same OTP verification can never authorize two actions."""
        if not token:
            return None
        for row in self.challenges.values():
            if (row.get("stepUpToken") == token and row["customerId"] == customer_id
                    and row["purpose"] == purpose and not row.get("redeemed")):
                if now() > datetime.fromisoformat(row["expiresAt"]):
                    return None
                row["redeemed"] = True
                self._persist("challenges", row["id"], row)
                return row
        return None

    def set_pin(self, customer_id: str, current_pin: str | None, new_pin: str, step_up_token: str) -> dict:
        if not (new_pin.isdigit() and 4 <= len(new_pin) <= 6):
            return {"error": "PIN must be 4-6 digits"}
        with self.lock:
            if self._redeem_step_up(customer_id, "pin_change", step_up_token) is None:
                return {"error": "invalid_step_up"}
            auth = self.auth.get(customer_id)
            if auth and not auth.get("mustChangePin") and current_pin is not None:
                if not _verify_pin(current_pin, auth["pinHash"], auth["pinSalt"]):
                    return {"error": "invalid_pin"}
            pin_hash, pin_salt = _hash_pin(new_pin)
            auth = {"pinHash": pin_hash, "pinSalt": pin_salt, "pinIterations": PBKDF2_ITER,
                    "mustChangePin": False, "updatedAt": now().isoformat(timespec="seconds")}
            self.auth[customer_id] = auth
            self._persist("auth", customer_id, auth)
            return {"ok": True}

    def verify_pin_only(self, customer_id: str, pin: str, step_up_token: str) -> dict:
        """Same must-change-PIN -> PIN -> step-up-token order as commit_transaction, but for
        actions that need proof-of-you without moving any money (reveal card details, raise a
        limit) — no balance touched, no transaction written."""
        with self.lock:
            auth = self.auth.get(customer_id)
            if auth is None or auth.get("mustChangePin"):
                return {"error": "pin_change_required"}
            if not _verify_pin(pin, auth["pinHash"], auth["pinSalt"]):
                return {"error": "invalid_pin"}
            if self._redeem_step_up(customer_id, "verify", step_up_token) is None:
                return {"error": "invalid_step_up"}
            return {"ok": True}

    def open_account(self, customer_id: str, name: str, acct_type: str) -> dict:
        """Opening an account isn't a payment (no PIN/OTP), but it still has to land server-side
        — otherwise a customer's new account could never be the target of a real deposit or
        transfer, since commit_transaction only knows accounts that exist in this list."""
        with self.lock:
            acct = self.accounts.get(customer_id)
            if acct is None:
                return {"error": "no such customer"}
            num = "•••• " + str(1000 + (len(acct["accounts"]) * 4127) % 9000)
            new_account = {"name": name or "New account", "num": num, "balance": 0,
                           "type": acct_type if acct_type in ("current", "savings", "fx") else "current"}
            acct["accounts"].append(new_account)
            self._persist("accounts", customer_id, acct)
            return {"account": new_account, "index": len(acct["accounts"]) - 1, "accounts": acct["accounts"]}

    def get_state(self, customer_id: str) -> dict | None:
        with self.lock:
            acct = self.accounts.get(customer_id)
            if acct is None:
                return None
            auth = self.auth.get(customer_id, {})
            txs = sorted((t for t in self.transactions if t.get("customerId") == customer_id),
                         key=lambda t: t.get("ts", ""), reverse=True)
            return {**acct, "mustChangePin": auth.get("mustChangePin", True), "transactions": txs[:40]}

    def commit_transaction(self, customer_id: str, body: dict) -> dict:
        """Order matters: must-change-PIN, then PIN, then the OTP step-up token, then a
        server-side balance re-check — never trust the client's own arithmetic — all inside
        one lock so nothing can interleave between the check and the write."""
        with self.lock:
            acct = self.accounts.get(customer_id)
            if acct is None:
                return {"error": "no such customer"}
            auth = self.auth.get(customer_id)
            if auth is None or auth.get("mustChangePin"):
                return {"error": "pin_change_required"}
            if not _verify_pin(body.get("pin", ""), auth["pinHash"], auth["pinSalt"]):
                return {"error": "invalid_pin"}
            if self._redeem_step_up(customer_id, "commit", body.get("stepUpToken", "")) is None:
                return {"error": "invalid_step_up"}
            try:
                idx = int(body.get("account", 0))
                account = acct["accounts"][idx]
            except (IndexError, TypeError, ValueError):
                return {"error": "no such account"}
            amount = float(body.get("amount", 0))
            if account["balance"] + amount < 0:
                return {"error": "insufficient_funds"}
            account["balance"] = round(account["balance"] + amount, 2)
            self._persist("accounts", customer_id, acct)

            self.tx_seq += 1
            ts = now()
            tx = {
                "id": f"TX{self.tx_seq}", "customerId": customer_id, "account": idx,
                "ts": ts.isoformat(timespec="seconds"),
                "merchant": body.get("merchant", ""), "amount": amount,
                "category": body.get("category", "Other"),
                "method": body.get("method", "AI-Digital Bank account"), "status": "Completed",
                "ref": "FID" + str((self.tx_seq * 7) % 999999).zfill(6),
                "hash": "0x" + hashlib.sha256(f"{customer_id}{amount}{self.tx_seq}".encode()).hexdigest()[:7],
                "balanceAfter": account["balance"],
            }
            self.transactions.append(tx)
            self._persist("transactions", tx["id"], tx)
            return {"tx": tx, "account": acct}

    # -- reads ----------------------------------------------------------------
    def snapshot(self) -> dict:
        with self.lock:
            t = now()
            queue = []
            for c in self.cases.values():
                due = datetime.fromisoformat(c["dueBy"])
                queue.append({**c,
                              "minutesLeft": round((due - t).total_seconds() / 60, 1),
                              "ageMinutes": round((t - datetime.fromisoformat(c["opened"])).total_seconds() / 60, 1)})
            queue.sort(key=lambda c: c["minutesLeft"])

            by_model: dict[str, dict] = {}
            for r in self.resolved:
                m = by_model.setdefault(r["useCase"], {"agreed": 0, "overridden": 0, "returned": 0})
                m[{"agree": "agreed", "override": "overridden", "return": "returned"}[r["status"]]] += 1
            for m in by_model.values():
                total = m["agreed"] + m["overridden"]
                m["overrideRate"] = round(m["overridden"] / total, 3) if total else None

            return {
                "capacityPerDay": CAPACITY_PER_DAY,
                "queue": queue,
                "open": len(queue),
                "breaching": sum(1 for c in queue if c["minutesLeft"] < 0),
                "clearedToday": len(self.resolved),
                "remainingCapacity": max(0, CAPACITY_PER_DAY - len(self.resolved)),
                "modelQuality": by_model,
                "resolved": self.resolved[-40:],
                "auditCount": len(self.audit),
            }


STORE = Store()


# ---------------------------------------------------------------------------- seeding
def seed_queue(n: int) -> None:
    """Overnight backlog, so a reviewer opening the console at 08:00 sees a real morning."""
    import random
    rng = random.Random(11)
    people = ["Ama Boateng", "Kofi Asare", "Adjoa Nyarko", "Yaw Darko", "Efua Sarpong",
              "Ibrahim Salifu", "Akosua Frimpong", "Kwesi Owusu", "Ama's Kitchen Ltd",
              "Coastal Foods Ltd", "Nana Addo Boakye", "Zainab Mohammed"]
    templates = [
        ("retail.loan_preapproval", "Loan pre-approval",
         "requested {amt} against an affordability cap of {cap}", 0.71, "web"),
        ("credit.scoring", "Thin-file credit grade",
         "no bureau history; alternative-data score is below the automatic band", 0.68, "app"),
        ("fcc.sanctions", "Beneficiary screened",
         "name similarity {sim} against a sanctions and PEP watchlist entry", 0.63, "web"),
        ("retail.fraud_detection", "Payment screened",
         "first payment to a correspondent bank outside Ghana; {amt}; 02:14 local", 0.74, "app"),
        ("retail.chatbot", "Assistant handover",
         "Hausa model {conf} sure it understood the customer, below the 0.70 floor", 0.61, "whatsapp"),
        ("fcc.aml", "Transaction monitoring alert",
         "six deposits of {amt} in four days from unrelated payers", 0.66, "batch"),
        ("sme.doc_verification", "Purchase order unreadable",
         "scan quality below the OCR threshold; amount line could not be read", 0.58, "app"),
    ]
    for i in range(n):
        uc, title, expl, conf, chan = templates[i % len(templates)]
        amt = rng.choice([2450, 8900, 12400, 24800, 41000, 3200])
        conf = round(conf + rng.uniform(-0.06, 0.08), 2)
        d = {
            "useCase": uc, "title": title, "review": True, "confidence": conf,
            "action": "HUMAN_ADJUDICATION", "channel": chan,
            "customer": people[i % len(people)], "amount": amt,
            "explanation": expl.format(amt=f"GHS {amt:,}", cap="GHS 20,100",
                                       sim=f"{rng.uniform(.62,.81):.2f}", conf=f"{conf:.0%}"),
            "evidence": {
                "Credit bureau": rng.randint(430, 760),
                "Debt to income": f"{rng.randint(18, 58)}%",
                "Relationship": f"{rng.randint(1, 11)} years",
                "Prior overrides": rng.choice(["none", "none", "1 in 12 months"]),
            } if "credit" in uc or "loan" in uc else {
                "Channel": chan, "Model version": "v3", "Prior alerts": rng.randint(0, 4),
                "Customer since": 2026 - rng.randint(1, 9),
            },
        }
        rec = STORE.record(d)
        # age the case so SLA clocks look like a real morning
        with STORE.lock:
            c = STORE.cases[rec["ref"]]
            age = rng.randint(1, max(2, int(c["slaMinutes"] * 1.4)))
            opened = now() - timedelta(minutes=age)
            c["opened"] = opened.isoformat(timespec="seconds")
            c["dueBy"] = (opened + timedelta(minutes=c["slaMinutes"])).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------- http
class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):        # keep the console readable
        if "/api/" in self.path:
            print(f"  {self.command} {self.path}")

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        p = urlparse(self.path)
        if p.path == "/api/state":
            return self._send(STORE.snapshot())
        if p.path == "/api/audit":
            n = int(parse_qs(p.query).get("tail", ["40"])[0])
            return self._send({"audit": STORE.audit[-n:]})
        if p.path == "/api/portfolio":
            if engine is None:
                return self._send({"error": "engine not importable"}, 503)
            return self._send({"useCases": [
                {"key": u.key, "name": u.name, "domain": engine.DOMAINS[u.domain].name,
                 "phase": u.phase.value, "quadrant": u.quadrant, "hasAgent": u.has_agent}
                for u in engine.USE_CASES.values()]})
        if p.path == "/api/health":
            return self._send({"ok": True, "engine": engine is not None, "database": STORE.db is not None,
                               "open": len(STORE.cases), "audit": len(STORE.audit)})
        if p.path.startswith("/api/accounts/"):
            customer_id = p.path.split("/")[3] if len(p.path.split("/")) > 3 else ""
            state = STORE.get_state(customer_id)
            if state is None:
                return self._send({"error": f"no such customer {customer_id}"}, 404)
            return self._send(state)
        # This service is the decision engine, not a web front end. The pages
        # live on the banking host, where the API behind them actually exists;
        # serving a second copy here is what sent customers to a login that
        # could never work. Anything that is not /api is sent across.
        if not p.path.startswith("/api"):
            target = BANKING_URL.rstrip("/") + self.path
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        return super().do_GET()

    def do_POST(self):
        p = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._send({"error": "bad json"}, 400)

        if p.path == "/api/decisions":
            return self._send(STORE.record(body), 201)

        if p.path.startswith("/api/cases/") and p.path.endswith("/resolve"):
            ref = p.path.split("/")[3]
            outcome = body.get("outcome")
            if outcome not in ("agree", "override", "return"):
                return self._send({"error": "outcome must be agree, override or return"}, 400)
            case = STORE.resolve(ref, outcome, body.get("note", ""), body.get("reviewer", "unknown"))
            if case is None:
                return self._send({"error": f"no open case {ref}"}, 404)
            return self._send(case)

        if p.path == "/api/otp/request":
            customer_id, purpose = body.get("customerId"), body.get("purpose")
            if not customer_id or purpose not in ("pin_change", "commit", "verify"):
                return self._send({"error": "customerId and a valid purpose are required"}, 400)
            row = STORE.create_otp(customer_id, purpose)
            return self._send({"challengeId": row["id"], "expiresAt": row["expiresAt"],
                               "demoCode": row["code"]}, 201)

        if p.path == "/api/otp/verify":
            result = STORE.verify_otp(body.get("challengeId", ""), body.get("code", ""))
            return self._send(result, 400 if "error" in result else 200)

        if p.path == "/api/pin/set":
            result = STORE.set_pin(body.get("customerId", ""), body.get("currentPin"),
                                    body.get("newPin", ""), body.get("stepUpToken", ""))
            if "error" in result:
                return self._send(result, 401 if result["error"] == "invalid_pin" else 400)
            return self._send(result)

        if p.path == "/api/transactions":
            result = STORE.commit_transaction(body.get("customerId", ""), body)
            if "error" in result:
                status = {"pin_change_required": 403, "invalid_pin": 401, "invalid_step_up": 401,
                          "insufficient_funds": 422}.get(result["error"], 400)
                return self._send(result, status)
            return self._send(result, 201)

        if p.path == "/api/accounts/open":
            result = STORE.open_account(body.get("customerId", ""), body.get("name", ""), body.get("type", "current"))
            if "error" in result:
                return self._send(result, 404)
            return self._send(result, 201)

        if p.path == "/api/pin/verify":
            result = STORE.verify_pin_only(body.get("customerId", ""), body.get("pin", ""),
                                            body.get("stepUpToken", ""))
            if "error" in result:
                status = {"pin_change_required": 403, "invalid_pin": 401,
                          "invalid_step_up": 401}.get(result["error"], 400)
                return self._send(result, status)
            return self._send(result)

        return self._send({"error": "no such endpoint"}, 404)


INDEX = """<!DOCTYPE html><html><head><meta charset="utf-8">
<title>AI-Digital Bank — running</title>
<style>body{font:15px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 24px;color:#17181B}
a{display:block;padding:14px 16px;border:1px solid #E3E5E8;border-radius:10px;margin-bottom:10px;
  text-decoration:none;color:inherit}a:hover{border-color:#14B8AC}b{display:block}
small{color:#71767D}h1{font-size:22px}</style></head><body>
<h1>AI-Digital Bank — services running</h1>
<p><small>Decisions made in the customer products post to this service, escalations land in the
reviewer queue, and the control tower reads the same audit log.</small></p>
<a href="/web.html"><b>AI-Digital Bank Online</b><small>customer · web</small></a>
<a href="/app.html"><b>AI-Digital Bank app</b><small>customer · mobile</small></a>
<a href="/reviewer-console.html"><b>Reviewer console</b><small>staff · the human line</small></a>
<a href="/control-tower.html"><b>AI Control Tower</b><small>staff · portfolio and governance</small></a>
<a href="/api/state"><b>/api/state</b><small>queue, capacity and model-quality signal</small></a>
</body></html>"""


def main():
    # PORT is the convention hosts like Render inject; its presence also means the process
    # is running on someone else's box, so bind every interface instead of just loopback.
    on_a_host = "PORT" in os.environ
    ap = argparse.ArgumentParser(description="AI-Digital Bank decision service")
    ap.add_argument("--host", default="0.0.0.0" if on_a_host else "127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--seed-queue", type=int, default=12,
                    help="overnight cases waiting when the console opens (0 for none)")
    a = ap.parse_args()

    import pathlib
    idx = pathlib.Path("index.html")
    if not idx.exists():          # the built prototype hub wins if it is present
        idx.write_text(INDEX)

    # a restored store already has its overnight backlog — reseeding on top of it would
    # duplicate cases every time this process restarts (a redeploy, an idle host waking up)
    if a.seed_queue and not STORE.cases and not STORE.audit:
        seed_queue(a.seed_queue)

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"AI-Digital Bank decision service on http://{a.host}:{a.port}/")
    print(f"  engine imported : {engine is not None}")
    print(f"  database        : {'connected, ' + str(len(STORE.audit)) + ' records restored' if STORE.db else 'in-memory only'}")
    print(f"  queue seeded    : {len(STORE.cases)} cases waiting")
    print("  ctrl-c to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
