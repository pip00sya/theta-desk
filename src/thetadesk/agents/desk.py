"""The desk: four LLM roles + morning meeting orchestration.

Division of labour is explicit and honest:
  - the quantitative signal (VRP score) is deterministic code (signals.py)
  - Vol Analyst  (Claude)      interprets regime & context, may disagree with the score
  - Second Opinion (Featherless) independent read of the same inputs
  - News Vetoer  (Featherless)  qualitative "any reason NOT to trade today?"
  - Risk Officer (Claude)       devil's advocate against today's candidate

Outputs feed SIZING ONLY (disagreement -> 0.5x, veto -> no new risk today).
No LLM output can loosen a deterministic gate.
Degraded mode (no keys): regime falls back to the deterministic score,
veto defaults to NO-veto, and every fallback is journaled.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..config import Config
from ..data.signals import MarketSignals
from . import llm

ANALYST_SYSTEM = (
    "You are the volatility analyst on an autonomous options desk trading SPY/QQQ "
    "index options in a PAPER account. You receive deterministic signals (spot, "
    "20d realized vol, ATM IV, VRP score). Your job is qualitative: classify the "
    "regime and flag anything the raw numbers may hide. You do NOT pick strikes "
    "and you cannot override risk gates. Reply with ONE JSON object only: "
    '{"regime": "rich"|"neutral"|"cheap", "confidence": 0.0-1.0, "rationale": "<2 sentences>"}'
)

SECOND_SYSTEM = (
    "You are an independent second-opinion model on an options desk. Same inputs, "
    "no knowledge of the primary analyst's view. Classify the volatility regime. "
    'Reply with ONE JSON object only: {"regime": "rich"|"neutral"|"cheap", '
    '"confidence": 0.0-1.0, "rationale": "<2 sentences>"}'
)

VETOER_SYSTEM = (
    "You are the news vetoer on an options desk that SELLS index option premium. "
    "Given today's headlines, answer one question: is there a qualitative reason "
    "NOT to add short-premium risk today (imminent binary event, panic, policy "
    "shock)? Ordinary market chatter is NOT a veto. Reply with ONE JSON object "
    'only: {"veto": true|false, "reason": "<1 sentence>"}'
)

RISK_OFFICER_SYSTEM = (
    "You are the risk officer on an options desk — the devil's advocate. You are "
    "given the candidate structure and current book. Attack it: name the most "
    "plausible scenario in the next two weeks where this trade loses. You cannot "
    "block trades (deterministic gates do that); your objection is recorded and "
    "may halve the size. Reply with ONE JSON object only: "
    '{"objection": "<2 sentences>", "severity": "low"|"medium"|"high"}'
)


@dataclass
class DeskView:
    regime_analyst: str
    regime_second: str
    disagreement: bool
    veto: bool
    veto_reason: str
    objection: str
    objection_severity: str
    exchanges: list[dict] = field(default_factory=list)
    fallbacks: list[str] = field(default_factory=list)

    @property
    def size_mult(self) -> float:
        m = 1.0
        if self.disagreement:
            m *= 0.5
        if self.objection_severity == "high":
            m *= 0.5
        return m

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["size_mult"] = self.size_mult
        return d


def _det_regime(score: float, cfg: Config) -> str:
    if score >= cfg["regime"]["vrp_rich_threshold"]:
        return "rich"
    if score >= cfg["regime"]["vrp_cheap_threshold"]:
        return "neutral"
    return "cheap"


def run_desk(signals: MarketSignals, headlines: list[str], candidate_desc: str,
             book_desc: str, cfg: Config) -> DeskView:
    L = cfg["llm"]
    sig_txt = (f"spot={signals.spot:.2f} rv20={signals.rv20:.4f} "
               f"atm_iv={signals.atm_iv:.4f} vrp_score={signals.vrp:.3f}")
    det = _det_regime(signals.vrp, cfg)
    exchanges: list[dict] = []
    fallbacks: list[str] = []

    def ask(role: str, provider: str, model: str, system: str, user: str) -> dict | None:
        ex = llm.call(role, provider, model, system, user, timeout_s=L["timeout_s"])
        exchanges.append(ex.to_dict())
        if not ex.ok:
            fallbacks.append(f"{role}: {ex.fallback_reason}")
            return None
        return llm.extract_json(ex.response_text)

    a = ask("vol_analyst", L["analyst_provider"], L["analyst_model"],
            ANALYST_SYSTEM, f"Signals: {sig_txt}")
    s = ask("second_opinion", L["second_provider"], L["second_model"],
            SECOND_SYSTEM, f"Signals: {sig_txt}")
    v = ask("news_vetoer", L["vetoer_provider"], L["vetoer_model"],
            VETOER_SYSTEM, "Headlines:\n- " + "\n- ".join(headlines[:12] or ["(no headlines)"]))
    r = ask("risk_officer", L.get("risk_provider", L["analyst_provider"]),
            L.get("risk_model", L["analyst_model"]),
            RISK_OFFICER_SYSTEM,
            f"Candidate: {candidate_desc}\nBook: {book_desc}\nSignals: {sig_txt}")

    regime_a = (a or {}).get("regime", det)
    regime_s = (s or {}).get("regime", det)
    if regime_a not in ("rich", "neutral", "cheap"):
        regime_a = det
    if regime_s not in ("rich", "neutral", "cheap"):
        regime_s = det

    return DeskView(
        regime_analyst=regime_a,
        regime_second=regime_s,
        disagreement=(regime_a != regime_s),
        veto=bool((v or {}).get("veto", False)),
        veto_reason=(v or {}).get("reason", "no veto (default)" if v is None else ""),
        objection=(r or {}).get("objection", "risk officer unavailable"),
        objection_severity=(r or {}).get("severity", "low"),
        exchanges=exchanges,
        fallbacks=fallbacks,
    )
