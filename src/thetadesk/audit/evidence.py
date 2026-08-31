"""Daily evidence archive (RED-TEAM P14): at 16:05 ET snapshot everything a
judge could later ask about — account, positions, orders, activities,
portfolio history — into data/evidence/YYYY-MM-DD/.

Run via:  python -m thetadesk.audit.evidence
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path


def collect(client, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for name, fn in [
        ("account", client.account),
        ("positions", client.positions),
        ("orders", lambda: client.orders(status="all")),
        ("activities", client.activities),
        ("portfolio_history", lambda: client.portfolio_history(period="1M", timeframe="1D")),
    ]:
        try:
            data = fn()
            p = out_dir / f"{name}.json"
            p.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")
            saved.append(name)
        except Exception as e:
            (out_dir / f"{name}.error.txt").write_text(str(e), encoding="utf-8")
    return saved


def main() -> int:
    from .. import config as cfgmod
    from ..data.alpaca_client import AlpacaClient
    cfg = cfgmod.load()
    client = AlpacaClient()
    out = cfg.evidence_dir / date.today().isoformat()
    saved = collect(client, out)
    print(f"evidence saved to {out}: {', '.join(saved)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
