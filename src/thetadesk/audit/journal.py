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

    def _scan_tail(self) -> tuple[str, int | None, int]:
        """(last good entry_hash, byte offset of a corrupt trailing line or
        None, number of good lines). DEVLOG #28: a write interrupted mid-line
        (hard kill, disk full) used to make Journal() raise in __init__ on
        every later tick — the desk was dead until a human deleted the tail."""
        if not self.path.exists():
            return GENESIS, None, 0
        last_hash, good, bad_offset, offset = GENESIS, 0, None, 0
        with self.path.open("rb") as f:
            for raw in f:
                start = offset
                offset += len(raw)
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    last_hash = json.loads(line)["entry_hash"]
                    good += 1
                    bad_offset = None
                except (ValueError, KeyError, TypeError):
                    bad_offset = start if bad_offset is None else bad_offset
        return last_hash, bad_offset, good

    def _read_last_hash(self) -> str:
        last_hash, self._bad_tail, _ = self._scan_tail()
        return last_hash

    @staticmethod
    def _hash(payload: str) -> str:
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def append(self, kind: str, data: dict) -> dict:
        if getattr(self, "_bad_tail", None) is not None:
            # move the unparseable tail aside and continue from the last
            # good hash; the repair is itself journaled. verify_chain never
            # mutates the file — only a writer repairs.
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            with self.path.open("rb") as f:
                blob = f.read()
            tail = blob[self._bad_tail:]
            self.path.with_name(f"{self.path.name}.corrupt-{stamp}").write_bytes(tail)
            with self.path.open("r+b") as f:
                f.truncate(self._bad_tail)
            self._bad_tail = None
            self._write({"ts": datetime.now(timezone.utc).isoformat(), "kind": "journal_tail_repaired",
                         "data": {"bytes_moved": len(tail), "moved_to": f"{self.path.name}.corrupt-{stamp}"},
                         "prev_hash": self._last_hash})
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "kind": kind,
            "data": data,
            "prev_hash": self._last_hash,
        }
        return self._write(entry)

    def _write(self, entry: dict) -> dict:
        body = json.dumps(entry, sort_keys=True, ensure_ascii=False)
        entry["entry_hash"] = self._hash(body)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            f.flush()
        self._last_hash = entry["entry_hash"]
        return entry

    def read_all(self) -> list[dict]:
        """Every parseable line. An unparseable line is reported as a broken
        chain by verify_chain (it is skipped here so the tools keep working)."""
        if not self.path.exists():
            return []
        out = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        out.append({"_unparseable": True, "prev_hash": None, "entry_hash": None})
        return out

    def verify_chain(self) -> tuple[bool, str]:
        prev = GENESIS
        for i, e in enumerate(self.read_all()):
            if e.get("_unparseable"):
                return False, f"line {i + 1}: unparseable"
            if e["prev_hash"] != prev:
                return False, f"line {i + 1}: prev_hash mismatch"
            body = {k: e[k] for k in ("ts", "kind", "data", "prev_hash")}
            expect = self._hash(json.dumps(body, sort_keys=True, ensure_ascii=False))
            if e["entry_hash"] != expect:
                return False, f"line {i + 1}: entry_hash mismatch"
            prev = e["entry_hash"]
        return True, "chain intact"
