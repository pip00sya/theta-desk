"""The desk's fast hand: a management pass every minute while the exchange is open.

The fifteen-minute tick DECIDES. This loop only MANAGES what the tick decided:
each pass reconciles working orders with the broker, checks the book against
the broker's positions, re-marks every open structure on a fresh chain and
applies the exit rules — profit target, structure stop, trailing stop, time
stop, event shield. It cannot open anything: `thetadesk.main manage` returns
before the selector exists.

Why a second cadence (DEVLOG #36): on 2026-09-01 the fourth position touched
its +60% target between ticks and the next tick found it lower. An exit that
is checked every fifteen minutes is an exit with a fifteen-minute hole in it.
A slow clock for deciding and a fast one for managing is the ordinary shape
of a desk; ours simply did not have the fast one until now.

Each pass is a subprocess under the tick's own lock, so the two can never
overlap and one bad pass can never take the loop down. The loop steps aside
for the minutes in which the scheduler fires, and sleeps while the exchange
is shut. It republishes the console's export every few passes so the page is
current between ticks; it never touches git — that stays with the tick.

Usage:
  python tools/manager.py                     a pass every 60s while the market is open
  python tools/manager.py --interval 30       faster
  python tools/manager.py --once              a single pass, for testing
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "data" / "manager.log"
LOG_MAX = 4000                              # lines; trimmed past this
EXPORT = ROOT / "dashboard" / "web" / "data.json"
TRADING = "https://paper-api.alpaca.markets"
TICK_MINUTES = (0, 1)                       # the scheduler fires at :00/:15/:30/:45


def _env() -> dict[str, str]:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    return {"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
            "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET_KEY"]}


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}\n")


def _trim_log() -> None:
    try:
        lines = LOG.read_text(encoding="utf-8").splitlines()
        if len(lines) > LOG_MAX:
            LOG.write_text("\n".join(lines[-LOG_MAX:]) + "\n", encoding="utf-8")
    except OSError:
        pass


def _child_env() -> dict[str, str]:
    return {**os.environ, "PYTHONPATH": str(ROOT / "src"), "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8"}


PASS_TIMEOUT_S = 120        # a pass takes seconds; this is a hung socket, not a slow pass


def _release_own_lock(started_iso: str) -> bool:
    """A pass killed on timeout never reaches its `finally`, and its tick_lock
    would sit until the 10-minute stale limit — a quarter hour in which the
    tick skips and every pass yields. The lock's value is the instant it was
    taken; one taken after this pass started is this pass's, and is cleared."""
    try:
        sys.path.insert(0, str(ROOT / "src"))
        from thetadesk import config as cfgmod            # noqa: PLC0415
        from thetadesk.state.store import Store           # noqa: PLC0415
        store = Store(cfgmod.load().db_path)
        held = store.get_kv("tick_lock", "") or ""
        if held and held >= started_iso:
            store.set_kv("tick_lock", "")
            return True
    except Exception as e:                                  # noqa: BLE001
        log(f"lock check failed: {str(e)[:120]}")
    return False


def run_pass() -> tuple[int, str]:
    """One `thetadesk.main manage` in its own process, under the tick's lock."""
    started = datetime.now(timezone.utc).isoformat()
    try:
        r = subprocess.run([sys.executable, "-m", "thetadesk.main", "manage"],
                           cwd=ROOT, env=_child_env(), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=PASS_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        freed = _release_own_lock(started)
        return 124, f"pass timed out after {PASS_TIMEOUT_S}s" + (" — its lock released" if freed else "")
    out = (r.stdout or "").strip().splitlines()
    err = (r.stderr or "").strip().splitlines()
    tail = (out[-1] if out else "") + ((" | " + err[-1]) if err else "")
    return r.returncode, tail[:400]


def publish_export() -> None:
    """Rebuild the console's export atomically: a page polling every minute
    must never read half a file. Git is the tick wrapper's job, not ours."""
    tmp = EXPORT.with_suffix(".json.tmp")
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "site_data.py"), "--out", str(tmp)],
                       cwd=ROOT, env=_child_env(), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    if r.returncode == 0 and tmp.exists() and tmp.stat().st_size > 1000:
        os.replace(tmp, EXPORT)
    else:
        log(f"export failed rc={r.returncode}: {(r.stderr or '')[-200:]}")
        try:
            tmp.unlink()
        except OSError:
            pass


def _seconds_until(iso: str) -> float:
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (t - datetime.now(timezone.utc)).total_seconds()
    except (ValueError, AttributeError):
        return 300.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=60.0, help="seconds between passes")
    ap.add_argument("--publish-every", type=int, default=5, help="rebuild the export every N passes")
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()

    import requests
    headers = _env()
    session = requests.Session()
    passes, closed_logged = 0, False
    log(f"manager started, interval {a.interval:g}s, pid {os.getpid()}")

    while True:
        t0 = time.monotonic()
        try:
            clock = session.get(TRADING + "/v2/clock", headers=headers, timeout=8).json()
        except Exception as e:                                   # noqa: BLE001
            log(f"clock unavailable: {str(e)[:120]}")
            if a.once:
                return 1
            time.sleep(a.interval)
            continue

        if not clock.get("is_open"):
            if not closed_logged:
                log(f"exchange closed — next open {clock.get('next_open')}")
                closed_logged = True
            if a.once:
                rc, tail = run_pass()          # still reconciles + checks integrity
                log(f"pass (closed) rc={rc} {tail}")
                return rc
            time.sleep(min(300.0, max(5.0, _seconds_until(clock.get("next_open", "")))))
            continue
        closed_logged = False

        now = datetime.now(timezone.utc)
        if now.minute % 15 in TICK_MINUTES and not a.once:
            # the scheduler's slot: the tick decides here, we step aside
            time.sleep(61 - now.second)
            continue

        try:
            rc, tail = run_pass()
        except Exception as e:                                   # noqa: BLE001
            # the loop outlives any single pass: log it, wait a minute, go on
            rc, tail = 125, f"pass could not run: {type(e).__name__}: {str(e)[:160]}"
        passes += 1
        log(f"pass {passes} rc={rc} {tail}")
        if rc == 0 and a.publish_every > 0 and passes % a.publish_every == 0:
            try:
                publish_export()
            except Exception as e:                               # noqa: BLE001
                log(f"export error: {str(e)[:160]}")
        if passes % 200 == 0:
            _trim_log()
        if a.once:
            return rc
        time.sleep(max(1.0, a.interval - (time.monotonic() - t0)))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
