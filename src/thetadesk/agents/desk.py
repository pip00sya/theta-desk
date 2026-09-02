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

# DEVLOG #28: the score's meaning was never defined in the prompts, so the
# second-opinion model read vrp=1.0 (IV 5x RV) as "cheap" and 3 of 3 live
# "disagreements" that halved size came from vocabulary, not information.
REGIME_GLOSSARY = (
    "Definitions (use exactly these): vrp_score = 0.5 + (atm_iv - rv20) / rv20, clipped to "
    "[0, 1]. 0.5 means implied vol equals realized. 'rich' = implied vol EXPENSIVE relative "
    "to realized (score >= 0.60, i.e. IV at least 10% above RV; favours SELLING premium). "
    "'cheap' = implied vol BELOW realized (score < 0.40; favours BUYING convexity). "
    "'neutral' = in between. A high score can never mean 'cheap'. The scale is CLIPPED: a "
    "score of exactly 1.00 only means IV is at least 50% above RV — that is a rich reading, "
    "not an error. Judge richness from the vol-point spread and ratio given to you, not from "
    "the clipped score. "
    # DEVLOG #29: the analyst set data_suspect because 'SPY at 762 is outside historical
    # norms' — a knowledge-cutoff artifact that blocked a valid condor on the first tick.
    "\"data_suspect\" means the inputs CONTRADICT EACH OTHER and must be true only for: ATM IV "
    "above 60%, a spot that does not sit inside the strike range you are given, or an implied "
    "vol more than 3x realized. You do NOT know the current price level of any index: today is "
    "later than your training data, so the absolute level of spot, strikes or the account "
    "equity is NEVER evidence of corruption. Unfamiliar price levels are normal. "
)

ANALYST_SYSTEM = (
    "You are the volatility analyst on an autonomous options desk trading SPY/QQQ "
    "index options in a PAPER account. You receive deterministic signals (spot, "
    "20d realized vol, ATM IV, VRP score). Your job is qualitative: classify the "
    "regime and flag anything the raw numbers may hide. You do NOT pick strikes "
    "and you cannot override risk gates. " + REGIME_GLOSSARY +
    "Reply with ONE JSON object only: "
    '{"regime": "rich"|"neutral"|"cheap", "confidence": 0.0-1.0, "data_suspect": true|false, '
    '"rationale": "<2 sentences>"}'
)

SECOND_SYSTEM = (
    "You are an independent second-opinion model on an options desk. Same inputs, "
    "no knowledge of the primary analyst's view. Classify the volatility regime. "
    + REGIME_GLOSSARY +
    'Reply with ONE JSON object only: {"regime": "rich"|"neutral"|"cheap", '
    '"confidence": 0.0-1.0, "data_suspect": true|false, "rationale": "<2 sentences>"}'
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
    data_suspect: bool = False   # an LLM flagged the raw inputs as corrupted (DEVLOG #28)

    @property
    def size_mult(self) -> float:
        m = 1.0
        if self.disagreement:
            m *= 0.5
        if self.objection_severity == "high":
            m *= 0.5
        if self.data_suspect:
            # DEVLOG #29: an unconfirmed data doubt halves size; only the
            # deterministic gate can stop the trade outright
            m *= 0.5
        return m

    def to_dict(self) -> dict:
        d = self.__dict__.copy()
        d["size_mult"] = self.size_mult
        return d


def veto_applies(view: "DeskView", net_credit: float) -> bool:
    """DEVLOG #25: the vetoer answers 'any reason NOT to add SHORT-premium
    risk?' — its veto blocks structures that SELL premium (net_credit > 0).
    Buying convexity ahead of a binary event is exactly the right trade, so
    a debit structure passes through with the veto journaled, not enforced."""
    return bool(view.veto) and net_credit > 0


def _det_regime(score: float, cfg: Config) -> str:
    if score >= cfg["regime"]["vrp_rich_threshold"]:
        return "rich"
    if score >= cfg["regime"]["vrp_cheap_threshold"]:
        return "neutral"
    return "cheap"


def run_desk(signals: MarketSignals, headlines: list[str], candidate_desc: str,
             book_desc: str, cfg: Config) -> DeskView:
    L = cfg["llm"]
    # the clipped score alone reads like an anomaly at its maximum; the raw
    # spread and ratio are what actually say how rich the premium is
    spread_pts = (signals.atm_iv - signals.rv20) * 100
    ratio = (signals.atm_iv / signals.rv20) if signals.rv20 > 0 else float("nan")
    sig_txt = (f"spot={signals.spot:.2f} rv20={signals.rv20:.4f} "
               f"atm_iv={signals.atm_iv:.4f} vrp_score={signals.vrp:.3f} "
               f"(iv-rv={spread_pts:+.1f} vol points, iv/rv={ratio:.2f}x)")
    det = _det_regime(signals.vrp, cfg)
    exchanges: list[dict] = []
    fallbacks: list[str] = []

    def ask(role: str, provider: str, model: str, system: str, user: str) -> dict | None:
        ex = llm.call(role, provider, model, system, user, timeout_s=L["timeout_s"])
        exchanges.append(ex.to_dict())
        if not ex.ok:
            fallbacks.append(f"{role}: {ex.fallback_reason}")
            return None
        out = llm.extract_json(ex.response_text)
        if out is None:
            # DEVLOG #28: a reply the desk cannot parse is a fallback too —
            # before this it silently became the deterministic default
            fallbacks.append(f"{role}: parse_failure")
        return out

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

    regime_a = str((a or {}).get("regime", det)).strip().lower()
    regime_s = str((s or {}).get("regime", det)).strip().lower()
    if regime_a not in ("rich", "neutral", "cheap"):
        regime_a = det
    if regime_s not in ("rich", "neutral", "cheap"):
        regime_s = det
    # strict booleans: the 7B vetoer may answer "false" as a string
    raw_veto = (v or {}).get("veto", False)
    veto = raw_veto if isinstance(raw_veto, bool) else str(raw_veto).strip().lower() == "true"
    severity = str((r or {}).get("severity", "low")).strip().lower()
    if severity not in ("low", "medium", "high"):
        severity = "low"
    # DEVLOG #29: ONE model's doubt is an opinion, not a fact — both regime
    # readers must agree before the desk treats the feed as suspect
    flags = [bool(x.get("data_suspect")) is True or str(x.get("data_suspect")).lower() == "true"
             for x in (a, s) if x]
    data_suspect = bool(flags) and all(flags) and len(flags) == 2

    return DeskView(
        regime_analyst=regime_a,
        regime_second=regime_s,
        disagreement=(regime_a != regime_s),
        veto=veto,
        veto_reason=(v or {}).get("reason", "no veto (default)" if v is None else ""),
        objection=(r or {}).get("objection", "risk officer unavailable"),
        objection_severity=severity,
        exchanges=exchanges,
        fallbacks=fallbacks,
        data_suspect=data_suspect,
    )
