"""Deterministic market signals: realized vol, ATM IV, VRP score."""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

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


# ---------------------------------------------------------------------------
# DEVLOG #28: L1 data-quality gate. One bad IEX quote (bid=0 after the close)
# once produced spot=380.9 on a 762 underlying, atm_iv 0.67, vrp 1.0 and
# $182k marks in the store, journal and the public dashboard. Every tick now
# classifies its inputs BEFORE anything is written:
#   full      -> normal tick
#   mark_only -> reconcile + management + marks, but no new risk
#   skip      -> reconcile + integrity only; nothing else is written
# ---------------------------------------------------------------------------

@dataclass
class DataQuality:
    mode: str                 # full | mark_only | skip
    spot: float               # the spot the tick should use
    spot_source: str          # quote | prev_close | none
    reasons: list[str]

    def to_dict(self) -> dict:
        return {"mode": self.mode, "spot": round(self.spot, 4), "spot_source": self.spot_source,
                "reasons": self.reasons}


def assess(quote: dict, closes: list[float], bars: list[dict], session_date: str,
           lookback: int = 20, *, max_rel_spread: float = 0.005,
           max_dev_from_close: float = 0.06, max_bar_age_days: int = 5) -> DataQuality:
    """Validate the stock quote and the daily-bar history for one tick."""
    reasons: list[str] = []
    mode = "full"
    prev_close = closes[-1] if closes else 0.0

    bid = float((quote or {}).get("bp") or 0.0)
    ask = float((quote or {}).get("ap") or 0.0)
    good_quote = bid > 0 and ask > 0 and ask >= bid and (ask - bid) / ask <= max_rel_spread
    if good_quote:
        spot, source = 0.5 * (bid + ask), "quote"
    else:
        reasons.append(f"stock quote unusable (bp={bid}, ap={ask})")
        if prev_close > 0:
            spot, source, mode = prev_close, "prev_close", "mark_only"
        else:
            return DataQuality("skip", 0.0, "none", reasons + ["no previous close either"])

    if prev_close > 0 and abs(spot / prev_close - 1.0) > max_dev_from_close:
        reasons.append(f"spot {spot:.2f} deviates {spot / prev_close - 1:+.1%} from last close {prev_close:.2f}")
        return DataQuality("skip", spot, source, reasons)

    if len(closes) < lookback + 1:
        reasons.append(f"only {len(closes)} closes for a {lookback}-day realized-vol window")
        mode = "mark_only"
    if bars:
        last_t = str(bars[-1].get("t", ""))[:10]
        try:
            age = (date.fromisoformat(session_date) - date.fromisoformat(last_t)).days
        except ValueError:
            age = 999
        if age > max_bar_age_days:
            reasons.append(f"last daily bar {last_t} is {age}d before session {session_date}")
            mode = "mark_only"
    return DataQuality(mode, spot, source, reasons)


def check_iv(sig: MarketSignals, lo: float = 0.05, hi: float = 0.60,
             max_ratio_to_rv: float = 3.0) -> str | None:
    """ATM IV outside [lo, hi], or several times realized vol, is a broken
    chain or a wrong spot, not a regime (K1 read 0.67 = 5x RV). During a real
    crisis spike this only pauses NEW entries, which is the right reflex."""
    if not (lo <= sig.atm_iv <= hi):
        return f"atm_iv {sig.atm_iv:.3f} outside [{lo}, {hi}]"
    if sig.rv20 > 0 and sig.atm_iv > max_ratio_to_rv * sig.rv20:
        return f"atm_iv {sig.atm_iv:.3f} is {sig.atm_iv / sig.rv20:.1f}x realized vol {sig.rv20:.3f}"
    return None
