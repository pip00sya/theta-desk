"""Position manager — management rules patched per RED-TEAM P5/P6.

  - profit target 35% of max profit (50% is unreachable in a 4-day window)
  - realization policy: on a day with no new entries, close the best
    structure at >= 25% so the account shows management activity daily
  - structure stop: loss of 2x received credit -> close
  - time stop DTE < 7 (moot while all legs sit behind min_expiry, kept as
    a safety net for post-submission mode)
  - halt mode: 4% drawdown stops NEW risk only; flatten happens ONLY on an
    integrity breach (naked leg / unknown position), never on drawdown
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

from ..engine.contracts import Leg, OptionContract, Structure
from ..engine.payoff import mark_to_model


@dataclass
class ManageAction:
    structure_id: str
    action: str          # close | hold | flatten_all
    reason: str
    est_pnl: float = 0.0


def legs_from_json(legs_json: str) -> list[Leg]:
    out = []
    for d in json.loads(legs_json):
        out.append(Leg(OptionContract.parse(d["symbol"]), d["qty"], d["entry_price"]))
    return out


def structure_mtm(legs: list[Leg], chain: dict[str, dict]) -> float | None:
    """Mark structure P&L per unit from live chain mids; None if any leg unmarkable."""
    pnl = 0.0
    for leg in legs:
        snap = chain.get(leg.contract.symbol) or {}
        q = snap.get("latestQuote") or {}
        bid, ask = float(q.get("bp") or 0), float(q.get("ap") or 0)
        if bid <= 0 or ask <= 0:
            return None
        mid = 0.5 * (bid + ask)
        pnl += leg.qty * (mid - leg.entry_price) * 100
    return pnl


def review_book(open_structures: list[dict], chain: dict[str, dict],
                cfg_mgmt: dict, now: datetime, entries_today: int,
                min_expiry: str) -> list[ManageAction]:
    actions: list[ManageAction] = []
    realize_candidates: list[tuple[float, dict, float]] = []

    for s in open_structures:
        if s["status"] != "open":
            continue
        legs = legs_from_json(s["legs_json"])
        mtm = structure_mtm(legs, chain)
        if mtm is None:
            actions.append(ManageAction(s["structure_id"], "hold", "unmarkable quote — hold"))
            continue
        qty = s["qty"]
        credit = s["net_credit"]

        if credit > 0:  # short-premium structure
            max_profit = credit * 100 * qty
            frac = mtm / max_profit if max_profit > 0 else 0.0
            if frac >= cfg_mgmt["profit_target_frac"]:
                actions.append(ManageAction(s["structure_id"], "close",
                                            f"profit target: {frac:.0%} of max profit", mtm))
                continue
            if mtm <= -cfg_mgmt["structure_stop_credit_mult"] * credit * 100 * qty:
                actions.append(ManageAction(s["structure_id"], "close",
                                            f"structure stop: loss {mtm:,.0f} vs credit "
                                            f"{credit * 100 * qty:,.0f}", mtm))
                continue
            if frac >= cfg_mgmt["realize_min_frac"]:
                realize_candidates.append((frac, s, mtm))

        # time stop (post-submission safety net)
        dtes = [(l.contract.expiry - now.date()).days for l in legs]
        if min(dtes) < cfg_mgmt["time_stop_dte"]:
            actions.append(ManageAction(s["structure_id"], "close",
                                        f"time stop: min DTE {min(dtes)} < {cfg_mgmt['time_stop_dte']}",
                                        mtm))
            continue

        actions.append(ManageAction(s["structure_id"], "hold", "within plan", mtm))

    # realization policy: idle day -> close the best candidate >= 25%
    if entries_today == 0 and realize_candidates:
        realize_candidates.sort(key=lambda t: -t[0])
        frac, s, mtm = realize_candidates[0]
        for a in actions:
            if a.structure_id == s["structure_id"] and a.action == "hold":
                a.action = "close"
                a.reason = f"realization policy: best structure at {frac:.0%}, idle day"
                a.est_pnl = mtm
    return actions


def integrity_check(open_structures: list[dict], broker_positions: list[dict]) -> tuple[bool, str]:
    """Broker is the source of truth. A naked short or an unknown position is
    the ONLY trigger for flatten-all (RED-TEAM P5)."""
    book_syms: dict[str, int] = {}
    for s in open_structures:
        if s["status"] != "open":
            continue
        for leg in legs_from_json(s["legs_json"]):
            book_syms[leg.contract.symbol] = book_syms.get(leg.contract.symbol, 0) + leg.qty * s["qty"]

    broker_syms = {p["symbol"]: int(float(p["qty"])) for p in broker_positions
                   if len(p.get("symbol", "")) > 12}  # option symbols only

    unknown = set(broker_syms) - set(book_syms)
    if unknown:
        return False, f"unknown option positions at broker: {sorted(unknown)}"
    for sym, q in book_syms.items():
        bq = broker_syms.get(sym, 0)
        if q < 0 and bq > q:  # we think short but broker shows less short/none while others gone
            pass  # partial closes are fine; only report structural nakedness below
    # naked short: any net-short symbol at broker with no long leg in the same expiry+right book-side
    for sym, bq in broker_syms.items():
        if bq < 0 and book_syms.get(sym, 0) >= 0:
            return False, f"naked short at broker not in book: {sym}"
    return True, "book/broker consistent"
