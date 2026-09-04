import json
import os

import pytest

from thetadesk.safety import SafetyError, assert_paper_only
from thetadesk.manage.positions import integrity_check, review_book
from datetime import datetime, timezone

NOW = datetime(2026, 8, 31, 15, 0, tzinfo=timezone.utc)

MGMT = {"profit_target_frac": 0.35, "realize_min_frac": 0.25,
        "structure_stop_credit_mult": 2.0, "time_stop_dte": 7}


def _struct(sid="s1", credit=2.20, qty=1):
    legs = [
        {"symbol": "SPY260918P00620000", "qty": -1, "entry_price": 3.00},
        {"symbol": "SPY260918P00610000", "qty": 1, "entry_price": 1.80},
        {"symbol": "SPY260918C00680000", "qty": -1, "entry_price": 2.60},
        {"symbol": "SPY260918C00690000", "qty": 1, "entry_price": 1.60},
    ]
    return {"structure_id": sid, "kind": "iron_condor", "sleeve": "core",
            "qty": qty, "legs_json": json.dumps(legs), "net_credit": credit,
            "status": "open"}


def _chain(mult=1.0):
    """mult<1 -> option prices dropped (good for short premium)."""
    mids = {"SPY260918P00620000": 3.00, "SPY260918P00610000": 1.80,
            "SPY260918C00680000": 2.60, "SPY260918C00690000": 1.60}
    return {s: {"latestQuote": {"bp": round(m * mult - 0.01, 2),
                                "ap": round(m * mult + 0.01, 2)}}
            for s, m in mids.items()}


def test_paper_gate_blocks_missing_and_live_env(monkeypatch):
    monkeypatch.delenv("APCA_API_BASE_URL", raising=False)
    with pytest.raises(SafetyError):
        assert_paper_only(exit_on_fail=False)
    monkeypatch.setenv("APCA_API_BASE_URL", "https://api.alpaca.markets")
    with pytest.raises(SafetyError):
        assert_paper_only(exit_on_fail=False)
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    monkeypatch.setenv("ALPACA_LIVE_TRADE", "true")
    with pytest.raises(SafetyError):
        assert_paper_only(exit_on_fail=False)
    monkeypatch.setenv("ALPACA_LIVE_TRADE", "false")
    assert assert_paper_only(exit_on_fail=False)


def test_profit_target_closes_at_35pct():
    # short-premium P&L when option prices fall 40%: mtm ≈ 0.4 * net premium...
    # compute expected: mtm = sum(qty*(mid-entry))*100 with mult=0.6
    actions = review_book([_struct()], _chain(mult=0.60), MGMT, NOW, 1, "2026-09-18")
    a = actions[0]
    assert a.action == "close" and "profit target" in a.reason


def test_structure_stop_closes_on_2x_credit_loss():
    actions = review_book([_struct()], _chain(mult=3.2), MGMT, NOW, 1, "2026-09-18")
    a = actions[0]
    assert a.action == "close" and "structure stop" in a.reason


def test_realization_policy_on_idle_day():
    # ~27% of max profit, idle day (entries_today=0) -> realize
    actions = review_book([_struct()], _chain(mult=0.725), MGMT, NOW, 0, "2026-09-18")
    a = actions[0]
    assert a.action == "close" and "realization policy" in a.reason


def test_hold_inside_plan_when_active_day():
    actions = review_book([_struct()], _chain(mult=0.725), MGMT, NOW, 2, "2026-09-18")
    assert actions[0].action == "hold"


def test_one_sided_quotes_mark_conservatively_and_the_rules_still_run():
    """DEVLOG #36: a one-sided quote used to make the structure unmarkable and
    silently switch off every exit — including the stop — for as long as the
    far wing had no bid, which is exactly the state a gap leaves it in."""
    # the SHORT put loses its bid: it is marked at the ask (what a buy-back
    # costs), the structure stays markable and the rules keep running
    ch = _chain(mult=3.2)
    ch["SPY260918P00620000"]["latestQuote"]["bp"] = 0.0
    actions = review_book([_struct()], ch, MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "close" and "structure stop" in actions[0].reason
    # the LONG wing loses its bid entirely: worth what nobody will pay — zero
    ch = _chain(mult=3.2)
    ch["SPY260918P00610000"]["latestQuote"] = {"bp": 0.0, "ap": 0.0}
    actions = review_book([_struct()], ch, MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "close" and "structure stop" in actions[0].reason


def test_a_short_leg_with_no_ask_cannot_be_priced_and_holds():
    ch = _chain()
    ch["SPY260918P00620000"]["latestQuote"] = {"bp": 0.0, "ap": 0.0}
    actions = review_book([_struct()], ch, MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "hold" and "unmarkable" in actions[0].reason


def test_integrity_flags_unknown_broker_position():
    ok, why = integrity_check([_struct()], [
        {"symbol": "SPY260918P00500000", "qty": "-1"},
    ])
    assert not ok and "unknown" in why


def test_integrity_ok_when_consistent():
    ok, _ = integrity_check([_struct()], [
        {"symbol": "SPY260918P00620000", "qty": "-1"},
        {"symbol": "SPY260918P00610000", "qty": "1"},
        {"symbol": "SPY260918C00680000", "qty": "-1"},
        {"symbol": "SPY260918C00690000", "qty": "1"},
    ])
    assert ok
