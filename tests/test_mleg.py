import pytest

from thetadesk.engine.contracts import Leg, OptionContract, Structure
from thetadesk.execution import mleg
from thetadesk.execution.idempotency import client_order_id


def _leg(sym, qty, px):
    return Leg(OptionContract.parse(sym), qty, px)


def _spread():
    return Structure("s1", "put_credit_spread", "core",
                     [_leg("SPY260918P00620000", -1, 3.00),
                      _leg("SPY260918P00610000", +1, 1.80)],
                     net_credit=1.20)


def test_open_payload_shape():
    p = mleg.build_mleg_payload(_spread(), 2, 1.20, "cid-1")
    assert p["order_class"] == "mleg"
    assert p["qty"] == "2"
    assert p["type"] == "limit"
    assert p["time_in_force"] == "day"
    assert len(p["legs"]) == 2
    short = next(l for l in p["legs"] if l["symbol"] == "SPY260918P00620000")
    assert short["side"] == "sell" and short["position_intent"] == "sell_to_open"
    long = next(l for l in p["legs"] if l["symbol"] == "SPY260918P00610000")
    assert long["side"] == "buy" and long["position_intent"] == "buy_to_open"


def test_credit_open_wire_price_is_negative():
    """DEVLOG #12: Alpaca sign convention — negative limit = credit received.
    Opening a credit spread asking for 1.20 must go out as -1.20."""
    p = mleg.build_mleg_payload(_spread(), 1, 1.20, "cid-sign-1")
    assert p["limit_price"] == "-1.20"


def test_credit_close_wire_price_is_positive():
    """Closing a credit structure means paying a debit -> positive wire price."""
    p = mleg.build_mleg_payload(_spread(), 1, 0.60, "cid-sign-2", closing=True)
    assert p["limit_price"] == "0.60"


def test_debit_structure_signs():
    debit = Structure("d1", "custom_debit", "core",
                      [_leg("SPY260918P00620000", +1, 3.00),
                       _leg("SPY260918P00610000", -1, 1.80)],
                      net_credit=-1.20)   # net long: we pay
    po = mleg.build_mleg_payload(debit, 1, 1.20, "cid-sign-3")
    assert po["limit_price"] == "1.20"    # opening: pay debit -> positive
    pc = mleg.build_mleg_payload(debit, 1, 0.90, "cid-sign-4", closing=True)
    assert pc["limit_price"] == "-0.90"   # closing: receive -> negative


def test_close_payload_flips_sides():
    p = mleg.build_mleg_payload(_spread(), 1, 0.60, "cid-2", closing=True)
    short = next(l for l in p["legs"] if l["symbol"] == "SPY260918P00620000")
    assert short["side"] == "buy" and short["position_intent"] == "buy_to_close"


def test_ratio_must_be_lowest_terms():
    s = Structure("s2", "custom", "core",
                  [_leg("SPY260918P00620000", -2, 3.00),
                   _leg("SPY260918P00610000", +4, 1.80)],
                  net_credit=1.0)
    with pytest.raises(mleg.MlegValidationError):
        mleg.build_mleg_payload(s, 1, 1.0, "cid-3")


def test_leg_count_bounds():
    one = Structure("s3", "x", "core", [_leg("SPY260918P00620000", +1, 1.0)], net_credit=-1.0)
    with pytest.raises(mleg.MlegValidationError):
        mleg.build_mleg_payload(one, 1, 1.0, "cid-4")


def test_client_order_id_deterministic_and_attempt_scoped():
    a = client_order_id("struct-1", "2026-08-31", 1)
    b = client_order_id("struct-1", "2026-08-31", 1)
    c = client_order_id("struct-1", "2026-08-31", 2)
    assert a == b != c
    assert a.startswith("td-") and len(a) <= 48
