import tempfile
from datetime import date
from pathlib import Path

from thetadesk import config as cfgmod
from thetadesk.audit.journal import Journal
from thetadesk.data.mock_client import MockAlpacaClient
from thetadesk.data.signals import compute, realized_vol
from thetadesk.engine import selector as sel

CFG = cfgmod.load()
EXP = date(2026, 9, 18)


def _entries(realized_scale=0.80):
    c = MockAlpacaClient(realized_scale=realized_scale)
    chain = c.option_chain("SPY", "2026-09-18")
    return sel.parse_chain(chain), c


def test_mock_chain_parses_with_greeks():
    entries, _ = _entries()
    assert len(entries) > 50
    assert all(e.delta is not None for e in entries)


def test_rich_vol_selects_condor():
    entries, c = _entries(realized_scale=0.70)  # IV rich vs RV
    closes = [b["c"] for b in c.stock_bars_daily("SPY", 30)]
    sig = compute(entries, closes, c.spot)
    assert sig.vrp >= CFG["regime"]["vrp_rich_threshold"]
    cand = sel.select(entries, EXP, sig.vrp, CFG["structures"], CFG["regime"], "2026-08-31")
    assert cand is not None and cand.structure.kind == "iron_condor"
    assert cand.regime == "rich" and cand.size_mult == 1.0
    # condor is 4 legs: 2 shorts covered by 2 longs
    assert len(cand.structure.legs) == 4
    assert cand.structure.net_credit > 0
    ml = cand.structure.max_loss
    assert 0 < ml <= 10 * 100  # bounded by wing width


def test_cheap_vol_branch_goes_long_vega():
    entries, c = _entries(realized_scale=1.45)  # RV >> IV -> cheap vol
    closes = [b["c"] for b in c.stock_bars_daily("SPY", 30)]
    sig = compute(entries, closes, c.spot)
    assert sig.vrp < CFG["regime"]["vrp_cheap_threshold"]
    cand = sel.select(entries, EXP, sig.vrp, CFG["structures"], CFG["regime"], "2026-08-31")
    assert cand is not None and cand.structure.kind == "cheap_vol_put"
    assert cand.structure.legs[0].qty > 0  # long
    assert cand.size_mult == 0.25


def test_hedge_builder_targets_low_delta_put():
    entries, _ = _entries()
    h = sel.build_hedge_put(entries, EXP, CFG["structures"]["hedge"], "2026-08-31")
    assert h is not None
    leg = h.legs[0]
    assert leg.contract.right == "P" and leg.qty == 1
    e = next(x for x in entries if x.symbol == leg.contract.symbol)
    assert abs(abs(e.delta) - 0.05) < 0.04


def test_realized_vol_sane():
    c = MockAlpacaClient()
    closes = [b["c"] for b in c.stock_bars_daily("SPY", 30)]
    rv = realized_vol(closes, 20)
    assert 0.02 < rv < 0.60


def test_journal_chain_verifies_and_detects_tampering():
    with tempfile.TemporaryDirectory() as td:
        j = Journal(Path(td))
        j.append("a", {"x": 1})
        j.append("b", {"y": [1, 2]})
        j.append("c", {"z": "тест"})
        ok, msg = j.verify_chain()
        assert ok, msg
        # tamper with line 2
        lines = j.path.read_text(encoding="utf-8").splitlines()
        lines[1] = lines[1].replace('"y": [1, 2]', '"y": [9, 9]')
        j.path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        ok2, msg2 = Journal(Path(td)).verify_chain()
        assert not ok2
