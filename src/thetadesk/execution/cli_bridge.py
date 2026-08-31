"""Order transport: Alpaca CLI first, REST fallback second.

The hackathon requires MCP or CLI in the loop; orders therefore go out as
  echo <payload> | alpaca api POST /v2/orders
when the CLI binary is present (exit codes: 0 ok, 1 api error, 2 auth).
When it is not installed (dev boxes), we fall back to the same REST call the
CLI would make, and journal which transport was used — the claim "orders via
CLI" must be reconcilable, not assumed.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass


@dataclass
class SubmitResult:
    ok: bool
    transport: str          # "cli" | "rest" | "dry_run"
    order: dict | None
    error: str = ""
    duplicate: bool = False


def cli_available() -> bool:
    return shutil.which("alpaca") is not None


def submit_via_cli(payload: dict) -> SubmitResult:
    p = subprocess.run(
        ["alpaca", "api", "POST", "/v2/orders"],
        input=json.dumps(payload), capture_output=True, text=True, timeout=30,
    )
    if p.returncode == 0:
        try:
            return SubmitResult(True, "cli", json.loads(p.stdout))
        except json.JSONDecodeError:
            return SubmitResult(True, "cli", {"raw": p.stdout.strip()})
    err = (p.stderr or p.stdout).strip()
    if "client_order_id" in err and ("duplicate" in err.lower() or "already" in err.lower()):
        return SubmitResult(True, "cli", None, error=err, duplicate=True)
    return SubmitResult(False, "cli", None, error=f"exit={p.returncode}: {err[:400]}")


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
        dup = "client_order_id" in msg and ("duplicate" in msg.lower() or "already" in msg.lower())
        return SubmitResult(dup, "rest", None, error=msg[:400], duplicate=dup)
