"""Social card: live ablation curves + hero stat, rendered to PNG."""
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUB = ROOT / "submission"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

conn = sqlite3.connect(ROOT / "data" / "thetadesk.sqlite")
series = {}
for book in ("real", "baseline_naive"):
    rows = conn.execute(
        "SELECT unrealized + COALESCE(realized,0) FROM marks WHERE book=? ORDER BY ts",
        (book,)).fetchall()
    series[book] = [float(r[0]) for r in rows]

n = max(len(v) for v in series.values())
lo = min(min(v) for v in series.values()) - 40
hi = max(max(v) for v in series.values()) + 40
W, H = 1380, 350


def path(vals):
    pts = [f"{i * W / (n - 1):.1f},{H - (v - lo) * H / (hi - lo):.1f}"
           for i, v in enumerate(vals)]
    return "M" + " L".join(pts)


zero = H - (0 - lo) * H / (hi - lo)
real_last, naive_last = series["real"][-1], series["baseline_naive"][-1]

html = f"""<meta charset="utf-8"><style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ width:1600px; height:900px; overflow:hidden; background:#0b0f1a; color:#e8ecf4;
       font-family:'Segoe UI',sans-serif; position:relative; padding:76px 90px; }}
.grid {{ position:absolute; inset:0;
  background-image:linear-gradient(rgba(90,120,200,.07) 1px, transparent 1px),
                   linear-gradient(90deg, rgba(90,120,200,.07) 1px, transparent 1px);
  background-size:48px 48px; }}
.z {{ position:relative; z-index:2; }}
.k {{ font-size:21px; letter-spacing:.16em; color:#7f96c9; text-transform:uppercase; }}
h1 {{ font-size:66px; font-weight:800; margin-top:10px; color:#fff; }}
h1 b {{ background:linear-gradient(92deg,#7aa2ff,#35e0b0); -webkit-background-clip:text;
       -webkit-text-fill-color:transparent; }}
.leg {{ display:flex; gap:46px; margin:26px 0 6px; }}
.leg div {{ display:flex; align-items:center; gap:12px; font-size:27px; color:#c7d2ea; }}
.sw {{ width:38px; height:7px; border-radius:4px; }}
.foot {{ position:absolute; bottom:56px; left:90px; right:90px; display:flex;
        justify-content:space-between; font-size:23px; color:#6d81ad; z-index:2 }}
.foot b {{ color:#b9c6e2; }}
</style>
<div class="grid"></div><div class="z">
<div class="k">Θ THETA DESK · autonomous options desk · day 3 of the Alpaca AI Trading Agents Hackathon</div>
<h1>Our agent <b>vs</b> the coin flip — live, same inputs</h1>
<div class="leg">
  <div><div class="sw" style="background:#35e0b0"></div>THETA DESK
       <b style="color:#35e0b0">{real_last:+,.0f}$</b></div>
  <div><div class="sw" style="background:#ff7a7a"></div>naive "read a headline, buy an option"
       <b style="color:#ff7a7a">{naive_last:+,.0f}$</b></div>
</div>
<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <line x1="0" y1="{zero:.0f}" x2="{W}" y2="{zero:.0f}" stroke="#3a4a72"
        stroke-width="2" stroke-dasharray="8 8"/>
  <path d="{path(series['baseline_naive'])}" fill="none" stroke="#ff7a7a" stroke-width="4" opacity=".85"/>
  <path d="{path(series['real'])}" fill="none" stroke="#35e0b0" stroke-width="6"/>
</svg>
<div class="foot">
  <div>18 risk gates · 4 LLM roles · every decision replays bit-for-bit · <b>paper trading only</b></div>
  <div><b>Team Qwertys</b> · Alpaca × lablab.ai</div>
</div></div>"""

p = SUB / "social-card.html"
p.write_text(html, encoding="utf-8")
png = SUB / "social-card.png"
subprocess.run([EDGE, "--headless", "--disable-gpu",
                f"--user-data-dir={ROOT / 'submission' / '_video' / 'edgeprof'}",
                f"--screenshot={png}", "--window-size=1600,900", p.as_uri()],
               capture_output=True)
print("PNG:", png.exists(), png.stat().st_size if png.exists() else 0)
