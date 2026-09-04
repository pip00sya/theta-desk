"""A synthetic session: ticks and one-minute management passes interleaved
on the FakeBroker, the market scripted between steps, and only INVARIANTS
asserted — ceilings never breached, exits fire within one pass, budgets
balance, the chain stays intact, nothing crashes.

What this deliberately does NOT do: tune a threshold so the synthetic P&L
looks good. Every number the desk trades by stays in config.yaml; the
scenarios are chosen so that a RULE fires, and the assertions are about
the rule, the accounting and the bounds — the same statements that must
hold on the live tape (DEVLOG #36).

Scenarios
  1. quiet rich tape on the establish rung  -> three lots, target exit by a pass
  2. day one, no record                     -> the explore rung, two lots
  3. drawdown                               -> a rung taken back, then the halt
  4. a gap through the short call            -> the stop fires from a pass, loss bounded
  5. a partial fill at three lots            -> one lot adopted, two lots of budget released
  6. a full day of entries                   -> the daily budget binds on the fourth
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from thetadesk import config as cfgmod
from thetadesk.engine.contracts import OptionContract
from thetadesk.audit.journal import Journal
from test_tick_flow import Args, FakeBroker, _journal, _struct

EXPIRY = "2026-09-18"


class Manage(Args):
    pass


class AutoBroker(FakeBroker):
    """FakeBroker plus a market that can be scripted and a settle() that fills
    every working order at the CURRENT chain mids — the way a limit sent at
    the mid fills when the market has not moved against it."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.minutes_to_close = 180.0
        self.partial_next: int | None = None     # fill only this many lots of the next order

    def clock(self):
        now = datetime.now(timezone.utc)
        return {"timestamp": now.isoformat(), "is_open": True,
                "next_open": now.isoformat(),
                "next_close": (now + timedelta(minutes=self.minutes_to_close)).isoformat()}

    @staticmethod
    def _und(sym: str) -> str:
        return sym[:next(i for i, ch in enumerate(sym) if ch.isdigit())]

    def settle(self) -> int:
        """Fill every working order at the current mids. Returns fills made."""
        n = 0
        chains: dict[str, dict] = {}
        for o in self.submitted:
            coid = o.get("client_order_id")
            if self.status.get(coid, "new") != "new":
                continue
            prices = {}
            for l in self._legs(o):
                u = self._und(l["symbol"])
                if u not in chains:
                    chains[u] = self.option_chain(u, EXPIRY)
                q = (chains[u].get(l["symbol"]) or {}).get("latestQuote") or {}
                # the mock drops contracts worth under 3c from its chain, the
                # way a far wing loses its bid live: it fills at the tick
                prices[l["symbol"]] = round(0.5 * (q["bp"] + q["ap"]), 2) if q else 0.01
            if self.partial_next is not None and int(o["qty"]) > self.partial_next:
                # the broker filled part, then the order died (DEVLOG #28 path)
                o["filled_qty"] = str(self.partial_next)
                self.fills[coid] = prices
                self.status[coid] = "canceled"
                self.partial_next = None
            else:
                self.fill(coid, prices)
            n += 1
        return n

    def order_by_client_id(self, coid):
        out = super().order_by_client_id(coid)
        if out and out.get("status") == "canceled" and out.get("filled_qty"):
            # a dead order that filled part of its size carries the fills
            f = self.fills.get(coid, {})
            if out.get("legs"):
                out["legs"] = [{**l, "filled_avg_price": str(f[l["symbol"]])} for l in out["legs"]]
        return out

    def positions(self):
        pos: dict[str, int] = {}
        for o in self.submitted:
            st = self.status.get(o.get("client_order_id"), "new")
            if st == "filled":
                lots = int(o["qty"])
            elif st == "canceled" and o.get("filled_qty"):
                lots = int(o["filled_qty"])
            else:
                continue
            for l in self._legs(o):
                sign = 1 if l["side"] == "buy" else -1
                pos[l["symbol"]] = pos.get(l["symbol"], 0) + sign * lots * int(l.get("ratio_qty", 1))
        return [{"symbol": s, "qty": str(q), "avg_entry_price": "0"} for s, q in pos.items() if q]


@pytest.fixture
def sim(tmp_path, monkeypatch):
    monkeypatch.setenv("THETADESK_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    for k in ("ANTHROPIC_API_KEY", "FEATHERLESS_API_KEY", "FEATHERLESS_API_KEY_BACKUP",
              "ALERT_TELEGRAM_TOKEN", "ALERT_TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL",
              "HEARTBEAT_URL", "ALPACA_LIVE_TRADE"):
        monkeypatch.delenv(k, raising=False)
    import thetadesk.main as m
    from thetadesk.execution import cli_bridge
    monkeypatch.setattr(cli_bridge, "cli_available", lambda: False)
    monkeypatch.setattr(cfgmod.Config, "events", lambda self: [])
    broker = AutoBroker(realized_scale=0.70)                # rich vol -> condors
    monkeypatch.setattr(m, "make_client", lambda mock: broker)
    monkeypatch.setattr(m, "LOCK_WAIT_S", 0.0)
    cfg = cfgmod.load()
    monkeypatch.setitem(cfg.raw["management"], "profit_target_frac", 0.10)
    return m, broker, cfg


# ---- helpers ------------------------------------------------------------------

def seed_record(m, cfg, n: int, pnl_each: float, hwm: float | None = None) -> None:
    """n resolved core trades in the store — the record the ladder is earned by."""
    st = m.Store(cfg.db_path)
    legs = json.dumps([{"symbol": "SPY260918P00600000", "qty": -1, "entry_price": 1.0},
                       {"symbol": "SPY260918P00590000", "qty": 1, "entry_price": 0.5}])
    for i in range(n):
        sid = f"seed{i:02d}"
        # kind 'seed' so the scenarios' condor queries never see the record;
        # the ladder counts by sleeve and status, not by kind
        st.upsert_structure(sid, "seed", "core", 1, legs, 0.5, 950.0, "closed")
        st.set_status(sid, "closed", pnl_each)
    if hwm is not None:
        st.set_kv("high_watermark", str(hwm))
    st.conn.close()


def tick(m, broker) -> None:
    assert m.cmd_tick_locked(Args()) == 0


def pause(m, broker, n: int = 1) -> None:
    for _ in range(n):
        assert m.cmd_manage_locked(Manage()) == 0


def kinds(cfg) -> list[str]:
    return [e["kind"] for e in _journal(cfg)]


def rows(m, cfg, **where) -> list[dict]:
    st = m.Store(cfg.db_path)
    try:
        out = [s for s in st.all_structures()
               if all(s.get(k) == v for k, v in where.items())]
    finally:
        st.conn.close()
    return out


def counter(m, cfg, key: str) -> float:
    st = m.Store(cfg.db_path)
    try:
        return st.get_counter(m._today(), key)
    finally:
        st.conn.close()


def invariants(m, broker, cfg) -> None:
    """What must hold after ANY session, whatever the market did."""
    j = _journal(cfg)
    ks = [e["kind"] for e in j]
    ok, msg = Journal(cfg.journal_dir).verify_chain()
    assert ok, msg
    for bad in ("tick_crash", "manage_crash", "integrity_halt", "flatten_all"):
        assert bad not in ks, bad
    # every gate that passed sized inside its rung; every rung was journaled first
    for i, e in enumerate(j):
        if e["kind"] != "gates":
            continue
        g7 = next(r for r in e["data"]["results"] if r["gate"] == "g7_structure_size")
        if e["data"]["passed"]:
            assert g7["data"]["risk"] <= g7["data"]["limit"] + 1e-6
        lad = next((x for x in reversed(j[:i]) if x["kind"] == "ladder"), None)
        assert lad is not None and lad["data"]["tier"] == e["data"]["tier"]
    # a snapshot for every signals line, and a signals line for every snapshot
    sigs = [e["data"]["snapshot"] for e in j if e["kind"] == "signals"]
    files = {p.name for p in cfg.snapshot_dir.glob("*.json")}
    assert set(sigs) == files, (len(sigs), len(files))
    # passes never opened anything
    for i, e in enumerate(j):
        if e["kind"] == "manage_start":
            end = next(k for k in range(i, len(j)) if j[k]["kind"] == "manage_end")
            between = {x["kind"] for x in j[i:end]}
            assert not ({"order_open", "order_hedge", "gates", "desk", "tick_start"} & between)
    # the broker holds exactly what the book says it holds
    book: dict[str, int] = {}
    for s in rows(m, cfg):
        if s["status"] in ("open", "closing"):
            for d in json.loads(s["legs_json"]):
                book[d["symbol"]] = book.get(d["symbol"], 0) + d["qty"] * s["qty"]
    broker_pos = {p["symbol"]: int(p["qty"]) for p in broker.positions()}
    assert {k: v for k, v in book.items() if v} == broker_pos
    # the daily budget is exactly the risk of what is at the broker or working today
    charged = sum(s["max_loss"] * s["qty"] for s in rows(m, cfg)
                  if s["sleeve"] == "core" and s["kind"] != "seed"
                  and s["status"] in ("open", "closing", "pending", "closed")
                  and (s.get("opened_utc") or "")[:10] >= m._today()[:10])
    assert counter(m, cfg, "new_risk") == pytest.approx(charged, abs=1.0)


def condor_lots(m, cfg) -> list[int]:
    return [s["qty"] for s in rows(m, cfg, kind="iron_condor")
            if s["status"] in ("open", "closing", "closed", "pending")]


# ---- scenarios ----------------------------------------------------------------

def test_quiet_rich_tape_on_the_establish_rung(sim):
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)

    tick(m, broker)                                   # the desk decides: a condor
    lad = [e["data"] for e in _journal(cfg) if e["kind"] == "ladder"][-1]
    assert lad["tier"] == "establish" and lad["closed"] == 5
    open_ = rows(m, cfg, kind="iron_condor")
    assert len(open_) == 1 and open_[0]["qty"] == 3          # three lots, not one
    assert open_[0]["max_loss"] * 3 <= 0.03 * 100_000 + 1e-6

    broker.settle()
    pause(m, broker, 3)                                # the fast hand sees the fill, holds
    assert _struct(m, cfg, open_[0]["structure_id"])["status"] == "open"
    ends = [e["data"] for e in _journal(cfg) if e["kind"] == "manage_end"]
    assert ends[-1]["holds"] >= 1 and ends[-1]["closes"] == []
    assert "manage" not in kinds(cfg)[kinds(cfg).index("manage_start"):]   # no hold rows

    broker.atm_iv = 0.105                              # vol softens: the condor is green
    pause(m, broker)                                   # ONE pass, not a quarter hour
    s = _struct(m, cfg, open_[0]["structure_id"])
    assert s["status"] == "closing"
    close = [e for e in _journal(cfg) if e["kind"] == "manage" and e["data"]["action"] == "close"]
    assert close and "profit target" in close[-1]["data"]["reason"]

    broker.settle()
    tick(m, broker)                                    # the tick settles it, does not resend
    s = _struct(m, cfg, open_[0]["structure_id"])
    assert s["status"] == "closed" and s["closed_pnl"] > 0
    assert kinds(cfg).count("order_close") == 1
    invariants(m, broker, cfg)


def test_day_one_is_the_explore_rung(sim):
    m, broker, cfg = sim
    tick(m, broker)
    lad = [e["data"] for e in _journal(cfg) if e["kind"] == "ladder"][-1]
    assert lad["tier"] == "explore" and lad["closed"] == 0 and lad["next"]["min_closed"] == 5
    assert condor_lots(m, cfg) == [2]                  # 2% of 100k over an ~$816 unit
    broker.settle()
    pause(m, broker, 2)
    invariants(m, broker, cfg)


def test_drawdown_takes_the_rung_back_then_the_halt_stops_entries(sim):
    m, broker, cfg = sim
    seed_record(m, cfg, n=6, pnl_each=50.0, hwm=100_000)
    broker.equity = 97_500.0                           # 2.5% off the high
    tick(m, broker)
    lad = [e["data"] for e in _journal(cfg) if e["kind"] == "ladder"][-1]
    assert lad["earned"] == "establish" and lad["tier"] == "explore" and lad["demoted"] == 1
    assert condor_lots(m, cfg) == [2]                  # sized on the rung it fell to
    broker.settle()

    broker.equity = 95_900.0                           # 4.1% off: gate #14
    broker.spot = 656.0                                # a fresh candidate, not a duplicate
    tick(m, broker)
    lad = [e["data"] for e in _journal(cfg) if e["kind"] == "ladder"][-1]
    assert lad["tier"] == "explore" and lad["demoted"] == 1
    refused = [e["data"] for e in _journal(cfg) if e["kind"] == "entry_refused"]
    assert refused and refused[-1]["gate"] == "g14_halt"
    assert len(condor_lots(m, cfg)) == 1               # nothing new was sent
    invariants(m, broker, cfg)


def test_gap_through_the_short_call_is_stopped_by_a_pass_and_bounded(sim):
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)
    tick(m, broker)
    s = rows(m, cfg, kind="iron_condor")[0]
    assert s["qty"] == 3
    broker.settle()
    pause(m, broker)
    assert _struct(m, cfg, s["structure_id"])["status"] == "open"

    short_call = max(OptionContract.parse(d["symbol"]).strike
                     for d in json.loads(s["legs_json"]) if d["qty"] < 0)
    broker.spot = short_call + 12.0                    # a gap through the short call
    pause(m, broker)                                   # the next minute, not the next tick
    st = _struct(m, cfg, s["structure_id"])
    assert st["status"] == "closing", st["status"]
    close = [e for e in _journal(cfg) if e["kind"] == "manage" and e["data"]["action"] == "close"][-1]
    assert "structure stop" in close["data"]["reason"]

    broker.settle()
    pause(m, broker)
    st = _struct(m, cfg, s["structure_id"])
    assert st["status"] == "closed" and st["closed_pnl"] < 0
    # defined risk: the loss can never exceed the worst case the gate priced
    assert -st["closed_pnl"] <= s["max_loss"] * s["qty"] + 1e-6
    assert not [p for p in broker.positions() if p["symbol"].startswith("SPY")]
    invariants(m, broker, cfg)


def test_partial_fill_adopts_the_lots_and_releases_the_rest(sim):
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)
    tick(m, broker)
    s = rows(m, cfg, kind="iron_condor")[0]
    assert s["qty"] == 3
    charged = counter(m, cfg, "new_risk")
    assert charged == pytest.approx(s["max_loss"] * 3, abs=0.01)

    broker.partial_next = 1                            # one lot fills, the order dies
    broker.settle()
    pause(m, broker)
    st = _struct(m, cfg, s["structure_id"])
    assert st["status"] == "open" and st["qty"] == 1
    rel = [e["data"] for e in _journal(cfg) if e["kind"] == "new_risk_released"]
    assert rel and rel[-1]["lots"] == 2 and rel[-1]["risk"] == pytest.approx(s["max_loss"] * 2, abs=0.01)
    assert counter(m, cfg, "new_risk") == pytest.approx(s["max_loss"] * 1, abs=0.01)
    integ = [e["data"] for e in _journal(cfg) if e["kind"] == "integrity"][-1]
    assert integ["ok"] and "DRIFT" not in integ["reason"]
    invariants(m, broker, cfg)


def test_a_full_day_of_entries_until_the_daily_budget_binds(sim):
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)
    # SPY, then the rotation's least-exposed names, three lots each
    for _ in range(3):
        tick(m, broker)
        broker.settle()
        pause(m, broker)
    lots = condor_lots(m, cfg)
    assert lots == [3, 3, 3], lots
    unds = sorted({OptionContract.parse(json.loads(s["legs_json"])[0]["symbol"]).underlying
                   for s in rows(m, cfg, kind="iron_condor")})
    assert unds == ["IWM", "QQQ", "SPY"]                # spread across the universe
    spent = counter(m, cfg, "new_risk")
    assert 0.05 * 100_000 < spent <= 0.08 * 100_000    # inside the establish day budget

    broker.spot = 656.5                                # a fourth, fresh candidate
    tick(m, broker)
    refused = [e["data"] for e in _journal(cfg) if e["kind"] == "entry_refused"]
    assert refused and refused[-1]["gate"] == "g9_daily_budget", refused
    g = [e["data"] for e in _journal(cfg) if e["kind"] == "gates"][-1]
    g9 = next(r for r in g["results"] if r["gate"] == "g9_daily_budget")
    assert g9["data"]["limit"] == pytest.approx(0.08 * 100_000)
    assert g9["data"]["new_risk_today"] + g9["data"]["cand_risk"] > g9["data"]["limit"]
    assert condor_lots(m, cfg) == [3, 3, 3]            # still three, nothing slipped through
    invariants(m, broker, cfg)
