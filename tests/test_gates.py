import random
from datetime import datetime, timezone

from thetadesk import config as cfgmod
from thetadesk.engine.contracts import Leg, OptionContract, Structure
from thetadesk.engine import gates

ASOF = datetime(2026, 8, 31, 15, 0, tzinfo=timezone.utc)
CFG = cfgmod.load()


def _leg(sym, qty, px):
    return Leg(OptionContract.parse(sym), qty, px)


def _condor(credit_put=1.20, credit_call=1.00):
    return Structure(
        "t1", "iron_condor", "core",
        [
            _leg("SPY260918P00620000", -1, 3.00), _leg("SPY260918P00610000", +1, 3.00 - credit_put),
            _leg("SPY260918C00680000", -1, 2.60), _leg("SPY260918C00690000", +1, 2.60 - credit_call),
        ],
        net_credit=credit_put + credit_call,
    )


def _chain_for(structure, rel_spread=0.04, iv=0.15):
    chain = {}
    for l in structure.legs:
        mid = max(0.10, l.entry_price)
        half = mid * rel_spread / 2
        chain[l.contract.symbol] = {
            "latestQuote": {"bp": round(mid - half, 2), "ap": round(mid + half, 2),
                            "t": ASOF.isoformat()},
            "impliedVolatility": iv,
            "greeks": {"delta": -0.15 if l.contract.right == "P" else 0.15},
        }
    return chain


def _run(structure, qty=1, equity=100_000, hwm=100_000, realized=0.0,
         new_risk_today=0.0, chain=None, mins_open=120.0, mins_close=120.0,
         market_open=True):
    return gates.run_entry_gates(
        structure=structure, qty=qty, chain=chain or _chain_for(structure),
        book_legs=[], spot=650.0, asof=ASOF, equity=equity, high_watermark=hwm,
        realized_gains=realized, new_risk_today=new_risk_today, cfg=CFG,
        minutes_from_open=mins_open, minutes_to_close=mins_close,
        market_open=market_open)


def test_clean_condor_passes_all_gates():
    r = _run(_condor())
    assert r.passed, r.first_failure


def test_g19_rejects_stale_or_untimestamped_feed():
    """DEVLOG #22: feed liveness from the ATM strip, not per leg."""
    from datetime import timedelta
    s = _condor()
    stale = _chain_for(s)
    for v in stale.values():
        v["latestQuote"]["t"] = (ASOF - timedelta(minutes=30)).isoformat()
    r = _run(s, chain=stale)
    assert not r.passed and r.first_failure.gate == "g19_feed_freshness"
    no_t = _chain_for(s)
    for v in no_t.values():
        del v["latestQuote"]["t"]
    r = _run(s, chain=no_t)
    assert not r.passed and r.first_failure.gate == "g19_feed_freshness"
    # a stale far wing must NOT trip it while the ATM strip is live
    wing = _chain_for(s)
    wing["SPY260918C00690000"]["latestQuote"]["t"] = (ASOF - timedelta(hours=2)).isoformat()
    assert _run(s, chain=wing).passed


def test_g2_rejects_foreign_underlying():
    s = Structure("t", "put_credit_spread", "core",
                  [_leg("TSLA260918P00200000", -1, 5.0), _leg("TSLA260918P00190000", +1, 3.0)],
                  net_credit=2.0)
    r = _run(s, chain=_chain_for(s))
    assert not r.passed
    assert any(x.gate == "g2_universe" and not x.passed for x in r.results)


def test_g3_rejects_expiry_inside_judging_window():
    s = Structure("t", "put_credit_spread", "core",
                  [_leg("SPY260911P00620000", -1, 3.0), _leg("SPY260911P00610000", +1, 1.8)],
                  net_credit=1.2)
    r = _run(s, chain=_chain_for(s))
    assert any(x.gate == "g3_expiry" and not x.passed for x in r.results)


def test_g5_rejects_one_sided_quote():
    s = _condor()
    chain = _chain_for(s)
    first = s.legs[0].contract.symbol
    chain[first]["latestQuote"]["bp"] = 0.0
    r = _run(s, chain=chain)
    assert any(x.gate == "g5g6_liquidity" and not x.passed for x in r.results)


def test_g6_rejects_wide_spread():
    s = _condor()
    r = _run(s, chain=_chain_for(s, rel_spread=0.30))
    assert any(x.gate == "g5g6_liquidity" and not x.passed for x in r.results)


def test_g7_rejects_oversized_structure():
    r = _run(_condor(), qty=3)  # 3 * ~780 = 2340 > 1.25% of 100k
    assert any(x.gate == "g7_structure_size" and not x.passed for x in r.results)


def test_g9_daily_budget_blocks():
    r = _run(_condor(), new_risk_today=2400.0)  # 2400 + 780 > 2.5% (2500)
    assert any(x.gate == "g9_daily_budget" and not x.passed for x in r.results)


def test_g10_blocks_open_and_close_windows():
    assert any(x.gate == "g10_time_window" and not x.passed
               for x in _run(_condor(), mins_open=5.0).results)
    assert any(x.gate == "g10_time_window" and not x.passed
               for x in _run(_condor(), mins_close=5.0).results)
    assert any(x.gate == "g10_time_window" and not x.passed
               for x in _run(_condor(), market_open=False).results)


def test_g14_halt_on_drawdown():
    r = _run(_condor(), equity=95_500, hwm=100_000)  # dd 4.5%
    assert any(x.gate == "g14_halt" and not x.passed for x in r.results)


def test_g8_portfolio_budget_with_earned_extension():
    # 8 condors of ~780 = 6240 > 6% base budget (6000): must fail without gains
    book = []
    for i in range(8):
        for l in _condor().legs:
            book.append(Leg(l.contract, l.qty, l.entry_price))
    r = gates.run_entry_gates(
        structure=_condor(), qty=1, chain=_chain_for(_condor()),
        book_legs=book, spot=650.0, asof=ASOF, equity=100_000, high_watermark=100_000,
        realized_gains=0.0, new_risk_today=0.0, cfg=CFG,
        minutes_from_open=120.0, minutes_to_close=120.0, market_open=True)
    assert any(x.gate == "g8_portfolio_worst_case" and not x.passed for x in r.results)
    # with realized gains the earned budget should absorb it
    r2 = gates.run_entry_gates(
        structure=_condor(), qty=1, chain=_chain_for(_condor()),
        book_legs=book, spot=650.0, asof=ASOF, equity=100_000, high_watermark=100_000,
        realized_gains=4000.0, new_risk_today=0.0, cfg=CFG,
        minutes_from_open=120.0, minutes_to_close=120.0, market_open=True)
    g8_2 = next(x for x in r2.results if x.gate == "g8_portfolio_worst_case")
    assert g8_2.passed


def test_g17_event_derisk_blocks_before_nfp():
    nfp_eve = datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc)  # ~10.5h before NFP
    r = gates.run_entry_gates(
        structure=_condor(), qty=1, chain=_chain_for(_condor()),
        book_legs=[], spot=650.0, asof=nfp_eve, equity=100_000, high_watermark=100_000,
        realized_gains=0.0, new_risk_today=0.0, cfg=CFG,
        minutes_from_open=120.0, minutes_to_close=120.0, market_open=True)
    assert any(x.gate == "g17_event_derisk" and not x.passed for x in r.results)


def test_property_random_books_never_pass_beyond_budget():
    """Property test: whatever random condor book we assemble, if g8 passes
    then the payoff worst case is within the (possibly earned) budget."""
    rng = random.Random(1)
    for _ in range(25):
        n = rng.randint(0, 10)
        book = []
        for i in range(n):
            for l in _condor().legs:
                book.append(Leg(l.contract, l.qty, l.entry_price))
        gains = rng.choice([0.0, 1000.0, 4000.0])
        r = gates.run_entry_gates(
            structure=_condor(), qty=1, chain=_chain_for(_condor()),
            book_legs=book, spot=650.0, asof=ASOF, equity=100_000,
            high_watermark=100_000, realized_gains=gains, new_risk_today=0.0,
            cfg=CFG, minutes_from_open=120.0, minutes_to_close=120.0, market_open=True)
        g8 = next(x for x in r.results if x.gate == "g8_portfolio_worst_case")
        budget = min(6000.0 + 0.5 * gains, 8000.0)
        if g8.passed:
            assert -r.payoff.worst_pnl <= budget + 1.0
