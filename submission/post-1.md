# Пост №1 — «первая сделка пошла против нашего же плана»

## Версия для X (постить тредом из 3 твитов)

**1/3**
Building THETA DESK for the @AlpacaHQ x @lablabai hackathon: an autonomous
options desk that doesn't predict prices — it prices volatility itself.

Day 1 story: our agent's first live trade went AGAINST our own plan. 🧵

**2/3**
The plan said: sell iron condors, harvest theta.
The signal said: 20-day realized vol (13.9%) > implied (11.6%).
Premium is CHEAP. Selling it = negative edge.

So the agent bought vega instead: 1 long SPY put, risk capped at 0.38% of
equity. The system follows the signal, not the narrative.

**3/3**
Under the hood: 17 deterministic risk gates, a portfolio payoff simulator
that reprices the whole book before every order, and a hash-chained decision
journal that replays bit-for-bit.

LLMs argue and veto. Code decides. Paper trading only.

#AlpacaHackathon #TradingAgents #BuildInPublic

## Версия для LinkedIn (один пост)

Our agent's first live trade went against our own plan — and that's exactly
what we wanted.

We're building THETA DESK for the Alpaca AI Trading Agents Hackathon by
lablab.ai: an autonomous options desk on Alpaca's paper trading API. The
design thesis: over a 5-day competition, price prediction is a coin flip —
so our agent doesn't predict prices. It prices the volatility risk premium
(implied vs realized volatility) and structures around it.

Day 1: the plan called for selling iron condors to harvest theta. But the
live signal showed realized volatility (13.9%) ABOVE implied (11.6%) —
premium is cheap, selling it has negative expected edge. The agent switched
regimes on its own and bought a small long put instead: defined risk, 0.38%
of equity, full decision trail recorded.

What makes this a desk and not a bot:
• 17 deterministic risk gates — the LLM roles (Claude + open models via
  Featherless AI) argue, veto and size, but they cannot loosen a single gate
• A portfolio payoff simulator reprices the ENTIRE book over a ±20% price
  grid before every order — a client-side cousin of Alpaca's own
  universal spread rule for options margin
• A hash-chained journal: every decision replays bit-for-bit with one command

Built with Alpaca's Trading API, MCP server and CLI. Paper trading only —
simulated results, not investment advice.

More as the week unfolds. @Alpaca @lablab.ai

#AlpacaHackathon #AITradingAgents #BuildInPublic #OptionsTrading
