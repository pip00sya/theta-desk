"""Offline demo: simulate a trading week against the mock market so the
dashboard, replay and reconcile have real material to show.

Scenario: 8 ticks over 4 'days'; spot drifts sideways-down, vol softens —
the condor decays profitably; day 3 the profit target fires.

Usage: python tools/demo_week.py
Everything lands in data/demo/ (THETADESK_DATA_DIR) — the live store, journal
and snapshots are never touched (DEVLOG #23). To inspect the demo week:
  THETADESK_DATA_DIR=data/demo python tools/replay.py
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO_DIR = "data/demo"
os.environ["THETADESK_DATA_DIR"] = DEMO_DIR      # before any thetadesk import
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.main import cmd_tick_locked          # noqa: E402


class Args:
    mock = True
    dry_run = True


def reset():
    demo = ROOT / DEMO_DIR
    assert demo.resolve() != (ROOT / "data").resolve(), "refusing to wipe the live data dir"
    shutil.rmtree(demo, ignore_errors=True)
    demo.mkdir(parents=True, exist_ok=True)


def main() -> int:
    reset()
    import thetadesk.main as m
    from thetadesk.data.mock_client import MockAlpacaClient

    # (spot, atm_iv) path: sideways drift down, vol softening
    path = [(650.0, 0.145), (649.0, 0.143), (647.5, 0.140), (648.5, 0.137),
            (646.0, 0.133), (647.0, 0.128), (645.5, 0.122), (646.5, 0.118)]

    orig = m.make_client

    for i, (spot, iv) in enumerate(path):
        m.make_client = lambda mock, s=spot, v=iv: MockAlpacaClient(spot=s, atm_iv=v)
        print(f"\n=== tick {i + 1}/8  spot={spot} iv={iv} ===")
        cmd_tick_locked(Args())
    m.make_client = orig

    print(f"\ndemo complete in {DEMO_DIR}/ — inspect it with THETADESK_DATA_DIR={DEMO_DIR}:")
    print("  python -m thetadesk.main status")
    print("  python tools/replay.py")
    print("  streamlit run dashboard/app.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
