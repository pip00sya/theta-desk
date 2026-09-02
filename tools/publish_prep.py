"""Compress tick snapshots before they are committed.

A snapshot is the whole option chain for one tick: ~443 KB, ~26 per session.
Committing them raw would add ~11 MB a day to a repository judges clone, and
~140 MB over the judging window. gzip takes the same file to ~126 KB.

The raw .json stays on the machine (gitignored); the .json.gz is what the
repository carries, and tools/replay.py reads either form, so the replay
evidence is unchanged.

Usage: python tools/publish_prep.py [--keep-raw-days N]
"""
from __future__ import annotations

import argparse
import gzip
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402


def compress(snapshot_dir: Path) -> tuple[int, int, int]:
    """Returns (compressed now, already done, bytes saved)."""
    made = skipped = saved = 0
    for raw in sorted(snapshot_dir.glob("*.json")):
        gz = raw.with_suffix(".json.gz")
        if gz.exists():
            skipped += 1
            continue
        with raw.open("rb") as src, gzip.open(gz, "wb", compresslevel=9) as dst:
            shutil.copyfileobj(src, dst)
        saved += raw.stat().st_size - gz.stat().st_size
        made += 1
    return made, skipped, saved


def prune_raw(snapshot_dir: Path, keep_days: int) -> int:
    """Drop raw .json older than keep_days once a .gz exists beside it."""
    if keep_days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    dropped = 0
    for raw in sorted(snapshot_dir.glob("*.json")):
        if not raw.with_suffix(".json.gz").exists():
            continue
        try:
            stamp = datetime.strptime(raw.name[:15], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if stamp < cutoff:
            raw.unlink()
            dropped += 1
    return dropped


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-raw-days", type=int, default=3)
    args = ap.parse_args()
    d = cfgmod.load().snapshot_dir
    made, skipped, saved = compress(d)
    dropped = prune_raw(d, args.keep_raw_days)
    print(f"snapshots: {made} compressed, {skipped} already, "
          f"{saved / 1e6:.1f} MB saved, {dropped} raw pruned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
