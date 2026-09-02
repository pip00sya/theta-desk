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
import os
import sys
import traceback
from datetime import date, datetime, timedelta, timezone

from .safety import assert_paper_only
from . import config as cfgmod
from .agents.desk import run_desk, veto_applies
from .audit import alerts
from .audit.journal import Journal
from .data import signals as sigmod
from .engine import selector as sel
from .engine.contracts import Leg, OptionContract, Structure
from .engine.gates import run_entry_gates
from .engine.liquidity import check_quote
from .execution import cli_bridge, idempotency, mleg
from .manage.positions import (apply_fills, integrity_check, legs_from_json,
                               reconcile_closing, reconcile_pending, review_book,
                               structure_close_price)
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


def _alert_on_change(store: Store, key: str, condition: bool, level: str, title: str,
                     text: str, journal: Journal) -> None:
    """Alert when a condition becomes true, not on every tick it stays true."""
    was = store.get_kv(f"alert_state:{key}", "") == "1"
    if condition and not was:
        alerts.alert(level, title, text, journal=journal)
    store.set_kv(f"alert_state:{key}", "1" if condition else "")


def make_client(mock: bool):
    if mock:
        from .data.mock_client import MockAlpacaClient
        return MockAlpacaClient()
    from .data.alpaca_client import AlpacaClient
    return AlpacaClient()


def _underlying_of(symbol: str) -> str:
    return symbol[:next(i for i, ch in enumerate(symbol) if ch.isdigit())]


def _adopt_unknown_longs(store: Store, broker_positions: list[dict], known: set[str],
                         journal: Journal) -> list[str]:
    """DEVLOG #28: an option position the store does not know about used to
    halt the desk forever (exit 2 every tick until a human edited the store).
    A LONG option is bounded risk (the debit): adopt it as its own structure
    so the existing exits (+60% target, time stop, event lock) manage it and
    the marks include it. A naked SHORT is still a halt — nothing here trades."""
    adopted = []
    for p in broker_positions:
        sym = p.get("symbol", "")
        if len(sym) <= 12 or sym in known:
            continue
        qty = int(float(p.get("qty") or 0))
        if qty <= 0:
            continue
        px = float(p.get("avg_entry_price") or 0.0)
        sid = "adopt-" + sym.lower()
        store.upsert_structure(sid, "adopted_long", "core", qty,
                               json.dumps([{"symbol": sym, "qty": 1, "entry_price": px}]),
                               -px, px * 100, "open")
        journal.append("adopted_position", {"structure_id": sid, "symbol": sym, "qty": qty,
                                            "avg_entry_price": px})
        adopted.append(sym)
    return adopted


def cmd_tick(args) -> int:
    if not args.mock:
        assert_paper_only()
    cfg = cfgmod.load()
    dry = bool(args.dry_run or args.mock)
    rehearsal = bool(args.dry_run and not args.mock)
    if rehearsal and not os.environ.get("THETADESK_DATA_DIR"):
        # DEVLOG #28: a rehearsal on the LIVE store closed real structures with
        # an estimate and bumped the live counters. Point it at a scratch copy.
        print("refusing --dry-run on the live data dir: set THETADESK_DATA_DIR=<scratch dir> "
              "(or use --mock)", file=sys.stderr)
        return 3
    store = Store(cfg.db_path)
    journal = Journal(cfg.journal_dir)
    client = make_client(args.mock)

    journal.append("tick_start", {"mock": args.mock, "dry_run": dry})

    # ---- L1: account + clock ---------------------------------------------
    account = client.account()
    equity = float(account.get("equity") or 0.0)
    clock = client.clock()
    is_open, mins_from_open, mins_to_close = _clock_window(clock)
    now = datetime.now(timezone.utc)
    lookback = cfg["regime"]["rv_lookback_days"]
    fill_wait = cfg["timing"]["fill_wait_min"]

    hwm = max(float(store.get_kv("high_watermark", "0") or 0), equity)
    store.set_kv("high_watermark", str(hwm))

    def release_new_risk(s: dict) -> None:
        """DEVLOG #29c: gate #9 counts new risk when the ORDER IS SENT, which
        is right while it is working (it may fill), but the count was never
        given back when the broker confirmed it never filled. Live on Sep 2:
        $2,425 of a $2,521 daily budget consumed by three condors of which
        exactly one existed — the desk had locked itself out of the session
        over risk it was not carrying."""
        try:
            day = (datetime.fromisoformat(s.get("opened_utc") or "")
                   + SESSION_TZ_OFFSET).date().isoformat()
        except ValueError:
            return
        if day != _today():
            return                      # yesterday's order, yesterday's budget
        risk = float(s.get("max_loss") or 0.0)
        if risk <= 0:
            return
        store.add_counter(_today(), "new_risk", -risk)
        journal.append("new_risk_released", {"structure_id": s["structure_id"], "risk": risk,
                                             "reason": "entry order never filled"})

    def reconcile_working() -> None:
        # ---- reconcile working close orders (DEVLOG #19) -----------------
        # A close is CLOSED only when the broker says filled. Marking it
        # closed on acceptance left an unfilled sell at the broker and a book
        # that no longer knew about it -> integrity breach every tick.
        closing = [s for s in store.open_structures() if s["status"] == "closing"]
        if closing and not args.mock:
            pend = {s["structure_id"]: json.loads(store.get_kv(f"close_order:{s['structure_id']}", "{}"))
                    for s in closing}
            for ra in reconcile_closing(closing, pend, client.order_by_client_id, now, fill_wait):
                journal.append("close_reconcile", ra.__dict__)
                if ra.action == "closed":
                    store.set_status(ra.structure_id, "closed", ra.pnl)
                    store.set_kv(f"close_missed:{ra.structure_id}", "")
                    # the operator's phone should learn about money, not only
                    # about failures; not journaled (the fill already is)
                    s = next((x for x in closing if x["structure_id"] == ra.structure_id), {})
                    alerts.alert("INFO", "позиция закрыта",
                                 f"{s.get('kind', '?')} {ra.structure_id[:8]}: "
                                 f"{(ra.pnl or 0):+,.0f}$ | всего зафиксировано "
                                 f"{store.realized_gains():+,.0f}$", journal=None)
                elif ra.action == "cancel_revert":
                    # DEVLOG #28: the DELETE is asynchronous (the live trace
                    # showed 1.1 s in pending_cancel) and the order can still
                    # fill inside that window. Nothing is written here: the
                    # next tick reads the terminal state (filled -> closed at
                    # the real fill, canceled -> reverted).
                    try:
                        client.cancel_order(ra.order_id)
                        journal.append("close_cancel_sent", {"structure_id": ra.structure_id,
                                                             "order_id": ra.order_id})
                    except Exception as e:  # leave it 'closing'; next tick retries
                        journal.append("close_cancel_failed", {"structure_id": ra.structure_id,
                                                               "error": str(e)[:300]})
                elif ra.action == "reverted":
                    store.set_status(ra.structure_id, "open")
                    # DEVLOG #27/#28: the NEXT close of this structure in the
                    # same session crosses the spread; a fresh decision on a
                    # later day goes back to the mid (the raw attempt counter
                    # never reset, so every later close hit the bid).
                    store.set_kv(f"close_missed:{ra.structure_id}", _today())

        # ---- reconcile working ENTRY orders (DEVLOG #20) -----------------
        # The twin of the block above: an entry is OPEN only when the broker
        # says filled, and its legs are repriced to the real fills. Rows in
        # 'submitting' (written before the broker call) are resolved here too.
        pending = [s for s in store.open_structures() if s["status"] in ("pending", "submitting")]
        if pending and not args.mock:
            po_map = {s["structure_id"]: json.loads(store.get_kv(f"open_order:{s['structure_id']}", "{}"))
                      for s in pending}
            for ra in reconcile_pending(pending, po_map, client.order_by_client_id, now, fill_wait):
                journal.append("open_reconcile", ra.__dict__)
                s = next(x for x in pending if x["structure_id"] == ra.structure_id)
                if ra.action == "filled":
                    net = ra.net_credit if ra.net_credit is not None else s["net_credit"]
                    store.set_fills(ra.structure_id, apply_fills(s["legs_json"], ra.fills or {}),
                                    net, "open")
                    if ra.filled_qty and ra.filled_qty != s["qty"]:
                        store.set_qty(ra.structure_id, ra.filled_qty)
                        alerts.alert("WARN", "partial fill adopted",
                                     f"{s['kind']} {ra.structure_id}: {ra.filled_qty} of {s['qty']}",
                                     journal=journal)
                    # post-fill sanity: a fill far from the intended price means
                    # the order meant something else (DEVLOG #12 would have tripped this)
                    intended = s["net_credit"]
                    if intended and abs(net - intended) > 0.30 * abs(intended):
                        alerts.alert("WARN", "fill anomaly",
                                     f"{s['kind']} {ra.structure_id}: intended {intended}, got {net}",
                                     journal=journal)
                    side = "продали премию" if net > 0 else "купили премию"
                    alerts.alert("INFO", "позиция открыта",
                                 f"{s['kind']} x{s['qty']}: {side} за "
                                 f"{abs(net) * 100 * s['qty']:,.0f}$, риск до "
                                 f"{s['max_loss']:,.0f}$", journal=None)
                elif ra.action == "cancel_unfilled":
                    try:
                        client.cancel_order(ra.order_id)
                        journal.append("open_cancel_sent", {"structure_id": ra.structure_id,
                                                            "order_id": ra.order_id})
                    except Exception as e:  # stays 'pending'; next tick retries
                        journal.append("open_cancel_failed", {"structure_id": ra.structure_id,
                                                              "error": str(e)[:300]})
                    # Status untouched on purpose (DEVLOG #28b): the DELETE is
                    # asynchronous and the order can still fill inside the
                    # cancel window, so the terminal state is read from the
                    # broker next tick — which is also where the daily risk
                    # budget is given back (DEVLOG #29c).
                elif ra.action == "unfilled":
                    store.set_status(ra.structure_id, "unfilled")
                    release_new_risk(s)

    def submit_write_ahead(sid: str, kind: str, sleeve: str, qty: int, legs_json: str,
                           net_credit: float, max_loss: float, payload: dict, coid: str,
                           jkind: str, extra: dict | None = None):
        """DEVLOG #28: the row and the kv record exist BEFORE the broker call,
        so a crash or an ambiguous transport failure can never orphan an
        accepted order; an ambiguous failure is resolved by client_order_id."""
        dry_status = "open" if (args.mock and sleeve == "hedge") else "dry_run"
        if not dry:
            store.upsert_structure(sid, kind, sleeve, qty, legs_json, net_credit, max_loss,
                                   "submitting", client_order_id=coid)
            store.set_kv(f"open_order:{sid}", json.dumps({
                "client_order_id": coid, "ts": now.isoformat(), "order_id": None,
                "intended": net_credit}))
        res = cli_bridge.submit(payload, client, dry_run=dry)
        journal.append(jkind, {"structure_id": sid, "transport": res.transport, "ok": res.ok,
                               "duplicate": res.duplicate, "ambiguous": res.ambiguous,
                               "error": res.error, "payload": payload, **(extra or {})})
        if dry:
            store.upsert_structure(sid, kind, sleeve, qty, legs_json, net_credit, max_loss,
                                   dry_status, order_id=(res.order or {}).get("id"),
                                   client_order_id=coid)
            return res
        order = res.order if res.ok else None
        if not res.ok:
            found = None
            try:
                found = client.order_by_client_id(coid)
            except Exception as e:
                journal.append("order_lookup_failed", {"structure_id": sid, "error": str(e)[:200]})
            if found:
                journal.append("order_recovered_by_client_id", {"structure_id": sid,
                                                                 "order_id": found.get("id"),
                                                                 "status": found.get("status")})
                res.ok, order = True, found
        if res.ok:
            store.upsert_structure(sid, kind, sleeve, qty, legs_json, net_credit, max_loss,
                                   "pending", order_id=(order or {}).get("id"), client_order_id=coid)
            store.set_kv(f"open_order:{sid}", json.dumps({
                "client_order_id": coid, "ts": now.isoformat(),
                "order_id": (order or {}).get("id"), "intended": net_credit}))
        else:
            store.set_status(sid, "unfilled")
            journal.append("order_not_at_broker", {"structure_id": sid, "error": res.error[:200]})
        return res

    def check_integrity() -> tuple[bool, str]:
        # ---- integrity: the broker is the source of truth --------------
        positions = client.positions() if not args.mock else []
        open_structs = store.open_structures()
        ok, why = integrity_check(open_structs, positions)
        if not ok and why.startswith("unknown option positions"):
            known = {d["symbol"] for s in open_structs for d in json.loads(s["legs_json"])}
            adopted = _adopt_unknown_longs(store, positions, known, journal)
            if adopted:
                alerts.alert("WARN", "adopted unknown long positions", ", ".join(adopted),
                             journal=journal)
                ok, why = integrity_check(store.open_structures(), positions)
        journal.append("integrity", {"ok": ok, "reason": why})
        _alert_on_change(store, "integrity", not ok, "CRITICAL",
                         "integrity breach — new risk halted", why, journal)
        _alert_on_change(store, "drift", ok and "DRIFT" in why, "WARN", "book/broker drift",
                         why, journal)
        return ok, why

    # ---- market closed: settle working orders, check the book, stop ------
    # DEVLOG #28: the scheduler fires 30 min past the close and all day on
    # exchange holidays; those ticks priced the book off a one-sided
    # after-hours quote (spot = ask/2) and submitted closes into a closed
    # market. Nothing is priced, marked or decided while the exchange is shut.
    if not is_open:
        reconcile_working()
        ok, why = check_integrity()
        journal.append("market_closed", {"next_open": clock.get("next_open"), "integrity_ok": ok})
        store.set_kv("last_tick_ts", now.isoformat())
        store.set_kv("last_tick_mode", "market_closed")
        print(json.dumps({"market_closed": True, "next_open": clock.get("next_open")}))
        return 0

    # ---- L1: market data + data-quality gate ------------------------------
    primary = cfg["universe"]["primary"]
    expiry = cfg["expiry"]["target_expiry"]
    # DEVLOG #28: post-submission roll. From roll_after new entries target
    # roll_target; every expiry already in the book keeps being fetched so
    # open Sep 18 legs stay markable and managed after the target moves.
    ex_cfg = cfg["expiry"]
    if ex_cfg.get("roll_after") and ex_cfg.get("roll_target") and _today() >= ex_cfg["roll_after"]:
        expiry = ex_cfg["roll_target"]
    book_expiries = {OptionContract.parse(d["symbol"]).expiry.isoformat()
                     for s in store.open_structures() for d in json.loads(s["legs_json"])}
    fetch_expiries = sorted({expiry} | book_expiries)
    if expiry != cfg["expiry"]["target_expiry"]:
        journal.append("expiry_roll", {"target": expiry, "book_expiries": sorted(book_expiries)})

    def chains_for(u: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for e in fetch_expiries:
            out.update(client.option_chain(u, e))
        return out

    chain = chains_for(primary)
    bars = client.stock_bars_daily(primary, days=lookback + 10, exclude_date=_today())
    closes = [b["c"] for b in bars]
    q = client.latest_stock_quote(primary)
    dq = sigmod.assess(q, closes, bars, _today(), lookback)
    spot = dq.spot
    if dq.reasons:
        journal.append("data_quality", dq.to_dict())
    if dq.mode == "skip":
        reconcile_working()
        check_integrity()
        alerts.alert("WARN", "tick skipped: market data failed the quality gate",
                     "; ".join(dq.reasons)[:400], journal=journal)
        store.set_kv("last_tick_ts", now.isoformat())
        store.set_kv("last_tick_mode", "skip")
        print(json.dumps({"skipped": True, "data_quality": dq.to_dict()}))
        return 0

    # DEVLOG #16: the book may hold several underlyings — every one of them
    # needs its own chain (marks, management, gates) and its own spot.
    spot_map: dict[str, float] = {primary: spot}
    book_underlyings = set()
    for s in store.open_structures():
        for d in json.loads(s["legs_json"]):
            book_underlyings.add(_underlying_of(d["symbol"]))
    # DEVLOG #29: the SHADOW books can hold an underlying the real book does
    # not — shadow_nogates records every candidate, including the QQQ condor
    # the gates refused on 2026-09-02. Marking it needs QQQ's spot, and its
    # absence crashed the tick after the order had already been sent.
    for b in shadow.SHADOW_BOOKS:
        for l in shadow.shadow_legs(store, b):
            book_underlyings.add(l.contract.underlying)
    extra_chains: dict[str, dict] = {}
    for u in sorted(book_underlyings - {primary}):
        extra_chains[u] = chains_for(u)
        uq = client.latest_stock_quote(u)
        ub = client.stock_bars_daily(u, days=5, exclude_date=_today())
        udq = sigmod.assess(uq, [b["c"] for b in ub], ub, _today(), lookback=1)
        if udq.spot > 0 and udq.mode != "skip":
            spot_map[u] = udq.spot
            if udq.reasons:
                journal.append("data_quality", {"underlying": u, **udq.to_dict()})
        else:
            journal.append("data_quality", {"underlying": u, **udq.to_dict()})

    # DEVLOG #28: signals and the selector see ONLY the primary's chain — the
    # merged chain (needed for marks/management of QQQ legs) polluted the
    # nearest-the-money strip and the candidate pool with foreign strikes.
    entries = sel.parse_chain(chain)
    # the ATM strip for the regime signal comes from the TARGET expiry only —
    # with two expiries in the chain the nearest strikes would mix term months
    sig_entries = [e for e in entries if e.expiry.isoformat() == expiry] or entries
    signals = sigmod.compute(sig_entries, closes, spot, lookback)
    iv_reason = sigmod.check_iv(signals)
    if iv_reason:
        dq.mode = "mark_only"
        dq.reasons.append(iv_reason)
        journal.append("data_quality", dq.to_dict())
    for extra in extra_chains.values():
        chain.update(extra)
    iv_map = {sym: (s.get("impliedVolatility") or 0.20) for sym, s in chain.items()}

    # snapshot for replay — microsecond-unique name, referenced from the
    # journal so replay pairs input and decision exactly (DEVLOG #6)
    snap_path = cfg.snapshot_dir / f"{now:%Y%m%dT%H%M%S_%f}.json"
    snap_path.parent.mkdir(parents=True, exist_ok=True)
    snap_path.write_text(json.dumps({
        "ts": now.isoformat(), "spot": spot, "equity": equity,
        "signals": signals.to_dict(), "chain": chain, "closes": closes,
        "data_quality": dq.to_dict(),
    }), encoding="utf-8")
    journal.append("signals", {**signals.to_dict(), "snapshot": snap_path.name,
                               "data_quality": dq.mode, "expiry": expiry})

    reconcile_working()

    # ---- integrity + management -----------------------------------------
    ok, why = check_integrity()
    if not ok:
        # A naked short (or an unknown position that could not be adopted):
        # no NEW risk, but the known book is still managed and marked
        # (DEVLOG #28 — before this the tick aborted here, forever).
        journal.append("integrity_halt", {"reason": why})
        print(f"INTEGRITY BREACH: {why} — new risk halted (manual action required)", file=sys.stderr)
    halt_new_risk = (not ok) or dq.mode != "full"
    open_structs = store.open_structures()

    entries_today = int(store.get_counter(_today(), "entries"))
    from .engine.gates import g17_event_derisk
    derisk = not g17_event_derisk(now, cfg.events(),
                                  cfg["events"]["derisk_hours_before"]).passed
    if derisk:
        journal.append("derisk_mode", {"reason": "high-class event inside window"})
    # DEVLOG #30: the manager knows the regime (only from a clean tick — a
    # mark-only tick must never close positions on a suspect signal) and
    # remembers each structure's best mark for the trailing stop.
    R = cfg["regime"]
    regime = ("rich" if signals.vrp >= R["vrp_rich_threshold"]
              else "cheap" if signals.vrp < R["vrp_cheap_threshold"] else "neutral")
    live_open = [s for s in open_structs if s["status"] == "open"]
    peaks = {s["structure_id"]: float(store.get_kv(f"peak_frac:{s['structure_id']}", "0") or 0)
             for s in live_open}
    actions = review_book(live_open, chain,
                          cfg["management"], now, entries_today, cfg.min_expiry,
                          derisk_mode=derisk,
                          derisk_lock_frac=cfg["events"].get("derisk_lock_profit_frac", 0.15),
                          minutes_to_close=mins_to_close,
                          realize_window_min=cfg["management"].get("realize_window_min", 60),
                          regime=regime if dq.mode == "full" else None,
                          peaks=peaks)
    for sid, pk in peaks.items():
        store.set_kv(f"peak_frac:{sid}", f"{pk:.4f}")
    close_buffer_min = 5   # a close sent in the last minutes rests overnight (DEVLOG #28)
    for a in actions:
        journal.append("manage", a.__dict__)
        if a.action == "close" and not dry and mins_to_close is not None and mins_to_close < close_buffer_min:
            journal.append("close_deferred", {"structure_id": a.structure_id,
                                              "reason": f"{mins_to_close:.0f}m to close"})
        elif a.action == "close" and not dry:
            s = next(x for x in open_structs if x["structure_id"] == a.structure_id)
            legs = legs_from_json(s["legs_json"])
            st = Structure(s["structure_id"], s["kind"], s["sleeve"], legs, s["net_credit"])
            attempt = idempotency.next_attempt(store, s["structure_id"] + ":close", _today())
            coid = idempotency.client_order_id(s["structure_id"] + ":close", _today(), attempt)
            # first try at the mid; a resubmission after an unfilled close IN
            # THE SAME SESSION takes the market (DEVLOG #27) — we want OUT,
            # not a better print. Keyed by session, not by the raw counter.
            cross = store.get_kv(f"close_missed:{s['structure_id']}", "") == _today()
            pkg = structure_close_price(legs, chain, cross=cross)
            if pkg is None:
                journal.append("close_skipped_unquoted", {"structure_id": s["structure_id"]})
                continue
            close_px = abs(pkg)
            if cross:
                journal.append("close_cross_spread", {"structure_id": s["structure_id"],
                                                      "attempt": attempt, "limit": round(close_px, 2)})
            if len(legs) == 1:
                l = legs[0]
                payload = mleg.single_leg_payload(
                    l.contract.symbol, abs(l.qty) * s["qty"],
                    "sell" if l.qty > 0 else "buy", close_px, coid,
                    "sell_to_close" if l.qty > 0 else "buy_to_close")
            else:
                payload = mleg.build_mleg_payload(st, s["qty"], close_px, coid, closing=True)
            # DEVLOG #28: write-ahead. 'closing' + the close order id are on
            # the row BEFORE the broker call; an ambiguous failure is resolved
            # by client_order_id, a definitive one reverts to 'open'.
            store.mark_closing(s["structure_id"], coid)
            store.set_kv(f"close_order:{s['structure_id']}", json.dumps({
                "client_order_id": coid, "est_pnl": a.est_pnl,
                "ts": now.isoformat(), "order_id": None}))
            res = cli_bridge.submit(payload, client, dry_run=dry)
            journal.append("order_close", {"structure_id": s["structure_id"],
                                           "transport": res.transport, "ok": res.ok,
                                           "ambiguous": res.ambiguous,
                                           "error": res.error, "limit": round(close_px, 2)})
            order = res.order if res.ok else None
            if not res.ok:
                found = None
                try:
                    found = client.order_by_client_id(coid)
                except Exception as e:
                    journal.append("order_lookup_failed", {"structure_id": s["structure_id"],
                                                           "error": str(e)[:200]})
                if found:
                    journal.append("order_recovered_by_client_id", {
                        "structure_id": s["structure_id"], "order_id": found.get("id"),
                        "status": found.get("status")})
                    res.ok, order = True, found
            if res.ok:
                # accepted != filled: stays 'closing'; reconcile_closing
                # settles it against the broker on the next tick (DEVLOG #19)
                store.set_kv(f"close_order:{s['structure_id']}", json.dumps({
                    "client_order_id": coid, "est_pnl": a.est_pnl,
                    "ts": now.isoformat(), "order_id": (order or {}).get("id")}))
            else:
                store.set_status(s["structure_id"], "open")
                journal.append("close_not_at_broker", {"structure_id": s["structure_id"],
                                                       "error": res.error[:200]})
                alerts.alert("WARN", "close order failed",
                             f"{s['kind']} {s['structure_id']}: {res.error[:200]}", journal=journal)
        elif a.action == "close" and dry and args.mock:
            # the offline demo realizes P&L so the ablation books have exits
            store.set_status(a.structure_id, "closed", a.est_pnl)
        elif a.action == "close" and dry:
            journal.append("manage_dry_close", {"structure_id": a.structure_id, "est_pnl": a.est_pnl})

    # ---- selector + desk -------------------------------------------------
    exp_date = date.fromisoformat(expiry)
    if halt_new_risk:
        journal.append("entries_disabled", {"integrity_ok": ok, "data_quality": dq.mode,
                                            "reasons": dq.reasons})
        cand = None
    else:
        # DEVLOG #16 + #31: search the whole universe, LEAST-EXPOSED underlying
        # first. Trying the primary first stacked two near-identical SPY condors
        # on 2026-09-02 (741/731/782/792 and 742/732/783/793) — one bet at double
        # size, both broken by the same SPY move. Spreading the same risk budget
        # across SPY/QQQ/IWM is diversification for free: the daily budget, the
        # per-structure loss cap and the credit floor are all unchanged.
        # The regime score stays primary-derived (indices are tightly correlated;
        # stated in the write-up), and every gate incl. the multi-underlying
        # payoff grid prices the combined book.
        neutral_mult = float(cfg.raw.get("sizing", {}).get("neutral_regime_mult", 0.5))
        held: dict[str, int] = {}
        # all_structures, not open_structs: a --dry-run book never leaves
        # 'dry_run' status, and the demo has to show the same rotation the
        # live desk performs (live has no dry_run rows, so this is identical)
        for st in store.all_structures():
            if (st["status"] not in ("open", "pending", "submitting", "closing", "dry_run")
                    or st.get("sleeve", "core") != "core"):
                continue          # the hedge is an offset, not exposure to spread
            for u in {_underlying_of(d["symbol"]) for d in json.loads(st["legs_json"])}:
                held[u] = held.get(u, 0) + 1
        order = sorted(cfg.underlyings,
                       key=lambda u: (held.get(u, 0), 0 if u == primary else 1, u))
        journal.append("underlying_order", {"order": order, "held": held})
        cand = None
        for u in order:
            if u == primary:
                u_entries, u_chain = entries, None
            else:
                # DEVLOG #29b's rule, applied to the wider search: a single bad
                # symbol must not cost the whole tick. The rotation reaches more
                # underlyings than the old single fallback did, so one flaky
                # chain would otherwise take the book's management with it.
                try:
                    u_chain = client.option_chain(u, expiry)
                    if not u_chain:
                        continue
                    uq = client.latest_stock_quote(u)
                except Exception as exc:                      # noqa: BLE001
                    journal.append("alt_underlying_none",
                                   {"underlying": u, "reason": f"{type(exc).__name__}: {exc}"[:120]})
                    continue
                u_spot = 0.5 * (float(uq.get("bp") or 0) + float(uq.get("ap") or 0))
                if not (float(uq.get("bp") or 0) > 0 and float(uq.get("ap") or 0) > 0):
                    journal.append("alt_underlying_none", {"underlying": u, "spot": u_spot,
                                                           "reason": "one-sided stock quote"})
                    continue
                u_entries = sel.parse_chain(u_chain)
            cand = sel.select(u_entries, exp_date, signals.vrp, cfg["structures"],
                              cfg["regime"], _today(), neutral_mult=neutral_mult)
            if cand is None:
                # The attempt itself is evidence: a silent miss made a whole day
                # of NO_CANDIDATE unexplainable (was the fallback even reached?).
                journal.append("alt_underlying_none", {"underlying": u,
                                                       "contracts": len(u_chain or chain)})
                continue
            if u != primary:
                chain = {**chain, **u_chain}
                iv_map.update({sym: (sn.get("impliedVolatility") or 0.20)
                               for sym, sn in u_chain.items()})
                spot_map[u] = u_spot
                journal.append("alt_underlying", {"underlying": u, "spot": u_spot,
                                                  "kind": cand.structure.kind})
            break

    new_entry_made = False
    headlines = [n.get("headline", "") for n in client.news(primary)]   # fetched once per tick
    if cand is None:
        if not halt_new_risk:
            journal.append("no_candidate", {"vrp": signals.vrp,
                                            "reason": "selector produced nothing (credit/liquidity floor)"})
    else:
        # the risk officer used to see "3 open structures"; give it the ledger
        book_lines = [f"{s['kind']} x{s['qty']} {'LONG premium' if s['net_credit'] < 0 else 'SHORT premium'} "
                      f"legs={[d['symbol'] for d in json.loads(s['legs_json'])]}"
                      for s in open_structs if s["status"] == "open"]
        book_desc = "; ".join(book_lines) or "flat"
        cand_desc = (f"{cand.structure.kind} {[l.contract.symbol for l in cand.structure.legs]} "
                     f"credit {cand.structure.net_credit}")
        desk = run_desk(signals, headlines, cand_desc, book_desc, cfg)
        # DEVLOG #28: a veto is a SESSION decision, not a 15-minute sample —
        # it flipped True/False/True in 30 minutes on identical headlines.
        if desk.veto:
            store.set_kv("veto_session", _today())
        elif store.get_kv("veto_session", "") == _today():
            desk.veto = True
            desk.veto_reason = f"sticky for the session (earlier tick): {desk.veto_reason or 'n/a'}"
            journal.append("desk_veto_sticky", {"reason": desk.veto_reason})
        journal.append("desk", desk.to_dict())
        store.add_meeting("tick", desk.exchanges)
        _alert_on_change(store, "llm_dark", len(desk.fallbacks) >= 4, "WARN",
                         "all four LLM roles fell back",
                         "; ".join(desk.fallbacks)[:400], journal)
        _alert_on_change(store, "llm_partial", 0 < len(desk.fallbacks) < 4, "INFO",
                         "some LLM roles fell back", "; ".join(desk.fallbacks)[:400], journal)
        if desk.data_suspect:
            # DEVLOG #29: both models doubting the feed is a WARNING, not a
            # verdict. It blocks new risk only when the deterministic gate
            # also found something wrong — otherwise it just halves size
            # (size_mult), because on the first live tick one model called a
            # perfectly good SPY spot "outside historical norms" and killed a
            # valid condor. LLMs tighten; code decides what is allowed.
            corroborated = dq.mode != "full" or bool(dq.reasons)
            journal.append("data_suspect", {"analyst": desk.regime_analyst,
                                            "second": desk.regime_second,
                                            "corroborated_by_data_gate": corroborated,
                                            "action": "blocked" if corroborated else "size halved"})
            _alert_on_change(store, "data_suspect", True, "WARN",
                             "LLM flagged the market data as suspect",
                             f"{'BLOCKED' if corroborated else 'size halved'}: {cand_desc}", journal)
            if corroborated:
                cand = None
        else:
            _alert_on_change(store, "data_suspect", False, "WARN", "", "", journal)
    if cand is not None:

        # DEVLOG #9: dry-run structures live under status "dry_run" so a real
        # tick can supersede them — otherwise a rehearsal blocks the real entry.
        sid = cand.structure.structure_id
        prev = next((s for s in store.all_structures() if s["structure_id"] == sid), None)
        already = prev is not None and prev["status"] in ("open", "pending", "closing", "closed",
                                                          "submitting")
        # DEVLOG #20: an 'unfilled' entry may be proposed again, at a worse
        # price, at most reprice_retries times — bounded, journaled, gated.
        unfilled_before = prev is not None and prev["status"] == "unfilled"
        attempts = int(float(store.get_kv(f"attempt:{sid}", "0")))
        if already:
            # Same-day identical candidate: the id is a hash of (day, kind,
            # legs). A repeated tick must NOT resubmit — this, not the
            # client_order_id, is the first line of idempotency (DEVLOG #4).
            journal.append("entry_skipped_duplicate", {"structure_id": sid})
        elif unfilled_before and attempts >= 1 + int(cfg["timing"]["reprice_retries"]):
            journal.append("entry_skipped_max_attempts", {"structure_id": sid,
                                                          "attempts": attempts})
        elif veto_applies(desk, cand.structure.net_credit):
            journal.append("desk_veto", {"reason": desk.veto_reason})
        else:
            if desk.veto:
                # DEVLOG #25: a news veto is about SELLING premium; this
                # candidate buys it — recorded, not enforced
                journal.append("desk_veto_waived", {"reason": desk.veto_reason,
                                                    "kind": cand.structure.kind,
                                                    "net_credit": cand.structure.net_credit})
            if unfilled_before:
                h = float(cfg["timing"]["reprice_credit_haircut"])
                before = cand.structure.net_credit
                cand.structure.net_credit = (round(before * (1 - h), 2) if before > 0
                                             else round(before * (1 + h), 2))
                journal.append("reprice", {"structure_id": sid, "attempt": attempts + 1,
                                           "from": before, "to": cand.structure.net_credit})
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
                    if s["status"] in ("open", "closing", "pending") and s["net_credit"] < 0
                    and s["sleeve"] == "core")
                # gates assume working entries fill (conservative)
                book_legs = shadow.real_book_legs(store, include_pending=True)
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
                                                "buy", abs(cand.structure.net_credit), coid,
                                                "buy_to_open")
                    # accepted != filled: 'pending' until reconcile_pending
                    # sees the fill (DEVLOG #20); dry runs stay 'dry_run'.
                    # The row is written BEFORE the broker call (DEVLOG #28).
                    res = submit_write_ahead(
                        cand.structure.structure_id, cand.structure.kind,
                        cand.structure.sleeve, qty,
                        json.dumps([{"symbol": l.contract.symbol, "qty": l.qty,
                                     "entry_price": l.entry_price}
                                    for l in cand.structure.legs]),
                        cand.structure.net_credit, cand.structure.max_loss,
                        payload, coid, "order_open")
                    if res.ok:
                        new_entry_made = True
                        store.add_counter(_today(), "entries", 1)
                        store.add_counter(_today(), "new_risk", unit_risk * qty)
                    else:
                        alerts.alert("WARN", "entry order failed",
                                     f"{cand.structure.kind} via {res.transport}: {res.error[:200]}",
                                     journal=journal)

    # ---- hedge sleeve ----------------------------------------------------
    open_after = store.open_structures()
    has_hedge = any(s["sleeve"] == "hedge" and s["status"] in ("open", "pending", "closing")
                    for s in open_after)
    core_open = [s for s in open_after if s["sleeve"] == "core" and s["status"] == "open"]
    hedge_window_ok = (not halt_new_risk and mins_to_close is not None
                       and mins_to_close >= cfg["timing"]["no_trade_last_min"]
                       and (mins_from_open is None or mins_from_open >= cfg["timing"]["no_trade_first_min"]))
    if core_open and not has_hedge and hedge_window_ok:
        h = sel.build_hedge_put(entries, exp_date, cfg["structures"]["hedge"], _today())
        # DEVLOG #28: the hedge used to bypass every gate and resubmit an
        # unfilled put every tick without bound. Now: session window (above),
        # liquidity on the leg, and the same attempt cap as core entries.
        prev_h = next((s for s in store.all_structures() if h and s["structure_id"] == h.structure_id), None)
        h_attempts = int(float(store.get_kv(f"attempt:{h.structure_id}", "0"))) if h else 0
        if h and prev_h is not None and prev_h["status"] == "unfilled" \
                and h_attempts >= 1 + int(cfg["timing"]["reprice_retries"]):
            journal.append("hedge_skipped_max_attempts", {"structure_id": h.structure_id,
                                                          "attempts": h_attempts})
            h = None
        if h and not check_quote(chain.get(h.legs[0].contract.symbol) or {},
                                 cfg["liquidity"]["max_rel_spread"]).ok:
            journal.append("hedge_skipped_illiquid", {"symbol": h.legs[0].contract.symbol})
            h = None
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
            if hqty < 1 and core_credit <= 0:
                journal.append("hedge_not_needed", {"reason": "book is net long premium; nothing to insure"})
            if hqty >= 1:
                attempt = idempotency.next_attempt(store, h.structure_id, _today())
                coid = idempotency.client_order_id(h.structure_id, _today(), attempt)
                payload = mleg.single_leg_payload(h.legs[0].contract.symbol, hqty, "buy",
                                                  h.legs[0].entry_price, coid, "buy_to_open")
                # live: 'pending' until the fill is seen (DEVLOG #20);
                # mock/demo: 'open' so the ablation books have a hedge to compare
                res = submit_write_ahead(
                    h.structure_id, h.kind, "hedge", hqty,
                    json.dumps([{"symbol": h.legs[0].contract.symbol, "qty": 1,
                                 "entry_price": h.legs[0].entry_price}]),
                    h.net_credit, h.max_loss, payload, coid, "order_hedge")
                if not res.ok:
                    alerts.alert("WARN", "hedge order failed",
                                 f"{h.structure_id}: {res.error[:200]}", journal=journal)

    # ---- shadow marks + baseline ----------------------------------------
    naive = None
    if dq.mode == "full":
        naive = shadow.baseline_naive_tick(store, chain, spot, headlines, _today())
    if naive:
        journal.append("baseline_naive_entry", {"symbol": naive})
    marks = shadow.mark_all_books(store, spot_map, now, iv_map, store.realized_gains(),
                                  broker_equity=equity, chain=chain,
                                  quality="ok" if dq.mode == "full" else "suspect")
    journal.append("marks", marks)

    journal.append("tick_end", {"entry_made": new_entry_made, "mode": dq.mode})
    store.set_kv("last_tick_ts", now.isoformat())
    store.set_kv("last_tick_mode", dq.mode)
    print(json.dumps({"signals": signals.to_dict(), "marks": marks,
                      "entry_made": new_entry_made, "mode": dq.mode}, indent=2))
    return 0


# A tick takes seconds; a lock older than this is a crashed holder. Matches
# the scheduler's ExecutionTimeLimit so a slow tick cannot be overtaken.
LOCK_TTL_MIN = 10


def cmd_tick_locked(args) -> int:
    """DEVLOG #21: one tick at a time, and a crash is journaled + alerted.
    The structure_id dedup only protects AFTER the first tick has written its
    entry; two ticks in flight at once could both submit (with distinct
    client_order_ids). The lock is an atomic sqlite upsert."""
    cfg = cfgmod.load()
    store = Store(cfg.db_path)
    now = datetime.now(timezone.utc)
    if not store.try_lock("tick_lock", now.isoformat(),
                          (now - timedelta(minutes=LOCK_TTL_MIN)).isoformat()):
        Journal(cfg.journal_dir).append("tick_skipped_locked",
                                        {"held_since": store.get_kv("tick_lock", "")})
        print("tick skipped: another tick holds the lock", file=sys.stderr)
        return 0
    try:
        rc = cmd_tick(args)
        _heartbeat_ping(ok=(rc == 0))
        return rc
    except SystemExit:
        raise
    except Exception as e:
        _heartbeat_ping(ok=False)
        # alert FIRST with no journal dependency (a corrupt journal tail used
        # to make this handler itself raise — DEVLOG #28), then journal.
        alerts.alert("CRITICAL", "tick crashed", f"{type(e).__name__}: {e}", journal=None)
        try:
            # a fresh Journal re-reads the chain head the crashed tick left behind
            Journal(cfg.journal_dir).append("tick_crash", {
                "error": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc()[-1500:]})
        except Exception:
            traceback.print_exc()
        traceback.print_exc()
        return 1
    finally:
        store.set_kv("tick_lock", "")


def _heartbeat_ping(ok: bool) -> None:
    """Dead-man switch (DEVLOG #28): if HEARTBEAT_URL is set (e.g. a
    healthchecks.io check on a */15 13-20 UTC weekday schedule), every tick
    pings it; a missed ping — laptop asleep, task disabled, reboot without
    login — is noticed by a server that is not this laptop."""
    url = os.environ.get("HEARTBEAT_URL")
    if not url:
        return
    try:
        import requests
        requests.get(url if ok else url.rstrip("/") + "/fail", timeout=5)
    except Exception:
        pass


def cmd_alert_test(args) -> int:
    """Prove alert delivery from the scheduler's own environment."""
    out = alerts.alert("INFO", "alert test", "THETA DESK can call for help", journal=None)
    _heartbeat_ping(ok=True)
    print(json.dumps({**out, "heartbeat_url_set": bool(os.environ.get("HEARTBEAT_URL"))}))
    return 0 if out.get("logged") else 1


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
    sub.add_parser("alert-test", help="send one INFO alert through every configured channel")
    args = p.parse_args(argv)
    return {"tick": cmd_tick_locked, "status": cmd_status,
            "verify-journal": cmd_verify_journal, "alert-test": cmd_alert_test}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
