"""DEVLOG #37 — size that the gates allowed but a model kept withholding.

Three findings from the Sep 4 session, each with its rule:
  * the risk officer rated 52 of 53 meetings 'high' and every entry went out
    at a third of the rung — a lone 'high' is now recorded, not enforced;
  * every candidate was QQQ because SPY sat cents under the credit floor, and
    the book stacked four condors on one name — concentration is now a cap
    the rotation reads, not an argument the officer has to keep making;
  * a fourth condor's short call landed on a strike an earlier condor was
    long, and the broker refused the package — opposite-side overlap is
    detected before the order exists.
"""
from __future__ import annotations

import json

from thetadesk.agents.desk import DeskView
from thetadesk.engine.contracts import Leg, OptionContract
from thetadesk.engine.selector import clashing_legs
from test_session_sim import (AutoBroker, Manage, condor_lots, invariants, kinds,  # noqa: F401
                              pause, rows, seed_record, sim, tick)
from test_tick_flow import _journal


def _view(**kw) -> DeskView:
    base = dict(regime_analyst="rich", regime_second="rich", disagreement=False, veto=False,
                veto_reason="", objection="x", objection_severity="low", disagreement_mult=0.5)
    base.update(kw)
    return DeskView(**base)


def test_objection_resizes_only_when_corroborated():
    assert _view(objection_severity="high").size_mult == 1.0                       # alone: an opinion
    assert _view(objection_severity="high", disagreement=True).size_mult == 0.25   # readers disagree
    assert _view(objection_severity="high", data_suspect=True).size_mult == 0.25   # feed doubted
    assert _view(objection_severity="medium", disagreement=True).size_mult == 0.5  # disagreement alone
    d = _view(objection_severity="high").to_dict()
    assert d["objection_applied"] is False and d["size_mult"] == 1.0              # journaled either way


def test_opposite_side_overlap_is_a_clash_same_side_is_not():
    c = lambda s: OptionContract.parse(s)  # noqa: E731
    book = [Leg(c("QQQ260918C00742000"), +1, 1.0), Leg(c("QQQ260918C00732000"), -1, 2.0)]
    cand = [Leg(c("QQQ260918C00742000"), -1, 1.1), Leg(c("QQQ260918C00752000"), +1, 0.5)]
    assert clashing_legs(book, cand) == ["QQQ260918C00742000"]
    same = [Leg(c("QQQ260918C00732000"), -1, 2.1), Leg(c("QQQ260918C00742000"), +1, 1.0)]
    assert clashing_legs(book, same) == []
    assert clashing_legs([], cand) == []


def test_a_lone_high_objection_no_longer_holds_the_rung_at_one_lot(sim, monkeypatch):
    """The fixture's desk has no keys, so every role falls back and the
    officer's severity is 'low'. Force 'high' the way Sep 4 saw it, without
    disagreement: the rung's three lots must go out, not one."""
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)
    import thetadesk.agents.desk as deskmod
    real = deskmod.run_desk

    def hostile(*a, **k):
        v = real(*a, **k)
        v.objection_severity = "high"
        return v
    monkeypatch.setattr(m, "run_desk", hostile)
    tick(m, broker)
    d = [e["data"] for e in _journal(cfg) if e["kind"] == "desk"][-1]
    assert d["objection_severity"] == "high" and d["objection_applied"] is False
    assert d["size_mult"] == 1.0
    assert condor_lots(m, cfg) == [3]


def test_concentration_cap_stops_stacking_one_name(sim, monkeypatch):
    m, broker, cfg = sim
    seed_record(m, cfg, n=5, pnl_each=60.0, hwm=100_000)
    monkeypatch.setitem(cfg.raw["sizing"], "max_core_per_underlying", 1)
    for i in range(4):
        tick(m, broker)
        broker.settle()
        pause(m, broker)
        broker.spot += 0.5 * (i + 1)          # fresh strikes, fresh ids
    st = rows(m, cfg, kind="iron_condor")
    unds = sorted({OptionContract.parse(json.loads(s["legs_json"])[0]["symbol"]).underlying
                   for s in st if s["status"] in ("open", "pending", "closing")})
    assert unds == ["IWM", "QQQ", "SPY"]                  # one per name, then nothing
    assert len([s for s in st if s["status"] in ("open", "pending", "closing")]) == 3
    caps = [e["data"] for e in _journal(cfg)
            if e["kind"] == "alt_underlying_none" and "concentration cap" in str(e["data"].get("reason"))]
    assert len(caps) >= 3                                 # the fourth tick was refused on every name
    assert "no_candidate" in kinds(cfg)
    invariants(m, broker, cfg)
