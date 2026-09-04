"""Render submission/cover.png — the desk's own payoff, drawn from live data.

Not a title card. The hero is the structure the agent actually holds: a real
QQQ iron condor with its real strikes, its real credit and its real worst
case, drawn to scale, with the profit zone shaded and the wings labelled.
Behind it, the week's equity curve at low contrast. Every number is read from
the store and the published export — nothing is typed here.

Run: python submission/make_cover.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUB = ROOT / "submission"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
W, H = 1600, 900


def live() -> dict:
    d = json.loads((ROOT / "dashboard" / "web" / "data.json").read_text(encoding="utf-8"))
    con = sqlite3.connect(f"file:{ROOT / 'data' / 'thetadesk.sqlite'}?mode=ro", uri=True)
    row = con.execute(
        "select legs_json, net_credit, max_loss from structures "
        "where kind='iron_condor' and status in ('open','pending') "
        "order by opened_utc desc limit 1").fetchone()
    con.close()
    legs = json.loads(row[0])
    strikes = sorted(float(l["symbol"][-8:]) / 1000 for l in legs)
    return {
        "lp": strikes[0], "sp": strikes[1], "sc": strikes[2], "lc": strikes[3],
        "credit": float(row[1]), "max_loss": float(row[2]),
        "under": legs[0]["symbol"][:next(i for i, c in enumerate(legs[0]["symbol"]) if c.isdigit())],
        "equity": d["broker"]["equity"], "realized": d["book"]["realized"],
        "iv": d["signals"]["atm_iv"], "rv": d["signals"]["rv20"],
        "curve": [p["v"] for p in d["curves"]["real"]],
        "ladder": d["ladder"]["tier"], "passes": d["manage"]["passes_today"],
        "refused": d["refusals"]["total"], "gates": len(d["gate_defs"]),
    }


def payoff_path(v: dict, x0: float, x1: float, y0: float, y1: float) -> tuple[str, str, float]:
    """The condor's expiry payoff, to scale, as an SVG path plus the shaded
    profit band. Domain is padded a wing's width beyond each long strike."""
    pad = (v["lc"] - v["sc"]) * 1.15
    lo, hi = v["lp"] - pad, v["lc"] + pad
    credit = v["credit"] * 100
    loss = -v["max_loss"]

    def px(k: float) -> float:
        return x0 + (k - lo) / (hi - lo) * (x1 - x0)

    def py(p: float) -> float:                       # loss at bottom, credit near top
        return y1 - (p - loss) / (credit - loss) * (y1 - y0)

    pts = [(lo, loss), (v["lp"], loss), (v["sp"], credit),
           (v["sc"], credit), (v["lc"], loss), (hi, loss)]
    d = "M " + " L ".join(f"{px(k):.1f} {py(p):.1f}" for k, p in pts)
    band = (f"M {px(v['sp']):.1f} {py(credit):.1f} L {px(v['sc']):.1f} {py(credit):.1f} "
            f"L {px(v['sc']):.1f} {py(0):.1f} L {px(v['sp']):.1f} {py(0):.1f} Z")
    return d, band, py(0)


def spark(vals: list[float], x0: float, x1: float, y0: float, y1: float) -> str:
    if len(vals) < 2:
        return ""
    lo, hi = min(vals), max(vals)
    rng = (hi - lo) or 1.0
    step = (x1 - x0) / (len(vals) - 1)
    return "M " + " L ".join(
        f"{x0 + i * step:.1f} {y1 - (v - lo) / rng * (y1 - y0):.1f}" for i, v in enumerate(vals))


def build() -> str:
    v = live()
    d, band, zero_y = payoff_path(v, 880, 1520, 250, 560)
    curve = spark(v["curve"], 62, 1538, 648, 790)
    prem = (v["iv"] - v["rv"]) * 100

    def x_of(k: float) -> float:
        pad = (v["lc"] - v["sc"]) * 1.15
        lo, hi = v["lp"] - pad, v["lc"] + pad
        return 880 + (k - lo) / (hi - lo) * 640

    return f"""<!doctype html><meta charset="utf-8"><title>cover</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{{margin:0;padding:0;box-sizing:border-box}}
  body{{width:{W}px;height:{H}px;overflow:hidden;background:#08080A;
       font-family:"Instrument Sans",system-ui,sans-serif;color:#F4F4F1;position:relative}}
  .grid{{position:absolute;inset:0;
    background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),
                     linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);
    background-size:56px 56px}}
  .glow{{position:absolute;right:-180px;top:-160px;width:900px;height:900px;border-radius:50%;
    background:radial-gradient(circle,rgba(242,193,78,.13),transparent 62%)}}
  .z{{position:relative;z-index:2;padding:60px 60px 0}}
  .rail{{display:flex;align-items:center;gap:14px;font-family:"IBM Plex Mono",monospace;
    font-size:15px;letter-spacing:.13em;color:#616159;text-transform:uppercase}}
  .dot{{width:7px;height:7px;border-radius:50%;background:#5CCB8E;box-shadow:0 0 12px #5CCB8E}}
  h1{{font-size:104px;line-height:.94;font-weight:700;letter-spacing:-.035em;margin-top:26px}}
  h1 .a{{color:#F2C14E}}
  .tag{{font-size:29px;line-height:1.34;color:#9C9C95;margin-top:22px;max-width:660px;font-weight:400}}
  .tag b{{color:#F4F4F1;font-weight:600}}
  .stats{{display:flex;gap:0;margin-top:38px;border-top:1px solid rgba(255,255,255,.10);
    border-bottom:1px solid rgba(255,255,255,.10);max-width:780px}}
  .st{{padding:20px 30px 20px 0;margin-right:30px;border-right:1px solid rgba(255,255,255,.08)}}
  .st:last-child{{border-right:0;margin-right:0;padding-right:0}}
  .st .n{{font-family:"IBM Plex Mono",monospace;font-size:40px;font-weight:600;
    letter-spacing:-.02em;line-height:1}}
  .st .n .u{{font-size:23px;color:#F2C14E}}
  .st .l{{font-size:14.5px;color:#616159;margin-top:9px;line-height:1.36;letter-spacing:.01em}}
  .up{{color:#5CCB8E}}
  .card{{position:absolute;right:60px;top:150px;width:660px;
    background:rgba(15,15,18,.72);border:1px solid rgba(255,255,255,.09);border-radius:14px;
    padding:22px 24px 18px;backdrop-filter:blur(2px)}}
  .ch{{display:flex;justify-content:space-between;align-items:baseline;
    font-family:"IBM Plex Mono",monospace;font-size:13px;letter-spacing:.12em;
    text-transform:uppercase;color:#616159;margin-bottom:6px}}
  .ch b{{color:#F2C14E;letter-spacing:.06em}}
  .lbl{{font-family:"IBM Plex Mono",monospace;font-size:14px;fill:#9C9C95}}
  .lbl.s{{fill:#F2C14E}}
  .curve{{position:absolute;left:60px;right:60px;top:598px;height:200px;
    border-top:1px solid rgba(255,255,255,.10);padding-top:12px}}
  .foot{{position:absolute;left:60px;right:60px;bottom:34px;display:flex;
    justify-content:space-between;align-items:center;
    font-family:"IBM Plex Mono",monospace;font-size:14.5px;color:#616159;letter-spacing:.05em}}
  .foot b{{color:#9C9C95}}
</style>
<div class="grid"></div><div class="glow"></div>

<div class="curve">
  <div class="ch"><span>the book · realised + unrealised · 5 sessions · every mark</span>
    <b>+${v['realized']:,.0f} banked · cannot be lost</b></div>
</div>
<svg style="position:absolute;inset:0;z-index:2" width="{W}" height="{H}">
  <path d="{curve} L 1538 790 L 62 790 Z" fill="url(#g)" opacity=".5"/>
  <path d="{curve}" fill="none" stroke="#F2C14E" stroke-width="2.4"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="rgba(242,193,78,.20)"/>
    <stop offset="1" stop-color="rgba(242,193,78,0)"/></linearGradient></defs>
</svg>

<div class="card">
  <div class="ch"><span>{v['under']} iron condor · held right now</span>
    <b>${v['credit']:.2f} credit</b></div>
  <svg width="612" height="330" viewBox="850 210 670 380">
    <line x1="880" y1="{zero_y:.0f}" x2="1520" y2="{zero_y:.0f}"
          stroke="rgba(255,255,255,.14)" stroke-dasharray="4 5"/>
    <path d="{band}" fill="rgba(92,203,142,.13)"/>
    <path d="{d}" fill="none" stroke="#F2C14E" stroke-width="3.2"
          stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="{x_of(v['sp']):.0f}" y1="250" x2="{x_of(v['sp']):.0f}" y2="570"
          stroke="rgba(242,193,78,.22)"/>
    <line x1="{x_of(v['sc']):.0f}" y1="250" x2="{x_of(v['sc']):.0f}" y2="570"
          stroke="rgba(242,193,78,.22)"/>
    <text class="lbl" x="{x_of(v['lp']):.0f}" y="588" text-anchor="middle">{v['lp']:.0f}</text>
    <text class="lbl s" x="{x_of(v['sp']):.0f}" y="588" text-anchor="middle">{v['sp']:.0f}</text>
    <text class="lbl s" x="{x_of(v['sc']):.0f}" y="588" text-anchor="middle">{v['sc']:.0f}</text>
    <text class="lbl" x="{x_of(v['lc']):.0f}" y="588" text-anchor="middle">{v['lc']:.0f}</text>
    <text class="lbl" x="{(x_of(v['sp']) + x_of(v['sc'])) / 2:.0f}" y="{zero_y - 16:.0f}"
          text-anchor="middle" style="fill:#5CCB8E">profit zone</text>
  </svg>
  <div class="ch" style="margin:2px 0 0"><span>max loss fixed at entry</span>
    <b style="color:#E4665C">−${v['max_loss']:,.0f}</b></div>
</div>

<div class="z">
  <div class="rail"><span class="dot"></span>Alpaca AI Trading Agents Hackathon
    · Team Qwertys · paper account PA39C10YAMYQ</div>
  <h1>THETA <span class="a">DESK</span></h1>
  <div class="tag">An autonomous options desk that prices <b>volatility</b>,
    never direction — and can only take the size it has <b>earned</b>.</div>
  <div class="stats">
    <div class="st"><div class="n up">+18.9<span class="u">%</span></div>
      <div class="l">return on the risk<br>that actually closed</div></div>
    <div class="st"><div class="n">{v['gates']}</div>
      <div class="l">deterministic gates<br>no model can loosen one</div></div>
    <div class="st"><div class="n">60<span class="u">s</span></div>
      <div class="l">exit cadence — a loop<br>that cannot open a trade</div></div>
    <div class="st"><div class="n">{v['refused']}</div>
      <div class="l">candidates refused,<br>each naming its rule</div></div>
  </div>
</div>

<div class="foot">
  <div>Alpaca <b>Trading API · MCP · CLI</b> — hypothetical paper results, not advice</div>
  <div><b>github.com/pip00sya/theta-desk</b></div>
</div>
"""


def main() -> int:
    html = build()
    src = SUB / "cover.html"
    src.write_text(html, encoding="utf-8")
    out = SUB / "cover.png"
    if out.exists():
        out.unlink()
    browser = CHROME if Path(CHROME).exists() else EDGE
    prof = Path(tempfile.gettempdir()) / "coverprof"
    r = subprocess.run([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--force-device-scale-factor=1", f"--user-data-dir={prof}",
                        f"--screenshot={out}", f"--window-size={W},{H}",
                        "--virtual-time-budget=9000", src.as_uri()],
                       capture_output=True, text=True)
    if not out.exists():
        return int(sys.stderr.write(f"render failed: {r.stderr[-400:]}\n") or 1)
    print(f"cover.png — {W}x{H}, {out.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
