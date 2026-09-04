"""DEVLOG #36 — the one-minute management pass.

`thetadesk.main manage` is the tick's pipeline up to and including the exits
and nothing after it. Against the FakeBroker: a pass on an empty desk is one
integrity read; a pass on a book with a working entry settles it; a pass on
an open structure that has reached its target sends the close — and none of
those passes ever opens anything, journals a tick, or spends a snapshot on a
hold. The tick then WAITS for a pass holding the lock instead of skipping.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from test_tick_flow import Args, FakeBroker, _journal, _struct, desk  # noqa: F401  (fixture)


class Manage(Args):
    pass


def _kinds(cfg):
    return [e["kind"] for e in _journal(cfg)]


def test_the_first_pass_records_the_integrity_verdict_then_goes_quiet(desk):
    """DEVLOG #36b: a pass journals only what HAPPENED. The first one records
    the integrity verdict because it is new; the next 363 in the session find
    the same verdict and write NOTHING — otherwise one session would be 1,092
    lines against 1,177 for the desk's entire first week, and the console's
    900-row blotter would hold nothing but heartbeat."""
    m, broker, cfg = desk
    assert m.cmd_manage_locked(Manage()) == 0
    k = _kinds(cfg)
    assert k == ["manage_start", "integrity", "manage_end"], k
    assert _journal(cfg)[-1]["data"].get("idle") is True

    for _ in range(5):                                        # the quiet minutes
        assert m.cmd_manage_locked(Manage()) == 0
    assert _kinds(cfg) == k, "a quiet pass must not journal"
    assert broker.submitted == []
    assert not list(cfg.snapshot_dir.glob("*.json"))          # and spends no snapshot

    st = m.Store(cfg.db_path)
    try:
        # it still proves it ran — in the store, where the watchdog reads it
        assert st.get_kv("last_manage_ts") and not st.get_kv("last_tick_ts")
        assert st.get_counter(m._today(), "manage_passes") == 6
    finally:
        st.conn.close()


def test_a_pass_journals_the_integrity_verdict_again_when_it_changes(desk):
    m, broker, cfg = desk
    assert m.cmd_manage_locked(Manage()) == 0
    n = _kinds(cfg).count("integrity")
    assert m.cmd_manage_locked(Manage()) == 0
    assert _kinds(cfg).count("integrity") == n                # unchanged: silent

    st = m.Store(cfg.db_path)                                  # a leg appears from nowhere
    st.upsert_structure("ghost", "iron_condor", "core", 1,
                        json.dumps([{"symbol": "SPY260918P00600000", "qty": -1,
                                     "entry_price": 1.0}]), 1.0, 900.0, "open")
    st.conn.close()
    assert m.cmd_manage_locked(Manage()) == 0
    assert _kinds(cfg).count("integrity") == n + 1             # changed: recorded
    last = [e for e in _journal(cfg) if e["kind"] == "integrity"][-1]["data"]
    assert last["changed"] is True and "DRIFT" in last["reason"]


def test_pass_settles_a_working_entry_and_never_opens(desk):
    m, broker, cfg = desk
    assert m.cmd_tick_locked(Args()) == 0                       # the tick opens: 'pending'
    st = m.Store(cfg.db_path)
    s = next(x for x in st.all_structures() if x["kind"] == "iron_condor")
    st.conn.close()
    assert s["status"] == "pending"
    legs = json.loads(s["legs_json"])
    broker.fill(s["client_order_id"], {l["symbol"]: l["entry_price"] for l in legs})

    n_orders = len(broker.submitted)
    n_snaps = len(list(cfg.snapshot_dir.glob("*.json")))
    assert m.cmd_manage_locked(Manage()) == 0                   # the pass sees the fill
    assert _struct(m, cfg, s["structure_id"])["status"] == "open"
    assert len(broker.submitted) == n_orders                    # nothing new at the broker
    assert len(list(cfg.snapshot_dir.glob("*.json"))) == n_snaps   # a hold spends no snapshot
    k = _kinds(cfg)
    tail = k[k.index("manage_start"):]
    assert "open_reconcile" in tail and "gates" not in tail and "order_open" not in tail
    assert "manage" not in tail                                 # holds are not journaled by a pass
    end = _journal(cfg)[-1]["data"]
    assert end["open"] == 1 and end["holds"] == 1 and end["closes"] == []
    assert "real" in end["marks"]                               # the book was re-marked
    st = m.Store(cfg.db_path)
    assert len(st.marks("real")) >= 2                           # tick mark + pass mark
    st.conn.close()


def test_quiet_passes_mark_on_a_cadence_not_every_minute(desk):
    """A mark a minute is 1,456 rows a session across four books. The pass
    marks every mark_every_passes (~5 min) so the curve still moves between
    ticks — and always when it acted, so a close lands on the curve at once."""
    m, broker, cfg = desk
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    s = next(x for x in st.all_structures() if x["kind"] == "iron_condor")
    st.conn.close()
    broker.fill(s["client_order_id"], {l["symbol"]: l["entry_price"]
                                       for l in json.loads(s["legs_json"])})
    every = int(cfg.raw["manage"]["mark_every_passes"])
    st = m.Store(cfg.db_path)
    before = len(st.marks("real"))
    st.conn.close()
    for _ in range(every * 2):
        assert m.cmd_manage_locked(Manage()) == 0
    st = m.Store(cfg.db_path)
    added = len(st.marks("real")) - before
    st.conn.close()
    assert added == 2, f"{every * 2} passes should mark twice, not {added} times"


def test_pass_sends_the_close_when_the_target_is_hit(desk, monkeypatch):
    m, broker, cfg = desk
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    s = next(x for x in st.all_structures() if x["kind"] == "iron_condor")
    st.conn.close()
    legs = json.loads(s["legs_json"])
    broker.fill(s["client_order_id"], {l["symbol"]: l["entry_price"] for l in legs})
    assert m.cmd_manage_locked(Manage()) == 0
    assert _struct(m, cfg, s["structure_id"])["status"] == "open"

    # vol softens: every short leg is now cheaper. The fixture's profit
    # target is 5% of max profit, so this is a close (as in test_tick_flow).
    broker.atm_iv = 0.125
    n_orders = len(broker.submitted)
    n_snaps = len(list(cfg.snapshot_dir.glob("*.json")))
    assert m.cmd_manage_locked(Manage()) == 0
    row = _struct(m, cfg, s["structure_id"])
    assert row["status"] == "closing", row["status"]
    assert len(broker.submitted) == n_orders + 1                # exactly the close
    close = broker.submitted[-1]
    assert all(l["position_intent"].endswith("_to_close") for l in close["legs"])
    assert len(list(cfg.snapshot_dir.glob("*.json"))) == n_snaps + 1   # a decision replays
    k = _kinds(cfg)
    tail = k[len(k) - k[::-1].index("manage_start") - 1:]
    assert "signals" in tail and "manage" in tail and "order_close" in tail
    sig = next(e for e in _journal(cfg) if e["kind"] == "signals" and e["data"].get("manage"))
    assert (cfg.snapshot_dir / sig["data"]["snapshot"]).exists()


def test_tick_waits_for_a_pass_that_holds_the_lock(desk, monkeypatch):
    m, broker, cfg = desk
    st = m.Store(cfg.db_path)
    st.set_kv("tick_lock", datetime.now(timezone.utc).isoformat())     # a pass in flight
    st.conn.close()
    monkeypatch.setattr(m, "LOCK_WAIT_S", 0.0)
    assert m.cmd_tick_locked(Args()) == 0
    assert "tick_skipped_locked" in _kinds(cfg)                 # no wait budget: skipped
    # a pass never waits: it yields and the next one is a minute away
    st = m.Store(cfg.db_path)
    st.set_kv("tick_lock", datetime.now(timezone.utc).isoformat())
    st.conn.close()
    before = len(_journal(cfg))
    assert m.cmd_manage_locked(Manage()) == 0
    assert len(_journal(cfg)) == before                         # nothing journaled either
    st = m.Store(cfg.db_path)
    assert st.get_kv("tick_lock")                               # and the holder's lock is intact
    st.conn.close()


def test_tick_journals_the_rung_before_it_sizes(desk):
    m, broker, cfg = desk
    assert m.cmd_tick_locked(Args()) == 0
    k = _kinds(cfg)
    assert k.index("ladder") < k.index("gates")
    lad = next(e["data"] for e in _journal(cfg) if e["kind"] == "ladder")
    assert lad["enabled"] and lad["tier"] == "explore" and lad["closed"] == 0
    g = next(e["data"] for e in _journal(cfg) if e["kind"] == "gates")
    assert g["tier"] == "explore"
    g7 = next(r for r in g["results"] if r["gate"] == "g7_structure_size")
    assert g7["data"]["limit"] == pytest.approx(float(broker.account()["equity"]) * 0.02, rel=1e-6)
