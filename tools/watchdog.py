"""Dead-man watchdog — says so when the desk stops ticking.

The heartbeat task fires every 15 minutes in session hours. If the machine
sleeps, the scheduler stalls, or a tick hangs past its time limit, nothing in
the desk itself can report it: the process that would report is the one that
is not running. This runs from a SEPARATE scheduled task and reads only the
store's `last_tick_ts` (written at the end of every tick, DEVLOG #28).

Usage:
  python tools/watchdog.py            check, alert once per session if stale
  python tools/watchdog.py --print    print the verdict, send nothing

One alert per session (marker data/notes/<session>.watchdog); an INFO follows
when ticks resume, and the marker is cleared so a second stall re-alerts.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit import alerts                  # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

STALE_MIN = 35            # two missed ticks; one can be a slow LLM round
SESSION_START = (13, 45)  # UTC — first tick is 13:30, allow one grace tick
SESSION_END = (20, 20)    # UTC — last tick 20:00 (+ the evening block)


def session_date(now: datetime) -> str:
    return (now - timedelta(hours=4)).date().isoformat()


def in_session(now: datetime) -> bool:
    if now.weekday() >= 5:
        return False
    hm = (now.hour, now.minute)
    return SESSION_START <= hm <= SESSION_END


def check(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    try:
        raw = store.get_kv("last_tick_ts", "")
    finally:
        store.conn.close()
    last = datetime.fromisoformat(raw) if raw else None
    age_min = (now - last).total_seconds() / 60 if last else None
    stale = in_session(now) and (age_min is None or age_min > STALE_MIN)
    return {"now": now.isoformat(timespec="seconds"), "in_session": in_session(now),
            "last_tick_ts": raw or None, "age_min": None if age_min is None else round(age_min, 1),
            "stale": stale}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print", action="store_true", help="print only, send nothing")
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    v = check(now)
    marker = ROOT / "data" / "notes" / f"{session_date(now)}.watchdog"
    if a.print:
        print(v)
        return 0
    if v["stale"] and not marker.exists():
        last = v["last_tick_ts"] or "никогда"
        age = f"{v['age_min']:.0f} мин" if v["age_min"] is not None else "—"
        text = (f"Последний тик: {last[:16].replace('T', ' ')} UTC, прошло {age}.\n"
                f"Планировщик не запускает тики: компьютер спит, выключен или задача зависла.\n"
                f"Открытые позиции никто не сопровождает, пока тики не вернутся.")
        alerts.alert("CRITICAL", "деск молчит", text)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(v["now"], encoding="utf-8")
        print("stale -> alerted", v)
    elif not v["stale"] and marker.exists():
        alerts.alert("INFO", "деск снова тикает", f"Тики возобновились в {v['now'][11:16]} UTC.")
        marker.unlink()
        print("recovered -> cleared", v)
    else:
        print("ok", v)
    return 0


if __name__ == "__main__":
    sys.exit(main())
