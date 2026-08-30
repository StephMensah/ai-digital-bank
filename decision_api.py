#!/usr/bin/env python3
"""
DECISION SERVICE — the seam between the engine, the customer products and the reviewers.

Until now the three front-ends were islands: the customer apps decided locally, the control
tower read a static export, and nothing carried an escalation to the person who has to clear
it. This service is the shared spine.

    customer products  --POST /api/decisions-->  service  --> queue --> reviewer console
                                                    |
                                                    +--> audit log --> control tower

Standard library only, no dependencies, single process, in-memory. Run it and open
http://localhost:8765/ — the same HTML files work with or without it, but with it the
escalation a customer triggers appears in the reviewer's queue within a second, and the
reviewer's override comes back as a model-quality signal.

    python3 decision_api.py [--port 8765] [--seed-queue 12]
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

try:
    import aibank_engine as engine
except Exception:                                    # service still runs without the engine
    engine = None

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


class Store:
    """Everything the three products share, behind one lock."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.cases: dict[str, dict] = {}
        self.audit: list[dict] = []
        self.resolved: list[dict] = []
        self.seq = 4400

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
            if rec["review"]:
                kind = KIND_OF.get(rec["useCase"], "credit_adjudication")
                sla = SLA[kind]
                self.cases[rec["ref"]] = {
                    **rec,
                    "kind": kind,
                    "queue": QUEUES[kind],
                    "opened": ts.isoformat(timespec="seconds"),
                    "dueBy": (ts + timedelta(minutes=sla)).isoformat(timespec="seconds"),
                    "slaMinutes": sla,
                    "status": "open",
                }
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
            return case

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
            return self._send({"ok": True, "engine": engine is not None,
                               "open": len(STORE.cases), "audit": len(STORE.audit)})
        if p.path == "/":
            self.path = "/index.html"
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

        return self._send({"error": "no such endpoint"}, 404)


INDEX = """<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Fidelity AI bank — running</title>
<style>body{font:15px/1.6 system-ui;max-width:640px;margin:60px auto;padding:0 24px;color:#17181B}
a{display:block;padding:14px 16px;border:1px solid #E3E5E8;border-radius:10px;margin-bottom:10px;
  text-decoration:none;color:inherit}a:hover{border-color:#E87722}b{display:block}
small{color:#71767D}h1{font-size:22px}</style></head><body>
<h1>Fidelity AI bank — services running</h1>
<p><small>Decisions made in the customer products post to this service, escalations land in the
reviewer queue, and the control tower reads the same audit log.</small></p>
<a href="/fidelity-web.html"><b>Fidelity Online</b><small>customer · web</small></a>
<a href="/fidelity-app.html"><b>Fidelity app</b><small>customer · mobile</small></a>
<a href="/reviewer-console.html"><b>Reviewer console</b><small>staff · the human line</small></a>
<a href="/control-tower.html"><b>AI Control Tower</b><small>staff · portfolio and governance</small></a>
<a href="/api/state"><b>/api/state</b><small>queue, capacity and model-quality signal</small></a>
</body></html>"""


def main():
    # PORT is the convention hosts like Render inject; its presence also means the process
    # is running on someone else's box, so bind every interface instead of just loopback.
    on_a_host = "PORT" in os.environ
    ap = argparse.ArgumentParser(description="Fidelity decision service")
    ap.add_argument("--host", default="0.0.0.0" if on_a_host else "127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    ap.add_argument("--seed-queue", type=int, default=12,
                    help="overnight cases waiting when the console opens (0 for none)")
    a = ap.parse_args()

    import pathlib
    idx = pathlib.Path("index.html")
    if not idx.exists():          # the built prototype hub wins if it is present
        idx.write_text(INDEX)

    if a.seed_queue:
        seed_queue(a.seed_queue)

    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Fidelity decision service on http://{a.host}:{a.port}/")
    print(f"  engine imported : {engine is not None}")
    print(f"  queue seeded    : {len(STORE.cases)} cases waiting")
    print("  ctrl-c to stop\n")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
