/* ===========================================================================
   THETA DESK — panels-ab.js — the STATUS RAIL, the COMMAND STRIP, the FOOTER
   and columns A and B of window.TDP.

     P00 status   P01 command   P99 footer
     A1 signal    A2 tree       A3 authority   A4 weakness
     B1 ledger    B2 equity     B3 thesis      B4 greeks     B5 ribbon

   Every renderer is  TDP.<key>(host, D, S)  where <key> is the panel's
   data-panel attribute, host is its [data-body] element (the region itself
   for the three chrome rows), D is TDD.derive(data) and S is the state.

   HOUSE RULES OBSERVED HERE
     · Not one hex literal and not one colour name: every stroke and fill
       comes from TDC.C (SPEC 3.7).  `make lint-hex` must stay clean.
     · The integrity green is never referenced.  `make lint-green` stays clean.
     · Green means system integrity; a negative P&L is ink with a leading
       U+2212, produced by TDC.fmt, and geometry below a labelled zero rule.
     · No number is invented.  Anything D reports as null renders the SPEC 3.6
       .notpub empty state naming the field path and the fix, never a zero.
     · No renderer holds state.  Panel-local controls patch S through TD.set()
       under namespaced keys (b2mode, b3upper, …) and read them back with a
       default, so one setter still drives one render pass.
     · No renderer attaches a window or document listener.  Listeners are
       attached once, to elements this file creates or adopts, and every such
       element is stamped data-wired="tdp" so app.js does not double-wire it.
     · Every x position comes from the ONE shared tick index (D.spine).  No
       panel divides by an array length.
   =========================================================================== */

window.TDP = window.TDP || {};

(function (global, doc) {
'use strict';

var TDC = global.TDC;
var TDD = global.TDD;
if (!TDC) { if (global.console) console.error('[TDP] charts.js must load first'); return; }

var F = TDC.fmt;
var K = TDC.K;
var MINUS = F.minus;
var WIRED = 'data-wired';

/* --------------------------------------------------------------------------
   0 · SMALL UTILITIES
   -------------------------------------------------------------------------- */
function C() { return TDC.C; }                     /* read at call time */
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function num(v) { return isNum(v) ? v : null; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function esc(s) { return TDC.esc(s); }
function keysOf(o) { var a = [], k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) a.push(k); return a; }

/* The only way state changes (SPEC 7.2).  Absent TD (the standalone probe),
   a control is inert rather than broken. */
function set(patch) {
  if (global.TD && typeof global.TD.set === 'function') { global.TD.set(patch); return true; }
  return false;
}

/* --------------------------------------------------------------------------
   1 · DOM HELPERS.  Renderers run on every state pass, so everything here is
   idempotent: a node is built once, kept on its parent under a private key,
   and thereafter only updated.  Rebuilding would drop the listeners the
   controls carry and would steal the caret from a focused input.
   -------------------------------------------------------------------------- */
function mk(tag, cls, text) {
  var n = doc.createElement(tag || 'div');
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(n) { if (n) while (n.firstChild) n.removeChild(n.firstChild); }
function txt(n, s) { if (n && n.textContent !== String(s)) n.textContent = String(s); }
function html(n, s) { if (n && n.__tdph !== s) { n.innerHTML = s; n.__tdph = s; } }
function cls(n, name, on) { if (!n) return; if (on) n.classList.add(name); else n.classList.remove(name); }
/* NEVER test a class with indexOf: "cmd-kpis".indexOf("kpis") is 4, and the
   command strip then never receives the .kpis that makes it a flex row. */
function addCls(n, name) { if (n && n.classList && !n.classList.contains(name)) n.classList.add(name); return n; }
function hasCls(n, name) { return !!(n && n.classList && n.classList.contains(name)); }
function att(n, k, v) {
  if (!n) return;
  if (v === null || v === undefined || v === false) { if (n.hasAttribute(k)) n.removeAttribute(k); }
  else if (n.getAttribute(k) !== String(v)) n.setAttribute(k, String(v));
}
function title(n, s) { if (n && n.title !== String(s || '')) n.title = String(s || ''); }

/* A persistent child.  slot(parent,'chart','div','chart') returns the same
   node on every pass; appended in first-call order, so order is stable. */
function slot(parent, key, tag, className) {
  if (!parent) return null;
  var k = '__tdp_' + key, n = parent[k];
  if (n && n.parentNode === parent) { if (className && n.className !== className) n.className = className; return n; }
  n = mk(tag || 'div', className || null);
  parent[k] = n;
  parent.appendChild(n);
  return n;
}
/* Attach a listener exactly once to a node this file owns or adopts. */
function wire(n, ev, fn) {
  if (!n || n.__tdpw && n.__tdpw[ev]) return n;
  n.addEventListener(ev, fn);
  n.__tdpw = n.__tdpw || {};
  n.__tdpw[ev] = 1;
  att(n, WIRED, 'tdp');
  return n;
}
/* Handlers that must see the current D/S: the node keeps a mutable payload. */
function payload(n, p) { n.__tdpp = p; return n; }

function flash(n, msg, ms) {
  if (!n) return;
  var prev = n.__tdpflash;
  if (prev) clearTimeout(prev);
  var was = n.__tdpwas === undefined ? n.textContent : n.__tdpwas;
  n.__tdpwas = was;
  n.textContent = msg;
  n.classList.add('flash');
  n.__tdpflash = setTimeout(function () {
    n.classList.remove('flash');
    n.textContent = n.__tdpwas || '';
    n.__tdpflash = null;
  }, ms || 1600);
}

/* --------------------------------------------------------------------------
   2 · THE .notpub EMPTY STATE (SPEC 3.6) — one rule for every missing thing.
   -------------------------------------------------------------------------- */
function notpub(parent, key, path, fix, inline) {
  var n = slot(parent, 'np_' + key, 'div', 'notpub' + (inline ? ' inline' : ''));
  html(n, '<b>not published</b><span>' + esc(path) + '</span>' +
          (fix ? '<span>' + esc(fix) + '</span>' : ''));
  return n;
}
/* The same, driven by derive's registry so the reason is the measured one. */
function notpubFor(parent, D, key, inline) {
  var m = D && D.missingByKey ? D.missingByKey[key] : null;
  if (!m) return notpub(parent, key, key, null, inline);
  var n = slot(parent, 'np_' + key, 'div', 'notpub' + (inline ? ' inline' : ''));
  html(n, '<b>not published</b><span>' + esc(m.path) + '</span><span>' + esc(m.fix) + '</span>');
  title(n, m.why);
  return n;
}
/* A series that exists but never varied (SPEC 3.6): a labelled scalar. */
function degenerate(parent, key, label, denom) {
  var n = slot(parent, 'dg_' + key, 'div', 'notpub inline');
  html(n, '<b>' + esc(label) + '</b><span>' + esc(denom) + '</span>');
  return n;
}
/* A judge-mode annotation (SPEC 7.8): inert until :root[data-judge="1"]. */
function judgeNote(parent, key, markup) {
  var n = slot(parent, 'jn_' + key, 'div', 'jn');
  html(n, markup);
  return n;
}

/* --------------------------------------------------------------------------
   3 · PANEL PLUMBING — the header hooks every panel carries (SPEC 3.3).
   -------------------------------------------------------------------------- */
function panelOf(host) {
  if (!host) return null;
  if (host.closest) return host.closest('.p') || host.closest('[data-panel]');
  var n = host;
  while (n && !(n.classList && n.classList.contains('p'))) n = n.parentNode;
  return n;
}
function hookOf(host, sel) { var p = panelOf(host); return p ? p.querySelector(sel) : null; }
function controls(host) { return hookOf(host, '.pc'); }
function readout(host, s, tip) {
  var n = hookOf(host, '.pr');
  if (!n) return null;
  txt(n, s);
  title(n, tip === undefined ? s : tip);
  return n;
}
function provenance(host, s, tip) {
  var n = hookOf(host, '.pf');
  if (!n) return null;
  txt(n, s);
  title(n, tip === undefined ? s : tip);
  return n;
}

/* --------------------------------------------------------------------------
   4 · CONTROL VOCABULARY (SPEC 3.4) — segmented, chip, toggle.  Built once,
   updated thereafter, so a click handler survives every render pass.
   -------------------------------------------------------------------------- */
function seg(parent, key, items, cur, onPick, label) {
  var wrap = null, s;
  if (label) {
    wrap = slot(parent, 'sw_' + key, 'div', 'grp ctlg');
    slot(wrap, 'lab', 'span', 'lab ctll');
    txt(wrap.__tdp_lab, label);
    s = slot(wrap, 'seg_' + key, 'div', 'seg');
  } else {
    s = slot(parent, 'seg_' + key, 'div', 'seg');
  }
  att(s, 'role', 'radiogroup');
  att(s, 'aria-label', key);
  att(s, 'data-ctl', key);
  var i, b;
  for (i = 0; i < items.length; i++) {
    b = slot(s, 'b_' + items[i].v, 'button', null);
    att(b, 'type', 'button');
    att(b, 'role', 'radio');
    att(b, 'data-v', items[i].v);
    txt(b, items[i].label);
    if (items[i].title) title(b, items[i].title);
    payload(b, items[i].v);
    wire(b, 'click', function () { onPick(this.__tdpp); });
  }
  for (i = 0; i < items.length; i++) {
    b = s['__tdp_b_' + items[i].v];
    att(b, 'aria-checked', items[i].v === cur ? 'true' : 'false');
  }
  return s;
}

function chip(parent, key, label, on, onClick, tip, count, extra) {
  var b = slot(parent, 'chip_' + key, 'button', 'chip' + (extra ? ' ' + extra : ''));
  att(b, 'type', 'button');
  att(b, 'data-chip', key);
  var body = esc(label) + (count === null || count === undefined ? ''
            : ' <span class="n">' + esc(String(count)) + '</span>');
  html(b, body);
  att(b, 'aria-pressed', on ? 'true' : 'false');
  if (tip) title(b, tip);
  if (onClick) { payload(b, onClick); wire(b, 'click', function (ev) { this.__tdpp(ev); }); }
  return b;
}

/* --------------------------------------------------------------------------
   5 · STATE READERS.  Panel-local controls live on S under namespaced keys;
   every one has a default here so an app.js that never heard of them works.
   -------------------------------------------------------------------------- */
function sv(S, key, dflt) {
  if (!S) return dflt;
  var v = S[key];
  return (v === undefined || v === null) ? dflt : v;
}
function axisMode(S) { return sv(S, 'axis', 'session') === 'time' ? 'time' : 'session'; }
function quality(S) { return sv(S, 'quality', 'all') === 'clean' ? 'clean' : 'all'; }

/* S.books may be a Set (SPEC 7.1) or an array; read as a map, write back in
   the shape it arrived in so app.js's hash writer keeps working. */
function bookMap(S) {
  var b = S ? S.books : null, out = {}, i;
  if (!b) return { real: 1, shadow_nogates: 1, shadow_nohedge: 1, baseline_naive: 1 };
  if (typeof b.forEach === 'function' && typeof b.size === 'number') { b.forEach(function (k) { out[k] = 1; }); return out; }
  if (typeof b.length === 'number') { for (i = 0; i < b.length; i++) out[b[i]] = 1; return out; }
  return b;
}
function bookWrite(S, map) {
  var keys = [], k;
  for (k in map) if (map[k]) keys.push(k);
  var b = S ? S.books : null;
  if (b && typeof b.size === 'number' && typeof global.Set === 'function') return new global.Set(keys);
  return keys;
}

/* The window every time panel shares. */
function win(D, S) {
  var r = sv(S, 'range', '3d');
  var w = D.spine.slice(r);
  return { i0: w[0], i1: w[1] };
}

/* --------------------------------------------------------------------------
   6 · THE SHARED TICK INDEX (SPEC 6.2).
   D.spine is the index; charts.js needs three methods derive does not expose
   (of / isBreak / breakBetween).  This is an adapter, not a second index —
   there is exactly one clustering in the page and it is derive's.
   -------------------------------------------------------------------------- */
var IXC = (typeof global.WeakMap === 'function') ? new global.WeakMap() : null;
function IX(D) {
  var s = D.spine;
  var w = IXC ? IXC.get(s) : s.__tdpix;
  if (w) return w;
  w = {
    n: s.n, ticks: s.ticks, days: s.days, dayBreaks: s.dayBreaks,
    at: function (t) { return s.at(t); },
    near: function (t) { return s.near(t); },
    bind: function (t) { return s.bind(t); },
    slice: function (r) { return s.slice(r); },
    window: function (r) { return s.window(r); },
    inRange: function (i, r) { return s.inRange(i, r); },
    dayOfTick: function (i) { return s.dayOfTick(i); },
    /* charts.js joins with of(); containing-else-closest, never -1 for a
       minute-truncated stamp (positions[].opened, trades[].closed). */
    of: function (t) { var i = s.bind(t); return (i === null || i === undefined) ? -1 : i; },
    isBreak: function (i) { for (var j = 0; j < s.dayBreaks.length; j++) if (s.dayBreaks[j] === i) return true; return false; },
    breakBetween: function (a, b) {
      var ta = s.ticks[a], tb = s.ticks[b];
      return !!(ta && tb && ta.dayIdx !== tb.dayIdx);
    },
    label: function (i, mode) {
      var t = s.ticks[i];
      if (!t) return F.DASH;
      switch (mode) {
        case 'hm': return t.hm;
        case 'md': return t.md;
        case 'ymd': return t.day;
        case 'iso': case 'full': return t.t;
        case 'dow': return F.ts(t.t, 'dow');
        default: return t.md + ' ' + t.hm + 'Z';
      }
    }
  };
  if (IXC) IXC.set(s, w); else s.__tdpix = w;
  return w;
}

/* Points already carry {i,v}; this trims them to the visible window so a
   scale never sees a value it will not draw. */
function inWin(pts, w) {
  var out = [], j;
  for (j = 0; j < (pts || []).length; j++) {
    var p = pts[j];
    if (!p || p.i < w.i0 || p.i > w.i1) continue;
    out.push(p);
  }
  return out;
}
function lastIn(pts, w) {
  var v = null, j;
  for (j = 0; j < (pts || []).length; j++) if (pts[j].i >= w.i0 && pts[j].i <= w.i1 && isNum(pts[j].v)) v = pts[j].v;
  return v;
}
function valueAtOf(pts) {
  var m = {}, j;
  for (j = 0; j < (pts || []).length; j++) if (isNum(pts[j].v)) m[pts[j].i] = pts[j].v;
  return function (i) { return m[i] === undefined ? null : m[i]; };
}

/* A chart host that fills its panel body. */
function chartHost(host, key) { return slot(host, key || 'chart', 'div', 'chart'); }
/* A body split into an 18px control strip and a chart.  .lanes is the one
   flex column styles.css defines; .chart carries min-height:0 so the flex
   shrink resolves inside the body instead of scrolling it. */
function stack(host) {
  addCls(host, 'lanes');
  var bar = slot(host, 'bar', 'div', 'row');
  var ch = slot(host, 'chart', 'div', 'chart');
  return { bar: bar, chart: ch };
}

/* Book identity, never mapped by hand. */
function bookColor(key) { return C().book[key] || C().soft; }
function bookShort(key) {
  return key === 'real' ? 'REAL' : key === 'shadow_nogates' ? 'NO-GATES'
       : key === 'shadow_nohedge' ? 'NO-HEDGE' : key === 'baseline_naive' ? 'NAIVE' : key;
}
/* S.base names a shadow; this is the series key it points at. */
var BASE_KEY = { nogates: 'shadow_nogates', nohedge: 'shadow_nohedge', naive: 'baseline_naive' };
var KEY_BASE = { shadow_nogates: 'nogates', shadow_nohedge: 'nohedge', baseline_naive: 'naive' };

/* Regime / vote colours — one mapping for A1, B3 and B5 so a "rich" cell is
   the same brass everywhere. */
function regimeColor(c) {
  var K2 = C();
  return c === 'rich' ? K2.gate : c === 'cheap' ? K2.rv : c === 'neutral' ? K2.raised : null;
}

/* ===========================================================================
   P00 · STATUS RAIL  —  shell row 1, 26px, six zones (SPEC 5 P00)
   ===========================================================================
   NOTE ON THE ONE COORDINATION DEFECT IN THE KERNEL.  styles.css lays the
   three chrome rows out through the id selectors #status, #command and #foot;
   index.html names those regions #p-status, #p-command and #p-footer (and it
   has to keep #p-status, because the green rule in styles.css is written
   `#p-status .chip-integrity`).  Neither file is mine to edit, so each
   renderer nests one element carrying the id styles.css is looking for and
   re-parents the region's existing hooks into it.  Node identity is preserved
   throughout — every data-* hook index.html shipped survives, with whatever
   listeners it carries — so the real fix (adding #p-status, #p-command and
   #p-footer to those three selector lists in styles.css) turns this shim into
   a harmless wrapper rather than a conflict.
   =========================================================================== */

function shimIn(host, id, className) {
  /* #shell has grid-template-rows but no columns, so its single implicit
     column is sized by its items' automatic minimum, which for a nowrap
     chrome row is the whole sentence — 3,549px against a 1,440px viewport,
     and the footer falls off the bottom of the clipped shell.  An item whose
     overflow is not `visible` has an automatic minimum of zero instead;
     .trunc is the class styles.css already defines for exactly that
     (overflow:hidden; min-width:0; white-space:nowrap), and every child here
     sets its own wrapping, so it changes nothing but the track sizing. */
  if (host && host.classList && !host.classList.contains('trunc')) host.classList.add('trunc');
  var n = doc.getElementById(id);
  if (!n) { n = mk('div', className || null); n.id = id; }
  if (n.parentNode !== host) host.appendChild(n);
  att(n, 'data-shim', 'tdp');
  return n;
}
function zone(parent, id, extra) {
  var n = doc.getElementById(id);
  if (!n) { n = mk('div'); n.id = id; }
  if (n.parentNode !== parent) parent.appendChild(n);
  var want = 'rz zone' + (extra ? ' ' + extra : '');
  if (n.className !== want) n.className = want;
  return n;
}
function hook(parent, attrName, tag, className) {
  var n = parent.querySelector('[' + attrName + ']');
  if (!n) { n = mk(tag || 'span', className || null); n.setAttribute(attrName, ''); parent.appendChild(n); }
  else if (className && n.className !== className) n.className = className;
  return n;
}
function byId(parent, id, tag, className) {
  var n = doc.getElementById(id);
  if (!n) { n = mk(tag || 'span', className || null); n.id = id; }
  if (n.parentNode !== parent) parent.appendChild(n);
  if (className && n.className !== className) n.className = className;
  return n;
}

function P_status(host, D, S) {
  if (!host || !D) return;
  var rail = shimIn(host, 'status', 'rail');
  var now = Date.now();
  var L = D.liveness(now);
  var st = D.status;

  /* (1) market state — CLOSED / OPEN plus the session date; the scheduler
         sentence is the title.  Derived from the last tick against the
         13:30-20:00 UTC Mon-Fri window, never asserted. */
  var z1 = zone(rail, 'st-market');
  var vm = hook(z1, 'data-market', 'span', 'state');
  var lt = st.lastTick;
  txt(vm, (L.marketState || 'CLOSED') + ' · ' +
          (lt ? (lt.dowName + ' ' + lt.dayNum + ' ' + lt.monName) : F.DASH));
  title(z1, 'scheduler ' + st.window.text + ' · state derived from the last tick, ' +
            (lt ? lt.t + 'Z' : F.DASH));

  /* (2) as of — book.marked_at.  Click toggles absolute/relative page-wide. */
  var z2 = zone(rail, 'st-asof', 'act');
  var ba = hook(z2, 'data-asof', 'button', 'rbtn');
  att(ba, 'type', 'button');
  var tsMode = sv(S, 'ts', 'abs');
  txt(ba, tsMode === 'rel' ? ('marked ' + F.age(D.meta.markedAt, now))
                           : ('as of ' + F.ts(D.meta.markedAt, 'hms') + 'Z'));
  att(ba, 'aria-pressed', tsMode === 'rel' ? 'true' : 'false');
  title(ba, 'book.marked_at ' + D.meta.markedAt + 'Z — click to toggle absolute / relative timestamps page-wide');
  payload(ba, tsMode);
  wire(ba, 'click', function () { set({ ts: this.__tdpp === 'rel' ? 'abs' : 'rel' }); });

  /* (3) tick n · age · next.  Amber past 30 minutes, inside the window only. */
  var z3 = zone(rail, 'st-tick', 'act');
  var bt = hook(z3, 'data-tick', 'button', 'rbtn');
  cls(bt, 'stale', !!L.stale);
  att(bt, 'type', 'button');
  var nextTxt;
  if (L.marketOpen) nextTxt = 'next ~' + Math.max(0, L.nextTickInMin) + 'm';
  else if (isNum(L.nextOpenInMin)) nextTxt = 'opens in ' + F.dur(L.nextOpenInMin / 60);
  else nextTxt = 'market closed';
  txt(bt, 'tick ' + F.count(st.ticks) + ' · ' + F.age(lt ? lt.t : null, now) + ' · ' + nextTxt);
  title(bt, st.ticks + ' tick_start rows; the shared index clusters every series into ' +
            st.spineTicks + ' ticks. Cadence ' + st.window.cadenceMin + ' min, ' + st.window.text +
            '. Click to jump to the last tick and lock the cursor.');
  payload(bt, D);
  wire(bt, 'click', function () {
    var d = this.__tdpp, last = d.spine.n - 1;
    set({ range: '1d', cur: last, locked: true });
    TDC.cursor.lock(last, 'status');
  });

  /* (4) tick mode.  kv.last_tick_mode is published; a PER-TICK mode is not. */
  var z4 = zone(rail, 'st-mode');
  var cm = hook(z4, 'data-mode', 'span', 'chip');
  if (st.tickMode) {
    txt(cm, String(st.tickMode).replace(/_/g, ' ').toUpperCase());
    title(cm, 'kv.last_tick_mode = ' + st.tickMode + ' at ' + (st.tickModeAt || F.DASH) +
              ' — the mode of the LAST tick only. series.ticks[] carries te/dur/mock/dry, not a per-tick mode.');
  } else {
    txt(cm, 'MODE —');
    title(cm, 'kv.last_tick_mode not published');
  }

  /* (5) integrity and chain — the only two green chips on the page, and green
         only while they are true. */
  var z5 = zone(rail, 'st-chips');
  var ci = hook(z5, 'data-integrity', 'button', 'chip chip-integrity');
  att(ci, 'type', 'button');
  var ig = D.integrity;
  if (!ig || !ig.n) {
    txt(ci, 'INTEGRITY UNAVAILABLE'); att(ci, 'data-state', 'none');
    title(ci, 'series.integrity is absent — this chip is never green on an absent series');
  } else if (ig.allClear) {
    txt(ci, 'ALL CLEAR ' + F.count(ig.n)); att(ci, 'data-state', null);
    title(ci, ig.n + ' integrity events, all ok');
  } else {
    txt(ci, F.count(ig.fail) + (ig.fail === 1 ? ' EXCEPTION' : ' EXCEPTIONS'));
    att(ci, 'data-state', 'bad');
    title(ci, ig.failures.length ? (ig.failures[0].t + 'Z — ' + ig.failures[0].reason) : 'integrity exception');
  }
  payload(ci, ig);
  wire(ci, 'click', function () {
    var g = this.__tdpp;
    if (g && g.failures && g.failures.length) set({ sel: { type: 'integrity', id: g.failures[0].k } });
  });

  var cc = hook(z5, 'data-chain', 'button', 'chip chip-chain');
  att(cc, 'type', 'button');
  var chn = st.chain;
  txt(cc, (chn.ok ? 'CHAIN INTACT' : 'CHAIN BROKEN') + ' · ' + F.count(chn.entries));
  att(cc, 'data-state', chn.ok ? null : 'bad');
  title(cc, chn.msg + ' — click to copy ' + st.verifyCommand);
  payload(cc, st.verifyCommand);
  wire(cc, 'click', function () { TDC.copy(this.__tdpp); flash(this, 'COPIED'); });

  /* (6) refresh, commit, keymap. */
  var z6 = zone(rail, 'st-right', 'grow');
  var br = byId(z6, 'st-refresh', 'button', 'rbtn');
  att(br, 'data-refresh', ''); att(br, 'type', 'button');
  txt(br, '⟳');
  title(br, 'fetch data.json again — there is no auto-refresh timer and no pause control');
  var out = byId(z6, 'st-refresh-out', 'span', 'rout c-faint');
  att(out, 'data-refresh-out', '');
  payload(br, out);
  wire(br, 'click', function () {
    var o = this.__tdpp;
    if (global.TD && typeof global.TD.refresh === 'function') { txt(o, 'fetching…'); global.TD.refresh(true); }
    else flash(o, 'hosted snapshot — refresh unavailable', 3200);
  });

  var bc = byId(z6, 'st-commit', 'button', 'rbtn mono hash');
  att(bc, 'data-commit', ''); att(bc, 'type', 'button');
  txt(bc, D.meta.commit || F.DASH);
  title(bc, 'commit ' + (D.meta.commit || F.DASH) + ' · account ' + (D.meta.account || F.DASH) +
            ' · generated ' + F.ts(D.meta.generatedUtc, 'iso') + ' — click to copy');
  payload(bc, { commit: D.meta.commit, out: out });
  wire(bc, 'click', function () {
    var p = this.__tdpp;
    TDC.copy(p.commit);
    flash(p.out, 'copied ' + p.commit, 1600);
  });

  var bk = byId(z6, 'st-keymap', 'button', 'rbtn');
  att(bk, 'data-keymap', ''); att(bk, 'type', 'button');
  txt(bk, '?');
  title(bk, 'keyboard map');
  wire(bk, 'click', function () {
    if (global.TD && typeof global.TD.keymap === 'function') { global.TD.keymap(); return; }
    var ov = doc.getElementById('ov-keymap') || doc.getElementById('keymap');
    if (ov) ov.hidden = !ov.hidden;
  });
}

/* ===========================================================================
   P01 · COMMAND STRIP  —  shell row 2, 52px (SPEC 5 P01)
   Three counted funnels, six KPI cells, and the global parameter set.
   =========================================================================== */

function bb(s) { return '<b>' + esc(s) + '</b>'; }

function funnelLine(parent, id, label, parts) {
  var f = doc.getElementById(id);
  if (!f) { f = mk('div', 'funnel'); f.id = id; }
  if (f.parentNode !== parent) parent.appendChild(f);
  addCls(f, 'funnel');
  var l = f.querySelector('.fl') || f.querySelector('.lab');
  if (!l) { l = mk('span', 'fl lab'); f.insertBefore(l, f.firstChild); }
  else addCls(l, 'lab');
  txt(l, label);
  var v = f.querySelector('[data-v]');
  if (!v) { v = mk('span', 'fv'); v.setAttribute('data-v', ''); f.appendChild(v); }
  html(v, parts);
  return f;
}

function kpiCell(parent, key, label, value, sub, sparkPts, sparkColor, tab, primary, extraClass, sparkH, tip) {
  var cell = parent.querySelector('[data-kpi="' + key + '"]');
  if (!cell) {
    cell = mk(tab ? 'button' : 'span', 'kpi');
    cell.setAttribute('data-kpi', key);
    if (tab) { cell.setAttribute('type', 'button'); cell.setAttribute('data-tab', tab); }
  }
  if (cell.parentNode !== parent) parent.appendChild(cell);
  var want = 'kpi' + (primary ? ' primary' : '') + (tab ? ' act' : '') + (extraClass ? ' ' + extraClass : '');
  if (cell.className !== want) cell.className = want;

  var kl = cell.querySelector('.kl, .k');
  if (!kl) { kl = mk('span', 'kl k'); cell.appendChild(kl); }
  else addCls(kl, 'k');
  html(kl, label);

  var kv = cell.querySelector('.kv, .v');
  if (!kv) { kv = mk('span', 'kv v'); kv.setAttribute('data-v', ''); cell.appendChild(kv); }
  else addCls(kv, 'v');
  txt(kv, value);

  var ks = cell.querySelector('.ks, .spark');
  if (sparkPts && sparkPts.length) {
    if (!ks) { ks = mk('span', 'ks spark'); ks.setAttribute('data-spark', ''); cell.appendChild(ks); }
    else addCls(ks, 'spark');
    ks.hidden = false;
    TDC.spark(ks, { pts: sparkPts, w: 44, h: sparkH || 16, color: sparkColor || C().ink, zero: true, mark: 'last' });
  } else if (ks) ks.hidden = true;

  var sb = cell.querySelector('.sub');
  if (sub) {
    if (!sb) { sb = mk('span', 'sub'); cell.appendChild(sb); }
    sb.hidden = false; txt(sb, sub);
  } else if (sb) sb.hidden = true;

  if (tab) { payload(cell, tab); wire(cell, 'click', function () { set({ tab: this.__tdpp }); }); }
  if (tip) title(cell, tip);
  return cell;
}

function globalSeg(id, cur, onPick) {
  var s = doc.getElementById(id);
  if (!s) return null;
  var bs = s.querySelectorAll('button[data-v]'), i, b2;
  for (i = 0; i < bs.length; i++) {
    b2 = bs[i];
    att(b2, 'aria-checked', b2.getAttribute('data-v') === String(cur) ? 'true' : 'false');
    payload(b2, b2.getAttribute('data-v'));
    wire(b2, 'click', function () { onPick(this.__tdpp); });
  }
  return s;
}

function P_command(host, D, S) {
  if (!host || !D) return;
  var strip = shimIn(host, 'command', 'cmd');

  /* ---- funnels ---------------------------------------------------------- */
  var fw = doc.getElementById('cmd-funnels');
  if (!fw) { fw = mk('div', 'funnels cmd-funnels'); fw.id = 'cmd-funnels'; }
  if (fw.parentNode !== strip) strip.appendChild(fw);
  addCls(fw, 'funnels');

  var cy = D.funnels.cycle, se = D.funnels.session, bo = D.funnels.book;
  funnelLine(fw, 'cf-cycle', 'CYCLE',
    bb(F.count(cy.candidates)) + ' candidate · ' + bb(F.count(cy.gated)) + ' gated · ' +
    bb(F.count(cy.entered)) + ' entered <span class="c-faint">' +
    esc(cy.t ? F.ts(cy.t, 'hm') + 'Z' : '') + '</span>');
  funnelLine(fw, 'cf-session', 'SESSION',
    bb(F.count(se.ticks)) + ' ticks · ' + bb(F.count(se.gateEvals)) + ' evals · ' +
    bb(F.count(se.ordersLive)) + ' orders · ' + bb(F.count(se.refused)) + ' refused');
  var fs2 = doc.getElementById('cf-session');
  if (fs2) title(fs2, se.ticks + ' tick_start rows · ' + se.gateEvals + ' gate evaluations · ' +
    se.ordersLive + ' orders submitted live · ' + se.refused + ' entries refused by a gate · ' +
    se.meetings + ' desk meetings · ' + se.signals + ' signals');
  /* styles.css caps .funnels at 23% of the strip, so this line is written to
     the dollar: the cents live one row down in the KPI cells and in B1, and
     the full-precision string is the funnel's title. */
  funnelLine(fw, 'cf-book', 'BOOK',
    bb(F.usd0(bo.pnl)) + ' marked · ' + bb(F.usd0(bo.realized)) + ' realized · ' +
    bb(F.usd0(bo.unrealized)) + ' unrealized · ' + bb(F.money(bo.brokerEquity, 0)) + ' broker');
  var fb2 = doc.getElementById('cf-book');
  if (fb2) title(fb2, F.usd(bo.pnl) + ' marked · ' + F.usd(bo.realized) + ' realized · ' +
    F.usd(bo.unrealized) + ' unrealized · ' + F.money(bo.brokerEquity) + ' broker equity · marked at ' +
    bo.markedAt + 'Z');
  title(fw, 'CYCLE is the last gate-evaluation timestamp group. ' + D.denominators.note + '.');

  /* ---- KPI cells -------------------------------------------------------- */
  var kw = doc.getElementById('cmd-kpis');
  if (!kw) { kw = mk('div', 'kpis cmd-kpis'); kw.id = 'cmd-kpis'; }
  if (kw.parentNode !== strip) strip.appendChild(kw);
  addCls(kw, 'kpis');

  var cells = D.kpi.cells, i, c, ink = C().ink;
  /* .kpi.primary — SPEC 5 P01's "--f28 at XL" — is deliberately NOT applied.
     styles.css caps .funnels at 23% and .ctrls at 32%, so six KPI cells share
     833px at 1920 and a cell is 139px wide with 123px of content box.  An
     eight-character money value ("+$460.85") needs ~134px at 28px, and the
     cell's own overflow:hidden ellipsises it to "+$460…" — a headline number
     with its cents cut off is worse than a slightly smaller headline number.
     Without .primary the value takes clamp(13px, 1.35vw, --f22) = 22px, which
     fits with room for the 16px sparkline under it.  The hook stays available
     to app.js if the strip is ever given more width. */
  var skH = 16;
  for (i = 0; i < cells.length; i++) {
    c = cells[i];
    /* Signed, two decimals, no currency glyph — exactly how SPEC 4.6 and
       SPEC 5 B1 write these figures ("book +460.85 / realized 598.00 /
       unrealized −137.15").  The glyph costs one character, and one character
       is the difference between a whole number and "+$460.…" at 1440px. */
    if (c.key === 'book') kpiCell(kw, 'book', 'BOOK P&amp;L', F.sgn(c.value, 2), null, c.spark, ink, null, false, null, skH,
      'book P&L ' + F.usd(c.value) + ' (' + F.pctRaw(D.kpi.book.pnlPct, 2) + ' of the ' + F.money(D.kpi.book.start, 0) + ' start) · ' + c.src);
    else if (c.key === 'realized') kpiCell(kw, 'realized', 'REALIZED', F.sgn(c.value, 2), null, c.spark, ink, null, false, null, skH,
      'realized ' + F.usd(c.value) + ' across ' + D.trades.n + ' closed trades · ' + c.src);
    else if (c.key === 'unrealized') kpiCell(kw, 'unrealized', 'UNREALIZED', F.sgn(c.value, 2), null, c.spark, ink, null, false, null, skH,
      'unrealized ' + F.usd(c.value) + ' on ' + D.structures.reported.open + ' open structures · ' + c.src);
    else if (c.key === 'refused') kpiCell(kw, 'refused', 'REFUSED', F.count(c.value),
      'of ' + F.count(D.denominators.gateEvaluations) + ' gate evals', null, null, 'refusals');
    else if (c.key === 'structures') kpiCell(kw, 'structures', 'STRUCTURES', F.count(c.value),
      F.count(c.parts.open) + ' open · ' + F.count(c.parts.closed) + ' closed · ' +
      F.count(c.parts.unfilled) + ' unfilled', null, null, 'positions');
    else if (c.key === 'journal') kpiCell(kw, 'journal', 'JOURNAL', F.count(c.value),
      D.status.chain.ok ? 'chain intact' : 'chain broken', null, null, 'all');
  }
  /* SPEC 4.4: at S the SIGNAL tiles fold into the KPI row.  .only-s is inert
     at every width above 1179px, so this costs nothing at XL / L / M. */
  var sg = D.signal.current;
  kpiCell(kw, 'iv', 'IV ATM', F.vol(sg.atm_iv), null, null, null, null, false, 'only-s');
  kpiCell(kw, 'rv', 'RV 20D', F.vol(sg.rv20), null, null, null, null, false, 'only-s');
  kpiCell(kw, 'vrp', 'VRP', F.num(sg.vrp, 2), null, null, null, null, false, 'only-s');
  kpiCell(kw, 'spot', 'SPOT', F.num(sg.spot, 2), null, null, null, null, false, 'only-s');

  /* ---- the global parameter set ----------------------------------------- */
  var cw = doc.getElementById('cmd-controls');
  if (!cw) { cw = mk('div', 'ctrls cmd-controls'); cw.id = 'cmd-controls'; }
  if (cw.parentNode !== strip) strip.appendChild(cw);
  addCls(cw, 'ctrls');
  var grps = cw.querySelectorAll('.ctlg'), gi;
  for (gi = 0; gi < grps.length; gi++) addCls(grps[gi], 'grp');
  var labs = cw.querySelectorAll('.ctll'), li;
  for (li = 0; li < labs.length; li++) addCls(labs[li], 'lab');

  globalSeg('ctl-range', sv(S, 'range', '3d'), function (v) { set({ range: v }); });
  globalSeg('ctl-axis', axisMode(S), function (v) { set({ axis: v }); });
  globalSeg('ctl-quality', quality(S), function (v) { set({ quality: v }); });
  globalSeg('ctl-density', sv(S, 'density', 'compact'), function (v) { set({ density: v }); });

  var bmap = bookMap(S), bkc = doc.getElementById('ctl-books');
  if (bkc) {
    bkc.__tdpS = S;
    var bbs = bkc.querySelectorAll('button[data-v]'), bi, b3, bkey, bd;
    for (bi = 0; bi < bbs.length; bi++) {
      b3 = bbs[bi]; bkey = b3.getAttribute('data-v'); bd = D.books.byKey[bkey];
      att(b3, 'aria-pressed', bmap[bkey] ? 'true' : 'false');
      title(b3, bd && bd.present
        ? (bd.label + ' · final ' + F.usd(bd.final.v) + ' · ' + bd.n + ' marks · realized ' + F.usd(bd.final.r))
        : (bkey + ' — not published'));
      payload(b3, bkey);
      wire(b3, 'click', function () {
        var S2 = this.parentNode.__tdpS, m = bookMap(S2), kk = this.__tdpp;
        m[kk] = !m[kk];
        set({ books: bookWrite(S2, m) });
      });
    }
  }
  var qx = doc.querySelector('[data-quality-excluded]');
  if (qx) {
    txt(qx, F.count(D.quality.excluded) + ' excluded');
    title(qx, D.quality.quarantine.length
      ? (D.quality.excluded + ' marks quarantined — ' + D.quality.quarantine[0].reason)
      : 'no quarantined marks');
  }

  var jb = doc.getElementById('ctl-judge');
  if (jb) {
    jb.__tdpS = S;
    att(jb, 'aria-pressed', sv(S, 'judge', false) ? 'true' : 'false');
    title(jb, 'reveal the inline annotations attached to the panels they explain');
    wire(jb, 'click', function () { set({ judge: !sv(this.__tdpS, 'judge', false) }); });
  }
  var xb = doc.getElementById('ctl-export');
  if (xb) {
    title(xb, 'export the current blotter view as CSV');
    wire(xb, 'click', function () {
      if (global.TD && typeof global.TD.export === 'function') global.TD.export();
      else flash(this, 'EXPORT UNAVAILABLE', 2000);
    });
  }
  var fb = doc.getElementById('ctl-filters');
  if (fb) {
    var active = 0, names = [];
    if (sv(S, 'gate', null)) { active++; names.push('gate ' + S.gate); }
    if (sv(S, 'kind', null)) { active++; names.push('kind ' + S.kind); }
    if (sv(S, 'underlying', null)) { active++; names.push('underlying ' + S.underlying); }
    if (sv(S, 'q', '')) { active++; names.push('search "' + S.q + '"'); }
    if (sv(S, 'from', '')) { active++; names.push('from ' + S.from); }
    if (sv(S, 'to', '')) { active++; names.push('to ' + S.to); }
    if (quality(S) === 'clean') { active++; names.push('clean marks only'); }
    fb.hidden = active === 0;
      addCls(fb, 'clear');
    var nEl = fb.querySelector('[data-n]');
    if (nEl) txt(nEl, active);
    title(fb, active ? ('clear ' + names.join(' · ')) : '');
    wire(fb, 'click', function () {
      set({ gate: null, kind: null, underlying: null, q: '', from: '', to: '', quality: 'all' });
    });
  }
}

/* ===========================================================================
   P99 · FOOTER  —  shell row 4, 20px (SPEC 5 P99)
   =========================================================================== */

function P_footer(host, D, S) {
  if (!host || !D) return;
  var f = shimIn(host, 'foot', 'foot');
  /* index.html ships five .fseg spans in this exact order; adopt them so the
     data-commit and data-generated hooks it created keep their identity, and
     never mint a second copy beside them. */
  var segs = host.querySelectorAll('.fseg'), i;
  for (i = 0; i < segs.length; i++) if (segs[i].parentNode !== f) f.appendChild(segs[i]);
  var have = f.querySelectorAll('.fseg'), names = ['s1', 's2', 's3', 's4', 's5'];
  for (i = 0; i < names.length && i < have.length; i++) {
    if (!f['__tdp_' + names[i]]) f['__tdp_' + names[i]] = have[i];
  }

  var s1 = slot(f, 's1', 'span', 'fseg');
  txt(s1, 'paper trading only');

  var s2 = slot(f, 's2', 'span', 'fseg grow');
  txt(s2, 'append-only journal: no update path and no delete path exists in the codebase, and every line carries the SHA-256 of the one before it');
  title(s2, D.status.chain.msg + ' · ' + F.count(D.status.chain.entries) + ' entries · verify with ' + D.status.verifyCommand);

  var s3 = slot(f, 's3', 'span', 'fseg');
  html(s3, 'every figure from data.json @ <button type="button" class="hash mono" data-commit>' +
           esc(D.meta.commit || F.DASH) + '</button>, generated <span class="mono" data-generated>' +
           esc(F.ts(D.meta.generatedUtc, 'iso')) + '</span>');
  var cb = s3.querySelector('[data-commit]');
  if (cb) { payload(cb, D.meta.commit); wire(cb, 'click', function () { TDC.copy(this.__tdpp); flash(this, 'copied'); }); }

  var s4 = slot(f, 's4', 'span', 'fseg');
  txt(s4, 'scheduler ' + D.status.window.text);

  var s5 = slot(f, 's5', 'span', 'fseg right');
  html(s5, '<a href="index.html" target="_blank" rel="noopener">⤢ open standalone</a>');
  title(s5, 'the raw HTML, for a judge on a taller screen than the component gives');
}

/* ===========================================================================
   COLUMN A — the rail.  One selection tree, not five widgets.
   =========================================================================== */

/* Flash a panel the user was sent to.  app.js may own a nicer implementation;
   this is the fallback and it touches no global listener. */
function goTo(id) {
  if (global.TD && typeof global.TD.goto === 'function') { global.TD.goto(id); return; }
  var p = doc.getElementById(id);
  if (!p) return;
  if (p.scrollIntoView) { try { p.scrollIntoView({ block: 'nearest' }); } catch (e) { p.scrollIntoView(); } }
  att(p, 'data-sel', '1');
  setTimeout(function () { if (p.getAttribute('data-sel') === '1') p.removeAttribute('data-sel'); }, 1500);
}
function selIs(S, type, id) {
  var s = S ? S.sel : null;
  return !!(s && s.type === type && (id === undefined || String(s.id) === String(id)));
}

/* ---------------------------------------------------------------------------
   A1 · SIGNAL  (SPEC 5 A1)
   Four tiles, one sans verdict sentence, one provenance line.  The tiles that
   bound the verdict carry the selection border; the others carry none.
   --------------------------------------------------------------------------- */

var A1_UNITS = [
  { v: 'score', label: 'SCORE', title: 'the deterministic VRP score, 0-1' },
  { v: 'pts', label: 'IV−RV PTS', title: 'implied minus realized, in volatility points' },
  { v: 'ratio', label: 'IV/RV ×', title: 'implied over realized' }
];

function tile(parent, key, label, value, pts, color, bound, sel, tip, onClick) {
  var t = slot(parent, 'tile_' + key, 'button', 'tile');
  att(t, 'type', 'button');
  att(t, 'data-tile', key);
  att(t, 'data-bound', bound ? '1' : null);
  att(t, 'data-sel', sel ? '1' : null);
  title(t, tip);
  var k = slot(t, 'k', 'span', 'k');
  html(k, label);
  var v = slot(t, 'v', 'span', 'v');
  var sp = slot(t, 'sp', 'span', 'spark');
  if (value === null || value === undefined) {
    txt(v, F.DASH);
    clear(sp);
  } else {
    txt(v, value);
    if (pts && pts.length) TDC.spark(sp, { pts: pts, w: 38, h: 16, color: color, mark: 'last' });
    else clear(sp);
  }
  if (onClick) { payload(t, onClick); wire(t, 'click', function () { this.__tdpp(); }); }
  return t;
}

function P_signal(host, D, S) {
  if (!host || !D) return;
  var sig = D.signal, cur = sig.current, th = sig.thresholds;
  var pack = quality(S) === 'clean' ? sig.clean : sig.all;
  var w = win(D, S);
  var K2 = C();
  var unit = sv(S, 'a1unit', 'score');

  /* controls — the VRP unit switch */
  seg(controls(host), 'a1unit', A1_UNITS, unit, function (v) { set({ a1unit: v }); });

  var tiles = slot(host, 'tiles', 'div', 'tiles');
  var vrpVal = unit === 'pts' ? F.num(cur.pts, 2) : unit === 'ratio' ? F.ratio(cur.ratio, 2) : F.num(cur.vrp, 2);
  var vrpPts = inWin(unit === 'pts' ? pack.pts : unit === 'ratio' ? pack.ratio : pack.vrp, w);

  function pick(key) {
    return function () { set({ sel: selIs(S, 'signalseries', key) ? null : { type: 'signalseries', id: key } }); };
  }

  tile(tiles, 'iv', 'IV ATM', F.vol(cur.atm_iv), inWin(pack.iv, w), K2.iv, true,
       selIs(S, 'signalseries', 'iv'),
       'signals.atm_iv · ' + sig.n + ' observations · brass = implied', pick('iv'));
  tile(tiles, 'rv', 'RV 20D', F.vol(cur.rv20), inWin(pack.rv, w), K2.rv, true,
       selIs(S, 'signalseries', 'rv'),
       'signals.rv20 · ' + th.rvLookbackDays + '-day lookback · steel = realized', pick('rv'));
  tile(tiles, 'vrp', 'VRP', vrpVal, vrpPts, K2.gate, true,
       selIs(S, 'signalseries', 'vrp'),
       'signals.vrp against params.regime.vrp_rich_threshold ' + th.rich +
       ' / vrp_cheap_threshold ' + th.cheap, pick('vrp'));
  tile(tiles, 'spot', 'SPOT', F.num(cur.spot, 2), inWin(pack.spot, w), K2.soft, false,
       selIs(S, 'signalseries', 'spot'),
       'signals.spot · ' + sig.symCensus.SPY + ' of ' + sig.n + ' observations are SPY', pick('spot'));

  /* the verdict — one sans sentence, computed from the sign and the rule */
  var vRow = slot(host, 'verdict', 'div', 'row tall');
  var vSpan = slot(vRow, 'p', 'span', 'prose');
  var verdict;
  if (!isNum(cur.pts) || !isNum(cur.vrp)) {
    verdict = 'No verdict: the signal series carries no current observation.';
  } else if (cur.regime === 'rich') {
    verdict = 'Implied exceeds realized by ' + F.num(cur.pts, 2) + ' vol points, a ' +
      F.ratio(cur.ratio, 2) + ' ratio, above the ' + F.num(th.rich, 2) +
      ' rich threshold — sell defined-risk premium.';
  } else if (cur.regime === 'cheap') {
    verdict = 'Realized exceeds implied: ' + F.num(cur.pts, 2) + ' vol points at a ' +
      F.ratio(cur.ratio, 2) + ' ratio, below the ' + F.num(th.cheap, 2) +
      ' cheap threshold — buy defined-risk vega, do not sell it.';
  } else {
    verdict = 'The premium is ' + F.num(cur.pts, 2) + ' vol points at a ' + F.ratio(cur.ratio, 2) +
      ' ratio, between the ' + F.num(th.cheap, 2) + ' cheap and ' + F.num(th.rich, 2) +
      ' rich thresholds — no new short premium.';
  }
  html(vSpan, esc(verdict));

  /* the provenance line — the sample-size admission lives here, always */
  var pRow = slot(host, 'prov', 'div', 'row tall act');
  var pSpan = slot(pRow, 'p', 'span', 'prose f10 c-faint trunc');
  var provTxt = 'data_quality ' + (cur.data_quality || 'not recorded') + ' · ' + sig.n +
                ' obs since ' + F.ts(sig.first, 'ymd') + ' · IV rank not computed: ' +
                (sig.ivRankReason || 'insufficient history');
  txt(pSpan, provTxt);
  title(pRow, provTxt + ' — click to open the DECK on PARAMS at params.regime');
  wire(pRow, 'click', function () {
    set({ deck: 'params', sel: { type: 'param', id: 'regime.vrp_rich_threshold' } });
    goTo('p-deck');
  });

  readout(host, 'iv ' + F.vol(cur.atm_iv) + ' · rv ' + F.vol(cur.rv20) +
                ' · vrp ' + F.num(cur.vrp, 2) + ' · spot ' + F.num(cur.spot, 2),
          'the panel’s exact current values — no hover required');
  provenance(host, F.ts(sig.first, 'ymd') + '→' + F.ts(sig.lastT, 'ymd') + ' · ' + sig.n +
             ' obs · ' + sig.sessionCount + ' sessions · series.signal · params.regime');
}

/* ---------------------------------------------------------------------------
   A2 · CONTEXT TREE  (SPEC 5 A2)
   Four collapsible groups; every row is simultaneously a filter and a
   selection.  Rows are rebuilt each pass because the filter changes them; the
   groups, their headers and the search input persist, so the caret survives.
   --------------------------------------------------------------------------- */

function trow(parent, opts) {
  var r = mk('div', 'trow trunc');
  att(r, 'data-sel', opts.sel ? '1' : null);
  if (opts.title) r.title = opts.title;
  r.innerHTML = opts.html;
  if (opts.click) { payload(r, opts.click); r.addEventListener('click', function () { this.__tdpp(); }); }
  if (opts.hover !== undefined && opts.hover !== null) {
    payload(r, r.__tdpp);
    (function (i) { r.addEventListener('pointerenter', function () { TDC.cursor.set(i, 'tree'); }); })(opts.hover);
    r.addEventListener('pointerleave', function () { TDC.cursor.set(null, 'tree'); });
  }
  parent.appendChild(r);
  return r;
}
function subhead(parent, label, n) {
  var r = mk('div', 'row');
  r.innerHTML = '<span class="lab">' + esc(label) + '</span><span class="num c-faint">' + esc(String(n)) + '</span>';
  parent.appendChild(r);
  return r;
}
function meterHtml(frac, over) {
  var pct = clamp(isNum(frac) ? frac : 0, 0, 1) * 100;
  return '<span class="meter thin"' + (over ? ' data-over="1"' : '') +
         '><span class="fill" style="width:' + pct.toFixed(1) + '%"></span></span>';
}

function P_tree(host, D, S) {
  if (!host || !D) return;
  var q = String(sv(S, 'treeq', '')).toLowerCase();
  var open = sv(S, 'treeGroups', null) || { universe: 1, structures: 1, gates: 1, days: 1 };
  var t = D.tree, K2 = C();

  /* the fuzzy filter — created once so it keeps focus and caret */
  var pc = controls(host);
  var srch = slot(pc, 'srch', 'span', 'srch');
  var inp = slot(srch, 'inp', 'input', 'inp');
  att(inp, 'type', 'search');
  att(inp, 'placeholder', 'filter…');
  att(inp, 'aria-label', 'filter the context tree');
  if (doc.activeElement !== inp && inp.value !== sv(S, 'treeq', '')) inp.value = sv(S, 'treeq', '');
  wire(inp, 'input', function () { set({ treeq: this.value }); });

  function match(s) { return !q || String(s).toLowerCase().indexOf(q) >= 0; }

  function group(key, label, build) {
    var g = slot(host, 'g_' + key, 'div', 'tgrp');
    att(g, 'data-g', key);
    var th = slot(g, 'th', 'button', 'th');
    att(th, 'type', 'button');
    var tb = slot(g, 'tb', 'div', 'tb');
    clear(tb);
    var n = build(tb);
    att(g, 'aria-expanded', open[key] ? 'true' : 'false');
    html(th, esc(label) + '<span class="n">' + n + '</span>');
    payload(th, key);
    wire(th, 'click', function () {
      var o = {}, kk;
      var cur2 = sv(global.TD && global.TD.S ? global.TD.S : S, 'treeGroups', null) || { universe: 1, structures: 1, gates: 1, days: 1 };
      for (kk in cur2) o[kk] = cur2[kk];
      o[this.__tdpp] = !o[this.__tdpp];
      set({ treeGroups: o });
    });
    return n;
  }

  /* group 1 — UNIVERSE.  IWM must appear and must say why. */
  var nU = group('universe', 'UNIVERSE', function (tb) {
    var rows = t.universe, i, u, n = 0;
    for (i = 0; i < rows.length; i++) {
      u = rows[i];
      if (!match(u.sym + ' ' + (u.state || '') + ' universe')) continue;
      n++;
      var tag, tagCls, body;
      if (u.covered) {
        tag = u.state === 'rich' ? 'VOL RICH' : u.state === 'cheap' ? 'VOL CHEAP' : 'NEUTRAL';
        tagCls = u.state === 'rich' ? 'tag rich' : 'tag';
        body = '<span class="id">' + esc(u.sym) + '</span>' +
               '<span class="num">' + esc(F.num(u.vrp, 2)) + '</span>' +
               '<span class="num c-faint">' + esc(F.num(u.pts, 2)) + ' pts</span>' +
               '<span class="' + tagCls + '">' + esc(tag) + '</span>';
      } else {
        tag = u.rotations.taken ? 'ROTATED IN' : 'BELOW FLOOR';
        tagCls = u.rotations.taken ? 'tag' : 'tag floor';
        body = '<span class="id">' + esc(u.sym) + '</span>' +
               '<span class="trunc c-faint">' + esc(u.rotations.tried + ' chains tried, ' +
                 (u.rotations.taken ? (u.rotations.taken + ' taken') : 'none cleared the credit floor')) + '</span>' +
               '<span class="' + tagCls + '">' + esc(tag) + '</span>';
      }
      var r = trow(tb, {
        html: body,
        sel: selIs(S, 'underlying', u.sym),
        title: u.covered
          ? (u.sym + ' · iv ' + F.vol(u.iv) + ' · rv ' + F.vol(u.rv) + ' · spot ' + F.num(u.spot, 2) +
             ' from ' + u.spotSrc + ' · ' + u.legsHeld + ' legs held')
          : ((u.missing || '') + ' · ' + u.rotations.tried + ' rotations tried, ' + u.rotations.taken +
             ' taken · ' + u.legsHeld + ' legs held' +
             (u.reasonPublished ? '' : ' · series.alt[].reason is empty on all rows, so the per-underlying floor reason cannot be quoted')),
        click: (function (sym) {
          return function () {
            set({ sel: selIs(S, 'underlying', sym) ? null : { type: 'underlying', id: sym },
                  underlying: selIs(S, 'underlying', sym) ? null : sym });
          };
        })(u.sym)
      });
      if (u.covered && u.spark && u.spark.length) {
        var sp = mk('span', 'spark');
        r.appendChild(sp);
        TDC.spark(sp, { pts: u.spark, w: 40, h: 12, color: K2.gate, mark: 'last' });
      } else if (!u.covered && u.missing) {
        var np = mk('span', 'notpub inline');
        np.innerHTML = '<b>no signal</b><span>series.signal[].sym</span>';
        np.title = u.missing;
        r.appendChild(np);
      }
    }
    /* the published spot series ranges 380.93-773.95; derive proves that is
       two quarantined after-hours marks, not two instruments.  Say which. */
    if (D.signal.suspect.length && !q) {
      var warn = mk('div', 'trow');
      warn.innerHTML = '<span class="tag floor">' + D.signal.suspect.length + ' SUSPECT MARKS</span>' +
        '<span class="trunc c-faint">spot ' + esc(F.num(D.signal.spot.min, 2)) + '–' +
        esc(F.num(D.signal.spot.max, 2)) + ', one instrument</span>';
      warn.title = D.signal.suspectRule + ' · ' +
        (D.quality.quarantine.length ? D.quality.quarantine[0].reason : '') +
        ' · series.signal[].sym is SPY on all ' + D.signal.n + ' rows';
      warn.addEventListener('click', function () { set({ quality: 'clean' }); });
      tb.appendChild(warn);
    }
    return n;
  });

  /* group 2 — STRUCTURES, three sub-lists, one shared max-loss scale */
  var nS = group('structures', 'STRUCTURES', function (tb) {
    var buckets = [['open', 'OPEN'], ['closed', 'CLOSED'], ['unfilled', 'UNFILLED']];
    var n = 0, bi, rows, i, s2;
    for (bi = 0; bi < buckets.length; bi++) {
      rows = [];
      for (i = 0; i < t.structures.length; i++) {
        s2 = t.structures[i];
        if (s2.bucket !== buckets[bi][0]) continue;
        if (!match(s2.id + ' ' + s2.kind + ' ' + s2.sleeve + ' ' + s2.status)) continue;
        rows.push(s2);
      }
      if (!rows.length) continue;
      subhead(tb, buckets[bi][1], rows.length);
      for (i = 0; i < rows.length; i++) {
        s2 = rows[i];
        var res = s2.bucket === 'closed' ? F.usd0(s2.pnl)
                : s2.bucket === 'unfilled' ? 'never filled'
                : 'open';
        var body = '<span class="id">' + esc(F.short(s2.id)) + '</span>' +
          '<span class="trunc">' + esc(String(s2.kind).replace(/_/g, ' ')) + '</span>' +
          '<span class="tag">' + esc(s2.sleeve || '') + '</span>' +
          (isNum(s2.qty) ? '<span class="c-faint">×' + esc(String(s2.qty)) + '</span>' : '') +
          meterHtml(s2.meterFrac) +
          '<span class="num">' + esc(res) + '</span>';
        trow(tb, {
          html: body,
          sel: selIs(S, 'structure', s2.id),
          title: s2.id + ' · ' + s2.kind + ' · ' + s2.sleeve + ' sleeve · max loss ' + F.money(s2.max_loss) +
                 ' of ' + F.money(t.maxLossMax) + ' (the widest of the eleven) · credit ' + F.num(s2.credit, 2) +
                 ' · opened ' + (s2.opened || F.DASH) + (s2.closed ? (' · closed ' + s2.closed) : '') +
                 (isNum(s2.r) ? (' · ' + F.sgn(s2.r, 2) + 'R') : ''),
          hover: D.spine.bind(s2.opened),
          click: (function (id) {
            return function () { set({ sel: selIs(S, 'structure', id) ? null : { type: 'structure', id: id } }); };
          })(s2.id)
        });
        n++;
      }
    }
    return n;
  });

  /* group 3 — GATES.  Denominators come from the presence of the key in r,
     never from a constant: g18 and g19 were not evaluated 57 times. */
  var nG = group('gates', 'GATES', function (tb) {
    var i, g2, n = 0;
    for (i = 0; i < t.gates.length; i++) {
      g2 = t.gates[i];
      if (!match(g2.id + ' ' + g2.label + ' ' + g2.what)) continue;
      n++;
      trow(tb, {
        html: '<span class="trunc">' + esc(g2.id) + '</span>' +
              '<span class="num' + (g2.everBound ? '' : ' c-faint') + '">' +
              esc(g2.fail + '/' + g2.evals) + '</span>' +
              '<span class="tag' + (g2.everBound ? ' rich' : '') + '">' +
              esc(g2.evals ? (g2.rate * 100).toFixed(1) + '%' : 'n/a') + '</span>',
        sel: selIs(S, 'gate', g2.id),
        title: g2.label + ' — ' + g2.what + ' · evaluated ' + g2.evals + ' times' +
               (g2.notReached ? (', not reached ' + g2.notReached) : '') +
               ' · params ' + (g2.params.join(', ') || 'none'),
        click: (function (id) {
          return function () {
            var on = selIs(S, 'gate', id);
            set({ sel: on ? null : { type: 'gate', id: id }, gate: on ? null : id });
          };
        })(g2.id)
      });
    }
    return n;
  });

  /* group 4 — DAYS.  Last mark per UTC date, with that day's tick count. */
  var nD = group('days', 'DAYS', function (tb) {
    var i, d2, n = 0;
    for (i = 0; i < t.days.length; i++) {
      d2 = t.days[i];
      if (!match(d2.day + ' ' + d2.dow)) continue;
      n++;
      trow(tb, {
        html: '<span class="trunc">' + esc(d2.day.slice(5)) + ' <span class="c-faint">' + esc(d2.dow) + '</span></span>' +
              '<span class="num">' + esc(F.usd(d2.pnlLast)) + '</span>' +
              '<span class="c-faint">' + esc(d2.ticks + ' ticks') + '</span>',
        sel: selIs(S, 'day', d2.day),
        title: d2.day + ' · last mark ' + F.usd(d2.pnlLast) +
               (isNum(d2.pnlDelta) ? (' · session change ' + F.usd(d2.pnlDelta)) : ' · first session') +
               ' · ' + d2.ticks + ' tick_start rows · shared-index ticks ' + d2.i0 + '–' + d2.i1,
        hover: d2.i1,
        click: (function (day, i0, i1) {
          return function () {
            var on = selIs(S, 'day', day);
            set({ sel: on ? null : { type: 'day', id: day }, range: on ? 'all' : [i0, i1] });
          };
        })(d2.day, d2.i0, d2.i1)
      });
    }
    return n;
  });

  var total = nU + nS + nG + nD;
  readout(host, q ? (total + ' of ' + (t.universe.length + t.structures.length + t.gates.length + t.days.length) + ' rows')
                  : (t.universe.length + ' · ' + t.structures.length + ' · ' + t.gates.length + ' · ' + t.days.length),
          'underlyings · structures · gates · sessions' + (q ? (' — filtered by "' + q + '"') : ''));
  provenance(host, 'params.universe · positions · gate_defs · series.gates[].r · series.books.real · series.alt',
             'every row is simultaneously a filter and a selection');
}

/* ---------------------------------------------------------------------------
   A3 · AUTHORITY MAP  (SPEC 5 A3)
   Eight stages, each with its badge and its live measured count.  This is the
   page's answer to "is the model allowed to trade?" and it is never behind a
   control.
   --------------------------------------------------------------------------- */

var A3_KINDS = {
  inputs:    ['signals', 'marks', 'tick_start', 'data_suspect'],
  regime:    ['desk', 'desk_veto'],
  strategy:  ['no_candidate', 'entry_skipped_duplicate', 'alt_underlying', 'alt_underlying_none', 'underlying_order'],
  sizing:    ['desk'],
  gates:     ['gates', 'entry_refused'],
  critic:    ['desk', 'desk_veto'],
  execution: ['order_open', 'order_close', 'order_hedge', 'reprice', 'open_reconcile', 'close_reconcile'],
  record:    ['integrity', 'broker_check', 'repair', 'chain_relinked']
};
var A3_TAB = {
  inputs: 'all', regime: 'desk', strategy: 'decisions', sizing: 'desk',
  gates: 'gates', critic: 'desk', execution: 'decisions', record: 'integrity'
};

function a3Text(key, m) {
  var p;
  switch (key) {
    case 'inputs':
      return F.count(m.signals) + ' signals · ' + F.count(m.ticks) + ' ticks · ' + F.count(m.marks) +
             ' marks · ' + F.count(m.quarantined) + ' quarantined';
    case 'regime':
      return F.count(m.meetings) + ' meetings, ' + F.count(m.dark) + ' fully dark, ' +
             F.count(m.vetoes) + ' vetoes, ' + F.count(m.disagreements) + ' disagreements';
    case 'strategy':
      p = keysOf(m.kinds).map(function (k) { return F.count(m.kinds[k]) + ' ' + k.replace(/_/g, ' '); });
      return F.count(m.candidates) + ' candidates · ' + p.join(' · ') + ' · ' +
             F.count(m.noCandidate) + ' ticks with none';
    case 'sizing':
      return 'multiplier ' + F.num(m.predominant.mult, 2) + ' on ' + F.count(m.predominant.n) +
             ' of ' + F.count(m.predominant.of) + ' · code, never the model';
    case 'gates':
      return F.count(m.evaluations) + ' evaluations, ' + F.count(m.functions) + ' gates, ' +
             F.count(m.refusals) + ' refusals, ' + F.count(m.everBound) + ' have ever bound';
    case 'critic':
      return F.count(m.roleCalls) + ' role calls, ' + F.count(m.roleFailures) + ' fallbacks, ' +
             F.count(m.vetoes) + ' vetoes, ' + F.count(m.severity.high || 0) + ' high severity';
    case 'execution':
      return F.count(m.ordersLive) + ' live orders, ' + F.count(m.repricings) + ' repricings, ' +
             F.count(m.fills) + ' fills, ' + F.count(m.unfilled) + ' unfilled, rejections not published';
    case 'record':
      return F.count(m.entries) + ' entries, ' + (m.chainOk ? 'chain intact' : 'chain broken') + ' · ' +
             F.count(m.integrity) + ' integrity checks, ' + F.count(m.exceptions) +
             (m.exceptions === 1 ? ' exception' : ' exceptions');
    default: return '';
  }
}

function P_authority(host, D, S) {
  if (!host || !D) return;
  var rows = D.authority.rows, i, r, a;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    a = slot(host, 'a_' + r.key, 'div', 'arow' + (r.llm ? ' llm' : ''));
    att(a, 'data-stage', r.key);
    att(a, 'data-sel', selIs(S, 'stage', r.key) ? '1' : null);
    var kEl = slot(a, 'k', 'span', 'k');
    txt(kEl, r.label);
    var bEl = slot(a, 'b', 'span', 'badge ' + (r.badge === 'LLM' ? 'llm' : r.badge === 'DATA' ? 'data' : 'code'));
    txt(bEl, r.badge);
    var tEl = slot(a, 't', 'span', 'trunc');
    txt(tEl, a3Text(r.key, r.metrics));
    title(a, r.label + ' — ' + r.badge + ' · ' + a3Text(r.key, r.metrics) +
             (r.metrics.rejectionsMissing ? (' · ' + r.metrics.rejectionsMissing) : '') +
             ' · click to filter the blotter to ' + A3_KINDS[r.key].join(', '));
    payload(a, r.key);
    wire(a, 'click', function () {
      var key = this.__tdpp, kinds = A3_KINDS[key];
      set({ sel: { type: 'stage', id: key }, kind: kinds[0], stageKinds: kinds, tab: A3_TAB[key] });
      if (key === 'regime' || key === 'critic') goTo('p-ribbon');
    });
  }

  judgeNote(host, 'llm',
    '<b>The LLM’s constitutional limits.</b> ' + esc(D.authority.llmConstraints.note) +
    '. Two of eight stages are model-driven; both are argument, not arithmetic. ' +
    'Of ' + F.count(D.desk.roleCalls) + ' role calls, ' + F.count(D.desk.roleFailures) +
    ' fell back to the deterministic core and every one of those fallbacks is a journal row.');

  readout(host, '2 of 8 stages are LLM · ' + F.count(D.desk.roleCalls) + ' role calls · ' +
                F.count(D.desk.roleFailures) + ' fallbacks',
          'Regime and Critic are the only model-driven stages; the model can tighten, never loosen');
  provenance(host, 'desk · series.desk · series.gates · verification · positions · kinds census');
}

/* ---------------------------------------------------------------------------
   A4 · KNOWN WEAKNESSES  (SPEC 5 A4)
   Seven fixed rows carrying live numbers, each a link into its own proof.
   Nothing here is softened; the panel's whole value is that it is not
   marketing.  Sources: DEVLOG.md and WRITEUP.md, cited inline.
   --------------------------------------------------------------------------- */

function a4Rows(D) {
  var cv = D.caveats, ab = cv.ablationUpperBound, ng = D.books.byKey.shadow_nogates;
  var iwm = null, i;
  for (i = 0; i < D.tree.universe.length; i++) if (D.tree.universe[i].sym === 'IWM') iwm = D.tree.universe[i];
  var covered = 0;
  for (i = 0; i < D.tree.universe.length; i++) if (D.tree.universe[i].legsHeld > 0) covered++;

  return [
    { n: 1,
      text: 'The four-book ablation is an upper bound, not a like-for-like comparison — the shadow books ' +
            'share our entries. shadow_nogates ends at ' + F.usd(ng.final.v) + ' with realized ' +
            F.usd(ng.final.r) + ': it never closes a position, so the ' + F.usd(ab.deltaNogates) +
            ' is what the gates prevented on the paths we took, not a measured edge.',
      tip: 'real realized ' + F.usd(ab.realRealized) + ' against no-gates ' + F.usd(ab.nogatesRealized),
      patch: { base: 'nogates', b2mode: 'split' }, go: 'p-equity' },
    { n: 2,
      text: F.count(D.trades.n) + ' closed trades over ' + F.count(D.meta.sessionCount) +
            ' sessions is inside anyone’s noise band; no rolling statistic is drawn anywhere on this page.',
      tip: 'win rate ' + F.pct(D.trades.winRate, 1) + ' on n=' + D.trades.n +
           ' — a number with no confidence interval worth printing',
      patch: { tab: 'trades' }, go: 'p-trades' },
    { n: 3,
      text: 'Paper fills are more optimistic than live, which is why the reconciliation gap of ' +
            F.usd(cv.fills.gap) + ' is bounded by the measured half-spread of the ' + cv.fills.legs +
            ' legs actually held (' + F.money(cv.fills.envelope.median) + ' at the median, ' +
            F.money(cv.fills.envelope.wide) + ' at the widest) rather than asserted.',
      tip: 'quotes.narrowest_c / median_c / widest_c, per leg ' + F.num(cv.fills.perLegCents, 2) + '¢',
      patch: null, go: 'p-recon' },
    { n: 4,
      text: covered + ' of ' + cv.universe.authorised + ' authorised underlyings hold legs; IWM never has — ' +
            (iwm ? (iwm.rotations.tried + ' chains tried, ' + iwm.rotations.taken + ' taken, ' +
                    iwm.legsHeld + ' legs held') : 'no rotation recorded') + '.',
      tip: 'series.alt[].reason is an empty string on all 75 rows, so the floor reason cannot be quoted here',
      patch: { sel: { type: 'underlying', id: 'IWM' }, underlying: 'IWM' }, go: 'p-tree' },
    { n: 5,
      text: F.count(cv.quality.quarantined) + ' of ' + F.count(cv.quality.marksTotal) +
            ' marks were quarantined after a one-sided after-hours quote and are excluded from every curve' +
            (D.quality.quarantine.length ? (' — ' + D.quality.quarantine[0].reason) : '') + '.',
      tip: 'DEVLOG #28: IEX returns bid=0 after 20:00 UTC, so 0.5*(bid+ask) read 380.93 against a spot of 762. ' +
           'The journal was not edited — the chain is intact and the rows are flagged, not deleted.',
      patch: { quality: 'clean' }, go: 'p-command' },
    { n: 6,
      text: F.count(cv.desk.dark) + ' of ' + F.count(cv.desk.meetings) +
            ' desk meetings ran with no model reachable, and every one of them is journalled as a fallback.',
      tip: 'DEVLOG: the Anthropic account had no credit balance for part of the run; the desk lost two of ' +
           'four votes and kept trading on the deterministic core',
      patch: { b5filter: 'dark', range: 'all' }, go: 'p-ribbon' },
    { n: 7,
      text: 'Open ' + cv.structures.open + ' + closed ' + cv.structures.closed + ' does not equal ' +
            cv.structures.total + ': ' + cv.structures.unfilled +
            ' structures are unfilled — submitted, never filled, cancelled after ten minutes.',
      tip: 'positions.unfilled — the count reconciles only when the third bucket is shown',
      patch: { tab: 'positions' }, go: 'p-blotter' }
  ];
}

function P_weakness(host, D, S) {
  if (!host || !D) return;
  var rows = a4Rows(D), i, r, el2;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    el2 = slot(host, 'w_' + r.n, 'div', 'row tall act');
    var nEl = slot(el2, 'n', 'span', 'lab');
    txt(nEl, String(r.n));
    var pEl = slot(el2, 'p', 'span', 'prose');
    txt(pEl, r.text);
    title(el2, r.tip);
    payload(el2, r);
    wire(el2, 'click', function () {
      var rr = this.__tdpp;
      if (rr.patch) set(rr.patch);
      if (rr.go) goTo(rr.go);
    });
  }
  readout(host, rows.length + ' limitations · each links to its proof',
          'read this before the P&L: nothing here is softened');
  provenance(host, 'series.books · trades · quotes · series.quarantine · desk · positions · DEVLOG.md',
             'sources: DEVLOG.md #28 (quarantine), WRITEUP.md (universe, fills), derive.js caveats');
}

/* ===========================================================================
   COLUMN B — the chart stack.  B5 owns the shared x-axis and the brush; every
   other chart here hangs off the same tick index and the same cursor bus.
   =========================================================================== */

/* ---------------------------------------------------------------------------
   B1 · ABLATION LEDGER  (SPEC 5 B1)
   The counterfactual as a read number, not a decoded chart.

   THE DELTA COLUMN.  The spec's own figures put +2,175.60 on the no-gates row
   and −38.71 on the no-hedge row, which is `real − row`, so that is what the
   column prints, on every row, always.  The BASELINE control therefore does
   what the spec says it does — it scopes B1, B2 and the blotter's delta
   column — by selecting which difference is emphasised, not by re-basing a
   column whose published numbers would then move.
   --------------------------------------------------------------------------- */

var B1_BASES = [
  { v: 'abs', label: 'ABSOLUTE', title: 'B2 draws the four curves absolute' },
  { v: 'nogates', label: 'vs NO-GATES', title: 'emphasise real − shadow_nogates' },
  { v: 'nohedge', label: 'vs NO-HEDGE', title: 'emphasise real − shadow_nohedge' },
  { v: 'naive', label: 'vs NAIVE', title: 'emphasise real − baseline_naive' }
];

function dbarHtml(v, scale, bookKey) {
  if (!isNum(v)) return '<span class="notpub inline"><b>—</b></span>';
  var half = 50, frac = scale ? clamp(Math.abs(v) / scale, 0, 1) : 0;
  var wdt = (half * frac);
  var left = v < 0 ? (half - wdt) : half;
  return '<span class="dbar" data-book="' + esc(bookKey) + '">' +
         '<span class="zero" style="left:50%"></span>' +
         '<span class="seg" style="left:' + left.toFixed(2) + 'px;width:' + Math.max(wdt, 0.5).toFixed(2) + 'px"></span>' +
         '</span>';
}

function P_ledger(host, D, S) {
  if (!host || !D) return;
  var base = sv(S, 'base', 'nogates');
  seg(controls(host), 'base', B1_BASES, base, function (v) { set({ base: v }); }, null);

  var tbl = slot(host, 'tbl', 'table', 'tbl');
  var thead = slot(tbl, 'thead', 'thead');
  html(thead, '<tr><th>BOOK</th><th class="num">FINAL P&amp;L</th>' +
              '<th class="num">REALIZED / UNREALIZED</th><th>Δ vs REAL</th>' +
              '<th class="num">MAX DRAWDOWN</th><th class="num">WORST TICK</th></tr>');
  var tb = slot(tbl, 'tbody', 'tbody');
  clear(tb);

  var order = D.books.order, scale = D.ablation.scaleMax || 1, i, key, bk, tr, dv, dCell;
  var missing = [];
  for (i = 0; i < order.length; i++) {
    key = order[i];
    bk = D.books.byKey[key];
    if (!bk || !bk.present) { missing.push(key); continue; }
    dv = key === 'real' ? null : (D.ablation.vs[key] ? D.ablation.vs[key].final : null);
    tr = mk('tr');
    att(tr, 'data-sel', (key === 'real' ? base === 'abs' : BASE_KEY[base] === key) ? '1' : null);
    dCell = key === 'real'
      ? '<span class="c-faint">base</span>'
      : (dbarHtml(dv, scale, KEY_BASE[key]) + ' <span class="num">' + esc(F.usd(dv)) + '</span>');
    tr.innerHTML =
      '<td><span class="sw bk-' + esc(KEY_BASE[key] || 'real') + '"></span> ' + esc(bk.label) + '</td>' +
      '<td class="num">' + esc(F.usd(bk.final.v)) + '</td>' +
      '<td class="num">' + esc(F.usd(bk.final.r)) + ' / ' + esc(F.usd(bk.final.u)) + '</td>' +
      '<td>' + dCell + '</td>' +
      '<td class="num">' + esc(F.usd(bk.maxDD)) + '</td>' +
      '<td class="num">' + esc(F.usd(bk.worstTick)) + '</td>';
    tr.title = bk.label + ' · ' + bk.n + ' marks over ' + bk.ticksCovered + ' ticks · peak ' +
      F.usd(bk.peak) + ' · trough ' + F.usd(bk.trough) + ' · deepest drawdown ' + F.usd(bk.maxDD) +
      ' at ' + D.spine.label(bk.maxDDAt) + 'Z · worst single tick ' + F.usd(bk.worstTick) +
      ' at ' + D.spine.label(bk.worstTickAt) + 'Z';
    (function (k2) {
      tr.addEventListener('click', function () { set({ base: k2 === 'real' ? 'abs' : KEY_BASE[k2] }); });
      var dtd = tr.cells[3];
      if (k2 !== 'real' && dtd) {
        dtd.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var a = D.ablation.vs[k2];
          set({ base: KEY_BASE[k2], b2mode: 'split', cur: a.maxAbsAt, locked: true });
          TDC.cursor.lock(a.maxAbsAt, 'ledger');
          goTo('p-equity');
        });
      }
      tr.addEventListener('pointerenter', function () { TDC.cursor.set(D.books.byKey[k2].final.i, 'ledger'); });
    })(key);
    tb.appendChild(tr);
  }

  /* welded under the table, never removable */
  var cav = slot(host, 'caveat', 'div', 'caveat');
  var ab = D.caveats.ablationUpperBound;
  txt(cav, 'Upper bound, not an edge. The shadow books share the real book’s entries and never take ' +
           'profit — no-gates realizes ' + F.usd(ab.nogatesRealized) + ' against our ' +
           F.usd(ab.realRealized) + '. This measures what the gates prevented on the paths we actually took.');

  judgeNote(host, 'b1',
    '<b>Why this is a ceiling.</b> Each shadow book is replayed over the same entry decisions the real ' +
    'desk took, so it can only ever answer “what would this rule have cost or saved on these paths”. ' +
    'The tell is in the REALIZED column: shadow_nogates closes nothing, so its ' +
    esc(F.usd(ab.nogatesFinal)) + ' is entirely unrealized. The hedge reads ' + esc(F.usd(ab.deltaNohedge)) +
    ' against us, and its largest divergence, ' + esc(F.usd(D.ablation.vs.shadow_nohedge.maxAbs)) +
    ', is at ' + esc(D.spine.label(D.ablation.vs.shadow_nohedge.maxAbsAt)) + 'Z — the hedge is insurance, ' +
    'and insurance costs money in the sessions it is not needed.');

  if (missing.length) notpub(host, 'books', 'series.books.' + missing.join(', '), 'tools/site_data.py · _series()');

  readout(host, 'real ' + F.usd(D.books.byKey.real.final.v) + ' · Δ ' +
                F.usd(D.ablation.vs.shadow_nogates.final) + ' vs no-gates · ' +
                F.usd(D.ablation.vs.shadow_nohedge.final) + ' vs no-hedge · ' +
                F.usd(D.ablation.vs.baseline_naive.final) + ' vs naive',
          'upper bound — the shadow books share our entries and realize nothing');
  provenance(host, 'series.books.* · last point per book · ' +
             order.map(function (k) { return D.books.byKey[k].n; }).join('/') + ' marks · Δ bars on one shared scale of ' +
             F.money(scale));
}

/* ---------------------------------------------------------------------------
   B2 · EQUITY & ABLATION  (SPEC 5 B2)
   --------------------------------------------------------------------------- */

var B2_MODES = [
  { v: 'split', label: 'SPLIT', title: 'real above, real − shadow below' },
  { v: 'four', label: 'FOUR', title: 'all four curves, absolute' },
  { v: 'underwater', label: 'UW', title: 'the real book only: value minus its running maximum' },
  { v: 'ru', label: 'R∶U', title: 'realized against unrealized, real book' }
];
var B2_OV_DEFAULT = { derisk: 1, entries: 1, quarantine: 1, hwm: 0, broker: 0 };

function ovMap(S) {
  var o = sv(S, 'b2ov', null), out = {}, k;
  for (k in B2_OV_DEFAULT) out[k] = (o && o[k] !== undefined) ? !!o[k] : !!B2_OV_DEFAULT[k];
  return out;
}
function ovToggle(S, key) {
  var m = ovMap(S);
  m[key] = !m[key];
  return m;
}
function identicalToReal(D, key, w) {
  var a = D.ablation.vs[key];
  if (!a) return false;
  var mx = 0, j, p;
  for (j = 0; j < a.perTick.length; j++) {
    p = a.perTick[j];
    if (p.i < w.i0 || p.i > w.i1) continue;
    if (Math.abs(p.v) > mx) mx = Math.abs(p.v);
  }
  return mx < 0.005;
}

function P_equity(host, D, S) {
  if (!host || !D) return;
  var st = stack(host);
  addCls(st.bar, 'trunc');
  var w = win(D, S);
  var mode = sv(S, 'b2mode', 'split');
  var base = sv(S, 'base', 'nogates');
  var bmap = bookMap(S);
  var ov = ovMap(S);
  var ix = IX(D);
  var K2 = C();

  seg(controls(host), 'b2mode', B2_MODES, mode, function (v) { set({ b2mode: v }); });

  /* ---- toolbar: the legend, then the overlay chips --------------------- */
  var lg = slot(st.bar, 'lg', 'span', 'legend');
  var items = [], i, key, bk, absent = [];
  for (i = 0; i < D.books.order.length; i++) {
    key = D.books.order[i];
    bk = D.books.byKey[key];
    if (!bk || !bk.present) { absent.push(key); continue; }
    var same = identicalToReal(D, key, w);
    items.push({
      key: key, label: bookShort(key), color: bookColor(key),
      on: !!bmap[key], struck: same,
      note: null,
      title: same ? 'identical to real over this range — nothing to compare'
                  : (bk.label + ' · final ' + F.usd(bk.final.v) + ' · realized ' + F.usd(bk.final.r) +
                     ' · ' + bk.n + ' marks')
    });
  }
  TDC.legend(lg, {
    items: items,
    onToggle: function (k) { var m = bookMap(S); m[k] = !m[k]; set({ books: bookWrite(S, m) }); }
  });

  var ovBox = slot(st.bar, 'ov', 'span', 'legend');
  function ovChip(k, label, count, tip) {
    chip(ovBox, k, label, ov[k], function () { set({ b2ov: ovToggle(S, k) }); }, tip, count);
  }
  ovChip('derisk', 'DERISK', D.overlays.deriskN,
    D.overlays.deriskBands.length ? (D.overlays.deriskBands.length + ' band(s) · ' + D.overlays.deriskBands[0].reason) : 'series.derisk');
  ovChip('entries', 'ENTRIES', D.overlays.entries.length, 'positions[].opened / .closed, bound to the shared index');
  ovChip('quarantine', 'QUARANTINE', D.overlays.quarantineTicks.length,
    D.overlays.quarantineTicks.length ? D.overlays.quarantineTicks[0].reason : 'series.quarantine');
  ovChip('hwm', 'HWM', null, 'kv.high_watermark ' + F.money(D.overlays.hwm.equity) + ' — ' + D.overlays.hwm.note);
  ovChip('broker', 'BROKER', D.overlays.broker.length,
    'series.books.real[].eq is non-null on ' + D.overlays.brokerN + ' of ' + D.overlays.brokerOf +
    ' marks; the shadow books carry none');

  /* ---- the chart ------------------------------------------------------- */
  var real = D.books.byKey.real;
  var realPts = inWin(real.v, w);
  var draw = function (ctx) {
    if (!(ctx.iw > 4 && ctx.ih > 20)) return;
    ctx.setIndex(ix);
    var x = TDC.scaleTick({ index: ix, mode: axisMode(S), range: [0, ctx.iw], i0: w.i0, i1: w.i1 });
    ctx.setX(x);
    var ih = ctx.ih, upperH, lowTop, lowH, evY = null, yTop, yBot = null, j, k2, pts;

    function usdFmt(v) { return F.usd0(v); }

    if (mode === 'split') {
      upperH = Math.max(30, Math.round(ih * 0.58));
      evY = ih - 5;
      lowTop = upperH + 10;
      lowH = Math.max(14, evY - 3 - lowTop);
    } else {
      upperH = ih;
      lowTop = null; lowH = 0;
    }

    /* upper pane ------------------------------------------------------- */
    var upPts = [], series = [];
    if (mode === 'four') {
      for (j = 0; j < D.books.order.length; j++) {
        k2 = D.books.order[j];
        if (!bmap[k2] || !D.books.byKey[k2].present) continue;
        if (k2 !== 'real' && identicalToReal(D, k2, w)) continue;
        pts = inWin(D.books.byKey[k2].v, w);
        series.push({ key: k2, pts: pts, color: bookColor(k2) });
        upPts.push(pts);
      }
    } else if (mode === 'underwater') {
      pts = inWin(real.dd, w);
      series.push({ key: 'real', pts: pts, color: bookColor('real'), fill: true });
      upPts.push(pts);
    } else if (mode === 'ru') {
      series.push({ key: 'realized', pts: inWin(real.r, w), color: K2.ink });
      series.push({ key: 'unrealized', pts: inWin(real.u, w), color: K2.soft, dash: K.dash });
      series.push({ key: 'real', pts: realPts, color: K2.ruleHi, width: 1 });
      upPts.push(series[0].pts, series[1].pts, series[2].pts);
    } else {
      series.push({ key: 'real', pts: realPts, color: bookColor('real') });
      upPts.push(realPts);
    }
    if (ov.broker && mode !== 'underwater' && D.overlays.broker.length) {
      var bpts = [];
      for (j = 0; j < D.overlays.broker.length; j++) {
        var bp = D.overlays.broker[j];
        if (bp.i < w.i0 || bp.i > w.i1) continue;
        bpts.push({ i: bp.i, v: bp.pnlEquivalent });
      }
      if (bpts.length) { series.push({ key: 'broker', pts: bpts, color: K2.rv, dash: K.dotted, width: 1 }); upPts.push(bpts); }
    }
    var ext = TDC.extent.apply(null, upPts) || [0, 1];
    if (ov.hwm && mode !== 'underwater' && isNum(D.overlays.hwm.pnlEquivalent)) {
      ext = [Math.min(ext[0], D.overlays.hwm.pnlEquivalent), Math.max(ext[1], D.overlays.hwm.pnlEquivalent)];
    }
    yTop = TDC.scaleLinear({ domain: ext, range: [upperH, 0], nice: true, zero: mode !== 'underwater', ticks: 3 });
    ctx.setY(yTop);
    TDC.axisY(ctx, { scale: yTop, ticks: 3, format: usdFmt, x0: 0, x1: ctx.iw, layer: 'bg' });

    /* overlays that sit behind the curves */
    if (ov.derisk) {
      for (j = 0; j < D.overlays.deriskBands.length; j++) {
        var db = D.overlays.deriskBands[j];
        var a0 = Math.max(db.i0, w.i0), a1 = Math.min(db.i1, w.i1);
        if (a1 < a0) continue;
        var x0 = x(a0) - (x.band || 2) / 2, x1 = x(a1) + (x.band || 2) / 2;
        ctx.add('bg', 'rect', {
          x: x0.toFixed(2), y: 0, width: Math.max(x1 - x0, 1).toFixed(2), height: upperH,
          fill: K2.gate, 'fill-opacity': 0.08, 'class': 'ev ev-band', 'data-key': 'derisk'
        }).appendChild(TDC.node('title', null, 'derisk · ' + db.n + ' ticks · ' + db.reason));
      }
    }
    if (ov.quarantine) {
      for (j = 0; j < D.overlays.quarantineTicks.length; j++) {
        var qt = D.overlays.quarantineTicks[j];
        if (qt.i < w.i0 || qt.i > w.i1) continue;
        var qx = x(qt.i);
        ctx.add('bg', 'rect', {
          x: (qx - 1).toFixed(2), y: 0, width: 2, height: upperH,
          fill: K2.breach, 'fill-opacity': 0.22, 'class': 'ev', 'data-key': 'quarantine'
        }).appendChild(TDC.node('title', null, 'mark quarantined and excluded · ' + qt.reason));
      }
    }
    if (ov.hwm && mode !== 'underwater' && isNum(D.overlays.hwm.pnlEquivalent)) {
      TDC.rule(ctx, { axis: 'y', value: D.overlays.hwm.pnlEquivalent, y: yTop, color: K2.gate,
        label: 'HWM ' + F.usd0(D.overlays.hwm.pnlEquivalent), side: 'right', layer: 'bg',
        title: 'kv.high_watermark ' + F.money(D.overlays.hwm.equity) + ' — ' + D.overlays.hwm.note });
    }
    if (mode === 'underwater') {
      var halt = D.raw.limits ? D.raw.limits.drawdown_halt : null;
      if (isNum(halt)) {
        var dom = yTop.domain;
        if (-halt >= dom[0] && -halt <= dom[1]) {
          TDC.rule(ctx, { axis: 'y', value: -halt, y: yTop, color: K2.breach,
            label: 'halt ' + F.usd0(-halt), side: 'right', layer: 'bg' });
        } else {
          ctx.add('fg', 'text', { x: ctx.iw, y: 10, 'text-anchor': 'end', fill: K2.faint, 'font-size': K.fs.small },
            'halt at ' + F.usd(-halt) + ' · never approached, deepest ' + F.usd(real.maxDD));
        }
      }
    }

    /* the curves */
    for (j = 0; j < series.length; j++) {
      var s2 = series[j];
      if (s2.fill) {
        TDC.area(ctx, { pts: s2.pts, baseline: 0, fill: s2.color, opacity: 0.16, y: yTop, key: s2.key });
      }
      TDC.line(ctx, {
        pts: s2.pts, color: s2.color, width: s2.width || (s2.key === 'real' ? 1.4 : K.lineW),
        dash: s2.dash || null, y: yTop, key: s2.key, dot: 'last'
      });
    }

    /* entry / exit markers */
    if (ov.entries) {
      var marks = [];
      for (j = 0; j < D.overlays.entries.length; j++) {
        var en = D.overlays.entries[j];
        if (en.i < w.i0 || en.i > w.i1) continue;
        marks.push({
          i: en.i, kind: en.dir, color: en.dir === 'open' ? K2.ink : K2.soft,
          key: 'entry:' + en.id, sel: selIs(S, 'structure', en.id),
          title: (en.dir === 'open' ? 'OPEN ' : 'CLOSE ') + F.short(en.id) + ' · ' +
                 String(en.kind).replace(/_/g, ' ') + ' · ' + en.t
        });
      }
      TDC.eventLane(ctx, {
        marks: marks, y: 0, h: 5, glyph: 'caret', layer: 'fg', key: 'entries',
        onMark: function (m) { set({ sel: { type: 'structure', id: String(m.key).slice(6) } }); }
      });
    }

    /* lower pane: real − shadow, zero-baselined, in the shadow's own colour */
    if (mode === 'split') {
      var diffs = [], dPts = [];
      for (j = 0; j < D.books.order.length; j++) {
        k2 = D.books.order[j];
        if (k2 === 'real' || !bmap[k2] || !D.books.byKey[k2].present) continue;
        if (identicalToReal(D, k2, w)) continue;
        var line = inWin(D.ablation.vs[k2].line, w);
        if (!line.length) continue;
        diffs.push({ key: k2, pts: line });
        dPts.push(line);
      }
      var dext = TDC.extent.apply(null, dPts) || [-1, 1];
      yBot = TDC.scaleLinear({ domain: dext, range: [lowTop + lowH, lowTop], nice: true, zero: true, ticks: 2 });
      TDC.axisY(ctx, { scale: yBot, ticks: 2, format: usdFmt, x0: 0, x1: ctx.iw, layer: 'bg' });
      for (j = 0; j < diffs.length; j++) {
        TDC.area(ctx, {
          pts: diffs[j].pts, baseline: 0, fill: bookColor(diffs[j].key), opacity: 0.18,
          y: yBot, key: 'd:' + diffs[j].key,
          title: 'real − ' + D.books.byKey[diffs[j].key].label + ' · ends ' + F.usd(D.ablation.vs[diffs[j].key].final)
        });
        TDC.line(ctx, { pts: diffs[j].pts, color: bookColor(diffs[j].key), width: 1, y: yBot, key: 'd:' + diffs[j].key });
      }
      ctx.add('fg', 'text', { x: 0, y: lowTop - 3, fill: K2.faint, 'font-size': K.fs.micro },
        'real − shadow, filled in the shadow’s own colour above and below zero');
      if (!diffs.length) {
        ctx.add('fg', 'text', { x: 0, y: lowTop + 12, fill: K2.faint, 'font-size': K.fs.small },
          'no shadow book selected — nothing to difference');
      }
      /* refusal ticks along the difference pane's x-axis */
      var rmarks = [], gd = D.premium.events.gated;
      for (j = 0; j < gd.length; j++) {
        if (gd[j].i < w.i0 || gd[j].i > w.i1) continue;
        rmarks.push({
          i: gd[j].i, kind: 'refusal', color: K2.gate, key: 'gate:' + gd[j].gate,
          sel: sv(S, 'gate', null) === gd[j].gate,
          title: 'ENTRY REFUSED · ' + gd[j].gate + ' · ' + gd[j].reason + ' · ' + gd[j].t
        });
      }
      TDC.eventLane(ctx, {
        marks: rmarks, y: evY, h: 5, glyph: 'tick', layer: 'fg', key: 'refusals',
        onMark: function (m) { set({ sel: { type: 'refusal', id: null }, gate: String(m.key).slice(5), tab: 'refusals' }); }
      });
    }

    TDC.axisX(ctx, { index: ix, mode: axisMode(S), dayRules: true, ruleH: ih, times: true });

    var valueAt = valueAtOf(mode === 'underwater' ? real.dd : real.v);
    TDC.cursorOverlay(ctx, {
      x: x, y0: 0, y1: ih, group: 'time', valueAt: valueAt,
      chip: function (i) {
        var v = valueAt(i);
        return ix.label(i, 'abs') + (isNum(v) ? ('  ' + F.usd(v)) : '');
      }
    });
    TDC.hitline(ctx, { index: ix, x: x, id: 'b2', group: 'time', y0: 0, y1: ih });

    /* selection dims, never removes (SPEC 3.5) */
    if (S && S.sel && S.sel.type === 'book') TDC.dim(ctx, function (k3) { return k3 === S.sel.id || k3 === 'real'; });
    else if (base !== 'abs' && mode === 'split') {
      var keep = 'd:' + BASE_KEY[base];
      TDC.dim(ctx, function (k3) { return !k3 || k3.indexOf('d:') !== 0 || k3 === keep; });
    } else TDC.dim(ctx, null);
  };

  TDC.mount(st.chart, { pad: { t: 10, r: 10, b: 16, l: 46 }, index: ix, draw: draw, label: 'equity and ablation' });

  var ro = mode === 'underwater'
    ? ('peak ' + F.usd(real.peak) + ' · deepest ' + F.usd(real.maxDD) + ' at ' + D.spine.label(real.maxDDAt) + 'Z')
    : mode === 'ru'
      ? ('realized ' + F.usd(real.final.r) + ' · unrealized ' + F.usd(real.final.u) + ' · marked ' + F.usd(real.final.v))
      : ('real ' + F.usd(real.final.v) + ' · Δ ' + F.usd(D.ablation.vs.shadow_nogates.final) + ' / ' +
         F.usd(D.ablation.vs.shadow_nohedge.final) + ' / ' + F.usd(D.ablation.vs.baseline_naive.final));
  readout(host, ro + (absent.length ? (' · ' + absent.join(', ') + ' not published') : ''),
          absent.length ? ('series.books.' + absent.join(', ') + ' is absent from the export') : ro);

  judgeNote(host, 'b2',
    '<b>The quarantined marks.</b> ' + esc(F.count(D.caveats.quality.quarantined)) + ' of ' +
    esc(F.count(D.caveats.quality.marksTotal)) + ' marks are excluded from every curve on this page. ' +
    (D.overlays.quarantineTicks.length
      ? ('They land at ' + esc(D.overlays.quarantineTicks.map(function (q) { return q.t + 'Z'; }).join(' and ')) +
         ' and the cause is recorded in the journal: ' + esc(D.overlays.quarantineTicks[0].reason) + '. ')
      : '') +
    'The journal was never edited — the hash chain is intact and the rows carry a quality flag rather than a deletion.');

  provenance(host, 'series.books.* · series.derisk (' + D.overlays.deriskN + ') · positions (' +
    D.overlays.entries.length + ' entry/exit) · series.quarantine (' + D.overlays.quarantineN + ') · kv.high_watermark · series.books.real[].eq (' +
    D.overlays.brokerN + ' of ' + D.overlays.brokerOf + ')');
}

/* ---------------------------------------------------------------------------
   B3 · IMPLIED vs REALIZED  —  the thesis chart  (SPEC 5 B3)

   The two quarantined ticks are never silently dropped and never allowed to
   set the scale either: the y domain is taken from the marks the desk's own
   data-quality gate accepted, the lines break at the excluded ticks, and each
   one is drawn as a breach marker carrying its measured value and the reason
   the desk itself recorded.
   --------------------------------------------------------------------------- */

var B3_UPPER = [
  { v: 'vol', label: 'VOL PTS', title: 'implied and realized as levels, with the premium filled between them' },
  { v: 'spread', label: 'SPREAD', title: 'implied minus realized, in volatility points, against zero' },
  { v: 'ratio', label: 'RATIO', title: 'implied over realized, against 1.00×' }
];

function P_thesis(host, D, S) {
  if (!host || !D) return;
  var st = stack(host);
  addCls(st.bar, 'trunc');
  var w = win(D, S);
  var ix = IX(D);
  var K2 = C();
  var upper = sv(S, 'b3upper', 'vol');
  var showTh = sv(S, 'b3th', true);
  var showRef = sv(S, 'b3ref', true);
  var showEnt = sv(S, 'b3ent', true);
  var pack = quality(S) === 'clean' ? D.signal.clean : D.signal.all;
  var th = D.signal.thresholds;

  seg(controls(host), 'b3upper', B3_UPPER, upper, function (v) { set({ b3upper: v }); });

  var chips = slot(st.bar, 'chips', 'span', 'legend');
  chip(chips, 'th', 'THRESHOLDS', showTh, function () { set({ b3th: !showTh }); },
       'params.regime.vrp_rich_threshold ' + th.rich + ' / vrp_cheap_threshold ' + th.cheap);
  chip(chips, 'ref', 'REFUSALS', showRef, function () { set({ b3ref: !showRef }); },
       D.premium.events.gatedN + ' entry refusals, each naming its first failing gate',
       D.premium.events.gatedN);
  chip(chips, 'ent', 'ENTRIES', showEnt, function () { set({ b3ent: !showEnt }); },
       D.premium.events.entriesNote, D.premium.events.entriesN);

  var note = slot(st.bar, 'note', 'span', 'trunc c-faint');
  var suspect = D.signal.suspect;
  txt(note, suspect.length
    ? (suspect.length + ' ticks excluded from the scale · ' +
       (D.quality.quarantine.length ? D.quality.quarantine[0].reason : D.signal.suspectRule))
    : ('no percentile cone: ' + (D.premium.coneReason || 'insufficient history')));
  title(note, 'no percentile cone or fan is drawn: ' + (D.premium.coneReason || '') +
              (suspect.length ? (' · excluded ticks ' + suspect.map(function (s2) { return s2.t + 'Z (spot ' + F.num(s2.spot, 2) + ', iv ' + F.vol(s2.iv) + ')'; }).join(', ')) : ''));

  var susp = {}, j;
  for (j = 0; j < suspect.length; j++) susp[suspect[j].i] = suspect[j];
  function scrub(pts) {
    var out = [], p;
    for (var q = 0; q < (pts || []).length; q++) {
      p = pts[q];
      if (p.i < w.i0 || p.i > w.i1) continue;
      out.push(susp[p.i] ? { i: p.i, v: null } : p);
    }
    return out;
  }

  var ivPts = scrub(pack.iv), rvPts = scrub(pack.rv), vrpPts = scrub(pack.vrp);
  var spPts = scrub(pack.pts), raPts = scrub(pack.ratio);

  var draw = function (ctx) {
    if (!(ctx.iw > 4 && ctx.ih > 24)) return;
    ctx.setIndex(ix);
    var x = TDC.scaleTick({ index: ix, mode: axisMode(S), range: [0, ctx.iw], i0: w.i0, i1: w.i1 });
    ctx.setX(x);
    var ih = ctx.ih;
    var evH = (showRef || showEnt) ? 6 : 0;
    var body = ih - evH - (evH ? 2 : 0);
    var upH = Math.max(24, Math.round(body * 0.62));
    var loTop = upH + 8;
    var loH = Math.max(16, body - loTop);
    var evY = ih - evH;

    /* upper pane -------------------------------------------------------- */
    var yUp, sel = (S && S.sel && S.sel.type === 'signalseries') ? S.sel.id : null;
    if (upper === 'vol') {
      yUp = TDC.scaleLinear({ domain: TDC.extent(ivPts, rvPts) || [0, 1], range: [upH, 0], nice: true, ticks: 3 });
      ctx.setY(yUp);
      TDC.axisY(ctx, { scale: yUp, ticks: 3, format: function (v) { return F.vol(v); }, x0: 0, x1: ctx.iw, layer: 'bg', zeroRule: false });
      TDC.band(ctx, { upper: ivPts, lower: rvPts, fill: K2.premium, y: yUp, key: 'premium',
                      title: 'the premium being harvested: implied above realized' });
      TDC.line(ctx, { pts: rvPts, color: K2.rv, y: yUp, key: 'rv', dot: 'last', title: 'realized volatility, 20-day' });
      TDC.line(ctx, { pts: ivPts, color: K2.iv, y: yUp, key: 'iv', dot: 'last', title: 'implied volatility, ATM' });
    } else if (upper === 'spread') {
      yUp = TDC.scaleLinear({ domain: TDC.extent(spPts) || [0, 1], range: [upH, 0], nice: true, zero: true, ticks: 3 });
      ctx.setY(yUp);
      TDC.axisY(ctx, { scale: yUp, ticks: 3, format: function (v) { return F.num(v, 1); }, x0: 0, x1: ctx.iw, layer: 'bg' });
      TDC.area(ctx, { pts: spPts, baseline: 0, fill: K2.iv, opacity: 0.14, y: yUp, key: 'iv' });
      TDC.line(ctx, { pts: spPts, color: K2.iv, y: yUp, key: 'iv', dot: 'last', title: 'implied minus realized, vol points' });
    } else {
      yUp = TDC.scaleLinear({ domain: TDC.extent(raPts) || [0, 2], range: [upH, 0], nice: true, ticks: 3 });
      ctx.setY(yUp);
      TDC.axisY(ctx, { scale: yUp, ticks: 3, format: function (v) { return F.num(v, 2); }, x0: 0, x1: ctx.iw, layer: 'bg', zeroRule: false });
      TDC.line(ctx, { pts: raPts, color: K2.iv, y: yUp, key: 'iv', dot: 'last', title: 'implied over realized' });
      TDC.rule(ctx, { axis: 'y', value: 1, y: yUp, color: K2.faint, label: '1.00×', side: 'left', layer: 'bg' });
    }

    /* the excluded ticks, printed rather than dropped */
    for (var q = 0; q < suspect.length; q++) {
      var sp2 = suspect[q];
      if (sp2.i < w.i0 || sp2.i > w.i1) continue;
      var sx = x(sp2.i);
      var g2 = ctx.add('fg', 'g', { 'class': 'mk', 'data-key': 'excluded' });
      g2.appendChild(TDC.node('rect', { x: (sx - 1).toFixed(2), y: 0, width: 2, height: ih,
        fill: K2.breach, 'fill-opacity': 0.28 }));
      g2.appendChild(TDC.node('circle', { cx: sx.toFixed(2), cy: 4, r: 3, fill: 'none',
        stroke: K2.breach, 'stroke-width': 1 }));
      g2.appendChild(TDC.node('title', null,
        'EXCLUDED · ' + sp2.t + 'Z · iv ' + F.vol(sp2.iv) + ' · rv ' + F.vol(sp2.rv) + ' · spot ' +
        F.num(sp2.spot, 2) + ' · ' + (D.quality.quarantine.length ? D.quality.quarantine[0].reason : D.signal.suspectRule)));
    }

    /* lower pane: the VRP score with its two published rules ------------- */
    var yLo = TDC.scaleLinear({ domain: [0, 1], range: [loTop + loH, loTop], nice: false });
    TDC.axisY(ctx, { scale: yLo, ticks: 2, format: function (v) { return F.num(v, 1); },
                     x0: 0, x1: ctx.iw, layer: 'bg', zeroRule: false });
    TDC.step(ctx, { pts: vrpPts, color: K2.gate, y: yLo, key: 'vrp', width: 1.25 });
    if (showTh) {
      TDC.rule(ctx, { axis: 'y', value: th.rich, y: yLo, color: K2.gate, label: 'rich ' + F.num(th.rich, 2),
                      side: 'left', layer: 'fg', key: 'th:rich' });
      TDC.rule(ctx, { axis: 'y', value: th.cheap, y: yLo, color: K2.rv, label: 'cheap ' + F.num(th.cheap, 2),
                      side: 'left', layer: 'fg', key: 'th:cheap' });
    }
    ctx.add('fg', 'text', { x: 0, y: loTop - 3, fill: K2.faint, 'font-size': K.fs.micro }, 'VRP score');

    /* the event lane */
    if (evH) {
      var marks = [], k3;
      if (showRef) {
        for (k3 = 0; k3 < D.premium.events.gated.length; k3++) {
          var gg = D.premium.events.gated[k3];
          if (gg.i < w.i0 || gg.i > w.i1) continue;
          marks.push({ i: gg.i, kind: 'refusal', color: K2.gate, key: 'ref:' + gg.k,
            sel: selIs(S, 'refusal', gg.k) || sv(S, 'gate', null) === gg.gate,
            title: 'ENTRY REFUSED · ' + gg.gate + ' · ' + gg.reason + ' · ' + gg.t });
        }
        TDC.eventLane(ctx, { marks: marks, y: evY, h: evH, glyph: 'tick', layer: 'fg', key: 'refusals',
          onMark: function (m) {
            var kk = parseInt(String(m.key).slice(4), 10);
            set({ sel: { type: 'refusal', id: kk }, tab: 'refusals' });
          } });
      }
      if (showEnt) {
        var em = [];
        for (k3 = 0; k3 < D.overlays.entries.length; k3++) {
          var en = D.overlays.entries[k3];
          if (en.dir !== 'open' || en.i < w.i0 || en.i > w.i1) continue;
          em.push({ i: en.i, kind: 'entry', color: K2.ink, key: 'ent:' + en.id,
            sel: selIs(S, 'structure', en.id),
            title: 'ENTRY · ' + F.short(en.id) + ' · ' + String(en.kind).replace(/_/g, ' ') + ' · ' + en.t });
        }
        TDC.eventLane(ctx, { marks: em, y: evY, h: evH, glyph: 'caret', layer: 'fg', key: 'entries',
          onMark: function (m) { set({ sel: { type: 'structure', id: String(m.key).slice(4) } }); } });
      }
    }

    TDC.axisX(ctx, { index: ix, mode: axisMode(S), dayRules: true, ruleH: body, times: true });

    var vAt = valueAtOf(upper === 'vol' ? ivPts : upper === 'spread' ? spPts : raPts);
    var rAt = valueAtOf(rvPts), pAt = valueAtOf(vrpPts);
    ctx.setY(yUp);
    TDC.cursorOverlay(ctx, {
      x: x, y0: 0, y1: ih, group: 'time', valueAt: vAt,
      chip: function (i) {
        var a = vAt(i), b2 = rAt(i), p2 = pAt(i);
        return ix.label(i, 'abs') +
          (isNum(a) ? ('  iv ' + F.vol(a)) : '') +
          (upper === 'vol' && isNum(b2) ? ('  rv ' + F.vol(b2)) : '') +
          (isNum(p2) ? ('  vrp ' + F.num(p2, 2)) : '');
      }
    });
    TDC.hitline(ctx, { index: ix, x: x, id: 'b3', group: 'time', y0: 0, y1: ih });

    /* the threshold rules are selectable objects (SPEC 5 B3) */
    var rules = ctx.svg.querySelectorAll('[data-key^="th:"]');
    for (var r2 = 0; r2 < rules.length; r2++) {
      (function (nEl) {
        nEl.style.cursor = 'pointer';
        nEl.addEventListener('click', function () {
          set({ deck: 'params', sel: { type: 'param',
            id: nEl.getAttribute('data-key') === 'th:rich' ? 'regime.vrp_rich_threshold' : 'regime.vrp_cheap_threshold' } });
        });
      })(rules[r2]);
    }
    if (sel) TDC.dim(ctx, function (k4) { return !k4 || k4 === sel || k4 === 'excluded' || k4.indexOf('th:') === 0; });
    else TDC.dim(ctx, null);
  };

  TDC.mount(st.chart, { pad: { t: 10, r: 10, b: 16, l: 40 }, index: ix, draw: draw, label: 'implied against realized volatility' });

  var rd = D.premium.readout;
  readout(host, 'iv ' + F.vol(rd.iv) + ' · rv ' + F.vol(rd.rv) + ' · spread ' + F.sgn(rd.spread, 2) +
                ' vol pts · ratio ' + F.ratio(rd.ratio, 2) + ' · vrp ' + F.num(rd.vrp, 2));
  provenance(host, F.ts(D.premium.first, 'md') + ' ' + F.ts(D.premium.first, 'hm') + ' → ' +
             F.ts(D.premium.lastT, 'md') + ' ' + F.ts(D.premium.lastT, 'hm') + ' · ' +
             D.premium.sessions + ' sessions · ' + D.premium.obs +
             ' obs · brass = implied, steel = realized · series.signal',
             'no percentile cone or fan: ' + (D.premium.coneReason || ''));
}

/* ---------------------------------------------------------------------------
   B4 · GREEKS — REAL BOOK ONLY  (SPEC 5 B4)
   A four-book greeks chart is prohibited by the render layer, not by a
   caption: this renderer accepts the real book and nothing else.
   --------------------------------------------------------------------------- */

function assertRealOnly(bookKey) {
  if (bookKey !== 'real') {
    throw new Error('TDP.greeks accepts only the real book; the three shadow books store exactly 0.0 ' +
                    'for delta, theta and vega on all 261 of their rows. Refused: ' + bookKey);
  }
  return bookKey;
}
var B4_UNITS = [
  { v: 'usd', label: '$', title: 'dollars' },
  { v: 'per1k', label: '/ $1K EQ', title: 'dollars per $1,000 of broker equity' }
];
function greekCaption(key, v) {
  if (!isNum(v)) return 'not published';
  if (key === 'delta') {
    if (Math.abs(v) < 40) return 'near zero: the hedge is doing its job';
    return v < 0 ? 'short delta: the book gains if the underlying falls'
                 : 'long delta: the book gains if the underlying rises';
  }
  if (key === 'theta') {
    return v > 0 ? 'positive: this is the product — premium decaying in our favour'
         : v < 0 ? 'negative: time is costing us — this book is long premium'
                 : 'flat: no time value either way';
  }
  return v < 0 ? 'negative: the book is short volatility, which is the trade'
       : v > 0 ? 'positive: the book is long volatility'
               : 'flat: no vega exposure';
}

function P_greeks(host, D, S) {
  if (!host || !D) return;
  var g = D.greeks;
  assertRealOnly(g.book);
  var w = win(D, S);
  var ix = IX(D);
  var K2 = C();
  var unit = sv(S, 'b4unit', 'usd');
  var expand = sv(S, 'b4expand', null);

  var pc = controls(host);
  seg(pc, 'b4unit', B4_UNITS, unit, function (v) { set({ b4unit: v }); });

  var keys = ['delta', 'theta', 'vega'];
  function seriesOf(k2) { return unit === 'per1k' ? g[k2].per1kEq : g[k2].series; }
  function valueOf(k2) { return unit === 'per1k' ? g[k2].curPer1kEq : g[k2].cur; }
  function unitOf(k2) { return unit === 'per1k' ? (g[k2].unit + ' / $1k') : g[k2].unit; }
  function fmtOf(k2, v) { return unit === 'per1k' ? F.sgn(v, 4) : F.greek(v, 2); }

  /* the shared window, so a spark and the charts above it agree on x */
  function padded(pts) {
    var p = inWin(pts, w);
    if (!p.length) return p;
    var out = [];
    if (p[0].i > w.i0) out.push({ i: w.i0, v: null });
    out = out.concat(p);
    if (p[p.length - 1].i < w.i1) out.push({ i: w.i1, v: null });
    return out;
  }

  var rows = slot(host, 'rows', 'div', 'lanes');
  var chartBox = slot(host, 'expand', 'div', 'chart');
  chartBox.hidden = !expand;
  rows.hidden = !!expand;

  var i, k2, gg;
  for (i = 0; i < keys.length; i++) {
    k2 = keys[i];
    gg = g[k2];
    var r = slot(rows, 'r_' + k2, 'div', 'row act');
    att(r, 'data-greek', k2);
    var lab = slot(r, 'lab', 'span', 'lab');
    txt(lab, gg.label);
    var val = slot(r, 'val', 'span', 'num f14 c-ink');
    var un = slot(r, 'un', 'span', 'c-faint');
    var sp = slot(r, 'sp', 'span', 'spark');
    var cap = slot(r, 'cap', 'span', 'prose trunc');
    if (!gg.present || !isNum(valueOf(k2))) {
      txt(val, F.DASH); txt(un, ''); clear(sp);
      txt(cap, 'not published — series.books.real[].' + (k2 === 'delta' ? 'd' : k2 === 'theta' ? 'th' : 'vg'));
    } else {
      txt(val, fmtOf(k2, valueOf(k2)));
      txt(un, unitOf(k2));
      TDC.spark(sp, { pts: padded(seriesOf(k2)), w: 80, h: 13, color: K2.soft, zero: true, mark: 'last' });
      txt(cap, greekCaption(k2, gg.cur));
    }
    title(r, gg.label + ' ' + F.greek(gg.cur, 2) + ' ' + gg.unit + ' · per $1k equity ' +
             F.sgn(gg.curPer1kEq, 4) + ' · range ' + F.greek(gg.min, 2) + ' to ' + F.greek(gg.max, 2) +
             ' · ' + gg.nonZero + ' of ' + gg.n + ' marks carry greeks · click to expand');
    payload(r, k2);
    wire(r, 'click', function () { set({ b4expand: this.__tdpp }); });
  }

  if (expand && g[expand]) {
    var ek = expand, eg = g[ek];
    var draw = function (ctx) {
      if (!(ctx.iw > 4 && ctx.ih > 12)) return;
      ctx.setIndex(ix);
      var x = TDC.scaleTick({ index: ix, mode: axisMode(S), range: [0, ctx.iw], i0: w.i0, i1: w.i1 });
      ctx.setX(x);
      var pts = inWin(seriesOf(ek), w);
      var y = TDC.scaleLinear({ domain: TDC.extent(pts) || [0, 1], range: [ctx.ih, 0], nice: true, zero: true, ticks: 3 });
      ctx.setY(y);
      TDC.axisY(ctx, { scale: y, ticks: 3, format: function (v) { return unit === 'per1k' ? F.num(v, 3) : F.num(v, 0); },
                       x0: 0, x1: ctx.iw, layer: 'bg' });
      TDC.area(ctx, { pts: pts, baseline: 0, fill: K2.soft, opacity: 0.14, y: y, key: ek });
      TDC.line(ctx, { pts: pts, color: K2.ink, y: y, key: ek, dot: 'last' });
      TDC.axisX(ctx, { index: ix, mode: axisMode(S), dayRules: true, times: true });
      var at = valueAtOf(pts);
      TDC.cursorOverlay(ctx, { x: x, y0: 0, y1: ctx.ih, group: 'time', valueAt: at,
        chip: function (i2) { var v = at(i2); return ix.label(i2, 'abs') + (isNum(v) ? ('  ' + fmtOf(ek, v)) : ''); } });
      TDC.hitline(ctx, { index: ix, x: x, id: 'b4', group: 'time', y0: 0, y1: ctx.ih });
      ctx.add('fg', 'text', { x: 0, y: 9, fill: K2.faint, 'font-size': K.fs.small },
        eg.label + ' ' + unitOf(ek) + ' · click the header chip to collapse');
    };
    TDC.mount(chartBox, { pad: { t: 12, r: 10, b: 16, l: 44 }, index: ix, draw: draw, label: eg.label });
    chip(pc, 'collapse', 'COLLAPSE', false, function () { set({ b4expand: null }); }, 'back to the three greeks');
  } else {
    TDC.unmount(chartBox);
    var cb = pc && pc['__tdp_chip_collapse'];
    if (cb && cb.parentNode) cb.parentNode.removeChild(cb);
    if (pc) pc['__tdp_chip_collapse'] = null;
  }

  judgeNote(host, 'b4',
    '<b>Greeks are the attribution language.</b> Theta ' + esc(F.greek(g.theta.cur, 2)) +
    ' per day is what the desk sells; vega ' + esc(F.greek(g.vega.cur, 2)) +
    ' per volatility point is the exposure that pays for it; delta ' + esc(F.greek(g.delta.cur, 2)) +
    ' per point is the residual the hedge is there to keep near zero. The three shadow books store ' +
    'exactly 0.0 on all ' + esc(String(g.shadowRowCount)) + ' of their rows, so a four-book greeks ' +
    'chart would be three flat lines pretending to be a comparison — this renderer refuses the key.');

  readout(host, 'Δ ' + F.greek(g.delta.cur, 2) + ' · Θ ' + F.greek(g.theta.cur, 2) + ' · V ' +
                F.greek(g.vega.cur, 2) + ' · real book · ' + g.nonZero + ' of ' + g.n + ' marks',
          'delta $/1pt, theta $/day, vega $/volpt — real book only');
  provenance(host, 'series.books.real[].{d,th,vg} · ' + g.n + ' marks, ' + g.nonZero +
             ' non-zero · the three shadow books store 0.0 on all ' + g.shadowRowCount + ' rows');
}

/* ---------------------------------------------------------------------------
   B5 · CONTEXT & DESK RIBBON  (SPEC 5 B5)
   Owner of the shared x-axis and the brush for the whole B column.
   --------------------------------------------------------------------------- */

var B5_LANES = [
  { k: 'regime', label: 'REGIME' },
  { k: 'desk', label: 'DESK' },
  { k: 'analyst', label: 'ANALYST' },
  { k: 'second', label: 'SECOND' },
  { k: 'mult', label: 'MULT' }
];
function laneMap(S) {
  var o = sv(S, 'b5lanes', null), out = {}, i;
  for (i = 0; i < B5_LANES.length; i++) out[B5_LANES[i].k] = (o && o[B5_LANES[i].k] !== undefined) ? !!o[B5_LANES[i].k] : true;
  return out;
}
function decisionMarks(D, ix, kinds) {
  var rows = D.raw && D.raw.decisions ? D.raw.decisions : [], out = [], i, r, want = {};
  for (i = 0; i < kinds.length; i++) want[kinds[i]] = 1;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (!want[r.kind]) continue;
    var idx = ix.of(r.t);
    if (idx < 0) continue;
    out.push({ i: idx, kind: r.kind, t: r.t, reason: r.reason || '' });
  }
  return out;
}

function P_ribbon(host, D, S) {
  if (!host || !D) return;
  var ix = IX(D);
  var w = win(D, S);
  var K2 = C();
  var lanes = laneMap(S);
  var filter = sv(S, 'b5filter', null);
  var dk = D.desk;

  var pc = controls(host);
  chip(pc, 'dark', 'DARK', filter === 'dark', function () { set({ b5filter: filter === 'dark' ? null : 'dark' }); },
       dk.dark + ' of ' + dk.n + ' meetings ran with no model reachable', dk.dark);
  chip(pc, 'veto', 'VETO', filter === 'veto', function () { set({ b5filter: filter === 'veto' ? null : 'veto' }); },
       dk.vetoes + ' vetoes — a veto stops new short-premium risk for the session', dk.vetoes);
  chip(pc, 'dis', 'DIS', filter === 'dis', function () { set({ b5filter: filter === 'dis' ? null : 'dis' }); },
       dk.disagreements + ' disagreements between the two regime reads — each halves position size',
       dk.disagreements);

  var chart = chartHost(host, 'chart');
  var closedMarks = decisionMarks(D, ix, ['market_closed']);
  var badMarks = decisionMarks(D, ix, ['data_suspect', 'tick_crash', 'flatten_all', 'repair', 'chain_relinked']);

  var draw = function (ctx) {
    if (!(ctx.iw > 4 && ctx.ih > 20)) return;
    ctx.setIndex(ix);
    var x = TDC.scaleTick({ index: ix, mode: axisMode(S), range: [0, ctx.iw], i0: w.i0, i1: w.i1 });
    ctx.setX(x);
    var ih = ctx.ih, axH = 12, gap = 2;
    var vis = [], i;
    for (i = 0; i < B5_LANES.length; i++) if (lanes[B5_LANES[i].k]) vis.push(B5_LANES[i]);
    var n = Math.max(vis.length, 1);
    var laneH = clamp(Math.floor((ih - axH - gap * (n - 1)) / n), 5, 14);
    var band = x.band || 2;
    var yOf = {}, y = 0;
    for (i = 0; i < vis.length; i++) { yOf[vis[i].k] = y; y += laneH + gap; }
    var bodyH = Math.max(y - gap, 1);

    /* a clickable lane label in the left pad — the panel is 99px tall and
       cannot also carry five visibility chips in its 22px header */
    function laneLabel(key, label, on, yy) {
      var t = ctx.add('fg', 'text', {
        x: -6, y: yy + laneH - Math.max(0, (laneH - K.fs.small) / 2) - 1, 'text-anchor': 'end',
        fill: on ? K2.faint : K2.ruleHi, 'font-size': K.fs.small, 'class': 'lane-label'
      }, label);
      t.style.cursor = 'pointer';
      t.appendChild(TDC.node('title', null, on ? ('hide the ' + label + ' lane') : ('show the ' + label + ' lane')));
      t.addEventListener('click', function () {
        var m = laneMap(S); m[key] = !m[key]; set({ b5lanes: m });
      });
    }
    function hiddenLabel(key, label, yy) { laneLabel(key, label, false, yy); }

    function dimmed(i2, kind) {
      if (!filter) return false;
      if (filter === 'dark') return !dk.byTick[i2] || !dk.byTick[i2].dark;
      if (filter === 'veto') return !dk.byTick[i2] || !dk.byTick[i2].veto;
      if (filter === 'dis') return !dk.byTick[i2] || !dk.byTick[i2].dis;
      return false;
    }

    /* 1 REGIME — derived per tick from the VRP score against the two rules */
    if (lanes.regime) {
      var ry = yOf.regime;
      var reg = inWin(D.signal.all.regime, w);
      TDC.categoryLane(ctx, { pts: reg, colors: { neutral: K2.raised, rich: null, cheap: null },
        y: ry, h: laneH, key: 'regime', labelAt: false, opacity: 1, label: 'REGIME' });
      TDC.categoryLane(ctx, { pts: reg, colors: { rich: K2.gate, cheap: K2.rv, neutral: null },
        y: ry, h: laneH, key: 'regime', labelAt: false, opacity: 0.22, label: 'REGIME' });
      laneLabel('regime', 'REGIME', true, ry);
    }

    /* 2 DESK STATE — derisk shaded, market-closed dulled, incidents in breach */
    if (lanes.desk) {
      var dy = yOf.desk, j;
      ctx.add('bg', 'rect', { x: 0, y: dy, width: Math.max(ctx.iw, 1), height: laneH, fill: K2.raised, 'fill-opacity': 0.5 });
      for (j = 0; j < D.overlays.deriskBands.length; j++) {
        var db = D.overlays.deriskBands[j];
        var a0 = Math.max(db.i0, w.i0), a1 = Math.min(db.i1, w.i1);
        if (a1 < a0) continue;
        var bx0 = x(a0) - band / 2, bx1 = x(a1) + band / 2;
        ctx.add('series', 'rect', { x: bx0.toFixed(2), y: dy, width: Math.max(bx1 - bx0, 1).toFixed(2),
          height: laneH, fill: K2.gate, 'fill-opacity': 0.3, 'class': 'ev ev-band', 'data-key': 'derisk' })
          .appendChild(TDC.node('title', null, 'DERISK · ' + db.n + ' ticks · ' + db.reason));
      }
      var cm = [], bm = [];
      for (j = 0; j < closedMarks.length; j++) if (closedMarks[j].i >= w.i0 && closedMarks[j].i <= w.i1)
        cm.push({ i: closedMarks[j].i, kind: 'market_closed', color: K2.ruleHi,
                  title: 'MARKET CLOSED · ' + closedMarks[j].t + ' · ' + closedMarks[j].reason });
      for (j = 0; j < badMarks.length; j++) if (badMarks[j].i >= w.i0 && badMarks[j].i <= w.i1)
        bm.push({ i: badMarks[j].i, kind: badMarks[j].kind, color: K2.breach,
                  title: TDD.KIND_LABEL[badMarks[j].kind] + ' · ' + badMarks[j].t + ' · ' + badMarks[j].reason });
      TDC.eventLane(ctx, { marks: cm, y: dy, h: laneH, glyph: 'band', color: K2.ruleHi, opacity: 0.55, key: 'closed', layer: 'series' });
      TDC.eventLane(ctx, { marks: bm, y: dy, h: laneH, glyph: 'tick', key: 'incident', layer: 'fg' });
      laneLabel('desk', 'DESK', true, dy);
    }

    /* 3 ANALYST (Claude) and 4 SECOND OPINION (Mistral) */
    var voteColors = { rich: K2.gate, cheap: K2.rv, neutral: K2.raised };
    function voteLane(key, label, pts, yy) {
      TDC.categoryLane(ctx, {
        pts: inWin(pts, w), colors: voteColors, y: yy, h: laneH, key: key, labelAt: false, opacity: 0.85,
        label: label,
        onCell: function (r2) { set({ sel: { type: 'meeting', id: r2.i0 } }); }
      });
      laneLabel(key, label, true, yy);
    }
    if (lanes.analyst) voteLane('analyst', 'ANALYST', dk.lanes.analyst, yOf.analyst);
    if (lanes.second) voteLane('second', 'SECOND', dk.lanes.second, yOf.second);

    /* the dark meetings, the vetoes and the disagreements */
    if (lanes.analyst) {
      var dm = [];
      for (i = 0; i < dk.lanes.dark.length; i++) {
        var d2 = dk.lanes.dark[i];
        if (d2.i < w.i0 || d2.i > w.i1) continue;
        dm.push({ i: d2.i, kind: 'dark', color: K2.soft, key: 'meeting:' + d2.i,
                  sel: selIs(S, 'meeting', d2.i), title: 'NO MODEL REACHABLE · ' + d2.title + ' · ' + ix.label(d2.i, 'abs') });
      }
      TDC.eventLane(ctx, { marks: dm, y: yOf.analyst, h: laneH, glyph: 'hollow', layer: 'fg', key: 'dark',
        onMark: function (m) { set({ sel: { type: 'meeting', id: parseInt(String(m.key).slice(8), 10) } }); } });
    }
    if (lanes.analyst && lanes.second) {
      var dsY = yOf.analyst + laneH;
      for (i = 0; i < dk.lanes.disagreement.length; i++) {
        var ds = dk.lanes.disagreement[i];
        if (ds.i < w.i0 || ds.i > w.i1) continue;
        var dx = x(ds.i);
        ctx.add('fg', 'rect', { x: (dx - 1).toFixed(2), y: dsY - 1, width: 2, height: gap + 2,
          fill: K2.sel, 'class': 'ev', 'data-key': 'disagreement' })
          .appendChild(TDC.node('title', null, 'DISAGREEMENT · ' + ds.title + ' · ' + ix.label(ds.i, 'abs')));
      }
    }
    if (lanes.second) {
      var vm = [];
      for (i = 0; i < dk.lanes.veto.length; i++) {
        var vv = dk.lanes.veto[i];
        if (vv.i < w.i0 || vv.i > w.i1) continue;
        vm.push({ i: vv.i, kind: 'veto', color: K2.breach, key: 'meeting:' + vv.i,
                  sel: selIs(S, 'meeting', vv.i), title: 'DESK VETO · ' + vv.title });
      }
      TDC.eventLane(ctx, { marks: vm, y: yOf.second, h: laneH, glyph: 'tick', layer: 'fg', key: 'veto', w: 2,
        onMark: function (m) { set({ sel: { type: 'meeting', id: parseInt(String(m.key).slice(8), 10) } }); } });
    }

    /* 5 SIZE MULT — a 0-1 step line */
    if (lanes.mult) {
      var my = yOf.mult;
      var yM = TDC.scaleLinear({ domain: [0, 1], range: [my + laneH, my], nice: false });
      ctx.add('bg', 'rect', { x: 0, y: my, width: Math.max(ctx.iw, 1), height: laneH, fill: K2.raised, 'fill-opacity': 0.5 });
      TDC.step(ctx, { pts: inWin(dk.lanes.mult, w), color: K2.ink, y: yM, key: 'mult', width: 1 });
      laneLabel('mult', 'MULT', true, my);
    }

    /* the lanes that are switched off keep their label so they can come back */
    for (i = 0; i < B5_LANES.length; i++) {
      if (lanes[B5_LANES[i].k]) continue;
      hiddenLabel(B5_LANES[i].k, B5_LANES[i].label, bodyH + 1);
    }

    TDC.axisX(ctx, { index: ix, mode: axisMode(S), dayRules: true, ruleH: bodyH, y: bodyH + 1, times: true });

    TDC.cursorOverlay(ctx, {
      x: x, y0: 0, y1: bodyH, group: 'time', dot: false,
      chip: function (i2) {
        var m = dk.byTick[i2];
        var s2 = D.signal.byTick[i2];
        return ix.label(i2, 'abs') +
          (s2 && s2.vrp !== null && s2.vrp !== undefined ? ('  vrp ' + F.num(s2.vrp, 2)) : '') +
          (m ? ('  ' + (m.a || '—') + '/' + (m.b || '—') + '  ×' + F.num(m.mult, 2) + (m.dark ? '  DARK' : '') + (m.veto ? '  VETO' : '')) : '');
      }
    });

    /* THE BRUSH — B5 owns it for the whole B column */
    TDC.hitline(ctx, {
      index: ix, x: x, id: 'b5', group: 'time', y0: 0, y1: bodyH,
      onBrush: function (r2) {
        if (!r2) { set({ range: 'all' }); return; }
        var a = Math.max(0, Math.round(Math.min(r2[0], r2[1])));
        var b2 = Math.min(ix.n - 1, Math.round(Math.max(r2[0], r2[1])));
        if (b2 - a < 1) return;
        set({ range: [a, b2] });
      },
      onDblClick: function () { set({ range: 'all' }); }
    });

    if (filter) {
      TDC.dim(ctx, function (k4) {
        return k4 === (filter === 'dark' ? 'dark' : filter === 'veto' ? 'veto' : 'disagreement');
      });
    } else if (S && S.sel && S.sel.type === 'stage' && (S.sel.id === 'regime' || S.sel.id === 'critic')) {
      TDC.dim(ctx, function (k4) { return k4 === 'analyst' || k4 === 'second' || k4 === 'dark' || k4 === 'veto' || k4 === 'disagreement'; });
    } else TDC.dim(ctx, null);
  };

  TDC.mount(chart, { pad: { t: 4, r: 10, b: 14, l: 54 }, index: ix, draw: draw, label: 'context and desk ribbon' });

  var lastReg = D.signal.current.regime || '—';
  readout(host, 'regime ' + lastReg + ' · analyst rich ' + (dk.census.analyst.rich || 0) + '/cheap ' +
                (dk.census.analyst.cheap || 0) + ' · second rich ' + (dk.census.second.rich || 0) + '/cheap ' +
                (dk.census.second.cheap || 0) + ' · ' + dk.disagreements + ' dis · ' + dk.vetoes +
                ' veto · ' + dk.dark + ' dark · mult ' + F.num(dk.multPredominant.mult, 2) + ' ×' + dk.multPredominant.n,
          'drag to brush the range for every time panel; double-click resets to ALL');

  var dn = D.denominators;
  provenance(host, dn.spineTicks + ' ticks in the shared index · tick_start ' + dn.tickStart + ' · signals ' +
             dn.signals + ' · marks ' + dn.marksJournal + ' · meetings ' + dn.meetings + ' · gate evaluations ' +
             dn.gateEvaluations + ' — five different denominators, not interchangeable',
             dn.note + '. Refusal rows ' + dn.refusalRows + ', integrity ' + dn.integrity +
             ', journal entries ' + dn.journalEntries + '.');

  judgeNote(host, 'b5',
    '<b>Three tick counts, and they are not the same number.</b> ' + esc(String(dn.tickStart)) +
    ' tick_start rows cluster into ' + esc(String(dn.spineTicks)) + ' ticks on the shared index; ' +
    esc(String(dn.signals)) + ' of them produced a signal, ' + esc(String(dn.meetings)) +
    ' produced a desk meeting and ' + esc(String(dn.gateEvaluations)) +
    ' reached the gates. Every rate on this page prints its own denominator for exactly this reason.');
}

/* ===========================================================================
   EXPORTS — keyed by each panel's data-panel attribute (SPEC 2.4)
   =========================================================================== */

TDP.status    = P_status;
TDP.command   = P_command;
TDP.footer    = P_footer;
TDP.signal    = P_signal;
TDP.tree      = P_tree;
TDP.authority = P_authority;
TDP.weakness  = P_weakness;
TDP.ledger    = P_ledger;
TDP.equity    = P_equity;
TDP.thesis    = P_thesis;
TDP.greeks    = P_greeks;
TDP.ribbon    = P_ribbon;

TDP.panelsAB = ['status', 'command', 'footer', 'signal', 'tree', 'authority', 'weakness',
                'ledger', 'equity', 'thesis', 'greeks', 'ribbon'];
/* The S keys these panels read.  Each has a default, so an app.js that never
   writes one still renders; serialising them into the hash is optional. */
TDP.stateKeysAB = {
  ts: 'abs', a1unit: 'score', treeq: '', treeGroups: null,
  base: 'nogates', b2mode: 'split', b2ov: null,
  b3upper: 'vol', b3th: true, b3ref: true, b3ent: true,
  b4unit: 'usd', b4expand: null, b5lanes: null, b5filter: null,
  stageKinds: null
};
TDP.versionAB = '1.0.0';

})(window, document);
