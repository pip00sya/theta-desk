"""★ Portfolio payoff simulator — the desk's veto right.

Before any order is sent the WHOLE book (open structures + candidate) is
repriced over a grid of underlying prices at the judging horizon, under a
base and a stressed-vol scenario. If the worst grid P&L breaches the risk
budget, the order is refused before Alpaca ever sees it.

This is a client-side implementation of the same principle Alpaca's own
margin engine uses for options (universal spread rule: margin = worst-case
combined payoff), applied earlier in the pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from . import blackscholes as bs
from .contracts import MULTIPLIER, Leg


@dataclass
class PayoffResult:
    worst_pnl: float          # most negative P&L across grid & scenarios ($)
    worst_spot_rel: float     # spot multiple where it occurs (e.g. 0.85)
    worst_scenario: str       # "base" | "stressed"
    grid_pnl_base: list[tuple[float, float]]      # (spot_mult, pnl) for dashboard
    grid_pnl_stressed: list[tuple[float, float]]


def _leg_value(leg: Leg, spot: float, asof: datetime, horizon: datetime,
               iv: float, r: float) -> float:
    """Value of one leg per share at `horizon` if underlying is at `spot`."""
    exp_t = leg.t_years(horizon)
    if exp_t <= 0:
        return bs.intrinsic(spot, leg.contract.strike, leg.contract.right)
    return bs.price(spot, leg.contract.strike, exp_t, iv, leg.contract.right, r)


def _spot_map(spot: "float | dict[str, float]", legs: list[Leg]) -> dict[str, float]:
    """Accept a bare float (single-underlying book, backward compatible) or a
    per-underlying map. Multi-underlying books stress all underlyings by the
    SAME relative move — a perfect-correlation assumption, conservative for
    an index pair like SPY/QQQ and stated openly in the write-up."""
    if isinstance(spot, dict):
        missing = {l.contract.underlying for l in legs} - set(spot)
        if missing:
            raise ValueError(f"spot_map missing underlyings: {sorted(missing)}")
        return spot
    return {u: float(spot) for u in {l.contract.underlying for l in legs}}


def portfolio_worst_case(
    legs: list[Leg],
    spot: "float | dict[str, float]",
    asof: datetime,
    horizon: datetime,
    iv_map: dict[str, float],
    *,
    grid_low: float = 0.80,
    grid_high: float = 1.20,
    grid_step: float = 0.005,
    vol_shock_up_rel: float = 0.50,
    r: float = 0.04,
    default_iv: float = 0.20,
) -> PayoffResult:
    """Worst P&L of the combined leg set.

    Scenarios:
      base      — each leg keeps its current IV (sticky-strike assumption)
      stressed  — on down moves IV is scaled up by vol_shock_up_rel * |move|/20%
                  (crash => vol spike; hurts short premium marked pre-expiry,
                  helps the hedge sleeve — both effects must be captured)
    """
    if not legs:
        return PayoffResult(0.0, 1.0, "base", [], [])
    spots = _spot_map(spot, legs)

    grid_base: list[tuple[float, float]] = []
    grid_stress: list[tuple[float, float]] = []
    worst = (0.0, 1.0, "base")

    mult = grid_low
    while mult <= grid_high + 1e-9:
        pnl_b = 0.0
        pnl_s = 0.0
        down_frac = max(0.0, 1.0 - mult)            # 0 at spot, 0.2 at -20%
        shock = 1.0 + vol_shock_up_rel * (down_frac / 0.20)
        for leg in legs:
            s = spots[leg.contract.underlying] * mult
            iv = iv_map.get(leg.contract.symbol, default_iv)
            vb = _leg_value(leg, s, asof, horizon, iv, r)
            vs = _leg_value(leg, s, asof, horizon, iv * shock, r)
            pnl_b += leg.qty * (vb - leg.entry_price) * MULTIPLIER
            pnl_s += leg.qty * (vs - leg.entry_price) * MULTIPLIER
        grid_base.append((round(mult, 4), round(pnl_b, 2)))
        grid_stress.append((round(mult, 4), round(pnl_s, 2)))
        if pnl_b < worst[0]:
            worst = (pnl_b, mult, "base")
        if pnl_s < worst[0]:
            worst = (pnl_s, mult, "stressed")
        mult += grid_step

    return PayoffResult(
        worst_pnl=round(worst[0], 2),
        worst_spot_rel=round(worst[1], 4),
        worst_scenario=worst[2],
        grid_pnl_base=grid_base,
        grid_pnl_stressed=grid_stress,
    )


def mark_to_model(legs: list[Leg], spot: "float | dict[str, float]", asof: datetime,
                  iv_map: dict[str, float], r: float = 0.04,
                  default_iv: float = 0.20) -> float:
    """Model P&L of a leg set at current spot/IV (used by shadow books)."""
    if not legs:
        return 0.0
    spots = _spot_map(spot, legs)
    pnl = 0.0
    for leg in legs:
        s = spots[leg.contract.underlying]
        iv = iv_map.get(leg.contract.symbol, default_iv)
        t = leg.t_years(asof)
        v = bs.price(s, leg.contract.strike, t, iv, leg.contract.right, r) if t > 0 \
            else bs.intrinsic(s, leg.contract.strike, leg.contract.right)
        pnl += leg.qty * (v - leg.entry_price) * MULTIPLIER
    return round(pnl, 2)
