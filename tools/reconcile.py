"""Reconcile — every number in the submission maps to a command that
regenerates it (our answer to Vega's bar, PLAN-MAX 5.4).

Computes each claim from the journal + store, then checks the CLAIMS block
in WRITEUP.md against them.

Usage:
  python tools/reconcile.py            verify (exit 1 on mismatch)
  python tools/reconcile.py --write    rewrite the CLAIMS block in WRITEUP.md
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit.journal import Journal         # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

BEGIN, END_MARK = "<!-- CLAIMS:BEGIN -->", "<!-- CLAIMS:END -->"


def compute_claims() -> dict[str, str]:
    cfg = cfgmod.load()
    journal = Journal(cfg.journal_dir)
    entries = journal.read_all()
    store = Store(cfg.db_path)

    chain_ok, chain_msg = journal.verify_chain()
    kinds = [e["kind"] for e in entries]
    gates = [e["data"] for e in entries if e["kind"] == "gates"]
    refused = [e["data"] for e in entries if e["kind"] == "entry_refused"]
    orders_open = [e["data"] for e in entries if e["kind"] == "order_open"]
    transports = sorted({o.get("transport") for o in orders_open if o.get("ok")})
    # "zero rejected orders" must be a number, not a sentence: every live
    # submission the broker/CLI refused is an order_* entry with ok=False
    orders_live = [e["data"] for e in entries
                   if e["kind"] in ("order_open", "order_close", "order_hedge")
                   and e["data"].get("transport") != "dry_run"]
    orders_rejected = sum(1 for o in orders_live if not o.get("ok"))
    structs = store.all_structures()
    worst_cases = [g["worst_case"]["pnl"] for g in gates
                   if g.get("worst_case") and g["worst_case"].get("pnl") is not None]

    fallbacks = []
    desks = [e["data"] for e in entries if e["kind"] == "desk"]
    for d in desks:
        fallbacks.extend(d.get("fallbacks", []))
    # DEVLOG #28: a meeting where every role fell back is "LLM-dark" — the
    # deterministic core decided alone; say how many, not just a raw count
    llm_dark = sum(1 for d in desks
                   if d.get("exchanges") and all(not x.get("ok") for x in d["exchanges"]))
    # DEVLOG #20: the broker's fills are the ground truth; tools/broker_check.py
    # journals its comparison so it can be quoted here without credentials
    checks = [e["data"] for e in entries if e["kind"] == "broker_check"]
    broker_realized = f"{checks[-1]['broker_realized']:.2f}" if checks else "not checked"
    cancelled = sum(1 for e in entries
                    if e["kind"] in ("close_reconcile", "open_reconcile")
                    and e["data"].get("action") in ("cancel_revert", "cancel_unfilled"))
    quarantined = store.conn.execute(
        "SELECT COUNT(*) FROM marks WHERE detail_json LIKE '%\"quality\": \"invalid\"%'"
        " OR detail_json LIKE '%\"quality\": \"suspect\"%'").fetchone()[0]
    tests_dir = Path(__file__).resolve().parents[1] / "tests"
    n_tests = sum(len(re.findall(r"^def test_", p.read_text(encoding="utf-8"), re.M))
                  for p in tests_dir.glob("test_*.py"))

    return {
        "journal_entries": str(len(entries)),
        "journal_chain": "intact" if chain_ok else f"BROKEN ({chain_msg})",
        "ticks": str(kinds.count("tick_start")),
        "gate_evaluations": str(len(gates)),
        "entries_refused_by_gates": str(len(refused)),
        "structures_total": str(len(structs)),
        "structures_open": str(sum(1 for s in structs if s["status"] == "open")),
        "structures_closed": str(sum(1 for s in structs if s["status"] == "closed")),
        "realized_pnl_usd": f"{store.realized_gains():.2f}",
        "realized_pnl_per_broker_fills_usd": broker_realized,
        "book_worst_case_peak_usd": f"{-min(worst_cases):.0f}" if worst_cases else "0",
        "order_transports_used": ",".join(transports) or "none",
        "orders_submitted_live": str(len(orders_live)),
        "orders_rejected_at_submit": str(orders_rejected),
        "orders_cancelled_unfilled": str(cancelled),
        "desk_meetings_total": str(len(desks)),
        "desk_meetings_llm_dark": str(llm_dark),
        "llm_fallbacks_recorded": str(len(fallbacks)),
        "marks_quarantined": str(quarantined),
        "test_functions": str(n_tests),
    }


def render_block(claims: dict[str, str]) -> str:
    lines = [BEGIN,
             "| # | Claim | Value | Regenerate with |",
             "|---|-------|-------|-----------------|"]
    for i, (k, v) in enumerate(claims.items(), 1):
        lines.append(f"| {i:02d} | {k} | {v} | `python tools/reconcile.py` |")
    lines.append(END_MARK)
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    claims = compute_claims()
    writeup = Path(__file__).resolve().parents[1] / "WRITEUP.md"

    for k, v in claims.items():
        print(f"CLAIM  {k:<32} {v}")

    if not writeup.exists():
        print("\nWRITEUP.md missing — nothing to verify against")
        return 0

    text = writeup.read_text(encoding="utf-8")
    if BEGIN not in text:
        print("\nWRITEUP.md has no CLAIMS block" + (" — adding" if args.write else ""))
        if args.write:
            writeup.write_text(text.rstrip() + "\n\n## Verified claims\n\n"
                               + render_block(claims) + "\n", encoding="utf-8")
            print("CLAIMS block written")
        return 0

    current = text.split(BEGIN)[1].split(END_MARK)[0]
    mismatches = []
    for k, v in claims.items():
        m = re.search(rf"\|\s*\d+\s*\|\s*{re.escape(k)}\s*\|\s*([^|]+?)\s*\|", current)
        if not m:
            mismatches.append(f"{k}: missing from WRITEUP")
        elif m.group(1).strip() != v:
            mismatches.append(f"{k}: WRITEUP says {m.group(1).strip()!r}, journal says {v!r}")

    if args.write:
        new = text.split(BEGIN)[0] + render_block(claims) + text.split(END_MARK)[1]
        writeup.write_text(new, encoding="utf-8")
        print(f"\nCLAIMS block rewritten ({len(claims)} claims)")
        return 0

    if mismatches:
        print(f"\n{len(mismatches)} MISMATCH(ES):")
        for m in mismatches:
            print("  " + m)
        return 1
    print(f"\n{len(claims)}/{len(claims)} claims reproduced - 0 mismatches - no credentials required")
    return 0


if __name__ == "__main__":
    sys.exit(main())
