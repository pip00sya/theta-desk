"""Deterministic market signals: realized vol, ATM IV, VRP score."""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..engine.selector import ChainEntry, vrp_score


def realized_vol(closes: list[float], lookback: int = 20) -> float:
    """Close-to-close realized volatility, annualized."""
    px = closes[-(lookback + 1):]
    if len(px) < 3:
        return 0.0
    rets = [math.log(px[i] / px[i - 1]) for i in range(1, len(px))]
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var * 252.0)


def atm_iv(entries: list[ChainEntry], spot: float, n: int = 6) -> float:
    """Average IV of the n contracts nearest the money (both rights)."""
    with_iv = [e for e in entries if e.iv and e.iv > 0.01]
    if not with_iv:
        return 0.0
    nearest = sorted(with_iv, key=lambda e: abs(e.strike - spot))[:n]
    return sum(e.iv for e in nearest) / len(nearest)


@dataclass
class MarketSignals:
    spot: float
    rv20: float
    atm_iv: float
    vrp: float          # score in [0,1]

    def to_dict(self) -> dict:
        return {"spot": self.spot, "rv20": round(self.rv20, 4),
                "atm_iv": round(self.atm_iv, 4), "vrp_score": round(self.vrp, 4)}


def compute(entries: list[ChainEntry], closes: list[float], spot: float,
            lookback: int = 20) -> MarketSignals:
    rv = realized_vol(closes, lookback)
    iv = atm_iv(entries, spot)
    return MarketSignals(spot=spot, rv20=rv, atm_iv=iv, vrp=vrp_score(iv, rv))
