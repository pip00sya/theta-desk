"""DEVLOG #36 — the size ladder.

Every ceiling the gates enforce is a fraction of equity; the ladder makes the
fraction a function of the desk's own record. These tests pin the table, the
promotion rule, the drawdown demotion, the config validation, the way the
gates consume a rung, and the sizing arithmetic that motivated the whole
thing: an $830 condor against 1.25% is one contract, against 3% it is three.
"""
from __future__ import annotations

import copy

import pytest

from thetadesk import config as cfgmod
from thetadesk.engine import gates, ladder

RISK = {"per_structure_max_loss_frac": 0.0125, "daily_new_risk_frac": 0.035,
        "portfolio_worst_case_frac": 0.075, "portfolio_worst_case_cap": 0.08}

LADDER = {
    "enabled": True,
    "promote_requires_realized_nonneg": True,
    "demote_one_tier_at_drawdown": 0.02,
    "demote_to_floor_at_drawdown": 0.035,
    "tiers": [
        {"name": "explore", "min_closed": 0, "per_structure_frac": 0.02,
         "daily_new_risk_frac": 0.05, "portfolio_worst_case_frac": 0.09,
         "portfolio_worst_case_cap": 0.10},
        {"name": "establish", "min_closed": 5, "per_structure_frac": 0.03,
         "daily_new_risk_frac": 0.08, "portfolio_worst_case_frac": 0.135,
         "portfolio_worst_case_cap": 0.15},
        {"name": "scale", "min_closed": 15, "per_structure_frac": 0.04,
         "daily_new_risk_frac": 0.10, "portfolio_worst_case_frac": 0.16,
         "portfolio_worst_case_cap": 0.18},
    ],
}


def _raw(**over) -> dict:
    lad = copy.deepcopy(LADDER)
    lad.update(over)
    return {"risk": dict(RISK), "ladder": lad}


def test_disabled_ladder_is_exactly_the_fixed_constants():
    st = ladder.resolve({"risk": dict(RISK), "ladder": {"enabled": False}},
                        closed=40, realized=5000.0, equity=100_000, high_watermark=100_000)
    assert not st.enabled and st.tier.name == "fixed"
    assert st.tier.per_structure == 0.0125 and st.tier.daily_new == 0.035
    assert st.tier.book_base == 0.075 and st.tier.book_cap == 0.08
    # and with no ladder key at all
    st2 = ladder.resolve({"risk": dict(RISK)}, 40, 5000.0, 100_000, 100_000)
    assert st2.tier == st.tier


@pytest.mark.parametrize("closed,name", [(0, "explore"), (4, "explore"), (5, "establish"),
                                         (14, "establish"), (15, "scale"), (99, "scale")])
def test_rungs_are_earned_by_closed_core_trades(closed, name):
    st = ladder.resolve(_raw(), closed, realized=1.0, equity=100_000, high_watermark=100_000)
    assert st.enabled and st.tier.name == name and st.earned.name == name
    assert st.demoted == 0


def test_promotion_is_withheld_while_realized_is_negative():
    st = ladder.resolve(_raw(), closed=9, realized=-50.0, equity=100_000, high_watermark=100_000)
    assert st.tier.name == "explore" and "withheld" in st.reason
    # exactly zero is not negative: five closed at break-even still count
    st0 = ladder.resolve(_raw(), closed=5, realized=0.0, equity=100_000, high_watermark=100_000)
    assert st0.tier.name == "establish"
    # the rule can be switched off in config, deliberately
    st_off = ladder.resolve(_raw(promote_requires_realized_nonneg=False), 9, -50.0, 100_000, 100_000)
    assert st_off.tier.name == "establish"


def test_drawdown_takes_rungs_back_before_the_halt():
    raw = _raw()
    # scale earned; 1.9% drawdown keeps it
    assert ladder.resolve(raw, 20, 100.0, 98_100, 100_000).tier.name == "scale"
    # 2% takes one rung
    st1 = ladder.resolve(raw, 20, 100.0, 98_000, 100_000)
    assert st1.tier.name == "establish" and st1.earned.name == "scale" and st1.demoted == 1
    # 3.5% takes every rung — and this is still BELOW gate #14's 4% halt
    st2 = ladder.resolve(raw, 20, 100.0, 96_500, 100_000)
    assert st2.tier.name == "explore" and st2.demoted == 2
    assert 0.035 < 0.04
    # nothing to take from the bottom rung
    st3 = ladder.resolve(raw, 2, 100.0, 96_500, 100_000)
    assert st3.tier.name == "explore" and st3.demoted == 0


def test_config_validation_refuses_a_ladder_that_could_size_down():
    bad = _raw()
    bad["ladder"]["tiers"][0]["per_structure_frac"] = 0.01      # below the 1.25% floor
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)
    bad = _raw()
    bad["ladder"]["tiers"][2]["daily_new_risk_frac"] = 0.07     # steps down from establish
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)
    bad = _raw()
    bad["ladder"]["tiers"][1]["min_closed"] = 0                 # not ascending
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)
    bad = _raw()
    bad["ladder"]["tiers"][0]["min_closed"] = 1                 # no rung for day one
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)
    bad = _raw()
    bad["ladder"]["tiers"][1]["portfolio_worst_case_frac"] = 0.16   # base above its cap
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)
    bad = _raw()
    bad["ladder"]["tiers"] = []
    with pytest.raises(ValueError):
        ladder.tiers_from_config(bad)


def test_the_live_config_ladder_loads_and_names_todays_rung():
    """The desk's actual config, the desk's actual record on 2026-09-04:
    six closed core trades, +$598 realised, half a percent off the high. That
    is the second rung. If someone edits the table this test says what changed."""
    cfg = cfgmod.load()
    enabled, tiers = ladder.tiers_from_config(cfg.raw)
    assert enabled and [t.name for t in tiers] == ["explore", "establish", "scale"]
    assert [t.min_closed for t in tiers] == [0, 5, 15]
    assert [t.per_structure for t in tiers] == [0.02, 0.03, 0.04]
    st = ladder.resolve(cfg.raw, closed=6, realized=598.0, equity=100_428.89,
                        high_watermark=100_968.37)
    assert st.tier.name == "establish" and st.next_tier.name == "scale"
    assert st.to_dict()["fracs"]["per_structure"] == 0.03


def test_sizing_arithmetic_is_the_whole_point():
    """main.py: qty = budget * mults // unit_risk, floored at one contract
    when one fits. An $832 condor on $100,428.89 of equity."""
    eq, unit = 100_428.89, 832.0

    def qty(frac, mult=1.0):
        q = int(eq * frac * mult // unit)
        return 1 if (q == 0 and unit <= eq * frac) else q

    assert qty(0.0125) == 1          # the desk through Sep 3: every structure at one lot
    assert qty(0.02) == 2            # explore
    assert qty(0.03) == 3            # establish — today's rung
    assert qty(0.04) == 4            # scale
    assert qty(0.03, 0.5) == 1       # a neutral-regime or disagreement haircut still applies


def _condor_and_chain():
    from test_gates import _condor, _chain_for
    s = _condor()
    return s, _chain_for(s)


def test_gates_measure_against_the_rung():
    """Same candidate, qty 3: the fixed rung refuses it at gate #7, the
    establish rung passes it, and gate #9's limit is the rung's daily fraction."""
    from test_gates import ASOF, CFG
    s, chain = _condor_and_chain()
    kw = dict(structure=s, qty=3, chain=chain, book_legs=[], spot=650.0, asof=ASOF,
              equity=100_000, high_watermark=100_000, realized_gains=0.0,
              new_risk_today=0.0, cfg=CFG, minutes_from_open=120.0, minutes_to_close=120.0,
              market_open=True)
    fixed = gates.run_entry_gates(**kw)
    g7 = next(r for r in fixed.results if r.gate == "g7_structure_size")
    assert not g7.passed and g7.data["limit"] == pytest.approx(100_000 * 0.0125)

    rung = ladder.Tier("establish", 5, 0.03, 0.08, 0.135, 0.15)
    earned = gates.run_entry_gates(**kw, tier=rung)
    g7e = next(r for r in earned.results if r.gate == "g7_structure_size")
    g9e = next(r for r in earned.results if r.gate == "g9_daily_budget")
    g8e = next(r for r in earned.results if r.gate == "g8_portfolio_worst_case")
    assert g7e.passed and g7e.data["limit"] == pytest.approx(100_000 * 0.03)
    assert g9e.data["limit"] == pytest.approx(100_000 * 0.08)
    assert g8e.data["budget"] == pytest.approx(100_000 * 0.135)
    # tier=None is byte-for-byte the old wall
    assert fixed.to_dict() == gates.run_entry_gates(**kw, tier=None).to_dict()
