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

LLMs argue, veto and adapt; they never compute. Four roles run each cycle
in a two-tier inference economy: deep roles on Claude, frequent roles on
open models via Featherless AI. A Vol Analyst (Claude Sonnet) interprets
the regime; an independent Second Opinion (Mistral-Small-24B on
Featherless) reads the same inputs blind — the pair is CROSS-PROVIDER, so
the disagreement signal compares different labs, not two prompts on the
same weights; a News Vetoer (Qwen2.5-7B, cheap enough to run every tick)
answers one question — "is there a qualitative reason NOT to add risk
today?"; a Risk Officer (Claude Sonnet) is a mandated devil's advocate
against the day's candidate. Disagreement between the two regime reads
halves position size; a veto stops new risk for the day; a high-severity
objection halves size again. No model output can loosen a deterministic
gate. A backup Featherless key rotates in automatically on quota errors;
with no keys at all the desk degrades to its deterministic core and
journals every fallback. Claude also drives the research loop through
Alpaca's MCP server in Claude Code.

## 2. Risk gates

Nineteen gates, all pure Python, orchestrated in `engine/gates.py` and unit-
and property-tested (incl. an earned-scaled cap on the long-premium sleeve
and a feed-liveness gate on the ATM quote strip). The central one: before any order, the ENTIRE book plus
the candidate is repriced over a ±20% underlying-price grid at the judging
horizon (deadline + 14 days), under base and stressed-vol scenarios; if the
worst grid P&L breaches the budget (6% of equity, extendable to 8% only by
realized gains — the agent earns the right to take risk), the order is never
sent. This is a client-side implementation of the same worst-case principle
as Alpaca's universal spread rule for options margin. Other gates: paper-only
fail-closed, SPY/QQQ/IWM universe, every leg expires on/after Sep 18 (nothing
expires during judging), defined-risk only, two-sided quotes, ≤8% relative
spread, ≤1.25% equity per structure, ≤2.5% new risk/day, session-edge
windows, macro-event de-risk (NFP lands the morning of the deadline — the
book enters that Friday light by rule), 35% profit target with a daily
realization policy, 2× credit structure stop, drawdown-halt (never
panic-flatten; full liquidation only on a book-integrity breach), and
hash-verified idempotent order ids.

## 3. Alpaca infrastructure

Trading API for execution; Market Data API for the option chain with greeks
and implied volatility (free indicative feed — no subscription needed).
Orders leave through the **Alpaca CLI** (`alpaca api POST /v2/orders`, exit
codes 0/1/2, idempotent `client_order_id`), with a REST fallback that
journals which transport was used. The **MCP server** is the research loop
in Claude Code. Multi-leg structures use `order_class: mleg` (2–4 legs,
`ratio_qty` in lowest terms, `position_intent` per leg), validated
client-side so the judged account shows zero rejected orders. An order is
`pending` until the broker reports the fill; the book is then repriced to
the real fill, and unfilled orders are cancelled and re-decided. Every
decision is an entry in a hash-chained journal; `tools/replay.py` re-runs
the week's decisions from stored snapshots bit-for-bit, and every number
below regenerates with one command.

## Verified claims

<!-- CLAIMS:BEGIN -->
| # | Claim | Value | Regenerate with |
|---|-------|-------|-----------------|
| 01 | journal_entries | 354 | `python tools/reconcile.py` |
| 02 | journal_chain | intact | `python tools/reconcile.py` |
| 03 | ticks | 37 | `python tools/reconcile.py` |
| 04 | gate_evaluations | 8 | `python tools/reconcile.py` |
| 05 | entries_refused_by_gates | 3 | `python tools/reconcile.py` |
| 06 | structures_total | 4 | `python tools/reconcile.py` |
| 07 | structures_open | 1 | `python tools/reconcile.py` |
| 08 | structures_closed | 3 | `python tools/reconcile.py` |
| 09 | realized_pnl_usd | 764.00 | `python tools/reconcile.py` |
| 10 | realized_pnl_per_broker_fills_usd | 764.00 | `python tools/reconcile.py` |
| 11 | book_worst_case_peak_usd | 1510 | `python tools/reconcile.py` |
| 12 | order_transports_used | cli,dry_run,rest | `python tools/reconcile.py` |
| 13 | llm_fallbacks_recorded | 32 | `python tools/reconcile.py` |
<!-- CLAIMS:END -->

*Paper trading simulation only. Hypothetical results, no real funds, not
investment advice. Options involve substantial risk — see Characteristics
and Risks of Standardized Options.*
