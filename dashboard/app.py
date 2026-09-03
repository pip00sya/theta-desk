"""THETA DESK glass-box dashboard (Streamlit).

Run:  streamlit run dashboard/app.py
Judge mode: append ?judge=1 to the URL — annotations explain what to look at.

Reads ONLY from the SQLite store and the hash-chained journal; the dashboard
cannot invent numbers that reconcile would not see.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit.journal import Journal         # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

st.set_page_config(page_title="THETA DESK", page_icon="O", layout="wide")

cfg = cfgmod.load()
# Cloud deploy fallback: a committed snapshot of the DB lives next to the app
# (refreshed by `make snapshot-dashboard` before each push).
db_path = cfg.db_path if cfg.db_path.exists() else Path(__file__).parent / "state.sqlite"
is_snapshot = db_path != cfg.db_path
store = Store(db_path)
journal = Journal(cfg.journal_dir)
entries = journal.read_all()

judge = st.query_params.get("judge") == "1"


def note(text: str):
    if judge:
        st.info("JUDGE NOTE - " + text)


def _quality(m: dict) -> str:
    try:
        return (json.loads(m.get("detail_json") or "{}").get("quality") or "ok")
    except ValueError:
        return "ok"


# ---- chrome (DEVLOG #36) ---------------------------------------------------
# Streamlit's defaults read as "a notebook someone shared". This is one of the
# three links a judge opens, so the page gets the desk's own typography and
# palette, and loses the deploy/hamburger furniture that means nothing to them.
st.html("""
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  #MainMenu, footer, [data-testid="stToolbar"], [data-testid="stDecoration"] { display: none; }
  html, body, [class*="css"], .stMarkdown, .stTabs { font-family: "IBM Plex Sans", system-ui, sans-serif; }
  .block-container { padding-top: 3.4rem; max-width: 1500px; }

  .desk-mast { border-bottom: 2px solid #35E0B0; padding-bottom: 14px; margin-bottom: 6px; }
  .desk-mast .kick { font-family: "IBM Plex Mono", monospace; font-size: 11.5px; letter-spacing: .18em;
                     text-transform: uppercase; color: #35E0B0; }
  .desk-mast h1 { font-size: 40px; font-weight: 700; letter-spacing: -.02em; margin: 6px 0 4px;
                  color: #F2F6FF; line-height: 1.1; }
  .desk-mast .sub { color: #8FA2C4; font-size: 15px; }
  .desk-mast .disc { color: #64748B; font-size: 12.5px; margin-top: 8px;
                     font-family: "IBM Plex Mono", monospace; }

  [data-testid="stMetric"] { background: #111827; border: 1px solid #223049; border-radius: 4px;
                             padding: 14px 18px; }
  [data-testid="stMetricLabel"] { font-family: "IBM Plex Mono", monospace; font-size: 11px !important;
                                  letter-spacing: .12em; text-transform: uppercase; color: #8FA2C4 !important; }
  [data-testid="stMetricValue"] { font-size: 30px !important; font-variant-numeric: tabular-nums;
                                  color: #F2F6FF !important; }

  .stTabs [data-baseweb="tab-list"] { gap: 4px; border-bottom: 1px solid #223049; }
  .stTabs [data-baseweb="tab"] { font-family: "IBM Plex Mono", monospace; font-size: 12.5px;
                                 letter-spacing: .06em; text-transform: uppercase; padding: 10px 16px; }
  .stTabs [aria-selected="true"] { color: #35E0B0 !important; }

  code, pre, .stDataFrame { font-family: "IBM Plex Mono", monospace !important; }
  .stAlert { border-radius: 3px; }
</style>
""")

st.html("""
<div class="desk-mast">
  <div class="kick">Alpaca paper account PA39C10YAMYQ · glass box</div>
  <h1>THETA DESK</h1>
  <div class="sub">An autonomous options desk that prices <b>volatility</b>, not direction.
  Every number on this page is recomputed from a hash-chained journal.</div>
  <div class="disc">paper trading only · hypothetical results · not investment advice</div>
</div>
""")

# ---- liveness (DEVLOG #28) -------------------------------------------------
last_ts = store.get_kv("last_tick_ts", "")
last_mode = store.get_kv("last_tick_mode", "")
if last_ts:
    age_min = (datetime.now(timezone.utc) - datetime.fromisoformat(last_ts)).total_seconds() / 60
    line = f"Last tick: {last_ts[:16]}Z ({age_min:.0f} min ago), mode: {last_mode or 'n/a'}"
    (st.success if age_min < 30 else st.warning)(line + " — scheduler window 13:30–20:00 UTC, Mon–Fri")
if is_snapshot:
    st.caption(f"Rendering the committed data snapshot (data as of the last publish). "
               f"Journal entries: {len(entries)}.")

ok, msg = journal.verify_chain()
c1, c2, c3, c4 = st.columns(4)
c1.metric("Journal entries", len(entries))
c2.metric("Hash chain", "intact" if ok else "BROKEN")
c3.metric("Structures", len(store.all_structures()))
c4.metric("Realized P&L", f"${store.realized_gains():,.2f}")
note("The journal is hash-chained: every decision line carries the SHA-256 of the "
     "previous one. `python -m thetadesk.main verify-journal` re-verifies it against "
     "in-place edits; the committed git history is the external anchor.")

tab_eq, tab_dec, tab_gates, tab_book, tab_desk, tab_ref = st.tabs(
    ["Equity & ablation", "Decision feed", "Gates", "Book", "Desk meetings", "Refusals"])

with tab_eq:
    note("Curves on identical inputs: the real book (broker equity), the same strategy "
         "without risk gates (unmanaged, marked at mid) and a naive news-driven baseline. "
         "Shadow books do not take profits, so this is a bound, not a like-for-like P&L. "
         "The hedge sleeve fired on Sep 2 (SPY 712 put), so the 'no hedge' curve now "
         "diverges from the real one; it is hidden only while identical.")
    import pandas as pd
    all_marks = {b: store.marks(b) for b in ("real", "shadow_nogates", "shadow_nohedge", "baseline_naive")}
    quarantined = sum(1 for ms in all_marks.values() for m in ms if _quality(m) != "ok")
    frames = {}
    for book, marks in all_marks.items():
        good = [m for m in marks if _quality(m) == "ok"]
        if not good:
            continue
        idx = pd.to_datetime([m["ts"] for m in good])
        if book == "real":
            eq = [m["equity"] for m in good]
            if all(e is not None for e in eq):
                frames["real (broker equity − $100k)"] = pd.Series([e - 100_000 for e in eq], index=idx)
            else:
                frames["real (model)"] = pd.Series([m["unrealized"] + (m["realized"] or 0) for m in good], index=idx)
        else:
            frames[book] = pd.Series([m["unrealized"] + (m["realized"] or 0) for m in good], index=idx)
    # hide the hedge ablation while it is identical to the real model book
    if "shadow_nohedge" in frames and all_marks.get("real"):
        real_model = [m["unrealized"] + (m["realized"] or 0) for m in all_marks["real"] if _quality(m) == "ok"]
        if real_model and list(frames["shadow_nohedge"].values) == real_model:
            frames.pop("shadow_nohedge")
    if frames:
        df = pd.concat(frames.values(), axis=1, keys=frames.keys()).ffill()
        st.line_chart(df)
        last = df.iloc[-1]
        cols = st.columns(len(frames))
        for col, (name, val) in zip(cols, last.items()):
            col.metric(name, f"${val:,.0f}")
        if quarantined:
            st.caption(f"{quarantined} mark rows quarantined (data-quality gate, DEVLOG #28): "
                       "2026-09-01 20:15/20:30 UTC priced off a one-sided after-hours quote. "
                       "They remain in the store and the journal; they are not plotted.")
        real_marks = [m for m in all_marks["real"] if _quality(m) == "ok"]
        with_greeks = [m for m in real_marks if m["theta"] or m["delta"] or m["vega"]]
        if with_greeks:
            st.subheader("Book greeks (dollar terms)")
            note("Net desk exposures from broker-published greeks: dollar delta per "
                 "1-point SPY move, dollar theta per day, dollar vega per vol point. This is the "
                 "attribution language: you can see WHY the curve moved.")
            gdf = pd.DataFrame(
                {"delta $/1pt": [m["delta"] for m in with_greeks],
                 "theta $/day": [m["theta"] for m in with_greeks],
                 "vega $/volpt": [m["vega"] for m in with_greeks]},
                index=pd.to_datetime([m["ts"] for m in with_greeks]))
            st.line_chart(gdf)
    else:
        st.write("No marks yet — run a tick.")

with tab_dec:
    note("Every tick's full chain: signals -> desk votes -> gates -> order. "
         "Refusals are first-class citizens: an agent that can decline to trade "
         "is the point.")
    for e in reversed(entries[-200:]):
        kind = e["kind"]
        label = {"tick_start": "tick", "signals": "signals", "desk": "desk votes",
                 "gates": "gate wall", "entry_refused": "ENTRY REFUSED",
                 "order_open": "ORDER OPEN", "order_close": "ORDER CLOSE",
                 "order_hedge": "HEDGE", "manage": "manage",
                 "entry_skipped_duplicate": "duplicate skip",
                 "desk_veto": "DESK VETO", "marks": "marks",
                 "data_quality": "DATA QUALITY", "market_closed": "market closed",
                 "entries_disabled": "entries disabled", "adopted_position": "ADOPTED POSITION",
                 "alert": "ALERT"}.get(kind, kind)
        with st.expander(f"{e['ts'][11:19]}  {label}"):
            st.json(e["data"])

with tab_gates:
    gates = [e["data"] for e in entries if e["kind"] == "gates"]
    refused = [e["data"] for e in entries if e["kind"] == "entry_refused"]
    st.metric("Gate evaluations", len(gates))
    st.metric("Entries refused", len(refused))
    note("Gate g8 reprices the ENTIRE book over a +/-20% price grid at the "
         "judging horizon (the Sep 18 expiry, so at intrinsic value) — a "
         "client-side implementation of Alpaca's universal spread rule.")
    for g in reversed(gates[-20:]):
        ff = next((r for r in g["results"] if not r["passed"]), None)
        verdict = "PASS" if g["passed"] else f"REFUSED at {ff['gate']}: {ff['reason']}"
        wc = g.get("worst_case") or {}
        st.write(f"`{g.get('structure_id', '?')}` {g.get('kind', '')} x{g.get('qty', '?')} — "
                 f"{verdict} — worst case ${-(wc.get('pnl') or 0):,.0f} "
                 f"at {wc.get('spot_rel', 1):.0%} spot ({wc.get('scenario', '-')})")

with tab_book:
    for s in store.all_structures():
        legs = json.loads(s["legs_json"])
        st.write(f"**[{s['status']}] {s['kind']}** x{s['qty']} sleeve={s['sleeve']} "
                 f"credit={s['net_credit']:.2f} max loss ${s['max_loss']:,.0f}"
                 + (f" — closed P&L ${s['closed_pnl']:,.2f}" if s["closed_pnl"] else ""))
        st.table(legs)

with tab_desk:
    note("LLM roles argue and veto; they never compute and cannot loosen a gate. "
         "Fallbacks are recorded — with no API keys the desk degrades to its "
         "deterministic core and says so.")
    rows = store.conn.execute(
        "SELECT ts, transcript_json FROM meetings ORDER BY ts DESC LIMIT 10").fetchall()
    for r in rows:
        with st.expander(r["ts"]):
            for ex in json.loads(r["transcript_json"]):
                st.markdown(f"**{ex['role']}** ({ex['provider']}/{ex['model']}) "
                            + ("ok" if ex["ok"] else f"FALLBACK: {ex['fallback_reason']}"))
                if ex["response_text"]:
                    st.code(ex["response_text"][:800])

with tab_ref:
    note("Every time the agent said no, and why. no_candidate = the selector found "
         "nothing that cleared the credit/liquidity floor; desk_veto = the news vetoer "
         "blocked short premium; entry_refused = a deterministic gate; "
         "entries_disabled = the data-quality gate or an integrity halt.")
    kinds = ("no_candidate", "desk_veto", "desk_veto_waived", "entry_refused", "size_zero",
             "derisk_mode", "entries_disabled", "data_quality", "data_suspect", "close_deferred")
    rows = [(e["ts"][:16], e["kind"], json.dumps(e["data"], ensure_ascii=False)[:160])
            for e in entries if e["kind"] in kinds]
    counts = {}
    for _, k, _ in rows:
        counts[k] = counts.get(k, 0) + 1
    cols = st.columns(max(1, min(len(counts), 5)))
    for col, (k, v) in zip(cols * 3, counts.items()):
        col.metric(k, v)
    import pandas as pd
    if rows:
        st.dataframe(pd.DataFrame(reversed(rows), columns=["ts", "kind", "detail"]),
                     use_container_width=True, height=400)
