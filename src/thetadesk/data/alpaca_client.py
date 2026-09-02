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


def _retry_after_seconds(header: str | None, default: float) -> float:
    """Retry-After may be seconds or an HTTP-date (RFC 7231); never crash on it."""
    if not header:
        return default
    try:
        return min(float(header), 30.0)
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime
        delta = (parsedate_to_datetime(header) - datetime.now(timezone.utc)).total_seconds()
        return max(0.5, min(delta, 30.0))
    except Exception:
        return default


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
        """GET/DELETE retry on 429/5xx AND on transport errors (DNS, reset,
        timeout — a tick fired seconds after the laptop wakes hits these
        before Wi-Fi is back, DEVLOG #28). POST is never retried: a second
        POST /v2/orders with the same client_order_id is a duplicate, not a
        retry — the caller reconciles by client_order_id instead."""
        last_err = ""
        for attempt in range(retries + 1):
            try:
                resp = self.s.request(method, url, params=params, json=json, timeout=20)
            except requests.RequestException as e:
                last_err = f"{type(e).__name__}: {e}"
                if method == "POST" or attempt >= retries:
                    raise AlpacaError(f"{method} {url}: {last_err}") from e
                time.sleep(2.0 * (attempt + 1))
                continue
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries and method != "POST":
                time.sleep(_retry_after_seconds(resp.headers.get("Retry-After"), 1.5 * (attempt + 1)))
                continue
            if resp.status_code >= 400:
                raise AlpacaError(f"{method} {url} -> {resp.status_code}: {resp.text[:400]}")
            if not resp.text:
                return {}
            try:
                return resp.json()
            except ValueError as e:  # HTML error page behind a 200 (CDN incident)
                last_err = f"non-JSON body: {resp.text[:120]!r}"
                if method == "POST" or attempt >= retries:
                    raise AlpacaError(f"{method} {url}: {last_err}") from e
                time.sleep(2.0 * (attempt + 1))
        raise AlpacaError(f"{method} {url}: retries exhausted ({last_err})")

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

    def order_by_client_id(self, client_order_id: str) -> dict | None:
        """Fill status of one of OUR orders; None if the broker never saw it."""
        try:
            return self._req("GET", f"{TRADING}/v2/orders:by_client_order_id",
                             params={"client_order_id": client_order_id})
        except AlpacaError as e:
            if "-> 404" in str(e):
                return None
            raise

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

    def stock_bars_daily(self, symbol: str, days: int = 40,
                         exclude_date: str | None = None) -> list[dict]:
        """The LAST `days` completed daily bars, oldest first.

        DEVLOG #28: the previous request (start = 2*days ago, limit = days,
        default sort asc) returned the FIRST `days` bars after start, so the
        realized-vol window ended ~12 trading days before today. Now the
        request is sorted desc and reversed. `exclude_date` (the session date)
        drops the in-progress bar of the current session, otherwise a partial
        day would enter the realized-vol sample and drift every 15 minutes."""
        start = (datetime.now(timezone.utc) - timedelta(days=days * 3)).strftime("%Y-%m-%d")
        j = self._req("GET", f"{DATA}/v2/stocks/{symbol}/bars",
                      params={"timeframe": "1Day", "start": start, "limit": days + 5,
                              "adjustment": "split", "feed": "iex", "sort": "desc"})
        bars = list(reversed(j.get("bars") or []))
        if exclude_date:
            bars = [b for b in bars if str(b.get("t", ""))[:10] < exclude_date]
        return bars[-days:]

    def latest_stock_quote(self, symbol: str) -> dict:
        j = self._req("GET", f"{DATA}/v2/stocks/{symbol}/quotes/latest",
                      params={"feed": "iex"})
        return j.get("quote") or {}

    def news(self, symbols: str = "SPY", limit: int = 12) -> list[dict]:
        j = self._req("GET", f"{DATA}/v1beta1/news",
                      params={"symbols": symbols, "limit": limit})
        return j.get("news") or []
