"""Shared fixtures.

The operator's kill switch (config.yaml `entries.enabled`, DEVLOG #38) is a
LIVE decision about the judged account, not a property of the code. The
suite tests the desk's mechanics — entries, gates, sizing, exits — so every
test runs with entries ON regardless of what the operator has set right
now; the one test that checks the switch itself sets it off explicitly.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _entries_enabled_for_tests(monkeypatch):
    from thetadesk import config as cfgmod
    cfg = cfgmod.load()                       # one cached Config per process
    monkeypatch.setitem(cfg.raw, "entries", {**(cfg.raw.get("entries") or {}), "enabled": True})
    yield
