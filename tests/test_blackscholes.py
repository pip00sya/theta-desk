import math

from thetadesk.engine import blackscholes as bs


def test_put_call_parity():
    s, k, t, sigma, r = 650.0, 640.0, 0.06, 0.15, 0.04
    c = bs.price(s, k, t, sigma, "C", r)
    p = bs.price(s, k, t, sigma, "P", r)
    assert abs((c - p) - (s - k * math.exp(-r * t))) < 1e-6


def test_atm_call_reasonable():
    # ATM ~3wk 15 vol on a 650 underlying: roughly s*sigma*sqrt(t/2pi)
    c = bs.price(650, 650, 21 / 365, 0.15, "C", 0.0)
    approx = 650 * 0.15 * math.sqrt(21 / 365) * 0.3989
    assert abs(c - approx) / approx < 0.05


def test_expiry_is_intrinsic():
    assert bs.price(650, 640, 0.0, 0.15, "C") == 10.0
    assert bs.price(650, 660, 0.0, 0.15, "C") == 0.0
    assert bs.price(650, 660, 0.0, 0.15, "P") == 10.0


def test_delta_signs_and_bounds():
    g_call = bs.greeks(650, 650, 0.06, 0.15, "C")
    g_put = bs.greeks(650, 650, 0.06, 0.15, "P")
    assert 0.4 < g_call.delta < 0.65
    assert -0.6 < g_put.delta < -0.35
    assert g_call.gamma > 0 and g_put.gamma > 0
    assert g_call.theta < 0 and g_put.theta < 0
    assert g_call.vega > 0


def test_iv_roundtrip():
    s, k, t, r = 650.0, 630.0, 0.08, 0.04
    for true_iv in (0.10, 0.18, 0.35):
        px = bs.price(s, k, t, true_iv, "P", r)
        got = bs.implied_vol(px, s, k, t, "P", r)
        assert got is not None
        assert abs(got - true_iv) < 1e-4


def test_iv_rejects_below_intrinsic():
    assert bs.implied_vol(5.0, 650, 660, 0.08, "P") is None  # intrinsic=10 > 5
