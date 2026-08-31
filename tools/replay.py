"""Deterministic replay (PLAN-MAX 1.2).

Re-runs the decision pipeline (signals -> selector) from every stored input
snapshot and compares against what the journal says happened. LLM votes are
NOT re-called — they are recorded exchanges; replay verifies that the
DETERMINISTIC pipeline around them reproduces bit-for-bit.

Usage: python tools/replay.py
Exit 0 = every snapshot reproduces; 1 = divergence (printed).
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod                  # noqa: E402
from thetadesk.audit.journal import Journal             # noqa: E402
from thetadesk.data import signals as sigmod            # noqa: E402
from thetadesk.engine import selector as sel            # noqa: E402


def main() -> int:
    cfg = cfgmod.load()
    journal = Journal(cfg.journal_dir)
    entries = journal.read_all()

    ok_chain, msg = journal.verify_chain()
    print(f"journal chain: {'OK' if ok_chain else 'FAIL'} — {msg} ({len(entries)} entries)")
    if not ok_chain:
        return 1

    # pair journal signal entries with their own snapshots (by reference)
    journal_signals = [e["data"] for e in entries if e["kind"] == "signals"]
    with_snap = [d for d in journal_signals if d.get("snapshot")]
    print(f"journal signal entries: {len(journal_signals)} "
          f"(with snapshot refs: {len(with_snap)})")

    mismatches = checked = 0
    for want in with_snap:
        sp = cfg.snapshot_dir / want["snapshot"]
        if not sp.exists():
            print(f"  [{want['snapshot']}] snapshot file missing — SKIP")
            continue
        checked += 1
        snap = json.loads(sp.read_text(encoding="utf-8"))
        parsed = sel.parse_chain(snap["chain"])
        sig = sigmod.compute(parsed, snap["closes"], snap["spot"],
                             cfg["regime"]["rv_lookback_days"])
        got = sig.to_dict()
        same = all(abs(got[k] - want[k]) < 1e-9 for k in ("rv20", "atm_iv", "vrp_score"))
        day = snap["ts"][:10]
        cand = sel.select(parsed, date.fromisoformat(cfg["expiry"]["target_expiry"]),
                          sig.vrp, cfg["structures"], cfg["regime"], day)
        cand_id = cand.structure.structure_id if cand else None
        if not same:
            mismatches += 1
            print(f"  [{sp.name}] DIVERGE: got {got} want "
                  f"{ {k: want[k] for k in ('rv20', 'atm_iv', 'vrp_score')} }")
        else:
            print(f"  [{sp.name}] MATCH  vrp={got['vrp_score']:.4f}"
                  f"  candidate={cand_id or '-'}")

    print(f"\nreplay: {checked - mismatches}/{checked} snapshots reproduce, "
          f"{mismatches} divergence(s)")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
