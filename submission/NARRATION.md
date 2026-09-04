# Текст для озвучки — THETA DESK

Читай ровно, без спешки. В скобках — что на экране, вслух не читать.
Общий хронометраж при спокойном темпе ≈ 5:30–6:00.

Ударные места выделены **жирным** — их чуть подчеркни голосом.
Тире — короткая пауза. Пустая строка — пауза в секунду.

---

## 1 — Обложка (~25 сек)

Over a five day competition, price prediction is a coin flip.

So our agent doesn't predict prices. THETA DESK is an autonomous options
desk on Alpaca that prices **volatility itself** — the gap between what the
market implies and what it actually delivers.

Everything you're about to see was designed, built and operated end to end
by AI. Paper trading only.

---

## 2 — Обе ветки сработали вживую (~50 сек)

Here's the proof this is a system, not a story.

Our own plan said: sell iron condors, harvest theta. But on day one the live
signal disagreed — realized volatility was **above** implied. Premium was
cheap. Selling it would have been negative edge.

The agent went against our plan and bought convexity instead. The market
slid, and three of those four puts closed at **plus sixty four to seventy
percent**.

Two days later realized vol collapsed, the regime flipped rich, and the desk
sold its first iron condors — the structure it was actually built for.

Both branches fired, live, on their own signal. Every decision is in a hash
chained journal.

---

## 3 — Две частоты (~45 сек)

The desk runs on **two clocks**.

Every fifteen minutes it **decides**. Every single minute it **manages** what
it already decided — reconciles with the broker, reprices the book, checks
every exit.

That fast loop structurally **cannot open a position**. We built it because
an exit checked once a quarter hour is an exit with a fifteen minute hole in
it — and one of our own positions fell straight through that hole.

On the slow clock, four language model roles argue about the same numbers.
A volatility analyst on Claude. An independent second opinion on an open
Mistral model — different providers, so the disagreement is real. A news
vetoer. And a risk officer whose only job is to attack the trade.

They can veto the day and shrink the size. What they **cannot** do is loosen
a single risk gate.

---

## 4 — Центральный гейт (~35 сек)

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

## 5 — Щит перед событием (~45 сек)

Here is the desk deciding on its own, with nobody at the keyboard.

The jobs report was landing the next morning. The desk measured how close
each position's short strike sat to the market — **not in percent**, but in
units of the daily move the option market itself was pricing.

Two S and P condors sat inside one and a half of those moves. Two Nasdaq
condors sat almost three away.

It closed the two a gap would reach, kept the two it would not, and wrote the
reason into the journal in plain language.

A blanket flatten would have paid the spread on four positions to protect two.

---

## 6 — НОВЫЙ. Размер зарабатывается (~60 сек) ⭐ главный слайд

Now the part we're least comfortable saying out loud, because it's the honest
one.

We made six hundred dollars. That sounds small — until you ask what it was
made **on**. Six hundred dollars came off three thousand one hundred and
sixty five dollars of risk that actually closed. That's **nearly nineteen
percent** on the capital we genuinely put at risk.

We were never behind on decisions. We were behind on **size**. And we can
point at the exact line.

Our ceiling was one and a quarter percent of equity per structure. That's
twelve hundred dollars. A ten dollar wide index condor costs eight hundred
and thirty for a **single** contract — so a second one never fit. Every
position we ever opened went out at one lot. Not by choice. By arithmetic.

So size is now **earned**. Two, three, then four percent per structure, at
zero, five and fifteen closed trades — and only while the realized result is
non negative. Drawdown takes the rungs back before the halt does.

The agent cannot vote itself a bigger book.

---

## 7 — Абляция (~55 сек)

We didn't just claim the design matters. We measured it, live.

Four books run on identical inputs. The real agent. The same strategy with
the gates ignored. The book without its hedge. And a naive baseline that
reads a headline and buys an option — the median hackathon strategy.

Being precise about what that shows: the shadow books never take profits, so
they're a **bound**, not a like for like P and L. We publish that caveat in
the same breath as the number.

The gates refused forty four entries this week — on liquidity, on the daily
budget, on the session edges, and before the jobs report. The unmanaged book
of everything they let through **and** everything they refused is deep in the
red, while the gated book is green.

The gates are load bearing.

---

## 8 — Воспроизводимость (~30 сек)

Everything here is reproducible.

The journal is hash chained — change one byte and verification fails. Every
tick stores its inputs, and one command replays the entire week, bit for bit:
ninety one snapshots out of ninety one.

Another command regenerates every number in our write up. Twenty out of
twenty claims. Zero mismatches. No credentials required.

One hundred and sixty two tests. Thirty six logged self corrections —
including two we found this morning, by simulating a whole session against a
fake broker before the market opened.

---

## 9 — Результат и закрытие (~35 сек)

The result, on paper account P A three nine C one zero Y A M Y Q: a small,
explained, risk boxed P and L. Every position defined risk. The worst case
the book ever carried never left three and a half percent of equity.

THETA DESK. **Language models decide whether it's wise. Code decides whether
it's allowed.**

Built on Alpaca's Trading API, M C P server and C L I, by team Qwertys.

Hypothetical paper trading results — not investment advice. Thanks for
watching.

---

## Подсказки по записи

- Сегмент 6 — самый важный. Там признание слабости, которое становится
  силой. Читай медленнее остальных, особенно «Not by choice. By arithmetic.»
- «P A three nine C one zero Y A M Y Q» — читай по буквам, не слитно.
- Числа «sixty four to seventy percent», «nineteen percent» — чуть громче.
- Если сбился — не начинай заново, просто повтори фразу; я вырежу.
- Пиши одним файлом, паузы между сегментами 2 секунды — я нарежу по ним.
