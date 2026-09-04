"""SQLite state store: book, marks, daily counters, tuned params, shadow books.

The broker is the source of truth for positions (RED-TEAM: reconcile every
tick); this store is the desk's working memory and the dashboard's backend.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS structures (
    structure_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    sleeve TEXT NOT NULL,
    qty INTEGER NOT NULL,
    legs_json TEXT NOT NULL,
    net_credit REAL NOT NULL,
    max_loss REAL NOT NULL,
    status TEXT NOT NULL,            -- pending | open | closed | rejected
    opened_utc TEXT,
    closed_utc TEXT,
    closed_pnl REAL,
    order_id TEXT,
    client_order_id TEXT
);
CREATE TABLE IF NOT EXISTS marks (
    ts TEXT NOT NULL,
    book TEXT NOT NULL,              -- real | shadow_nogates | shadow_nohedge | baseline_naive
    equity REAL,
    unrealized REAL,
    realized REAL,
    theta REAL, delta REAL, vega REAL,
    detail_json TEXT
);
CREATE TABLE IF NOT EXISTS counters (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (day, key)
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS meetings (
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    transcript_json TEXT NOT NULL
);
"""


class Store:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        # DEVLOG #28: the close order's id lives on the row itself, written in
        # the same UPDATE as the 'closing' status — the kv record used to be a
        # second commit, and a missing record fell back to the ENTRY id.
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(structures)")}
        if "close_client_order_id" not in cols:
            self.conn.execute("ALTER TABLE structures ADD COLUMN close_client_order_id TEXT")
        self.conn.commit()

    # -- structures -------------------------------------------------------
    def mark_closing(self, sid: str, close_client_order_id: str) -> None:
        self.conn.execute(
            "UPDATE structures SET status='closing', close_client_order_id=? WHERE structure_id=?",
            (close_client_order_id, sid))
        self.conn.commit()

    def set_qty(self, sid: str, qty: int) -> None:
        self.conn.execute("UPDATE structures SET qty=? WHERE structure_id=?", (qty, sid))
        self.conn.commit()
    def upsert_structure(self, sid: str, kind: str, sleeve: str, qty: int,
                         legs_json: str, net_credit: float, max_loss: float,
                         status: str, order_id: str | None = None,
                         client_order_id: str | None = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self.conn.execute(
            """INSERT INTO structures (structure_id, kind, sleeve, qty, legs_json,
               net_credit, max_loss, status, opened_utc, order_id, client_order_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(structure_id) DO UPDATE SET
                 status=excluded.status, order_id=excluded.order_id,
                 client_order_id=excluded.client_order_id,
                 qty=excluded.qty, legs_json=excluded.legs_json,
                 net_credit=excluded.net_credit, max_loss=excluded.max_loss,
                 opened_utc=excluded.opened_utc""",
            (sid, kind, sleeve, qty, legs_json, net_credit, max_loss, status,
             now, order_id, client_order_id))
        self.conn.commit()

    def set_status(self, sid: str, status: str, closed_pnl: float | None = None) -> None:
        now = datetime.now(timezone.utc).isoformat()
        if status == "closed":
            self.conn.execute(
                "UPDATE structures SET status=?, closed_utc=?, closed_pnl=? WHERE structure_id=?",
                (status, now, closed_pnl, sid))
        else:
            self.conn.execute("UPDATE structures SET status=? WHERE structure_id=?", (status, sid))
        self.conn.commit()

    def set_fills(self, sid: str, legs_json: str, net_credit: float, status: str) -> None:
        """Entry filled: replace decision-time mids with the real fills (DEVLOG #20)."""
        self.conn.execute(
            "UPDATE structures SET legs_json=?, net_credit=?, status=? WHERE structure_id=?",
            (legs_json, net_credit, status, sid))
        self.conn.commit()

    def open_structures(self) -> list[dict]:
        # 'closing' = close order accepted but not filled: still at the broker,
        # still risk, still part of the book (DEVLOG #19)
        # 'submitting' = written BEFORE the broker call (DEVLOG #28): if the
        # process dies between submit and the store write, the next tick
        # resolves the row by client_order_id instead of orphaning the order
        rows = self.conn.execute(
            "SELECT * FROM structures WHERE status IN ('open','pending','closing','submitting')").fetchall()
        return [dict(r) for r in rows]

    def all_structures(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM structures").fetchall()]

    def realized_gains(self) -> float:
        row = self.conn.execute(
            "SELECT COALESCE(SUM(closed_pnl),0) s FROM structures WHERE status='closed'").fetchone()
        return float(row["s"])

    def closed_core_count(self) -> int:
        """Resolved trades: core structures the broker has confirmed closed.
        The hedge is insurance, not a trade, and nothing working or open has
        a result yet — this is the count the size ladder is earned by."""
        row = self.conn.execute(
            "SELECT COUNT(*) n FROM structures WHERE status='closed' AND sleeve='core'").fetchone()
        return int(row["n"])

    # -- marks ------------------------------------------------------------
    def add_mark(self, book: str, equity: float | None, unrealized: float,
                 realized: float, theta: float = 0.0, delta: float = 0.0,
                 vega: float = 0.0, detail: dict | None = None) -> None:
        self.conn.execute(
            "INSERT INTO marks VALUES (?,?,?,?,?,?,?,?,?)",
            (datetime.now(timezone.utc).isoformat(), book, equity, unrealized,
             realized, theta, delta, vega, json.dumps(detail or {})))
        self.conn.commit()

    def marks(self, book: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM marks WHERE book=? ORDER BY ts", (book,)).fetchall()
        return [dict(r) for r in rows]

    # -- counters / kv ----------------------------------------------------
    def add_counter(self, day: str, key: str, delta: float) -> float:
        self.conn.execute(
            """INSERT INTO counters VALUES (?,?,?)
               ON CONFLICT(day,key) DO UPDATE SET value = value + excluded.value""",
            (day, key, delta))
        self.conn.commit()
        return self.get_counter(day, key)

    def get_counter(self, day: str, key: str) -> float:
        row = self.conn.execute(
            "SELECT value FROM counters WHERE day=? AND key=?", (day, key)).fetchone()
        return float(row["value"]) if row else 0.0

    def set_kv(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value))
        self.conn.commit()

    def try_lock(self, key: str, now_iso: str, stale_before_iso: str) -> bool:
        """Atomic take-if-free (or stale) — one upsert, no check-then-set race."""
        cur = self.conn.execute(
            """INSERT INTO kv VALUES (?,?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value
               WHERE kv.value IS NULL OR kv.value = '' OR kv.value < ?""",
            (key, now_iso, stale_before_iso))
        self.conn.commit()
        return cur.rowcount == 1

    def get_kv(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def add_meeting(self, kind: str, transcript: list[dict]) -> None:
        self.conn.execute("INSERT INTO meetings VALUES (?,?,?)",
                          (datetime.now(timezone.utc).isoformat(), kind,
                           json.dumps(transcript, ensure_ascii=False)))
        self.conn.commit()
