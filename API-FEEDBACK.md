# Developer feedback for the Alpaca team

Written while building THETA DESK during the AI Trading Agents Hackathon
(Aug 28 – Sep 4, 2026). Everything below was hit in practice; each item has
a DEVLOG entry with the full story.

## What was excellent

1. **Greeks and IV on the free indicative feed.** The option chain endpoint
   returning Black-Scholes greeks and implied volatility without a paid
   subscription is what made a real risk model possible on a hackathon
   budget. This is a genuinely generous default — advertise it louder.
2. **Paper accounts get options Level 3 by default.** Zero friction from
   signup to a multi-leg iron condor. We had an mleg order accepted within
   hours of account creation.
3. **The CLI is agent-grade.** Exit codes (0/1/2), JSON errors on stderr,
   `--client-order-id` idempotency, raw `alpaca api POST` passthrough —
   our autonomous loop ships orders through it in production. The
   "designed for AI agents" claim holds.

## What cost us time (with repro)

1. **mleg `limit_price` sign convention is under-documented.** Negative =
   net credit received, positive = net debit paid. Our first mleg order
   asked to *collect* ≥ 3.40 but sent `+3.40` — the API read it as *pay ≤
   3.40* and filled instantly at the market's 1.79. Nothing in the order
   response flags the semantic flip. Suggestion: reject positive limit
   prices on orders whose legs net to sell_to_open credit, or at minimum
   document the sign rule prominently on the Level 3 page.
   (DEVLOG #12; order pair `td-mleg-selfcheck-001` / `-close2` on account
   PA39C10YAMYQ, Saturday Aug 29 — market closed.)
2. **Paper fills options orders while the market is closed**, against the
   prior session's quotes. Useful for smoke tests, surprising for anything
   else — a `paper_fill_policy` flag (or a doc note) would help.
3. **`alpaca order submit` has no multi-leg flags.** The workaround
   (`alpaca api POST /v2/orders` with a JSON body) is fine, but first-class
   `--leg` flags would make the CLI the best mleg tool available. We would
   happily contribute the skill doc for it.
4. **Assignment/exercise events don't reach any stream.** Polling
   `/v2/account/activities` works; a websocket event class would remove a
   whole polling loop from agent designs.

## Small paper-realism notes

- Multi-leg limit orders appear to fill as a package against leg NBBO with
  no queue position or partial-leg risk — great for determinism, worth a
  line in the paper-trading docs.
- `portfolio_history` intraday granularity for options-heavy books would
  make judging-style P&L reviews easier for everyone.

— Team Qwertys (THETA DESK), github.com/pip00sya/theta-desk
