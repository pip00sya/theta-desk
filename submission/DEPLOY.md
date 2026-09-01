# Деплой дашборда на Streamlit Cloud — 3 минуты, нужен твой GitHub-логин

Дашборд читает закоммиченный снапшот базы (dashboard/state.sqlite) и журнал —
живые ключи в облако НЕ идут, ничего секретного не публикуется.

## Шаги (один раз)
1. Открой https://share.streamlit.io и нажми **Sign in with GitHub** (pip00sya)
2. **Create app** → выбери репозиторий `pip00sya/theta-desk`, ветка `master`
3. Main file path: `dashboard/app.py` → **Deploy**
4. Через ~2 минуты получишь URL вида `https://<name>.streamlit.app` —
   это и есть Demo URL для сабмита. Пришли его мне — впишу в черновик.

## Обновление данных на дашборде (перед сабмитом в пятницу)
Мне достаточно одной команды (`make snapshot-dashboard` + push) —
Streamlit Cloud подхватит пуш и перезапустится сам.

## Статус (1 сен)
- Репозиторий `pip00sya/theta-desk` — **публичный** с 1 сентября
- Дашборд задеплоен: https://theta-desk.streamlit.app (judge mode: `?judge=1`)
- Обновление данных: `make snapshot-dashboard` → commit → push; Streamlit
  Cloud подхватывает пуш и перезапускается сам
