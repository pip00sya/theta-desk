"""Offline demo: simulate a trading week against the mock market so the
dashboard, replay and reconcile have real material to show.

Scenario: 8 ticks over 4 'days'; spot drifts sideways-down, vol softens —
the condor decays profitably; day 3 the profit target fires.

Usage: python tools/demo_week.py   (wipes data/ demo state first)
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.main import cmd_tick                 # noqa: E402


class Args:
    mock = True
    dry_run = True


def reset():
    for p in [ROOT / "data" / "thetadesk.sqlite"]:
        p.unlink(missing_ok=True)
    jdir = ROOT / "data" / "journal"
    if jdir.exists():
        for f in jdir.glob("*.jsonl"):
            f.unlink()
    sdir = ROOT / "data" / "snapshots"
    if sdir.exists():
        for f in sdir.glob("*.json"):
            f.unlink()


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
        cmd_tick(Args())
    m.make_client = orig

    print("\ndemo complete — now run:")
    print("  python -m thetadesk.main status")
    print("  python tools/replay.py")
    print("  python tools/reconcile.py --write")
    print("  streamlit run dashboard/app.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
