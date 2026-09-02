"""DEVLOG #28 — the data-quality gate, closed-market ticks, LLM reply hygiene,
journal tail repair and the qty-scaled exits. Every case here is a live
failure that 85 green tests could not see because the mock market is perfect."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from thetadesk.agents import llm
from thetadesk.audit.journal import Journal
from thetadesk.data import signals as sigmod
from thetadesk.data.mock_client import MockAlpacaClient
from thetadesk.manage.positions import review_book

NOW = datetime(2026, 9, 2, 15, 0, tzinfo=timezone.utc)
SESSION = "2026-09-02"


def _bars(n=30, last="2026-09-01"):
    d = datetime.fromisoformat(last)
    out = []
    for i in range(n):
        out.append({"t": (d - timedelta(days=n - 1 - i)).strftime("%Y-%m-%dT04:00:00Z"), "c": 760.0 + i * 0.1})
    return out


# ---- L1 data-quality gate ---------------------------------------------------

def test_one_sided_quote_falls_back_to_prev_close_and_disables_entries():
    """The exact 2026-09-01 20:15 UTC failure: bid=0 after the close -> spot=ap/2."""
    bars = _bars()
    closes = [b["c"] for b in bars]
    dq = sigmod.assess({"bp": 0.0, "ap": 761.85}, closes, bars, SESSION)
    assert dq.mode == "mark_only" and dq.spot_source == "prev_close"
    assert abs(dq.spot - closes[-1]) < 1e-9
    assert any("unusable" in r for r in dq.reasons)


def test_spot_far_from_close_skips_the_tick():
    bars = _bars()
    closes = [b["c"] for b in bars]
    dq = sigmod.assess({"bp": 380.9, "ap": 380.95}, closes, bars, SESSION)
    assert dq.mode == "skip"


def test_stale_bars_disable_entries():
    bars = _bars(last="2026-08-14")      # what the old request actually returned
    closes = [b["c"] for b in bars]
    dq = sigmod.assess({"bp": 762.0, "ap": 762.05}, closes, bars, SESSION)
    assert dq.mode == "mark_only" and any("daily bar" in r for r in dq.reasons)


def test_clean_inputs_are_full():
    bars = _bars()
    closes = [b["c"] for b in bars]
    dq = sigmod.assess({"bp": 762.0, "ap": 762.05}, closes, bars, SESSION)
    assert dq.mode == "full" and dq.spot_source == "quote" and not dq.reasons


def test_short_history_disables_entries():
    bars = _bars(n=5)
    dq = sigmod.assess({"bp": 762.0, "ap": 762.05}, [b["c"] for b in bars], bars, SESSION)
    assert dq.mode == "mark_only"


def test_iv_bounds():
    assert sigmod.check_iv(sigmod.MarketSignals(762, 0.13, 0.67, 1.0)) is not None
    assert sigmod.check_iv(sigmod.MarketSignals(762, 0.13, 0.13, 0.5)) is None


def test_mock_bars_end_yesterday_and_exclude_session_bar():
    c = MockAlpacaClient()
    bars = c.stock_bars_daily("SPY", 30)
    assert len(bars) == 30
    today = datetime.now(timezone.utc).date().isoformat()
    assert bars[-1]["t"][:10] < today
    dq = sigmod.assess(c.latest_stock_quote("SPY"), [b["c"] for b in bars], bars, today)
    assert dq.mode == "full", dq.reasons


# ---- LLM reply hygiene ------------------------------------------------------

def test_extract_json_shapes():
    assert llm.extract_json('{"veto": false, "reason": "x"}') == {"veto": False, "reason": "x"}
    assert llm.extract_json('```json\n{"regime": "rich"}\n```') == {"regime": "rich"}
    assert llm.extract_json('Format {regime} then: {"regime": "cheap"}') == {"regime": "cheap"}
    assert llm.extract_json('{"objection": "if SPY breaks 750 } we lose", "severity": "high"}') == {
        "objection": "if SPY breaks 750 } we lose", "severity": "high"}
    assert llm.extract_json("") is None and llm.extract_json("no json here") is None


def test_desk_treats_empty_and_string_booleans_safely(monkeypatch):
    from thetadesk import config as cfgmod
    from thetadesk.agents import desk as deskmod

    answers = {
        "vol_analyst": '{"regime": "Rich", "confidence": 0.8, "data_suspect": false}',
        "second_opinion": "",                                   # empty -> fallback
        "news_vetoer": '{"veto": "false", "reason": "calm"}',   # string boolean
        "risk_officer": '{"objection": "gap", "severity": "High"}',
    }

    def fake_call(role, provider, model, system, user, timeout_s=45, max_tokens=2000):
        text = answers[role]
        return llm.LLMExchange(role, provider, model, "ph", text, bool(text.strip()),
                               "" if text.strip() else "empty_reply")

    monkeypatch.setattr(llm, "call", fake_call)
    cfg = cfgmod.load()
    sig = sigmod.MarketSignals(762.0, 0.13, 0.145, 0.62)
    view = deskmod.run_desk(sig, ["h1"], "cand", "book", cfg)
    assert view.regime_analyst == "rich"
    assert view.veto is False                       # "false" must not become a veto
    assert view.objection_severity == "high"        # case-normalised
    assert view.size_mult == 0.5                    # high severity halves; no disagreement (second fell back)
    assert any(f.startswith("second_opinion:") for f in view.fallbacks)


# ---- journal: corrupt tail --------------------------------------------------

def test_journal_survives_a_truncated_last_line(tmp_path):
    j = Journal(tmp_path)
    j.append("a", {"x": 1})
    j.append("b", {"y": 2})
    raw = j.path.read_bytes()
    j.path.write_bytes(raw[:-40])                  # a kill mid-write
    ok, msg = Journal(tmp_path).verify_chain()
    assert not ok and "unparseable" in msg           # verify never repairs
    j2 = Journal(tmp_path)
    j2.append("c", {"z": 3})                         # a writer repairs, journaled
    entries = Journal(tmp_path).read_all()
    kinds = [e["kind"] for e in entries]
    assert kinds == ["a", "journal_tail_repaired", "c"]
    assert Journal(tmp_path).verify_chain()[0]
    assert list(tmp_path.glob("desk.jsonl.corrupt-*"))


# ---- management -----------------------------------------------------------

MGMT = {"profit_target_frac": 0.35, "debit_profit_target_frac": 0.60, "realize_min_frac": 0.25,
        "structure_stop_credit_mult": 2.0, "time_stop_dte": 7}


def _put(qty=1, sleeve="core"):
    return {"structure_id": "s1", "kind": "cheap_vol_put", "sleeve": sleeve, "qty": qty,
            "legs_json": json.dumps([{"symbol": "SPY260918P00751000", "qty": 1, "entry_price": 3.66}]),
            "net_credit": -3.66, "status": "open"}


def _chain(mid):
    return {"SPY260918P00751000": {"latestQuote": {"bp": mid - 0.02, "ap": mid + 0.02}}}


def test_realization_policy_needs_a_known_clock_when_windowed():
    """Closed market -> minutes_to_close None -> NOT inside the last hour."""
    [a] = review_book([_put()], _chain(3.66 * 1.42), MGMT, NOW, 0, "2026-09-18",
                      minutes_to_close=None, realize_window_min=60)
    assert a.action == "hold"
    [a] = review_book([_put()], _chain(3.66 * 1.42), MGMT, NOW, 0, "2026-09-18",
                      minutes_to_close=30, realize_window_min=60)
    assert a.action == "close"


@pytest.mark.parametrize("qty", [1, 2, 3])
def test_exit_thresholds_are_qty_invariant(qty):
    [a] = review_book([_put(qty)], _chain(3.66 * 1.65), MGMT, NOW, 1, "2026-09-18")
    assert a.action == "close" and "debit profit target" in a.reason
    assert abs(a.est_pnl - qty * (3.66 * 0.65) * 100) < 1.0 * qty


def test_hedge_sleeve_is_never_profit_taken():
    [a] = review_book([_put(sleeve="hedge")], _chain(3.66 * 1.9), MGMT, NOW, 0, "2026-09-18",
                      derisk_mode=True, minutes_to_close=30, realize_window_min=60)
    assert a.action == "hold" and "hedge" in a.reason


# ---- tick-level: closed market and bad quote --------------------------------

class Args:
    mock = True
    dry_run = True


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    monkeypatch.setenv("THETADESK_DATA_DIR", str(tmp_path))
    import thetadesk.main as m
    return m, tmp_path


def _journal(tmp_path):
    with open(tmp_path / "journal" / "desk.jsonl", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def test_closed_market_tick_settles_and_stops(scratch, monkeypatch):
    m, tmp_path = scratch
    monkeypatch.setattr(m, "make_client", lambda mock: MockAlpacaClient(market_open=False))
    assert m.cmd_tick_locked(Args()) == 0
    kinds = [e["kind"] for e in _journal(tmp_path)]
    assert "market_closed" in kinds and "integrity" in kinds
    assert "marks" not in kinds and "signals" not in kinds and "manage" not in kinds
    assert not list((tmp_path / "snapshots").glob("*.json")) if (tmp_path / "snapshots").exists() else True


def test_one_sided_quote_tick_is_mark_only(scratch, monkeypatch):
    m, tmp_path = scratch

    class HalfQuote(MockAlpacaClient):
        def latest_stock_quote(self, symbol):
            return {"bp": 0.0, "ap": self.spot + 0.01}

    monkeypatch.setattr(m, "make_client", lambda mock: HalfQuote(realized_scale=0.70))
    assert m.cmd_tick_locked(Args()) == 0
    entries = _journal(tmp_path)
    kinds = [e["kind"] for e in entries]
    assert "data_quality" in kinds and "entries_disabled" in kinds
    assert "order_open" not in kinds and "gates" not in kinds
    sig = next(e for e in entries if e["kind"] == "signals")["data"]
    assert abs(sig["spot"] - 650.0) < 5.0            # prev close, not ask/2
    marks = next(e for e in entries if e["kind"] == "marks")
    assert marks["data"]["real"] == 0.0


def test_rehearsal_refuses_live_data_dir(monkeypatch):
    monkeypatch.delenv("THETADESK_DATA_DIR", raising=False)
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    import thetadesk.main as m

    class A:
        mock = False
        dry_run = True
    assert m.cmd_tick(A()) == 3


# ---- DEVLOG #29: one model's doubt must not kill the strategy --------------

def test_data_suspect_needs_both_regime_models(monkeypatch):
    from thetadesk import config as cfgmod
    from thetadesk.agents import desk as deskmod

    def make(analyst_suspect, second_suspect):
        answers = {
            "vol_analyst": '{"regime": "rich", "confidence": 0.8, "data_suspect": %s}'
                           % ("true" if analyst_suspect else "false"),
            "second_opinion": '{"regime": "rich", "confidence": 0.9, "data_suspect": %s}'
                              % ("true" if second_suspect else "false"),
            "news_vetoer": '{"veto": false, "reason": "calm"}',
            "risk_officer": '{"objection": "gap", "severity": "medium"}',
        }
        return lambda role, provider, model, system, user, timeout_s=45, max_tokens=2000: \
            llm.LLMExchange(role, provider, model, "ph", answers[role], True)

    cfg = cfgmod.load()
    sig = sigmod.MarketSignals(762.4, 0.0717, 0.1336, 1.0)
    monkeypatch.setattr(llm, "call", make(True, False))
    one = deskmod.run_desk(sig, ["h"], "cand", "book", cfg)
    assert one.data_suspect is False and one.size_mult == 1.0   # a lone doubt is an opinion
    monkeypatch.setattr(llm, "call", make(True, True))
    both = deskmod.run_desk(sig, ["h"], "cand", "book", cfg)
    assert both.data_suspect is True and both.size_mult == 0.5  # agreed doubt halves size


def test_regime_prompt_forbids_price_level_as_evidence():
    """The first live tick was blocked because a model called SPY at 762
    'outside historical norms' — a training-cutoff artifact, not a data fault."""
    from thetadesk.agents.desk import ANALYST_SYSTEM, SECOND_SYSTEM
    for p in (ANALYST_SYSTEM, SECOND_SYSTEM):
        assert "NEVER evidence of corruption" in p
        assert "clipped" in p.lower()


def test_desk_signal_text_carries_spread_and_ratio(monkeypatch):
    from thetadesk import config as cfgmod
    from thetadesk.agents import desk as deskmod
    seen = {}

    def fake(role, provider, model, system, user, timeout_s=45, max_tokens=2000):
        seen[role] = user
        return llm.LLMExchange(role, provider, model, "ph", '{"regime": "rich"}', True)

    monkeypatch.setattr(llm, "call", fake)
    deskmod.run_desk(sigmod.MarketSignals(762.4, 0.0717, 0.1336, 1.0), ["h"], "c", "b",
                     cfgmod.load())
    assert "vol points" in seen["vol_analyst"] and "iv/rv=1.86x" in seen["vol_analyst"]


def test_marks_never_crash_on_an_underlying_without_a_spot(tmp_path):
    """DEVLOG #29: shadow_nogates recorded a refused QQQ condor; the next tick
    had no QQQ spot and mark_to_model raised, killing the tick AFTER the order
    had been sent. A mark drops what it cannot price; gates still refuse."""
    from thetadesk.engine.contracts import Leg, OptionContract
    from thetadesk.shadow import books
    from thetadesk.state.store import Store

    st = Store(tmp_path / "t.sqlite")
    spy = Leg(OptionContract.parse("SPY260918P00751000"), 1, 3.66)
    qqq = Leg(OptionContract.parse("QQQ260918C00742000"), -1, 1.20)
    books.record_candidate(st, "shadow_nogates", "iron_condor", "core", [spy, qqq], 1, 1.9,
                           structure_id="mixed")
    out = books.mark_all_books(st, {"SPY": 762.0}, NOW,
                               {"SPY260918P00751000": 0.15, "QQQ260918C00742000": 0.15},
                               real_realized=0.0)
    assert out["_unpriced_underlyings"] == ["QQQ"]
    assert isinstance(out["shadow_nogates"], float)      # marked what it could
    st.conn.close()


def test_unfilled_entry_gives_back_the_daily_risk_budget(scratch, monkeypatch):
    """DEVLOG #29c: three condors were sent, one filled, and the daily budget
    stayed charged for all three — the desk locked itself out of the session."""
    m, tmp_path = scratch

    class NeverFills(MockAlpacaClient):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.submitted_ids = []

        def submit_order(self, payload):
            rec = super().submit_order(payload)
            self.submitted_ids.append(payload["client_order_id"])
            return rec

        def order_by_client_id(self, coid):
            for o in self.submitted:
                if o.get("client_order_id") == coid:
                    return {**o, "status": "canceled", "filled_qty": "0"}
            return None

        def positions(self):
            return []

    broker = NeverFills(realized_scale=0.70)
    monkeypatch.setattr(m, "make_client", lambda mock: broker)

    class Live:
        mock = False
        dry_run = False
    monkeypatch.setenv("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    from thetadesk.execution import cli_bridge
    monkeypatch.setattr(cli_bridge, "cli_available", lambda: False)

    assert m.cmd_tick_locked(Live()) == 0                      # tick 1: order sent
    st = m.Store(m.cfgmod.load().db_path)
    charged = st.get_counter(m._today(), "new_risk")
    st.conn.close()
    assert charged > 0                                         # budget committed while working

    # tick 2: the broker confirms the order never filled; the desk gives the
    # budget back and re-proposes, so the charge stays at ONE working order
    assert m.cmd_tick_locked(Live()) == 0
    st = m.Store(m.cfgmod.load().db_path)
    after = st.get_counter(m._today(), "new_risk")
    st.conn.close()
    released = [e for e in _journal(tmp_path) if e["kind"] == "new_risk_released"]
    assert released and abs(released[0]["data"]["risk"] - charged) < 1.0
    # one working order's worth, not two: the re-proposal may be priced a
    # little differently, but the cancelled one is no longer charged
    assert after < charged * 1.5, (
        f"budget charged {after} while only one order (~{charged}) is working")
