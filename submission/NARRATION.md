# THETA DESK — narration script with timecodes

Total 6:56. Timecodes are the real rendered segment boundaries, so if you
record to these marks the audio drops straight onto the existing cut.

Read at a measured pace. **Bold** = press slightly. An em dash — is a short
beat. A blank line is a full second of silence.

| # | In | Out | Len | On screen |
|---|---|---|---|---|
| 1 | 0:00 | 0:24 | 24s | Cover |
| 2 | 0:24 | 1:06 | 42s | Slide — both branches fired |
| 3 | 1:06 | 1:58 | 52s | Slide — architecture, two clocks |
| 4 | 1:58 | 2:30 | 32s | Slide — the payoff simulator |
| 5 | 2:30 | 3:07 | 38s | Frame — event shield, live |
| 6 | 3:07 | 4:08 | 61s | **Slide — earned size** ⭐ |
| 7 | 4:08 | 4:56 | 48s | Frame — ablation chart |
| 8 | 4:56 | 5:45 | 49s | **Frame — the live console** ⭐ |
| 9 | 5:45 | 6:09 | 24s | Frame — verification terminal |
| 10 | 6:09 | 6:36 | 28s | Frame — account board |
| 11 | 6:36 | 6:56 | 20s | Cover |

---

## 1 · 0:00 – 0:24 — Thesis

Over a five day competition, price prediction is a coin flip.

So our agent doesn't predict prices. THETA DESK is an autonomous options desk
on Alpaca that prices **volatility itself** — the gap between what the market
implies and what it actually delivers.

Everything you're about to see was designed, built and operated end to end by
AI. Paper trading only.

---

## 2 · 0:24 – 1:06 — Both branches fired, live

Here's the proof this is a system and not a story.

Our own plan said: sell iron condors, harvest theta. On day one the live
signal disagreed — realized volatility was **above** implied. Premium was
cheap, and selling it would have been negative edge.

The agent went against our plan and bought convexity instead. The market
slid, and three of those four puts closed at **plus sixty four to seventy
percent**.

Two days later realized vol collapsed, the regime flipped rich, and the desk
sold its first iron condors — the structure it was actually built for.

Both branches fired on their own signal, and every decision is in a hash
chained journal.

---

## 3 · 1:06 – 1:58 — Two clocks

The desk runs on **two clocks**.

Every fifteen minutes it **decides**. Every single minute it **manages** what
it already decided — reconciles with the broker, reprices the book, checks
every exit.

That fast loop structurally **cannot open a position**. We built it because
an exit checked once a quarter hour is an exit with a fifteen minute hole in
it — and one of our own positions fell straight through that hole.

On the slow clock, four language model roles argue about the same numbers. A
volatility analyst on Claude. An independent second opinion on an open
Mistral model — different providers, so the disagreement is real. A news
vetoer. And a risk officer whose only job is to attack the trade.

They can veto the day and shrink the size. What they **cannot** do is loosen
a single risk gate.

---

## 4 · 1:58 – 2:30 — The central gate

Twelve deterministic gates stand between an idea and the market, and the
central one is the desk's veto right.

Before any order, the **entire book** plus the candidate is repriced over a
twenty percent price grid at the judging horizon, under a stressed volatility
scenario.

If the worst case breaches budget, the order is never sent — and the refusal
is journaled with the full grid attached.

It's a client side implementation of the same worst case principle behind
Alpaca's universal spread rule for options margin, applied one step earlier.

---

## 5 · 2:30 – 3:07 — The event shield

Here is the desk deciding on its own, with nobody at the keyboard.

The jobs report was landing the next morning. The desk measured how close
each position's short strike sat to the market — **not in percent**, but in
units of the daily move the option market itself was pricing.

Two S and P condors sat inside one and a half of those moves. Two Nasdaq
condors sat almost three away.

It closed the two a gap would reach, kept the two it would not, and wrote the
reason into the journal in plain language. A blanket flatten would have paid
the spread on four positions to protect two.

---

## 6 · 3:07 – 4:08 — Earned size ⭐ the argument

Now the part we're least comfortable saying out loud, because it's the honest
one.

We made six hundred dollars. That sounds small — until you ask what it was
made **on**. Six hundred came off three thousand one hundred and sixty five
dollars of risk that actually closed. That's **nearly nineteen percent** on
the capital we genuinely put at risk.

And across the whole week the book only ever carried **four point eight five
percent** of equity. So the constraint was never the quality of the
decisions — it was how few dollars each correct decision was allowed to move.

We were never behind on decisions. We were behind on **size**, and we can
point at the exact line. Our ceiling was one and a quarter percent of equity
per structure. A ten dollar wide index condor costs eight hundred and thirty
for a **single** contract — so a second one never fit. Every position we ever
opened went out at one lot. Not by choice. By arithmetic.

So size is now **earned**. Two, three, then four percent, at zero, five and
fifteen closed trades, and only while the realized result is non negative.
Drawdown takes the rungs back before the halt does.

The agent cannot vote itself a bigger book.

---

## 7 · 4:08 – 4:56 — Live ablation

We didn't just claim the design matters. We measured it, live.

Four books run on identical inputs. The real agent. The same strategy with
the gates ignored. The book without its hedge. And a naive baseline that
reads a headline and buys an option — the median hackathon strategy.

Being precise about what that shows: the shadow books never take profits, so
they're a **bound**, not a like for like P and L. We publish that caveat in
the same breath as the number.

The gates refused a hundred and eleven candidates this week — on liquidity,
on the daily budget, on the session edges, and before the jobs report. The
unmanaged book of everything they let through **and** everything they refused
is deep in the red, while the gated book is green.

The gates are load bearing.

---

## 8 · 4:56 – 5:45 — The live console ⭐ the proof

And this is the desk itself, mid session, with the market open.

Nothing on this page is typed. The ceilings read from the ladder — rung
establish, six closed trades, five hundred and ninety eight dollars banked,
next rung at fifteen. Beside the last tick it says thirty four management
passes today, because the fast loop writes its own count.

And on the right, the audit log shows this afternoon's entry clearing every
gate at two o'clock — **one line above** yesterday's refusal on the very
liquidity rule we replaced this morning, after measuring that it was
rejecting wings that cost one dollar to cross.

Refusals and entries sit in the same stream, in the same plain language,
because a desk that only shows you its trades is showing you half its
behaviour.

---

## 9 · 5:45 – 6:09 — Reproducibility

Everything here is reproducible.

The journal is hash chained — change one byte and verification fails. Every
tick stores its inputs, and one command replays the entire week bit for bit:
ninety one snapshots out of ninety one.

Another command regenerates every number in our write up. Twenty out of
twenty claims, zero mismatches, no credentials required. A hundred and
sixty two tests.

---

## 10 · 6:09 – 6:36 — The result

The result, on paper account P A three nine C one zero Y A M Y Q: a small,
explained, risk boxed P and L.

Every position is defined risk. The worst case this book ever carried never
left three and a half percent of equity. And the jobs report that landed on
deadline morning was de-risked by rule the day before — the desk opened
nothing that Thursday, by design.

---

## 11 · 6:36 – 6:56 — Close

THETA DESK. **Language models decide whether it's wise. Code decides whether
it's allowed.**

Built on Alpaca's Trading API, M C P server and C L I, by team Qwertys.

Hypothetical paper trading results — not investment advice. Thanks for
watching.

---

## Recording notes

- Segment 6 is the argument. Slow down there, especially on
  "Not by choice. By arithmetic."
- Read the account as letters: "P A three nine C one zero Y A M Y Q".
- Record one continuous take with two seconds of silence between segments;
  the boundaries above are where the cut already falls.
- If you fluff a line, don't restart — pause two seconds and say it again.
