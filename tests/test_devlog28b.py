"""DEVLOG #28 (state machine): write-ahead order submission, deferred cancel
settlement, close order id on the row, 'never seen' timeouts and the
post-submission expiry roll — all against the FakeBroker harness."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from thetadesk import config as cfgmod
from thetadesk.data.mock_client import MockAlpacaClient
from thetadesk.manage.positions import reconcile_closing, reconcile_pending
from test_tick_flow import FakeBroker, Args, _journal, _struct

NOW = datetime(2026, 9, 2, 15, 0, tzinfo=timezone.utc)
LEGS = json.dumps([{"symbol": "SPY260918P00750000", "qty": 1, "entry_price": 3.66}])


@pytest.fixture
def desk(tmp_path, monkeypatch):
    monkeypatch.setenv("THETADESK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    for k in ("ANTHROPIC_API_KEY", "FEATHERLESS_API_KEY", "FEATHERLESS_API_KEY_BACKUP",
              "ALERT_TELEGRAM_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL", "HEARTBEAT_URL"):
        monkeypatch.delenv(k, raising=False)
    import thetadesk.main as m
    from thetadesk.execution import cli_bridge
    monkeypatch.setattr(cli_bridge, "cli_available", lambda: False)
    monkeypatch.setattr(cfgmod.Config, "events", lambda self: [])
    cfg = cfgmod.load()
    monkeypatch.setitem(cfg.raw["management"], "profit_target_frac", 0.05)
    return m, cfg


# ---- write-ahead submission ------------------------------------------------

class AcceptsButRaises(FakeBroker):
    """The broker accepts the order, then the transport dies before the reply."""
    def submit_order(self, payload):
        rec = super().submit_order(payload)
        raise ConnectionError("connection reset by peer")


def test_ambiguous_submit_is_recovered_by_client_order_id(desk, monkeypatch):
    m, cfg = desk
    broker = AcceptsButRaises(realized_scale=0.70)
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    condors = [s for s in st.all_structures() if s["kind"] == "iron_condor"]
    st.conn.close()
    assert len(condors) == 1 and condors[0]["status"] == "pending"      # not orphaned, not doubled
    kinds = [e["kind"] for e in _journal(cfg)]
    assert "order_recovered_by_client_id" in kinds and "tick_crash" not in kinds
    assert len(broker.submitted) == 1


class RejectsDefinitively(FakeBroker):
    def submit_order(self, payload):
        from thetadesk.data.alpaca_client import AlpacaError
        raise AlpacaError("POST https://paper-api.alpaca.markets/v2/orders -> 422: insufficient")


def test_definitive_rejection_releases_the_row(desk, monkeypatch):
    m, cfg = desk
    monkeypatch.setattr(m, "make_client", lambda mock: RejectsDefinitively(realized_scale=0.70))
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    s = next(x for x in st.all_structures() if x["kind"] == "iron_condor")
    st.conn.close()
    assert s["status"] == "unfilled"
    assert "order_not_at_broker" in [e["kind"] for e in _journal(cfg)]


# ---- cancel vs fill race ---------------------------------------------------

class RacingBroker(FakeBroker):
    """The cancel arrives a second after the fill printed."""
    def cancel_order(self, order_id):
        for o in self.submitted:
            if o["id"] == order_id and self.status.get(o["client_order_id"], "new") != "filled":
                legs = self._legs(o)
                self.fill(o["client_order_id"],
                          {l["symbol"]: float(o["limit_price"]) / max(1, len(legs)) for l in legs}
                          if not o.get("legs") else
                          {l["symbol"]: 1.0 for l in legs})


def test_cancel_that_races_a_fill_does_not_halt(desk, monkeypatch):
    m, cfg = desk
    broker = RacingBroker(realized_scale=0.70)
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    assert m.cmd_tick_locked(Args()) == 0                       # tick 1: pending
    st = m.Store(cfg.db_path)
    sid = next(x for x in st.all_structures() if x["kind"] == "iron_condor")["structure_id"]
    po = json.loads(st.get_kv(f"open_order:{sid}"))
    po["ts"] = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    st.set_kv(f"open_order:{sid}", json.dumps(po))
    st.conn.close()
    assert m.cmd_tick_locked(Args()) == 0                       # tick 2: cancel sent, order fills
    assert _struct(m, cfg, sid)["status"] == "pending"          # nothing terminal written
    assert m.cmd_tick_locked(Args()) == 0                       # tick 3: broker says filled -> open
    assert _struct(m, cfg, sid)["status"] == "open"
    journal = _journal(cfg)
    assert [e for e in journal if e["kind"] == "integrity"][-1]["data"]["ok"]
    assert "integrity_halt" not in [e["kind"] for e in journal]


# ---- reconcile details ------------------------------------------------------

def _closing(coid_col=None):
    return {"structure_id": "s1", "status": "closing", "net_credit": -3.66, "qty": 1,
            "legs_json": LEGS, "client_order_id": "td-entry", "close_client_order_id": coid_col}


def test_close_reconcile_never_uses_the_entry_order_id():
    entry_order = {"id": "e1", "status": "filled", "filled_avg_price": "3.66"}
    lookup = lambda coid: entry_order if coid == "td-entry" else None
    [ra] = reconcile_closing([_closing(None)], {}, lookup, NOW, 10)
    assert ra.action == "reverted"                              # no close record -> back to open
    [ra] = reconcile_closing([_closing("td-close")], {}, lookup, NOW, 10)
    assert ra.action == "pending"                               # close id known, broker not yet


def test_never_seen_orders_are_released_after_the_grace_period():
    old = {"s1": {"client_order_id": "td-x", "ts": (NOW - timedelta(minutes=40)).isoformat()}}
    fresh = {"s1": {"client_order_id": "td-x", "ts": (NOW - timedelta(minutes=5)).isoformat()}}
    pend = {"structure_id": "s1", "status": "pending", "net_credit": -3.66, "qty": 1,
            "legs_json": LEGS, "client_order_id": "td-x"}
    assert reconcile_pending([pend], old, lambda c: None, NOW, 10)[0].action == "unfilled"
    assert reconcile_pending([pend], fresh, lambda c: None, NOW, 10)[0].action == "pending"
    [ra] = reconcile_closing([_closing("td-x")], old, lambda c: None, NOW, 10)
    assert ra.action == "reverted"


def test_pending_cancel_waits_and_partial_dead_order_adopts_filled_qty():
    pend = {"structure_id": "s1", "status": "pending", "net_credit": -3.66, "qty": 3,
            "legs_json": LEGS, "client_order_id": "td-x"}
    po = {"s1": {"client_order_id": "td-x", "ts": (NOW - timedelta(minutes=20)).isoformat()}}
    [ra] = reconcile_pending([pend], po, lambda c: {"id": "o", "status": "pending_cancel"}, NOW, 10)
    assert ra.action == "pending"
    [ra] = reconcile_pending([pend], po, lambda c: {"id": "o", "status": "canceled", "filled_qty": "2",
                                                    "filled_avg_price": "3.70"}, NOW, 10)
    assert ra.action == "filled" and ra.filled_qty == 2 and ra.fills == {"SPY260918P00750000": 3.70}
    [ra] = reconcile_pending([pend], po, lambda c: {"id": "o", "status": "partially_filled",
                                                    "filled_qty": "1"}, NOW, 10)
    assert ra.action == "cancel_unfilled"                       # remainder cancelled after the wait


# ---- post-submission roll ---------------------------------------------------

def test_expiry_rolls_after_the_configured_date_and_book_legs_stay_marked(desk, monkeypatch):
    m, cfg = desk
    monkeypatch.setitem(cfg.raw["expiry"], "roll_after", "2000-01-01")
    monkeypatch.setitem(cfg.raw["expiry"], "roll_target", "2026-10-16")
    broker = FakeBroker(realized_scale=0.70)
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    st = m.Store(cfg.db_path)
    st.upsert_structure("old", "cheap_vol_put", "core", 1, LEGS, -3.66, 366.0, "open")
    st.conn.close()
    # the fake broker must hold the Sep-18 leg so integrity passes
    broker.submitted.append({"id": "seed", "client_order_id": "seed", "symbol": "SPY260918P00750000",
                             "side": "buy", "qty": "1", "limit_price": "3.66"})
    broker.status["seed"] = "filled"
    assert m.cmd_tick_locked(Args()) == 0
    journal = _journal(cfg)
    sig = next(e for e in journal if e["kind"] == "signals")["data"]
    assert sig["expiry"] == "2026-10-16"
    assert "expiry_roll" in [e["kind"] for e in journal]
    manage = [e for e in journal if e["kind"] == "manage" and e["data"]["structure_id"] == "old"]
    assert manage and "unmarkable" not in manage[-1]["data"]["reason"]   # Sep-18 chain still fetched
    opened = [e for e in journal if e["kind"] == "order_open"]
    assert opened, "the roll target should produce a candidate on the mock chain"
    legs = opened[0]["data"]["payload"]["legs"]
    assert all(l["symbol"][3:9] == "261016" for l in legs)          # new entries target Oct 16


# ---- sizing keys are read, not decorative (audit F30) -----------------------

def test_sizing_keys_drive_the_multipliers():
    from thetadesk.agents.desk import DeskView
    v = DeskView(regime_analyst="rich", regime_second="neutral", disagreement=True, veto=False,
                 veto_reason="", objection="", objection_severity="low", disagreement_mult=0.25)
    assert v.size_mult == 0.25
    v2 = DeskView(regime_analyst="rich", regime_second="rich", disagreement=False, veto=False,
                  veto_reason="", objection="", objection_severity="high", disagreement_mult=0.25)
    assert v2.size_mult == 0.25
    import inspect
    from thetadesk.engine import selector as sel
    assert "neutral_mult" in inspect.signature(sel.select).parameters


def test_regime_exit_ignores_zero_credit_rows():
    """A row that neither paid nor received (a mleg fill reported flat) is not
    long premium; the regime exit must not close it as one."""
    from test_devlog28 import _put, _chain, MGMT, NOW
    from thetadesk.manage.positions import review_book
    s = _put(sid="z")
    s["net_credit"] = 0.0
    [a] = review_book([s], _chain(3.66), MGMT, NOW, 0, "2026-09-18", regime="rich", peaks={})
    assert "regime exit" not in a.reason


# ---- underlying rotation (DEVLOG #31) --------------------------------------

def test_second_entry_goes_to_a_different_underlying(desk, monkeypatch):
    """Two near-identical SPY condors on 2026-09-02 were one bet at double
    size. The search now starts with the underlying the book holds least."""
    m, cfg = desk
    broker = FakeBroker(realized_scale=0.70)
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    sid = next(x for x in st.all_structures() if x["kind"] == "iron_condor")["structure_id"]
    coid = json.loads(st.get_kv(f"open_order:{sid}"))["client_order_id"]
    st.conn.close()
    broker.fill(coid, {l["symbol"]: 1.0 for l in broker.submitted[0]["legs"]})
    assert m.cmd_tick_locked(Args()) == 0          # first condor now open

    order = [e for e in _journal(cfg) if e["kind"] == "underlying_order"][-1]["data"]
    first_held = order["held"].get(order["order"][0], 0)
    assert first_held == 0, order            # never re-enters the held name first
    assert order["order"][-1] == cfg["universe"]["primary"], order


def test_an_estimated_entry_price_must_not_hide_a_profit_target():
    """2026-09-01, SPY 751 put, the single most expensive bug so far (~$208).

    The desk sent the order at an estimated 3.74 and filled at 3.66, but
    nothing rewrote the leg, so the mark read (5.955-3.74)*100 = +221.5 =
    +59.2% of an inflated cost and held one point under the +60% exit. The
    three sibling puts, whose estimates happened to match their fills, all
    closed at +64/66/70%. Overnight SPY rebounded and the +$229 became +$21.
    Marks are computed from FILLS now (apply_fills); this pins that down.
    """
    from datetime import datetime, timezone
    from thetadesk.manage.positions import apply_fills, review_book
    estimated = json.dumps([{"symbol": "SPY260918P00751000", "qty": 1, "entry_price": 3.74}])
    s = {"structure_id": "bc78ba8c", "kind": "cheap_vol_put", "sleeve": "core", "qty": 1,
         "legs_json": apply_fills(estimated, {"SPY260918P00751000": 3.66}),
         "net_credit": -3.66, "status": "open"}
    chain = {"SPY260918P00751000": {"latestQuote": {"bp": 5.95, "ap": 5.96}}}
    mgmt = {"profit_target_frac": 0.35, "debit_profit_target_frac": 0.60,
            "realize_min_frac": 0.25, "structure_stop_credit_mult": 2.0, "time_stop_dte": 7}
    [a] = review_book([s], chain, mgmt, datetime(2026, 9, 1, 18, 45, tzinfo=timezone.utc),
                      0, "2026-09-18")
    assert a.action == "close" and "debit profit target" in a.reason, a
    assert a.est_pnl == 229.5, a.est_pnl
