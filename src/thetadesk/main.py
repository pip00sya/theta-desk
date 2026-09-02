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
from .engine.contracts import Leg, Structure
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
                elif ra.action == "cancel_revert":
                    try:
                        client.cancel_order(ra.order_id)
                    except Exception as e:  # leave it 'closing'; next tick retries
                        journal.append("close_cancel_failed", {"structure_id": ra.structure_id,
                                                               "error": str(e)[:300]})
                        continue
                    store.set_status(ra.structure_id, "open")
                    # DEVLOG #27/#28: the NEXT close of this structure in the
                    # same session crosses the spread; a fresh decision on a
                    # later day goes back to the mid (the raw attempt counter
                    # never reset, so every later close hit the bid).
                    store.set_kv(f"close_missed:{ra.structure_id}", _today())
                elif ra.action == "reverted":
                    store.set_status(ra.structure_id, "open")

        # ---- reconcile working ENTRY orders (DEVLOG #20) -----------------
        # The twin of the block above: an entry is OPEN only when the broker
        # says filled, and its legs are repriced to the real fills.
        pending = [s for s in store.open_structures() if s["status"] == "pending"]
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
                    # post-fill sanity: a fill far from the intended price means
                    # the order meant something else (DEVLOG #12 would have tripped this)
                    intended = s["net_credit"]
                    if intended and abs(net - intended) > 0.30 * abs(intended):
                        alerts.alert("WARN", "fill anomaly",
                                     f"{s['kind']} {ra.structure_id}: intended {intended}, got {net}",
                                     journal=journal)
                elif ra.action == "cancel_unfilled":
                    try:
                        client.cancel_order(ra.order_id)
                    except Exception as e:  # stays 'pending'; next tick retries
                        journal.append("open_cancel_failed", {"structure_id": ra.structure_id,
                                                              "error": str(e)[:300]})
                        continue
                    store.set_status(ra.structure_id, "unfilled")
                elif ra.action == "unfilled":
                    store.set_status(ra.structure_id, "unfilled")

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
    chain = client.option_chain(primary, expiry)
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
    extra_chains: dict[str, dict] = {}
    for u in sorted(book_underlyings - {primary}):
        extra_chains[u] = client.option_chain(u, expiry)
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
    signals = sigmod.compute(entries, closes, spot, lookback)
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
                               "data_quality": dq.mode})

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
    actions = review_book([s for s in open_structs if s["status"] == "open"], chain,
                          cfg["management"], now, entries_today, cfg.min_expiry,
                          derisk_mode=derisk,
                          derisk_lock_frac=cfg["events"].get("derisk_lock_profit_frac", 0.15),
                          minutes_to_close=mins_to_close,
                          realize_window_min=cfg["management"].get("realize_window_min", 60))
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
        cand = sel.select(entries, exp_date, signals.vrp, cfg["structures"], cfg["regime"], _today())

    # DEVLOG #16: second-underlying fallback. When the primary's candidate
    # fails the credit/liquidity floor (all-day NO_CANDIDATE in neutral
    # regime), try QQQ — richer IV often clears the same floor. The regime
    # score stays SPY-derived (indices are tightly correlated; stated in
    # the write-up), and every gate incl. the multi-underlying payoff grid
    # prices the combined book.
    if cand is None and not halt_new_risk:
        for alt in [u for u in cfg.underlyings if u != primary][:1]:
            alt_chain = client.option_chain(alt, expiry)
            if not alt_chain:
                continue
            alt_q = client.latest_stock_quote(alt)
            alt_spot = 0.5 * (float(alt_q.get("bp") or 0) + float(alt_q.get("ap") or 0))
            if not (float(alt_q.get("bp") or 0) > 0 and float(alt_q.get("ap") or 0) > 0):
                journal.append("alt_underlying_none", {"underlying": alt, "spot": alt_spot,
                                                       "reason": "one-sided stock quote"})
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
            # an LLM says the inputs look corrupted: recorded, and no new risk
            journal.append("data_suspect", {"analyst": desk.regime_analyst,
                                            "second": desk.regime_second})
            _alert_on_change(store, "data_suspect", True, "WARN",
                             "LLM flagged the market data as suspect", cand_desc, journal)
            cand = None
        else:
            _alert_on_change(store, "data_suspect", False, "WARN", "", "", journal)
    if cand is not None:

        # DEVLOG #9: dry-run structures live under status "dry_run" so a real
        # tick can supersede them — otherwise a rehearsal blocks the real entry.
        sid = cand.structure.structure_id
        prev = next((s for s in store.all_structures() if s["structure_id"] == sid), None)
        already = prev is not None and prev["status"] in ("open", "pending", "closing", "closed")
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
                    res = cli_bridge.submit(payload, client, dry_run=dry)
                    journal.append("order_open", {"structure_id": cand.structure.structure_id,
                                                  "transport": res.transport, "ok": res.ok,
                                                  "duplicate": res.duplicate, "error": res.error,
                                                  "payload": payload})
                    if res.ok:
                        new_entry_made = True
                        # accepted != filled: 'pending' until reconcile_pending
                        # sees the fill (DEVLOG #20); dry runs stay 'dry_run'
                        store.upsert_structure(
                            cand.structure.structure_id, cand.structure.kind,
                            cand.structure.sleeve, qty,
                            json.dumps([{"symbol": l.contract.symbol, "qty": l.qty,
                                         "entry_price": l.entry_price}
                                        for l in cand.structure.legs]),
                            cand.structure.net_credit, cand.structure.max_loss,
                            "dry_run" if dry else "pending",
                            order_id=(res.order or {}).get("id"), client_order_id=coid)
                        if not dry:
                            store.set_kv(f"open_order:{cand.structure.structure_id}", json.dumps({
                                "client_order_id": coid, "ts": now.isoformat(),
                                "order_id": (res.order or {}).get("id"),
                                "intended": cand.structure.net_credit}))
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
                res = cli_bridge.submit(payload, client, dry_run=dry)
                journal.append("order_hedge", {"structure_id": h.structure_id,
                                               "transport": res.transport, "ok": res.ok})
                if res.ok:
                    # live: 'pending' until the fill is seen (DEVLOG #20);
                    # dry/demo: 'open' so the ablation books have a hedge to compare
                    store.upsert_structure(
                        h.structure_id, h.kind, "hedge", hqty,
                        json.dumps([{"symbol": h.legs[0].contract.symbol, "qty": 1,
                                     "entry_price": h.legs[0].entry_price}]),
                        h.net_credit, h.max_loss,
                        "open" if args.mock else ("dry_run" if dry else "pending"),
                        order_id=(res.order or {}).get("id"), client_order_id=coid)
                    if not dry:
                        store.set_kv(f"open_order:{h.structure_id}", json.dumps({
                            "client_order_id": coid, "ts": now.isoformat(),
                            "order_id": (res.order or {}).get("id"), "intended": h.net_credit}))

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
