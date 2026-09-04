# ПОДАЧА — всё в одном месте

Кто подаёт: тот, у кого есть submission permission в команде Qwertys.
Форма пишет «Ask your team admin to grant you submission permission», значит
нужен админ (вероятно **Shakhnazar / eye172**).

Копируй блоки в рамках как есть. Ничего не сокращай — всё уже подогнано под
лимиты символов.

---

## 1. Team Idea — ЗАМЕНИТЬ (сейчас там неверное «17-gate»)

```
THETA DESK: an autonomous options desk on Alpaca. It doesn't predict prices — it prices the volatility risk premium and runs a two-sleeve book: theta-earning iron condors hedged by a convexity tail. Size is earned, never voted: ceilings climb a ladder with the desk's own closed-trade record and fall back on drawdown. Every order must survive a 12-gate risk wall including a portfolio payoff simulator that reprices the whole book first, and every exit is re-checked every minute by a loop that cannot open a position. Every decision lands in a hash-chained journal and replays bit-for-bit. Built by Qwertys with Claude + Featherless on Alpaca's Trading API, MCP server and CLI.
```

## 2. Title

```
THETA DESK — Autonomous Options Desk
```

## 3. Short Description (250/255)

```
An autonomous options desk on Alpaca that doesn't predict prices — it prices the volatility risk premium, sizes only what it has earned, checks its exits every minute, and refuses any trade that fails a 12-gate wall with a portfolio payoff simulator.
```

## 4. Long Description (1990/2000)

```
Over a five-day competition, price prediction is a coin flip. THETA DESK doesn't flip coins: it prices the volatility risk premium — ATM implied volatility from Alpaca's option chain against 20-day realized volatility — and structures around it. Cheap vol: it buys convexity at micro size (day one: four long puts, three closed at +64-70%). Rich vol: it sells defined-risk iron condors across SPY/QQQ/IWM, least-exposed name first, and harvests theta.

Size is EARNED. Every ceiling is a rung on a ladder the desk climbs with its own record: 2/3/4% of equity per structure at 0/5/15 closed trades, and only while the realized result is non-negative. Drawdown takes rungs back — one at 2%, all at 3.5% — before the 4% halt. The agent cannot vote itself a bigger book.

Two cadences. A tick every fifteen minutes DECIDES; a pass every minute MANAGES what was decided — reconcile, re-mark, exits, closes — and structurally cannot open a position. An exit checked once a quarter-hour has a fifteen-minute hole in it.

Four LLM roles argue every cycle: a Vol Analyst and a devil's-advocate Risk Officer on Claude, an independent Second Opinion on Mistral via Featherless (a different provider, so disagreement is real), a News Vetoer on Qwen. They veto and halve size; they never compute, and no model output can loosen a gate. Today an objection halved a live entry.

Eighteen deterministic rules stand between an idea and the market; the central one reprices the ENTIRE book plus the candidate over a ±20% grid at the judging horizon.

Every decision is a hash-chained journal entry. The week replays bit-for-bit (91/91 snapshots), 20 of 20 write-up claims regenerate from the journal, and the store reconciles to the broker's fills to the cent. 162 tests, 36 logged self-corrections — two found this morning by simulating a session against a fake broker: a one-sided quote silently disabled every exit rule, and the fast loop would have buried the journal that proves all of this. Paper only.
```

## 5. Ссылки

| поле | значение |
|---|---|
| **Demo / App URL** | `https://theta-desk.streamlit.app` |
| **GitHub (основной)** | `https://github.com/pip00sya/theta-desk` |
| **GitHub (хакатон)** | `https://github.com/Eye172/alpaca-ai-trading-agents-hackathon` |
| **Alpaca paper account ID** | `PA39C10YAMYQ` |

## 6. Файлы для загрузки

Все лежат в `theta-desk/submission/`:

| поле формы | файл |
|---|---|
| Cover image | `cover.png` |
| Presentation | `slides.pdf` |
| Video | `theta-desk-video.mp4` (5:44, 10.2 МБ) |

Если видео просят ссылкой, а не файлом — залей на YouTube как unlisted и
вставь ссылку.

## 7. Категории

- **Categories:** Finance
- **Track:** Options Alpha Agents
- **Technologies Used:** Alpaca, Featherless, Anthropic Claude, Claude Code, Streamlit, Python, SQLite

## 8. Social posts (extra challenge, до 5 ссылок)

Черновики в `submission/post-1.md`, `post-2.md`, `post-3.md` — если они уже
опубликованы, вставь ссылки; если нет, поле необязательное.

---

## Что судья увидит, если пойдёт проверять

- Дашборд живой: тики каждые 15 минут, управляющий проход каждую минуту,
  read-only пульс каждые 3 секунды. Цифры не зашиты — страница читает
  экспорт, который пересобирается после каждого тика.
- `python tools/reconcile.py` — 20/20 утверждений из write-up, без ключей.
- `python tools/replay.py` — 91/91 снимков воспроизводятся бит-в-бит.
- `python -m pytest tests -q` — 162 теста.
- `python tools/reality_check.py` — 25 цифр сверены со счётом, базой и
  журналом по независимому маршруту (нужны ключи).
