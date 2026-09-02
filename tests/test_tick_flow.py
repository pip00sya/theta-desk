"""End-to-end tick flow against a fake broker — the LIVE order path
(DEVLOG #19/#20/#27), never exercised by the mock/dry-run demo:

  entry accepted -> unfilled 15m -> cancelled -> resubmitted with a haircut
  -> filled at real prices -> open -> profit target -> close accepted
  -> close filled -> realized from the broker's fills.

Safety: the real CLI is unreachable (cli_available patched False) and the
real AlpacaClient is never constructed (make_client patched); all data
paths point at a temp dir (THETADESK_DATA_DIR)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from thetadesk import config as cfgmod
from thetadesk.data.mock_client import MockAlpacaClient


class FakeBroker(MockAlpacaClient):
    """Mock market plus an order book whose fill status the test controls."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.status: dict[str, str] = {}     # client_order_id -> status (default 'new')
        self.fills: dict[str, dict] = {}     # client_order_id -> {symbol: price}

    @staticmethod
    def _legs(o: dict) -> list[dict]:
        return o.get("legs") or [{"symbol": o["symbol"], "side": o["side"], "ratio_qty": "1"}]

    def order_by_client_id(self, coid):
        for o in self.submitted:
            if o.get("client_order_id") != coid:
                continue
            st = self.status.get(coid, "new")
            out = {**o, "status": st}
            if st == "filled":
                f = self.fills.get(coid, {})
                if o.get("legs"):
                    out["legs"] = [{**l, "filled_avg_price": str(f[l["symbol"]])} for l in o["legs"]]
                else:
                    out["filled_avg_price"] = str(f.get(o["symbol"], o["limit_price"]))
            return out
        return None

    def cancel_order(self, order_id):
        for o in self.submitted:
            if o["id"] == order_id:
                self.status[o["client_order_id"]] = "canceled"

    def positions(self):
        pos: dict[str, int] = {}
        for o in self.submitted:
            if self.status.get(o.get("client_order_id"), "new") != "filled":
                continue
            for l in self._legs(o):
                sign = 1 if l["side"] == "buy" else -1
                pos[l["symbol"]] = pos.get(l["symbol"], 0) + sign * int(o["qty"]) * int(l.get("ratio_qty", 1))
        return [{"symbol": s, "qty": str(q), "avg_entry_price": "0"} for s, q in pos.items() if q]

    def fill(self, coid: str, prices: dict) -> None:
        self.status[coid] = "filled"
        self.fills[coid] = prices


class Args:
    mock = False
    dry_run = False


@pytest.fixture
def desk(tmp_path, monkeypatch):
    monkeypatch.setenv("THETADESK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    for k in ("ANTHROPIC_API_KEY", "FEATHERLESS_API_KEY", "FEATHERLESS_API_KEY_BACKUP",
              "ALERT_TELEGRAM_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL",
              "ALPACA_LIVE_TRADE"):
        monkeypatch.delenv(k, raising=False)
    import thetadesk.main as m
    from thetadesk.execution import cli_bridge
    monkeypatch.setattr(cli_bridge, "cli_available", lambda: False)   # never the real CLI
    monkeypatch.setattr(cfgmod.Config, "events", lambda self: [])      # no NFP window here
    broker = FakeBroker(realized_scale=0.70)                            # rich vol -> condor
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    cfg = cfgmod.load()
    monkeypatch.setitem(cfg.raw["management"], "profit_target_frac", 0.05)
    return m, broker, cfg


def _journal(cfg) -> list[dict]:
    with open(cfg.journal_dir / "desk.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def _struct(m, cfg, sid):
    st = m.Store(cfg.db_path)
    try:
        return next(x for x in st.all_structures() if x["structure_id"] == sid)
    finally:
        st.conn.close()


def test_entry_and_close_settle_on_broker_fills(desk):
    m, broker, cfg = desk

    # ---- tick 1: candidate passes the wall, order accepted -> 'pending' ----
    assert m.cmd_tick_locked(Args()) == 0
    st = m.Store(cfg.db_path)
    condors = [s for s in st.all_structures() if s["kind"] == "iron_condor"]
    st.conn.close()
    assert len(condors) == 1 and condors[0]["status"] == "pending"
    sid, coid1, intended = condors[0]["structure_id"], condors[0]["client_order_id"], condors[0]["net_credit"]
    first = broker.order_by_client_id(coid1)
    assert first and first["order_class"] == "mleg" and float(first["limit_price"]) < 0   # credit: negative wire

    # ---- tick 2: 15 minutes unfilled -> cancel SENT; nothing terminal is written
    # (DEVLOG #28: the DELETE is asynchronous and the order may still fill) ----
    st = m.Store(cfg.db_path)
    po = json.loads(st.get_kv(f"open_order:{sid}"))
    po["ts"] = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    st.set_kv(f"open_order:{sid}", json.dumps(po))
    st.conn.close()
    assert m.cmd_tick_locked(Args()) == 0
    assert broker.status[coid1] == "canceled"
    s = _struct(m, cfg, sid)
    assert s["status"] == "pending" and s["client_order_id"] == coid1
    assert "open_cancel_sent" in [e["kind"] for e in _journal(cfg)]

    # ---- tick 3: broker confirms canceled -> 'unfilled' -> re-proposed 15% cheaper ----
    assert m.cmd_tick_locked(Args()) == 0
    s = _struct(m, cfg, sid)
    assert s["status"] == "pending" and s["client_order_id"] != coid1
    assert abs(s["net_credit"] - intended * 0.85) < 0.03
    kinds = [e["kind"] for e in _journal(cfg)]
    assert "open_reconcile" in kinds and "reprice" in kinds and "integrity_halt" not in kinds

    # ---- tick 4: the broker fills the resubmission at real (worse) prices -> 'open' ----
    coid2 = s["client_order_id"]
    legs = json.loads(s["legs_json"])
    prices = {d["symbol"]: round(d["entry_price"] * (0.97 if d["qty"] < 0 else 1.03), 2) for d in legs}
    broker.fill(coid2, prices)
    assert m.cmd_tick_locked(Args()) == 0
    s = _struct(m, cfg, sid)
    assert s["status"] == "open"
    assert s["net_credit"] == round(sum(-d["qty"] * prices[d["symbol"]] for d in legs), 4)
    assert all(d["entry_price"] == prices[d["symbol"]] for d in json.loads(s["legs_json"]))
    integrity = [e for e in _journal(cfg) if e["kind"] == "integrity"][-1]["data"]
    assert integrity["ok"] and "DRIFT" not in integrity["reason"]

    # ---- tick 4: vol softens -> profit target -> close accepted -> 'closing' ----
    broker.atm_iv = 0.125
    assert m.cmd_tick_locked(Args()) == 0
    s = _struct(m, cfg, sid)
    assert s["status"] == "closing"
    close = json.loads(m.Store(cfg.db_path).get_kv(f"close_order:{sid}"))
    close_order = broker.order_by_client_id(close["client_order_id"])
    assert close_order and float(close_order["limit_price"]) > 0            # pay to close a credit
    assert all(l["position_intent"].endswith("to_close") for l in close_order["legs"])

    # ---- tick 5: close filled -> 'closed', realized from the fills, book/broker flat ----
    chain = broker.option_chain("SPY", "2026-09-18")
    cfills = {d["symbol"]: round(0.5 * (chain[d["symbol"]]["latestQuote"]["bp"]
                                        + chain[d["symbol"]]["latestQuote"]["ap"]), 2) for d in legs}
    broker.fill(close["client_order_id"], cfills)
    assert m.cmd_tick_locked(Args()) == 0
    s = _struct(m, cfg, sid)
    expected = round(sum(d["qty"] * (cfills[d["symbol"]] - prices[d["symbol"]]) * 100 for d in legs), 2)
    assert s["status"] == "closed" and s["closed_pnl"] == expected and expected > 0
    st = m.Store(cfg.db_path)
    assert st.realized_gains() == expected
    st.conn.close()
    assert not [p for p in broker.positions() if p["symbol"] in prices]   # condor legs flat
    journal = _journal(cfg)
    assert [e for e in journal if e["kind"] == "integrity"][-1]["data"]["ok"]
    assert "flatten_all" not in [e["kind"] for e in journal]
    # LLM blackout (no keys) alerted ONCE, on the change — not on every tick
    blackouts = [e for e in journal if e["kind"] == "alert" and "LLM" in e["data"]["title"]]
    assert len(blackouts) == 1


def test_second_tick_holds_the_lock_out(desk):
    m, broker, cfg = desk
    st = m.Store(cfg.db_path)
    assert st.try_lock("tick_lock", datetime.now(timezone.utc).isoformat(),
                       (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat())
    st.conn.close()
    assert m.cmd_tick_locked(Args()) == 0
    assert broker.submitted == []                       # nothing ran
    assert _journal(cfg)[-1]["kind"] == "tick_skipped_locked"
