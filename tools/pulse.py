"""A read-only heartbeat against the broker, separate from the trading tick.

The desk trades every fifteen minutes and that is deliberate: an options desk
that re-decides every second is not a desk, it is a random number generator with
a broker account. But a dashboard that only moves every fifteen minutes cannot
be told apart from a screenshot, and with the market closed it cannot be told
apart from a dead one.

So this is the other half: a loop that only ever GETs. It reads the exchange
clock, the account, and the last trade on the primary underlying, and writes a
small file the console polls. It has no order path — the Alpaca endpoints it
touches are the clock, the account and market data, and nothing else. It cannot
open, close, or modify a position even if it wanted to.

What genuinely changes while the market is closed: the exchange's own clock, the
countdown to the next open, the age of the last poll, and the sequence number.
The equity moves when the equity moves. The console labels each for what it is
rather than implying the book is trading at midnight.

Usage:
  python tools/pulse.py                      poll every 3s until stopped
  python tools/pulse.py --interval 5         a slower cadence
  python tools/pulse.py --once               a single poll, for testing
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

OUT = ROOT / "dashboard" / "web" / "live.json"
LOG = ROOT / "data" / "pulse.jsonl"
LOG_MAX = 20_000                       # lines; the file is trimmed past this

TRADING = "https://paper-api.alpaca.markets"
DATA = "https://data.alpaca.markets"


def _env() -> dict[str, str]:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    return {"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
            "APCA-API-SECRET-KEY": os.environ["ALPACA_SECRET_KEY"]}


def _atomic(path: Path, text: str) -> None:
    """A reader must never see half a file."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def poll(session, headers: dict, sym: str, seq: int, started: float,
         account_every: int, last_account: dict | None) -> dict:
    t0 = time.time()
    out: dict = {"seq": seq, "t": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "uptime_s": round(time.time() - started, 1), "sym": sym}

    # the exchange clock: the one thing that is different on every single call
    try:
        c = session.get(TRADING + "/v2/clock", headers=headers, timeout=8).json()
        # keep the offsets: these are exchange-local instants, and truncating
        # them to nineteen characters silently turned 09:30 New York into
        # 09:30 UTC, which made the countdown read "now" all morning
        out["market"] = {"is_open": bool(c.get("is_open")),
                         "server_time": c.get("timestamp", ""),
                         "next_open": c.get("next_open", ""),
                         "next_close": c.get("next_close", "")}
    except Exception as e:
        out["market"] = {"error": str(e)[:120]}

    # the account, less often: it cannot move faster than a fill
    if seq % account_every == 0 or last_account is None:
        try:
            a = session.get(TRADING + "/v2/account", headers=headers, timeout=10).json()
            out["account"] = {"equity": round(float(a["equity"]), 2),
                              "cash": round(float(a["cash"]), 2),
                              "buying_power": round(float(a["buying_power"]), 2),
                              "as_of": out["t"]}
        except Exception as e:
            out["account"] = last_account or {"error": str(e)[:120]}
    else:
        out["account"] = last_account

    # the last print on the primary underlying, with the exchange's own stamp
    try:
        q = session.get(DATA + f"/v2/stocks/{sym}/trades/latest",
                        params={"feed": "iex"}, headers=headers, timeout=8).json()
        tr = q.get("trade") or {}
        out["last_trade"] = {"price": tr.get("p"), "at": str(tr.get("t", ""))[:19],
                             "size": tr.get("s")}
    except Exception as e:
        out["last_trade"] = {"error": str(e)[:120]}

    out["poll_ms"] = int((time.time() - t0) * 1000)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=3.0, help="seconds between polls")
    ap.add_argument("--account-every", type=int, default=5, help="poll the account every Nth cycle")
    ap.add_argument("--symbol", default=None, help="defaults to the config's primary underlying")
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()

    from thetadesk import config as cfgmod
    sym = a.symbol or cfgmod.load().raw["universe"]["primary"]

    import requests
    session = requests.Session()
    headers = _env()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    LOG.parent.mkdir(parents=True, exist_ok=True)

    started, seq, last_account = time.time(), 0, None
    while True:
        seq += 1
        rec = poll(session, headers, sym, seq, started, a.account_every, last_account)
        if isinstance(rec.get("account"), dict) and "equity" in rec["account"]:
            last_account = rec["account"]
        _atomic(OUT, json.dumps(rec, separators=(",", ":")))
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")
        if seq % 500 == 0:                       # keep the log bounded
            lines = LOG.read_text(encoding="utf-8").splitlines()
            if len(lines) > LOG_MAX:
                LOG.write_text("\n".join(lines[-LOG_MAX:]) + "\n", encoding="utf-8")
        if a.once:
            print(json.dumps(rec, indent=1))
            return 0
        time.sleep(max(0.5, a.interval))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
