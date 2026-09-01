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


def test_neutral_condor_uses_its_own_credit_floor():
    """DEVLOG #17: the widened neutral condor collects less credit than the
    base condor; it must be judged against its own floor, or the branch is dead."""
    entries, _ = _entries(realized_scale=0.70)
    condor = CFG["structures"]["condor"]
    base = sel.build_iron_condor(entries, EXP, condor, "2026-09-01")
    wide = sel.build_iron_condor(entries, EXP, condor, "2026-09-01", widen=0.04,
                                 min_credit_frac=0.0)
    assert base is not None and wide is not None
    assert wide.net_credit < base.net_credit          # wider strikes -> less credit
    # the floor is the only thing that can kill the wide condor
    assert sel.build_iron_condor(entries, EXP, condor, "2026-09-01", widen=0.04,
                                 min_credit_frac=0.99) is None
    # select() routes the neutral regime through the neutral floor
    neutral_score = 0.5 * (CFG["regime"]["vrp_cheap_threshold"]
                           + CFG["regime"]["vrp_rich_threshold"])
    structures = {**CFG["structures"],
                  "condor": {**condor, "neutral_min_credit_frac_of_width": 0.0}}
    cand = sel.select(entries, EXP, neutral_score, structures, CFG["regime"], "2026-09-01")
    assert cand is not None and cand.regime == "neutral" and cand.size_mult == 0.5
    assert cand.structure.structure_id == wide.structure_id
    structures["condor"]["neutral_min_credit_frac_of_width"] = 0.99
    assert sel.select(entries, EXP, neutral_score, structures, CFG["regime"], "2026-09-01") is None


def test_session_date_is_new_york_not_host_local():
    """DEVLOG #18: the host's local midnight (UTC+5) falls an hour before the
    close; day keys must follow the exchange session."""
    from datetime import datetime, timedelta, timezone
    from thetadesk.main import _today
    expect = (datetime.now(timezone.utc) - timedelta(hours=4)).date().isoformat()
    assert _today() == expect


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
