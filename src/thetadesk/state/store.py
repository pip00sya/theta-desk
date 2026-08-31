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
        self.conn.commit()

    # -- structures -------------------------------------------------------
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
                 client_order_id=excluded.client_order_id""",
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

    def open_structures(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM structures WHERE status IN ('open','pending')").fetchall()
        return [dict(r) for r in rows]

    def all_structures(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM structures").fetchall()]

    def realized_gains(self) -> float:
        row = self.conn.execute(
            "SELECT COALESCE(SUM(closed_pnl),0) s FROM structures WHERE status='closed'").fetchone()
        return float(row["s"])

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

    def get_kv(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def add_meeting(self, kind: str, transcript: list[dict]) -> None:
        self.conn.execute("INSERT INTO meetings VALUES (?,?,?)",
                          (datetime.now(timezone.utc).isoformat(), kind,
                           json.dumps(transcript, ensure_ascii=False)))
        self.conn.commit()
