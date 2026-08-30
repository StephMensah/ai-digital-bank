#!/usr/bin/env python3
"""
AI-FIRST BANK ENGINE  -  executable prototype of the Strategic AI Banking Framework
AI-Digital Bank Ghana / McKinsey adaptation (deck dated 27 August 2026)

This is a runnable skeleton of the "AI Control Tower" described on slide 14: it holds
the whole use-case portfolio from slides 9-10, gates every use case through governance
(slides 14-16), routes live banking events to domain agents (slide 23-24 capability
stack), keeps an immutable audit trail, tracks value, and monitors drift.

Every agent's inference is a deterministic stub. Real models plug in at Agent.infer()
via the `endpoint` attribute (Azure ML / DataRobot / H2O / Neo4j / Rasa per Appendix I).

Usage
  python3 aibank_engine.py run [--days 5] [--phase 2] [--seed 7]
  python3 aibank_engine.py portfolio
  python3 aibank_engine.py roadmap
  python3 aibank_engine.py dpia retail.chatbot
  python3 aibank_engine.py audit --tail 15
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Callable

CCY = "GHS"

# ==========================================================================================
# SECTION 1 - REGISTRY: strategic business domains and sub-functional domains (slides 9, 10,
#             22, 30). This is the single source of truth the control tower governs.
# ==========================================================================================


class Group(str, Enum):
    CUSTOMER_FACING = "Customer Facing Systems"
    SUPPORTING = "Supporting Systems"


class Approach(str, Enum):
    IN_HOUSE = "In-House"
    HYBRID = "Hybrid"
    OUTSOURCED = "Outsourced"


class Phase(int, Enum):
    FOUNDATION = 1  # 0-6 months
    BUILD = 2       # 6-18 months
    OPTIMIZE = 3    # 18-30 months
    SCALE = 4       # 30+ months

    @property
    def window(self) -> str:
        return {1: "0-6 months", 2: "6-18 months", 3: "18-30 months", 4: "30+ months"}[self.value]

    @property
    def label(self) -> str:
        return {1: "Foundation", 2: "Build", 3: "Optimize", 4: "Scale"}[self.value]


@dataclass(frozen=True)
class Domain:
    key: str
    name: str
    group: Group
    phase: Phase
    approach: Approach
    hosting: str
    frameworks: tuple[str, ...]


DOMAINS: dict[str, Domain] = {
    d.key: d
    for d in [
        Domain("retail", "Retail Banking", Group.CUSTOMER_FACING, Phase.FOUNDATION,
               Approach.IN_HOUSE, "Azure Cloud",
               ("Rasa NLU", "TensorFlow", "FastAPI", "Azure ML", "LightGBM")),
        Domain("cx", "Customer Experience", Group.CUSTOMER_FACING, Phase.FOUNDATION,
               Approach.HYBRID, "Azure, AWS",
               ("Azure Cognitive Services", "BERT", "RoBERTa", "Google Cloud NLP")),
        Domain("credit", "Credit Risk", Group.CUSTOMER_FACING, Phase.FOUNDATION,
               Approach.HYBRID, "Azure Cloud",
               ("DataRobot AutoML", "XGBoost", "LightGBM", "Scikit-learn")),
        Domain("sme", "SME Banking", Group.CUSTOMER_FACING, Phase.BUILD,
               Approach.HYBRID, "AWS, Azure",
               ("Tesseract OCR", "Prophet", "PyTorch", "LightGBM")),
        Domain("fcc", "Financial Crime & Compliance", Group.SUPPORTING, Phase.BUILD,
               Approach.OUTSOURCED, "Azure, Google Cloud",
               ("H2O AutoML", "SAS Viya", "FuzzyWuzzy", "IBM OpenScale")),
        Domain("ops", "Operations", Group.SUPPORTING, Phase.BUILD,
               Approach.IN_HOUSE, "Azure, AWS",
               ("UiPath StudioX", "Tesseract OCR", "Prophet", "PyCaret")),
        Domain("tech", "Technology", Group.SUPPORTING, Phase.BUILD,
               Approach.HYBRID, "Azure, AWS",
               ("Prometheus", "Grafana", "ELK Stack", "Azure Sentinel")),
        Domain("finance", "Finance", Group.SUPPORTING, Phase.OPTIMIZE,
               Approach.HYBRID, "IBM Cloud",
               ("SAP HANA ML", "Oracle AI", "TimeGPT", "Azure ML Forecasting")),
        Domain("legal", "Legal", Group.SUPPORTING, Phase.OPTIMIZE,
               Approach.OUTSOURCED, "AWS, Google Cloud",
               ("BERT-based NLP", "clause extraction pipelines", "IBM Watson NLP")),
        Domain("marketing", "Marketing & Sales", Group.CUSTOMER_FACING, Phase.OPTIMIZE,
               Approach.HYBRID, "IBM Cloud",
               ("Salesforce Einstein", "Google Cloud AI", "Adobe Sensei", "PyCaret")),
        Domain("corp", "Corporate Banking", Group.CUSTOMER_FACING, Phase.OPTIMIZE,
               Approach.HYBRID, "IBM Cloud",
               ("Neo4j Graph Data Science", "spaCy", "NLTK", "Prophet", "PyTorch")),
    ]
}


@dataclass
class UseCase:
    """A sub-functional domain from slide 9, enriched with everything the control tower
    needs to gate it (slides 11, 14-16) and everything the runtime needs to execute it."""
    key: str
    name: str
    domain: str
    scenario: str
    impact: int          # 1-5, business impact axis of slide 11
    feasibility: int     # 1-5, technical feasibility axis of slide 11
    personal_data: bool = False        # triggers DPIA (slide 15)
    automated_decision: bool = False   # triggers explainability + adverse-action review
    value_per_event: float = 0.0       # GHS captured per automated decision
    phase_override: Phase | None = None
    # governance state, mutated by the control tower
    dpia_ref: str | None = None
    bias_tested: bool = False
    stress_tested: bool = False
    explainer: str | None = None
    admitted: bool = False
    blocked_reason: str | None = None

    @property
    def phase(self) -> Phase:
        return self.phase_override or DOMAINS[self.domain].phase

    @property
    def quadrant(self) -> str:
        hi_i, hi_f = self.impact >= 4, self.feasibility >= 4
        if hi_i and hi_f:
            return "DO NOW"
        if hi_i and not hi_f:
            return "INVEST / RE-PLATFORM"
        if not hi_i and hi_f:
            return "QUICK WIN"
        return "DEFER"

    @property
    def has_agent(self) -> bool:
        return self.key in AGENT_REGISTRY


def _uc(*a, **kw) -> UseCase:
    return UseCase(*a, **kw)


USE_CASES: dict[str, UseCase] = {u.key: u for u in [
    # ---- Retail Banking -----------------------------------------------------------------
    _uc("retail.fraud_detection", "Fraud Detection for Retail Transactions", "retail",
        "Real-time anomaly detection for debit/credit card transactions",
        impact=5, feasibility=4, personal_data=True, automated_decision=True,
        value_per_event=180.0),
    _uc("retail.personalized_offers", "Personalized Product Recommendations", "retail",
        "Suggest loan top-ups for customers with growing balances",
        impact=4, feasibility=4, personal_data=True, value_per_event=42.0),
    _uc("retail.loan_preapproval", "Loan Pre-Approval & Instant Credit Scoring", "retail",
        "Instant credit scoring report via mobile app",
        impact=5, feasibility=3, personal_data=True, automated_decision=True,
        value_per_event=95.0),
    _uc("retail.spending_insights", "Customer Spending Insights", "retail",
        "Monthly savings tips generated and sent to customers",
        impact=3, feasibility=5, personal_data=True, value_per_event=8.0),
    _uc("retail.chatbot", "Multilingual Chatbot & Virtual Assistant", "retail",
        "Multilingual AI chatbot on WhatsApp / USSD / app",
        impact=4, feasibility=4, personal_data=True, value_per_event=22.0),
    _uc("retail.segmentation", "Customer Segmentation", "retail",
        "Behavioural segmentation for campaign targeting",
        impact=3, feasibility=4, personal_data=True, value_per_event=6.0),
    # ---- Customer Experience ------------------------------------------------------------
    _uc("cx.complaint_resolution", "Complaint Resolution Automation", "cx",
        "Auto-triage and resolve tier-1 complaints",
        impact=4, feasibility=4, personal_data=True, value_per_event=35.0),
    _uc("cx.voc", "Voice of the Customer Analysis", "cx",
        "Sentiment and NPS prediction across channels",
        impact=3, feasibility=4, personal_data=True, value_per_event=11.0),
    _uc("cx.retention", "Customer Retention Modeling", "cx",
        "Churn propensity scoring with next-best-action",
        impact=4, feasibility=3, personal_data=True, value_per_event=140.0),
    _uc("cx.service_quality", "Service Quality Prediction", "cx",
        "Predict SLA breaches before they happen", impact=3, feasibility=3),
    # ---- Credit Risk ---------------------------------------------------------------------
    _uc("credit.scoring", "AI Credit Scoring Models", "credit",
        "Thin-file credit scoring using alternative data",
        impact=5, feasibility=3, personal_data=True, automated_decision=True,
        value_per_event=260.0),
    _uc("credit.early_warning", "Early Warning Systems", "credit",
        "Predict deterioration 90 days ahead of default",
        impact=5, feasibility=3, personal_data=True, value_per_event=420.0),
    _uc("credit.risk_pricing", "Risk-Based Pricing", "credit",
        "Price loans to the borrower's modelled risk",
        impact=4, feasibility=3, personal_data=True, automated_decision=True,
        value_per_event=210.0),
    _uc("credit.collections", "Collections Optimization", "credit",
        "Optimise contact channel, timing and treatment",
        impact=4, feasibility=4, personal_data=True, value_per_event=75.0),
    _uc("credit.stress_testing", "Stress Testing", "credit",
        "Portfolio stress scenarios for BoG submissions", impact=4, feasibility=2),
    # ---- SME Banking -----------------------------------------------------------------------
    _uc("sme.loan_risk", "Loan Risk Profiling", "sme",
        "SME credit scoring enriched with trade data",
        impact=5, feasibility=3, personal_data=True, automated_decision=True,
        value_per_event=310.0),
    _uc("sme.doc_verification", "Automated Document Verification", "sme",
        "OCR for LPO and invoice validation",
        impact=4, feasibility=4, personal_data=True, value_per_event=48.0),
    _uc("sme.cashflow", "Cash Flow Forecasting", "sme",
        "Predict seasonal working capital needs",
        impact=4, feasibility=4, value_per_event=130.0),
    _uc("sme.trade_finance", "Trade Finance Risk Analytics", "sme",
        "Detect fraudulent shipping patterns", impact=4, feasibility=2),
    _uc("sme.segmentation", "SME Customer Segmentation", "sme",
        "Identify high-growth SMEs for priority servicing", impact=3, feasibility=4),
    # ---- Financial Crime & Compliance --------------------------------------------------------
    _uc("fcc.aml", "AML Transaction Monitoring", "fcc",
        "AI triages suspicious transactions ahead of analyst review",
        impact=5, feasibility=4, personal_data=True, value_per_event=290.0),
    _uc("fcc.sanctions", "Sanctions & PEP Screening", "fcc",
        "Fuzzy matching against PEP and sanctions watchlists",
        impact=5, feasibility=4, personal_data=True, value_per_event=115.0),
    _uc("fcc.fraud_ring", "Fraud Ring Detection", "fcc",
        "Network graph analysis over accounts and devices",
        impact=5, feasibility=3, personal_data=True, automated_decision=True,
        value_per_event=640.0),
    _uc("fcc.sar", "Suspicious Activity Reporting Automation", "fcc",
        "Auto-draft SARs for FIC submission",
        impact=4, feasibility=3, personal_data=True, value_per_event=180.0),
    _uc("fcc.cyber_threat", "Cybersecurity Threat Detection", "fcc",
        "Detect phishing campaigns targeting customers", impact=4, feasibility=4),
    # ---- Corporate Banking --------------------------------------------------------------------
    _uc("corp.liquidity", "Liquidity Management Predictions", "corp",
        "Corporate treasury cash forecasting",
        impact=4, feasibility=3, value_per_event=520.0),
    _uc("corp.trade_fraud", "Trade Fraud Detection", "corp",
        "Detect forged bills of lading",
        impact=5, feasibility=2, value_per_event=1250.0),
    _uc("corp.portfolio_risk", "Credit Portfolio Risk Monitoring", "corp",
        "Early warning for corporate exposures", impact=5, feasibility=3),
    _uc("corp.relationship", "Relationship Health Scoring", "corp",
        "Client engagement and wallet-share tracking", impact=3, feasibility=4),
    _uc("corp.cross_sell", "Corporate Product Cross-Selling", "corp",
        "Treasury / FX recommendation engine", impact=4, feasibility=3),
    # ---- Operations -------------------------------------------------------------------------
    _uc("ops.document_processing", "Document Processing Automation", "ops",
        "Straight-through processing of account and KYC packs",
        impact=4, feasibility=5, personal_data=True, value_per_event=26.0),
    _uc("ops.back_office", "Back-Office Automation", "ops",
        "Reconciliation and exception handling", impact=4, feasibility=4),
    _uc("ops.cash_management", "Cash Management Optimization", "ops",
        "ATM and branch cash forecasting", impact=3, feasibility=4),
    _uc("ops.branch_allocation", "Branch Resource Allocation", "ops",
        "Staff scheduling against predicted footfall", impact=3, feasibility=4),
    # ---- Technology --------------------------------------------------------------------------
    _uc("tech.aiops", "IT Operations Automation (AIOps)", "tech",
        "Predict and auto-remediate infrastructure incidents",
        impact=4, feasibility=4, value_per_event=340.0),
    _uc("tech.api_health", "API & System Health Monitoring", "tech",
        "Anomaly detection across the API estate", impact=3, feasibility=5),
    _uc("tech.cyber_ai", "Cybersecurity AI", "tech",
        "SIEM-integrated threat detection and response", impact=5, feasibility=3),
    _uc("tech.cloud_cost", "Cloud Resource Optimization", "tech",
        "FinOps rightsizing across Azure / AWS / IBM", impact=3, feasibility=4),
    # ---- Finance / Legal / Marketing -------------------------------------------------------
    _uc("finance.forecasting", "Budgeting & Forecasting", "finance",
        "Rolling revenue and cost forecasts", impact=4, feasibility=3),
    _uc("finance.cost_opt", "Cost Optimization", "finance",
        "Spend analytics and leakage detection", impact=3, feasibility=4),
    _uc("legal.contract_intel", "Contract Intelligence", "legal",
        "Clause extraction and obligation tracking", impact=3, feasibility=3),
    _uc("legal.privacy", "Data Privacy & Governance", "legal",
        "Automated DPIA tracking and retention enforcement",
        impact=4, feasibility=3, phase_override=Phase.FOUNDATION),
    _uc("marketing.campaign", "Campaign Optimization", "marketing",
        "Budget allocation across channels", impact=3, feasibility=4),
    _uc("marketing.lead_scoring", "Lead Scoring", "marketing",
        "Rank inbound leads by conversion propensity", impact=3, feasibility=4),
]}


# ==========================================================================================
# SECTION 2 - GOVERNANCE: the AI Control Tower (slide 14), gates (slides 15-16), audit trail
# ==========================================================================================


class Verdict(str, Enum):
    SCALE = "SCALE"
    PIVOT = "PIVOT"
    SUNSET = "SUNSET"
    HOLD = "HOLD"


@dataclass
class AuditEvent:
    """Immutable regulator-facing record. One per automated decision."""
    ts: str
    event_id: str
    use_case: str
    model_version: str
    action: str
    confidence: float
    explanation: str
    data_categories: tuple[str, ...]
    human_review: bool

    def as_json(self) -> str:
        return json.dumps(self.__dict__, separators=(",", ":"))


class AuditLog:
    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def record(self, ev: AuditEvent) -> None:
        self._events.append(ev)

    def tail(self, n: int) -> list[AuditEvent]:
        return self._events[-n:]

    def __len__(self) -> int:
        return len(self._events)


Gate = Callable[[UseCase], tuple[bool, str]]


def gate_strategic_alignment(uc: UseCase) -> tuple[bool, str]:
    """Slide 20: does it align to the adoption phase and strategy?"""
    if uc.impact + uc.feasibility < 5:
        return False, "below strategic threshold (impact+feasibility < 5)"
    return True, "aligned to bank-wide AI strategy"


def gate_dpia(uc: UseCase) -> tuple[bool, str]:
    """Slide 15: personal data processing requires a completed DPIA."""
    if uc.personal_data and not uc.dpia_ref:
        return False, "DPIA required and not completed (Ghana Data Protection Act 843)"
    return True, f"DPIA {uc.dpia_ref}" if uc.dpia_ref else "no personal data processed"


def gate_model_risk(uc: UseCase) -> tuple[bool, str]:
    """Slide 16 #02: validation, stress testing, bias detection."""
    missing = [n for n, ok in (("bias test", uc.bias_tested),
                               ("stress test", uc.stress_tested)) if not ok]
    if missing:
        return False, "model risk validation incomplete: " + ", ".join(missing)
    return True, "validated, bias-tested, stress-tested"


def gate_explainability(uc: UseCase) -> tuple[bool, str]:
    """Slide 16 #04: automated decisions affecting customers must be explainable."""
    if uc.automated_decision and not uc.explainer:
        return False, "automated customer decision without an explainer (SHAP/LIME)"
    return True, uc.explainer or "not an automated customer decision"


def gate_hosting(uc: UseCase) -> tuple[bool, str]:
    """Slide 22: approved hosting per domain; data residency for personal data."""
    host = DOMAINS[uc.domain].hosting
    return True, f"approved hosting: {host}"


GATES: tuple[tuple[str, Gate], ...] = (
    ("Strategic Alignment", gate_strategic_alignment),
    ("Data Protection (DPIA)", gate_dpia),
    ("Model Risk Management", gate_model_risk),
    ("Explainability & Fairness", gate_explainability),
    ("Security & Hosting", gate_hosting),
)


class ControlTower:
    """Slide 14. Owns the portfolio, admits use cases, tracks ROI, decides scale/pivot/sunset."""

    ESCALATION_CAPACITY_PER_DAY = 120   # human reviewers available bank-wide
    DRIFT_TOLERANCE = 0.06

    def __init__(self, portfolio: dict[str, UseCase], audit: AuditLog) -> None:
        self.portfolio = portfolio
        self.audit = audit
        self.gate_results: dict[str, list[tuple[str, bool, str]]] = {}
        self.value_captured: dict[str, float] = defaultdict(float)
        self.decisions: dict[str, int] = defaultdict(int)
        self.escalations: dict[str, int] = defaultdict(int)
        self.confidence_window: dict[str, deque] = defaultdict(lambda: deque(maxlen=400))
        self.baseline_confidence: dict[str, float] = {}

    # -- governance ------------------------------------------------------------------------
    def certify(self, uc: UseCase) -> None:
        """Stand-in for the real assurance workflow: DPIA, validation, explainer selection.
        In production these flags are set by evidence in the model registry, never by code."""
        if uc.personal_data:
            uc.dpia_ref = f"DPIA-{uc.key.upper().replace('.', '-')}-2026"
        uc.bias_tested = True
        uc.stress_tested = True
        if uc.automated_decision:
            uc.explainer = "SHAP (IBM OpenScale)"

    def admit(self, uc: UseCase, up_to_phase: Phase) -> bool:
        results = [(name, *gate(uc)) for name, gate in GATES]
        self.gate_results[uc.key] = [(n, ok, why) for n, ok, why in results]
        failed = [why for _, ok, why in results if not ok]
        if failed:
            uc.admitted, uc.blocked_reason = False, failed[0]
            return False
        if uc.phase.value > up_to_phase.value:
            uc.admitted, uc.blocked_reason = False, f"scheduled for Phase {uc.phase.value} ({uc.phase.window})"
            return False
        if not uc.has_agent:
            uc.admitted, uc.blocked_reason = False, "no agent implemented yet (registered in portfolio)"
            return False
        uc.admitted, uc.blocked_reason = True, None
        return True

    # -- runtime accounting ------------------------------------------------------------------
    def observe(self, decision: "Decision") -> None:
        self.decisions[decision.use_case] += 1
        self.confidence_window[decision.use_case].append(decision.confidence)
        if decision.escalated:
            self.escalations[decision.use_case] += 1
        else:
            self.value_captured[decision.use_case] += decision.value
        if decision.use_case not in self.baseline_confidence and \
                len(self.confidence_window[decision.use_case]) == 50:
            self.baseline_confidence[decision.use_case] = \
                sum(self.confidence_window[decision.use_case]) / 50

    def drift_alerts(self) -> list[tuple[str, float, float]]:
        alerts = []
        for key, base in self.baseline_confidence.items():
            window = list(self.confidence_window[key])[-100:]
            if len(window) < 50:
                continue
            recent = sum(window) / len(window)
            if base - recent > self.DRIFT_TOLERANCE:
                alerts.append((key, base, recent))
        return sorted(alerts, key=lambda t: t[1] - t[2], reverse=True)

    def review(self, key: str) -> tuple[Verdict, str]:
        """Slide 14: decide which initiatives to scale, pivot, or sunset."""
        n = self.decisions[key]
        if n == 0:
            return Verdict.HOLD, "no production traffic"
        esc_rate = self.escalations[key] / n
        value = self.value_captured[key]
        drifting = any(k == key for k, _, _ in self.drift_alerts())
        if drifting:
            return Verdict.PIVOT, f"confidence drift beyond {self.DRIFT_TOLERANCE:.0%} tolerance - retrain"
        if esc_rate > 0.45:
            return Verdict.PIVOT, f"{esc_rate:.0%} of decisions escalated - automation thesis not met"
        if value < 5_000 and n > 200:
            return Verdict.SUNSET, f"only {CCY} {value:,.0f} captured over {n:,} decisions"
        if esc_rate < 0.25 and value > 50_000:
            return Verdict.SCALE, f"{CCY} {value:,.0f} captured, {1 - esc_rate:.0%} straight-through"
        return Verdict.HOLD, f"{CCY} {value:,.0f} captured, monitoring"


# ==========================================================================================
# SECTION 3 - AGENT RUNTIME: the decision-making layer of the capability stack (slide 23-24)
# ==========================================================================================


@dataclass
class Event:
    """Anything the bank has to react to: a swipe, an application, a message, a document."""
    id: str
    type: str
    ts: datetime
    payload: dict[str, Any]


@dataclass
class Decision:
    use_case: str
    action: str
    confidence: float
    explanation: str
    value: float
    escalated: bool
    reason_escalated: str | None = None


AGENT_REGISTRY: dict[str, type["Agent"]] = {}


def agent(key: str):
    def deco(cls):
        cls.use_case_key = key
        AGENT_REGISTRY[key] = cls
        return cls
    return deco


class Agent:
    """Base class. Replace infer() with a real call to the endpoint named below."""
    use_case_key: str = ""
    model_version: str = "0.1.0-stub"
    endpoint: str = "<not wired>"
    confidence_floor: float = 0.75
    data_categories: tuple[str, ...] = ()
    degrades: bool = False   # simulate a model that decays, to exercise drift monitoring

    def __init__(self, uc: UseCase, rng: random.Random) -> None:
        self.uc = uc
        self.rng = rng
        self._calls = 0

    # ---- override this ---------------------------------------------------------------------
    def infer(self, ev: Event) -> tuple[str, float, str, bool]:
        """Return (action, confidence, explanation, adverse_to_customer)."""
        raise NotImplementedError

    # ---- runtime wrapper ---------------------------------------------------------------------
    def handle(self, ev: Event, tower: ControlTower) -> Decision:
        self._calls += 1
        action, conf, why, adverse = self.infer(ev)
        if self.degrades:
            conf = max(0.30, conf - min(0.14, self._calls * 0.00035))
        escalated, reason = False, None
        if conf < self.confidence_floor:
            escalated, reason = True, f"confidence {conf:.2f} below floor {self.confidence_floor:.2f}"
        elif adverse and self.uc.automated_decision:
            escalated, reason = True, "adverse automated decision - human adjudication required"
        d = Decision(self.uc.key, action, round(conf, 3), why,
                     0.0 if escalated else self.uc.value_per_event, escalated, reason)
        tower.audit.record(AuditEvent(
            ts=ev.ts.isoformat(timespec="seconds"), event_id=ev.id, use_case=self.uc.key,
            model_version=self.model_version, action=action, confidence=round(conf, 3),
            explanation=why, data_categories=self.data_categories, human_review=escalated))
        tower.observe(d)
        return d


# ---- Retail --------------------------------------------------------------------------------

@agent("retail.fraud_detection")
class FraudAgent(Agent):
    endpoint = "azureml://aidigitalbank/retail-fraud-lgbm/v3:score"
    confidence_floor = 0.80
    data_categories = ("account", "transaction", "device", "geolocation")

    def infer(self, ev):
        amt = ev.payload["amount"]
        foreign = ev.payload["foreign"]
        night = ev.payload["hour"] < 5
        score = 0.05 + 0.35 * foreign + 0.20 * night + min(0.35, amt / 60_000)
        score += self.rng.uniform(-0.08, 0.08)
        if score > 0.55:
            return ("BLOCK_AND_STEP_UP", 0.62 + score / 3,
                    f"amount {amt:,.0f}, foreign={foreign}, night={night}", True)
        return ("APPROVE", 0.96 - score / 2, "within customer's behavioural envelope", False)


@agent("retail.personalized_offers")
class OfferAgent(Agent):
    endpoint = "azureml://aidigitalbank/personalizer/v2:rank"
    confidence_floor = 0.55
    data_categories = ("account", "balance history", "product holding")

    def infer(self, ev):
        growth = ev.payload["balance_growth"]
        if growth > 0.12:
            return ("OFFER_LOAN_TOPUP", 0.60 + min(0.35, growth), f"balance +{growth:.0%} over 90d", False)
        return ("NO_OFFER", 0.82, "no eligible trigger", False)


@agent("retail.loan_preapproval")
class PreApprovalAgent(Agent):
    endpoint = "datarobot://aidigitalbank/thin-file-scorecard/v5:predict"
    confidence_floor = 0.78
    data_categories = ("identity", "income", "credit bureau", "transaction")

    def infer(self, ev):
        score = ev.payload["bureau_score"]
        dti = ev.payload["dti"]
        pd_ = max(0.01, min(0.9, (750 - score) / 900 + dti / 3))
        if pd_ > 0.28:
            return ("DECLINE", 0.70 + self.rng.uniform(0, 0.22),
                    f"PD {pd_:.1%} above appetite; bureau {score}, DTI {dti:.0%}", True)
        limit = round((1 - pd_) * ev.payload["income"] * 4, -2)
        return (f"PRE_APPROVE_{CCY}_{limit:,.0f}", 0.94 - pd_ / 2,
                f"PD {pd_:.1%}, affordability-capped at 4x monthly income", False)


@agent("retail.chatbot")
class ChatbotAgent(Agent):
    endpoint = "rasa://aidigitalbank/multilingual-nlu/v4:parse"
    confidence_floor = 0.70
    data_categories = ("identity", "contact", "conversation")

    INTENTS = ("balance_enquiry", "card_block", "branch_locator",
               "loan_enquiry", "complaint", "airtime_topup")

    def infer(self, ev):
        lang = ev.payload["language"]
        intent = self.rng.choice(self.INTENTS)
        # local-language coverage is genuinely weaker: this is the fairness risk on slide 15
        base = {"English": 0.93, "Twi": 0.80, "Ga": 0.74, "Ewe": 0.72, "Hausa": 0.71}[lang]
        conf = base + self.rng.uniform(-0.10, 0.06)
        if intent == "complaint":
            return ("HANDOFF_TO_CX", conf, f"complaint intent detected ({lang})", False)
        return (f"SERVE_{intent.upper()}", conf, f"intent={intent}, language={lang}", False)


@agent("retail.spending_insights")
class InsightsAgent(Agent):
    endpoint = "azureml://aidigitalbank/spend-insights/v1:batch"
    confidence_floor = 0.60
    data_categories = ("transaction", "merchant category")

    def infer(self, ev):
        return ("SEND_SAVINGS_TIP", 0.78 + self.rng.uniform(-0.1, 0.15),
                "recurring merchant spend above peer median", False)


# ---- Customer Experience ---------------------------------------------------------------------

@agent("cx.complaint_resolution")
class ComplaintAgent(Agent):
    endpoint = "azure-cognitive://aidigitalbank/complaint-triage/v2"
    confidence_floor = 0.72
    data_categories = ("identity", "contact", "complaint text")

    def infer(self, ev):
        sev = ev.payload.get("severity", self.rng.randint(1, 5))
        if sev >= 4:
            return ("ESCALATE_TIER2", 0.62, f"severity {sev}/5, regulatory exposure", False)
        return ("AUTO_RESOLVE", 0.86 - sev * 0.03, f"severity {sev}/5, playbook match", False)


@agent("cx.retention")
class RetentionAgent(Agent):
    endpoint = "azureml://aidigitalbank/churn-propensity/v3:predict"
    confidence_floor = 0.68
    data_categories = ("account", "transaction", "service history")

    def infer(self, ev):
        churn = self.rng.betavariate(2, 6)
        if churn > 0.45:
            return ("TRIGGER_RETENTION_PLAY", 0.65 + churn / 3, f"churn propensity {churn:.0%}", False)
        return ("MONITOR", 0.88, f"churn propensity {churn:.0%}", False)


# ---- Credit Risk ------------------------------------------------------------------------------

@agent("credit.scoring")
class CreditScoringAgent(Agent):
    endpoint = "datarobot://aidigitalbank/credit-scorecard/v7:predict"
    confidence_floor = 0.80
    data_categories = ("identity", "income", "credit bureau", "alternative data")

    def infer(self, ev):
        score = ev.payload["bureau_score"]
        thin = ev.payload.get("thin_file", False)
        conf = (0.72 if thin else 0.91) + self.rng.uniform(-0.08, 0.06)
        band = "A" if score > 720 else "B" if score > 640 else "C" if score > 560 else "D"
        adverse = band == "D"
        return (f"GRADE_{band}", conf,
                f"bureau {score}, thin_file={thin}, top driver: repayment history", adverse)


@agent("credit.risk_pricing")
class PricingAgent(Agent):
    endpoint = "azureml://aidigitalbank/risk-based-pricing/v2:score"
    confidence_floor = 0.75
    data_categories = ("credit grade", "product", "tenor")

    def infer(self, ev):
        grade = ev.payload.get("grade", "B")
        spread = {"A": 2.5, "B": 4.0, "C": 7.5, "D": 12.0}[grade]
        return (f"PRICE_BASE_PLUS_{spread}pct", 0.87 - {"A": 0, "B": .02, "C": .07, "D": .16}[grade],
                f"grade {grade} risk spread", grade == "D")


@agent("credit.early_warning")
class EarlyWarningAgent(Agent):
    endpoint = "azureml://aidigitalbank/ews-gradient-boost/v4:predict"
    confidence_floor = 0.70
    data_categories = ("account", "transaction", "exposure")
    degrades = True   # macro shift makes this the model that drifts first

    def infer(self, ev):
        stress = ev.payload.get("stress", self.rng.random())
        if stress > 0.7:
            return ("FLAG_WATCHLIST", 0.68 + stress / 4,
                    f"inflow volatility and utilisation spike (stress {stress:.2f})", False)
        return ("NO_ACTION", 0.90 - stress / 5, f"stress {stress:.2f} within tolerance", False)


@agent("credit.collections")
class CollectionsAgent(Agent):
    endpoint = "azureml://aidigitalbank/collections-nba/v2:rank"
    confidence_floor = 0.65
    data_categories = ("account", "arrears", "contact history")

    def infer(self, ev):
        dpd = ev.payload.get("dpd", self.rng.randint(1, 120))
        channel = "SMS" if dpd < 30 else "CALL" if dpd < 90 else "FIELD_VISIT"
        return (f"CONTACT_VIA_{channel}", 0.80 + self.rng.uniform(-0.12, 0.12),
                f"{dpd} days past due, best-response channel", False)


# ---- SME ------------------------------------------------------------------------------------

@agent("sme.loan_risk")
class SMEriskAgent(Agent):
    endpoint = "azureml://aidigitalbank/sme-scorecard-lgbm/v3:predict"
    confidence_floor = 0.76
    data_categories = ("business identity", "trade data", "transaction")

    def infer(self, ev):
        turnover = ev.payload.get("turnover", self.rng.uniform(50_000, 3_000_000))
        volatility = self.rng.random()
        conf = 0.90 - volatility * 0.30
        adverse = volatility > 0.75
        return ("DECLINE" if adverse else "APPROVE_WITH_COVENANT", conf,
                f"turnover {CCY} {turnover:,.0f}, cashflow volatility {volatility:.2f}", adverse)


@agent("sme.doc_verification")
class DocVerifyAgent(Agent):
    endpoint = "tesseract+layoutlm://aidigitalbank/lpo-verify/v2"
    confidence_floor = 0.85
    data_categories = ("business identity", "document image")

    def infer(self, ev):
        quality = ev.payload.get("scan_quality", self.rng.random())
        if quality < 0.4:
            return ("REJECT_RESUBMIT", 0.55 + quality, f"scan quality {quality:.2f} below OCR threshold", False)
        return ("VERIFIED", 0.80 + quality * 0.18, "LPO fields matched to buyer registry", False)


@agent("sme.cashflow")
class CashflowAgent(Agent):
    endpoint = "prophet://aidigitalbank/sme-cashflow/v1:forecast"
    confidence_floor = 0.62
    data_categories = ("business transaction",)

    def infer(self, ev):
        gap = self.rng.uniform(-200_000, 400_000)
        if gap > 100_000:
            return ("OFFER_WORKING_CAPITAL", 0.70 + self.rng.uniform(0, 0.2),
                    f"projected 60d shortfall {CCY} {gap:,.0f}", False)
        return ("NO_ACTION", 0.84, "no financing gap projected", False)


# ---- Financial Crime & Compliance -------------------------------------------------------------

@agent("fcc.aml")
class AMLAgent(Agent):
    endpoint = "h2o://aidigitalbank/aml-triage/v6:score"
    confidence_floor = 0.82
    data_categories = ("identity", "transaction", "counterparty")

    def infer(self, ev):
        amt = ev.payload.get("amount", 0)
        structuring = ev.payload.get("structuring", False)
        risk = min(0.95, amt / 250_000 + 0.4 * structuring + self.rng.uniform(0, 0.25))
        if risk > 0.6:
            return ("ESCALATE_TO_ANALYST", 0.60 + risk / 4,
                    f"typology match, structuring={structuring}", False)
        return ("CLOSE_NO_ACTION", 0.93 - risk / 3, "no typology match", False)


@agent("fcc.sanctions")
class SanctionsAgent(Agent):
    endpoint = "lexisnexis://bridger/screen/v1"
    confidence_floor = 0.90   # deliberately high: false negatives are unacceptable
    data_categories = ("identity", "nationality", "counterparty")

    def infer(self, ev):
        similarity = self.rng.betavariate(1.4, 8)
        if similarity > 0.30:
            return ("HOLD_FOR_L2_REVIEW", 0.55 + similarity,
                    f"fuzzy match score {similarity:.2f} against PEP/sanctions list", False)
        return ("CLEAR", 0.96, f"no match above 0.30 (best {similarity:.2f})", False)


@agent("fcc.fraud_ring")
class FraudRingAgent(Agent):
    endpoint = "neo4j://aidigitalbank/gds/fraud-community/v2"
    confidence_floor = 0.74
    data_categories = ("account", "device", "network graph")

    def infer(self, ev):
        density = self.rng.betavariate(1.5, 7)
        if density > 0.35:
            return ("FREEZE_CLUSTER", 0.62 + density,
                    f"community density {density:.2f}, shared device fingerprints", True)
        return ("NO_RING_DETECTED", 0.91, f"community density {density:.2f}", False)


@agent("fcc.sar")
class SARAgent(Agent):
    endpoint = "azure-openai://aidigitalbank/sar-drafter/v1"
    confidence_floor = 0.70
    data_categories = ("identity", "transaction", "case narrative")

    def infer(self, ev):
        return ("DRAFT_SAR_FOR_MLRO_SIGNOFF", 0.76 + self.rng.uniform(-0.08, 0.14),
                "narrative assembled from case timeline; MLRO signature required", False)


# ---- Corporate --------------------------------------------------------------------------------

@agent("corp.liquidity")
class LiquidityAgent(Agent):
    endpoint = "timegpt://aidigitalbank/corp-liquidity/v2:forecast"
    confidence_floor = 0.66
    data_categories = ("corporate account", "treasury position")

    def infer(self, ev):
        horizon_err = self.rng.uniform(0.02, 0.22)
        return ("PUBLISH_5D_FORECAST", 0.92 - horizon_err,
                f"expected MAPE {horizon_err:.1%} over 5-day horizon", False)


@agent("corp.trade_fraud")
class TradeFraudAgent(Agent):
    endpoint = "neo4j+ocr://aidigitalbank/bol-verify/v1"
    confidence_floor = 0.80
    data_categories = ("trade document", "counterparty", "vessel registry")

    def infer(self, ev):
        anomaly = self.rng.betavariate(1.3, 6)
        if anomaly > 0.30:
            return ("HOLD_DOCUMENT", 0.58 + anomaly,
                    f"bill of lading anomaly {anomaly:.2f}: vessel/route mismatch", True)
        return ("RELEASE", 0.89, "document consistent with vessel and route registries", False)


# ---- Operations / Technology ------------------------------------------------------------------

@agent("ops.document_processing")
class DocProcessingAgent(Agent):
    endpoint = "uipath://aidigitalbank/kyc-stp/v3"
    confidence_floor = 0.83
    data_categories = ("identity", "document image")

    def infer(self, ev):
        completeness = self.rng.random()
        if completeness < 0.25:
            return ("ROUTE_TO_OPS_QUEUE", 0.60, "mandatory KYC fields missing", False)
        return ("STRAIGHT_THROUGH", 0.84 + completeness * 0.14, "all mandatory fields extracted", False)


@agent("tech.aiops")
class AIOpsAgent(Agent):
    endpoint = "prometheus+moogsoft://aidigitalbank/aiops/v2"
    confidence_floor = 0.70
    data_categories = ("telemetry",)

    def infer(self, ev):
        sev = ev.payload.get("severity", self.rng.randint(1, 5))
        if sev >= 4:
            return ("PAGE_SRE", 0.66, f"sev{sev} anomaly, auto-remediation not safe", False)
        return ("AUTO_REMEDIATE", 0.88 - sev * 0.02, f"sev{sev}: restart + scale-out playbook", False)


# ==========================================================================================
# SECTION 4 - ORCHESTRATION: routes events through pipelines of agents (slide 23 "orchestration")
# ==========================================================================================


PIPELINES: dict[str, tuple[str, ...]] = {
    "card_transaction":  ("retail.fraud_detection", "fcc.aml", "fcc.fraud_ring"),
    "loan_application":  ("retail.loan_preapproval", "credit.scoring", "credit.risk_pricing",
                          "fcc.sanctions"),
    "sme_facility":      ("sme.doc_verification", "sme.loan_risk", "sme.cashflow", "fcc.sanctions"),
    "chat_message":      ("retail.chatbot", "cx.complaint_resolution"),
    "account_opening":   ("ops.document_processing", "fcc.sanctions"),
    "trade_document":    ("corp.trade_fraud", "fcc.sanctions"),
    "portfolio_tick":    ("credit.early_warning", "credit.collections", "cx.retention",
                          "retail.personalized_offers"),
    "treasury_tick":     ("corp.liquidity",),
    "infra_alert":       ("tech.aiops",),
    "monthly_batch":     ("retail.spending_insights",),
    "aml_case":          ("fcc.sar",),
}

DAILY_VOLUMES: dict[str, int] = {
    "card_transaction": 420, "loan_application": 55, "sme_facility": 18,
    "chat_message": 300, "account_opening": 40, "trade_document": 8,
    "portfolio_tick": 120, "treasury_tick": 12, "infra_alert": 25,
    "monthly_batch": 60, "aml_case": 10,
}


class Orchestrator:
    def __init__(self, tower: ControlTower, rng: random.Random) -> None:
        self.tower = tower
        self.rng = rng
        self.agents: dict[str, Agent] = {}
        for key, cls in AGENT_REGISTRY.items():
            uc = USE_CASES[key]
            if uc.admitted:
                self.agents[key] = cls(uc, rng)
        self.blocked_calls: dict[str, int] = defaultdict(int)
        self.escalation_queue: int = 0
        self.queue_overflow: int = 0

    def dispatch(self, ev: Event) -> list[Decision]:
        out: list[Decision] = []
        for key in PIPELINES.get(ev.type, ()):
            ag = self.agents.get(key)
            if ag is None:
                self.blocked_calls[key] += 1
                continue
            d = ag.handle(ev, self.tower)
            out.append(d)
            if d.escalated:
                self.escalation_queue += 1
            # short-circuit: a hard block downstream of fraud/sanctions stops the pipeline
            if d.action in ("BLOCK_AND_STEP_UP", "HOLD_FOR_L2_REVIEW", "FREEZE_CLUSTER",
                            "HOLD_DOCUMENT", "DECLINE", "REJECT_RESUBMIT"):
                break
        return out

    def close_day(self) -> None:
        cleared = min(self.escalation_queue, ControlTower.ESCALATION_CAPACITY_PER_DAY)
        self.escalation_queue -= cleared
        if self.escalation_queue > 0:
            self.queue_overflow += self.escalation_queue


# ---- event generation -----------------------------------------------------------------------


def generate_events(day: datetime, rng: random.Random, scale: float = 1.0) -> list[Event]:
    evs: list[Event] = []
    n = 0
    for etype, vol in DAILY_VOLUMES.items():
        for _ in range(max(1, int(vol * scale))):
            n += 1
            ts = day + timedelta(minutes=rng.randint(0, 1439))
            payload: dict[str, Any] = {"hour": ts.hour}
            if etype == "card_transaction":
                payload |= {"amount": round(rng.lognormvariate(6.0, 1.3), 2),
                            "foreign": rng.random() < 0.07,
                            "structuring": rng.random() < 0.04}
            elif etype in ("loan_application",):
                payload |= {"bureau_score": rng.randint(430, 810),
                            "dti": rng.uniform(0.05, 0.65),
                            "income": rng.uniform(1_200, 28_000),
                            "thin_file": rng.random() < 0.35,
                            "grade": rng.choice("ABCD")}
            elif etype == "sme_facility":
                payload |= {"turnover": rng.uniform(60_000, 4_000_000),
                            "scan_quality": rng.random()}
            elif etype == "chat_message":
                payload |= {"language": rng.choices(
                    ["English", "Twi", "Ga", "Ewe", "Hausa"], weights=[55, 25, 8, 7, 5])[0],
                    "severity": rng.randint(1, 5)}
            elif etype == "account_opening":
                payload |= {"scan_quality": rng.random()}
            elif etype == "portfolio_tick":
                payload |= {"stress": rng.random(), "dpd": rng.randint(0, 150),
                            "balance_growth": rng.uniform(-0.2, 0.4)}
            elif etype == "infra_alert":
                payload |= {"severity": rng.randint(1, 5)}
            elif etype == "aml_case":
                payload |= {"amount": rng.uniform(10_000, 900_000)}
            evs.append(Event(f"EV{day:%Y%m%d}-{n:05d}", etype, ts, payload))
    rng.shuffle(evs)
    return evs


# ==========================================================================================
# SECTION 5 - REPORTING: the control tower dashboard (slide 17 "How to Sustain Value")
# ==========================================================================================


def rule(title: str = "", width: int = 92) -> str:
    if not title:
        return "-" * width
    return f"-- {title} " + "-" * max(0, width - len(title) - 4)


def boot(up_to_phase: Phase, seed: int) -> tuple[ControlTower, Orchestrator]:
    rng = random.Random(seed)
    tower = ControlTower(USE_CASES, AuditLog())
    for uc in USE_CASES.values():
        tower.certify(uc)          # assurance evidence loaded from the model registry
        tower.admit(uc, up_to_phase)
    return tower, Orchestrator(tower, rng)


def cmd_portfolio(args) -> None:
    tower, _ = boot(Phase(args.phase), args.seed)
    print(rule("AI PORTFOLIO - governed by the AI Control Tower"))
    print(f"{'USE CASE':<38}{'DOMAIN':<18}{'PH':<4}{'QUADRANT':<22}STATUS")
    print(rule())
    for uc in sorted(USE_CASES.values(), key=lambda u: (u.phase.value, u.domain, u.key)):
        status = "LIVE" if uc.admitted else f"blocked: {uc.blocked_reason}"
        print(f"{uc.name[:37]:<38}{DOMAINS[uc.domain].name[:17]:<18}"
              f"{uc.phase.value:<4}{uc.quadrant:<22}{status[:34]}")
    live = sum(1 for u in USE_CASES.values() if u.admitted)
    print(rule())
    print(f"{live} live / {len(USE_CASES)} registered  |  admission cut-off: Phase {args.phase}")


def cmd_roadmap(args) -> None:
    print(rule("IMPLEMENTATION ROADMAP (slide 26)"))
    for ph in Phase:
        ucs = [u for u in USE_CASES.values() if u.phase == ph]
        built = sum(1 for u in ucs if u.has_agent)
        print(f"\nPhase {ph.value} - {ph.label} ({ph.window})   "
              f"{built}/{len(ucs)} use cases have an agent")
        by_domain = defaultdict(list)
        for u in ucs:
            by_domain[DOMAINS[u.domain].name].append(u)
        for dom, items in sorted(by_domain.items()):
            names = ", ".join(u.name + ("" if u.has_agent else " [stub]") for u in items)
            print(f"   {dom:<30} {names}")


def cmd_dpia(args) -> None:
    uc = USE_CASES.get(args.use_case)
    if not uc:
        print(f"unknown use case '{args.use_case}'. Try: python3 {sys.argv[0]} portfolio")
        return
    tower, _ = boot(Phase.SCALE, args.seed)
    ag_cls = AGENT_REGISTRY.get(uc.key)
    print(rule(f"DATA PROTECTION IMPACT ASSESSMENT - {uc.name}"))
    print(f"Reference        : {uc.dpia_ref or 'not required'}")
    print(f"Controller       : AI-Digital Bank Ghana  |  Domain: {DOMAINS[uc.domain].name}")
    print(f"Processing       : {uc.scenario}")
    print(f"Lawful basis     : {'consent + legitimate interest' if uc.personal_data else 'n/a'}")
    print(f"Data categories  : {', '.join(ag_cls.data_categories) if ag_cls else 'tbd'}")
    print(f"Automated decision with legal/significant effect: {uc.automated_decision}")
    print(f"Hosting          : {DOMAINS[uc.domain].hosting}   Approach: {DOMAINS[uc.domain].approach.value}")
    print("\nIdentified risks")
    risks = ["privacy breach in transit or at rest",
             "unintended retention beyond stated purpose",
             "disclosure of sensitive financial information"]
    if uc.key == "retail.chatbot":
        risks.append("language-based model bias (local-language accuracy below English)")
    if uc.automated_decision:
        risks.append("unfair or unexplainable adverse decision against a customer")
    for r in risks:
        print(f"  - {r}")
    print("\nMitigations in force")
    mits = ["field-level encryption; TLS 1.3 in transit",
            "data minimisation at ingestion; purpose-bound retention schedule",
            "role-based access control with quarterly recertification",
            "immutable audit trail of every automated decision"]
    if uc.automated_decision:
        mits.append(f"explainability: {uc.explainer}; adverse outcomes routed to human adjudication")
    if uc.key == "retail.chatbot":
        mits.append("per-language fairness testing with published accuracy floors")
    for m in mits:
        print(f"  - {m}")
    print("\nGate results")
    for name, ok, why in tower.gate_results.get(uc.key, []):
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<26} {why}")


def cmd_audit(args) -> None:
    tower, orch = boot(Phase(args.phase), args.seed)
    day = datetime(2026, 9, 1, 0, 0)
    for ev in generate_events(day, orch.rng, scale=0.3):
        orch.dispatch(ev)
    print(rule(f"AUDIT TRAIL - last {args.tail} of {len(tower.audit):,} records"))
    for e in tower.audit.tail(args.tail):
        print(e.as_json())


def cmd_run(args) -> None:
    phase = Phase(args.phase)
    tower, orch = boot(phase, args.seed)
    start = datetime(2026, 9, 1)

    print(rule("AI-FIRST BANK ENGINE - AI-Digital Bank Ghana"))
    print(f"Admission cut-off : Phase {phase.value} - {phase.label} ({phase.window})")
    live = [u for u in USE_CASES.values() if u.admitted]
    print(f"Agents live       : {len(live)}   Registered use cases: {len(USE_CASES)}")
    blocked_gov = [u for u in USE_CASES.values()
                   if not u.admitted and u.has_agent and u.blocked_reason
                   and "Phase" not in u.blocked_reason]
    if blocked_gov:
        print("Blocked by governance:")
        for u in blocked_gov:
            print(f"   - {u.name}: {u.blocked_reason}")

    total_events = 0
    for d in range(args.days):
        day = start + timedelta(days=d)
        events = generate_events(day, orch.rng)
        total_events += len(events)
        for ev in events:
            orch.dispatch(ev)
        orch.close_day()

    decisions = sum(tower.decisions.values())
    escalations = sum(tower.escalations.values())
    value = sum(tower.value_captured.values())

    print("\n" + rule("RUN SUMMARY"))
    print(f"Business days simulated : {args.days}")
    print(f"Events ingested         : {total_events:,}")
    print(f"Automated decisions     : {decisions:,}")
    print(f"Straight-through rate   : {(1 - escalations / max(1, decisions)):.1%}")
    print(f"Escalated to humans     : {escalations:,}  "
          f"(capacity {ControlTower.ESCALATION_CAPACITY_PER_DAY}/day)")
    if orch.queue_overflow:
        print(f"  ! review backlog carried: {orch.queue_overflow:,} case-days over capacity")
    print(f"Value captured          : {CCY} {value:,.0f}")
    print(f"Audit records written   : {len(tower.audit):,}")

    print("\n" + rule("PER-AGENT PERFORMANCE"))
    print(f"{'USE CASE':<34}{'DECISIONS':>10}{'STP':>8}{'AVG CONF':>10}{'VALUE ' + CCY:>16}  VERDICT")
    print(rule())
    for key in sorted(tower.decisions, key=lambda k: -tower.value_captured[k]):
        n = tower.decisions[key]
        stp = 1 - tower.escalations[key] / n
        conf = sum(tower.confidence_window[key]) / len(tower.confidence_window[key])
        verdict, why = tower.review(key)
        print(f"{USE_CASES[key].name[:33]:<34}{n:>10,}{stp:>8.0%}{conf:>10.2f}"
              f"{tower.value_captured[key]:>16,.0f}  {verdict.value}")

    alerts = tower.drift_alerts()
    print("\n" + rule("MODEL RISK MONITORING"))
    if alerts:
        for key, base, recent in alerts:
            print(f"  DRIFT  {USE_CASES[key].name}: confidence {base:.2f} -> {recent:.2f} "
                  f"(tolerance {ControlTower.DRIFT_TOLERANCE:.0%}) -> retrain and revalidate")
    else:
        print("  no drift beyond tolerance")

    print("\n" + rule("CONTROL TOWER ACTIONS"))
    for key in sorted(tower.decisions, key=lambda k: -tower.value_captured[k]):
        verdict, why = tower.review(key)
        if verdict is not Verdict.HOLD:
            print(f"  {verdict.value:<7} {USE_CASES[key].name}: {why}")
    if orch.blocked_calls:
        print("\n  Pipeline calls to agents not yet admitted (demand signal for the roadmap):")
        for key, n in sorted(orch.blocked_calls.items(), key=lambda kv: -kv[1]):
            print(f"    {USE_CASES[key].name:<40}{n:>8,} calls  "
                  f"(Phase {USE_CASES[key].phase.value})")

    print("\n" + rule())
    print("Every number above is generated by stub models. Wire Agent.infer() to the endpoints")
    print("declared on each agent class to run this against real models and real data.")



def cmd_export(args) -> None:
    """Emit a JSON snapshot of a full run for the Control Tower dashboard."""
    phase = Phase(args.phase)
    tower, orch = boot(phase, args.seed)
    start = datetime(2026, 9, 1)
    daily, prev = [], (0, 0, 0.0)
    for d in range(args.days):
        day = start + timedelta(days=d)
        for ev in generate_events(day, orch.rng):
            orch.dispatch(ev)
        orch.close_day()
        cur = (sum(tower.decisions.values()), sum(tower.escalations.values()),
               sum(tower.value_captured.values()))
        daily.append({"day": day.strftime("%d %b"),
                      "decisions": cur[0] - prev[0],
                      "escalated": cur[1] - prev[1],
                      "value": round(cur[2] - prev[2], 2),
                      "backlog": orch.escalation_queue})
        prev = cur

    ucs = []
    for uc in USE_CASES.values():
        n = tower.decisions.get(uc.key, 0)
        conf = tower.confidence_window.get(uc.key)
        verdict, why = tower.review(uc.key)
        gates = [{"gate": g, "pass": ok, "note": note}
                 for g, ok, note in tower.gate_results.get(uc.key, [])]
        ucs.append({
            "key": uc.key, "name": uc.name, "domain": DOMAINS[uc.domain].name,
            "group": DOMAINS[uc.domain].group.value, "approach": DOMAINS[uc.domain].approach.value,
            "hosting": DOMAINS[uc.domain].hosting, "scenario": uc.scenario,
            "phase": uc.phase.value, "quadrant": uc.quadrant,
            "impact": uc.impact, "feasibility": uc.feasibility,
            "personalData": uc.personal_data, "automatedDecision": uc.automated_decision,
            "dpia": uc.dpia_ref, "explainer": uc.explainer,
            "hasAgent": uc.has_agent, "admitted": uc.admitted, "blocked": uc.blocked_reason,
            "endpoint": getattr(AGENT_REGISTRY.get(uc.key), "endpoint", None),
            "decisions": n,
            "escalated": tower.escalations.get(uc.key, 0),
            "stp": round(1 - tower.escalations.get(uc.key, 0) / n, 4) if n else None,
            "confidence": round(sum(conf) / len(conf), 3) if conf else None,
            "value": round(tower.value_captured.get(uc.key, 0.0), 2),
            "verdict": verdict.value, "verdictWhy": why, "gates": gates,
        })

    snapshot = {
        "meta": {"bank": "AI-Digital Bank Ghana", "currency": CCY, "days": args.days,
                 "phaseCutoff": phase.value, "seed": args.seed,
                 "capacityPerDay": ControlTower.ESCALATION_CAPACITY_PER_DAY,
                 "generated": datetime.now().isoformat(timespec="seconds"),
                 "driftTolerance": ControlTower.DRIFT_TOLERANCE},
        "totals": {"events": sum(int(v * args.days) for v in DAILY_VOLUMES.values()),
                   "decisions": sum(tower.decisions.values()),
                   "escalated": sum(tower.escalations.values()),
                   "value": round(sum(tower.value_captured.values()), 2),
                   "auditRecords": len(tower.audit),
                   "backlog": orch.queue_overflow},
        "daily": daily,
        "useCases": ucs,
        "drift": [{"key": k, "name": USE_CASES[k].name, "baseline": round(b, 3),
                   "recent": round(r, 3)} for k, b, r in tower.drift_alerts()],
        "phases": [{"n": p.value, "label": p.label, "window": p.window} for p in Phase],
        "audit": [e.__dict__ for e in tower.audit.tail(40)],
    }
    out = args.out
    with open(out, "w") as f:
        json.dump(snapshot, f, indent=1)
    print(f"wrote {out}: {len(ucs)} use cases, {snapshot['totals']['decisions']:,} decisions")


def main() -> None:
    p = argparse.ArgumentParser(description="AI-First Bank Engine")
    p.add_argument("--seed", type=int, default=7)
    sub = p.add_subparsers(dest="cmd")

    r = sub.add_parser("run", help="simulate the bank running")
    r.add_argument("--days", type=int, default=5)
    r.add_argument("--phase", type=int, default=2, choices=[1, 2, 3, 4])
    r.add_argument("--seed", type=int, default=7)
    r.set_defaults(func=cmd_run)

    pf = sub.add_parser("portfolio", help="show the governed use-case portfolio")
    pf.add_argument("--phase", type=int, default=2, choices=[1, 2, 3, 4])
    pf.add_argument("--seed", type=int, default=7)
    pf.set_defaults(func=cmd_portfolio)

    rm = sub.add_parser("roadmap", help="show the phased roadmap")
    rm.add_argument("--seed", type=int, default=7)
    rm.set_defaults(func=cmd_roadmap)

    dp = sub.add_parser("dpia", help="print the DPIA record for a use case")
    dp.add_argument("use_case")
    dp.add_argument("--seed", type=int, default=7)
    dp.set_defaults(func=cmd_dpia)

    au = sub.add_parser("audit", help="print the tail of the audit trail")
    au.add_argument("--tail", type=int, default=10)
    au.add_argument("--phase", type=int, default=2, choices=[1, 2, 3, 4])
    au.add_argument("--seed", type=int, default=7)
    au.set_defaults(func=cmd_audit)

    ex = sub.add_parser("export", help="write a JSON snapshot for the dashboard")
    ex.add_argument("--days", type=int, default=20)
    ex.add_argument("--phase", type=int, default=4, choices=[1, 2, 3, 4])
    ex.add_argument("--out", default="control_tower_data.json")
    ex.add_argument("--seed", type=int, default=7)
    ex.set_defaults(func=cmd_export)

    args = p.parse_args()
    if not getattr(args, "cmd", None):
        args = p.parse_args(["run"])
    args.func(args)


if __name__ == "__main__":
    main()
