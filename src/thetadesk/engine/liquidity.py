"""Gates #5/#6: liquidity checks against the indicative feed.

Refuse-by-default: the free feed produces stale/one-sided quotes; anything
that fails these checks is not tradeable, whatever the model says.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class QuoteCheck:
    ok: bool
    reason: str
    bid: float = 0.0
    ask: float = 0.0
    mid: float = 0.0
    rel_spread: float = 0.0


def check_quote(snapshot: dict, max_rel_spread: float = 0.08) -> QuoteCheck:
    q = (snapshot or {}).get("latestQuote") or {}
    bid = float(q.get("bp") or 0.0)
    ask = float(q.get("ap") or 0.0)
    if bid <= 0.0 or ask <= 0.0:
        return QuoteCheck(False, "no two-sided quote", bid, ask)
    if ask < bid:
        return QuoteCheck(False, "crossed quote", bid, ask)
    mid = 0.5 * (bid + ask)
    rel = (ask - bid) / mid if mid > 0 else 999.0
    if rel > max_rel_spread:
        return QuoteCheck(False, f"rel spread {rel:.1%} > {max_rel_spread:.0%}",
                          bid, ask, mid, rel)
    return QuoteCheck(True, "ok", bid, ask, mid, rel)
