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
import re
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
         timeout_s: int = 45, max_tokens: int = 2000) -> LLMExchange:
    """DEVLOG #28: an EMPTY reply is a fallback, not a success. Claude Sonnet 5
    thinks adaptively by default and the thinking shares `max_tokens`; with
    700 tokens a long think exhausted the budget before any text block, and
    ok=True with '' silently defaulted the risk officer to 'low' and wiped a
    daily note. Now: effort=low for these short JSON roles, a larger budget,
    and stop_reason/emptiness are checked."""
    ph = _hash(system + "\n" + user)
    try:
        if provider == "anthropic":
            key = os.environ.get("ANTHROPIC_API_KEY")
            if not key:
                return LLMExchange(role, provider, model, ph, "", False, "no ANTHROPIC_API_KEY")
            r = requests.post(ANTHROPIC_URL, timeout=timeout_s, json={
                "model": model, "max_tokens": max_tokens, "system": system,
                "output_config": {"effort": "low"},
                "messages": [{"role": "user", "content": user}],
            }, headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                        "content-type": "application/json"})
            r.raise_for_status()
            j = r.json()
            text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
            stop = j.get("stop_reason")
            if stop in ("max_tokens", "refusal") or not text.strip():
                return LLMExchange(role, provider, model, ph, text, False,
                                   f"empty_or_truncated_reply stop_reason={stop}")
            return LLMExchange(role, provider, model, ph, text, True)
        if provider == "featherless":
            key = os.environ.get("FEATHERLESS_API_KEY")
            if not key:
                return LLMExchange(role, provider, model, ph, "", False, "no FEATHERLESS_API_KEY")
            # temperature 0 + seed: identical headlines must not yield a
            # different veto on the next tick (they did, 3 flips in 30 min)
            body = {"model": model, "max_tokens": max_tokens, "temperature": 0, "seed": 7,
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}]}
            r = requests.post(FEATHERLESS_URL, timeout=timeout_s, json=body,
                              headers={"Authorization": f"Bearer {key}"})
            # quota/auth exhaustion on the primary key -> one retry on backup
            backup = os.environ.get("FEATHERLESS_API_KEY_BACKUP")
            if r.status_code in (401, 402, 429) and backup:
                r = requests.post(FEATHERLESS_URL, timeout=timeout_s, json=body,
                                  headers={"Authorization": f"Bearer {backup}"})
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"] or ""
            if not text.strip():
                return LLMExchange(role, provider, model, ph, text, False, "empty_reply")
            return LLMExchange(role, provider, model, ph, text, True)
        return LLMExchange(role, provider, model, ph, "", False, f"unknown provider {provider}")
    except Exception as e:  # network/timeout/parse — desk must not die on LLM failure
        return LLMExchange(role, provider, model, ph, "", False, f"{type(e).__name__}: {e}")


def extract_json(text: str) -> dict | None:
    """Extract the first JSON object from a model response.

    Tries, in order: the whole text, a ```json fence, then raw_decode at every
    '{' (string-aware, so a brace inside a rationale does not end the scan)."""
    if not text:
        return None
    dec = json.JSONDecoder()
    try:
        obj = json.loads(text.strip())
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if m:
        try:
            obj = json.loads(m.group(1))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, _ = dec.raw_decode(text[i:])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            continue
    return None
