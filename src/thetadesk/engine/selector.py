"""Deterministic structure selector — regime map -> candidate structure.

LLMs argue and veto; strike selection is pure code (RED-TEAM P7).

Regime map (RED-TEAM P10):
  vrp_score >= rich_threshold  -> iron condor, full base size
  cheap <= score < rich        -> iron condor, wider strikes, 0.5x size
  vrp_score < cheap_threshold  -> cheap-vol branch: micro long-vega
                                  (long put ~25-delta at target expiry)
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime

from .contracts import Leg, OptionContract, Structure


@dataclass
class ChainEntry:
    symbol: str
    right: str
    strike: float
    expiry: date
    bid: float
    ask: float
    mid: float
    delta: float | None
    iv: float | None


def parse_chain(snapshots: dict[str, dict]) -> list[ChainEntry]:
    out: list[ChainEntry] = []
    for sym, s in snapshots.items():
        try:
            c = OptionContract.parse(sym)
        except ValueError:
            continue
        q = s.get("latestQuote") or {}
        bid = float(q.get("bp") or 0.0)
        ask = float(q.get("ap") or 0.0)
        g = s.get("greeks") or {}
        out.append(ChainEntry(
            symbol=c.symbol, right=c.right, strike=c.strike, expiry=c.expiry,
            bid=bid, ask=ask, mid=0.5 * (bid + ask) if bid > 0 and ask > 0 else 0.0,
            delta=g.get("delta"), iv=s.get("impliedVolatility"),
        ))
    return out


def _nearest_by_delta(entries: list[ChainEntry], right: str, target: float) -> ChainEntry | None:
    best, err = None, 1e9
    for e in entries:
        if e.right != right or e.delta is None or e.mid <= 0:
            continue
        d = abs(e.delta)
        if d < 0.01 or d > 0.60:
            continue
        if abs(d - target) < err:
            best, err = e, abs(d - target)
    return best


def _by_strike(entries: list[ChainEntry], right: str, strike: float) -> ChainEntry | None:
    cands = [e for e in entries if e.right == right and abs(e.strike - strike) < 1e-6]
    return cands[0] if cands else None


def _sid(kind: str, legs: list[Leg], day: str) -> str:
    key = f"{day}|{kind}|" + "|".join(sorted(l.contract.symbol for l in legs))
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def vrp_score(atm_iv: float, realized_vol: float) -> float:
    """Deterministic volatility-risk-premium score in [0, 1].
    0.5 = IV equals RV; +1 sigma-ish enrichment maps toward 1."""
    if realized_vol <= 0:
        return 0.5
    edge = (atm_iv - realized_vol) / realized_vol      # relative richness
    return max(0.0, min(1.0, 0.5 + edge))


@dataclass
class Candidate:
    structure: Structure
    regime: str                 # rich | neutral | cheap
    size_mult: float            # applied before risk-budget sizing
    rationale: str


def build_iron_condor(entries: list[ChainEntry], expiry: date, cfg: dict,
                      day: str, widen: float = 0.0) -> Structure | None:
    ex = [e for e in entries if e.expiry == expiry]
    sp = _nearest_by_delta(ex, "P", cfg["short_put_delta"] - widen)
    sc = _nearest_by_delta(ex, "C", cfg["short_call_delta"] - widen)
    if not sp or not sc:
        return None
    lp = _by_strike(ex, "P", sp.strike - cfg["put_wing_width"])
    lc = _by_strike(ex, "C", sc.strike + cfg["call_wing_width"])
    if not lp or not lc or lp.mid <= 0 or lc.mid <= 0:
        return None
    credit = (sp.mid + sc.mid) - (lp.mid + lc.mid)
    width = max(cfg["put_wing_width"], cfg["call_wing_width"])
    if credit < cfg["min_credit_frac_of_width"] * width:
        return None
    legs = [
        Leg(OptionContract.parse(sp.symbol), -1, sp.mid),
        Leg(OptionContract.parse(lp.symbol), +1, lp.mid),
        Leg(OptionContract.parse(sc.symbol), -1, sc.mid),
        Leg(OptionContract.parse(lc.symbol), +1, lc.mid),
    ]
    return Structure(structure_id=_sid("iron_condor", legs, day), kind="iron_condor",
                     sleeve="core", legs=legs, net_credit=round(credit, 2))


def build_hedge_put(entries: list[ChainEntry], expiry: date, cfg: dict, day: str) -> Structure | None:
    ex = [e for e in entries if e.expiry == expiry]
    p = _nearest_by_delta(ex, "P", cfg["put_delta"])
    if not p or p.mid <= 0:
        return None
    legs = [Leg(OptionContract.parse(p.symbol), +1, p.mid)]
    return Structure(structure_id=_sid("hedge_put", legs, day), kind="hedge_put",
                     sleeve="hedge", legs=legs, net_credit=round(-p.mid, 2))


def build_cheap_vol_put(entries: list[ChainEntry], expiry: date, day: str) -> Structure | None:
    """Cheap-vol branch: micro long 25-delta put (long vega, defined risk = debit)."""
    ex = [e for e in entries if e.expiry == expiry]
    p = _nearest_by_delta(ex, "P", 0.25)
    if not p or p.mid <= 0:
        return None
    legs = [Leg(OptionContract.parse(p.symbol), +1, p.mid)]
    return Structure(structure_id=_sid("cheap_vol_put", legs, day), kind="cheap_vol_put",
                     sleeve="core", legs=legs, net_credit=round(-p.mid, 2))


def select(entries: list[ChainEntry], expiry: date, score: float,
           cfg_structures: dict, cfg_regime: dict, day: str) -> Candidate | None:
    rich = cfg_regime["vrp_rich_threshold"]
    cheap = cfg_regime["vrp_cheap_threshold"]
    if score >= rich:
        s = build_iron_condor(entries, expiry, cfg_structures["condor"], day)
        if s:
            return Candidate(s, "rich", 1.0,
                             f"VRP score {score:.2f} >= {rich}: sell premium at base size")
        return None
    if score >= cheap:
        s = build_iron_condor(entries, expiry, cfg_structures["condor"], day, widen=0.04)
        if s:
            return Candidate(s, "neutral", 0.5,
                             f"VRP score {score:.2f} neutral: wider condor, half size")
        return None
    s = build_cheap_vol_put(entries, expiry, day)
    if s:
        return Candidate(s, "cheap", 0.25,
                         f"VRP score {score:.2f} < {cheap}: vol is cheap — micro long vega")
    return None
