"""Render submission/slides.pdf from live data — no number typed by hand.

The deck shipped on Sep 2 carried "+$321 → final on Friday" because a human
edited the figures and the session moved on. Every live figure in slides.html
is now a {{TOKEN}} filled from the store, the journal and the reconciler, so a
stale deck is impossible: re-run this and the PDF tells today's truth.

Usage:  python tools/render_deck.py            render submission/slides.pdf
        python tools/render_deck.py --print    show the values, write nothing
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUB = ROOT / "submission"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def _money(x: float) -> str:
    return f"{'+' if x >= 0 else '−'}${abs(x):,.0f}"


def values() -> dict[str, str]:
    sys.path.insert(0, str(ROOT / "src"))
    from thetadesk import config as cfgmod
    cfg = cfgmod.load()

    marks = None
    with (cfg.journal_dir / "desk.jsonl").open(encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            e = json.loads(line)
            if e["kind"] == "marks":
                marks = e["data"]
    if marks is None:
        raise SystemExit("no marks in the journal — nothing to render")

    real, nogates = float(marks["real"]), float(marks["shadow_nogates"])
    nohedge, naive = float(marks["shadow_nohedge"]), float(marks["baseline_naive"])
    devlog = sum(1 for l in (ROOT / "DEVLOG.md").read_text(encoding="utf-8").splitlines()
                 if l.startswith("## #"))
    claims = re.findall(r"^\| \d+ \|", (ROOT / "WRITEUP.md").read_text(encoding="utf-8"), re.M)
    return {
        "REAL": _money(real),
        "NOGATES": _money(nogates),
        "NOHEDGE": _money(nohedge),
        "NAIVE": _money(naive),
        "GATES_WORTH": f"${real - nogates:,.0f}",
        "HEDGE_COST": f"${abs(nohedge - real):,.0f}",
        "CLAIMS": f"{len(claims)}/{len(claims)}",
        "DEVLOG_N": str(devlog),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", help="show the values, write nothing")
    a = ap.parse_args()
    v = values()
    for k, x in v.items():
        print(f"  {k:<12} {x}")
    if a.print:
        return 0

    html = (SUB / "slides.html").read_text(encoding="utf-8")
    missing = set(re.findall(r"\{\{(\w+)\}\}", html)) - set(v)
    if missing:
        raise SystemExit(f"slides.html has tokens nothing fills: {sorted(missing)}")
    for k, x in v.items():
        html = html.replace("{{" + k + "}}", x)

    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "slides.rendered.html"
        page.write_text(html, encoding="utf-8")
        out = SUB / "slides.pdf"
        r = subprocess.run([EDGE, "--headless", "--disable-gpu", f"--user-data-dir={tmp}/prof",
                            "--no-pdf-header-footer", f"--print-to-pdf={out}", page.as_uri()],
                           capture_output=True, text=True, timeout=180)
        if not out.exists():
            raise SystemExit(f"edge failed to render: {r.stderr[-300:]}")
    pages = len(re.findall(rb"/Type\s*/Page[^s]", out.read_bytes()))
    print(f"\nslides.pdf — {pages} pages, {out.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
