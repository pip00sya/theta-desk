"""DEVLOG #19: a close is closed only when the broker says filled."""
import json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from thetadesk.manage.positions import integrity_check, reconcile_closing
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


def test_filled_credit_structure_pays_to_close():
    lookup = lambda coid: {"id": "o1", "status": "filled", "filled_avg_price": "0.90"}
    [ra] = reconcile_closing([_closing(credit=1.80)], _pending(5), lookup, NOW, 10)
    assert ra.action == "closed" and ra.pnl == round((1.80 - 0.90) * 100, 2)


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
