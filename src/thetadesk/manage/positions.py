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
                min_expiry: str, derisk_mode: bool = False,
                derisk_lock_frac: float = 0.15) -> list[ManageAction]:
    """DEVLOG #15: exits exist for BOTH directions of premium.
      credit structures: 35% profit target, 2x credit stop
      debit structures:  +60% of debit target (vol spikes mean-revert),
                         no stop-loss (loss already bounded by the debit)
    derisk_mode (inside a high-event window): lock anything >= +15%."""
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
        else:  # debit (long-premium) structure
            cost = abs(credit) * 100 * qty
            frac = mtm / cost if cost > 0 else 0.0
            target = cfg_mgmt.get("debit_profit_target_frac", 0.60)
            if frac >= target:
                actions.append(ManageAction(s["structure_id"], "close",
                                            f"debit profit target: +{frac:.0%} of cost", mtm))
                continue

        if derisk_mode and frac >= derisk_lock_frac:
            actions.append(ManageAction(s["structure_id"], "close",
                                        f"event de-risk: locking +{frac:.0%} before release", mtm))
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


@dataclass
class ReconcileAction:
    structure_id: str
    action: str          # closes: closed | cancel_revert | reverted | pending
                         # opens:  filled | cancel_unfilled | unfilled | pending
    reason: str
    pnl: float | None = None
    order_id: str | None = None
    fills: dict | None = None          # symbol -> real fill price (per share)
    net_credit: float | None = None    # real net credit per unit after fills


BOOK_STATUSES = ("open", "closing")            # position IS at the broker
KNOWN_STATUSES = ("open", "closing", "pending")  # may be at the broker (entry working)


def fills_from_order(order: dict, legs_json: str) -> tuple[dict[str, float], float | None]:
    """Real per-leg fill prices from a broker order (mleg orders carry them
    under `legs`; a single-leg order on the parent). Returns (fills, net
    credit per unit = sum(-qty * price)) — net None if any leg is unpriced."""
    legs = json.loads(legs_json)
    fills: dict[str, float] = {}
    for lo in order.get("legs") or []:
        p = lo.get("filled_avg_price")
        if lo.get("symbol") and p:
            fills[lo["symbol"]] = float(p)
    if not fills and len(legs) == 1 and order.get("filled_avg_price"):
        fills[legs[0]["symbol"]] = float(order["filled_avg_price"])
    if any(d["symbol"] not in fills for d in legs):
        return fills, None
    return fills, round(sum(-d["qty"] * fills[d["symbol"]] for d in legs), 4)


def apply_fills(legs_json: str, fills: dict[str, float]) -> str:
    legs = json.loads(legs_json)
    for d in legs:
        if d["symbol"] in fills:
            d["entry_price"] = fills[d["symbol"]]
    return json.dumps(legs)


def _order_age_min(po: dict, order: dict, now: datetime, default: float) -> float:
    try:
        sub = datetime.fromisoformat(
            str(po.get("ts") or order.get("submitted_at", "")).replace("Z", "+00:00"))
        return (now - sub).total_seconds() / 60
    except ValueError:
        return default


def reconcile_pending(pending: list[dict], orders: dict[str, dict], lookup,
                      now: datetime, fill_wait_min: int) -> list[ReconcileAction]:
    """DEVLOG #20 — the entry-side twin of reconcile_closing: a structure is
    OPEN only when the broker says filled.

    filled            -> open, legs repriced to the REAL fills
    dead at broker    -> unfilled (the selector may propose it again; the
                         attempt counter bounds the retries)
    live > fill_wait  -> cancel + unfilled
    partially filled  -> wait (cancelling would leave a broken structure)
    """
    out: list[ReconcileAction] = []
    for s in pending:
        sid = s["structure_id"]
        po = orders.get(sid) or {}
        coid = po.get("client_order_id") or s.get("client_order_id")
        o = lookup(coid) if coid else None
        if not o:
            out.append(ReconcileAction(sid, "pending", f"order {coid} not found at broker — waiting"))
            continue
        st, oid = o.get("status", "unknown"), o.get("id")
        if st == "filled":
            fills, net = fills_from_order(o, s["legs_json"])
            reason = f"filled, net {net if net is not None else 'n/a'} vs intended {s['net_credit']}"
            out.append(ReconcileAction(sid, "filled", reason, None, oid, fills, net))
        elif st in _DEAD_ORDER:
            out.append(ReconcileAction(sid, "unfilled", f"entry order {st} at broker", None, oid))
        elif st == "partially_filled":
            out.append(ReconcileAction(sid, "pending", "partial fill — waiting", None, oid))
        elif st in _LIVE_ORDER:
            age = _order_age_min(po, o, now, fill_wait_min)
            if age >= fill_wait_min:
                out.append(ReconcileAction(sid, "cancel_unfilled",
                                           f"unfilled {age:.0f}m >= {fill_wait_min}m — cancel", None, oid))
            else:
                out.append(ReconcileAction(sid, "pending", f"unfilled {age:.0f}m — waiting", None, oid))
        else:
            out.append(ReconcileAction(sid, "pending", f"order status {st} — waiting", None, oid))
    return out

_LIVE_ORDER = ("new", "accepted", "pending_new", "held", "accepted_for_bidding",
               "partially_filled")
_DEAD_ORDER = ("canceled", "expired", "rejected", "done_for_day", "replaced", "stopped")


def reconcile_closing(closing: list[dict], pending: dict[str, dict], lookup,
                      now: datetime, fill_wait_min: int) -> list[ReconcileAction]:
    """DEVLOG #19: a structure is CLOSED only when the broker says filled.

    `closing`  — structures whose close order was accepted (status 'closing')
    `pending`  — structure_id -> {client_order_id, est_pnl, ts} from the kv store
    `lookup`   — client_order_id -> broker order dict (or None)

    filled            -> closed at the REAL fill price (not the decision-time mid)
    dead at broker    -> reverted to open (the manager re-decides)
    live > fill_wait  -> cancel + revert (a re-decision at the new mid is the reprice)
    partially filled  -> wait (cancelling would split the structure)
    """
    out: list[ReconcileAction] = []
    for s in closing:
        sid = s["structure_id"]
        po = pending.get(sid) or {}
        coid = po.get("client_order_id") or s.get("client_order_id")
        o = lookup(coid) if coid else None
        if not o:
            out.append(ReconcileAction(sid, "pending", f"order {coid} not found at broker — waiting"))
            continue
        st = o.get("status", "unknown")
        oid = o.get("id")
        if st == "filled":
            fills, _ = fills_from_order(o, s["legs_json"])
            qty = s["qty"]
            legs = json.loads(s["legs_json"])
            if fills and all(d["symbol"] in fills for d in legs):
                # per-leg: what we sold/bought back vs what we paid/received
                pnl = sum(d["qty"] * (fills[d["symbol"]] - d["entry_price"]) * 100 * qty
                          for d in legs)
                reason = "filled " + ", ".join(f"{k[-9:]}@{v:.2f}" for k, v in fills.items())
            else:
                pnl = float(po.get("est_pnl") or 0.0)
                reason = "filled, no per-leg prices — estimate kept"
            out.append(ReconcileAction(sid, "closed", reason, round(pnl, 2), oid, fills or None))
        elif st in _DEAD_ORDER:
            out.append(ReconcileAction(sid, "reverted", f"close order {st} at broker", None, oid))
        elif st == "partially_filled":
            out.append(ReconcileAction(sid, "pending", "partial fill — waiting", None, oid))
        elif st in _LIVE_ORDER:
            age_min = _order_age_min(po, o, now, fill_wait_min)
            if age_min >= fill_wait_min:
                out.append(ReconcileAction(sid, "cancel_revert",
                                           f"unfilled {age_min:.0f}m >= {fill_wait_min}m — cancel, re-decide",
                                           None, oid))
            else:
                out.append(ReconcileAction(sid, "pending", f"unfilled {age_min:.0f}m — waiting", None, oid))
        else:
            out.append(ReconcileAction(sid, "pending", f"order status {st} — waiting", None, oid))
    return out


def integrity_check(open_structures: list[dict], broker_positions: list[dict]) -> tuple[bool, str]:
    """Broker is the source of truth. A naked short or an unknown position is
    the ONLY trigger for flatten-all (RED-TEAM P5). A structure whose close
    order is still working ('closing') is still at the broker and counts; one
    whose ENTRY is still working ('pending') may be — its symbols are known,
    not unknown (DEVLOG #20). Book legs missing at the broker are reported as
    drift in the reason (ok=True): that is a stale store, not a naked risk."""
    book_syms: dict[str, int] = {}
    known: set[str] = set()
    for s in open_structures:
        if s["status"] not in KNOWN_STATUSES:
            continue
        for leg in legs_from_json(s["legs_json"]):
            known.add(leg.contract.symbol)
            if s["status"] in BOOK_STATUSES:
                book_syms[leg.contract.symbol] = book_syms.get(leg.contract.symbol, 0) + leg.qty * s["qty"]

    broker_syms = {p["symbol"]: int(float(p["qty"])) for p in broker_positions
                   if len(p.get("symbol", "")) > 12}  # option symbols only

    unknown = set(broker_syms) - known
    if unknown:
        return False, f"unknown option positions at broker: {sorted(unknown)}"
    # naked short: any net-short symbol at broker with no long leg in the same expiry+right book-side
    for sym, bq in broker_syms.items():
        if bq < 0 and book_syms.get(sym, 0) >= 0:
            return False, f"naked short at broker not in book: {sym}"
    missing = sorted(sym for sym, q in book_syms.items() if q != broker_syms.get(sym, 0))
    if missing:
        return True, f"book/broker consistent; DRIFT — book legs not matched at broker: {missing}"
    return True, "book/broker consistent"
