"""THETA DESK — the glass box.

Streamlit is the host, not the interface. The page itself is
`dashboard/web/index.html`, a hand-built instrument; this module inlines the
generated data into it and renders it full-bleed. Keeping Streamlit as the
shell means the submission's existing demo URL keeps working while the surface
a judge actually sees is ours.

Every figure comes from ONE generated file (tools/site_data.py). Nothing on the
page is computed here, so two pages of this project can never disagree.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import streamlit as st
import streamlit.components.v1 as components

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

st.set_page_config(page_title="THETA DESK", page_icon="◱", layout="wide",
                   initial_sidebar_state="collapsed")
# Streamlit gives a component a fixed-height box inside a page that does not
# scroll, so anything past the first screen becomes unreachable. Rather than
# guess a height, the component is pinned to the viewport and the page inside
# it does its own scrolling — which is what a full-bleed instrument wants.
st.markdown("""<style>
  #MainMenu, footer, header, [data-testid="stToolbar"], [data-testid="stDecoration"],
  [data-testid="stSidebarNav"] { display:none !important; }
  .block-container { padding:0 !important; max-width:100% !important; }
  .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"] {
    background:#0B0B0C; overflow:hidden !important; }
  /* the local Streamlit calls this iframe streamlit_component_v1 and the one
     on Cloud calls it st.iframe; match both or the page ends up clipped */
  iframe[title="streamlit_component_v1"], iframe[title="st.iframe"],
  iframe[data-testid="stIFrame"], iframe.stIFrame {
    position:fixed !important; inset:0 !important;
    width:100vw !important; height:100vh !important; border:0 !important; z-index:1; }
</style>""", unsafe_allow_html=True)

PAGE = ROOT / "dashboard" / "web" / "index.html"
DATA = ROOT / "dashboard" / "web" / "data.json"


def _data() -> dict | None:
    """Serve the published export; recompute only where there is something to
    recompute.

    On Streamlit Cloud there is no live store, no credentials and no .env, so a
    rebuild there can only produce a *worse* copy of the file the commit already
    carries — and it did: a failed pytest collection printed "null cases
    collected" on the live page. The host now rebuilds only when it can see the
    desk's own environment, and otherwise serves exactly what was published.
    """
    committed = None
    try:
        committed = json.loads(DATA.read_text(encoding="utf-8"))
    except Exception:
        pass
    if not (ROOT / ".env").exists():
        return committed
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        import site_data                                    # noqa: PLC0415
        import importlib                                    # noqa: PLC0415
        importlib.reload(site_data)   # a rerun must not serve a cached module
        live = site_data.build()
        if not live.get("broker") and committed and committed.get("broker"):
            live["broker"] = committed["broker"]
            live["broker_stale"] = True
        return live
    except Exception:
        return committed


d = _data()
html = PAGE.read_text(encoding="utf-8")
if d is not None:
    # the page fetches data.json when served as a static file; inside the
    # component iframe there is no such path, so hand it the object directly
    html = html.replace(
        'async function load(){',
        "window.__DATA__ = " + json.dumps(d, separators=(',', ':')) + ";\nasync function load(){")
    html = html.replace(
        'const r = await fetch("data.json?" + Math.floor(Date.now()/60000));\n    if(!r.ok) throw new Error(r.status);\n    render(await r.json());',
        'if(window.__DATA__){ render(window.__DATA__); return; }\n'
        '    const r = await fetch("data.json?" + Math.floor(Date.now()/60000));\n'
        '    if(!r.ok) throw new Error(r.status);\n    render(await r.json());')

components.html(html, height=900, scrolling=True)
