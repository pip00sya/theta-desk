"""Shadow books — the live ablation (PLAN-MAX 1.1).

Three counterfactual books marked with the same model on the same inputs:
  shadow_nogates : every candidate the selector produced, gates ignored,
                   fills assumed at mid
  shadow_nohedge : the real book minus the hedge sleeve
  baseline_naive : "LLM reads a headline, buys an ATM option" — the control

Each tick, every book is marked (mark_to_model) and appended to `marks`, so
the dashboard draws four equity curves from one table. Nothing here ever
sends an order.
"""
from __future__ import annotations

import json
from datetime import datetime

from ..engine.contracts import Leg, OptionContract
from ..engine.payoff import mark_to_model
from ..manage.positions import legs_from_json
from ..state.store import Store

SHADOW_BOOKS = ("shadow_nogates", "shadow_nohedge", "baseline_naive")


def record_candidate(store: Store, book: str, structure_kind: str, sleeve: str,
                     legs: list[Leg], qty: int, net_credit: float,
                     structure_id: str = "") -> None:
    """Register a (virtual) fill at mid into a shadow book ledger (kv-based).
    Dedup by structure_id: a repeated tick must not double the shadow book."""
    key = f"shadow:{book}"
    ledger = json.loads(store.get_kv(key, "[]"))
    if structure_id and any(e.get("structure_id") == structure_id for e in ledger):
        return
    ledger.append({
        "structure_id": structure_id,
        "kind": structure_kind, "sleeve": sleeve, "qty": qty, "net_credit": net_credit,
        "legs": [{"symbol": l.contract.symbol, "qty": l.qty * qty, "entry_price": l.entry_price}
                 for l in legs],
    })
    store.set_kv(key, json.dumps(ledger))


def shadow_legs(store: Store, book: str, exclude_sleeve: str | None = None) -> list[Leg]:
    ledger = json.loads(store.get_kv(f"shadow:{book}", "[]"))
    legs: list[Leg] = []
    for entry in ledger:
        if exclude_sleeve and entry["sleeve"] == exclude_sleeve:
            continue
        for d in entry["legs"]:
            legs.append(Leg(OptionContract.parse(d["symbol"]), d["qty"], d["entry_price"]))
    return legs


def real_book_legs(store: Store, exclude_sleeve: str | None = None) -> list[Leg]:
    legs: list[Leg] = []
    for s in store.open_structures():
        if s["status"] != "open":
            continue
        if exclude_sleeve and s["sleeve"] == exclude_sleeve:
            continue
        for l in legs_from_json(s["legs_json"]):
            legs.append(Leg(l.contract, l.qty * s["qty"], l.entry_price))
    return legs


def mark_all_books(store: Store, spot: float, asof: datetime,
                   iv_map: dict[str, float], real_realized: float) -> dict[str, float]:
    out: dict[str, float] = {}

    real = mark_to_model(real_book_legs(store), spot, asof, iv_map)
    store.add_mark("real", None, real, real_realized)
    out["real"] = real + real_realized

    nogates = mark_to_model(shadow_legs(store, "shadow_nogates"), spot, asof, iv_map)
    store.add_mark("shadow_nogates", None, nogates, 0.0)
    out["shadow_nogates"] = nogates

    nohedge = mark_to_model(real_book_legs(store, exclude_sleeve="hedge"), spot, asof, iv_map)
    store.add_mark("shadow_nohedge", None, nohedge, real_realized)
    out["shadow_nohedge"] = nohedge + real_realized

    naive = mark_to_model(shadow_legs(store, "baseline_naive"), spot, asof, iv_map)
    store.add_mark("baseline_naive", None, naive, 0.0)
    out["baseline_naive"] = naive
    return out


def baseline_naive_tick(store: Store, chain: dict[str, dict], spot: float,
                        headlines: list[str], day: str) -> str | None:
    """The control agent: one ATM call if headlines lean positive, ATM put if
    negative, at most one position per day, held to horizon. Deliberately the
    median hackathon strategy — measured, not mocked."""
    if store.get_kv(f"naive_done:{day}"):
        return None
    text = " ".join(headlines).lower()
    neg = sum(w in text for w in ("fall", "drop", "fear", "cut", "risk", "war", "crash"))
    pos = sum(w in text for w in ("rally", "beat", "growth", "surge", "gain", "record"))
    right = "P" if neg > pos else "C"
    atm = None
    best = 1e9
    for sym, s in chain.items():
        try:
            c = OptionContract.parse(sym)
        except ValueError:
            continue
        if c.right != right:
            continue
        q = s.get("latestQuote") or {}
        bid, ask = float(q.get("bp") or 0), float(q.get("ap") or 0)
        if bid <= 0 or ask <= 0:
            continue
        if abs(c.strike - spot) < best:
            best, atm = abs(c.strike - spot), (c, 0.5 * (bid + ask))
    if not atm:
        return None
    c, mid = atm
    record_candidate(store, "baseline_naive", "naive_atm", "core",
                     [Leg(c, +1, mid)], 1, -mid)
    store.set_kv(f"naive_done:{day}", "1")
    return c.symbol
