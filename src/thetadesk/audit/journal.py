"""Hash-chained JSONL journal — the desk's tamper-evident memory.

Every decision, gate result, LLM exchange, order and mark is appended as one
JSON line carrying the SHA-256 of the previous line. `verify_chain()` proves
nothing was edited after the fact; reconcile and replay both read from here.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

GENESIS = "0" * 64


class Journal:
    def __init__(self, journal_dir: Path, name: str = "desk"):
        journal_dir.mkdir(parents=True, exist_ok=True)
        self.path = journal_dir / f"{name}.jsonl"
        self._last_hash = self._read_last_hash()

    def _read_last_hash(self) -> str:
        if not self.path.exists():
            return GENESIS
        last = None
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    last = line
        if not last:
            return GENESIS
        return json.loads(last)["entry_hash"]

    @staticmethod
    def _hash(payload: str) -> str:
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def append(self, kind: str, data: dict) -> dict:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "kind": kind,
            "data": data,
            "prev_hash": self._last_hash,
        }
        body = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        entry["entry_hash"] = self._hash(body)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self._last_hash = entry["entry_hash"]
        return entry

    def read_all(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    out.append(json.loads(line))
        return out

    def verify_chain(self) -> tuple[bool, str]:
        prev = GENESIS
        for i, e in enumerate(self.read_all()):
            if e["prev_hash"] != prev:
                return False, f"line {i + 1}: prev_hash mismatch"
            body = {k: e[k] for k in ("ts", "kind", "data", "prev_hash")}
            expect = self._hash(json.dumps(body, sort_keys=True, ensure_ascii=False))
            if e["entry_hash"] != expect:
                return False, f"line {i + 1}: entry_hash mismatch"
            prev = e["entry_hash"]
        return True, "chain intact"
