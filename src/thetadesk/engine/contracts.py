"""OCC option symbology + Leg / Structure models shared across the desk."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

OCC_RE = re.compile(r"^([A-Z]{1,6})(\d{6})([CP])(\d{8})$")
MULTIPLIER = 100


@dataclass(frozen=True)
class OptionContract:
    symbol: str          # e.g. SPY260918P00620000
    underlying: str
    expiry: date
    right: str           # "C" | "P"
    strike: float

    @classmethod
    def parse(cls, symbol: str) -> "OptionContract":
        m = OCC_RE.match(symbol.strip().upper())
        if not m:
            raise ValueError(f"not an OCC option symbol: {symbol!r}")
        root, ymd, right, strike = m.groups()
        return cls(
            symbol=symbol.strip().upper(),
            underlying=root,
            expiry=date(2000 + int(ymd[:2]), int(ymd[2:4]), int(ymd[4:6])),
            right=right,
            strike=int(strike) / 1000.0,
        )


def occ_symbol(underlying: str, expiry: date, right: str, strike: float) -> str:
    return f"{underlying.upper()}{expiry:%y%m%d}{right}{int(round(strike * 1000)):08d}"


@dataclass
class Leg:
    """One option leg with signed quantity: +N long, -N short."""
    contract: OptionContract
    qty: int                      # signed
    entry_price: float            # per share (option premium), >= 0

    @property
    def is_long(self) -> bool:
        return self.qty > 0

    def t_years(self, asof: datetime) -> float:
        exp_dt = datetime(self.contract.expiry.year, self.contract.expiry.month,
                          self.contract.expiry.day, 20, 0, tzinfo=timezone.utc)
        return max(0.0, (exp_dt - asof).total_seconds() / (365.0 * 86400.0))


@dataclass
class Structure:
    """A tradeable unit of the book (condor, spread, hedge put, calendar)."""
    structure_id: str
    kind: str                     # iron_condor | put_credit_spread | hedge_put | calendar
    sleeve: str                   # core | hedge
    legs: list[Leg]
    net_credit: float             # per share; >0 means we received premium
    opened_utc: str = ""
    status: str = "pending"       # pending | open | closed | rejected
    closed_pnl: float | None = None

    @property
    def max_loss(self) -> float:
        """Defined-risk worst case in dollars for ONE unit set of legs.
        Computed structurally (width - credit) for verticals/condors;
        for long structures it's the debit paid."""
        puts = sorted([l for l in self.legs if l.contract.right == "P"], key=lambda l: l.contract.strike)
        calls = sorted([l for l in self.legs if l.contract.right == "C"], key=lambda l: l.contract.strike)

        def side_width(side: list[Leg]) -> float:
            shorts = [l for l in side if l.qty < 0]
            longs = [l for l in side if l.qty > 0]
            if not shorts:
                return 0.0
            if not longs:
                raise ValueError("naked short leg in defined-risk structure")
            return max(abs(s.contract.strike - lg.contract.strike)
                       for s in shorts for lg in longs)

        w = max(side_width(puts), side_width(calls))
        n = max(abs(l.qty) for l in self.legs)
        if w > 0:
            return (w - self.net_credit) * MULTIPLIER * n
        # net-long structure: risk = debit paid
        return max(0.0, -self.net_credit) * MULTIPLIER * n
