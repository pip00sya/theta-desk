"""Provider-agnostic LLM access with recorded exchanges and degraded mode.

Two providers:
  anthropic   — Claude via Messages API (deep roles: analyst, risk officer)
  featherless — OpenAI-compatible open models (vetoer, second opinion)

Design rules (RED-TEAM P7): LLMs argue, veto and adapt — they never compute.
Every call is recorded {prompt_hash, response, model} for replay. With no API
keys the desk degrades to deterministic defaults and journals the fallback.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass

import requests

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
FEATHERLESS_URL = "https://api.featherless.ai/v1/chat/completions"


@dataclass
class LLMExchange:
    role: str
    provider: str
    model: str
    prompt_hash: str
    response_text: str
    ok: bool
    fallback_reason: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def call(role: str, provider: str, model: str, system: str, user: str,
         timeout_s: int = 45, max_tokens: int = 700) -> LLMExchange:
    ph = _hash(system + "\n" + user)
    try:
        if provider == "anthropic":
            key = os.environ.get("ANTHROPIC_API_KEY")
            if not key:
                return LLMExchange(role, provider, model, ph, "", False, "no ANTHROPIC_API_KEY")
            r = requests.post(ANTHROPIC_URL, timeout=timeout_s, json={
                "model": model, "max_tokens": max_tokens, "system": system,
                "messages": [{"role": "user", "content": user}],
            }, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                        "content-type": "application/json"})
            r.raise_for_status()
            text = "".join(b.get("text", "") for b in r.json().get("content", []))
            return LLMExchange(role, provider, model, ph, text, True)
        if provider == "featherless":
            key = os.environ.get("FEATHERLESS_API_KEY")
            if not key:
                return LLMExchange(role, provider, model, ph, "", False, "no FEATHERLESS_API_KEY")
            body = {"model": model, "max_tokens": max_tokens,
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}]}
            r = requests.post(FEATHERLESS_URL, timeout=timeout_s, json=body,
                              headers={"Authorization": f"Bearer {key}"})
            # quota/auth exhaustion on the primary key -> one retry on backup
            backup = os.environ.get("FEATHERLESS_API_KEY_BACKUP")
            if r.status_code in (401, 402, 403, 429) and backup:
                r = requests.post(FEATHERLESS_URL, timeout=timeout_s, json=body,
                                  headers={"Authorization": f"Bearer {backup}"})
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
            return LLMExchange(role, provider, model, ph, text, True)
        return LLMExchange(role, provider, model, ph, "", False, f"unknown provider {provider}")
    except Exception as e:  # network/timeout/parse — desk must not die on LLM failure
        return LLMExchange(role, provider, model, ph, "", False, f"{type(e).__name__}: {e}")


def extract_json(text: str) -> dict | None:
    """Extract the first JSON object from a model response."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None
