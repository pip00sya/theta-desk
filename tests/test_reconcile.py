"""DEVLOG #19: a close is closed only when the broker says filled."""
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from thetadesk.manage.positions import (apply_fills, fills_from_order, integrity_check,
                                        reconcile_closing, reconcile_pending)
from thetadesk.state.store import Store

NOW = datetime(2026, 9, 1, 19, 30, tzinfo=timezone.utc)
LEGS = json.dumps([{"symbol": "SPY260918P00751000", "qty": 1, "entry_price": 3.74}])


def _closing(sid="s1", credit=-3.74, qty=1):
    return {"structure_id": sid, "status": "closing", "net_credit": credit, "qty": qty,
            "legs_json": LEGS, "client_order_id": "td-x"}


def _pending(minutes_ago, est=189.5):
    return {"s1": {"client_order_id": "td-x", "est_pnl": est,
                   "ts": (NOW - timedelta(minutes=minutes_ago)).isoformat()}}


def test_filled_closes_at_real_fill_not_estimate():
    lookup = lambda coid: {"id": "o1", "status": "filled", "filled_avg_price": "5.10"}
    [ra] = reconcile_closing([_closing()], _pending(5), lookup, NOW, 10)
    assert ra.action == "closed"
    assert ra.pnl == round((5.10 - 3.74) * 100, 2)      # not the 189.5 estimate


SPREAD = json.dumps([{"symbol": "SPY260918P00620000", "qty": -1, "entry_price": 3.00},
                     {"symbol": "SPY260918P00610000", "qty": 1, "entry_price": 1.80}])


def test_filled_credit_spread_close_uses_per_leg_fills():
    lookup = lambda coid: {"id": "o1", "status": "filled", "legs": [
        {"symbol": "SPY260918P00620000", "filled_avg_price": "2.00"},
        {"symbol": "SPY260918P00610000", "filled_avg_price": "1.10"}]}
    s = {**_closing(credit=1.20), "legs_json": SPREAD}
    [ra] = reconcile_closing([s], _pending(5), lookup, NOW, 10)
    # bought back the short 1.00 cheaper (+100), sold the long 0.70 lower (-70)
    assert ra.action == "closed" and ra.pnl == 30.0


# ---- entries: reconcile_pending (DEVLOG #20) --------------------------------

def _pend(sid="s1", credit=-3.74, legs=LEGS):
    return {"structure_id": sid, "status": "pending", "net_credit": credit, "qty": 1,
            "legs_json": legs, "client_order_id": "td-x"}


def test_entry_filled_single_leg_reprices_to_real_fill():
    lookup = lambda c: {"id": "o1", "status": "filled", "filled_avg_price": "3.66"}
    [ra] = reconcile_pending([_pend()], _pending(3), lookup, NOW, 10)
    assert ra.action == "filled"
    assert ra.fills == {"SPY260918P00751000": 3.66} and ra.net_credit == -3.66
    assert json.loads(apply_fills(LEGS, ra.fills))[0]["entry_price"] == 3.66


def test_entry_filled_mleg_net_credit_from_leg_fills():
    lookup = lambda c: {"id": "o1", "status": "filled", "legs": [
        {"symbol": "SPY260918P00620000", "filled_avg_price": "2.95"},
        {"symbol": "SPY260918P00610000", "filled_avg_price": "1.82"}]}
    [ra] = reconcile_pending([_pend(credit=1.20, legs=SPREAD)], _pending(3), lookup, NOW, 10)
    assert ra.action == "filled" and ra.net_credit == round(2.95 - 1.82, 4)


def test_entry_filled_without_leg_prices_keeps_intended():
    lookup = lambda c: {"id": "o1", "status": "filled"}          # no prices at all
    [ra] = reconcile_pending([_pend(credit=1.20, legs=SPREAD)], _pending(3), lookup, NOW, 10)
    assert ra.action == "filled" and ra.net_credit is None and not ra.fills


def test_entry_live_past_wait_is_cancelled_else_waits():
    live = lambda c: {"id": "o1", "status": "accepted"}
    [ra] = reconcile_pending([_pend()], _pending(12), live, NOW, 10)
    assert ra.action == "cancel_unfilled" and ra.order_id == "o1"
    [ra] = reconcile_pending([_pend()], _pending(2), live, NOW, 10)
    assert ra.action == "pending"


def test_entry_dead_or_partial_or_unknown():
    [ra] = reconcile_pending([_pend()], _pending(2), lambda c: {"id": "o1", "status": "expired"}, NOW, 10)
    assert ra.action == "unfilled"
    [ra] = reconcile_pending([_pend()], _pending(30), lambda c: {"id": "o1", "status": "partially_filled"}, NOW, 10)
    assert ra.action == "pending"
    [ra] = reconcile_pending([_pend()], _pending(30), lambda c: None, NOW, 10)
    assert ra.action == "pending"


def test_fills_from_order_requires_every_leg():
    fills, net = fills_from_order({"legs": [{"symbol": "SPY260918P00620000", "filled_avg_price": "2.95"}]}, SPREAD)
    assert fills == {"SPY260918P00620000": 2.95} and net is None


def test_integrity_knows_pending_symbols_and_reports_drift():
    broker = [{"symbol": "SPY260918P00751000", "qty": "1"}]
    ok, why = integrity_check([_pend()], broker)          # entry working, partial at broker
    assert ok, why
    ok, why = integrity_check([{**_pend(), "status": "open"}], [])   # store says open, broker empty
    assert ok and "DRIFT" in why
    ok, why = integrity_check([], broker)
    assert not ok and "unknown" in why


def test_tick_lock_is_atomic_and_expires(tmp_path):
    st = Store(tmp_path / "t.sqlite")
    t0 = "2026-09-01T19:30:00+00:00"
    assert st.try_lock("tick_lock", t0, "2026-09-01T19:25:00+00:00")
    assert not st.try_lock("tick_lock", "2026-09-01T19:31:00+00:00", "2026-09-01T19:26:00+00:00")
    # holder crashed 6 minutes ago -> stale -> taken over
    assert st.try_lock("tick_lock", "2026-09-01T19:36:00+00:00", "2026-09-01T19:31:00+00:00")
    st.set_kv("tick_lock", "")
    assert st.try_lock("tick_lock", "2026-09-01T19:37:00+00:00", "2026-09-01T19:32:00+00:00")
    st.conn.close()


def test_live_order_waits_inside_fill_window():
    lookup = lambda coid: {"id": "o1", "status": "new"}
    [ra] = reconcile_closing([_closing()], _pending(4), lookup, NOW, 10)
    assert ra.action == "pending"


def test_live_order_past_fill_window_is_cancelled_and_reverted():
    lookup = lambda coid: {"id": "o1", "status": "new"}
    [ra] = reconcile_closing([_closing()], _pending(30), lookup, NOW, 10)
    assert ra.action == "cancel_revert" and ra.order_id == "o1"


def test_dead_order_reverts_to_open():
    for st in ("canceled", "expired", "rejected"):
        lookup = lambda coid, st=st: {"id": "o1", "status": st}
        [ra] = reconcile_closing([_closing()], _pending(30), lookup, NOW, 10)
        assert ra.action == "reverted", st


def test_partial_fill_and_unknown_order_wait():
    [ra] = reconcile_closing([_closing()], _pending(30),
                             lambda c: {"id": "o1", "status": "partially_filled"}, NOW, 10)
    assert ra.action == "pending"
    [ra] = reconcile_closing([_closing()], _pending(30), lambda c: None, NOW, 10)
    assert ra.action == "pending"


def test_unparseable_timestamp_falls_back_to_cancel():
    lookup = lambda coid: {"id": "o1", "status": "new", "submitted_at": "garbage"}
    pend = {"s1": {"client_order_id": "td-x", "ts": "not-a-date"}}
    [ra] = reconcile_closing([_closing()], pend, lookup, NOW, 10)
    assert ra.action == "cancel_revert"


def test_closing_structure_still_counts_as_book_for_integrity():
    """The exact 19:15 UTC failure: broker holds the put, store said closed."""
    broker = [{"symbol": "SPY260918P00751000", "qty": "1"}]
    ok, why = integrity_check([{**_closing(), "status": "closed"}], broker)
    assert not ok and "unknown" in why
    ok, why = integrity_check([_closing()], broker)
    assert ok, why


def test_store_open_structures_includes_closing_and_excludes_from_realized(tmp_path):
    # tmp_path, not TemporaryDirectory: Windows cannot delete an open sqlite file
    st = Store(tmp_path / "t.sqlite")
    st.upsert_structure("s1", "cheap_vol_put", "core", 1, LEGS, -3.74, 374.0, "open")
    st.set_status("s1", "closing")
    assert [s["structure_id"] for s in st.open_structures()] == ["s1"]
    assert st.realized_gains() == 0.0
    st.set_status("s1", "closed", 136.0)
    assert st.open_structures() == [] and st.realized_gains() == 136.0
    st.conn.close()
