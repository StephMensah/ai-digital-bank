# AI-First Bank Engine — prototype

An executable version of the *Strategic AI Banking Framework* deck. Everything in the deck
that was a box on a slide is a live object here: the domains, the sub-functional use cases,
the governance gates, the DPIA, the phased roadmap, the control tower.

Single file, no dependencies, Python 3.10+.

```
python3 aibank_engine.py run --days 5 --phase 2
python3 aibank_engine.py portfolio --phase 1
python3 aibank_engine.py roadmap
python3 aibank_engine.py dpia retail.chatbot
python3 aibank_engine.py audit --tail 15
python3 aibank_engine.py export --days 20 --phase 4 --out control_tower_data.json
```

## Start here

Open **index.html**. It is the prototype hub: pick a surface, switch between phone, tablet and
laptop widths, and the preview resizes live. Each surface also opens on its own.

```
python3 decision_api.py     # http://localhost:8765/  — hub plus a shared queue
```

## Running the whole thing

```
python3 decision_api.py            # http://localhost:8765/
```

That starts the decision service and serves every front-end from one origin. With it running,
a customer escalation appears in the reviewer's queue within four seconds and lands in the
audit log the control tower reads. Without it, each front-end still opens straight off disk
and decides locally — they detect the service and fall back on their own.

```
customer products --POST /api/decisions--> service --> queue --> reviewer console
                                              |
                                              +--> audit log --> control tower
```

Endpoints: `GET /api/state` (queue, capacity, override rates), `POST /api/decisions`,
`POST /api/cases/<ref>/resolve`, `GET /api/audit`, `GET /api/portfolio`, `GET /api/health`.

## Start here

Open **`index.html`** — the prototype hub. It links all four products, checks whether the
decision service is running, and lists the interactions that exercise the engine. Every
product also carries a switcher in the bottom-right corner, so you can move between them
without going back.

## Front-ends

- **control-tower.html** — the operator console. Runs on the JSON snapshot the `export`
  command writes, so every number traces to an engine run. Phase buttons change the
  admission cut-off; clicking a row opens its governance gates, DPIA reference and endpoint.
- **web.html** — internet banking, redesigned as a full digital bank. Personal and
  business entities with their own navigation: overview, transfers and standing orders, bills
  and airtime, cards (physical and virtual), save & invest (goals, fixed deposits, 91–364 day
  treasury bills), borrow, foreign exchange, statements and certificates, support, and a
  privacy centre. Business adds payroll with maker-checker, invoices and purchase-order
  verification, cash flow, and approvals. A decision rail runs down the right of every page.
- **reviewer-console.html** — the staff product for the people the escalations land on.
  Queue sorted by SLA, case detail showing exactly what the model saw and what the customer
  was already told, and three outcomes: agree, override, or return for more. Keyboard: `j`/`k`
  to move, `a`/`o`/`r` to decide. An override is the only ground truth these models get from
  production, so the console tracks override rate per model and feeds it back.
- **app.html** — the mobile product. Five tabs with a raised Pay button, a keypad
  amount flow, goal rings, card art with freeze, treasury bills, FX, KYC tiers and limits,
  and the same decision notes. Below 520px the device frame drops and it fills the screen.

All three are built from `src/` by `build.py`, which inlines two shared files so each product stays
a single portable file:

- `src/core.js` — the browser port of the agents. Each keeps the engine contract,
  `infer(input) -> {action, confidence, explanation, adverse}`, and `FID.decide()` applies the
  confidence floor, routes adverse outcomes to human adjudication and writes the receipt.
- `src/icons.js` — 47 hand-built SVG icons on a 24px grid, plus the node lattice
  that textures dark surfaces. The block / node / chain / ledger family carries the
  distributed-ledger motif.
- `src/core.js` also holds the **merchant registry and live ledger**. Every statement row
  resolves to a merchant with a brand colour and mark; `post()` moves real balances and
  writes the row; `fundGoal()` funds a savings goal from an account or a mobile money wallet.
- `src/icons.js` — 74 icons, including a banking set: bank, transfer, receipt, piggy, vault,
  growth, exchange, loan, statement, scales, stamp, payroll, bulk, dashboard, headset, atm,
  cheque, coins, banknote, handshake, target, percent.
- `src/art.js` — nine illustrations built in the strategy deck's language: flat geometry,
  three oranges, two greys, white space doing the work. No raster images, no requests.
- `src/ui.css` — the consumer design system: warm Ghanaian neutrals, AI-Digital Bank turquoise for
  action, jade for money in, gold for money set aside; Bricolage Grotesque for figures,
  Hanken Grotesk for text, Geist Mono for references.
- `src/ds.css` — the older console system, still used by the reviewer console.

```
python3 build.py     # rebuilds all four front-ends
```

Behaviour worth checking in either product: pay **Global Marine Ltd** (sanctions hold, money
never moves), pay **GHS 12,400** to anyone (step-up, with the signals listed), drag the loan
slider past your limit (goes to a named credit officer, never an automated decline), ask
about a loan in **Ga or Hausa** (below the floor, hands to a person and says so), and turn off
spending insights (the cards it powers disappear).

To refresh the dashboard after changing the engine, re-run `export` and re-inject:

```python
tpl = open('tower_template.html').read()          # placeholder: __SNAPSHOT_JSON__
data = open('control_tower_data.json').read()
open('control-tower.html','w').write(tpl.replace('__SNAPSHOT_JSON__', data))
```

## What maps to what

| Deck | Engine |
|---|---|
| Slide 9 domain map | `DOMAINS` (11) and `USE_CASES` (44) registries |
| Slide 11 feasibility/impact grid | `UseCase.impact` / `.feasibility` → `.quadrant` |
| Slide 14 AI Control Tower | `ControlTower` — admits, monitors, decides SCALE/PIVOT/SUNSET |
| Slide 15 DPIA | `gate_dpia` + the `dpia` command |
| Slide 16 security controls | the five entries in `GATES` |
| Slide 23 capability stack | `Agent` (decision layer), `Orchestrator` (orchestration), `PIPELINES` |
| Slide 26 roadmap | `Phase`; `--phase N` sets the admission cut-off |

## How it runs

An `Event` (card swipe, loan application, chat message, trade document, portfolio tick)
enters `Orchestrator.dispatch`, which walks the pipeline for that event type. Each `Agent`
returns an action, a confidence and a plain-language explanation. The runtime escalates to a
human when confidence falls below the agent's floor, or when an automated decision is adverse
to a customer. Every decision writes an audit record. The control tower accumulates value,
straight-through rate and confidence drift, and issues a verdict per use case.

Nothing runs until it clears governance. A use case with personal data and no DPIA reference,
or an automated customer decision with no explainer, is refused admission and the pipeline
step is skipped — the count of skipped calls appears in the run report as roadmap demand.

## Wiring real models

Each agent class declares an `endpoint` (Azure ML, DataRobot, H2O, Neo4j, Rasa, UiPath,
LexisNexis — matching Appendix I). Replace the body of `infer()` with the real call. The
contract is `(action, confidence, explanation, adverse_to_customer)`. Nothing else changes:
governance, escalation, audit and value tracking all sit in the base class.

`ControlTower.certify()` is the one deliberate cheat — it sets the assurance flags in code.
In production those flags come from evidence in the model registry, never from the engine.

## Two things the deck doesn't cost

1. **Human review capacity is the binding constraint.** At the modelled volumes the engine
   escalates far more cases per day than `ESCALATION_CAPACITY_PER_DAY` can clear, and the
   backlog compounds. Automation rate is a staffing decision before it is a model decision.
2. **Local-language accuracy is a fairness risk, not just a quality one.** The chatbot agent
   models genuinely lower confidence for Twi, Ga, Ewe and Hausa than for English. Under the
   Data Protection Act that gap is a discrimination exposure, so the DPIA record carries a
   published per-language accuracy floor.


## Partner logos on the statement

Every statement row asks for `logos/<slug>.svg`. Drop the file in and it appears; leave it
out and the row falls back to a generated mark in the partner's brand colour, so the
statement never looks broken while assets are still being collected.

- `logos/manifest.json` lists all 29 partners with their slug, brand colour and category.
- `logos/README.md` covers what to ask a partner for and the rules worth keeping.
- Serving them from elsewhere: `FID.setLogoDir('/assets/partner-logos/')`.

No code change is needed per partner. Removing one is deleting a file.


## Testing

There is no browser in the build environment, so interaction is verified with a small DOM
in `/tmp` that does real parsing, real bubbling and a real `closest()`. Two suites:

- a sweep that clicks every reachable element in every view under both entities and fails
  on any handler error
- assertions on outcomes, not silence: a send debits the balance by exactly the amount and
  adds one statement row; searching narrows the statement; funding a goal from MoMo moves
  the wallet and leaves the bank account alone; turning off insights removes the card it
  powers; a watchlisted beneficiary is held and no money moves.

That suite caught the collision where "Send money" shared an action name with the chat send
button and silently did nothing.


## Device frame

The app renders inside an iPhone 17 container — 430 × 930 outer, 53pt screen radius, Dynamic
Island with the camera cut-out, physical side buttons, live status bar and home indicator.
Below 560px the frame is removed entirely and the app takes the whole screen, which is what
a real customer sees.


## Verified interaction

Both customer products are driven end to end by a headless DOM harness — real element tree,
real `closest()`, real event bubbling — not by eyeballing:

- **App:** 19 journeys pass. Send a payment (balance debits, statement row appears, running
  balance recalculates), pay a bill, open a transaction record, buy FX, quote a treasury bill,
  get routed to a credit officer, fund a goal from MoMo, trip the sanctions hold, hit the tier
  limit, and force the Hausa language handover.
- **Web:** 19 journeys pass across all 14 views and both entities.
- **Dead-end sweep:** every `data-act` and `data-sheet` reachable from any view is clicked and
  checked for a real response. Currently zero dead buttons.

## Responsive

Three layouts, not one that shrinks:

| Width | App | Web |
|---|---|---|
| ≤ 560px | device shell removed entirely — no aspect ratio, no frame, no fake status bar; app fills 100dvh with safe-area padding top and bottom | sidebar becomes a scrolling top bar, sheets go full width |
| 561–1120px | centred device frame | sidebar collapses to icons, grids stack |
| ≥ 1120px | frame plus context rail | full sidebar; decision rail appears at 1340px |

Touch targets stay at or above 44px at every width, and wide tables scroll horizontally
rather than overflowing.


## Palette

There is no black anywhere in the customer products — the darkest value is `#333A42`, a deep
warm slate used only for body text. Everything that used to be black now carries the brand:

| Was | Now |
|---|---|
| Matte black balance card | Orange gradient with a white node lattice |
| Black primary button | Orange gradient, warm-tinted shadow |
| Black pressed chip | Solid orange |
| Gunmetal device frame | Silver titanium on a warm sand page |
| Dark web sidebar | White, with an orange rail on the active item |
| Black virtual card | White premium card with an orange lattice |

Shadows are warm grey (`rgba(93,74,54,…)`), never neutral black, so nothing reads as a hole
in the page.


## Two services, one site

The Node service (`server/`) is the product: it serves the front ends from
`public/` and holds the ledger, the rails and the staff consoles.

The Python service (`decision_api.py`) is the decision engine only. It no
longer serves HTML — every non-`/api` request is redirected to `BANKING_URL`,
so a customer can never land on a copy of the pages with no banking API behind
them. The Node service reaches it over `PYTHON_SERVICE_URL`.

Point pokzbank.com at the Node service, then set:

    Node    PUBLIC_WEB_ORIGIN    https://pokzbank.com
    Node    HUBTEL_CALLBACK_URL  https://pokzbank.com/api/v1/webhooks/hubtel
    Node    HUBTEL_RETURN_URL    https://pokzbank.com/app.html
    Node    MOMO_CALLBACK_URL    https://pokzbank.com/api/v1/webhooks/momo
    Python  BANKING_URL          https://pokzbank.com

and update the `adb-app-url` meta tag in `src/index.html`, `src/app.html` and
`src/web.html` before rebuilding.
