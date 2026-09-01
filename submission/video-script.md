# Сценарий видео — 5 минут, MP4, ≤300 MB

Записывать: OBS Studio (бесплатно) или Xbox Game Bar (Win+G). Экран 1920×1080.
Язык озвучки: английский (судьи международные). Текст ниже — читать почти дословно,
темп спокойный. Что показывать — в правой колонке. Прогнать один раз на черновик.

## Подготовка перед записью (5 минут)
1. `streamlit run dashboard/app.py` — открыть дашборд, вкладка Equity & ablation
2. Второе окно: терминал в репо (шрифт покрупнее, Ctrl+= в Windows Terminal)
3. Третье окно: браузер с Alpaca dashboard (paper, позиции видны)
4. Полноэкранный VS Code с engine/gates.py и engine/payoff.py

| Время | Говорим (EN) | Показываем |
|---|---|---|
| 0:00–0:25 | "Over a five-day competition, price prediction is a coin flip. So our agent doesn't predict prices. THETA DESK is an autonomous options desk that prices volatility itself — the gap between implied and realized. I'm from team Qwertys, and everything you'll see was built and is operated end-to-end by AI." | Обложка (cover.png) 3 сек → дашборд, титульные метрики |
| 0:25–1:00 | "Here's the proof it's real, not a narrative. Our plan said: sell iron condors, harvest theta. On day one the live signal said realized vol was ABOVE implied — premium was cheap, selling it would be negative edge. The agent went against our own plan and bought convexity instead. That decision — and every decision since — is in a hash-chained journal." | Дашборд → Decision feed, разворачиваем запись `desk` с голосами и запись `order_open` первого пута |
| 1:00–1:50 | "Every 15 minutes the desk runs one cycle. Four LLM roles argue: a Vol Analyst on Claude, an independent Second Opinion on an open Mistral model — different providers, so disagreement is real; a News Vetoer; and a Risk Officer whose only job is to attack the trade. They can veto and shrink size. They can NOT loosen a single risk gate — eighteen of them, all deterministic Python." | Слайд 3 (архитектура) → VS Code, файл gates.py, скроллим список гейтов |
| 1:50–2:40 | "The central gate is the desk's veto right. Before ANY order, the entire book plus the candidate is repriced over a ±20% price grid at the judging horizon, under a stressed-vol scenario. If the worst case breaches budget, the order is never sent. This is a client-side implementation of the same worst-case principle as Alpaca's own universal spread rule for options margin — applied one step earlier. Here is a real refusal, journaled with its reason." | payoff.py кратко → дашборд Gates: показать REFUSED запись с worst case |
| 2:40–3:20 | "We didn't just claim our design matters — we measured it. Four books run live on the same inputs: the real agent; the same strategy with gates ignored; the book without its hedge; and a naive baseline that reads a headline and buys an option — the median hackathon strategy. The baseline lost money all week. Ours didn't." | Дашборд Equity & ablation: 4 кривые, навести на baseline_naive |
| 3:20–4:00 | "Everything is reproducible. The journal is hash-chained — edit one byte and verification fails. Every tick stores its inputs; one command replays the whole week bit-for-bit. Another regenerates every number in our write-up. And our DEVLOG documents sixteen self-corrections — including discovering that Alpaca's multi-leg limit price is signed, the hard way, in a weekend acceptance test." | Терминал вживую: `make verify` → зелёные строки chain/replay/reconcile. DEVLOG.md скролл |
| 4:00–4:35 | "The result: a small, explained, risk-boxed P&L on account PA-39-C-10-YAMYQ — every position defined-risk, book worst case capped, sizes that grow only from realized gains, and the NFP release on deadline morning de-risked by rule the day before." | Alpaca dashboard: позиции и equity → дашборд: греки книги |
| 4:35–5:00 | "THETA DESK: LLMs decide whether it's wise, code decides whether it's allowed. Built on Alpaca's Trading API, MCP server and CLI. Paper trading only, hypothetical results, not investment advice. Thanks for watching." | Обложка + GitHub URL. Конец |

## Технические требования
- MP4, ≤ 5:00, ≤ 300 MB (1080p/30fps в OBS с битрейтом 6000 ≈ 220 MB на 5 мин — ок)
- Микрофон ближе, эхо меньше; фоновую музыку не надо
- Если оговорка — не перезаписывай всё, монтаж склейкой в Clipchamp (встроен в Windows)
