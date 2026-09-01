"""DEVLOG #15 patch tests: debit exits, sleeve budget gate, event profit-lock."""
import json
from datetime import datetime, timezone

from thetadesk import config as cfgmod
from thetadesk.engine import gates
from thetadesk.engine.contracts import Leg, OptionContract, Structure
from thetadesk.manage.positions import review_book

NOW = datetime(2026, 9, 2, 15, 0, tzinfo=timezone.utc)
CFG = cfgmod.load()

MGMT = {"profit_target_frac": 0.35, "debit_profit_target_frac": 0.60,
        "realize_min_frac": 0.25, "structure_stop_credit_mult": 2.0,
        "time_stop_dte": 7}


def _long_put(sid="p1", entry=3.77, qty=1):
    legs = [{"symbol": "SPY260918P00754000", "qty": 1, "entry_price": entry}]
    return {"structure_id": sid, "kind": "cheap_vol_put", "sleeve": "core",
            "qty": qty, "legs_json": json.dumps(legs), "net_credit": -entry,
            "status": "open"}


def _chain(mid):
    return {"SPY260918P00754000": {"latestQuote": {"bp": mid - 0.02, "ap": mid + 0.02}}}


def test_debit_profit_target_closes_at_60pct():
    actions = review_book([_long_put()], _chain(3.77 * 1.65), MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "close"
    assert "debit profit target" in actions[0].reason


def test_debit_below_target_holds_on_active_day():
    actions = review_book([_long_put()], _chain(3.77 * 1.30), MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "hold"


def test_debit_realization_policy_fires_on_idle_day():
    actions = review_book([_long_put()], _chain(3.77 * 1.30), MGMT, NOW, 0, "2026-09-18")
    assert actions[0].action == "close"
    assert "realization policy" in actions[0].reason


def test_no_stop_loss_on_debit_structures():
    """Bounded loss by construction — a drawdown must NOT trigger a close."""
    actions = review_book([_long_put()], _chain(3.77 * 0.40), MGMT, NOW, 1, "2026-09-18")
    assert actions[0].action == "hold"


def test_derisk_mode_locks_profitable_positions():
    actions = review_book([_long_put()], _chain(3.77 * 1.20), MGMT, NOW, 1,
                          "2026-09-18", derisk_mode=True, derisk_lock_frac=0.15)
    assert actions[0].action == "close"
    assert "event de-risk" in actions[0].reason


def test_derisk_mode_holds_losers():
    actions = review_book([_long_put()], _chain(3.77 * 0.90), MGMT, NOW, 1,
                          "2026-09-18", derisk_mode=True, derisk_lock_frac=0.15)
    assert actions[0].action == "hold"


def _leg(sym, qty, px):
    return Leg(OptionContract.parse(sym), qty, px)


def test_g18_blocks_when_sleeve_full():
    s = Structure("d", "cheap_vol_put", "core",
                  [_leg("SPY260918P00750000", +1, 3.60)], net_credit=-3.60)
    r = gates.g18_sleeve_budget(s, 1, open_sleeve_debit=1400.0,
                                equity=100_000, frac=0.015)
    assert not r.passed  # 1400 + 360 > 1500


def test_g18_allows_when_room():
    s = Structure("d", "cheap_vol_put", "core",
                  [_leg("SPY260918P00750000", +1, 3.60)], net_credit=-3.60)
    r = gates.g18_sleeve_budget(s, 1, open_sleeve_debit=500.0,
                                equity=100_000, frac=0.015)
    assert r.passed


def test_g18_ignores_credit_structures():
    s = Structure("c", "iron_condor", "core",
                  [_leg("SPY260918P00620000", -1, 3.00), _leg("SPY260918P00610000", +1, 1.80)],
                  net_credit=1.20)
    r = gates.g18_sleeve_budget(s, 1, open_sleeve_debit=99999.0,
                                equity=100_000, frac=0.015)
    assert r.passed


def test_g18_earned_extension_and_ceiling():
    s = Structure("d", "cheap_vol_put", "core",
                  [_leg("SPY260918P00750000", +1, 3.60)], net_credit=-3.60)
    # 1400 + 360 = 1760 > 1500 base, but realized 600 -> limit 1500+300=1800: pass
    r = gates.g18_sleeve_budget(s, 1, open_sleeve_debit=1400.0, equity=100_000,
                                frac=0.015, realized_gains=600.0)
    assert r.passed
    # hard ceiling 2.5%: huge gains cannot push limit past $2,500
    r2 = gates.g18_sleeve_budget(s, 1, open_sleeve_debit=2400.0, equity=100_000,
                                 frac=0.015, realized_gains=50_000.0)
    assert not r2.passed


def test_payoff_multi_underlying_uses_own_spots():
    from datetime import datetime, timezone
    from thetadesk.engine.payoff import portfolio_worst_case
    asof = datetime(2026, 9, 2, 15, 0, tzinfo=timezone.utc)
    horizon = datetime(2026, 9, 18, 20, 0, tzinfo=timezone.utc)
    legs = [
        _leg("SPY260918P00754000", +1, 3.77),   # SPY spot 766
        _leg("QQQ260918P00600000", +1, 3.00),   # QQQ spot 610
    ]
    iv = {l.contract.symbol: 0.15 for l in legs}
    res = portfolio_worst_case(legs, {"SPY": 766.0, "QQQ": 610.0}, asof, horizon, iv)
    # both are long puts: worst case = total debit paid (the OTM plateau —
    # it starts as soon as both spots sit above their strikes at expiry)
    assert abs(res.worst_pnl + (3.77 + 3.00) * 100) < 2.0
    # sanity: at -20% both puts are deep ITM and the tail is strongly positive
    assert res.grid_pnl_base[0][1] > 5_000
    # missing underlying in the map must raise, not silently misprice
    import pytest as _pt
    with _pt.raises(ValueError):
        portfolio_worst_case(legs, {"SPY": 766.0}, asof, horizon, iv)
