"""Volatility regime map (RED-TEAM P10: includes the cheap-vol branch).

The quantitative signal is deterministic code — the LLM desk interprets,
vetoes and argues, but VRP itself is arithmetic and we say so honestly.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Regime(str, Enum):
    SELL = "sell_premium"      # vol rich: condors + put credit spreads
    NEUTRAL = "neutral"        # smaller size, condors only, wider strikes
    CHEAP = "cheap_vol"        # vol cheap: book inverts — tiny long-vega, core sleeps


@dataclass(frozen=True)
class RegimeCall:
    regime: Regime
    vrp_ratio: float     # (atm_iv - rv20) / rv20
    atm_iv: float
    rv20: float
    rationale: str


def classify(atm_iv: float, rv20: float,
             sell_thresh: float = 0.15, cheap_thresh: float = 0.0) -> RegimeCall:
    if rv20 <= 0:
        return RegimeCall(Regime.NEUTRAL, 0.0, atm_iv, rv20, "rv20 unavailable -> neutral")
    vrp = (atm_iv - rv20) / rv20
    if vrp > sell_thresh:
        return RegimeCall(Regime.SELL, vrp, atm_iv, rv20,
                          f"IV {atm_iv:.1%} rich vs RV {rv20:.1%} (VRP {vrp:+.1%})")
    if vrp < cheap_thresh:
        return RegimeCall(Regime.CHEAP, vrp, atm_iv, rv20,
                          f"IV {atm_iv:.1%} cheap vs RV {rv20:.1%} (VRP {vrp:+.1%})")
    return RegimeCall(Regime.NEUTRAL, vrp, atm_iv, rv20,
                      f"VRP {vrp:+.1%} inside neutral band")
