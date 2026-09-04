"""Опросить живые дашборды соперников и вытащить заявленный equity/P&L."""
import concurrent.futures as cf, json, re, sys, urllib.request, urllib.error

URLS = json.load(open("demos.json", encoding="utf-8"))
MONEY = re.compile(r'\$\s?1[0-9]{2}[,.][0-9]{3}(?:\.[0-9]{2})?')          # $1xx,xxx
PCT   = re.compile(r'[+\-−]\s?\d{1,2}\.\d{1,2}\s?%')
PNL   = re.compile(r'(equity|portfolio value|net liq|p&l|pnl|profit|return|balance)[^\n]{0,80}', re.I)

def probe(item):
    k, u = item
    try:
        req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=12) as r:
            body = r.read(400_000).decode("utf-8", "replace")
            code = r.status
    except Exception as e:
        return k, u, "DEAD", type(e).__name__, [], []
    txt = re.sub(r"<script[^>]*>.*?</script>", " ", body, flags=re.S | re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = re.sub(r"\s+", " ", txt)
    return k, u, code, len(body), MONEY.findall(txt)[:6], [m.strip()[:70] for m in PNL.findall(txt)[:3]]

rows = []
with cf.ThreadPoolExecutor(max_workers=14) as ex:
    for res in ex.map(probe, URLS.items()):
        rows.append(res)
alive = [r for r in rows if r[2] != "DEAD"]
hits  = [r for r in alive if r[4]]
print(f"опрошено {len(rows)}, ответили {len(alive)}, с денежными числами {len(hits)}\n")
for k, u, code, n, money, ctx in sorted(hits, key=lambda r: r[0]):
    print(f"{k.split('/')[1][:32]:<34} {money}")
    if ctx: print(f"    {ctx[0][:90]}")
