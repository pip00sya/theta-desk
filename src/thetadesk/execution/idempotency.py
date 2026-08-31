"""Deterministic client_order_id: a cron restart can never double an order.

id = sha256(day | structure_id | attempt)[:32]
Attempt counter lives in the store, so a *retry with a better price* gets a
new id while a *replayed tick* reuses the same one and is rejected by Alpaca
as a duplicate — which we treat as success-already-done.
"""
from __future__ import annotations

import hashlib

from ..state.store import Store


def client_order_id(structure_id: str, day: str, attempt: int) -> str:
    key = f"{day}|{structure_id}|{attempt}"
    return "td-" + hashlib.sha256(key.encode()).hexdigest()[:29]  # <=48 chars, prefixed


def next_attempt(store: Store, structure_id: str, day: str) -> int:
    key = f"attempt:{structure_id}"
    cur = int(float(store.get_kv(key, "0")))
    store.set_kv(key, str(cur + 1))
    return cur + 1
