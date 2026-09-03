"""Keep the public judge dashboard awake by being a real viewer for a minute.

Streamlit Community Cloud sleeps an app after a stretch without viewer
sessions and greets the next visitor with a "Zzzz" page and a wake-up button
(seen 2026-09-03 17:15 UTC, a day before the deadline). A plain HTTP GET is
not a viewer; a browser that loads the page and holds the websocket is. This
launches headless Edge with a DevTools port, waits until the page title reads
THETA DESK (i.e. the app actually rendered, not the sleep page), holds it for
a while, and logs what it saw. Scheduled every 3 hours by ops/keepalive.ps1.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://theta-desk.streamlit.app/?judge=1"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9333
LOG = Path(__file__).resolve().parents[1] / "data" / "keepalive.log"


def main() -> int:
    prof = Path(tempfile.gettempdir()) / "theta-keepalive-prof"
    p = subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--no-first-run",
                          f"--user-data-dir={prof}", f"--remote-debugging-port={PORT}",
                          "--window-size=1200,900", URL],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    title, woke = "", False
    try:
        deadline = time.time() + 75
        while time.time() < deadline:
            time.sleep(3)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=3) as r:
                    tabs = json.load(r)
                title = next((t.get("title", "") for t in tabs if "streamlit" in t.get("url", "")), title)
            except Exception:
                continue
            if "THETA DESK" in title:
                woke = True
                time.sleep(20)          # hold the session so it counts as a visit
                break
            if "sleep" in title.lower() or "Zzzz" in title:
                # click the wake-up button through DevTools: evaluate JS on the page
                try:
                    ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if "streamlit" in t.get("url", ""))
                    _click_wake(ws_url)
                except Exception:
                    pass
    finally:
        p.kill()
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"{stamp} rendered={woke} title={title!r}\n")
    print(f"rendered={woke} title={title!r}")
    return 0 if woke else 1


def _click_wake(ws_url: str) -> None:
    """Minimal CDP call: run JS that clicks the 'get this app back up' button."""
    import base64, socket, struct, urllib.parse
    u = urllib.parse.urlparse(ws_url)
    s = socket.create_connection((u.hostname, u.port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode()
    s.send((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    s.recv(4096)
    js = "[...document.querySelectorAll('button')].find(b=>/back up/i.test(b.textContent))?.click(); 'clicked'"
    msg = json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": js}}).encode()
    mask = os.urandom(4)
    hdr = bytes([0x81]) + (bytes([0x80 | len(msg)]) if len(msg) < 126 else bytes([0x80 | 126]) + struct.pack(">H", len(msg)))
    s.send(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(msg)))
    s.settimeout(5)
    try:
        s.recv(4096)
    finally:
        s.close()


if __name__ == "__main__":
    sys.exit(main())
