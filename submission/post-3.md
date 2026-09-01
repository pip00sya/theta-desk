# Пост №3 — «за один вечер нашли три ошибки в живом агенте — две он показал сам»

## Версия для X (тред из 4 твитов)

**1/4**
Day 4 of building THETA DESK for the @AlpacaHQ x @lablabai hackathon.
Tonight, market closed, we audited our own autonomous options agent.

Found three bugs in one hour. One had already fired. 🧵

**2/4**
Bug 1: a whole regime was dead. The "neutral vol" branch widened its strikes
but kept the credit floor of the aggressive one — it could NEVER find a
trade. 21 ticks in a row: "no candidate". Not caution. A rule that couldn't fire.

**3/4**
Bug 2: our laptop lives in UTC+5. Its midnight is 19:00 UTC — an hour
BEFORE the close. Daily counters reset mid-session and the agent closed a
winning put under the wrong rule.

Bug 3: "order accepted" was treated as "filled". The sell never filled.
The book and the broker disagreed. The agent halted itself. Correct — and
it would have stayed halted all week.

**4/4**
The fix that matters: an order is only real when the broker says FILLED.
Every position is now repriced to the actual fill, every number in our
write-up regenerates from the journal, and the desk's News Vetoer blocked
a condor tonight on Iran headlines — the journal shows exactly why.

Paper trading only. Realized so far: $764 on $100k. 25 documented
self-corrections and counting. #AlpacaHackathon #BuildInPublic

## Версия для LinkedIn (один пост)

Tonight, with the market closed, we audited our own autonomous options
agent — and found three bugs in an hour. One of them had already fired.

We're building THETA DESK for the Alpaca AI Trading Agents Hackathon by
lablab.ai: an agent that doesn't predict prices, it prices volatility and
manages a defined-risk options book on Alpaca's paper API. It has 19
deterministic risk gates, four LLM roles that argue and veto, and a
hash-chained journal of every decision.

What we found:

1. A dead regime. The "neutral volatility" branch used wider strikes but
   the same credit floor as the aggressive branch — structurally it could
   never collect enough. Twenty-one ticks of "no candidate" looked like
   discipline. It was a rule that couldn't fire.

2. The wrong midnight. Our host runs in UTC+5, where midnight falls an hour
   BEFORE the exchange closes. Daily counters reset mid-session, and the
   agent closed a winning put under a rule meant for idle days.

3. "Accepted" is not "filled". The close order from bug 2 never executed.
   The store said closed; the broker still held the position. On the next
   cycle the agent detected the mismatch and halted itself — correct
   behaviour — and would have stayed halted until the deadline.

The fix that matters: an order is only real when the broker reports the
fill. Every position is now repriced to the actual fill price, unfilled
orders are cancelled and re-decided, and a reconciliation tool diffs our
books against the broker's fills — it found three more cents-level
discrepancies in earlier trades and corrected them.

Meanwhile the desk did its job. Tonight's candidate — an iron condor —
reached the gate wall twice and was vetoed twice by the News Vetoer on
Iran headlines. Selling premium into a binary event is the wrong trade,
and the journal shows the exact reasoning.

Every one of these is a numbered entry in our DEVLOG — 25 self-corrections
so far, each with what we found and what we changed. That log is the
product as much as the P&L is.

Paper trading only; simulated results, not investment advice. Realized so
far: $764 on a $100k paper account. More as the week unfolds.

#AlpacaHackathon #AITradingAgents #BuildInPublic #OptionsTrading
