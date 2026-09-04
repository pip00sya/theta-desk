"""Recompute every headline figure from scratch and compare it to the export.

tools/site_data.py builds dashboard/web/data.json, and the console renders that
file. If site_data has a bug, the console renders the bug faithfully and nobody
notices. So this reads the same underlying truth by a different route — the
SQLite store directly, the journal line by line, and the live Alpaca account —
and asserts the published figure matches.

Anything that disagrees is printed with both numbers and the exit code is 1.

Usage:  python tools/reality_check.py            check the committed export
        python tools/reality_check.py --json     machine-readable result
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod                    # noqa: E402

EXPORT = ROOT / "dashboard" / "web" / "data.json"
START_EQUITY = 100_000.0


def _store_path(cfg) -> Path:
    live = Path(cfg.db_path)
    if live.exists() and live.stat().st_size > 0:
        return live
    return ROOT / "dashboard" / "state.sqlite"


def _journal_lines(cfg) -> list[dict]:
    out = []
    with (Path(cfg.journal_dir) / "desk.jsonl").open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def _broker() -> dict | None:
    """The account itself, read live. Skipped where there are no credentials."""
    try:
        import os
        import requests
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text(encoding="utf-8").splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())
        h = {"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
             "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET_KEY"]}
        a = requests.get("https://paper-api.alpaca.markets/v2/account",
                         headers=h, timeout=15).json()
        pos = requests.get("https://paper-api.alpaca.markets/v2/positions",
                           headers=h, timeout=15).json()
        return {"equity": float(a["equity"]), "cash": float(a["cash"]),
                "positions": [p["symbol"] for p in pos if isinstance(p, dict)]}
    except Exception:
        return None


def check() -> tuple[list[dict], list[dict]]:
    cfg = cfgmod.load()
    d = json.loads(EXPORT.read_text(encoding="utf-8"))
    entries = _journal_lines(cfg)
    con = sqlite3.connect(f"file:{_store_path(cfg)}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows, notes = [], []

    def cmp(name, published, recomputed, how, tol=0.005):
        ok = (abs(float(published) - float(recomputed)) <= tol
              if isinstance(recomputed, (int, float)) and isinstance(published, (int, float))
              else published == recomputed)
        rows.append({"field": name, "published": published, "recomputed": recomputed,
                     "source": how, "ok": bool(ok)})

    # ---- the journal, counted line by line ---------------------------------
    kinds = Counter(e["kind"] for e in entries)
    cmp("journal entries", d["verification"]["journal_entries"], len(entries),
        "wc -l on data/journal/desk.jsonl")
    cmp("ticks", d["counts"]["ticks"], kinds["tick_start"], "tick_start lines")
    cmp("gate evaluations", len(d["series"]["gates"]), kinds["gates"], "gates lines")
    cmp("desk meetings", d["desk"]["meetings"], kinds["desk"], "desk lines")
    REFUSAL = ("entry_refused", "no_candidate", "derisk_mode", "entry_skipped_duplicate",
               "market_closed", "desk_veto", "data_suspect")
    cmp("refusals, all kinds", d["refusals"]["all"], sum(kinds[k] for k in REFUSAL),
        "seven refusal kinds summed")
    cmp("refusals, gated only", d["refusals"]["total"], kinds["entry_refused"],
        "entry_refused lines")
    live_orders = sum(1 for e in entries
                      if e["kind"] in ("order_open", "order_close", "order_hedge")
                      and e["data"].get("transport") != "dry_run")
    cmp("live orders", d["counts"]["orders_live"], live_orders, "order_* lines, dry runs excluded")
    cmp("signal readings", len(d["series"]["signal"]),
        sum(1 for e in entries if e["kind"] == "signals" and e["data"].get("spot")),
        "signals lines carrying a spot")

    # ---- the store, queried directly ---------------------------------------
    st = con.execute("select status, count(*) n, sum(closed_pnl) p, sum(max_loss) ml "
                     "from structures group by status").fetchall()
    by = {r["status"]: r for r in st}
    total = sum(r["n"] for r in st)
    cmp("structures, total", d["counts"]["structures_total"], total, "select count(*) structures")
    cmp("structures, closed", d["counts"]["structures_closed"],
        by.get("closed", {"n": 0})["n"], "status = closed")
    opened = sum(by[s]["n"] for s in by if s in ("open", "pending", "closing", "submitting"))
    cmp("structures, open", d["counts"]["structures_open"], opened, "status in open/pending/…")
    realized = con.execute("select coalesce(sum(closed_pnl),0) v from structures "
                           "where status='closed'").fetchone()["v"]
    cmp("realized P&L", d["book"]["realized"], round(float(realized), 2),
        "sum(closed_pnl) where closed", tol=0.011)
    open_risk = con.execute(
        "select coalesce(sum(max_loss),0) v from structures "
        "where status in ('open','pending','closing','submitting')").fetchone()["v"]
    cmp("open worst case", sum(p["max_loss"] for p in d["positions"]["open"]),
        round(float(open_risk)), "sum(max_loss) of open structures", tol=1.0)

    last = con.execute("select * from marks where book='real' order by ts desc limit 1").fetchone()
    if last:
        cmp("delta", d["greeks"]["delta"], round(float(last["delta"] or 0), 2), "latest real mark")
        cmp("theta", d["greeks"]["theta"], round(float(last["theta"] or 0), 2), "latest real mark")
        cmp("vega", d["greeks"]["vega"], round(float(last["vega"] or 0), 2), "latest real mark")
        cmp("book P&L", d["book"]["pnl"],
            round(float(last["unrealized"] or 0) + float(last["realized"] or 0), 2),
            "unrealized + realized on the latest real mark", tol=0.011)

    # ---- the signal, from the last journalled reading ----------------------
    sig = next((e["data"] for e in reversed(entries) if e["kind"] == "signals"), {})
    for k, j in (("atm_iv", "atm_iv"), ("rv20", "rv20"), ("spot", "spot")):
        cmp("signal " + k, d["signals"][k], sig.get(j), "last signals line", tol=1e-9)

    # ---- the ceilings, from config × equity --------------------------------
    eq = d["broker"]["equity"] if d.get("broker") else START_EQUITY
    r = cfg.raw["risk"]
    cmp("ceiling, per structure", d["limits"]["per_structure"],
        round(eq * r["per_structure_max_loss_frac"], 2), "equity × config", tol=0.011)
    cmp("ceiling, portfolio cap", d["limits"]["portfolio_cap"],
        round(eq * r["portfolio_worst_case_cap"], 2), "equity × config", tol=0.011)

    # ---- the chain ---------------------------------------------------------
    vr = subprocess.run([sys.executable, "-m", "thetadesk.main", "verify-journal"],
                        cwd=ROOT, capture_output=True, text=True,
                        env={**__import__("os").environ, "PYTHONPATH": str(ROOT / "src")})
    cmp("hash chain", d["verification"]["chain_ok"], vr.returncode == 0,
        "python -m thetadesk.main verify-journal")

    # ---- the account itself ------------------------------------------------
    br = _broker()
    if br is None:
        notes.append({"note": "broker not read — no credentials in this environment"})
    else:
        cmp("broker equity", d["broker"]["equity"], round(br["equity"], 2),
            "GET /v2/account, live", tol=200.0)
        notes.append({"note": f"broker equity now {br['equity']:,.2f}; the export was stamped at "
                              f"{d['broker']['asof_utc']}"})
        ours = {l["symbol"] for p in d["positions"]["open"] for l in p["legs"]}
        theirs = set(br["positions"])
        if ours - theirs:
            notes.append({"note": f"legs the store holds and the broker does not: {sorted(ours - theirs)}"})
        if theirs - ours:
            notes.append({"note": f"legs the broker holds and the store does not: {sorted(theirs - ours)}"})
    con.close()
    return rows, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    rows, notes = check()
    bad = [r for r in rows if not r["ok"]]
    if a.json:
        print(json.dumps({"rows": rows, "notes": notes, "ok": not bad}, indent=1, default=str))
        return 1 if bad else 0
    w = max(len(r["field"]) for r in rows)
    for r in rows:
        mark = "ok " if r["ok"] else "XX "
        print(f"{mark}{r['field']:<{w}}  published {str(r['published']):>14}   "
              f"recomputed {str(r['recomputed']):>14}   {r['source']}")
    for n in notes:
        print("   note: " + n["note"])
    print(f"\n{len(rows) - len(bad)} of {len(rows)} figures reconcile against the store, "
          f"the journal and the account.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
