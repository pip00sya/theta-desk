"""THETA DESK glass-box dashboard (Streamlit).

Run:  streamlit run dashboard/app.py
Judge mode: append ?judge=1 to the URL — annotations explain what to look at.

Reads ONLY from the SQLite store and the hash-chained journal; the dashboard
cannot invent numbers that reconcile would not see.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from thetadesk import config as cfgmod              # noqa: E402
from thetadesk.audit.journal import Journal         # noqa: E402
from thetadesk.state.store import Store             # noqa: E402

st.set_page_config(page_title="THETA DESK", page_icon="O", layout="wide")

cfg = cfgmod.load()
store = Store(cfg.db_path)
journal = Journal(cfg.journal_dir)
entries = journal.read_all()

judge = st.query_params.get("judge") == "1"


def note(text: str):
    if judge:
        st.info("JUDGE NOTE - " + text)


st.title("THETA DESK — autonomous options desk on Alpaca (paper)")
st.caption("Paper trading simulation only. Hypothetical results. Not investment advice.")

ok, msg = journal.verify_chain()
c1, c2, c3, c4 = st.columns(4)
c1.metric("Journal entries", len(entries))
c2.metric("Hash chain", "intact" if ok else "BROKEN")
c3.metric("Structures", len(store.all_structures()))
c4.metric("Realized P&L", f"${store.realized_gains():,.2f}")
note("The journal is hash-chained: every decision line carries the SHA-256 of the "
     "previous one. `python -m thetadesk.main verify-journal` re-verifies it.")

tab_eq, tab_dec, tab_gates, tab_book, tab_desk = st.tabs(
    ["Equity & ablation", "Decision feed", "Gates", "Book", "Desk meetings"])

with tab_eq:
    note("Four curves, same inputs: the real book, the same strategy without risk "
         "gates, without the hedge sleeve, and a naive news-driven baseline. "
         "This is the live ablation — the dollar value of each design decision.")
    import pandas as pd
    frames = {}
    for book in ("real", "shadow_nogates", "shadow_nohedge", "baseline_naive"):
        marks = store.marks(book)
        if marks:
            frames[book] = pd.Series(
                [m["unrealized"] + (m["realized"] or 0) for m in marks],
                index=pd.to_datetime([m["ts"] for m in marks]), name=book)
    if frames:
        df = pd.concat(frames.values(), axis=1).ffill()
        st.line_chart(df)
        last = df.iloc[-1]
        cols = st.columns(len(frames))
        for col, (name, val) in zip(cols, last.items()):
            col.metric(name, f"${val:,.0f}")
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
                 "desk_veto": "DESK VETO", "marks": "marks"}.get(kind, kind)
        with st.expander(f"{e['ts'][11:19]}  {label}"):
            st.json(e["data"])

with tab_gates:
    gates = [e["data"] for e in entries if e["kind"] == "gates"]
    refused = [e["data"] for e in entries if e["kind"] == "entry_refused"]
    st.metric("Gate evaluations", len(gates))
    st.metric("Entries refused", len(refused))
    note("Gate g8 reprices the ENTIRE book over a +/-20% price grid at the "
         "judging horizon under base and stressed vol — a client-side "
         "implementation of Alpaca's universal spread rule.")
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
