"""Earned size — the ladder that sets every risk ceiling the gates enforce.

The ceilings are fractions of equity. Until DEVLOG #36 they were constants,
and one of them pinned the whole desk: 1.25% per structure is $1,255 on a
$100k account, a $10-wide index condor risks ~$830 for ONE contract, and a
second contract would need $1,660. So all nine structures the desk ever
opened went out at qty 1 — not by decision, by arithmetic. Realised +$598 on
$3,165 of closed risk is +18.9% on the risk actually taken; the book simply
never held much of it (4.85% of equity across the whole week).

The ladder makes the fractions a function of the desk's own record:

  * a rung is EARNED by resolved core trades (closed — never open, never
    working) and only while the realised result is not negative: five
    closed losers earn nothing;
  * a rung is TAKEN BACK by drawdown from the high-water mark — one rung at
    demote_one_tier_at_drawdown, every rung at demote_to_floor_at_drawdown,
    which sits below gate #14's halt so the desk shrinks before it stops;
  * disabled, the ladder is a single fixed rung made of the risk.* constants
    — exactly the desk as it traded through 2026-09-03. That is the rollback.

Nothing here reads a market or a model. It is a table, three counters and a
subtraction, and the tick journals the result as `ladder` before it sizes.
"""
from __future__ import annotations

from dataclasses import dataclass

FIELDS = ("per_structure", "daily_new", "book_base", "book_cap")


@dataclass(frozen=True)
class Tier:
    name: str
    min_closed: int
    per_structure: float       # gate #7   worst case of one structure / equity
    daily_new: float           # gate #9   new worst case opened per session / equity
    book_base: float           # gate #8   base worst-case budget / equity
    book_cap: float            # gate #8   ceiling the earned extension cannot pass


@dataclass
class LadderState:
    enabled: bool
    tier: Tier                 # what the gates use this tick
    earned: Tier               # by record alone, before drawdown
    closed: int
    realized: float
    drawdown: float
    demoted: int               # rungs lost to drawdown this tick
    next_tier: Tier | None     # the rung above `earned`, if any
    reason: str

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "tier": self.tier.name,
            "earned": self.earned.name,
            "closed": self.closed,
            "realized": round(self.realized, 2),
            "drawdown": round(self.drawdown, 4),
            "demoted": self.demoted,
            "next": (None if self.next_tier is None
                     else {"name": self.next_tier.name, "min_closed": self.next_tier.min_closed}),
            "fracs": {f: getattr(self.tier, f) for f in FIELDS},
            "reason": self.reason,
        }


def fixed_tier(risk: dict) -> Tier:
    """The desk before the ladder: one rung made of the risk.* constants."""
    return Tier("fixed", 0,
                float(risk["per_structure_max_loss_frac"]),
                float(risk["daily_new_risk_frac"]),
                float(risk["portfolio_worst_case_frac"]),
                float(risk["portfolio_worst_case_cap"]))


def tiers_from_config(raw: dict) -> tuple[bool, list[Tier]]:
    """(enabled, rungs). Validated on load: the first rung starts at zero
    closed, min_closed strictly ascends, no fraction ever steps DOWN rung to
    rung, and no rung sits below the risk.* floor. A ladder that could size
    down from the constants, or skip a rung, is a config error and refuses to
    load rather than trade something surprising."""
    lad = raw.get("ladder") or {}
    floor = fixed_tier(raw["risk"])
    if not lad.get("enabled"):
        return False, [floor]
    rows = lad.get("tiers") or []
    if not rows:
        raise ValueError("ladder.enabled but ladder.tiers is empty")
    tiers = [Tier(str(r["name"]), int(r["min_closed"]),
                  float(r["per_structure_frac"]), float(r["daily_new_risk_frac"]),
                  float(r["portfolio_worst_case_frac"]), float(r["portfolio_worst_case_cap"]))
             for r in rows]
    if tiers[0].min_closed != 0:
        raise ValueError("the first ladder rung must start at min_closed 0")
    prev: Tier | None = None
    for t in tiers:
        for f in FIELDS:
            if getattr(t, f) < getattr(floor, f) - 1e-12:
                raise ValueError(f"ladder rung {t.name}.{f} is below the risk.* floor")
            if prev is not None and getattr(t, f) < getattr(prev, f) - 1e-12:
                raise ValueError(f"ladder rung {t.name}.{f} steps down from {prev.name}")
        if t.book_base > t.book_cap + 1e-12:
            raise ValueError(f"ladder rung {t.name}: portfolio base above its cap")
        if prev is not None and t.min_closed <= prev.min_closed:
            raise ValueError("ladder rungs must have strictly ascending min_closed")
        prev = t
    return True, tiers


def resolve(raw: dict, closed: int, realized: float, equity: float,
            high_watermark: float) -> LadderState:
    """The rung for this tick, from the record and the drawdown."""
    enabled, tiers = tiers_from_config(raw)
    dd = 0.0
    if high_watermark > 0 and equity > 0:
        dd = max(0.0, 1.0 - equity / high_watermark)
    if not enabled:
        t = tiers[0]
        return LadderState(False, t, t, closed, realized, dd, 0, None,
                           "ladder disabled — the fixed risk.* constants")

    lad = raw["ladder"]
    need_nonneg = bool(lad.get("promote_requires_realized_nonneg", True))
    withheld = need_nonneg and realized < 0
    idx = 0
    if not withheld:
        for i, t in enumerate(tiers):
            if closed >= t.min_closed:
                idx = i
    earned = tiers[idx]
    nxt = tiers[idx + 1] if idx + 1 < len(tiers) else None

    one_at = float(lad.get("demote_one_tier_at_drawdown", 0.02))
    floor_at = float(lad.get("demote_to_floor_at_drawdown", 0.035))
    demoted = 0
    if dd >= floor_at:
        demoted = idx
    elif dd >= one_at:
        demoted = min(1, idx)
    tier = tiers[idx - demoted]

    if withheld and len(tiers) > 1 and closed >= tiers[1].min_closed:
        reason = f"{closed} closed but realized {realized:+,.0f} < 0 — promotion withheld"
    elif demoted:
        reason = f"drawdown {dd:.2%} — {demoted} rung(s) taken back from {earned.name}"
    elif nxt is not None:
        reason = (f"{closed} closed, realized {realized:+,.0f}; "
                  f"{nxt.name} at {nxt.min_closed} closed")
    else:
        reason = f"{closed} closed, realized {realized:+,.0f}; top rung"
    return LadderState(True, tier, earned, closed, realized, dd, demoted, nxt, reason)
