# Step 1 — финальные тексты для формы lablab (обновлено 2026-09-02 после сессии)

**Title (без изменений):** THETA DESK — Autonomous Options Desk

**Short Description (225/255):**
```
An autonomous options desk on Alpaca that doesn't predict prices — it prices the volatility risk premium, runs a hedged two-sleeve book, and refuses any trade that fails an 18-gate risk wall with a portfolio payoff simulator.
```

**Long Description (1766/2000):**
```
Over a five-day competition, price prediction is a coin flip. THETA DESK doesn't flip coins: it prices the volatility risk premium — ATM implied volatility from Alpaca's option chain against 20-day realized volatility — and structures around it. Cheap vol: it buys convexity at micro size (day one: four long puts; three closed at +64–70% when the market slid). Rich vol: it sells defined-risk iron condors across SPY/QQQ, least-exposed name first, and harvests theta.

Four LLM roles run every cycle: a Vol Analyst and a devil's-advocate Risk Officer on Claude, an independent Second Opinion on Mistral via Featherless (a different provider, so disagreement is real), and a News Vetoer on Qwen. They argue, veto and halve size — they never compute, and no model output can loosen a gate.

Eighteen deterministic rules stand between any idea and the market. The central one reprices the ENTIRE book plus the candidate over a ±20% price grid at the judging horizon, under base and stressed-vol scenarios — a client-side version of the worst-case principle behind Alpaca's universal spread rule. Risk budget grows only from realized gains; the desk de-risks by rule before NFP (deadline morning) and halts — never panic-flattens — on drawdown. Exits: profit targets, a trailing stop, a regime exit, structure and time stops.

Every decision is a hash-chained journal entry; the week replays bit-for-bit, 20 of 20 write-up claims regenerate from the journal, and the store reconciles to the broker's fills to the cent. The DEVLOG records 32 self-corrections — including the desk's most expensive bug ($208), found by replaying its own snapshot and pinned with a test. Orders leave through Alpaca's CLI as multi-leg limits with idempotent client ids. Paper trading only.
```

**Categories:** Finance  
**Track:** Options Alpha Agents  
**Technologies Used:** Alpaca, Featherless, Anthropic Claude, Claude Code, Streamlit, Python, SQLite
