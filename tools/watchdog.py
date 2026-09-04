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


def _age_min(raw: str, now: datetime) -> float | None:
    if not raw:
        return None
    return (now - datetime.fromisoformat(raw)).total_seconds() / 60


def check(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    try:
        raw = store.get_kv("last_tick_ts", "")
        raw_manage = store.get_kv("last_manage_ts", "")
    finally:
        store.conn.close()
    age_min = _age_min(raw, now)
    stale = in_session(now) and (age_min is None or age_min > STALE_MIN)
    # DEVLOG #36b: the fast loop is a second thing that can die on its own. If
    # it does, exits quietly fall back to the fifteen-minute tick and nothing
    # says so — the desk looks healthy while its fast hand is gone. The loop
    # writes last_manage_ts every pass, whether or not the pass journalled.
    m_stale_after = float(cfg.raw.get("manage", {}).get("stale_after_min", 6))
    age_manage = _age_min(raw_manage, now)
    manage_stale = in_session(now) and (age_manage is None or age_manage > m_stale_after)
    return {"now": now.isoformat(timespec="seconds"), "in_session": in_session(now),
            "last_tick_ts": raw or None, "age_min": None if age_min is None else round(age_min, 1),
            "stale": stale,
            "last_manage_ts": raw_manage or None,
            "manage_age_min": None if age_manage is None else round(age_manage, 1),
            "manage_stale": manage_stale, "manage_stale_after_min": m_stale_after}


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

    # The fast loop dies on its own terms (DEVLOG #36b). Its own marker, so a
    # dead loop and a dead scheduler are two different pages, and a desk that
    # is ticking but no longer managing every minute cannot look healthy.
    m_marker = ROOT / "data" / "notes" / f"{session_date(now)}.manager"
    if v["manage_stale"] and not m_marker.exists():
        last = v["last_manage_ts"] or "никогда"
        age = f"{v['manage_age_min']:.0f} мин" if v["manage_age_min"] is not None else "—"
        alerts.alert("WARN", "быстрый цикл выходов молчит",
                     f"Последний проход: {last[:16].replace('T', ' ')} UTC, прошло {age}.\n"
                     f"Правила выхода сейчас проверяются только тиком — раз в 15 минут.\n"
                     f"Позиции сопровождаются, но медленнее. Запустить: ops\\manager.ps1")
        m_marker.parent.mkdir(parents=True, exist_ok=True)
        m_marker.write_text(v["now"], encoding="utf-8")
        print("manager stale -> alerted")
    elif not v["manage_stale"] and m_marker.exists():
        alerts.alert("INFO", "быстрый цикл вернулся",
                     f"Проходы возобновились в {v['now'][11:16]} UTC.")
        m_marker.unlink()
        print("manager recovered -> cleared")
    return 0


if __name__ == "__main__":
    sys.exit(main())
