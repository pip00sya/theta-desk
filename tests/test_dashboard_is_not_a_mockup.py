"""The console must render the export, not a picture of it.

A dashboard that shows the right numbers because someone typed them is worth
nothing on a submission whose whole claim is that every figure is checkable.
These tests read the page as text and assert that the figures it displays are
nowhere in its source — the only place they can come from is data.json.

They also guard the two bugs a perturbed-data run actually caught: a hardcoded
'+' in front of a signed premium, and a verdict sentence written for the regime
the desk happened to be in on the day the page was authored.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "dashboard" / "web"
PAGE = WEB / "index.html"
DATA = WEB / "data.json"


@pytest.fixture(scope="module")
def page() -> str:
    return PAGE.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def data() -> dict:
    return json.loads(DATA.read_text(encoding="utf-8"))


def _live_figures(d: dict) -> dict[str, str]:
    """Figures a reader sees, in the exact form they would be typed by hand."""
    b, bk, v, c = d["broker"], d["book"], d["verification"], d["counts"]
    out = {
        "broker equity": f"{b['equity']:,.2f}",
        "broker equity, no separators": f"{b['equity']:.2f}",
        "book pnl": f"{bk['pnl']:.2f}",
        "realized": f"{bk['realized']:.2f}",
        "journal entries": f"{v['journal_entries']:,}",
        "journal entries, no separators": str(v["journal_entries"]),
        "ticks": str(c["ticks"]),
        "refusals": str(d["refusals"]["all"]),
        "atm iv": f"{d['signals']['atm_iv']}",
        "rv20": f"{d['signals']['rv20']}",
        "spot": f"{d['signals']['spot']}",
        "portfolio cap": f"{d['limits']['portfolio_cap']:,.2f}",
    }
    # a two- or three-digit count is too short to search for safely
    return {k: s for k, s in out.items() if len(s) >= 4}


def test_no_live_figure_is_written_into_the_page(page: str, data: dict) -> None:
    """None of the numbers on screen appear in the source that draws them."""
    baked = {name: s for name, s in _live_figures(data).items() if s in page}
    assert not baked, (
        "these figures are hardcoded in index.html and would survive a data "
        f"change: {baked}"
    )


def test_the_account_number_is_not_written_into_the_page(page: str, data: dict) -> None:
    assert data["account"] not in page, "the account id is baked into the page"
    assert data["commit"] not in page, "the commit is baked into the page"


def test_the_premium_is_printed_with_its_own_sign(page: str) -> None:
    """A negative premium once rendered as '+-6.19'."""
    assert "'+' + prem" not in page, "the premium prints a hardcoded plus"
    assert "sg2(prem)" in page, "the premium should use the signed formatter"


def test_the_verdict_covers_every_regime(page: str) -> None:
    """Fed a cheap tape the page must not claim the desk is selling premium."""
    verdict = page[page.index("function verdict("):]
    verdict = verdict[:verdict.index("\n}\n")]
    for regime in ("rich", "cheap"):
        assert f"'{regime}'" in verdict, f"the verdict has no branch for a {regime} regime"
    assert "buys convexity" in verdict, "the cheap branch must say what the desk does instead"


def test_every_workspace_reads_from_the_export(page: str) -> None:
    """Each pane function must touch D, the parsed export, somewhere."""
    for pane in ("paneDesk", "panePositions", "paneRules", "paneProof",
                 "chartFrame", "signalBlocks"):
        i = page.index("function " + pane + "(")
        body = page[i:i + 4000]
        assert re.search(r"\bD\.", body), f"{pane} never reads the export"


def test_the_page_falls_back_to_fetching_the_export(page: str) -> None:
    """Served statically there is no host to inject window.__DATA__."""
    assert "window.__DATA__" in page
    assert "fetch('data.json" in page


def test_the_export_carries_everything_the_page_addresses(data: dict) -> None:
    """Every top-level key the console reads exists in the published file."""
    for key in ("broker", "book", "signals", "greeks", "counts", "limits", "refusals",
                "positions", "trades", "series", "gate_defs", "verification", "params",
                "decisions", "kinds", "kv", "account", "commit", "generated_utc"):
        assert key in data, f"the console reads data.{key} and the export does not carry it"
    for key in ("signal", "books", "gates", "desk", "refusals", "manage", "integrity",
                "alt", "daily", "quarantine"):
        assert key in data["series"], f"the console reads series.{key}"
