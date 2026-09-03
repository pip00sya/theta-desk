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
st.markdown("""<style>
  #MainMenu, footer, header, [data-testid="stToolbar"], [data-testid="stDecoration"],
  [data-testid="stSidebarNav"] { display:none !important; }
  .block-container { padding:0 !important; max-width:100% !important; }
  .stApp { background:#0B0B0C; }
  iframe { border:0; }
</style>""", unsafe_allow_html=True)

PAGE = ROOT / "dashboard" / "web" / "index.html"
DATA = ROOT / "dashboard" / "web" / "data.json"


def _data() -> dict | None:
    """Prefer a freshly computed export; fall back to the committed one.

    On Streamlit Cloud there is no live store and no credentials, so the commit
    ships data.json and this just reads it. Locally it recomputes, so the page
    is current the moment a tick lands."""
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        import site_data                                    # noqa: PLC0415
        return site_data.build()
    except Exception:
        try:
            return json.loads(DATA.read_text(encoding="utf-8"))
        except Exception:
            return None


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

components.html(html, height=2400, scrolling=True)
