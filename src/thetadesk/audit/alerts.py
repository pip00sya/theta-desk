"""Alerts — the desk can call for help (DEVLOG #21).

An integrity breach at 19:15 UTC on Sep 1 stopped the agent silently; it was
noticed only because someone happened to be watching. Every alert is
appended to data/alerts.log and journaled; if ALERT_TELEGRAM_TOKEN +
ALERT_TELEGRAM_CHAT_ID (or ALERT_WEBHOOK_URL) are set in .env it is also
pushed out. Delivery failures never break a tick.

DEVLOG #39: push delivery also stops the instant `data/alerts_mute` exists —
not another env var. pulse.py and tools/manager.py are long-running
processes that read .env once at their own startup; every push channel they
spawn (`thetadesk.main tick`/`manage`) inherits THEIR environment, not a
fresh read of .env, so an env edit only reaches a channel that has not yet
started. On 2026-09-08 the S4U boot task started before the mute was set and
this session had no permission to kill or restart it (Stop-Process/taskkill:
access denied) — env alone could not have silenced it. A marker file is
opened fresh on every single alert() call, in whichever process makes it, so
muting is immediate regardless of which loop is stale. `touch`/`rm` it, or
the alert-mute CLI below.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[3]


def _data_dir() -> Path:
    return ROOT / os.environ.get("THETADESK_DATA_DIR", "data")


def log_path() -> Path:
    # follows THETADESK_DATA_DIR like every other data path (DEVLOG #23)
    return _data_dir() / "alerts.log"


def mute_path() -> Path:
    return _data_dir() / "alerts_mute"


def muted() -> bool:
    return mute_path().exists()


def alert(level: str, title: str, text: str, journal=None) -> dict:
    """level: INFO | WARN | CRITICAL. Returns {logged, telegram, webhook, muted}."""
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"{ts} [{level}] {title}: {text}"
    out = {"logged": False, "telegram": False, "webhook": False, "muted": muted()}
    try:
        log = log_path()
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(line + ("  [muted: push suppressed]" if out["muted"] else "") + "\n")
        out["logged"] = True
    except OSError:
        pass
    if out["muted"]:
        # still logged and journaled below — muting hides the phone, not the record
        if journal is not None:
            journal.append("alert", {"level": level, "title": title, "text": text[:500], **out})
        return out
    body = f"THETA DESK [{level}] {title}\n{text}"
    tok, chat = os.environ.get("ALERT_TELEGRAM_TOKEN"), os.environ.get("ALERT_TELEGRAM_CHAT_ID")
    if tok and chat:
        try:
            r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                              json={"chat_id": chat, "text": body}, timeout=10)
            out["telegram"] = r.ok
        except Exception:
            pass
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if url:
        try:
            r = requests.post(url, json={"level": level, "title": title, "text": text, "ts": ts},
                              timeout=10)
            out["webhook"] = r.ok
        except Exception:
            pass
    if journal is not None:
        journal.append("alert", {"level": level, "title": title, "text": text[:500], **out})
    return out


def _cli() -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--mute", action="store_true", help="stop Telegram/webhook pushes immediately")
    g.add_argument("--unmute", action="store_true", help="resume pushes")
    g.add_argument("--status", action="store_true")
    a = ap.parse_args()
    if a.mute:
        mute_path().parent.mkdir(parents=True, exist_ok=True)
        mute_path().write_text(datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n",
                               encoding="utf-8")
        print(f"muted — {mute_path()} written. Alerts still log and journal; nothing pushes.")
    elif a.unmute:
        mute_path().unlink(missing_ok=True)
        print("unmuted — pushes resume on the next alert.")
    else:
        print("muted" if muted() else "not muted")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_cli())
