"""Day-0 checklist (RED-TEAM §4) — automated where possible.

Usage:  python tools/selfcheck.py            (needs .env with paper keys)
        python tools/selfcheck.py --offline  (structure-only checks)

Checks:
  1. paper-only environment gate
  2. account reachable, equity == $100,000, account ID printed
  3. SPY chain for target expiry returns greeks + IV on the indicative feed
  4. options approval level in paper (expect 3)
  5. Alpaca CLI present (orders transport) — warn if missing (REST fallback)
  6. mleg dry-run payload validates locally
  7. clock endpoint answers (market open/closed)
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod                       # noqa: E402
from thetadesk.engine import selector as sel                 # noqa: E402
from thetadesk.engine.contracts import Structure             # noqa: E402
from thetadesk.execution import cli_bridge, mleg             # noqa: E402
from thetadesk.safety import SafetyError, assert_paper_only  # noqa: E402

GREEN, RED, YELLOW, END = "\033[92m", "\033[91m", "\033[93m", "\033[0m"


def mark(ok: bool, warn: bool = False) -> str:
    if ok:
        return f"{GREEN}PASS{END}"
    return f"{YELLOW}WARN{END}" if warn else f"{RED}FAIL{END}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()
    cfg = cfgmod.load()
    failures = 0

    # 1. paper gate
    try:
        url = assert_paper_only(exit_on_fail=False)
        print(f"[1] paper-only gate            {mark(True)}  ({url})")
    except SafetyError as e:
        print(f"[1] paper-only gate            {mark(False)}  {e}")
        failures += 1
        if not args.offline:
            print("    -> set APCA_API_BASE_URL=https://paper-api.alpaca.markets")

    # 5. CLI presence (independent of keys)
    has_cli = cli_bridge.cli_available()
    print(f"[5] alpaca CLI on PATH         {mark(has_cli, warn=True)}"
          + ("" if has_cli else "  (REST fallback active — install: brew install alpacahq/tap/cli)"))

    # 6. mleg payload validation (offline)
    from thetadesk.engine.contracts import Leg, OptionContract
    s = Structure("check", "put_credit_spread", "core",
                  [Leg(OptionContract.parse("SPY260918P00620000"), -1, 3.0),
                   Leg(OptionContract.parse("SPY260918P00610000"), +1, 1.8)], 1.2)
    try:
        p = mleg.build_mleg_payload(s, 1, 1.20, "selfcheck-0001")
        ok6 = p["order_class"] == "mleg" and len(p["legs"]) == 2
    except Exception:
        ok6 = False
    print(f"[6] mleg payload builds        {mark(ok6)}")
    failures += 0 if ok6 else 1

    if args.offline:
        print("\noffline mode: skipped live checks 2/3/4/7")
        return 1 if failures else 0

    if not (os.environ.get("ALPACA_API_KEY") and os.environ.get("ALPACA_SECRET_KEY")):
        print(f"\n{RED}no ALPACA_API_KEY / ALPACA_SECRET_KEY in env — cannot run live checks{END}")
        return 1

    from thetadesk.data.alpaca_client import AlpacaClient
    c = AlpacaClient()

    # 2. account
    try:
        a = c.account()
        eq = float(a.get("equity") or 0)
        ok2 = abs(eq - 100_000.0) < 1.0
        print(f"[2] account equity $100,000    {mark(ok2)}  equity=${eq:,.2f}  "
              f"ACCOUNT ID: {a.get('account_number') or a.get('id')}")
        if not ok2:
            print("    -> hackathon requires a FRESH paper account with exactly $100,000")
            failures += 1
    except Exception as e:
        print(f"[2] account reachable          {mark(False)}  {e}")
        failures += 1
        return 1

    # 4. options level
    lvl = a.get("options_trading_level", a.get("options_approved_level"))
    ok4 = str(lvl) == "3"
    print(f"[4] options level 3 in paper   {mark(ok4)}  level={lvl}")
    failures += 0 if ok4 else 1

    # 3. chain greeks
    try:
        chain = c.option_chain(cfg["universe"]["primary"], cfg["expiry"]["target_expiry"])
        entries = sel.parse_chain(chain)
        with_greeks = sum(1 for e in entries if e.delta is not None)
        with_iv = sum(1 for e in entries if e.iv)
        ok3 = len(entries) > 20 and with_greeks > 10 and with_iv > 10
        print(f"[3] chain greeks+IV (free)     {mark(ok3)}  contracts={len(entries)} "
              f"greeks={with_greeks} iv={with_iv}")
        failures += 0 if ok3 else 1
    except Exception as e:
        print(f"[3] chain greeks+IV            {mark(False)}  {e}")
        failures += 1

    # 7. clock
    try:
        clk = c.clock()
        print(f"[7] clock                      {mark(True)}  is_open={clk.get('is_open')}")
    except Exception as e:
        print(f"[7] clock                      {mark(False)}  {e}")
        failures += 1

    print(f"\n{'ALL GREEN — Friday warm-up allowed' if failures == 0 else str(failures) + ' failure(s) — trade Monday, fix over the weekend'}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
