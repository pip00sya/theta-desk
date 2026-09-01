"""THETA DESK entrypoint.

Commands:
  python -m thetadesk.main tick [--dry-run] [--mock]   one full decision cycle
  python -m thetadesk.main status                      book & marks summary
  python -m thetadesk.main verify-journal              hash-chain check

Tick pipeline (PLAN.md §4.3, patched by RED-TEAM.md):
  L1 data -> deterministic signals -> L2 desk (LLM roles, degraded-safe)
  -> management pass -> L3 selector -> L4..L5 gates (incl. payoff simulator)
  -> L6 executor (CLI-first) -> shadow marks -> journal everything.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone

from .safety import assert_paper_only
from . import config as cfgmod
from .agents.desk import run_desk
from .audit.journal import Journal
from .data import signals as sigmod
from .engine import selector as sel
from .engine.contracts import Leg, Structure
from .engine.gates import run_entry_gates
from .execution import cli_bridge, idempotency, mleg
from .manage.positions import (integrity_check, legs_from_json, reconcile_closing,
                               review_book, structure_mtm)
from .shadow import books as shadow
from .state.store import Store


SESSION_TZ_OFFSET = timedelta(hours=-4)   # New York, EDT — the whole window is DST


def _today() -> str:
    """The SESSION date (New York), not the host's local date. The host runs
    in UTC+5: its midnight is 19:00 UTC, an hour BEFORE the close, so daily
    counters, structure-id days and the idle-day realization policy all
    rolled over mid-session (DEVLOG #18)."""
    return (datetime.now(timezone.utc) + SESSION_TZ_OFFSET).date().isoformat()


def _clock_window(clock: dict) -> tuple[bool, float | None, float | None]:
    is_open = bool(clock.get("is_open"))
    try:
        now = datetime.fromisoformat(clock["timestamp"].replace("Z", "+00:00"))
        nxt_close = datetime.fromisoformat(clock["next_close"].replace("Z", "+00:00"))
        mins_to_close = (nxt_close - now).total_seconds() / 60 if is_open else None
    except Exception:
        return is_open, None, None
    # minutes from open unavailable without calendar lookup; approximate via close (6.5h session)
    mins_from_open = (390 - mins_to_close) if mins_to_close is not None else None
    return is_open, mins_from_open, mins_to_close


def make_client(mock: bool):
    if mock:
        from .data.mock_client import MockAlpacaClient
        return MockAlpacaClient()
    from .data.alpaca_client import AlpacaClient
    return AlpacaClient()


def cmd_tick(args) -> int:
    if not args.mock:
        assert_paper_only()
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    journal = Journal(cfg.journal_dir)
    client = make_client(args.mock)
    dry = bool(args.dry_run or args.mock)

    journal.append("tick_start", {"mock": args.mock, "dry_run": dry})

    # ---- L1: data --------------------------------------------------------
    account = client.account()
    equity = float(account.get("equity") or 0.0)
    clock = client.clock()
    is_open, mins_from_open, mins_to_close = _clock_window(clock)

    hwm = max(float(store.get_kv("high_watermark", "0") or 0), equity)
    store.set_kv("high_watermark", str(hwm))

    primary = cfg["universe"]["primary"]
    expiry = cfg["expiry"]["target_expiry"]
    chain = client.option_chain(primary, expiry)
    bars = client.stock_bars_daily(primary, days=cfg["regime"]["rv_lookback_days"] + 10)
    closes = [b["c"] for b in bars]
    q = client.latest_stock_quote(primary)
    spot = 0.5 * (float(q.get("bp") or 0) + float(q.get("ap") or 0)) or (closes[-1] if closes else 0.0)
    now = datetime.now(timezone.utc)

    # DEVLOG #16: the book may hold several underlyings — every one of them
    # needs its own chain (marks, management, gates) and its own spot.
    spot_map: dict[str, float] = {primary: spot}
    book_underlyings = set()
    for s in store.open_structures():
        for d in json.loads(s["legs_json"]):
            book_underlyings.add(d["symbol"][:next(i for i, ch in enumerate(d["symbol"]) if ch.isdigit())])
    for u in sorted(book_underlyings - {primary}):
        extra = client.option_chain(u, expiry)
        chain.update(extra)
        uq = client.latest_stock_quote(u)
        us = 0.5 * (float(uq.get("bp") or 0) + float(uq.get("ap") or 0))
        if us > 0:
            spot_map[u] = us

    entries = sel.parse_chain(chain)
    signals = sigmod.compute(entries, closes, spot, cfg["regime"]["rv_lookback_days"])
    iv_map = {sym: (s.get("impliedVolatility") or 0.20) for sym, s in chain.items()}

    # snapshot for replay — microsecond-unique name, referenced from the
    # journal so replay pairs input and decision exactly (DEVLOG #6)
    snap_path = cfg.snapshot_dir / f"{now:%Y%m%dT%H%M%S_%f}.json"
    snap_path.parent.mkdir(parents=True, exist_ok=True)
    snap_path.write_text(json.dumps({
        "ts": now.isoformat(), "spot": spot, "equity": equity,
        "signals": signals.to_dict(), "chain": chain, "closes": closes,
    }), encoding="utf-8")
    journal.append("signals", {**signals.to_dict(), "snapshot": snap_path.name})

    # ---- reconcile working close orders (DEVLOG #19) ---------------------
    # A close is CLOSED only when the broker says filled. Marking it closed on
    # acceptance left an unfilled sell at the broker and a book that no longer
    # knew about it -> integrity breach on every following tick.
    closing = [s for s in store.open_structures() if s["status"] == "closing"]
    if closing and not args.mock:
        pend = {s["structure_id"]: json.loads(store.get_kv(f"close_order:{s['structure_id']}", "{}"))
                for s in closing}
        for ra in reconcile_closing(closing, pend, client.order_by_client_id, now,
                                    cfg["timing"]["fill_wait_min"]):
            journal.append("close_reconcile", ra.__dict__)
            if ra.action == "closed":
                store.set_status(ra.structure_id, "closed", ra.pnl)
            elif ra.action == "cancel_revert":
                try:
                    client.cancel_order(ra.order_id)
                except Exception as e:  # leave it 'closing'; next tick retries
                    journal.append("close_cancel_failed", {"structure_id": ra.structure_id,
                                                           "error": str(e)[:300]})
                    continue
                store.set_status(ra.structure_id, "open")
            elif ra.action == "reverted":
                store.set_status(ra.structure_id, "open")

    # ---- integrity + management -----------------------------------------
    open_structs = store.open_structures()
    ok, why = integrity_check(open_structs, client.positions() if not args.mock else [])
    journal.append("integrity", {"ok": ok, "reason": why})
    if not ok:
        journal.append("flatten_all", {"reason": why})
        print(f"INTEGRITY BREACH: {why} — flatten required (manual confirm in paper)", file=sys.stderr)
        return 2

    entries_today = int(store.get_counter(_today(), "entries"))
    from .engine.gates import g17_event_derisk
    derisk = not g17_event_derisk(now, cfg.events(),
                                  cfg["events"]["derisk_hours_before"]).passed
    if derisk:
        journal.append("derisk_mode", {"reason": "high-class event inside window"})
    actions = review_book([s for s in open_structs if s["status"] == "open"], chain,
                          cfg["management"], now, entries_today, cfg.min_expiry,
                          derisk_mode=derisk,
                          derisk_lock_frac=cfg["events"].get("derisk_lock_profit_frac", 0.15))
    for a in actions:
        journal.append("manage", a.__dict__)
        if a.action == "close" and not dry:
            s = next(x for x in open_structs if x["structure_id"] == a.structure_id)
            legs = legs_from_json(s["legs_json"])
            st = Structure(s["structure_id"], s["kind"], s["sleeve"], legs, s["net_credit"])
            attempt = idempotency.next_attempt(store, s["structure_id"] + ":close", _today())
            coid = idempotency.client_order_id(s["structure_id"] + ":close", _today(), attempt)
            mid_now = structure_mtm(legs, chain)
            close_px = abs(s["net_credit"] - (mid_now or 0) / (100 * s["qty"]))
            if len(legs) == 1:
                l = legs[0]
                payload = mleg.single_leg_payload(
                    l.contract.symbol, abs(l.qty) * s["qty"],
                    "sell" if l.qty > 0 else "buy", close_px, coid,
                    "sell_to_close" if l.qty > 0 else "buy_to_close")
            else:
                payload = mleg.build_mleg_payload(st, s["qty"], close_px, coid, closing=True)
            res = cli_bridge.submit(payload, client, dry_run=dry)
            journal.append("order_close", {"structure_id": s["structure_id"],
                                           "transport": res.transport, "ok": res.ok,
                                           "error": res.error, "limit": round(close_px, 2)})
            if res.ok:
                # accepted != filled: park it as 'closing'; reconcile_closing
                # settles it against the broker on the next tick (DEVLOG #19)
                store.set_status(s["structure_id"], "closing")
                store.set_kv(f"close_order:{s['structure_id']}", json.dumps({
                    "client_order_id": coid, "est_pnl": a.est_pnl,
                    "ts": now.isoformat(), "order_id": (res.order or {}).get("id")}))
        elif a.action == "close" and dry:
            store.set_status(a.structure_id, "closed", a.est_pnl)

    # ---- selector + desk -------------------------------------------------
    exp_date = date.fromisoformat(expiry)
    cand = sel.select(entries, exp_date, signals.vrp, cfg["structures"], cfg["regime"], _today())

    # DEVLOG #16: second-underlying fallback. When the primary's candidate
    # fails the credit/liquidity floor (all-day NO_CANDIDATE in neutral
    # regime), try QQQ — richer IV often clears the same floor. The regime
    # score stays SPY-derived (indices are tightly correlated; stated in
    # the write-up), and every gate incl. the multi-underlying payoff grid
    # prices the combined book.
    if cand is None:
        for alt in [u for u in cfg.underlyings if u != primary][:1]:
            alt_chain = client.option_chain(alt, expiry)
            if not alt_chain:
                continue
            alt_q = client.latest_stock_quote(alt)
            alt_spot = 0.5 * (float(alt_q.get("bp") or 0) + float(alt_q.get("ap") or 0))
            if alt_spot <= 0:
                continue
            alt_entries = sel.parse_chain(alt_chain)
            cand = sel.select(alt_entries, exp_date, signals.vrp,
                              cfg["structures"], cfg["regime"], _today())
            if cand is not None:
                chain = {**chain, **alt_chain}
                iv_map.update({sym: (s.get("impliedVolatility") or 0.20)
                               for sym, s in alt_chain.items()})
                spot_map[alt] = alt_spot
                journal.append("alt_underlying", {"underlying": alt, "spot": alt_spot,
                                                  "kind": cand.structure.kind})
                break
            # The attempt itself is evidence: a silent miss made a whole day of
            # NO_CANDIDATE unexplainable (was the fallback even reached?).
            journal.append("alt_underlying_none", {"underlying": alt, "spot": alt_spot,
                                                   "contracts": len(alt_chain)})

    new_entry_made = False
    if cand is None:
        journal.append("no_candidate", {"vrp": signals.vrp,
                                        "reason": "selector produced nothing (credit/liquidity floor)"})
    else:
        headlines = [n.get("headline", "") for n in client.news(primary)]
        book_desc = f"{len([s for s in open_structs if s['status'] == 'open'])} open structures"
        cand_desc = (f"{cand.structure.kind} {[l.contract.symbol for l in cand.structure.legs]} "
                     f"credit {cand.structure.net_credit}")
        desk = run_desk(signals, headlines, cand_desc, book_desc, cfg)
        journal.append("desk", desk.to_dict())
        store.add_meeting("tick", desk.exchanges)

        # DEVLOG #9: dry-run structures live under status "dry_run" so a real
        # tick can supersede them — otherwise a rehearsal blocks the real entry.
        already = {s["structure_id"] for s in store.all_structures()
                   if s["status"] in ("open", "pending", "closed")}
        if cand.structure.structure_id in already:
            # Same-day identical candidate: the id is a hash of (day, kind,
            # legs). A repeated tick must NOT resubmit — this, not the
            # client_order_id, is the first line of idempotency (DEVLOG #4).
            journal.append("entry_skipped_duplicate",
                           {"structure_id": cand.structure.structure_id})
        elif desk.veto:
            journal.append("desk_veto", {"reason": desk.veto_reason})
        else:
            # sizing: risk budget -> qty
            per_struct_budget = equity * cfg["risk"]["per_structure_max_loss_frac"]
            unit_risk = cand.structure.max_loss  # per 1 unit
            qty = int(per_struct_budget * cand.size_mult * desk.size_mult // unit_risk) if unit_risk > 0 else 0
            # DEVLOG #7: minimum viable position — multipliers scale ABOVE one
            # contract, they cannot scale below it. One contract is allowed
            # whenever its risk fits the per-structure budget (gate #7 still
            # enforces the hard bound); otherwise cheap-regime micro entries
            # could never exist at all.
            if qty == 0 and 0 < unit_risk <= per_struct_budget:
                qty = 1
            if qty < 1:
                journal.append("size_zero", {"unit_risk": unit_risk,
                                             "budget": per_struct_budget,
                                             "mults": [cand.size_mult, desk.size_mult]})
            else:
                open_sleeve_debit = sum(
                    abs(s["net_credit"]) * 100 * s["qty"]
                    for s in store.open_structures()
                    if s["status"] in ("open", "closing") and s["net_credit"] < 0
                    and s["sleeve"] == "core")
                book_legs = shadow.real_book_legs(store)
                report = run_entry_gates(
                    structure=cand.structure, qty=qty, chain=chain,
                    book_legs=book_legs, spot=spot_map, asof=now, equity=equity,
                    high_watermark=hwm, realized_gains=store.realized_gains(),
                    new_risk_today=store.get_counter(_today(), "new_risk"),
                    cfg=cfg, minutes_from_open=mins_from_open,
                    minutes_to_close=mins_to_close, market_open=is_open,
                    open_sleeve_debit=open_sleeve_debit,
                )
                journal.append("gates", {"structure_id": cand.structure.structure_id,
                                         "kind": cand.structure.kind, "qty": qty,
                                         **report.to_dict()})
                # shadow_nogates records every candidate regardless of the verdict
                shadow.record_candidate(store, "shadow_nogates", cand.structure.kind,
                                        cand.structure.sleeve, cand.structure.legs, qty,
                                        cand.structure.net_credit,
                                        structure_id=cand.structure.structure_id)
                if not report.passed:
                    store.add_counter(_today(), "gate_rejections", 1)
                    ff = report.first_failure
                    journal.append("entry_refused", {"gate": ff.gate, "reason": ff.reason})
                else:
                    attempt = idempotency.next_attempt(store, cand.structure.structure_id, _today())
                    coid = idempotency.client_order_id(cand.structure.structure_id, _today(), attempt)
                    limit_px = cand.structure.net_credit  # start at mid-credit
                    payload = mleg.build_mleg_payload(cand.structure, qty, limit_px, coid) \
                        if len(cand.structure.legs) > 1 else \
                        mleg.single_leg_payload(cand.structure.legs[0].contract.symbol, qty,
                                                "buy", cand.structure.legs[0].entry_price, coid,
                                                "buy_to_open")
                    res = cli_bridge.submit(payload, client, dry_run=dry)
                    journal.append("order_open", {"structure_id": cand.structure.structure_id,
                                                  "transport": res.transport, "ok": res.ok,
                                                  "duplicate": res.duplicate, "error": res.error,
                                                  "payload": payload})
                    if res.ok:
                        new_entry_made = True
                        store.upsert_structure(
                            cand.structure.structure_id, cand.structure.kind,
                            cand.structure.sleeve, qty,
                            json.dumps([{"symbol": l.contract.symbol, "qty": l.qty,
                                         "entry_price": l.entry_price}
                                        for l in cand.structure.legs]),
                            cand.structure.net_credit, cand.structure.max_loss,
                            "dry_run" if dry else "open",
                            order_id=(res.order or {}).get("id"), client_order_id=coid)
                        store.add_counter(_today(), "entries", 1)
                        store.add_counter(_today(), "new_risk", unit_risk * qty)

    # ---- hedge sleeve ----------------------------------------------------
    open_after = store.open_structures()
    has_hedge = any(s["sleeve"] == "hedge" and s["status"] == "open" for s in open_after)
    core_open = [s for s in open_after if s["sleeve"] == "core" and s["status"] == "open"]
    if core_open and not has_hedge:
        h = sel.build_hedge_put(entries, exp_date, cfg["structures"]["hedge"], _today())
        if h:
            # DEVLOG #5: hedge is financed by Core theta — its budget scales
            # with collected core credits (30%), capped at 0.6% of equity.
            # A flat equity fraction oversized the hedge 10x vs a 1-condor book.
            core_credit = sum(s["net_credit"] * 100 * s["qty"]
                              for s in core_open if s["net_credit"] > 0)
            budget = min(equity * cfg["structures"]["hedge"]["budget_frac_equity"],
                         0.30 * core_credit)
            unit_cost = abs(h.net_credit) * 100
            hqty = int(budget // unit_cost) if unit_cost > 0 else 0
            if hqty >= 1:
                attempt = idempotency.next_attempt(store, h.structure_id, _today())
                coid = idempotency.client_order_id(h.structure_id, _today(), attempt)
                payload = mleg.single_leg_payload(h.legs[0].contract.symbol, hqty, "buy",
                                                  h.legs[0].entry_price, coid, "buy_to_open")
                res = cli_bridge.submit(payload, client, dry_run=dry)
                journal.append("order_hedge", {"structure_id": h.structure_id,
                                               "transport": res.transport, "ok": res.ok})
                if res.ok:
                    store.upsert_structure(
                        h.structure_id, h.kind, "hedge", hqty,
                        json.dumps([{"symbol": h.legs[0].contract.symbol, "qty": 1,
                                     "entry_price": h.legs[0].entry_price}]),
                        h.net_credit, h.max_loss, "open", client_order_id=coid)

    # ---- shadow marks + baseline ----------------------------------------
    headlines = [n.get("headline", "") for n in client.news(primary)]
    naive = shadow.baseline_naive_tick(store, chain, spot, headlines, _today())
    if naive:
        journal.append("baseline_naive_entry", {"symbol": naive})
    marks = shadow.mark_all_books(store, spot_map, now, iv_map, store.realized_gains(),
                                  broker_equity=equity, chain=chain)
    journal.append("marks", marks)

    journal.append("tick_end", {"entry_made": new_entry_made})
    print(json.dumps({"signals": signals.to_dict(), "marks": marks,
                      "entry_made": new_entry_made}, indent=2))
    return 0


def cmd_status(args) -> int:
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    structs = store.all_structures()
    print(f"structures: {len(structs)}")
    for s in structs:
        print(f"  [{s['status']:>8}] {s['kind']:<18} x{s['qty']} sleeve={s['sleeve']} "
              f"credit={s['net_credit']:.2f} maxloss=${s['max_loss']:,.0f}")
    for book in ("real",) + shadow.SHADOW_BOOKS:
        m = store.marks(book)
        if m:
            last = m[-1]
            print(f"{book:<16} unrealized={last['unrealized']:>10.2f} realized={last['realized']:>10.2f}")
    print(f"realized gains: {store.realized_gains():.2f}")
    return 0


def cmd_verify_journal(args) -> int:
    cfg = cfgmod.load()
    j = Journal(cfg.journal_dir)
    ok, msg = j.verify_chain()
    print(("OK: " if ok else "FAIL: ") + msg + f" ({len(j.read_all())} entries)")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="thetadesk")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("tick")
    t.add_argument("--dry-run", action="store_true")
    t.add_argument("--mock", action="store_true", help="offline synthetic market")
    sub.add_parser("status")
    sub.add_parser("verify-journal")
    args = p.parse_args(argv)
    return {"tick": cmd_tick, "status": cmd_status,
            "verify-journal": cmd_verify_journal}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
