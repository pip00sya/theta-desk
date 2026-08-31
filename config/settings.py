"""Central configuration for THETA DESK.

Every threshold that a risk gate uses lives here, in one place, with the
RED-TEAM patched values. Env vars override for ops; code never hardcodes
a risk number outside this file.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


@dataclass(frozen=True)
class Settings:
    # --- identity / endpoints -------------------------------------------------
    paper_host: str = "paper-api.alpaca.markets"
    trading_base: str = _env("APCA_API_BASE_URL", "https://paper-api.alpaca.markets")
    data_base: str = "https://data.alpaca.markets"
    api_key: str = _env("ALPACA_API_KEY", "")
    secret_key: str = _env("ALPACA_SECRET_KEY", "")
    feed: str = "indicative"  # free options feed; greeks+IV included regardless

    # --- mock / dry modes -----------------------------------------------------
    mock: bool = _env("THETA_MOCK", "0") == "1"      # synthetic data, no network
    dry_run: bool = _env("THETA_DRY", "0") == "1"    # full pipeline, no order submit

    # --- universe & calendar (RED-TEAM P3: judging horizon = deadline + 14d) --
    underlyings: tuple[str, ...] = ("SPY", "QQQ")
    hedge_underlying: str = "SPY"
    submission_deadline: date = date(2026, 9, 4)
    judging_horizon: date = date(2026, 9, 18)        # all payoff math uses this
    min_expiry: date = date(2026, 9, 18)             # gate #3: never expire before this
    target_expiry: date = date(2026, 9, 18)          # monthly, most liquid

    # --- account --------------------------------------------------------------
    starting_equity: float = 100_000.0

    # --- risk gates (RED-TEAM patched values) ---------------------------------
    per_structure_risk_pct: float = 0.0125   # gate #7: max loss per structure <= 1.25% equity
    portfolio_worst_case_pct: float = 0.06   # gate #8 base: 6% of equity
    earned_budget_bonus_cap: float = 0.02    # up to +2% from realized gains (=> 8% max)
    earned_budget_factor: float = 0.5        # +0.5 * realized_gain_pct
    daily_new_risk_pct: float = 0.025        # gate #9: 2.5%/day of new worst-case risk
    max_rel_spread: float = 0.08             # gate #6: leg spread <= 8% of mid
    min_credit_frac_of_width: float = 0.25   # credit >= 25% of spread width
    short_delta_target: float = 0.17         # short strikes near 15-20 delta
    short_delta_band: tuple[float, float] = (0.12, 0.22)
    hedge_delta_target: float = 0.05
    hedge_premium_budget_pct: float = 0.006  # <= 0.6% equity total hedge premium
    spread_width: float = 10.0               # $10 wide for SPY, scaled for QQQ
    profit_target_frac: float = 0.35         # gate #12 patched: 35% of max profit
    realization_min_frac: float = 0.25       # daily realization policy threshold
    structure_stop_credit_mult: float = 2.0  # gate #13: loss >= 2x credit -> close
    time_stop_dte: int = 7                   # gate #11
    drawdown_halt_pct: float = 0.04          # gate #14 patched: HALT (not flatten)
    session_edge_minutes: int = 15           # gate #10: skip first/last 15 min
    payoff_grid_lo: float = 0.80             # +-20% grid
    payoff_grid_hi: float = 1.20
    payoff_grid_step: float = 0.005
    iv_crash_beta: float = 2.0               # IV up-scaling on down moves in stress
    risk_free_rate: float = 0.04

    # --- event de-risk (RED-TEAM P2: gate #17) --------------------------------
    events_file: str = "config/events.yaml"
    derisk_worst_case_pct: float = 0.025     # shrink book to <=2.5% before events

    # --- execution ------------------------------------------------------------
    fill_wait_minutes: int = 10
    reprice_credit_frac: float = 0.15        # one retry, 15% of credit worse
    mid_margin_frac: float = 0.10            # initial limit: mid minus 10% of half-spread

    # --- LLM layer ------------------------------------------------------------
    anthropic_key: str = _env("ANTHROPIC_API_KEY", "")
    anthropic_model: str = _env("THETA_CLAUDE_MODEL", "claude-sonnet-5")
    featherless_key: str = _env("FEATHERLESS_API_KEY", "")
    featherless_base: str = _env("FEATHERLESS_BASE", "https://api.featherless.ai/v1")
    featherless_model: str = _env("THETA_FEATHERLESS_MODEL", "Qwen/Qwen2.5-72B-Instruct")

    # --- modes ----------------------------------------------------------------
    post_submission: bool = _env("THETA_POST_SUBMISSION", "0") == "1"  # manage-only

    # --- storage --------------------------------------------------------------
    data_dir: str = _env("THETA_DATA_DIR", "data")
    db_path: str = field(default="")

    def __post_init__(self):
        object.__setattr__(self, "db_path", os.path.join(self.data_dir, "thetadesk.sqlite"))


SETTINGS = Settings()
