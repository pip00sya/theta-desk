# Θ THETA DESK

![THETA DESK](submission/cover.png)

**An autonomous options desk on Alpaca that prices volatility, not direction.**
Team Qwertys — [Alpaca AI Trading Agents Hackathon](https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon) (lablab.ai), Aug 28 – Sep 4, 2026.

<p>
<a href="https://theta-desk.streamlit.app"><b>▶ Dashboard</b></a> (daily snapshot) ·
<a href="https://theta-desk.streamlit.app/?judge=1">Judge mode</a> ·
<a href="WRITEUP.md">One-page write-up</a> ·
<a href="DEVLOG.md">DEVLOG — 33 documented self-corrections</a> ·
<a href="API-FEEDBACK.md">Feedback for the Alpaca team</a>
</p>

Paper account **PA39C10YAMYQ** · paper trading only · hypothetical results · not investment advice.

---

## The thesis

Over a five-day competition, price prediction is a coin flip. THETA DESK doesn't
flip coins: it prices the **volatility risk premium** — ATM implied volatility
from Alpaca's free option chain against 20-day realized volatility — and trades
the gap. Rich vol → sell defined-risk iron condors. Cheap vol → buy convexity.

**Day-one proof it's a system, not a story:** the plan said "sell condors".
The live signal said realized vol was *above* implied — premium was cheap.
The deterministic core went against its authors' plan and bought puts instead
(the LLM roles were not yet keyed on day one — the journal shows four
fallbacks on that tick). That book is what you see green on the dashboard.
Honest footnote (DEVLOG #28): the realized-vol window was lagging by two
weeks until Sep 2; with the corrected window the same signal reads *rich*.

## LLMs decide whether it's wise. Code decides whether it's allowed.

Four LLM roles run every 15-minute cycle that has a candidate — a Vol Analyst
(Claude), a blind Second Opinion (Mistral via Featherless — cross-provider,
so disagreement is real), a News Vetoer (Qwen, cheap enough for every tick),
and a Risk Officer (Claude) whose only job is to attack the trade. They
argue, veto (for the whole session) and shrink size; they can flag the market
data itself as suspect, which blocks new risk. **They cannot loosen a single
one of the 19 deterministic risk rules** (12 entry gates in
`engine/gates.py` plus paper-only, idempotent ids, the tick lock, the
data-quality gate, the desk veto, and the exit rules in `manage/`).

The central gate is the desk's veto right: before any order, the **entire
book plus the candidate** is repriced over a ±20% underlying grid at the
judging horizon (the Sep 18 expiry, so every leg is valued at intrinsic;
the stressed-vol branch engages for legs that outlive the horizon), each leg
off its own underlying's spot. Worst case breaches budget → the order is
never sent, and the refusal is journaled with the worst-case point. It is a
client-side implementation of the same worst-case principle as Alpaca's
universal spread rule for options margin — applied one step earlier.

## Everything replays. Every number regenerates.

- **Hash-chained journal** — every decision line carries the SHA-256 of the
  previous one; edit a byte in place and `verify-journal` fails. The chain
  is self-seeded, so the committed git history is its external anchor.
- **Fills are the truth** — an order is *pending* until the broker reports
  the fill, and the book is repriced to the real fill; `tools/broker_check.py`
  diffs the store against the broker's fills
- **Signal replay** — every tick stores its inputs; `tools/replay.py`
  recomputes the signal layer (realized vol, ATM IV, VRP, candidate id) from
  every snapshot (currently 100% MATCH); the order path is replayed
  end-to-end against a fake broker in `tests/test_tick_flow.py`
- **Claims reconciler** — `tools/reconcile.py` recomputes every number in
  [WRITEUP.md](WRITEUP.md) from the journal, no credentials required
- **Live ablation** — counterfactual books on identical inputs: the strategy
  without gates (unmanaged, marked at mid) and a naive "read a headline, buy
  an option" baseline. A bound on the value of the gates, not a like-for-like
  P&L. The gates refused 43 entries this week — 16 on liquidity, 14 before the
  jobs report, 9 on the daily budget, 4 at the session edges. The hedge sleeve
  fired on Sep 2 (SPY 712 put), so the "no hedge" curve now diverges
- **Data-quality gate** (DEVLOG #28) — every tick classifies its own inputs
  (quote, spot vs last close, bar freshness, IV bounds) as full / mark-only /
  skip before anything is written; closed-market ticks only settle orders

## Architecture

```
scheduler (mirrors the exchange session, survives sleep & battery)
  └─ L1 data        chain + greeks + IV (free indicative feed), 20d RV, per-underlying spots,
  │                 data-quality gate (full / mark-only / skip)
  └─ L2 desk        4 LLM roles argue/veto/size — never compute
  └─ L3 selector    deterministic regime map -> iron condor / long vega / QQQ fallback
  └─ L4-L5 gates    12 pure-Python entry gates incl. ★ portfolio payoff simulator
  └─ L6 executor    mleg limit via Alpaca CLI (signed prices), idempotent ids, REST fallback
  └─ L7 manager     profit targets · realization policy · NFP de-risk · halt-not-flatten
  └─ L8 audit       hash journal · snapshots · replay · reconcile · evidence archive
  └─ shadows        ablation books + naive baseline
```

Sizing is **earned**: risk budgets grow only from realized gains (worst-case
6%→8% of equity, long-premium sleeve 1.5%→2.5%). The agent earns the right
to take risk.

## Built with the whole Alpaca stack

| Piece | Use |
|---|---|
| Trading API | execution, positions, activities, portfolio history |
| Market Data API | option chain with greeks + IV on the **free** indicative feed |
| **CLI** | the autonomous order path: `alpaca api POST /v2/orders`, exit codes, idempotent `client_order_id` (3 of 4 live entries and every close; the very first entry used the REST fallback before the CLI was installed) |
| MCP Server | development tooling only — used interactively from Claude Code during research; the running agent does not call it |
| mleg orders | 2–4 legs, lowest-terms ratios, **signed limit prices** (see DEVLOG #12 — found the hard way) |

## Reproduce everything

```bash
pip install -e ".[dashboard,dev]"
python -m pytest tests -q            # 126 tests
python tools/demo_week.py            # offline simulated week, zero credentials
python tools/replay.py               # the signal layer reproduces from every snapshot
python tools/reconcile.py            # every write-up number regenerates
streamlit run dashboard/app.py       # the glass box, locally
python -m thetadesk.main alert-test  # prove Telegram/webhook/heartbeat delivery
```

Live paper trading additionally needs `.env` (see `.env.example`) — and the
process refuses to start unless the base URL is the paper host (fail-closed,
`safety.py`).

## What we measured but did not ship

Diversification, with numbers instead of intent. The book runs SPY and QQQ,
which correlate ~0.9 — nine condors across two names is closer to one bet at
nine times the size than to nine bets. So on Sep 3 we ran every liquid
candidate through the desk's OWN entry gates (17Δ/15Δ strikes, 10-wide wings,
the 0.18×width credit floor, the 8% spread ceiling) on the Sep 18 expiry:

| Underlying | Condor credit | Floor 1.80 | Verdict |
|---|---|---|---|
| QQQ | 1.94 | pass | already traded |
| **GLD** (gold) | **1.89** | **pass** | **a genuinely different risk driver** |
| SMH (semis) | 2.16 | pass | QQQ's core by another name — false diversification, and a 4.9% spread |
| SPY | 1.76 | fail that hour | premium had compressed |
| IWM / DIA | 1.35 / 1.52 | fail | too cheap for a 10-wide wing |
| TLT / SLV / EFA / XLE | — | n/a | a 10-point wing is wider than a sane fraction of spot |

GLD is the one worth having: gold does not break on the day equities gap, so
its condor is a second bet rather than the same bet again. It is **not**
shipped, and that is deliberate — it needs the payoff grid re-checked for an
underlying that does not move with the rest of the book, and landing that
17 hours before a deadline trades a working desk for a config line. The
measurement is the deliverable; the code is the next session's.

## Honest notes

- Built, red-teamed, debugged and operated end-to-end by AI (Claude), with
  every self-correction documented in [DEVLOG.md](DEVLOG.md) — including an
  mleg sign-convention bug that a weekend acceptance test caught before it
  could hurt, and the pair of labeled test orders that neutralized it (−$6)
- The cloud dashboard renders a committed data snapshot (refreshed daily);
  live keys never leave the machine. The header shows the last tick time.
- Two post-close ticks on Sep 1 priced the book off a one-sided after-hours
  quote; those eight mark rows are flagged `invalid` and not plotted, the
  journal lines stay (the chain is never edited) — DEVLOG #28
- Paper fills are optimistic vs live markets (no impact, no queue); stated
  in the write-up

MIT License.
