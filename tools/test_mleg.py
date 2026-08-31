"""One-shot mleg acceptance test against the paper account.

Purpose: close DEVLOG open assumption — does Alpaca accept our mleg payload
(order_class, legs, ratio_qty, position_intent, client_order_id) exactly as
the production path builds it? Runs while the market is closed: the order is
accepted+queued or rejected with a reason. Either way we CANCEL immediately
so Monday starts clean.

Usage: python tools/test_mleg.py
"""
from __future__ import annotations

import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod                    # noqa: E402
from thetadesk.data.alpaca_client import AlpacaClient     # noqa: E402
from thetadesk.engine import selector as sel              # noqa: E402
from thetadesk.execution import cli_bridge, mleg          # noqa: E402


def main() -> int:
    cfg = cfgmod.load()
    c = AlpacaClient()
    expiry = cfg["expiry"]["target_expiry"]
    chain = c.option_chain(cfg["universe"]["primary"], expiry)
    entries = sel.parse_chain(chain)
    print(f"chain: {len(entries)} contracts")

    cond = sel.build_iron_condor(entries, date.fromisoformat(expiry),
                                 cfg["structures"]["condor"], date.today().isoformat())
    if cond is None:
        print("selector's condor failed credit floor on stale weekend quotes — "
              "building a wider test condor manually")
        cfg_relaxed = dict(cfg["structures"]["condor"])
        cfg_relaxed["min_credit_frac_of_width"] = 0.01
        cond = sel.build_iron_condor(entries, date.fromisoformat(expiry),
                                     cfg_relaxed, date.today().isoformat())
    if cond is None:
        print("FAIL: cannot construct any condor from the chain")
        return 1

    for l in cond.legs:
        print(f"  leg {l.qty:+d} {l.contract.symbol} @ {l.entry_price}")
    print(f"  net credit {cond.net_credit}  max loss ${cond.max_loss:,.0f}")

    # deliberately unmarketable price (half the mid credit is *more* credit
    # than the market gives? no — ASK for MORE credit than mid so it cannot
    # fill even if the market opens before we cancel)
    ask_credit = round(cond.net_credit * 1.8, 2)
    payload = mleg.build_mleg_payload(cond, 1, ask_credit, "td-mleg-selfcheck-001")
    print("\nsubmitting mleg (limit credit", ask_credit, ") ...")
    res = cli_bridge.submit(payload, c, dry_run=False)
    print(f"transport={res.transport} ok={res.ok} duplicate={res.duplicate}")
    if not res.ok:
        print("REJECTED:", res.error)
        return 2
    order = res.order or {}
    oid = order.get("id")
    print(f"ACCEPTED: id={oid} status={order.get('status')} legs={len(order.get('legs', []))}")

    if oid:
        time.sleep(2)
        try:
            c.cancel_order(oid)
            print("canceled OK")
        except Exception as e:
            print("cancel error:", e)
        time.sleep(2)
        final = [o for o in c.orders(status="all") if o.get("id") == oid]
        if final:
            print("final status:", final[0]["status"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
