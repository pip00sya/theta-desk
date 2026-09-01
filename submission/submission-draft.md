# Черновик сабмита lablab — все поля формы

## Step 1 — Basic Information

**Submission Title** (5–50 символов; сейчас 37):
```
THETA DESK — Autonomous Options Desk
```

**Short Description** (50–255; сейчас ~219):
```
An autonomous options desk on Alpaca that doesn't predict prices — it prices the volatility risk premium, runs a hedged two-sleeve book, and refuses any trade that fails a 17-gate risk wall with a portfolio payoff simulator.
```

**Long Description** (600–2000 символов; сейчас ~1450):
```
Over a five-day competition, price prediction is a coin flip. THETA DESK doesn't flip coins: it prices the volatility risk premium — ATM implied volatility from Alpaca's option chain against 20-day realized volatility — and structures around it. When volatility is rich it sells defined-risk iron condors and harvests theta; when it is cheap (as the live signal showed on day one), it switches regimes on its own and buys convexity instead.

Four LLM roles run every cycle on open models via Featherless AI: a Vol Analyst (Qwen2.5-72B), an independent Second Opinion (Mistral-Small-24B — a different model family, so disagreement is real), a News Vetoer, and a mandated devil's-advocate Risk Officer. They argue, veto and size — but they never compute, and no model output can loosen a gate.

Seventeen deterministic risk gates stand between any idea and the market. The central one reprices the ENTIRE book plus the candidate over a ±20% price grid at the judging horizon, under base and stressed-vol scenarios — a client-side implementation of the same worst-case principle as Alpaca's universal spread rule. The agent earns extra risk budget only from realized gains, de-risks by rule before NFP (which lands on deadline morning), and halts — never panic-flattens — on drawdown.

Every decision is a hash-chained journal entry; the whole week replays bit-for-bit with one command, and every number in our write-up regenerates from the journal. Built on Alpaca's Trading API, MCP server and CLI (multi-leg mleg orders with idempotent client order ids). Paper trading only.
```

**Categories:** Finance
**Event Tracks:** Options Alpha Agents
**Technologies Used:** Alpaca, Featherless, Claude Code, Python, Streamlit, SQLite

**Social Media Post Link 1–5:**
1. https://x.com/nnutlanrt/status/2094813503999943071 (X, пост №1 — опубликован 2 сен)
2. https://www.linkedin.com/feed/update/urn:li:share:7500579705809592320/ (LinkedIn, пост №1 — опубликован 2 сен)
3. https://x.com/nnutlanrt/status/2094828957246144643 (X, пост №2 с карточкой «agent vs coin flip» — 2 сен)
4. https://lnkd.in/p/dPqeCdjf (LinkedIn, пост №2 с карточкой — 2 сен)
5. https://lnkd.in/p/d5z22VuY (LinkedIn, пост Бердиали с карточкой — 2 сен)

СТРАТЕГИЯ (решение Нурхана 02.09): команда продолжает постить всю неделю
без ограничений; 5 ссылок выше — предварительные. В пятницу перед сабмитом
собрать ВСЕ посты команды (Нурхан, Шахназар, Бердиали), сравнить охват
(лайки+комменты+репосты+просмотры) и вписать в форму 5 сильнейших.
Напоминание себе: спросить у Нурхана ссылки на новые посты в пятницу утром.

## Step 2 — Media (день 5)
- Cover image: PNG/JPG 16:9 — TODO
- Video: MP4 ≤5 мин ≤300MB — TODO
- Slides: PDF — TODO

## Step 3 — Technical
- GitHub: https://github.com/pip00sya/theta-desk ✅ (публичный со 2 сен)
- Demo Platform: Streamlit
- Demo URL: https://theta-desk.streamlit.app ✅ (задеплоен 2 сен)
- Judge Mode: https://theta-desk.streamlit.app/?judge=1
- **Alpaca paper account ID: PA39C10YAMYQ** ← в поле Additional Information / отдельное поле
