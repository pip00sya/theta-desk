# THETA DESK

**Autonomous options desk on Alpaca — paper trading only.**
Team Qwertys · Alpaca AI Trading Agents Hackathon (lablab.ai), Aug 28 – Sep 4, 2026.

The agent does not predict price. It prices the volatility risk premium and
runs a two-sleeve book: an iron-condor **carry** sleeve that earns theta while
the market is calm, and a small long-put **convexity** sleeve, financed by that
theta, that converts a crash tail into profit. Before any order, a portfolio
payoff simulator reprices the entire book over a ±20% price grid at the
judging horizon and refuses the order if the worst case breaches budget —
a client-side implementation of the same worst-case principle as Alpaca's
universal spread rule.

## Architecture

```
heartbeat (cron 30m)
  └─ L1 data        chain + greeks + IV (free indicative feed), 20d RV, positions
  └─ L2 desk        4 LLM roles: Vol Analyst · Second Opinion · News Vetoer · Risk Officer
  │                 (argue/veto/size only — they never compute, cannot loosen gates)
  └─ L3 selector    deterministic regime map -> iron condor / micro long vega
  └─ L4-L5 gates    17 pure-Python gates incl. ★ portfolio payoff simulator
  └─ L6 executor    mleg limit via Alpaca CLI (`alpaca api POST /v2/orders`), REST fallback
  └─ L7 manager     35% profit target · realization policy · 2x credit stop · halt mode
  └─ L8 audit       hash-chained journal · snapshots · replay · reconcile
  └─ shadows        live ablation: no-gates book · no-hedge book · naive baseline
```

## Quickstart

```bash
pip install -e ".[dashboard,dev]"
python -m pytest tests -q                    # 44 tests
python tools/demo_week.py                    # offline simulated week (no keys)
python -m thetadesk.main status
python tools/replay.py                       # decisions reproduce bit-for-bit
python tools/reconcile.py --write            # regenerate WRITEUP claims
streamlit run dashboard/app.py               # glass-box (add ?judge=1)
```

Live (paper only — the process refuses to start otherwise):

```bash
cp .env.example .env                         # fill ALPACA_API_KEY / SECRET
python tools/selfcheck.py                    # Day-0 checklist, prints account ID
python -m thetadesk.main tick --dry-run      # full cycle, no orders
python -m thetadesk.main tick                # live paper cycle
```

## Safety

- `safety.assert_paper_only()` is the first statement of every entrypoint:
  no `paper-api.alpaca.markets` in the base URL -> the process exits.
- Every structure is defined-risk by construction; naked shorts raise.
- Drawdown halts NEW risk only; flatten-all exists solely for a
  book-integrity breach (naked leg / unknown position at the broker).
- No human orders on the judged account — pre-committed.

## Repo map

| Path | What |
|---|---|
| `src/thetadesk/engine/` | Black-Scholes, payoff simulator, gates, selector |
| `src/thetadesk/agents/` | LLM roles (Anthropic + Featherless), degraded-safe |
| `src/thetadesk/execution/` | mleg builder, CLI bridge, idempotency |
| `src/thetadesk/manage/` | profit targets, stops, integrity checks |
| `src/thetadesk/shadow/` | ablation books + naive baseline |
| `src/thetadesk/audit/` | hash-chained journal |
| `tools/` | selfcheck · replay · reconcile · demo_week |
| `dashboard/` | Streamlit glass-box, judge mode |
| `DEVLOG.md` | what the plan promised vs what implementation proved |

## Disclaimers

Paper trading simulation only; hypothetical results; no real funds. Nothing
here is investment advice. Options trading involves substantial risk — see
[Characteristics and Risks of Standardized Options](https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document).

MIT License.
