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
    abs_spread: float = 0.0


def check_quote(snapshot: dict, max_rel_spread: float = 0.08,
                max_abs_spread: float = 0.0) -> QuoteCheck:
    """A leg is untradeable when crossing its spread is EXPENSIVE.

    DEVLOG #36c: for four sessions that was measured in per cent alone, and
    per cent is the wrong instrument for a cheap contract. A far wing quoted
    0.15/0.20 is "28.6% wide" and costs three dollars a contract to cross; a
    $5.00 contract quoted 9.5% wide costs fifty. The relative cap refused the
    first and would have passed the second. On 2026-09-03 it refused ten
    candidates whose widest leg cost between one and three dollars to cross,
    and 206 of the 282 contracts it rejected chain-wide were penny-wide.

    So a leg fails only when it is wide BOTH ways: over the relative cap AND
    over an absolute one. max_abs_spread = 0 keeps the old behaviour, which
    is the rollback. Everything genuinely expensive to cross still fails —
    the absolute test is an escape for cheapness, never for width."""
    q = (snapshot or {}).get("latestQuote") or {}
    bid = float(q.get("bp") or 0.0)
    ask = float(q.get("ap") or 0.0)
    if bid <= 0.0 or ask <= 0.0:
        return QuoteCheck(False, "no two-sided quote", bid, ask)
    if ask < bid:
        return QuoteCheck(False, "crossed quote", bid, ask)
    mid = 0.5 * (bid + ask)
    absolute = ask - bid
    rel = absolute / mid if mid > 0 else 999.0
    if rel > max_rel_spread and absolute > max_abs_spread:
        why = f"rel spread {rel:.1%} > {max_rel_spread:.0%}"
        if max_abs_spread > 0:
            why += f" and ${absolute:.2f} > ${max_abs_spread:.2f} to cross"
        return QuoteCheck(False, why, bid, ask, mid, rel, absolute)
    return QuoteCheck(True, "ok", bid, ask, mid, rel, absolute)
