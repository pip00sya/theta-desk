"""Gate orchestrator — every entry decision passes this wall of pure Python.

LLMs never see this module's inputs or outputs before the fact; they cannot
talk their way past a gate. Each GateResult is journaled, pass or fail.

Gate numbering follows PLAN.md §4.5 as patched by RED-TEAM.md §3.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from statistics import median

from ..config import Config, MacroEvent
from .contracts import Leg, OptionContract, Structure
from .ladder import Tier, fixed_tier
from .liquidity import check_quote
from .payoff import PayoffResult, portfolio_worst_case


@dataclass
class GateResult:
    gate: str
    passed: bool
    reason: str
    data: dict = field(default_factory=dict)


@dataclass
class GateReport:
    results: list[GateResult]
    payoff: PayoffResult | None = None

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.results)

    @property
    def first_failure(self) -> GateResult | None:
        return next((r for r in self.results if not r.passed), None)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            # r.data carries the operands a gate compared — the measured value
            # and the limit it was measured against. Dropping it meant the
            # journal recorded that a gate fired but never by how much.
            "results": [{"gate": r.gate, "passed": r.passed, "reason": r.reason,
                         "data": r.data or None} for r in self.results],
            "worst_case": None if not self.payoff else {
                "pnl": self.payoff.worst_pnl,
                "spot_rel": self.payoff.worst_spot_rel,
                "scenario": self.payoff.worst_scenario,
            },
        }


def g2_universe(s: Structure, allowed: list[str]) -> GateResult:
    bad = {l.contract.underlying for l in s.legs} - set(allowed)
    return GateResult("g2_universe", not bad,
                      "ok" if not bad else f"underlying(s) {sorted(bad)} outside {allowed}")


def g3_expiry(s: Structure, min_expiry: str, asof: datetime | None = None,
              min_dte: int = 0) -> GateResult:
    """Patched: every leg expires on/after min_expiry (judging-horizon safe).
    DEVLOG #26: and at least min_dte days out — otherwise the DTE<7 time stop
    would close a fresh entry on the very next tick (post-deadline churn:
    open at DTE 6, close at DTE 6, pay the spread, repeat until expiry)."""
    early = [l.contract.symbol for l in s.legs if l.contract.expiry.isoformat() < min_expiry]
    if early:
        return GateResult("g3_expiry", False, f"legs expire before {min_expiry}: {early}")
    if asof is not None and min_dte:
        short = [f"{l.contract.symbol} ({(l.contract.expiry - asof.date()).days}d)"
                 for l in s.legs if (l.contract.expiry - asof.date()).days < min_dte]
        if short:
            return GateResult("g3_expiry", False,
                              f"legs inside {min_dte} DTE — the time stop would close them next tick: {short}")
    return GateResult("g3_expiry", True, "ok")


def g4_defined_risk(s: Structure) -> GateResult:
    try:
        ml = s.max_loss
    except ValueError as e:
        return GateResult("g4_defined_risk", False, str(e))
    return GateResult("g4_defined_risk", ml >= 0, f"max structural loss ${ml:,.0f}",
                      {"max_loss": ml})


def g5_g6_liquidity(s: Structure, chain: dict[str, dict], max_rel_spread: float,
                    max_abs_spread: float = 0.0) -> list[GateResult]:
    out = []
    for leg in s.legs:
        snap = chain.get(leg.contract.symbol)
        qc = check_quote(snap or {}, max_rel_spread, max_abs_spread)
        out.append(GateResult("g5g6_liquidity", qc.ok,
                              f"{leg.contract.symbol}: {qc.reason}",
                              {"bid": qc.bid, "ask": qc.ask, "rel_spread": qc.rel_spread,
                               "abs_spread": qc.abs_spread}))
    return out


def g19_feed_freshness(chain: dict[str, dict], spot: "float | dict[str, float]",
                       asof: datetime, max_age_min: float, n: int = 20) -> GateResult:
    """DEVLOG #22: is the quote feed alive? Median age of the n two-sided
    quotes nearest the money must be under max_age_min. Deliberately NOT
    per-leg: a far wing legitimately goes minutes without a quote change;
    the ATM strip does not. Fail-closed when the feed carries no timestamps."""
    ages: list[tuple[float, float]] = []
    two_sided = 0
    for sym, s in chain.items():
        q = s.get("latestQuote") or {}
        if not (float(q.get("bp") or 0) > 0 and float(q.get("ap") or 0) > 0):
            continue
        two_sided += 1
        if not q.get("t"):
            continue
        try:
            c = OptionContract.parse(sym)
            sp = spot.get(c.underlying) if isinstance(spot, dict) else float(spot)
            if not sp:
                continue
            t = datetime.fromisoformat(str(q["t"]).replace("Z", "+00:00"))
        except ValueError:
            continue
        ages.append((abs(c.strike - sp), (asof - t).total_seconds() / 60))
    if two_sided == 0:
        return GateResult("g19_feed_freshness", False, "no two-sided quotes in chain")
    if not ages:
        return GateResult("g19_feed_freshness", False,
                          f"{two_sided} two-sided quotes but none timestamped — feed not trusted")
    ages.sort()
    med = median(a for _, a in ages[:n])
    return GateResult("g19_feed_freshness", med <= max_age_min,
                      f"ATM-{min(n, len(ages))} median quote age {med:.1f}m vs {max_age_min}m",
                      {"median_age_min": med})


def g7_structure_size(s: Structure, qty: int, equity: float, frac: float) -> GateResult:
    risk = s.max_loss * qty / max(abs(l.qty) for l in s.legs)
    limit = equity * frac
    return GateResult("g7_structure_size", risk <= limit + 1e-6,
                      f"structure risk ${risk:,.0f} vs limit ${limit:,.0f} ({frac:.2%} eq)",
                      {"risk": risk, "limit": limit})


def g8_portfolio_worst_case(book_legs: list[Leg], cand_legs: list[Leg],
                            spot: "float | dict[str, float]",
                            asof: datetime, horizon: datetime, iv_map: dict[str, float],
                            equity: float, cfg: Config,
                            realized_gains: float,
                            base_frac: float | None = None,
                            cap_frac: float | None = None) -> tuple[GateResult, PayoffResult]:
    """base_frac / cap_frac come from the size ladder's rung (DEVLOG #36);
    absent, the risk.* constants apply — the desk as it was."""
    r = cfg["risk"]
    if base_frac is None:
        base_frac = r["portfolio_worst_case_frac"]
    if cap_frac is None:
        cap_frac = r["portfolio_worst_case_cap"]
    base = equity * base_frac
    earned = realized_gains * r["earned_budget_gain_mult"] if realized_gains > 0 else 0.0
    budget = min(base + earned, equity * cap_frac)
    res = portfolio_worst_case(
        book_legs + cand_legs, spot, asof, horizon, iv_map,
        grid_low=r["price_grid_low"], grid_high=r["price_grid_high"],
        grid_step=r["price_grid_step"], vol_shock_up_rel=r["vol_shock_up_rel"],
        r=r["risk_free_rate"],
    )
    ok = -res.worst_pnl <= budget + 1e-6
    return GateResult(
        "g8_portfolio_worst_case", ok,
        f"book worst case ${-res.worst_pnl:,.0f} at {res.worst_spot_rel:.0%} spot "
        f"({res.worst_scenario}) vs budget ${budget:,.0f}"
        + (f" (earned +${earned:,.0f})" if earned else ""),
        {"worst_pnl": res.worst_pnl, "budget": budget},
    ), res


def g9_daily_budget(new_risk_today: float, cand_risk: float, equity: float, frac: float) -> GateResult:
    limit = equity * frac
    total = new_risk_today + cand_risk
    return GateResult("g9_daily_budget", total <= limit + 1e-6,
                      f"today's new risk ${total:,.0f} vs limit ${limit:,.0f}",
                      {"new_risk_today": new_risk_today, "cand_risk": cand_risk, "limit": limit})


def g10_time_window(now_et_minutes_from_open: float | None, minutes_to_close: float | None,
                    first: int, last: int, market_open: bool) -> GateResult:
    if not market_open:
        return GateResult("g10_time_window", False, "market closed")
    if now_et_minutes_from_open is not None and now_et_minutes_from_open < first:
        return GateResult("g10_time_window", False,
                          f"first {first} min of session (t+{now_et_minutes_from_open:.0f}m)")
    if minutes_to_close is not None and minutes_to_close < last:
        return GateResult("g10_time_window", False,
                          f"last {last} min of session ({minutes_to_close:.0f}m to close)")
    return GateResult("g10_time_window", True, "ok")


def g14_halt(equity: float, high_watermark: float, frac: float) -> GateResult:
    """Patched: drawdown -> HALT new risk (never panic-flatten)."""
    if high_watermark <= 0:
        return GateResult("g14_halt", True, "no watermark yet")
    dd = 1.0 - equity / high_watermark
    return GateResult("g14_halt", dd < frac,
                      f"drawdown {dd:.2%} vs halt at {frac:.2%} "
                      + ("(HALT MODE: managing only)" if dd >= frac else "(ok)"),
                      {"drawdown": dd, "hwm": high_watermark, "frac": frac})


def g18_sleeve_budget(structure: Structure, qty: int, open_sleeve_debit: float,
                      equity: float, frac: float, realized_gains: float = 0.0,
                      gain_mult: float = 0.5, cap_frac: float = 0.025) -> GateResult:
    """DEVLOG #15: without a sleeve cap the cheap-vol branch can add one
    micro put per strike per day forever (min-viable-qty floors each at 1).
    Total open long-premium debit is capped as a fraction of equity.
    DEVLOG #16: the cap is EARNED-scaled like g8 — realized gains extend it
    (base + 0.5x gains, hard ceiling 2.5%). Winners compound only out of
    banked profit, never out of fresh risk appetite."""
    if structure.net_credit > 0:
        return GateResult("g18_sleeve_budget", True, "credit structure — n/a")
    cand_debit = abs(structure.net_credit) * 100 * qty
    earned = realized_gains * gain_mult if realized_gains > 0 else 0.0
    limit = min(equity * frac + earned, equity * cap_frac)
    total = open_sleeve_debit + cand_debit
    return GateResult("g18_sleeve_budget", total <= limit + 1e-6,
                      f"long-premium sleeve ${total:,.0f} vs cap ${limit:,.0f}"
                      + (f" (earned +${earned:,.0f})" if earned else ""),
                      {"open_debit": open_sleeve_debit, "cand_debit": cand_debit, "limit": limit})


def g17_event_derisk(now: datetime, events: list[MacroEvent], hours_before: int) -> GateResult:
    for e in events:
        if e.klass != "high":
            continue
        if timedelta(0) <= e.utc - now <= timedelta(hours=hours_before):
            return GateResult("g17_event_derisk", False,
                              f"{e.name} in {(e.utc - now).total_seconds() / 3600:.1f}h — no new risk")
    return GateResult("g17_event_derisk", True, "no high-class event inside window")


def run_entry_gates(
    *, structure: Structure, qty: int, chain: dict[str, dict],
    book_legs: list[Leg], spot: "float | dict[str, float]", asof: datetime,
    equity: float, high_watermark: float, realized_gains: float,
    new_risk_today: float, cfg: Config,
    minutes_from_open: float | None, minutes_to_close: float | None, market_open: bool,
    open_sleeve_debit: float = 0.0,
    tier: Tier | None = None,
) -> GateReport:
    """Full wall, ordered cheap -> expensive. Stops nothing early on purpose:
    ALL gate results are computed and journaled so refusals are explainable.

    `tier` is the size ladder's rung for this tick (DEVLOG #36): it supplies
    the fractions gates #7, #8 and #9 measure against. Without one the
    risk.* constants apply, which is the ladder's own disabled state."""
    r = cfg["risk"]
    if tier is None:
        tier = fixed_tier(r)
    results: list[GateResult] = []
    results.append(g2_universe(structure, cfg.underlyings))
    m = cfg["management"]
    results.append(g3_expiry(structure, cfg.min_expiry, asof,
                             int(m.get("min_entry_dte", m["time_stop_dte"] + 3))))
    results.append(g4_defined_risk(structure))
    results.extend(g5_g6_liquidity(structure, chain, cfg["liquidity"]["max_rel_spread"],
                                   cfg["liquidity"].get("max_abs_spread", 0.0)))
    results.append(g19_feed_freshness(chain, spot, asof,
                                      cfg["liquidity"].get("max_quote_age_min", 10)))
    results.append(g7_structure_size(structure, qty, equity, tier.per_structure))

    cand_risk = 0.0
    try:
        cand_risk = structure.max_loss * qty / max(abs(l.qty) for l in structure.legs)
    except ValueError:
        pass
    results.append(g9_daily_budget(new_risk_today, cand_risk, equity, tier.daily_new))
    results.append(g10_time_window(minutes_from_open, minutes_to_close,
                                   cfg["timing"]["no_trade_first_min"],
                                   cfg["timing"]["no_trade_last_min"], market_open))
    results.append(g14_halt(equity, high_watermark, r["drawdown_halt_frac"]))
    results.append(g17_event_derisk(asof, cfg.events(), cfg["events"]["derisk_hours_before"]))
    results.append(g18_sleeve_budget(structure, qty, open_sleeve_debit, equity,
                                     r.get("cheap_sleeve_budget_frac", 0.015),
                                     realized_gains=realized_gains,
                                     gain_mult=r["earned_budget_gain_mult"],
                                     cap_frac=r.get("cheap_sleeve_budget_cap", 0.025)))

    iv_map = {sym: (s.get("impliedVolatility") or 0.20) for sym, s in chain.items()}
    cand_legs = [Leg(l.contract, l.qty * qty, l.entry_price) for l in structure.legs]
    g8, payoff = g8_portfolio_worst_case(book_legs, cand_legs, spot, asof,
                                         cfg.judging_horizon, iv_map, equity, cfg,
                                         realized_gains,
                                         base_frac=tier.book_base, cap_frac=tier.book_cap)
    results.append(g8)
    return GateReport(results=results, payoff=payoff)
