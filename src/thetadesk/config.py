"""Typed access to config.yaml + events.yaml. Single load per process."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]


def _parse_utc(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


@dataclass
class MacroEvent:
    name: str
    utc: datetime
    klass: str  # "high" | "medium"


@dataclass
class Config:
    raw: dict[str, Any]
    root: Path = ROOT

    # -- convenience accessors -------------------------------------------
    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    @property
    def deadline(self) -> datetime:
        return _parse_utc(self.raw["meta"]["hackathon_deadline_utc"])

    @property
    def judging_horizon(self) -> datetime:
        return _parse_utc(self.raw["meta"]["judging_horizon_utc"])

    @property
    def min_expiry(self) -> str:
        return self.raw["expiry"]["min_expiry"]

    @property
    def underlyings(self) -> list[str]:
        return list(self.raw["universe"]["underlyings"])

    def _data(self, key: str) -> Path:
        """DEVLOG #23: THETADESK_DATA_DIR relocates every data path (demo runs
        must never touch the live store, journal or snapshots)."""
        p = Path(self.raw["paths"][key])
        override = os.environ.get("THETADESK_DATA_DIR")
        if override:
            p = Path(override) / p.name
        return self.root / p

    @property
    def db_path(self) -> Path:
        return self._data("db")

    @property
    def journal_dir(self) -> Path:
        return self._data("journal_dir")

    @property
    def snapshot_dir(self) -> Path:
        return self._data("snapshot_dir")

    @property
    def evidence_dir(self) -> Path:
        return self._data("evidence_dir")

    def events(self) -> list[MacroEvent]:
        path = self.root / self.raw["events"]["calendar_file"]
        if not path.exists():
            return []
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return [
            MacroEvent(name=e["name"], utc=_parse_utc(e["utc"]), klass=e.get("class", "medium"))
            for e in data.get("events", [])
        ]


_cached: Config | None = None


def load(path: str | Path | None = None) -> Config:
    global _cached
    if _cached is not None and path is None:
        return _cached
    p = Path(path) if path else ROOT / "config.yaml"
    cfg = Config(raw=yaml.safe_load(p.read_text(encoding="utf-8")))
    if path is None:
        _cached = cfg
    return cfg


def data_headers() -> dict[str, str]:
    return {
        "APCA-API-KEY-ID": os.environ.get("ALPACA_API_KEY", ""),
        "APCA-API-SECRET-KEY": os.environ.get("ALPACA_SECRET_KEY", ""),
    }
