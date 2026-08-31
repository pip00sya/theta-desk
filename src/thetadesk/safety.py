"""Gate #1: paper-only, fail-closed.

Every entrypoint calls assert_paper_only() as its first statement.
If the environment is not unambiguously pointed at the paper host,
the process exits before any client is constructed.
"""
from __future__ import annotations

import os
import sys

PAPER_HOST = "paper-api.alpaca.markets"


class SafetyError(RuntimeError):
    pass


def assert_paper_only(exit_on_fail: bool = True) -> str:
    url = os.environ.get("APCA_API_BASE_URL", "")
    problems = []
    if PAPER_HOST not in url:
        problems.append(f"APCA_API_BASE_URL={url!r} does not point to {PAPER_HOST}")
    if os.environ.get("ALPACA_LIVE_TRADE", "").lower() == "true":
        problems.append("ALPACA_LIVE_TRADE=true is set")
    if os.environ.get("ALPACA_PAPER_TRADE", "true").lower() == "false":
        problems.append("ALPACA_PAPER_TRADE=false is set")
    if problems:
        msg = "FATAL(paper-only gate): " + "; ".join(problems)
        if exit_on_fail:
            sys.stderr.write(msg + "\n")
            sys.exit(1)
        raise SafetyError(msg)
    return url
