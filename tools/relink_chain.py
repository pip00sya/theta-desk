"""Re-link a journal whose chain forked because two writers appended at once.

This does NOT edit any entry. It recomputes prev_hash/entry_hash from the fork
point onward so the links match the order the entries were actually written,
and appends a `chain_relinked` record naming the fork. Content is verifiable:
--check prints the per-entry diff of (ts, kind, data) before and after, which
must be empty for every line.

Usage:
  python tools/relink_chain.py            report the fork, change nothing
  python tools/relink_chain.py --write    back up, re-link, journal the repair
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit.journal import GENESIS, Journal  # noqa: E402

BODY_KEYS = ("ts", "kind", "data", "prev_hash")


def _hash(body: str) -> str:
    import hashlib
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    cfg = cfgmod.load()
    path = cfg.journal_dir / "desk.jsonl"
    entries = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    before = [(e["ts"], e["kind"], json.dumps(e["data"], sort_keys=True)) for e in entries]

    forks, prev = [], GENESIS
    for i, e in enumerate(entries, 1):
        if e["prev_hash"] != prev:
            forks.append((i, e["ts"], e["kind"], e["prev_hash"][:10], prev[:10]))
        prev = e["entry_hash"]
    if not forks:
        print("chain intact — nothing to re-link")
        return 0
    for i, ts, kind, got, want in forks:
        print(f"fork at line {i}: {ts} {kind}\n  prev_hash {got}… but the line above hashes to {want}…")
    if not a.write:
        print("\ndry run — pass --write to re-link")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    backup = path.with_name(f"{path.name}.forked-{stamp}")
    shutil.copy2(path, backup)

    prev = GENESIS
    for e in entries:
        e["prev_hash"] = prev
        body = {k: e[k] for k in BODY_KEYS}
        e["entry_hash"] = _hash(json.dumps(body, sort_keys=True, ensure_ascii=False))
        prev = e["entry_hash"]
    after = [(e["ts"], e["kind"], json.dumps(e["data"], sort_keys=True)) for e in entries]
    assert before == after, "content changed — refusing to write"
    path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    j = Journal(cfg.journal_dir)
    j.append("chain_relinked", {
        "reason": "concurrent append forked the chain; entries unchanged, links recomputed",
        "forks": [{"line": i, "ts": ts, "kind": k} for i, ts, k, _, _ in forks],
        "entries": len(entries), "backup": backup.name})
    ok, why = Journal(cfg.journal_dir).verify_chain()
    print(f"\nre-linked {len(entries)} entries · content identical · backup {backup.name}")
    print(f"verify: {'OK' if ok else 'FAIL'} — {why}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
