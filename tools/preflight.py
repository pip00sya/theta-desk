"""Pre-open check of the LIVE desk: everything the first tick will need,
read the way the tick reads it, printed as go / no-go (DEVLOG #36).

  python tools/preflight.py

Exit 0 = go. Exit 1 = at least one blocker. Warnings do not block.
Nothing here trades or writes; the only broker calls are GETs.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod                     # noqa: E402
from thetadesk.audit.journal import Journal                # noqa: E402
from thetadesk.engine import ladder as ladmod              # noqa: E402
from thetadesk.state.store import Store                    # noqa: E402

TRADING = "https://paper-api.alpaca.markets"
rows: list[tuple[str, str, str]] = []          # (level, check, detail)


def say(level: str, check: str, detail: str) -> None:
    rows.append((level, check, detail))


def _env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def _pid_alive(marker: Path) -> tuple[bool, str]:
    if not marker.exists():
        return False, "no pid file"
    pid = marker.read_text().strip()
    r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
    return (pid in r.stdout), f"pid {pid}"


def main() -> int:
    _env()
    now = datetime.now(timezone.utc)
    cfg = cfgmod.load()

    # ---- environment ---------------------------------------------------------
    url = os.environ.get("APCA_API_BASE_URL", "")
    say("ok" if "paper-api" in url else "BLOCK", "paper-only", url or "APCA_API_BASE_URL unset")
    for k in ("ALPACA_API_KEY", "ALPACA_SECRET_KEY"):
        say("ok" if os.environ.get(k) else "BLOCK", k, "set" if os.environ.get(k) else "missing")
    for k in ("ANTHROPIC_API_KEY", "FEATHERLESS_API_KEY"):
        say("ok" if os.environ.get(k) else "warn", k,
            "set" if os.environ.get(k) else "missing — the desk roles fall back to the deterministic core")
    cli = subprocess.run(["alpaca", "--version"], capture_output=True, text=True)
    say("ok" if cli.returncode == 0 else "warn", "alpaca cli",
        (cli.stdout or cli.stderr).strip()[:60] or "not found — REST fallback")

    # ---- the broker, read-only -------------------------------------------------
    import requests
    h = {"APCA-API-KEY-ID": os.environ.get("ALPACA_API_KEY", ""),
         "APCA-API-SECRET-KEY": os.environ.get("ALPACA_SECRET_KEY", "")}
    equity = None
    try:
        a = requests.get(TRADING + "/v2/account", headers=h, timeout=10).json()
        equity = float(a["equity"])
        lvl = int(a.get("options_trading_level") or 0)
        say("ok", "account", f"equity {equity:,.2f} · options level {lvl} · status {a.get('status')}")
        say("ok" if lvl >= 3 else "BLOCK", "options level", f"{lvl} (mleg needs 3)")
        say("ok" if a.get("trading_blocked") is False else "BLOCK", "trading_blocked", str(a.get("trading_blocked")))
    except Exception as e:                                             # noqa: BLE001
        say("BLOCK", "account", f"unreadable: {str(e)[:100]}")
    market_open = False
    try:
        c = requests.get(TRADING + "/v2/clock", headers=h, timeout=10).json()
        market_open = bool(c.get("is_open"))
        say("ok", "exchange clock", f"open={c.get('is_open')} next_open={c.get('next_open')}")
    except Exception as e:                                             # noqa: BLE001
        say("BLOCK", "exchange clock", str(e)[:100])
    try:
        orders = requests.get(TRADING + "/v2/orders", headers=h, params={"status": "open"}, timeout=10).json()
        say("ok" if not orders else "warn", "working orders at broker", str(len(orders)))
        pos = requests.get(TRADING + "/v2/positions", headers=h, timeout=10).json()
        say("ok", "positions at broker", ", ".join(f"{p['symbol']}×{p['qty']}" for p in pos) or "flat")
    except Exception as e:                                             # noqa: BLE001
        say("warn", "orders/positions", str(e)[:100])

    # ---- the store -----------------------------------------------------------
    store = Store(cfg.db_path)
    lock = store.get_kv("tick_lock", "")
    say("ok" if not lock else "warn", "tick lock", "free" if not lock else f"held since {lock}")
    stuck = [s for s in store.open_structures() if s["status"] in ("submitting", "pending", "closing")]
    say("ok" if not stuck else "warn", "working rows in store",
        "none" if not stuck else ", ".join(f"{s['kind']} {s['status']}" for s in stuck))
    today = (now + timedelta(hours=-4)).date().isoformat()
    veto = store.get_kv("veto_session", "")
    say("ok" if veto != today else "warn", "sticky veto", "none today" if veto != today else "SET for today")
    hwm = float(store.get_kv("high_watermark", "0") or 0)
    lad = ladmod.resolve(cfg.raw, store.closed_core_count(), store.realized_gains(),
                         equity or hwm or 1.0, hwm)
    say("ok", "size ladder", f"rung {lad.tier.name} · {lad.reason} · per-structure "
                            f"{lad.tier.per_structure:.1%} = ${(equity or 0) * lad.tier.per_structure:,.0f}")
    dd = lad.drawdown
    say("ok" if dd < cfg['risk']['drawdown_halt_frac'] else "BLOCK", "drawdown vs halt",
        f"{dd:.2%} vs {cfg['risk']['drawdown_halt_frac']:.0%}")
    last = store.get_kv("last_tick_ts", "")
    say("ok", "last tick", last[:19] or "never")
    lm = store.get_kv("last_manage_ts", "")
    say("ok", "last management pass", lm[:19] or "never")

    # ---- the journal -----------------------------------------------------------
    ok, msg = Journal(cfg.journal_dir).verify_chain()
    say("ok" if ok else "BLOCK", "hash chain", msg)

    # ---- the calendar and the expiry ------------------------------------------
    exp = datetime.fromisoformat(cfg["expiry"]["target_expiry"]).replace(tzinfo=timezone.utc)
    dte = (exp.date() - now.date()).days
    min_dte = int(cfg["management"].get("min_entry_dte", 10))
    say("ok" if dte >= min_dte else "BLOCK", "target expiry",
        f"{cfg['expiry']['target_expiry']} · {dte} DTE vs min {min_dte}")
    hi = [e for e in cfg.events() if e.klass == "high" and e.utc > now]
    nxt = min(hi, key=lambda e: e.utc) if hi else None
    if nxt:
        hrs = (nxt.utc - now).total_seconds() / 3600
        inside = hrs <= cfg["events"]["derisk_hours_before"]
        say("warn" if inside else "ok", "next high-class event",
            f"{nxt.name} in {hrs:.1f}h" + (" — INSIDE the de-risk window: no new risk" if inside else ""))
    else:
        say("ok", "next high-class event", "none ahead")

    # ---- the loops and the scheduler ------------------------------------------
    for name in ("pulse", "manager"):
        alive, det = _pid_alive(ROOT / "data" / f"{name}.pid")
        say("ok" if alive else "warn", f"{name} loop", ("running · " if alive else "NOT running · ") + det)
    # A live pid is not a working loop: the pass writes last_manage_ts every
    # minute whether or not it journalled, so its age is the real evidence —
    # but only while the exchange is open. The loop sleeps to the next open
    # when it is shut, so an old timestamp overnight is the design, not a fault.
    if lm and market_open:
        age_m = (now - datetime.fromisoformat(lm)).total_seconds() / 60
        limit = float(cfg.raw.get("manage", {}).get("stale_after_min", 6))
        fresh = age_m <= limit
        say("ok" if fresh else "warn", "last pass age",
            f"{age_m:.1f}m vs {limit:g}m" + ("" if fresh else " — the loop is not passing"))
    elif lm:
        say("ok", "last pass", f"{lm[:16].replace('T', ' ')}Z · the loop sleeps while the exchange is shut")
    say("ok", "passes today", f"{int(store.get_counter(today, 'manage_passes'))} · "
                              f"{int(store.get_counter(today, 'manage_closes'))} close(s) fired")
    q = subprocess.run(["schtasks", "/query", "/tn", "theta-desk-heartbeat", "/fo", "LIST", "/v"],
                       capture_output=True, text=True)
    status = next((l.split(":", 1)[1].strip() for l in q.stdout.splitlines() if l.startswith("Status")), "?")
    nrt = next((l.split(":", 1)[1].strip() for l in q.stdout.splitlines() if "Next Run Time" in l), "?")
    say("ok" if q.returncode == 0 and status.lower() in ("ready", "running") else "BLOCK",
        "scheduled task", f"{status} · next {nrt}")
    if (ROOT / "dashboard" / "web" / "live.json").exists():
        live = json.loads((ROOT / "dashboard" / "web" / "live.json").read_text(encoding="utf-8"))
        age = (now - datetime.fromisoformat(live["t"])).total_seconds()
        say("ok" if age < 30 else "warn", "pulse freshness", f"{age:.0f}s old · seq {live.get('seq')}")

    # ---- report ----------------------------------------------------------------
    w = max(len(r[1]) for r in rows)
    for level, check, detail in rows:
        print(f"{level:>5}  {check:<{w}}  {detail}")
    blockers = [r for r in rows if r[0] == "BLOCK"]
    warns = [r for r in rows if r[0] == "warn"]
    print(f"\n{'NO-GO' if blockers else 'GO'}: {len(blockers)} blocker(s), {len(warns)} warning(s), "
          f"{len(rows)} checks at {now:%H:%M:%S}Z")
    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
