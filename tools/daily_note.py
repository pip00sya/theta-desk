"""Daily note — the agent writes its own end-of-day retro (PLAN-MAX 2.2 lite).

Reads today's journal + account state, asks the analyst-tier model for a
short honest retro, saves data/notes/YYYY-MM-DD.md and the meetings table.
Doubles as build-in-public draft material. No parameters are changed —
this is reflection, not self-modification.

Usage: python tools/daily_note.py   (wired into tick_wrapper's evening block)
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.agents import llm                    # noqa: E402
from thetadesk.audit.journal import Journal         # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

SYSTEM = (
    "You are the desk's end-of-day narrator. You receive a compressed log of "
    "one trading day of an autonomous options agent (paper trading). Write an "
    "honest 6-10 sentence retro in first person plural: what the signal said, "
    "what was opened/closed/refused and why, what the P&L did, one thing that "
    "worked, one risk we are carrying into tomorrow. Plain language, no hype, "
    "no advice. End with a single-sentence 'tomorrow we watch: ...'"
)


def main() -> int:
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    journal = Journal(cfg.journal_dir)
    today = date.today().isoformat()

    entries = [e for e in journal.read_all() if e["ts"][:10] == today]
    if not entries:
        print("no journal entries today — skipping note")
        return 0

    compact = []
    for e in entries:
        k, d = e["kind"], e["data"]
        if k == "signals":
            compact.append(f"signals spot={d['spot']:.1f} rv={d['rv20']:.3f} "
                           f"iv={d['atm_iv']:.3f} vrp={d['vrp_score']:.2f}")
        elif k == "desk":
            compact.append(f"desk {d['regime_analyst']}/{d['regime_second']} "
                           f"veto={d['veto']} mult={d['size_mult']}")
        elif k in ("order_open", "order_close", "order_hedge"):
            compact.append(f"{k} {json.dumps(d.get('payload', {}).get('symbol') or d, default=str)[:90]}")
        elif k in ("entry_refused", "desk_veto", "derisk_mode", "size_zero"):
            compact.append(f"{k}: {json.dumps(d, default=str)[:110]}")
        elif k == "manage" and d.get("action") == "close":
            compact.append(f"close {d['structure_id'][:8]}: {d['reason']} pnl~{d['est_pnl']:.0f}")
        elif k == "marks":
            compact.append(f"marks {json.dumps(d)}")
    digest = "\n".join(compact[-70:])
    realized = store.realized_gains()

    L = cfg["llm"]
    ex = llm.call("daily_note", L["analyst_provider"], L["analyst_model"],
                  SYSTEM, f"Date: {today}\nRealized P&L to date: ${realized:.2f}\n"
                          f"Day log:\n{digest}", timeout_s=60, max_tokens=500)
    if not ex.ok:
        print("note generation failed:", ex.fallback_reason)
        return 1

    notes_dir = ROOT / "data" / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    path = notes_dir / f"{today}.md"
    path.write_text(f"# THETA DESK — daily note {today}\n\n{ex.response_text}\n",
                    encoding="utf-8")
    store.add_meeting("daily_note", [ex.to_dict()])
    print(f"note saved: {path}")
    print(ex.response_text[:400])
    return 0


if __name__ == "__main__":
    sys.exit(main())
