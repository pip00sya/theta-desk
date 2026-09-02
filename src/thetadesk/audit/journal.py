"""Hash-chained JSONL journal — the desk's tamper-evident memory.

Every decision, gate result, LLM exchange, order and mark is appended as one
JSON line carrying the SHA-256 of the previous line. `verify_chain()` proves
nothing was edited after the fact; reconcile and replay both read from here.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

GENESIS = "0" * 64

try:                                    # POSIX
    import fcntl
    _HAVE_FCNTL = True
except ImportError:                     # Windows
    import msvcrt
    _HAVE_FCNTL = False


@contextlib.contextmanager
def _exclusive(path: Path):
    """Hold an OS-level exclusive lock on a sidecar file across the whole
    read-tail / append cycle. DEVLOG #33: the chain was linked from a hash
    cached in __init__, so a SECOND writer (a tool run by hand while a tick
    was in flight) forked it — 2026-09-02 17:45:14, broker_check.py appended
    while the 17:45 tick held a stale tail, and every later entry chained onto
    a hash that was no longer the last one. The tick lock never covered this:
    it serialises ticks, not tools."""
    lock = path.with_name(path.name + ".lock")
    with lock.open("a+b") as f:
        try:
            if _HAVE_FCNTL:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            else:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
            yield
        finally:
            with contextlib.suppress(OSError):
                if _HAVE_FCNTL:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                else:
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


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
        with _exclusive(self.path):
            # the FILE is the source of truth for the tail, not this process's
            # memory: another writer may have appended since __init__
            self._last_hash = self._read_last_hash()
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
