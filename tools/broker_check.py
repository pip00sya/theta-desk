"""Broker check — the store against the broker's actual fills (DEVLOG #20/#22).

Usage:  python tools/broker_check.py            report only
        python tools/broker_check.py --repair   write real fills into the store

Ground truth for every number the desk claims is the broker's fill, not the
mid at decision time. For each structure: the entry order is found by its
client_order_id; a close is found by the kv `close_order` record or, for the
early closes made before that existed, by symbol + side after the entry.
Differences are printed; --repair applies them and journals a `repair`.
Needs .env (paper keys). The summary is journaled as `broker_check` so the
no-credentials reconciler can quote it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

for _line in (ROOT / ".env").read_text(encoding="utf-8").splitlines() if (ROOT / ".env").exists() else []:
    if "=" in _line and not _line.strip().startswith("#"):
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip())

from thetadesk import config as cfgmod                       # noqa: E402
from thetadesk.audit.journal import Journal                  # noqa: E402
from thetadesk.data.alpaca_client import AlpacaClient        # noqa: E402
from thetadesk.manage.positions import fills_from_order      # noqa: E402
from thetadesk.state.store import Store                      # noqa: E402


def _leg_pnl(legs: list[dict], fills: dict[str, float], qty: int) -> float:
    return round(sum(d["qty"] * (fills[d["symbol"]] - d["entry_price"]) * 100 * qty for d in legs), 2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repair", action="store_true")
    args = ap.parse_args()
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    client = AlpacaClient()
    orders = client.orders(status="all", limit=500)
    by_coid = {o.get("client_order_id"): o for o in orders}
    filled = [o for o in orders if o.get("status") == "filled"]
    used: set[str] = set()

    rows = []
    before = store.realized_gains()
    for s in store.all_structures():
        if s["status"] in ("dry_run", "rejected", "unfilled"):
            continue
        legs = json.loads(s["legs_json"])
        rec = {"structure_id": s["structure_id"], "kind": s["kind"], "status": s["status"],
               "entry_store": s["net_credit"], "entry_broker": None,
               "closed_store": s["closed_pnl"], "closed_broker": None, "notes": []}
        o = by_coid.get(s.get("client_order_id"))
        entry_fills, entry_net = ({}, None)
        if o and o.get("status") == "filled":
            entry_fills, entry_net = fills_from_order(o, s["legs_json"])
            rec["entry_broker"] = entry_net
            used.add(o["id"])
        else:
            rec["notes"].append("entry order not found/filled at broker")
        legs_real = [{**d, "entry_price": entry_fills.get(d["symbol"], d["entry_price"])} for d in legs]

        if s["status"] in ("closed", "closing"):
            close = None
            po = json.loads(store.get_kv(f"close_order:{s['structure_id']}", "{}"))
            if po.get("client_order_id"):
                close = by_coid.get(po["client_order_id"])
            if not (close and close.get("status") == "filled"):
                syms = {d["symbol"] for d in legs}
                # earliest unused filled order that closes exactly these legs
                for c in sorted(filled, key=lambda x: x.get("filled_at") or ""):
                    if c["id"] in used:
                        continue
                    csyms = {l["symbol"] for l in (c.get("legs") or [])} or {c.get("symbol")}
                    side_ok = (c.get("position_intent") or "").endswith("to_close") or bool(c.get("legs"))
                    if csyms == syms and side_ok and (c.get("filled_at") or "") > (o or {}).get("filled_at", ""):
                        close = c
                        break
            if close and close.get("status") == "filled":
                used.add(close["id"])
                cfills, _ = fills_from_order(close, s["legs_json"])
                if all(d["symbol"] in cfills for d in legs):
                    rec["closed_broker"] = _leg_pnl(legs_real, cfills, s["qty"])
                    rec["_close_fills"] = cfills
            else:
                rec["notes"].append("close order not found/filled at broker")
        rec["_legs_real"] = legs_real
        rec["_entry_net"] = entry_net
        rows.append(rec)

    print(f"{'structure':<18}{'kind':<15}{'status':<9}{'entry store':>12}{'entry brk':>11}"
          f"{'closed store':>14}{'closed brk':>12}")
    diffs = 0
    for r in rows:
        eb = "" if r["entry_broker"] is None else f"{r['entry_broker']:.2f}"
        cs = "" if r["closed_store"] is None else f"{r['closed_store']:.2f}"
        cb = "" if r["closed_broker"] is None else f"{r['closed_broker']:.2f}"
        flag = ""
        if r["entry_broker"] is not None and abs(r["entry_broker"] - r["entry_store"]) > 0.005:
            flag = " <- entry differs"; diffs += 1
        if r["closed_broker"] is not None and r["closed_store"] is not None \
                and abs(r["closed_broker"] - r["closed_store"]) > 0.01:
            flag += " <- closed P&L differs"; diffs += 1
        print(f"{r['structure_id']:<18}{r['kind']:<15}{r['status']:<9}{r['entry_store']:>12.2f}"
              f"{eb:>11}{cs:>14}{cb:>12}{flag}")
        for n in r["notes"]:
            print(f"{'':<18}note: {n}")
    broker_realized = round(sum(r["closed_broker"] for r in rows
                                if r["status"] == "closed" and r["closed_broker"] is not None), 2)
    print(f"\nrealized: store ${before:.2f}  broker ${broker_realized:.2f}  diffs={diffs}")

    repaired = []
    if args.repair and diffs:
        for r in rows:
            sid = r["structure_id"]
            if r["_entry_net"] is not None and abs(r["_entry_net"] - r["entry_store"]) > 0.005:
                store.set_fills(sid, json.dumps(r["_legs_real"]), r["_entry_net"], r["status"])
                repaired.append({"structure_id": sid, "entry": [r["entry_store"], r["_entry_net"]]})
            if r["closed_broker"] is not None and r["closed_store"] is not None \
                    and abs(r["closed_broker"] - r["closed_store"]) > 0.01:
                store.conn.execute("UPDATE structures SET closed_pnl=? WHERE structure_id=?",
                                   (r["closed_broker"], sid))
                store.conn.commit()
                repaired.append({"structure_id": sid, "closed_pnl": [r["closed_store"], r["closed_broker"]]})
        print(f"repaired {len(repaired)} field(s); realized now ${store.realized_gains():.2f}")

    Journal(cfg.journal_dir).append("broker_check", {
        "store_realized": before, "broker_realized": broker_realized, "diffs": diffs,
        "repaired": repaired, "store_realized_after": store.realized_gains()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
