# Step 1 — финальные тексты для формы lablab (обновлено 2026-09-04, день сдачи)

Копируй блоки в кодовых рамках как есть.

**Title:**
```
THETA DESK — Autonomous Options Desk
```

**Short Description (250/255):**
```
An autonomous options desk on Alpaca that doesn't predict prices — it prices the volatility risk premium, sizes only what it has earned, checks its exits every minute, and refuses any trade that fails a 12-gate wall with a portfolio payoff simulator.
```

**Long Description (1990/2000):**
```
Over a five-day competition, price prediction is a coin flip. THETA DESK doesn't flip coins: it prices the volatility risk premium — ATM implied volatility from Alpaca's option chain against 20-day realized volatility — and structures around it. Cheap vol: it buys convexity at micro size (day one: four long puts, three closed at +64-70%). Rich vol: it sells defined-risk iron condors across SPY/QQQ/IWM, least-exposed name first, and harvests theta.

Size is EARNED. Every ceiling is a rung on a ladder the desk climbs with its own record: 2/3/4% of equity per structure at 0/5/15 closed trades, and only while the realized result is non-negative. Drawdown takes rungs back — one at 2%, all at 3.5% — before the 4% halt. The agent cannot vote itself a bigger book.

Two cadences. A tick every fifteen minutes DECIDES; a pass every minute MANAGES what was decided — reconcile, re-mark, exits, closes — and structurally cannot open a position. An exit checked once a quarter-hour has a fifteen-minute hole in it.

Four LLM roles argue every cycle: a Vol Analyst and a devil's-advocate Risk Officer on Claude, an independent Second Opinion on Mistral via Featherless (a different provider, so disagreement is real), a News Vetoer on Qwen. They veto and halve size; they never compute, and no model output can loosen a gate. Today an objection halved a live entry.

Eighteen deterministic rules stand between an idea and the market; the central one reprices the ENTIRE book plus the candidate over a ±20% grid at the judging horizon.

Every decision is a hash-chained journal entry. The week replays bit-for-bit (91/91 snapshots), 20 of 20 write-up claims regenerate from the journal, and the store reconciles to the broker's fills to the cent. 162 tests, 36 logged self-corrections — two found this morning by simulating a session against a fake broker: a one-sided quote silently disabled every exit rule, and the fast loop would have buried the journal that proves all of this. Paper only.
```

**Categories:** Finance
**Track:** Options Alpha Agents
**Technologies Used:** Alpaca, Featherless, Anthropic Claude, Claude Code, Streamlit, Python, SQLite

**Alpaca paper account ID:** `PA39C10YAMYQ`

---

## Что менялось против прошлой версии и почему

- «Eighteen deterministic rules» осталось: это 12 входных гейтов плюс
  paper-only, идемпотентные id, замок такта, гейт качества данных, вето
  деска и правила выхода — ровно как в WRITEUP. Короткое описание говорит
  «12-gate wall» про входную стену. Оба числа честны и не противоречат.
- «32 самокоррекции» → **36**: DEVLOG вырос за день (#35, #36, #36b, #36c).
- Добавлена **лестница размера** — главное отличие от всех троих
  конкурентов, которых я разобрал: у trdrbot размер тоже заработанный, но
  он сверху накидывает коэффициент аппетита ×1.75; у нас потолок нельзя
  превысить ничем.
- Добавлены **две частоты** — прямой ответ на дыру, которая стоила нам
  цели +60% первого сентября.
- Убрано «day one: four long puts; three closed at +64–70% when the market
  slid» → сжато, чтобы влезло. Факт сохранён.
