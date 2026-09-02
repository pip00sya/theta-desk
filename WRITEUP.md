# THETA DESK — one-page write-up

> Autonomous options desk on Alpaca paper trading. Team Qwertys —
> Alpaca AI Trading Agents Hackathon, Aug 28 – Sep 4, 2026.
> **Alpaca paper account ID:** `PA39C10YAMYQ`

## 1. AI logic

The agent does not predict price. It prices the volatility risk premium —
ATM implied volatility from Alpaca's free option chain against 20-day
realized volatility — with a deterministic score, and trades the spread
between them: an iron-condor carry book when volatility is rich, a micro
long-vega book when it is cheap.

LLMs argue, veto and adapt; they never compute. Four roles run on every
cycle that has a candidate (the day-one trades were placed by the
deterministic core before the API keys were configured — those meetings
show four fallbacks in the journal) in a two-tier inference economy: deep
roles on Claude, frequent roles on open models via Featherless AI. A Vol Analyst (Claude Sonnet) interprets
the regime; an independent Second Opinion (Mistral-Small-24B on
Featherless) reads the same inputs blind — the pair is CROSS-PROVIDER, so
the disagreement signal compares different labs, not two prompts on the
same weights; a News Vetoer (Qwen2.5-7B, cheap enough to run every tick)
answers one question — "is there a qualitative reason NOT to add risk
today?"; a Risk Officer (Claude Sonnet) is a mandated devil's advocate
against the day's candidate. Disagreement between the two regime reads
halves position size (the prompts define rich/cheap explicitly so the
signal is information, not vocabulary); a veto stops new short-premium risk
for the rest of the session; a high-severity objection halves size again;
either analyst can flag the market data itself as suspect, which halves size —
and blocks the tick only when BOTH readers agree AND the deterministic
data-quality gate independently found a defect. That asymmetry was bought
live: on 2026-09-02 one analyst called a correct SPY print "outside
historical norms" (a training-cutoff artifact, not a corrupt feed) and would
have shut the desk for the day. LLMs may tighten; only code may stop. No model output can loosen a deterministic gate. Empty,
truncated or unparseable replies are journaled as fallbacks and default to
the deterministic core; a backup Featherless key rotates in automatically on
quota errors. Claude Code with Alpaca's MCP server was the research and build
tool; the running agent itself calls the Trading and Market Data APIs and
the CLI.

## 2. Risk gates

Eighteen deterministic rules, all pure Python: twelve entry gates
orchestrated in `engine/gates.py` (unit- and property-tested, incl. an
earned-scaled cap on the long-premium sleeve and a feed-liveness gate on the
ATM quote strip), plus the paper-only guard, idempotent order ids, the tick
lock, the data-quality gate on every tick's inputs (DEVLOG #28), the desk
veto, and the exit rules in `manage/positions.py`. The central one: before
any order, the ENTIRE book plus the candidate is repriced over a ±20%
underlying-price grid at the judging horizon (deadline + 14 days = the Sep 18
expiry, so every leg the desk trades is valued at intrinsic; the stressed-vol
branch applies to legs that outlive the horizon); if the worst grid P&L
breaches the budget (6% of equity, extendable to 8% only by realized gains —
the agent earns the right to take risk), the order is never sent. This is a client-side implementation of the same worst-case principle
as Alpaca's universal spread rule for options margin. Other gates: paper-only
fail-closed, SPY/QQQ/IWM universe searched least-exposed name first so the
book does not stack one bet at double size, every leg expires on/after Sep 18 (nothing
expires during judging), defined-risk only, two-sided quotes, ≤8% relative
spread, ≤1.25% equity per structure, ≤2.5% new risk/day, session-edge
windows, macro-event de-risk (NFP lands the morning of the deadline — the
book enters that Friday light by rule), 35% profit target with a daily
realization policy, 2× credit structure stop, +60% target on long premium,
a trailing stop that arms at +20% and closes on a 40% giveback of the peak,
a regime exit that refuses to hold long premium once volatility is rich,
drawdown-halt (never
panic-flatten; full liquidation only on a book-integrity breach), and
hash-verified idempotent order ids.

## 3. Alpaca infrastructure

Trading API for execution; Market Data API for the option chain with greeks
and implied volatility (free indicative feed — no subscription needed).
Orders leave through the **Alpaca CLI** (`alpaca api POST /v2/orders`, exit
codes 0/1/2, idempotent `client_order_id`), with a REST fallback that
journals which transport was used (the first live entry went through the
fallback before the CLI was installed; every order since has used the CLI).
Multi-leg structures use `order_class: mleg` (2–4 legs, `ratio_qty` in
lowest terms, `position_intent` per leg), validated client-side so no order
is rejected at submission; unfilled orders are cancelled after ten minutes
and re-decided, which the journal counts separately. An order is `pending`
until the broker reports the fill; the book is then repriced to the real
fill. Unknown long option positions at the broker are adopted into the book
rather than halting the desk; a naked short halts new risk. Every decision
is an entry in a hash-chained journal; `tools/replay.py` recomputes the
signal layer (realized vol, ATM IV, VRP, candidate) from every stored
snapshot, the order path is replayed end-to-end against a fake broker in
the test suite, and every number below regenerates with one command.

## Verified claims

<!-- CLAIMS:BEGIN -->
| # | Claim | Value | Regenerate with |
|---|-------|-------|-----------------|
| 01 | journal_entries | 370 | `python tools/reconcile.py` |
| 02 | journal_chain | intact | `python tools/reconcile.py` |
| 03 | ticks | 39 | `python tools/reconcile.py` |
| 04 | gate_evaluations | 8 | `python tools/reconcile.py` |
| 05 | entries_refused_by_gates | 3 | `python tools/reconcile.py` |
| 06 | structures_total | 4 | `python tools/reconcile.py` |
| 07 | structures_open | 1 | `python tools/reconcile.py` |
| 08 | structures_closed | 3 | `python tools/reconcile.py` |
| 09 | realized_pnl_usd | 764.00 | `python tools/reconcile.py` |
| 10 | realized_pnl_per_broker_fills_usd | 764.00 | `python tools/reconcile.py` |
| 11 | book_worst_case_peak_usd | 1510 | `python tools/reconcile.py` |
| 12 | order_transports_used | cli,dry_run,rest | `python tools/reconcile.py` |
| 13 | orders_submitted_live | 8 | `python tools/reconcile.py` |
| 14 | orders_rejected_at_submit | 0 | `python tools/reconcile.py` |
| 15 | orders_cancelled_unfilled | 1 | `python tools/reconcile.py` |
| 16 | desk_meetings_total | 16 | `python tools/reconcile.py` |
| 17 | desk_meetings_llm_dark | 8 | `python tools/reconcile.py` |
| 18 | llm_fallbacks_recorded | 32 | `python tools/reconcile.py` |
| 19 | marks_quarantined | 8 | `python tools/reconcile.py` |
| 20 | test_functions | 101 | `python tools/reconcile.py` |
<!-- CLAIMS:END -->

*Paper trading simulation only. Hypothetical results, no real funds, not
investment advice. Options involve substantial risk — see Characteristics
and Risks of Standardized Options.*
