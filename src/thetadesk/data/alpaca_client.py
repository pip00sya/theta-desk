"""Thin REST client for Alpaca Trading + Market Data APIs.

Deliberately raw `requests` (no SDK): full control over the exact payloads
(mleg, options snapshots) and a transparent audit trail — every request the
desk makes is visible in one file. Orders still go out through the Alpaca
CLI when available (see execution.cli_bridge); this client is the data path
and the REST fallback.
"""
from __future__ import annotations

import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from ..safety import assert_paper_only

TRADING = "https://paper-api.alpaca.markets"
DATA = "https://data.alpaca.markets"


class AlpacaError(RuntimeError):
    pass


class AlpacaClient:
    def __init__(self, session: requests.Session | None = None):
        assert_paper_only()
        self.s = session or requests.Session()
        self.s.headers.update({
            "APCA-API-KEY-ID": os.environ.get("ALPACA_API_KEY", ""),
            "APCA-API-SECRET-KEY": os.environ.get("ALPACA_SECRET_KEY", ""),
        })

    # -- plumbing ---------------------------------------------------------
    def _req(self, method: str, url: str, *, params: dict | None = None,
             json: dict | None = None, retries: int = 3) -> Any:
        for attempt in range(retries + 1):
            resp = self.s.request(method, url, params=params, json=json, timeout=20)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                wait = float(resp.headers.get("Retry-After", 1.5 * (attempt + 1)))
                time.sleep(wait)
                continue
            if resp.status_code >= 400:
                raise AlpacaError(f"{method} {url} -> {resp.status_code}: {resp.text[:400]}")
            return resp.json() if resp.text else {}
        raise AlpacaError(f"{method} {url}: retries exhausted")

    # -- trading ----------------------------------------------------------
    def account(self) -> dict:
        return self._req("GET", f"{TRADING}/v2/account")

    def clock(self) -> dict:
        return self._req("GET", f"{TRADING}/v2/clock")

    def positions(self) -> list[dict]:
        return self._req("GET", f"{TRADING}/v2/positions")

    def orders(self, status: str = "all", limit: int = 200) -> list[dict]:
        return self._req("GET", f"{TRADING}/v2/orders",
                         params={"status": status, "limit": limit})

    def submit_order(self, payload: dict) -> dict:
        return self._req("POST", f"{TRADING}/v2/orders", json=payload)

    def cancel_order(self, order_id: str) -> None:
        self._req("DELETE", f"{TRADING}/v2/orders/{order_id}")

    def portfolio_history(self, period: str = "1M", timeframe: str = "1D") -> dict:
        return self._req("GET", f"{TRADING}/v2/account/portfolio/history",
                         params={"period": period, "timeframe": timeframe})

    def activities(self, activity_type: str | None = None) -> list[dict]:
        url = f"{TRADING}/v2/account/activities"
        if activity_type:
            url += f"/{activity_type}"
        return self._req("GET", url)

    # -- market data ------------------------------------------------------
    def option_chain(self, underlying: str, expiry: str, feed: str = "indicative") -> dict[str, dict]:
        """Full chain snapshots incl. greeks + IV. Paginates past 1000."""
        out: dict[str, dict] = {}
        token = None
        while True:
            params = {"feed": feed, "expiration_date": expiry, "limit": 1000}
            if token:
                params["page_token"] = token
            j = self._req("GET", f"{DATA}/v1beta1/options/snapshots/{underlying}", params=params)
            out.update(j.get("snapshots") or {})
            token = j.get("next_page_token")
            if not token:
                return out

    def stock_bars_daily(self, symbol: str, days: int = 40) -> list[dict]:
        start = (datetime.now(timezone.utc) - timedelta(days=days * 2)).strftime("%Y-%m-%d")
        j = self._req("GET", f"{DATA}/v2/stocks/{symbol}/bars",
                      params={"timeframe": "1Day", "start": start, "limit": days,
                              "adjustment": "split", "feed": "iex"})
        return j.get("bars") or []

    def latest_stock_quote(self, symbol: str) -> dict:
        j = self._req("GET", f"{DATA}/v2/stocks/{symbol}/quotes/latest",
                      params={"feed": "iex"})
        return j.get("quote") or {}

    def news(self, symbols: str = "SPY", limit: int = 12) -> list[dict]:
        j = self._req("GET", f"{DATA}/v1beta1/news",
                      params={"symbols": symbols, "limit": limit})
        return j.get("news") or []
