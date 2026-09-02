"""Order transport: Alpaca CLI first, REST fallback second.

The hackathon requires MCP or CLI in the loop; orders therefore go out as
  echo <payload> | alpaca api POST /v2/orders
when the CLI binary is present (exit codes: 0 ok, 1 api error, 2 auth).
When it is not installed (dev boxes), we fall back to the same REST call the
CLI would make, and journal which transport was used — the claim "orders via
CLI" must be reconcilable, not assumed.

DEVLOG #28: a submit can fail AMBIGUOUSLY (CLI timeout, connection reset,
gateway 5xx) after the broker accepted the order. `ambiguous=True` tells the
caller to look the order up by client_order_id before concluding anything.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass

DUPLICATE_MARKERS = ("duplicate", "already", "must be unique", "40010001")


@dataclass
class SubmitResult:
    ok: bool
    transport: str          # "cli" | "rest" | "dry_run"
    order: dict | None
    error: str = ""
    duplicate: bool = False
    ambiguous: bool = False  # the broker may have the order despite the failure


def cli_available() -> bool:
    return shutil.which("alpaca") is not None


def _is_duplicate(err: str) -> bool:
    low = err.lower()
    return "client_order_id" in low and any(m in low for m in DUPLICATE_MARKERS)


def submit_via_cli(payload: dict) -> SubmitResult:
    try:
        p = subprocess.run(
            ["alpaca", "api", "POST", "/v2/orders"],
            input=json.dumps(payload), capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return SubmitResult(False, "cli", None, error="cli timeout after 30s", ambiguous=True)
    except OSError as e:
        return SubmitResult(False, "cli", None, error=f"cli launch failed: {e}"[:400])
    if p.returncode == 0:
        try:
            return SubmitResult(True, "cli", json.loads(p.stdout))
        except json.JSONDecodeError:
            # exit 0 but no order JSON: treat as ambiguous, not as success
            return SubmitResult(False, "cli", {"raw": p.stdout.strip()},
                                error="cli returned non-JSON stdout", ambiguous=True)
    err = (p.stderr or p.stdout).strip()
    if _is_duplicate(err):
        return SubmitResult(True, "cli", None, error=err, duplicate=True)
    # exit 2 = auth; exit 1 = API error. A gateway/5xx-looking error is ambiguous.
    ambiguous = any(t in err.lower() for t in ("502", "503", "504", "timeout", "timed out", "gateway"))
    return SubmitResult(False, "cli", None, error=f"exit={p.returncode}: {err[:400]}",
                        ambiguous=ambiguous)


def submit(payload: dict, client, dry_run: bool = False) -> SubmitResult:
    if dry_run:
        return SubmitResult(True, "dry_run", {"dry_run": True, **payload})
    if cli_available():
        return submit_via_cli(payload)
    try:
        order = client.submit_order(payload)
        return SubmitResult(True, "rest", order)
    except Exception as e:
        msg = str(e)
        if _is_duplicate(msg):
            return SubmitResult(True, "rest", None, error=msg[:400], duplicate=True)
        # a definitive 4xx validation error is NOT ambiguous; anything else may be
        definitive = "-> 4" in msg and "-> 429" not in msg
        return SubmitResult(False, "rest", None, error=msg[:400], ambiguous=not definitive)
