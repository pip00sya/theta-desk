"""Black-Scholes pricing, greeks and IV inversion.

stdlib-only (math.erf) so the reconciler runs with zero heavy deps.
Used for: repricing the book on the payoff grid, sanity-checking broker
greeks, and marking shadow books.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

SQRT_2PI = math.sqrt(2.0 * math.pi)


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def _d1_d2(s: float, k: float, t: float, sigma: float, r: float) -> tuple[float, float]:
    if t <= 0 or sigma <= 0 or s <= 0 or k <= 0:
        raise ValueError("invalid inputs to d1/d2")
    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / (sigma * math.sqrt(t))
    return d1, d1 - sigma * math.sqrt(t)


def intrinsic(s: float, k: float, right: str) -> float:
    return max(0.0, s - k) if right == "C" else max(0.0, k - s)


def price(s: float, k: float, t_years: float, sigma: float, right: str, r: float = 0.04) -> float:
    """European BS price. t<=0 -> intrinsic. Good enough for grid repricing
    of near-dated American index-ETF options (early-exercise premium ~0 here)."""
    if t_years <= 1e-9 or sigma <= 1e-9:
        return intrinsic(s, k, right)
    d1, d2 = _d1_d2(s, k, t_years, sigma, r)
    if right == "C":
        return s * norm_cdf(d1) - k * math.exp(-r * t_years) * norm_cdf(d2)
    return k * math.exp(-r * t_years) * norm_cdf(-d2) - s * norm_cdf(-d1)


@dataclass
class Greeks:
    delta: float
    gamma: float
    theta: float  # per calendar day, per share
    vega: float   # per 1.00 of vol (i.e. per 100 vol points), per share
    rho: float


def greeks(s: float, k: float, t_years: float, sigma: float, right: str, r: float = 0.04) -> Greeks:
    if t_years <= 1e-9 or sigma <= 1e-9:
        d = 1.0 if (right == "C" and s > k) else (-1.0 if (right == "P" and s < k) else 0.0)
        return Greeks(delta=d, gamma=0.0, theta=0.0, vega=0.0, rho=0.0)
    d1, d2 = _d1_d2(s, k, t_years, sigma, r)
    pdf = norm_pdf(d1)
    gamma = pdf / (s * sigma * math.sqrt(t_years))
    vega = s * pdf * math.sqrt(t_years)
    if right == "C":
        delta = norm_cdf(d1)
        theta_y = -(s * pdf * sigma) / (2 * math.sqrt(t_years)) - r * k * math.exp(-r * t_years) * norm_cdf(d2)
        rho = k * t_years * math.exp(-r * t_years) * norm_cdf(d2)
    else:
        delta = norm_cdf(d1) - 1.0
        theta_y = -(s * pdf * sigma) / (2 * math.sqrt(t_years)) + r * k * math.exp(-r * t_years) * norm_cdf(-d2)
        rho = -k * t_years * math.exp(-r * t_years) * norm_cdf(-d2)
    return Greeks(delta=delta, gamma=gamma, theta=theta_y / 365.0, vega=vega, rho=rho)


def implied_vol(target: float, s: float, k: float, t_years: float, right: str,
                r: float = 0.04, lo: float = 0.005, hi: float = 4.0, tol: float = 1e-6) -> float | None:
    """Bisection IV inversion of a mid price. None when price is outside
    no-arb bounds (common on the free indicative feed -> caller must gate)."""
    if t_years <= 0:
        return None
    if target < intrinsic(s, k, right) - 1e-9:
        return None
    if price(s, k, t_years, lo, right, r) > target:
        return None
    if price(s, k, t_years, hi, right, r) < target:
        return None
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        if price(s, k, t_years, mid, right, r) > target:
            hi = mid
        else:
            lo = mid
        if hi - lo < tol:
            break
    return 0.5 * (lo + hi)
