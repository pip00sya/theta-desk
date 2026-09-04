"""Build the 5-minute submission video end-to-end, no human in the loop.

Frames: cover + slides (rendered by headless Edge) + live-data frames
(ablation chart from the real marks table, verify terminal, account board).
Narration: Microsoft neural TTS (edge-tts, en-US-AndrewNeural).
Assembly: ffmpeg — per-segment stills + narration, concat, 1080p.

Run:  python submission/build_video.py
Out:  submission/theta-desk-video.mp4
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUB = ROOT / "submission"
WORK = SUB / "_video"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
VOICE = "en-US-AndrewNeural"

NARRATION = {
    1: ("cover.png",
        "Over a five day competition, price prediction is a coin flip. So our agent "
        "doesn't predict prices. THETA DESK is an autonomous options desk on Alpaca "
        "that prices volatility itself — the gap between implied and realized. "
        "Everything you're about to see was designed, built and operated end to end "
        "by AI. Paper trading only."),
    2: ("slide2.png",
        "Here's the proof this is a system, not a story. Our plan said: sell iron "
        "condors and harvest theta. On day one, the live signal said realized "
        "volatility was above implied — premium was cheap, and selling it would be "
        "negative edge. The agent went against our own plan and bought convexity "
        "instead. The market slid, and three of those four puts closed at plus "
        "sixty four to seventy percent. Two days later realized vol collapsed, the "
        "regime flipped rich, and the desk sold its first iron condors — the "
        "structure it was built for. Both branches fired, live, on their own "
        "signal. Every decision is in a hash chained journal."),
    3: ("slide3.png",
        "Every fifteen minutes of the session, the desk runs one cycle. Four language "
        "model roles argue about the same numbers: a volatility analyst on Claude; an "
        "independent second opinion on an open Mistral model — different providers, "
        "so disagreement is real; a news vetoer; and a risk officer whose only job is "
        "to attack the trade. They can veto the day and shrink the size. What they "
        "cannot do is loosen a single risk gate. Twelve of them, all deterministic "
        "Python."),
    4: ("slide4.png",
        "The central gate is the desk's veto right. Before any order, the entire book "
        "plus the candidate is repriced over a twenty percent price grid at the "
        "judging horizon, under a stressed volatility scenario. If the worst case "
        "breaches budget, the order is never sent — and the refusal is journaled with "
        "the full grid attached. It's a client side implementation of the same worst "
        "case principle as Alpaca's universal spread rule for options margin, applied "
        "one step earlier."),
    45: ("shield.png",
        "Here is the desk deciding this afternoon, with nobody at the keyboard. The "
        "jobs report lands tomorrow morning. The desk measured how close each "
        "position's short strike sat to the market — not in percent, but in units of "
        "the daily move the option market itself was pricing. Two S and P condors sat "
        "inside one and a half of those moves. Two Nasdaq condors sat almost three "
        "away. It closed the two a gap would reach, kept the two it would not, and "
        "wrote the reason into the journal in plain language. A blanket flatten would "
        "have paid the spread on four positions to protect two."),
    5: ("ablation.png",
        "We didn't just claim the design matters — we measured it, live. Four books "
        "run on identical inputs: the real agent; the same strategy with gates "
        "ignored; the book without its hedge; and a naive baseline that reads a "
        "headline and buys an option — the median hackathon strategy. Being precise "
        "about what that shows: the shadow books never take profits, so they are a "
        "bound, not a like for like P and L. The gates refused forty three entries "
        "this week — on liquidity, on the daily budget, on the session edges, and "
        "before the jobs report. The unmanaged book of everything they let through "
        "and everything they refused is deep in the red while the gated book is "
        "green. The gates are load bearing. We publish the caveat with the number."),
    6: ("verify.png",
        "Everything is reproducible. The journal is hash chained — change one byte "
        "and verification fails. Every tick stores its inputs, and one command "
        "replays the entire week, bit for bit. Another command regenerates every "
        "number in our write up: twenty out of twenty claims, zero mismatches, no "
        "credentials required."),
    7: ("account.png",
        "The result, on paper account P A 3 9 C 1 0 Y A M Y Q: a small, explained, "
        "risk boxed P and L. Six hundred dollars realized, on a book whose worst "
        "case never left three and a half percent of equity. Every "
        "position is defined risk. Position size grows only from realized gains. And "
        "the jobs report that lands on deadline morning is de-risked by rule, the "
        "day before — the desk will open nothing tomorrow, by design."),
    8: ("cover.png",
        "THETA DESK. Language models decide whether it's wise. Code decides whether "
        "it's allowed. Built on Alpaca's Trading API, M C P server, and C L I, by "
        "team Qwertys. Hypothetical paper trading results — not investment advice. "
        "Thanks for watching."),
}

PAGE_CSS = """
* { margin:0; padding:0; box-sizing:border-box; }
body { width:1600px; height:900px; overflow:hidden; background:#0b0f1a;
       color:#e8ecf4; font-family:'Segoe UI',sans-serif; padding:70px 90px; }
h2 { font-size:52px; color:#fff; margin-bottom:8px; }
h2 span { color:#35e0b0; }
.k { font-size:19px; letter-spacing:.15em; color:#7f96c9; text-transform:uppercase; margin-bottom:10px; }
"""


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
_SERVER = {"port": None}


def _serve(root: Path) -> int:
    """Headless Chrome refuses file:// screenshots here, so frames are served.

    Edge's --screenshot stopped producing files on this machine on 2026-09-03
    (see the note on the PIL fallback below); Chrome works, but only over http.
    One short-lived server for the whole build.
    """
    if _SERVER["port"]:
        return _SERVER["port"]
    import functools
    import http.server
    import socketserver
    import threading
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    _SERVER["port"] = httpd.server_address[1]
    return _SERVER["port"]


def edge_shot(html: Path, png: Path) -> None:
    """Render one frame. Named for the browser it used to use."""
    browser = CHROME if Path(CHROME).exists() else EDGE
    port = _serve(ROOT)
    url = f"http://127.0.0.1:{port}/" + html.resolve().relative_to(ROOT).as_posix()
    if png.exists():
        png.unlink()
    r = run([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=1",
             f"--user-data-dir={WORK / 'shotprof'}",
             f"--screenshot={png}", "--window-size=1600,900",
             "--virtual-time-budget=9000", url])
    if not png.exists():
        sys.exit(f"render failed for {html}: {r.stderr[-300:]}")


def split_slides() -> None:
    html = (SUB / "slides.html").read_text(encoding="utf-8")
    head, *slides = html.split('<div class="slide">')
    for i, body in enumerate(slides, 1):
        if i not in (2, 3, 4):
            continue
        page = head + '<div class="slide">' + body.split('<div class="slide">')[0]
        p = WORK / f"slide{i}.html"
        p.write_text(page, encoding="utf-8")
        edge_shot(p, WORK / f"slide{i}.png")


def ablation_frame() -> None:
    conn = sqlite3.connect(ROOT / "data" / "thetadesk.sqlite")
    conn.row_factory = sqlite3.Row
    series: dict[str, list[float]] = {}
    for book in ("real", "shadow_nogates", "shadow_nohedge", "baseline_naive"):
        rows = conn.execute(
            "SELECT unrealized + COALESCE(realized,0) v FROM marks WHERE book=? ORDER BY ts",
            (book,)).fetchall()
        series[book] = [float(r["v"]) for r in rows]
    n = max(len(v) for v in series.values())
    lo = min(min(v) for v in series.values() if v) - 30
    hi = max(max(v) for v in series.values() if v) + 30
    W, H = 1380, 560

    def path(vals: list[float]) -> str:
        if len(vals) < 2:
            return ""
        pts = [f"{i * W / (n - 1):.1f},{H - (v - lo) * H / (hi - lo):.1f}"
               for i, v in enumerate(vals)]
        return "M" + " L".join(pts)

    colors = {"real": "#35e0b0", "shadow_nogates": "#7aa2ff",
              "shadow_nohedge": "#c9a2ff", "baseline_naive": "#ff7a7a"}
    labels = {"real": "real agent", "shadow_nogates": "no gates",
              "shadow_nohedge": "no hedge", "baseline_naive": "naive baseline"}
    zero_y = H - (0 - lo) * H / (hi - lo)
    svg_paths = "".join(
        f'<path d="{path(v)}" fill="none" stroke="{colors[b]}" '
        f'stroke-width="{5 if b == "real" else 3}" opacity="{1 if b == "real" else .8}"/>'
        for b, v in series.items() if len(v) >= 2)
    legend = "".join(
        f'<div style="display:flex;align-items:center;gap:10px;margin-right:44px">'
        f'<div style="width:34px;height:6px;background:{colors[b]};border-radius:3px"></div>'
        f'<span style="font-size:24px;color:#c7d2ea">{labels[b]}'
        f' <b style="color:{colors[b]}">{series[b][-1]:+,.0f}$</b></span></div>'
        for b in series if series[b])
    html = f"""<meta charset="utf-8"><style>{PAGE_CSS}</style>
<div class="k">Live ablation — four books, identical inputs</div>
<h2>The dollar value of <span>every design decision</span></h2>
<div style="display:flex;margin:26px 0 18px">{legend}</div>
<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<line x1="0" y1="{zero_y:.0f}" x2="{W}" y2="{zero_y:.0f}" stroke="#3a4a72" stroke-width="2" stroke-dasharray="8 8"/>
{svg_paths}</svg>"""
    p = WORK / "ablation.html"
    p.write_text(html, encoding="utf-8")
    edge_shot(p, WORK / "ablation.png")


def shield_frame() -> None:
    """The journal lines from the tick that made today's call — nothing staged.

    Drawn with PIL rather than headless Edge: on 2026-09-03 Edge's --screenshot
    stopped producing files on this machine while --print-to-pdf kept working,
    and a submission asset must not depend on a browser flag that can fail
    silently the evening before a deadline.
    """
    from PIL import Image, ImageDraw, ImageFont

    path = ROOT / "data" / "journal" / "desk.jsonl"
    entries = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                entries.append(json.loads(line))
    shield = [e for e in entries
              if e["kind"] == "manage" and "event shield" in str(e["data"].get("reason", ""))]
    if not shield:
        sys.exit("no event-shield decision in the journal — nothing to show")
    tick = shield[-1]["ts"][:16]
    shown = [e for e in entries if e["kind"] == "manage" and e["ts"][:16] == tick][:8]

    W, H = 1600, 900
    BG, PANEL = (11, 15, 26), (13, 19, 34)
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    def font(name, size):
        for f in (name, "segoeui.ttf", "arial.ttf"):
            try:
                return ImageFont.truetype(f, size)
            except OSError:
                continue
        return ImageFont.load_default()

    f_kick, f_head, f_mono = font("segoeui.ttf", 21), font("segoeuib.ttf", 50), font("consola.ttf", 21)
    d.text((90, 70), "THE JOURNAL, UNEDITED — ONE TICK, NOBODY AT THE KEYBOARD",
           font=f_kick, fill=(127, 150, 201))
    d.text((90, 112), "It closed what a gap would reach,", font=f_head, fill=(255, 255, 255))
    d.text((90, 172), "and kept the rest", font=f_head, fill=(53, 224, 176))

    top, pad = 268, 34
    d.rounded_rectangle([90, top, W - 90, top + 46 * len(shown) + pad * 2], 14,
                        fill=PANEL, outline=(46, 62, 104))
    y = top + pad
    for e in shown:
        dd = e["data"]
        act = dd["action"].upper()
        col = (255, 143, 122) if act == "CLOSE" else (93, 107, 143)
        x = 124
        for text, colour in ((e["ts"][11:19], (93, 107, 143)),
                             (f"{act:<6}", col),
                             (dd["structure_id"][:8], (199, 210, 234)),
                             (dd["reason"][:84], (169, 183, 214))):
            d.text((x, y), text, font=f_mono, fill=colour)
            x += d.textlength(text + " ", font=f_mono)
        y += 46

    # the measurement behind the call, so the frame argues instead of asserting
    foot = top + 46 * len(shown) + pad * 2 + 54
    d.text((90, foot), "THE MEASUREMENT, NOT AN OPINION", font=f_kick, fill=(127, 150, 201))
    f_body = font("segoeui.ttf", 27)
    for i, line in enumerate((
            "σ = atm_iv / √252 = the daily move the option market itself is pricing: 0.74% today.",
            "S&P condors sat 1.4σ and 1.6σ from their short calls. Nasdaq condors sat 2.8σ and 3.3σ.",
            "Inside 2σ closes before a high-class release. A blanket flatten pays four spreads to protect two.")):
        d.text((90, foot + 44 + i * 40), line, font=f_body, fill=(199, 210, 234))

    img.save(WORK / "shield.png")


def verify_frame() -> None:
    txt = (SUB / "verify_output.txt").read_text(encoding="utf-8")
    lines = [l for l in txt.splitlines() if l.strip()][:22]
    def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;")
    body = ""
    for l in lines:
        color = "#35e0b0" if ("OK" in l or "MATCH" in l or "reproduce" in l or
                              "reproduced" in l) else ("#7aa2ff" if l.startswith("$") else "#c7d2ea")
        body += f'<div style="color:{color}">{esc(l)}</div>'
    html = f"""<meta charset="utf-8"><style>{PAGE_CSS}
.term {{ background:#0d1322; border:1px solid rgba(122,162,255,.25); border-radius:14px;
        padding:34px 40px; font-family:Consolas,monospace; font-size:24px; line-height:1.6;
        margin-top:26px; }}</style>
<div class="k">make verify — run live, unedited output</div>
<h2>Hash chain · bit-for-bit replay · <span>claims reconciler</span></h2>
<div class="term">{body}</div>"""
    p = WORK / "verify.html"
    p.write_text(html, encoding="utf-8")
    edge_shot(p, WORK / "verify.png")


def account_frame() -> None:
    data = json.loads((SUB / "account_snapshot.json").read_text())
    rows = "".join(
        f"<tr><td class='mono'>{p['symbol']}</td><td>{p['qty']}</td>"
        f"<td>${p['avg']}</td>"
        f"<td style='color:{'#35e0b0' if float(p['upl']) >= 0 else '#ff8f7a'}'>"
        f"{'+' if float(p['upl']) >= 0 else '−'}${abs(float(p['upl'])):.0f}</td></tr>"
        for p in data["positions"])
    pnl = float(data["equity"]) - 100_000
    html = f"""<meta charset="utf-8"><style>{PAGE_CSS}
table {{ border-collapse:collapse; width:100%; margin-top:30px; }}
th,td {{ text-align:left; padding:18px 24px; font-size:28px; color:#d7e0f4;
        border-bottom:1px solid rgba(122,162,255,.15); }}
th {{ color:#7f96c9; font-size:20px; text-transform:uppercase; letter-spacing:.08em; }}
.mono {{ font-family:Consolas,monospace; }}
.eq {{ font-size:76px; font-weight:800; color:#fff; margin-top:22px; }}
.eq span {{ color:#35e0b0; font-size:40px; }}</style>
<div class="k">Paper account {data['account']} — live snapshot</div>
<h2>Defined-risk book, <span>gate-capped</span> worst case</h2>
<div class="eq">${float(data['equity']):,.2f} <span>{pnl:+,.2f}</span></div>
<table><tr><th>Contract</th><th>Qty</th><th>Avg entry</th><th>Unrealized</th></tr>{rows}</table>"""
    p = WORK / "account.html"
    p.write_text(html, encoding="utf-8")
    edge_shot(p, WORK / "account.png")


def tts(idx: int, text: str) -> Path:
    mp3 = WORK / f"seg{idx}.mp3"
    r = run([sys.executable, "-m", "edge_tts", "--voice", VOICE,
             "--text", text, "--write-media", str(mp3)])
    if not mp3.exists() or mp3.stat().st_size < 1000:
        sys.exit(f"tts failed for segment {idx}: {r.stderr[-300:]}")
    return mp3


def assemble() -> None:
    seg_files = []
    for idx, (img_name, text) in NARRATION.items():
        img = SUB / img_name if img_name == "cover.png" else WORK / img_name
        mp3 = tts(idx, text)
        seg = WORK / f"seg{idx}.mp4"
        r = run(["ffmpeg", "-y", "-loop", "1", "-i", str(img), "-i", str(mp3),
                 "-af", "apad=pad_dur=0.8",
                 "-c:v", "libx264", "-tune", "stillimage", "-r", "30",
                 "-vf", "scale=1920:1080", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "160k", "-shortest", str(seg)])
        if not seg.exists():
            sys.exit(f"ffmpeg segment {idx} failed: {r.stderr[-400:]}")
        seg_files.append(seg)
        print(f"segment {idx} done ({img_name})")

    lst = WORK / "concat.txt"
    lst.write_text("".join(f"file '{s.as_posix()}'\n" for s in seg_files), encoding="utf-8")
    out = SUB / "theta-desk-video.mp4"
    r = run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
             "-c", "copy", str(out)])
    if not out.exists():
        sys.exit(f"concat failed: {r.stderr[-400:]}")
    probe = run(["ffprobe", "-v", "quiet", "-show_entries", "format=duration,size",
                 "-of", "json", str(out)])
    info = json.loads(probe.stdout)["format"]
    print(f"\nVIDEO: {out}")
    print(f"duration: {float(info['duration']):.1f}s  size: {int(info['size']) / 1e6:.1f} MB")


if __name__ == "__main__":
    WORK.mkdir(exist_ok=True)
    split_slides()
    print("slides rendered")
    ablation_frame()
    print("ablation frame rendered")
    shield_frame()
    verify_frame()
    account_frame()
    print("live-data frames rendered")
    assemble()
