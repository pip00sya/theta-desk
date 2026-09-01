"""Alerts — the desk can call for help (DEVLOG #21).

An integrity breach at 19:15 UTC on Sep 1 stopped the agent silently; it was
noticed only because someone happened to be watching. Every alert is
appended to data/alerts.log and journaled; if ALERT_TELEGRAM_TOKEN +
ALERT_TELEGRAM_CHAT_ID (or ALERT_WEBHOOK_URL) are set in .env it is also
pushed out. Delivery failures never break a tick.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[3]


def log_path() -> Path:
    # follows THETADESK_DATA_DIR like every other data path (DEVLOG #23)
    return ROOT / os.environ.get("THETADESK_DATA_DIR", "data") / "alerts.log"


def alert(level: str, title: str, text: str, journal=None) -> dict:
    """level: INFO | WARN | CRITICAL. Returns {logged, telegram, webhook}."""
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    line = f"{ts} [{level}] {title}: {text}"
    out = {"logged": False, "telegram": False, "webhook": False}
    try:
        log = log_path()
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        out["logged"] = True
    except OSError:
        pass
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
