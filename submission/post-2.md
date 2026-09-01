# Пост №2 — «агент, который умеет отказываться» (ср/чт)

## X (тред 2 твита)

**1/2**
Day 3 of building THETA DESK for @AlpacaHQ x @lablabai.

Our agent's most important feature isn't a trade — it's a refusal.

Before ANY order, it reprices the ENTIRE book over a ±20% price grid under
stressed vol. Worst case breaches budget → order never leaves the machine.

**2/2**
It's a client-side cousin of Alpaca's own universal spread rule for
options margin — applied one step earlier.

Meanwhile the live ablation tells the story:
📗 our book: green
📕 naive "read headline, buy option" baseline: red all week

LLMs argue. Code decides. Paper only.
#AlpacaHackathon #BuildInPublic

## LinkedIn

The most valuable thing our trading agent did this week was refuse an order.

THETA DESK (our entry for the Alpaca AI Trading Agents Hackathon by
lablab.ai) runs a portfolio payoff simulator before every single order:
the whole book plus the candidate is repriced across a ±20% underlying
grid, under a stressed-volatility scenario, at the judging horizon. If the
worst-case loss breaches the risk budget, the order is never sent — and
the refusal is written into a hash-chained journal with the full grid
attached.

That's the design thesis in one feature: our four LLM roles (Claude + open
models via Featherless AI) argue, veto and size — but not one of them can
loosen a deterministic gate.

And we measure the difference live: four books run on identical inputs —
the real agent, the same strategy without gates, without its hedge, and a
naive headline-driven baseline. The baseline has been red all week.

Built on Alpaca's Trading API, MCP server and CLI. Paper trading only —
hypothetical results, not investment advice.

@Alpaca @lablab.ai #AlpacaHackathon #AITradingAgents #BuildInPublic

# Пост №3 — итоговый (пятница, после сабмита) — заполнить числами
Каркас: финальный P&L и кривая → «что сделал агент за неделю» в 4 цифрах
(сделки/отказы/фиксации/LLM-голоса) → make verify зелёный скрин →
ссылка на репо + дашборд → благодарности @AlpacaHQ @lablabai.
