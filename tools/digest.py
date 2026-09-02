"""Telegram digest — the desk explains its day in plain language.

The alert channel (audit/alerts.py) is a "call for help": breaches, crashes,
refused orders. It never says how the account is doing, which is the thing a
human actually wants on their phone. This is that message.

Usage:
  python tools/digest.py            summary of the current session
  python tools/digest.py --print    print only, send nothing

Reads the store and the hash-chained journal, never the broker: it works from
the same numbers the dashboard and the reconciler use.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit import alerts                  # noqa: E402
from thetadesk.audit.journal import Journal         # noqa: E402
from thetadesk.engine.contracts import OptionContract  # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

START_EQUITY = 100_000.0        # the hackathon's fixed paper balance


def session_date() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=4)).date().isoformat()


def _describe(s: dict) -> str:
    """One human line per structure: direction, strikes, expiry."""
    legs = json.loads(s["legs_json"])
    try:
        cs = [OptionContract.parse(d["symbol"]) for d in legs]
        strikes = "/".join(f"{c.strike:.0f}{c.right}" for c in cs)
        exp = min(c.expiry for c in cs).strftime("%d.%m")
        under = cs[0].underlying
    except ValueError:
        strikes, exp, under = "?", "?", "?"
    side = "куплено" if s["net_credit"] < 0 else "продано"
    return f"{under} {strikes} до {exp} ({side}, x{s['qty']})"


def build(cfg, store: Store, journal: Journal) -> str:
    today = session_date()
    entries = journal.read_all()
    mine = [e for e in entries if e["ts"][:10] == today]

    # --- money -----------------------------------------------------------
    equities = [m["equity"] for m in store.marks("real") if m["equity"]]
    equity = equities[-1] if equities else START_EQUITY
    realized = store.realized_gains()
    open_structs = [s for s in store.all_structures() if s["status"] in ("open", "closing")]

    # per-structure mark: the manager writes est_pnl on every tick
    mtm = {}
    for e in mine:
        if e["kind"] == "manage" and e["data"].get("est_pnl") is not None:
            mtm[e["data"]["structure_id"]] = e["data"]["est_pnl"]
    unrealized = sum(mtm.get(s["structure_id"], 0.0) for s in open_structs)

    lines = [f"THETA DESK — сводка за {today}", ""]
    lines.append(f"Счёт: ${equity:,.0f} (старт ${START_EQUITY:,.0f}, "
                 f"{equity - START_EQUITY:+,.0f})")
    lines.append(f"Зафиксировано с начала недели: {realized:+,.0f}$")
    if open_structs:
        lines.append(f"Открыто позиций: {len(open_structs)} "
                     f"(бумажная прибыль {unrealized:+,.0f}$)")
        for s in open_structs:
            pnl = mtm.get(s["structure_id"])
            tail = f" — сейчас {pnl:+,.0f}$" if pnl is not None else ""
            lines.append(f"  • {_describe(s)}{tail}")
    else:
        lines.append("Открытых позиций нет")

    # --- what the desk did today -----------------------------------------
    kinds = [e["kind"] for e in mine]
    opened = sum(1 for e in mine if e["kind"] == "order_open" and e["data"].get("ok"))
    closed = sum(1 for e in mine if e["kind"] == "order_close" and e["data"].get("ok"))
    refused = kinds.count("entry_refused")
    vetoed = kinds.count("desk_veto")
    no_cand = kinds.count("no_candidate")
    ticks = kinds.count("tick_start")
    lines += ["", f"Сегодня: тиков {ticks}, входов {opened}, закрытий {closed}, "
                  f"отказов гейтов {refused}, вето {vetoed}, нет кандидата {no_cand}"]

    sigs = [e["data"] for e in mine if e["kind"] == "signals"]
    if sigs:
        s = sigs[-1]
        regime = ("дорогая (продаём премию)" if s["vrp_score"] >= cfg["regime"]["vrp_rich_threshold"]
                  else "дешёвая (покупаем выпуклость)" if s["vrp_score"] < cfg["regime"]["vrp_cheap_threshold"]
                  else "нейтральная")
        lines.append(f"Волатильность: {regime} — IV {s['atm_iv']:.1%} против RV {s['rv20']:.1%}, "
                     f"спот {s['spot']:.2f}")

    problems = [e["data"] for e in mine if e["kind"] == "alert" and e["data"]["level"] != "INFO"]
    if problems:
        lines.append(f"Тревоги: {len(problems)} — " + "; ".join(p["title"] for p in problems[:3]))

    ev = [e for e in cfg.events() if e.utc > datetime.now(timezone.utc)]
    if ev:
        nxt = min(ev, key=lambda e: e.utc)
        hrs = (nxt.utc - datetime.now(timezone.utc)).total_seconds() / 3600
        lines.append(f"Ближайшее событие: {nxt.name} через {hrs:.0f} ч")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", dest="only_print", action="store_true")
    args = ap.parse_args()
    cfg = cfgmod.load()
    text = build(cfg, Store(cfg.db_path), Journal(cfg.journal_dir))
    print(text)
    if not args.only_print:
        out = alerts.alert("INFO", "сводка", text, journal=None)
        print("\ndelivery:", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
