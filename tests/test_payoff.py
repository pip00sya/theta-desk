from datetime import datetime, timezone

from thetadesk.engine.contracts import Leg, OptionContract, Structure
from thetadesk.engine.payoff import portfolio_worst_case

ASOF = datetime(2026, 8, 28, 15, 0, tzinfo=timezone.utc)
HORIZON = datetime(2026, 9, 18, 20, 0, tzinfo=timezone.utc)  # = expiry -> intrinsic
IV = 0.15


def _leg(sym: str, qty: int, entry: float) -> Leg:
    return Leg(OptionContract.parse(sym), qty, entry)


def test_put_credit_spread_worst_case_is_width_minus_credit():
    legs = [
        _leg("SPY260918P00620000", -1, 3.00),   # short 620 put
        _leg("SPY260918P00610000", +1, 1.80),   # long 610 put
    ]
    iv_map = {l.contract.symbol: IV for l in legs}
    res = portfolio_worst_case(legs, 650.0, ASOF, HORIZON, iv_map)
    # credit = 1.20 -> max loss = (10 - 1.20) * 100 = 880 (at/below 610)
    assert abs(res.worst_pnl + 880.0) < 1.0
    assert res.worst_spot_rel < 0.95


def test_iron_condor_worst_is_single_side():
    legs = [
        _leg("SPY260918P00620000", -1, 3.00), _leg("SPY260918P00610000", +1, 1.80),
        _leg("SPY260918C00680000", -1, 2.60), _leg("SPY260918C00690000", +1, 1.60),
    ]
    iv_map = {l.contract.symbol: IV for l in legs}
    res = portfolio_worst_case(legs, 650.0, ASOF, HORIZON, iv_map)
    # total credit 2.20 -> worst side = (10 - 2.20) * 100 = 780, NOT 1560
    assert abs(res.worst_pnl + 780.0) < 1.0


def test_hedge_converts_far_tail_not_worst_case():
    """DEVLOG finding: a far-OTM hedge CANNOT reduce the worst case of a
    defined-risk book (the loss plateau between long strike and hedge strike
    still carries the hedge premium). What it does is convert the extreme
    tail into profit. The gate budget must therefore include hedge premium —
    which g8 does, because it prices the whole book together."""
    core = [
        _leg("SPY260918P00620000", -3, 3.00), _leg("SPY260918P00610000", +3, 1.80),
    ]
    hedge = [_leg("SPY260918P00550000", +2, 0.60)]
    iv_map = {l.contract.symbol: IV for l in core + hedge}
    no_hedge = portfolio_worst_case(core, 650.0, ASOF, HORIZON, iv_map)
    with_hedge = portfolio_worst_case(core + hedge, 650.0, ASOF, HORIZON, iv_map)
    # worst case worsens only by (at most) the hedge premium paid
    hedge_cost = 2 * 0.60 * 100
    assert no_hedge.worst_pnl - hedge_cost - 1.0 <= with_hedge.worst_pnl <= no_hedge.worst_pnl
    # ...but the crash tail (-20%) flips from deep loss to profit
    tail_no = no_hedge.grid_pnl_base[0][1]
    tail_with = with_hedge.grid_pnl_base[0][1]
    assert tail_no < -2000 and tail_with > 2000


def test_stressed_scenario_hits_short_premium_before_expiry():
    early_horizon = datetime(2026, 9, 8, 20, 0, tzinfo=timezone.utc)  # before expiry
    legs = [
        _leg("SPY260918P00620000", -1, 3.00), _leg("SPY260918P00610000", +1, 1.80),
    ]
    iv_map = {l.contract.symbol: IV for l in legs}
    res = portfolio_worst_case(legs, 650.0, ASOF, early_horizon, iv_map)
    assert res.worst_scenario in ("base", "stressed")
    assert res.worst_pnl >= -880.0 - 1.0  # can never exceed structural max loss


def test_long_structure_worst_case_is_debit():
    legs = [_leg("SPY260918P00550000", +2, 0.60)]
    iv_map = {legs[0].contract.symbol: IV}
    res = portfolio_worst_case(legs, 650.0, ASOF, HORIZON, iv_map)
    assert abs(res.worst_pnl + 120.0) < 1.0  # 2 * 0.60 * 100


def test_structure_max_loss_matches_payoff():
    s = Structure(
        "x", "iron_condor", "core",
        [
            _leg("SPY260918P00620000", -1, 3.00), _leg("SPY260918P00610000", +1, 1.80),
            _leg("SPY260918C00680000", -1, 2.60), _leg("SPY260918C00690000", +1, 1.60),
        ],
        net_credit=2.20,
    )
    assert abs(s.max_loss - 780.0) < 1.0


def test_naked_short_raises():
    s = Structure("x", "bad", "core", [_leg("SPY260918P00620000", -1, 3.00)], net_credit=3.00)
    try:
        _ = s.max_loss
        assert False, "naked short must raise"
    except ValueError:
        pass
