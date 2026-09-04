/* ===========================================================================
   panels-d.js — THETA DESK · COLUMN D · proof and detail
   ---------------------------------------------------------------------------
   D1 RECONCILIATION   the subtraction, never a total
   D2 INTEGRITY & CHAIN the 97-cell strip and the verification line
   D3 CLOSED TRADES    waterfall / R-multiple / hours, six trades, no trend
   D4 DECK             STRIKES · PATHS · FUNNEL · PARAMS · CLAIMS
   D5 INSPECTOR        permanent, type-polymorphic, never a modal, never empty

   Contract (§2.4): every renderer is TDP.<panel>(host, D, S) where host is the
   panel's [data-body] element, D is TDD.derive(data) and S is the state object.
   Renderers are idempotent, attach no window/document listeners and return
   nothing.  Panel controls go into the header's [data-controls] hook, the live
   values into [data-readout], the source path into [data-provenance].

   Rules honoured here, deliberately and visibly:
     · every colour comes from TDC.C or from a class in styles.css — no literal
       hex anywhere in this file (make lint-hex)
     · green is never drawn by this file; the integrity strip emits the class
       `ok` and #p-integrity's rule in styles.css is what paints it (lint-green)
     · a negative number is ink with a leading minus; red is by kind only
     · a value the export does not carry renders .notpub naming the field path,
       never a zero, never a blank
     · no rolling statistic, moving average or trend line is drawn at any n
   =========================================================================== */

window.TDP = window.TDP || {};

(function (global) {
'use strict';

var doc = global.document;
var TDC = global.TDC;
var TDD = global.TDD;
var fmt = TDC.fmt;
var K   = TDC.K;

var DOT  = ' · ';
var SIG  = 'σ';
var PM   = '±';
var ARR  = '→';
var TIMES = '×';

/* ===========================================================================
   1 · DOM AND FORMAT HELPERS
   =========================================================================== */

function E(tag, cls, text) {
  var e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== null && text !== undefined) e.textContent = String(text);
  return e;
}
function AP(parent, child) { parent.appendChild(child); return child; }
function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
function attr(el, k, v) { if (v === null || v === undefined) el.removeAttribute(k); else el.setAttribute(k, String(v)); return el; }
function txt(el, s) { clear(el); el.appendChild(doc.createTextNode(s == null ? '' : String(s))); return el; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function arr(v) { return Array.isArray(v) ? v : []; }
function num(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }

/* "—" is the only no-value glyph on the page. */
var DASH = fmt.DASH;

function money(v, dp) { return v == null ? DASH : fmt.usd(v, dp == null ? 2 : dp); }
function plain(v, dp) { return v == null ? DASH : fmt.money(v, dp == null ? 2 : dp); }
function count(v) { return v == null ? DASH : fmt.count(v); }
/* a bare number: a strike, a cent count, a day count, a multiplier -- never a $ */
function nm(v, dp) { return v == null ? DASH : fmt.num(v, dp == null ? 2 : dp); }
function rate(n, d) { return (n == null || !d) ? DASH : fmt.rate(n, d); }
function short8(s) { return fmt.short(s, 8); }

/* a compact "n of m (p%)" that never prints a rate without its denominator */
function ofRate(n, d) {
  if (n == null || !d) return DASH;
  return count(n) + ' of ' + count(d) + ' (' + (n / d * 100).toFixed(1) + '%)';
}

/* ===========================================================================
   2 · PANEL PLUMBING
   Controls, readout, provenance, panel-local view state, local repaint.
   =========================================================================== */

function panelOf(host) {
  if (!host) return null;
  if (host.closest) return host.closest('section.p') || host.parentNode;
  return host.parentNode;
}
function hookOf(host, name) {
  var p = panelOf(host);
  return p ? p.querySelector('[data-' + name + ']') : null;
}
function controls(host) { return hookOf(host, 'controls'); }
function readout(host, s) { var el = hookOf(host, 'readout'); if (el) txt(el, s); return el; }
function provenance(host, s) { var el = hookOf(host, 'provenance'); if (el) { txt(el, s); el.title = s; } return el; }

/* Pick the longest readout that leaves every control clickable.  `variants` is
   longest first; `prefix` optionally builds a node (the win dots) that always
   precedes the text.  Measured, not estimated, so it holds at every breakpoint
   and in whatever font actually loaded. */
function readoutFit(host, variants, title, prefix) {
  var ro = hookOf(host, 'readout');
  if (!ro) return;
  var pc = hookOf(host, 'controls');
  function put(str, withPrefix) {
    clear(ro);
    if (prefix && withPrefix) ro.appendChild(prefix());
    if (str) ro.appendChild(doc.createTextNode(str));
  }
  function clipped() { return !!pc && pc.scrollWidth > pc.clientWidth + 0.5; }

  for (var i = 0; i < variants.length; i++) {
    put(variants[i], true);
    /* the exact failure this guards against: .pc is flex:0 1 auto with
       overflow:hidden, so when the header runs out of room the controls are
       what disappears.  scrollWidth > clientWidth IS "a button is clipped". */
    if (!pc || i === variants.length - 1 || !clipped()) break;
  }
  /* still clipped at the narrowest variant (the 296px accordion): drop the
     prefix, then trim.  A control the user cannot click is worse than a
     readout the user has to hover — and the title always carries the full text. */
  var last = variants.length ? String(variants[variants.length - 1]) : '';
  if (clipped() && prefix) put(last, false);
  var guard = 0;
  while (clipped() && last.length && guard++ < 64) {
    last = last.slice(0, -1).replace(/[\s\/·+\-]+$/, '');
    put(last, false);
  }
  if (title) ro.title = title;
}

/* Panel-local VIEW state (a sub-mode, a sort order, an expanded flag) has no
   home in S (§7.1 fixes S's keys) and no home in the hash (§7.6 fixes those
   too), so it lives on the panel element as a data attribute: the least state
   possible, and it survives the full render pass because nothing clears the
   section.  Shared state still goes through TD.set() and nothing else. */
function vget(host, key, dflt) {
  var p = panelOf(host);
  if (!p) return dflt;
  var v = p.getAttribute('data-v-' + key);
  return v === null ? dflt : v;
}
function vset(host, key, val) {
  var p = panelOf(host);
  if (p) p.setAttribute('data-v-' + key, String(val));
}
/* remember the last (D,S) so a local control can repaint its own panel without
   a page-wide pass; TD.set() remains the only path for shared state. */
function remember(host, fn, D, S) {
  var p = panelOf(host);
  if (p) p.__tdp = { fn: fn, D: D, S: S, host: host };
}
function repaint(host) {
  var p = panelOf(host);
  if (p && p.__tdp) p.__tdp.fn(p.__tdp.host, p.__tdp.D, p.__tdp.S);
}
function local(host, key, val) { vset(host, key, val); repaint(host); }

function TD() { return global.TD; }
function tdset(patch) {
  var td = TD();
  if (td && typeof td.set === 'function') td.set(patch);
}
function select(type, id) { tdset({ sel: { type: type, id: id } }); }
function selIs(S, type, id) {
  var s = S && S.sel;
  return !!(s && s.type === type && String(s.id) === String(id));
}
/* the raw-record drawer belongs to app.js; if it is not there yet the record
   is shown inline rather than behind a dead button. */
function raw(host, obj, label) {
  var td = TD();
  if (td && typeof td.drawer === 'function') { td.drawer(obj, label); return; }
  var p = panelOf(host);
  var body = p ? p.querySelector('[data-body]') : host;
  var old = body.querySelector('[data-rawjson]');
  if (old) { old.parentNode.removeChild(old); return; }
  var box = E('div', 'json');
  attr(box, 'data-rawjson', '1');
  box.textContent = safeJson(obj);
  body.appendChild(box);
  box.scrollIntoView({ block: 'nearest' });
}
function safeJson(o) {
  try { return JSON.stringify(o, null, 1); } catch (e) { return String(o); }
}
function copyLink() {
  var td = TD(), href = null;
  if (td && typeof td.link === 'function') href = td.link();
  else if (td && typeof td.hash === 'function') href = td.hash();
  if (href == null) { try { href = String(global.location.href); } catch (e2) { href = ''; } }
  TDC.copy(href);
  return href;
}

/* ===========================================================================
   3 · SHARED WIDGETS — every one of them a class that exists in styles.css
   =========================================================================== */

function seg(items, active, onPick, useShort) {
  var d = E('div', 'seg');
  attr(d, 'role', 'radiogroup');
  items.forEach(function (it) {
    var b = E('button', null, (useShort && it.short) ? it.short : it.label);
    b.type = 'button';
    attr(b, 'role', 'radio');
    attr(b, 'aria-checked', it.v === active ? 'true' : 'false');
    attr(b, 'data-v', it.v);
    if (it.title) b.title = it.title;
    b.addEventListener('click', function (ev) { onPick(it.v, ev); });
    d.appendChild(b);
  });
  return d;
}
/* Append a segmented control and, only if it measurably does not fit, swap in
   the short labels.  The readout is emptied by the caller first, so the
   controls are measured against the room they will actually have. */
function segFit(pc, items, active, onPick) {
  var d = seg(items, active, onPick, false);
  pc.appendChild(d);
  var hasShort = false;
  items.forEach(function (it) { if (it.short) hasShort = true; });
  if (hasShort && pc.scrollWidth > pc.clientWidth + 0.5) {
    pc.removeChild(d);
    d = seg(items, active, onPick, true);
    pc.appendChild(d);
  }
  return d;
}

function chip(label, on, onClick, opts) {
  opts = opts || {};
  var b = E('button', 'chip' + (opts.cls ? ' ' + opts.cls : ''));
  b.type = 'button';
  b.appendChild(doc.createTextNode(label));
  if (opts.n != null) b.appendChild(E('span', 'n', ' ' + count(opts.n)));
  if (on !== null && on !== undefined) attr(b, 'aria-pressed', on ? 'true' : 'false');
  if (opts.title) b.title = opts.title;
  if (onClick) b.addEventListener('click', onClick);
  else { b.disabled = true; }
  return b;
}
function ibtn(label, title, onClick) {
  var b = E('button', 'ibtn', label);
  b.type = 'button';
  if (title) { b.title = title; attr(b, 'aria-label', title); }
  if (onClick) b.addEventListener('click', onClick); else b.disabled = true;
  return b;
}

/* §3.6 — one empty state for every missing thing. */
function notpub(path, why, fix) {
  var d = E('div', 'notpub');
  d.appendChild(E('b', null, 'not published'));
  d.appendChild(E('span', null, path));
  if (why) d.appendChild(E('span', null, why));
  d.appendChild(E('span', null, fix || 'tools/site_data.py'));
  if (why) d.title = why;
  return d;
}
function notpubInline(path, why) {
  var d = E('div', 'notpub inline');
  d.appendChild(E('b', null, 'not published'));
  d.appendChild(E('span', null, path));
  if (why) d.title = why;
  return d;
}
/* the derive layer keeps the registry of every null with the reason for it */
function notpubFor(D, key, path) {
  var m = D.missingByKey ? D.missingByKey[key] : null;
  if (!m) return notpub(path || key, null, null);
  return notpub(m.path, m.why, m.fix);
}
function notpubInlineFor(D, key, path) {
  var m = D.missingByKey ? D.missingByKey[key] : null;
  return notpubInline(m ? m.path : (path || key), m ? m.why : null);
}

/* a definition list; pairs are [label, value, {cls,title,click,html}] */
function dl(pairs, wide) {
  var d = E('dl', 'dl' + (wide ? ' wide' : ''));
  /* GEOMETRY ONLY, and measured: styles.css sizes .dl with a percentage track
     (minmax(96px,42%)), and inside .pb's scroll container Chrome resolves that
     grid at max-content — a 329px body renders a 477px list and the panel
     scrolls sideways.  Clamping the box is the whole fix; nothing about colour,
     type or spacing is touched.  Delete this line if .dl ever gains
     max-width:100% in styles.css. */
  d.style.maxWidth = '100%';
  pairs.forEach(function (p) {
    if (!p) return;
    d.appendChild(E('dt', null, p[0]));
    var o = p[2] || {};
    var dd = E('dd', o.cls || null);
    if (o.node) dd.appendChild(o.node);
    else dd.textContent = (p[1] === null || p[1] === undefined || p[1] === '') ? DASH : String(p[1]);
    if (o.title) dd.title = o.title;
    if (o.click) { dd.style.cursor = 'pointer'; dd.addEventListener('click', o.click); }
    d.appendChild(dd);
  });
  return d;
}

/* a list row: label … value.  `.row.act` when it selects something. */
function row(label, value, opts) {
  opts = opts || {};
  var r = E('div', 'row' + (opts.act ? ' act' : '') + (opts.tall ? ' tall' : ''));
  if (opts.sev) attr(r, 'data-sev', opts.sev);
  if (opts.sel) attr(r, 'data-sel', '1');
  if (label != null) r.appendChild(E('span', (opts.labCls || 'lab') + ' nowrap', label));
  if (opts.mid) r.appendChild(opts.mid);
  if (opts.note != null) r.appendChild(E('span', 'c-faint trunc', opts.note));
  if (opts.noteTitle) r.title = opts.noteTitle;
  if (value != null) r.appendChild(E('span', 'num ' + (opts.valCls || 'c-ink'), value));
  if (opts.title) r.title = opts.title;
  if (opts.click) { r.addEventListener('click', opts.click); r.className += ' act'; }
  return r;
}

/* a table; cols = [{k,label,cls,num,w,get,title}] */
function table(cols, rows, opts) {
  opts = opts || {};
  var t = E('table', 'tbl');
  var thead = AP(t, E('thead'));
  var tr = AP(thead, E('tr'));
  cols.forEach(function (c) {
    var th = E('th', c.cls || null, c.label);
    if (c.num) attr(th, 'data-num', '1');
    if (c.w) th.style.width = c.w;
    if (c.title) th.title = c.title;
    if (opts.sortable && c.k) {
      attr(th, 'aria-sort', opts.sortKey === c.k ? (opts.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.addEventListener('click', function () { opts.onSort(c.k); });
    }
    tr.appendChild(th);
  });
  var tb = AP(t, E('tbody'));
  rows.forEach(function (r, ri) {
    var trr = E('tr');
    if (opts.sel && opts.sel(r, ri)) attr(trr, 'data-sel', '1');
    if (opts.dim && opts.dim(r, ri)) attr(trr, 'data-dim', '1');
    cols.forEach(function (c) {
      var v = c.get ? c.get(r, ri) : r[c.k];
      var td = E('td', c.cls || null);
      if (c.num) attr(td, 'data-num', '1');
      if (c.sev) { var s = c.sev(r); if (s) attr(td, 'data-sev', s); }
      if (v && v.nodeType === 1) td.appendChild(v);
      else td.textContent = (v === null || v === undefined || v === '') ? DASH : String(v);
      if (c.tip) { var tt = c.tip(r); if (tt) td.title = tt; }
      trr.appendChild(td);
    });
    if (opts.onRow) { trr.style.cursor = 'pointer'; trr.addEventListener('click', function (ev) { opts.onRow(r, ev, ri); }); }
    if (opts.onEnter) {
      trr.addEventListener('dblclick', function (ev) { opts.onEnter(r, ev, ri); });
    }
    if (opts.rowTitle) { var rt = opts.rowTitle(r); if (rt) trr.title = rt; }
    tb.appendChild(trr);
  });
  if (opts.foot) {
    var tf = AP(t, E('tfoot'));
    var ftr = AP(tf, E('tr'));
    var ftd = E('td', null, opts.foot);
    attr(ftd, 'colspan', cols.length);
    ftr.appendChild(ftd);
  }
  return t;
}

function badge(text, cls, title) {
  var b = E('span', 'badge' + (cls ? ' ' + cls : ''), text);
  if (title) b.title = title;
  return b;
}

/* four up dots and two down dots plus "4 of 6" — §5 D3, no rolling curve */
function dots(list) {
  var d = E('span', 'dots');
  list.forEach(function (up) { d.appendChild(E('i', up ? 'up' : 'dn')); });
  return d;
}

/* a mounted chart host that survives the render pass, so TDC.mount reuses one
   ctx (and one ResizeObserver) for the life of the panel. */
function chartHost(host, key) {
  var el = host.firstElementChild;
  if (el && el.getAttribute('data-chart') === key && host.children.length === 1) return el;
  clear(host);
  el = E('div', 'chart');
  attr(el, 'data-chart', key);
  host.appendChild(el);
  return el;
}
/* a DOM sub-view host that survives the pass, so an <input> keeps its caret */
function viewHost(host, key) {
  var el = host.firstElementChild;
  if (el && el.getAttribute('data-view') === key && host.children.length === 1) {
    return { el: el, fresh: false };
  }
  clear(host);
  el = E('div');
  attr(el, 'data-view', key);
  host.appendChild(el);
  return { el: el, fresh: true };
}

/* width of a DOM-hosted mini mark; the element is already in the document. */
function widthOf(el, dflt) {
  var w = el && el.clientWidth ? el.clientWidth : 0;
  return w > 8 ? w : (dflt || 320);
}

/* Mono advance is ~0.6em.  charts.js keeps these to itself, so a panel that
   draws its own svg text needs its own copy: a label that will not fit is
   truncated rather than run across the label next to it. */
function tw(s, fs) { return String(s == null ? '' : s).length * (fs || K.fs.small) * 0.6; }
/* Truncate an svg <text> to a real measured width.  styles.css sets
   `.chart svg text{font-size:var(--f10)}` and a CSS declaration beats an SVG
   presentation attribute, so a label inside a mounted chart renders at 10.5px
   however it was authored: arithmetic is wrong by a quarter exactly where the
   labels are tightest.  getComputedTextLength is the only honest ruler. */
function clampText(node, str, maxW) {
  str = String(str == null ? '' : str);
  node.textContent = str;
  if (!str.length || !(maxW > 0)) return node;
  var w = 0;
  try { w = node.getComputedTextLength(); } catch (e) { w = tw(str, K.fs.axis); }
  if (w <= maxW) return node;
  var per = w / str.length;
  var n = Math.max(1, Math.floor(maxW / per) - 1);
  node.textContent = str.slice(0, n) + '…';
  return node;
}

/* the visible window [i0,i1] for the shared axis */
function windowOf(D, S) {
  var r = (S && S.range) || 'all';
  var s = D.spine.slice(r);
  return { i0: s[0], i1: s[1] };
}
function axisMode(S) { return (S && S.axis === 'time') ? 'time' : 'session'; }

/* human labels for the panel ids the params table cites (labels, not data) */
var PANEL_LABEL = {
  a1: 'SIGNAL', a2: 'CONTEXT TREE', a3: 'AUTHORITY', a4: 'WEAKNESSES',
  b1: 'ABLATION LEDGER', b2: 'EQUITY', b3: 'IMPLIED vs REALIZED', b4: 'GREEKS',
  b5: 'DESK RIBBON', c1: 'GATE MATRIX', c2: 'RISK LADDER', c3: 'REFUSALS',
  c4: 'BLOTTER', d1: 'RECONCILIATION', d2: 'INTEGRITY', d3: 'CLOSED TRADES',
  d4: 'DECK', d5: 'INSPECTOR', p00: 'STATUS RAIL'
};

/* ===========================================================================
   4 · D1 · RECONCILIATION
   The gap is the headline and it is printed as a subtraction, never as one
   "equity" line: broker equity against start + realized + unrealized, the
   difference, the difference per leg, and the measured half-spread envelope
   of the nine legs we actually hold.
   =========================================================================== */

function reconVerdict(R) {
  if (R.gap == null) return { state: 'unknown', text: 'the gap cannot be computed', shortText: DASH };
  var a = Math.abs(R.gap);
  if (R.envelope.narrow != null && a <= R.envelope.narrow) {
    return { state: 'narrow',
      text: 'inside the narrowest quote we hold (' + PM + plain(R.envelope.narrow) + ' at ' +
            nm(R.quotes.narrowest_c, 1) + 'c)',
      shortText: 'inside ' + PM + plain(R.envelope.narrow, 0) + ' narrowest' };
  }
  if (R.envelope.wide != null && a <= R.envelope.wide) {
    var band = (R.envelope.median != null && a <= R.envelope.median) ? 'median' : 'widest';
    var v = band === 'median' ? R.envelope.median : R.envelope.wide;
    var c = band === 'median' ? R.quotes.median_c : R.quotes.widest_c;
    return { state: band,
      text: 'inside the ' + band + ' half-spread of the legs we hold (' + PM + plain(v) +
            ' at ' + nm(c, 1) + 'c)',
      shortText: 'inside ' + PM + plain(v, 0) + ' ' + band + ' (' + nm(c, 0) + 'c)' };
  }
  return { state: 'outside',
    text: 'OUTSIDE the widest half-spread of the legs we hold (' + PM + plain(R.envelope.wide) + ')',
    shortText: 'OUTSIDE ' + PM + plain(R.envelope.wide, 0) };
}

/* the envelope: three nested half-spread bands, a labelled zero and the gap
   marker.  Drawn with TDC.mini because it is 22px tall and never resizes on
   its own — the panel redraws it. */
function drawEnvelope(el, R, verdict) {
  var C = TDC.C;
  var W = widthOf(el, 300), H = 24, padX = 8;
  var m = TDC.mini(el, W, H, 'tdc-envelope', 'none');
  /* the host may gain a scrollbar after this is measured, so the svg stretches
     to whatever width it ends up with rather than pinning 357px of content. */
  m.svg.style.width = '100%';
  var wide = R.envelope.wide, med = R.envelope.median, nar = R.envelope.narrow;
  var span = Math.max(wide == null ? 0 : wide, R.gap == null ? 0 : Math.abs(R.gap)) * 1.18 || 1;
  var x0 = padX, x1 = W - padX;
  var x = function (v) { return x0 + (v + span) / (2 * span) * (x1 - x0); };
  var yTop = 1, bh = 11, mid = yTop + bh / 2;

  function band(v, opacity) {
    if (v == null) return;
    m.add('rect', {
      x: x(-v).toFixed(2), y: yTop, width: Math.max(1, x(v) - x(-v)).toFixed(2), height: bh,
      fill: C.raised, 'fill-opacity': opacity
    });
  }
  band(wide, 0.55); band(med, 0.85); band(nar, 1);

  /* the two edges that carry a number: the median and the widest */
  function edge(v) {
    if (v == null) return;
    [-v, v].forEach(function (s) {
      m.add('rect', { x: (x(s) - 0.5).toFixed(2), y: yTop - 1, width: 1, height: bh + 2, fill: C.gate, 'fill-opacity': 0.75 });
    });
  }
  edge(nar); edge(med); edge(wide);

  /* zero */
  m.add('rect', { x: (x(0) - 0.5).toFixed(2), y: yTop - 1, width: 1, height: bh + 2, fill: C.faint });

  /* the gap marker, ink, inside the envelope it is measured against */
  if (R.gap != null) {
    var gx = x(R.gap);
    m.add('rect', { x: (gx - 1).toFixed(2), y: yTop - 2, width: 2, height: bh + 4, fill: C.ink });
  }

  /* the two captions: what the gap is per leg, and which band contains it */
  var left = 'GAP ' + money(R.gap) + DOT + plain(R.perLegCents) + '/leg ' + TIMES + ' ' +
             count(R.legs) + DOT + 'narrowest ' + nm(R.quotes.narrowest_c, 1) + 'c';
  var right = verdict ? verdict.shortText : '';
  var rn = right
    ? m.add('text', { x: W, y: H - 2, 'text-anchor': 'end', fill: C.gate, 'font-size': K.fs.micro }, right)
    : null;
  var rw = 0;
  if (rn) { try { rw = rn.getComputedTextLength(); } catch (e) { rw = tw(right, K.fs.micro); } }
  var ln = m.add('text', { x: 0, y: H - 2, fill: C.ink, 'font-size': K.fs.small });
  clampText(ln, left, W - rw - 8);
  /* if the left caption had to be cut, the verdict yields: the readout carries
     it in every case, and the gap per leg is the number this panel is for. */
  if (rn && ln.textContent.length < left.length) {
    rn.parentNode.removeChild(rn);
    clampText(ln, left, W - 4);
  }
  return m.svg;
}

function drawReconHistory(ctx, D, S) {
  var C = TDC.C, R = D.recon;
  var win = windowOf(D, S);
  var pts = R.historyLine.filter(function (p) { return p.i >= win.i0 && p.i <= win.i1; });
  var lim = [];
  ['wide', 'median'].forEach(function (k) { if (R.envelope[k] != null) lim.push(R.envelope[k], -R.envelope[k]); });
  var ex = TDC.extent(pts) || [-1, 1];
  var lo = Math.min(ex[0], lim.length ? Math.min.apply(null, lim) : ex[0]);
  var hi = Math.max(ex[1], lim.length ? Math.max.apply(null, lim) : ex[1]);

  var x = ctx.setX(TDC.scaleTick({ index: D.spine, mode: axisMode(S), range: [0, ctx.iw], i0: win.i0, i1: win.i1 }));
  var y = ctx.setY(TDC.scaleLinear({ domain: [lo, hi], range: [ctx.ih, 0], nice: true, zero: true }));
  ctx.setIndex(D.spine);

  TDC.axisY(ctx, { scale: y, ticks: 3, format: function (v) { return fmt.usd0(v); } });
  TDC.axisX(ctx, { index: D.spine, mode: axisMode(S) });

  if (R.envelope.wide != null) {
    TDC.rule(ctx, { axis: 'y', value: R.envelope.wide, color: C.gate, label: PM + plain(R.envelope.wide, 0) + ' widest', side: 'right' });
    TDC.rule(ctx, { axis: 'y', value: -R.envelope.wide, color: C.gate, label: null });
  }
  if (R.envelope.median != null) {
    TDC.rule(ctx, { axis: 'y', value: R.envelope.median, color: C.faint, label: PM + plain(R.envelope.median, 0) + ' median', side: 'right' });
    TDC.rule(ctx, { axis: 'y', value: -R.envelope.median, color: C.faint, label: null });
  }
  TDC.line(ctx, { pts: pts, color: C.ink, width: K.lineW, dot: 'last', key: 'gap' });

  TDC.cursorOverlay(ctx, {
    chip: function (i) {
      var h = null;
      for (var j = 0; j < R.history.length; j++) if (R.history[j].i === i) h = R.history[j];
      return h ? (money(h.gap) + ' gap') : '';
    },
    valueAt: function (i) {
      for (var j = 0; j < pts.length; j++) if (pts[j].i === i) return pts[j].v;
      return null;
    }
  });
  TDC.hitline(ctx, { index: D.spine, id: 'p-recon' });
}

function renderRecon(host, D, S) {
  remember(host, renderRecon, D, S);
  var R = D.recon;
  var mode = vget(host, 'mode', 'now');
  var legsOpen = vget(host, 'legs', '0') === '1';
  var v = reconVerdict(R);

  /* ---- controls ---- */
  var pc = controls(host);
  if (pc) {
    clear(pc);
    readout(host, '');                       /* controls are measured first */
    pc.appendChild(seg(
      [{ v: 'now', label: 'NOW', title: 'the current gap inside its measured envelope' },
       { v: 'history', label: 'HIST', title: 'the gap at every tick that carries broker equity' }],
      mode, function (nv) { local(host, 'mode', nv); }));
    pc.appendChild(chip('LEGS', legsOpen, function () {
      local(host, 'legs', legsOpen ? '0' : '1');
    }, { title: 'the ' + count(R.legs) + ' legs the gap is measured over' }));
  }

  /* ---- readout: the panel's exact current values ---- */
  /* the gap is the panel's headline value; the per-leg figure and the verdict
     are printed inside the envelope, which is always visible.  Anything longer
     here squeezes .pc and clips a control. */
  readoutFit(host,
    [money(R.gap) + DOT + plain(R.perLegCents) + '/leg' + DOT + v.shortText,
     money(R.gap) + DOT + plain(R.perLegCents) + '/leg',
     money(R.gap)],
    'broker ' + money(R.brokerEquity) + ' − marked ' + money(R.markedEquity) + ' = ' +
      money(R.gap) + DOT + plain(R.perLegCents) + ' per leg over ' + count(R.legs) + ' legs' +
      DOT + v.text);

  /* ---- body ---- */
  if (legsOpen) {
    var vh = viewHost(host, 'legs');
    var el = clear(vh.el);
    var legs = [];
    D.structures.open.forEach(function (s) {
      s.legs.forEach(function (l) { legs.push({ s: s, l: l }); });
    });
    if (!legs.length) {
      el.appendChild(notpub('positions.open[].legs', 'no open structure carries a leg', 'tools/site_data.py'));
    } else {
      el.appendChild(table([
        { k: 'sym', label: 'LEG', cls: 'id', get: function (r) { return r.l.symbol; } },
        { k: 'qty', label: 'QTY', num: true, get: function (r) { return fmt.sgn(r.l.qty, 0); } },
        { k: 'entry', label: 'ENTRY', num: true, get: function (r) { return nm(r.l.entry, 2); } },
        { k: 'dte', label: 'DTE', num: true, get: function (r) { return nm(r.l.dte, 1); } },
        { k: 'sid', label: 'STRUCTURE', cls: 'id col-structure', get: function (r) { return short8(r.s.id); } }
      ], legs, {
        onRow: function (r) { select('leg', r.l.symbol); },
        rowTitle: function (r) { return r.l.symbol + DOT + r.s.kind + DOT + r.s.sleeve; },
        sel: function (r) { return selIs(S, 'leg', r.l.symbol); },
        foot: 'quote widths are published for the book, not per leg: narrowest ' +
              nm(R.quotes.narrowest_c, 1) + 'c, median ' + nm(R.quotes.median_c, 1) +
              'c, widest ' + nm(R.quotes.widest_c, 1) + 'c'
      }));
      var np = E('div');
      np.appendChild(notpubInline('quotes[].per_leg', 'the export carries the narrowest, median and widest width across the ' + count(R.legs) + ' legs, not one width per leg'));
      el.appendChild(np);
    }
  } else if (mode === 'history') {
    if (!R.history.length) {
      clear(host).appendChild(notpubFor(D, 'shadow_equity', 'series.books.real[].eq'));
    } else {
      var ch = chartHost(host, 'reconhist');
      TDC.mount(ch, {
        pad: { t: 10, r: 46, b: 16, l: 44 },
        label: 'broker equity minus marked book, per tick, against the measured half-spread envelope',
        draw: function (ctx) { drawReconHistory(ctx, D, S); }
      });
    }
  } else {
    var vh2 = viewHost(host, 'now');
    var b = clear(vh2.el);

    b.appendChild(row('BROKER', money(R.brokerEquity, 2), {
      note: 'polled ' + fmt.ts(R.brokerAsOf, 'hms') + 'Z',
      title: 'broker.equity ' + DOT + 'cash ' + plain(R.brokerCash) + DOT + R.brokerAsOf
    }));
    b.appendChild(row('MARKED', money(R.markedEquity, 2), {
      note: plain(R.start, 0) + ' + ' + plain(R.realized) + ' realized ' +
            (R.unrealized < 0 ? '− ' + plain(Math.abs(R.unrealized)) : '+ ' + plain(R.unrealized)) + ' unrealized',
      title: 'book.start + book.realized + book.unrealized, marked at ' + R.markedAt
    }));
    /* the gap, as a marker inside the half-spread envelope of the legs we
       actually hold.  One cent on one contract is one dollar, so the envelope
       is legs x cents x 0.5 and the caption carries the per-leg comparison. */
    var envHost = AP(b, E('div'));
    envHost.title = 'the gap is ' + money(R.gap) + ' — ' + v.text +
      '. One cent on one contract is one dollar, so ' + count(R.legs) + ' legs at the ' +
      nm(R.quotes.median_c, 1) + 'c median quote bound it at ' + PM + plain(R.envelope.median) + '.';
    drawEnvelope(envHost, R, v);
  }

  provenance(host,
    'broker.equity @ ' + fmt.ts(R.brokerAsOf, 'hms') + 'Z' + DOT +
    'book marked @ ' + fmt.ts(R.markedAt, 'hms') + DOT +
    'quotes.legs ' + count(R.legs) + DOT +
    'history ' + count(R.historyN) + ' of ' + count(R.historyOf) + ' real-book rows carry eq' + DOT +
    'series.brokercheck ' + count(R.brokerChecks.length));
}

/* ===========================================================================
   5 · D2 · INTEGRITY & CHAIN
   =========================================================================== */

function renderIntegrityPanel(host, D, S) {
  remember(host, renderIntegrityPanel, D, S);
  var I = D.integrity, V = D.verification, ST = D.status, CL = D.claims;

  var pc = controls(host);
  if (pc) {
    clear(pc);
    pc.appendChild(chip('⧉ VERIFY', null, function (ev) {
      TDC.copy(ST.verifyCommand);
      var b = ev.currentTarget;
      var was = b.firstChild.nodeValue;
      b.firstChild.nodeValue = 'COPIED';
      global.setTimeout(function () { b.firstChild.nodeValue = was; }, 900);
    }, { title: 'copy: ' + ST.verifyCommand }));
  }

  readoutFit(host,
    [count(I.ok) + ' ok' + DOT + count(I.fail) + (I.fail === 1 ? ' exception' : ' exceptions') +
       DOT + (ST.chain.ok ? 'chain intact' : 'CHAIN BROKEN'),
     count(I.ok) + ' ok' + DOT + count(I.fail) + (I.fail === 1 ? ' exception' : ' exceptions'),
     count(I.ok) + '/' + count(I.n)],
    count(I.n) + ' integrity events' + DOT + count(I.ok) + ' ok' + DOT + count(I.fail) +
      ' exception' + DOT + (ST.chain.ok ? 'chain intact' : 'chain broken') + DOT + (ST.chain.msg || ''));

  var vh = viewHost(host, 'integrity');
  var b = clear(vh.el);

  /* the strip.  The `ok` class is the only place on this page that can be
     green, and #p-integrity .cell.ok in styles.css is what paints it. */
  var strip = AP(b, E('div', 'strip'));
  attr(strip, 'role', 'img');
  attr(strip, 'aria-label', I.n + ' integrity events, ' + I.ok + ' ok, ' + I.fail + ' exception');
  I.cells.forEach(function (c) {
    var cell = E('i', 'cell ' + (c.ok ? 'ok' : 'bad'));
    attr(cell, 'data-k', c.k);
    attr(cell, 'data-i', c.i);
    if (selIs(S, 'integrity', c.k)) attr(cell, 'data-sel', '1');
    if (S && S.cur != null && c.i === S.cur) cell.className += ' cur';
    cell.title = fmt.ts(c.t, 'full') + DOT + (c.ok ? 'ok' : 'EXCEPTION' + (c.reason ? ': ' + c.reason : ''));
    strip.appendChild(cell);
  });
  strip.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var k = t.getAttribute('data-k');
    if (k === null) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    select('integrity', parseInt(k, 10));
    if (isFinite(i) && i >= 0) TDC.cursor.lock(i, 'p-integrity');
  });
  strip.addEventListener('pointermove', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    if (isFinite(i) && i >= 0) TDC.cursor.set(i, 'p-integrity');
  });
  strip.addEventListener('pointerleave', function () { TDC.cursor.set(null, 'p-integrity'); });

  /* the verification line — one row, because the body is 61px at 1440x900 */
  var r1 = AP(b, E('div', 'row'));
  r1.appendChild(E('span', (ST.chain.ok ? 'c-ink' : 'c-breach') + ' nowrap',
    ST.chain.ok ? 'CHAIN INTACT' : 'CHAIN BROKEN'));
  r1.title = ST.chain.msg || '';
  r1.appendChild(E('span', 'c-faint nowrap', count(ST.chain.entries) + ' entries'));
  var fail0 = I.failures.length ? I.failures[0] : null;
  if (fail0) {
    r1.appendChild(E('span', 'c-breach trunc',
      count(I.fail) + (I.fail === 1 ? ' exception · ' : ' exceptions · ') +
      fmt.ts(fail0.t, 'md') + ' ' + fmt.ts(fail0.t, 'hm')));
  } else {
    r1.appendChild(E('span', 'c-soft trunc', 'CLAIMS ' + count(CL.n) + '/' + count(CL.total || CL.n) +
      ' · ' + count(CL.passing) + ' reconcile'));
  }

  var r2 = AP(b, E('div', 'row'));
  var tbtn = E('button', 'chip');
  tbtn.type = 'button';
  tbtn.textContent = 'TESTS ' + count(V.test_defs) + '/' + count(V.tests_collected);
  tbtn.title = 'why ' + V.test_defs + ' test functions collect as ' + V.tests_collected + ' cases — opens the judge note';
  tbtn.addEventListener('click', function () { tdset({ judge: !(S && S.judge) }); });
  r2.appendChild(tbtn);
  r2.appendChild(E('span', 'c-faint nowrap', count(V.devlog) + ' devlog'));
  if (fail0) {
    /* the one thing a judge must read: what the exception actually said */
    r2.appendChild(E('span', 'trunc', fail0.reason || 'no reason journalled'));
    r2.title = fmt.ts(fail0.t, 'full') + ' — ' + (fail0.reason || '');
    r2.className = 'row act';
    r2.addEventListener('click', function () { select('integrity', fail0.k); });
  } else {
    r2.appendChild(E('span', 'num c-soft trunc', 'CLAIMS ' + count(CL.n) + '/' + count(CL.total || CL.n) +
      ' · ' + count(CL.passing) + ' reconcile'));
  }

  /* every further exception, when there is more than one, keeps its own row */
  if (I.failures.length > 1) {
    I.failures.slice(1).forEach(function (f) {
      b.appendChild(row('EXCEPTION', fmt.ts(f.t, 'md') + ' ' + fmt.ts(f.t, 'hm'), {
        note: f.reason,
        valCls: 'c-ink',
        title: f.reason,
        click: function () { select('integrity', f.k); }
      }));
    });
  }

  /* §7.8 — the hash chain and its verify command live here */
  var jn = AP(b, E('div', 'jn'));
  jn.appendChild(E('b', null, 'JUDGE NOTE · the chain, and the two test counts. '));
  jn.appendChild(doc.createTextNode(
    'Every journal line carries the SHA-256 of the line before it; there is no update path and no delete path in the codebase, ' +
    'so a changed number breaks the chain at that line and every line after it. Verify it with ' + ST.verifyCommand + '. ' +
    'The two test counts are different quantities: ' + V.test_defs + ' is the number of `def test_` functions in the tree, ' +
    V.tests_collected + ' is the number of cases pytest collects, because a parametrised function collects once per parameter set. ' +
    'Neither is a count of assertions, and neither is quoted as one.'));

  provenance(host,
    'series.integrity ' + count(I.n) + DOT +
    'verification.chain_ok / journal_entries / test_defs / tests_collected / devlog' + DOT +
    'replay is not published: verification.replay');
}

/* ===========================================================================
   6 · D3 · CLOSED TRADES
   Three modes over six trades.  No rolling statistic is drawn at any n.
   =========================================================================== */

function drawTradesWaterfall(ctx, D, S) {
  var T = D.trades;
  /* seven bars in 341px is a 48px band; an 8-character id renders 50px wide at
     the size styles.css imposes, so the label shrinks with the band and the
     full id stays in the bar's title. */
  var wide = (ctx.iw / (T.waterfall.length + 1)) >= 58;
  var items = T.waterfall.map(function (w) {
    return { id: w.id, label: wide ? short8(w.id) : fmt.short(w.id, 6), v: w.v };
  });
  var wf = TDC.waterfall(ctx, {
    items: items,
    total: { id: '__total', label: 'REALIZED', v: T.total },
    labelH: 12,
    selId: (S && S.sel && S.sel.type === 'trade') ? S.sel.id : null,
    onBar: function (s) { if (s.id !== '__total') select('trade', s.id); }
  });
  if (S && S.sel && S.sel.type === 'trade') {
    TDC.dim(ctx, function (k) { return k === S.sel.id || k === '__total'; });
  }
  return wf;
}

function drawTradesBars(ctx, D, S, field) {
  var C = TDC.C, T = D.trades;
  var rows = T.rows;
  var vals = rows.map(function (r) { return r[field]; }).filter(isNum);
  if (!vals.length) return;
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  var x = ctx.setX(TDC.scaleOrdinal({ n: rows.length, range: [0, ctx.iw], padOuter: ctx.iw / (rows.length * 2) }));
  var y = ctx.setY(TDC.scaleLinear({
    domain: [Math.min(lo, 0), Math.max(hi, 0)], range: [ctx.ih - 12, 0], nice: true, zero: true
  }));
  var f = field === 'r'
    ? function (v) { return fmt.sgn(v, 2) + 'R'; }
    : function (v) { return fmt.dur(v); };

  TDC.axisY(ctx, { scale: y, ticks: 3, format: f });

  var bars = rows.map(function (r, i) {
    return {
      i: i, v: r[field], key: r.id,
      sel: selIs(S, 'trade', r.id),
      title: short8(r.id) + DOT + r.kind + DOT + f(r[field]) + DOT + money(r.pnl) +
             ' on ' + plain(r.max_loss) + ' max loss'
    };
  });
  TDC.barsV(ctx, {
    bars: bars, width: Math.max(6, x.band * 0.5), color: C.ink, opacity: 0.62,
    onBar: function (b) { select('trade', b.key); }
  });
  /* the value on each bar, and the id under it */
  rows.forEach(function (r, i) {
    if (!isNum(r[field])) return;
    var X = x(i), Y = y(r[field]), base = y(0);
    ctx.add('fg', 'text', {
      x: X.toFixed(2), y: (Math.min(Y, base) - 3).toFixed(2), 'text-anchor': 'middle',
      fill: TDC.C.soft, 'font-size': K.fs.micro
    }, f(r[field]));
    ctx.add('fg', 'text', {
      x: X.toFixed(2), y: (ctx.ih - 2).toFixed(2), 'text-anchor': 'middle',
      fill: TDC.C.faint, 'font-size': K.fs.micro
    }, short8(r.id));
  });
  if (S && S.sel && S.sel.type === 'trade') TDC.dim(ctx, function (k) { return k === S.sel.id; });
}

function renderTrades(host, D, S) {
  remember(host, renderTrades, D, S);
  var T = D.trades;
  var mode = vget(host, 'mode', 'wf');

  var pc = controls(host);
  if (pc) {
    clear(pc);
    readout(host, '');                       /* controls are measured first */
    segFit(pc, [
      { v: 'wf', label: 'WATERFALL', short: 'WF', title: 'each closed trade against the running realized total' },
      { v: 'r', label: 'R', title: 'pnl / max_loss — the only honest way to compare a ' +
        plain(T.rows.length ? Math.min.apply(null, T.rows.map(function (r) { return r.max_loss; })) : 0, 0) +
        ' risk with an ' + plain(T.rows.length ? Math.max.apply(null, T.rows.map(function (r) { return r.max_loss; })) : 0, 0) + ' risk' },
      { v: 'hours', label: 'HOURS', short: 'HRS', title: 'holding period per trade' }
    ], mode, function (nv) { local(host, 'mode', nv); });
  }

  if (!T.n) {
    readout(host, DASH);
    clear(host).appendChild(notpub('trades[]', 'no closed trade is published', 'tools/site_data.py'));
    provenance(host, 'trades[]');
    return;
  }

  /* readout: the win count as dots, never a curve */
  readoutFit(host,
    [' ' + T.wins + ' of ' + T.n + DOT + money(T.total) + DOT + fmt.dur(T.medianHours) + ' med',
     ' ' + T.wins + ' of ' + T.n + DOT + money(T.total),
     ' ' + T.wins + '/' + T.n + ' ' + money(T.total, 0),
     ' ' + T.wins + '/' + T.n],
    T.wins + ' of ' + T.n + ' closed up' + DOT + 'realized ' + money(T.total) +
      DOT + 'median hold ' + fmt.dur(T.medianHours) + DOT + T.sampleNote,
    function () { return dots(T.winDots.map(function (w) { return !!w; })); });

  var ch = chartHost(host, 'trades-' + mode);
  TDC.mount(ch, {
    pad: { t: 12, r: 8, b: 14, l: 40 },
    label: 'six closed trades, ' + (mode === 'wf' ? 'as a waterfall summing to the realized total' :
      mode === 'r' ? 'by R multiple' : 'by holding hours'),
    draw: function (ctx) {
      if (mode === 'wf') drawTradesWaterfall(ctx, D, S);
      else drawTradesBars(ctx, D, S, mode === 'r' ? 'r' : 'hours');
    }
  });

  provenance(host,
    'trades[' + T.n + ']' + DOT +
    'sum ' + money(T.total) + (T.reconciles ? ' = book.realized' : ' ≠ book.realized ' + money(T.realized)) + DOT +
    'avg win ' + money(T.avgWin) + ' / avg loss ' + money(T.avgLoss) + DOT +
    T.sampleNote);
}

/* ===========================================================================
   7 · D4 · DECK — five sub-views behind one segmented control
   =========================================================================== */

var DECK_VIEWS = [
  { v: 'strikes', label: 'STRIKES', short: 'STRIKE' },
  { v: 'paths', label: 'PATHS', short: 'PATH' },
  { v: 'funnel', label: 'FUNNEL', short: 'FUNL' },
  { v: 'params', label: 'PARAMS', short: 'PARAM' },
  { v: 'claims', label: 'CLAIMS', short: 'CLAIM' }
];

/* ---- STRIKES ------------------------------------------------------------- */

function drawStrikes(ctx, D, S) {
  var C = TDC.C;
  var groups = D.strikes.byUnderlying;
  if (!groups.length) return;
  var laneH = ctx.ih / groups.length;

  groups.forEach(function (g, gi) {
    var top = gi * laneH;
    var mid = top + laneH * 0.56;
    var vals = [];
    g.legs.forEach(function (l) { if (isNum(l.strike)) vals.push(l.strike); });
    if (isNum(g.spot)) vals.push(g.spot);
    if (g.shield) { vals.push(g.shield.lo, g.shield.hi); }
    if (vals.length < 2) return;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var padV = Math.max((hi - lo) * 0.08, 1);
    var x = TDC.scaleLinear({ domain: [lo - padV, hi + padV], range: [0, ctx.iw], nice: false });

    /* the event shield, from params.events.event_shield_sigmas and ATM IV */
    if (g.shield) {
      ctx.add('bg', 'rect', {
        x: x(g.shield.lo).toFixed(2), y: (mid - laneH * 0.34).toFixed(2),
        width: Math.max(1, x(g.shield.hi) - x(g.shield.lo)).toFixed(2),
        height: (laneH * 0.68).toFixed(2),
        fill: C.gate, 'fill-opacity': 0.09
      });
      [g.shield.lo, g.shield.hi].forEach(function (v, k) {
        ctx.add('bg', 'rect', {
          x: (x(v) - 0.5).toFixed(2), y: (mid - laneH * 0.34).toFixed(2),
          width: 1, height: (laneH * 0.68).toFixed(2), fill: C.gate, 'fill-opacity': 0.5
        });
        ctx.add('fg', 'text', {
          x: (x(v) + (k ? -2 : 2)).toFixed(2), y: (mid + laneH * 0.34).toFixed(2),
          'text-anchor': k ? 'end' : 'start', fill: C.gate, 'font-size': K.fs.micro
        }, (k ? '+' : '−') + nm(g.shield.sigmas, 1) + SIG + ' ' + nm(v, 0));
      });
    }

    /* the axis the legs hang from */
    ctx.add('series', 'rect', { x: 0, y: mid.toFixed(2), width: ctx.iw, height: 1, fill: C.rule });

    /* spot */
    if (isNum(g.spot)) {
      ctx.add('series', 'rect', {
        x: (x(g.spot) - 0.5).toFixed(2), y: (mid - laneH * 0.40).toFixed(2),
        width: 1, height: (laneH * 0.80).toFixed(2), fill: C.ink, 'fill-opacity': 0.85
      });
      ctx.add('fg', 'text', {
        x: (x(g.spot) + 3).toFixed(2), y: (mid - laneH * 0.30).toFixed(2),
        'text-anchor': x(g.spot) > ctx.iw - 44 ? 'end' : 'start',
        fill: C.ink, 'font-size': K.fs.micro
      }, nm(g.spot, 2));
    }

    /* the legs: long above the line, short below it */
    var stackUp = {}, stackDn = {};
    g.legs.forEach(function (l) {
      if (!isNum(l.strike)) return;
      var isShort = l.qty != null && l.qty < 0;
      var key = Math.round(x(l.strike));
      var n = isShort ? (stackDn[key] = (stackDn[key] || 0) + 1) : (stackUp[key] = (stackUp[key] || 0) + 1);
      var h = Math.max(5, laneH * 0.20);
      var y = isShort ? (mid + 2 + (n - 1) * (h + 1)) : (mid - 2 - h - (n - 1) * (h + 1));
      var r = ctx.add('series', 'rect', {
        x: (x(l.strike) - 1.25).toFixed(2), y: y.toFixed(2), width: 2.5, height: h.toFixed(2),
        fill: isShort ? C.soft : C.ink, 'fill-opacity': 0.92,
        'data-key': l.symbol, 'data-sel': selIs(S, 'leg', l.symbol) ? '1' : null
      });
      r.style.cursor = 'pointer';
      r.appendChild(TDC.node('title', null,
        l.symbol + '\n' + (isShort ? 'SHORT ' : 'LONG ') + fmt.sgn(l.qty, 0) +
        DOT + 'strike ' + nm(l.strike, 0) + DOT + 'entry ' + nm(l.entry, 2) +
        (l.dte == null ? '' : DOT + nm(l.dte, 1) + ' DTE') +
        '\n' + short8(l.sid) + DOT + l.kind + DOT + l.status));
      r.addEventListener('click', function () { select('leg', l.symbol); });
    });

    /* the extremes, printed */
    var range = nm(g.strikeMin, 0) + ' – ' + nm(g.strikeMax, 0);
    var head = g.underlying + DOT + g.legCount + ' legs' + DOT + g.structures.length + ' structures' +
      (g.shield ? '' : (g.shieldMissing ? DOT + 'no shield: ' + g.shieldMissing : ''));
    var rn = ctx.add('fg', 'text', {
      x: ctx.iw, y: (top + 8).toFixed(2), 'text-anchor': 'end', fill: C.faint, 'font-size': K.fs.micro
    }, range);
    var rw = 0;
    try { rw = rn.getComputedTextLength(); } catch (e1) { rw = tw(range, K.fs.axis); }
    var ht = ctx.add('fg', 'text', { x: 0, y: (top + 8).toFixed(2), fill: C.faint, 'font-size': K.fs.micro });
    clampText(ht, head, ctx.iw - rw - 8);
    ht.appendChild(TDC.node('title', null, head));
  });

  clampText(ctx.add('fg', 'text', {
    x: 0, y: (ctx.ih - 1).toFixed(2), fill: TDC.C.faint, 'font-size': K.fs.micro
  }), 'long above the line · short below · band = ' +
     (D.strikes.sigmas == null ? 'event shield' : PM + nm(D.strikes.sigmas, 1) + SIG + ' event shield'),
     ctx.iw);
}

function drawDte(ctx, D, S) {
  var C = TDC.C;
  var rows = D.strikes.dte.slice().sort(function (a, b) {
    if (a.dte == null) return 1;
    if (b.dte == null) return -1;
    return a.dte - b.dte;
  });
  if (!rows.length) return;
  var labelW = 66;
  var maxD = 0;
  rows.forEach(function (r) { if (isNum(r.dte)) maxD = Math.max(maxD, r.dte); });
  maxD = Math.max(maxD, D.strikes.minEntryDte || 0, D.strikes.timeStopDte || 0) + 2;
  var x = TDC.scaleLinear({ domain: [0, maxD], range: [labelW, ctx.iw], nice: false });
  var rowH = ctx.ih / rows.length;

  [[D.strikes.timeStopDte, 'time stop ' + nm(D.strikes.timeStopDte, 0) + 'd', C.gate],
   [D.strikes.minEntryDte, 'min entry ' + nm(D.strikes.minEntryDte, 0) + 'd', C.faint]
  ].forEach(function (t, ti) {
    if (t[0] == null) return;
    ctx.add('bg', 'rect', { x: (x(t[0]) - 0.5).toFixed(2), y: 0, width: 1, height: ctx.ih, fill: t[2], 'fill-opacity': 0.7 });
    /* the two rules can be four days apart on a 300px axis: stagger the labels
       rather than overprint them */
    clampText(ctx.add('fg', 'text', {
      x: (x(t[0]) + 3).toFixed(2), y: 8 + ti * 11, fill: t[2], 'font-size': K.fs.micro
    }), t[1], ctx.iw - x(t[0]) - 4);
  });

  rows.forEach(function (r, j) {
    var y = j * rowH, h = Math.max(4, rowH * 0.5), my = y + rowH / 2 - h / 2;
    ctx.add('fg', 'text', {
      x: 0, y: (y + rowH / 2 + 3).toFixed(2), fill: selIs(S, 'structure', r.id) ? C.sel : C.faint,
      'font-size': K.fs.micro
    }, short8(r.id));
    if (!isNum(r.dte)) {
      ctx.add('fg', 'text', { x: labelW + 4, y: (y + rowH / 2 + 3).toFixed(2), fill: C.faint, 'font-size': K.fs.micro },
        'no expiry published');
      return;
    }
    var open = r.status === 'open';
    var bar = ctx.add('series', 'rect', {
      x: x(0).toFixed(2), y: my.toFixed(2),
      width: Math.max(1, x(r.dte) - x(0)).toFixed(2), height: h.toFixed(2),
      fill: open ? C.ink : C.soft, 'fill-opacity': open ? 0.8 : 0.4,
      'data-key': r.id, 'data-sel': selIs(S, 'structure', r.id) ? '1' : null
    });
    bar.style.cursor = 'pointer';
    bar.appendChild(TDC.node('title', null, short8(r.id) + DOT + r.kind + DOT + r.status +
      DOT + nm(r.dte, 1) + ' DTE' + DOT + 'expiry ' + (r.expiry || DASH)));
    bar.addEventListener('click', function () { select('structure', r.id); });
    ctx.add('fg', 'text', {
      x: (x(r.dte) + 3).toFixed(2), y: (y + rowH / 2 + 3).toFixed(2),
      fill: C.soft, 'font-size': K.fs.micro
    }, nm(r.dte, 0) + 'd');
  });
}

function deckStrikes(host, D, S) {
  var sub = vget(host, 'sub', 'strikes');
  var g0 = D.strikes.byUnderlying[0] || null;
  readoutFit(host,
    sub === 'dte'
      ? [count(D.strikes.dte.length) + ' structures' + DOT + 'stop ' + nm(D.strikes.timeStopDte, 0) + 'd',
         'stop ' + nm(D.strikes.timeStopDte, 0) + 'd',
         nm(D.strikes.timeStopDte, 0) + 'd']
      : [(g0 ? g0.underlying + ' ' + nm(g0.spot, 2) + DOT : '') + count(D.strikes.legCount) + ' legs',
         count(D.strikes.legCount) + ' legs',
         count(D.strikes.legCount)],
    sub === 'dte'
      ? (count(D.strikes.dte.length) + ' structures' + DOT + 'time stop ' + nm(D.strikes.timeStopDte, 0) +
         'd' + DOT + 'min entry ' + nm(D.strikes.minEntryDte, 0) + 'd')
      : ((g0 ? g0.underlying + ' spot ' + nm(g0.spot, 2) : DASH) + DOT +
         count(D.strikes.legCount) + ' legs over ' + count(D.strikes.byUnderlying.length) + ' underlyings'));

  var ch = chartHost(host, 'deck-' + sub);
  TDC.mount(ch, {
    pad: { t: 4, r: 8, b: 12, l: 8 },
    label: sub === 'dte' ? 'days to expiry per structure against the time stop'
      : 'strike ladder per underlying with the event shield band',
    draw: function (ctx) { if (sub === 'dte') drawDte(ctx, D, S); else drawStrikes(ctx, D, S); }
  });

  provenance(host, sub === 'dte'
    ? ('positions[].legs[].symbol' + DOT + 'params.management.time_stop_dte ' + nm(D.strikes.timeStopDte, 0) +
       ' / min_entry_dte ' + nm(D.strikes.minEntryDte, 0) + DOT + 'DTE measured at ' + fmt.ts(D.strikes.asof, 'md'))
    : ('positions[].legs[] ' + count(D.strikes.legCount) + ' legs' + DOT +
       'spot ' + (g0 && g0.spotSrc ? g0.spotSrc : 'not published') + DOT +
       'shield = params.events.event_shield_sigmas ' + TIMES + ' ATM IV ' + TIMES + ' sqrt(dte/365)'));
}

/* ---- PATHS --------------------------------------------------------------- */

function deckPaths(host, D, S) {
  var P = D.paths;
  readoutFit(host,
    [count(P.n) + ' structures' + DOT + count(P.points) + ' points',
     count(P.n) + DOT + count(P.points) + ' pts',
     count(P.points) + ' pts',
     count(P.n) + '/' + count(P.points)],
    count(P.points) + ' manage points over ' + count(P.n) + ' structures' + DOT + P.valueMeaning);

  var vh = viewHost(host, 'paths');
  var b = clear(vh.el);

  if (!P.n) {
    b.appendChild(notpub('series.manage', 'no structure carries a manage stream', 'tools/site_data.py'));
    provenance(host, 'series.manage');
    return;
  }

  var cap = AP(b, E('div', 'row'));
  cap.appendChild(E('span', 'lab', 'EST. P&L PATH'));
  cap.appendChild(E('span', 'c-faint trunc', P.valueMeaning + ' — not a mark-to-market'));
  cap.appendChild(E('span', 'num c-soft', count(P.points) + ' pts'));

  var tiles = AP(b, E('div', 'tiles'));
  P.cards.forEach(function (c) {
    var tile = AP(tiles, E('div', 'tile'));
    if (selIs(S, 'structure', c.sid)) attr(tile, 'data-bound', '1');
    tile.title = short8(c.sid) + DOT + (c.kind || 'structure') + DOT + c.n + ' manage points' +
      '\nvalue = ' + P.valueMeaning + (c.exitRule ? '\nexit: ' + c.exitRule : '') +
      (c.realizedPnl != null ? '\nrealized ' + money(c.realizedPnl) : '');
    var k = AP(tile, E('span', 'k'));
    k.textContent = short8(c.sid) + ' · ' + (c.kind || '?');
    var v = AP(tile, E('span', 'v'));
    v.textContent = (c.last && c.last.p != null ? money(c.last.p, 0) : DASH) +
      (c.closes ? ' ○' : '');
    var sp = AP(tile, E('span', 'spark'));
    TDC.spark(sp, {
      pts: c.line, w: 150, h: 14, color: TDC.C.ink, zero: true,
      mark: c.close ? 'close' : 'last', markColor: TDC.C.gate,
      title: c.n + ' points' + (c.exitRule ? DOT + c.exitRule : '')
    });
    tile.addEventListener('click', function () { select('structure', c.sid); });
  });

  var exits = P.exitRules.length;
  var cap2 = AP(b, E('div', 'row'));
  cap2.appendChild(E('span', 'lab', 'EXITS'));
  cap2.appendChild(E('span', 'c-faint trunc', exits
    ? P.exitRules.map(function (e) { return short8(e.sid) + ': ' + e.rule; }).join(' · ')
    : 'no close is recorded in the manage stream'));

  provenance(host,
    'series.manage[sid][] ' + count(P.points) + ' points over ' + count(P.n) + ' structures' + DOT +
    'value field .p = ' + P.valueMeaning + DOT + P.perStructureMarksReason);
}

/* ---- FUNNEL -------------------------------------------------------------- */

function deckFunnel(host, D, S) {
  var F = D.funnel;
  var st = F.stages.filter(function (s) { return s.n != null; });
  readoutFit(host,
    st.length ? [count(st[0].n) + ' ticks ' + ARR + ' ' + count(st[st.length - 1].n) + ' open',
                 count(st[0].n) + ' ' + ARR + ' ' + count(st[st.length - 1].n)] : [DASH],
    F.stages.map(function (x) { return x.label + ' ' + count(x.n); }).join(DOT));

  var vh = viewHost(host, 'funnel');
  var b = clear(vh.el);

  var f1 = AP(b, E('div', 'fun'));
  F.stages.forEach(function (s, i) {
    if (i) f1.appendChild(E('span', 'arrow', ARR));
    var n = AP(f1, E('span', 'node'));
    if (s.n == null) {
      n.appendChild(notpubInline(s.src));
    } else {
      n.appendChild(E('span', 'k', s.label));
      n.appendChild(doc.createTextNode(count(s.n)));
    }
    n.title = s.label + DOT + s.src;
    n.style.cursor = 'pointer';
    n.addEventListener('click', function () {
      if (s.key === 'gateEvals' || s.key === 'passed') tdset({ tab: 'gates' });
      else if (s.key === 'meetings') tdset({ tab: 'desk' });
      else if (s.key === 'filled' || s.key === 'open') tdset({ tab: 'positions' });
      else tdset({ tab: 'all' });
    });
  });

  var lab = AP(b, E('div', 'row'));
  lab.appendChild(E('span', 'lab', 'LEAKAGE'));
  lab.appendChild(E('span', 'c-faint trunc', 'every tick that produced no entry, by the reason journalled for it'));

  var f2 = AP(b, E('div', 'fun'));
  F.leaks.forEach(function (l) {
    var n = AP(f2, E('span', 'node leak'));
    n.appendChild(E('span', 'k', l.label));
    n.appendChild(doc.createTextNode(count(l.n)));
    n.title = l.label + DOT + l.src;
    n.style.cursor = 'pointer';
    n.addEventListener('click', function () { tdset({ tab: 'refusals', kind: l.key }); });
  });

  /* the three tick counts, stated where the funnel's first denominator is */
  var den = F.denominators;
  var cav = AP(b, E('div', 'caveat'));
  cav.appendChild(E('b', null, 'CAVEAT · three tick counts, and they are not interchangeable. '));
  cav.appendChild(doc.createTextNode(
    'counts.ticks reports ' + count(den.ticksReported) + '; series.ticks carries ' + count(den.tickStart) +
    ' tick_start rows; the shared axis clusters every timestamp in the export into ' + count(den.spineTicks) +
    ' ticks, because rows inside one 300-second cycle are one tick. The funnel is drawn on the journal counts, ' +
    'the charts on the clustered axis, and ' + den.note + '.'));

  provenance(host,
    F.stages.map(function (s) { return s.src; }).slice(0, 3).join(DOT) + DOT +
    'leaks from refusals.by_kind' + DOT + 'denominators: ' + den.note);
}

/* ---- PARAMS -------------------------------------------------------------- */

function deckParams(host, D, S) {
  var P = D.params;
  var vh = viewHost(host, 'params');
  var el = vh.el;
  var input, tblBox;

  if (vh.fresh) {
    var bar = AP(el, E('div', 'row'));
    var srch = AP(bar, E('div', 'srch'));
    input = AP(srch, E('input', 'inp'));
    attr(input, 'type', 'search');
    attr(input, 'placeholder', 'search params…');
    attr(input, 'data-q', '1');
    input.addEventListener('input', function () { repaint(host); });
    tblBox = AP(el, E('div'));
    attr(tblBox, 'data-tbl', '1');
  } else {
    input = el.querySelector('[data-q]');
    tblBox = el.querySelector('[data-tbl]');
  }

  var q = (input && input.value ? input.value : '').toLowerCase();
  var rows = P.rows.filter(function (r) {
    if (!q) return true;
    return (r.path + ' ' + String(r.value) + ' ' + r.gates.join(' ') +
            ' ' + r.panels.map(function (p) { return PANEL_LABEL[p] || p; }).join(' ')).toLowerCase().indexOf(q) >= 0;
  });

  readoutFit(host,
    [count(rows.length) + (q ? ' of ' + count(P.n) : '') + ' keys in ' + count(P.sections.length) + ' sections',
     count(rows.length) + (q ? '/' + count(P.n) : '') + ' keys',
     count(rows.length)],
    count(P.n) + ' published config keys in ' + count(P.sections.length) + ' sections');

  clear(tblBox).appendChild(table([
    { k: 'path', label: 'KEY', cls: 'id', get: function (r) { return r.path; } },
    { k: 'value', label: 'VALUE', num: true, get: function (r) {
        var v = r.value;
        if (v === null || v === undefined) return DASH;
        if (Array.isArray(v)) return v.join(' ');
        if (typeof v === 'number') return nm(v, (Math.abs(v) < 1 && v !== 0) ? 4 : 2);
        return String(v);
      } },
    { k: 'governs', label: 'GOVERNS', get: function (r) {
        var s = E('span');
        r.gates.forEach(function (g) { s.appendChild(badge(g, 'code', D.gates.defById[g] ? D.gates.defById[g].what : g)); });
        r.panels.forEach(function (p) { s.appendChild(badge(PANEL_LABEL[p] || p, 'data', 'drawn on panel ' + p)); });
        if (!r.gates.length && !r.panels.length) s.appendChild(E('span', 'c-faint', DASH));
        return s;
      } }
  ], rows, {
    onRow: function (r) { select('param', r.path); },
    sel: function (r) { return selIs(S, 'param', r.path); },
    rowTitle: function (r) {
      return r.path + ' = ' + String(r.value) +
        (r.gates.length ? '\ngates: ' + r.gates.join(', ') : '') +
        (r.panels.length ? '\ndrawn on: ' + r.panels.map(function (p) { return PANEL_LABEL[p] || p; }).join(', ') : '');
    }
  }));

  provenance(host,
    'params ' + count(P.n) + ' keys in ' + count(P.sections.length) + ' sections' + DOT +
    'GOVERNS from gate_defs[].params' + DOT + 'static reference only: no panel is redrawn from here');
}

/* ---- CLAIMS -------------------------------------------------------------- */

function deckClaims(host, D, S) {
  var CL = D.claims;
  readoutFit(host,
    [count(CL.n) + ' claims' + DOT + count(CL.passing) + ' reconcile',
     count(CL.n) + DOT + count(CL.passing) + ' ✓' + (CL.failing ? DOT + count(CL.failing) + ' ✕' : ''),
     count(CL.passing) + '/' + count(CL.n)],
    count(CL.n) + ' published claims' + DOT + count(CL.passing) + ' reconcile against the series' +
      DOT + count(CL.failing) + ' mismatch' + DOT + count(CL.unverifiable) + ' not derivable from this export');

  var vh = viewHost(host, 'claims');
  var b = clear(vh.el);

  if (!CL.n) {
    b.appendChild(notpub('verification.claims[]', 'no claim is published', 'tools/site_data.py'));
    provenance(host, 'verification.claims[]');
    return;
  }

  b.appendChild(table([
    { k: 'n', label: '#', cls: 'id', w: '26px' },
    { k: 'name', label: 'CLAIM', get: function (r) { return r.name; } },
    { k: 'value', label: 'VALUE', num: true, get: function (r) { return r.value; } },
    { k: 'check', label: 'CHECK', get: function (r) {
        if (r.check.ok === true) return badge('RECONCILES', 'code', 'independently recomputed here from ' + r.check.src);
        if (r.check.ok === false) return badge('MISMATCH', null, 'this page computes ' + r.check.value + ' from ' + r.check.src);
        return badge('NOT DERIVABLE', 'data',
          'the published export does not carry a complete counter-source for this claim, so no badge is asserted');
      },
      sev: function (r) { return r.check.ok === false ? 'breach' : null; } },
    { k: 'src', label: 'SOURCE', cls: 'id', get: function (r) { return r.src || DASH; } }
  ], CL.rows, {
    onRow: function (r) { select('claim', r.n); },
    onEnter: function (r) { raw(host, r, 'claim ' + r.n + ' ' + r.name); },
    sel: function (r) { return selIs(S, 'claim', r.n); },
    rowTitle: function (r) {
      return r.name + ' = ' + r.value + '\nregenerate: ' + (r.src || 'not published') +
        (r.check.src ? '\nthis page recomputes it from ' + r.check.src + ' and gets ' + r.check.value : '');
    },
    foot: count(CL.n) + ' claims' + DOT + count(CL.passing) + ' reconcile against the published series' + DOT +
          count(CL.failing) + ' mismatch' + DOT + count(CL.unverifiable) + ' not derivable from this export'
  }));

  provenance(host,
    'verification.claims[' + count(CL.n) + ']' + DOT +
    'src published on ' + (CL.srcPublished ? 'every row' : 'some rows') + DOT +
    'CHECK is this page recomputing the claim from the series, not the claim quoting itself');
}

function renderDeck(host, D, S) {
  remember(host, renderDeck, D, S);
  var view = (S && S.deck) || 'strikes';
  var known = false;
  DECK_VIEWS.forEach(function (v) { if (v.v === view) known = true; });
  if (!known) view = 'strikes';

  var pc = controls(host);
  if (pc) {
    clear(pc);
    /* STRIKES carries its own sub-mode: clicking it while it is already the
       live view toggles the strike ladder and the DTE bars, and the label says
       which one is on screen.  A sixth control would not fit in a 357px header
       and would break the five-way `deck=` contract the hash and [ ] rely on. */
    var sub = vget(host, 'sub', 'strikes');
    var items = DECK_VIEWS.map(function (d) {
      if (d.v !== 'strikes') return d;
      return {
        v: 'strikes',
        label: sub === 'dte' ? 'DTE' : 'STRIKES',
        short: sub === 'dte' ? 'DTE' : 'STRIKE',
        title: sub === 'dte'
          ? 'days to expiry per structure — click again for the strike ladder'
          : 'strike ladder per underlying — click again for days to expiry'
      };
    });
    readout(host, '');                       /* controls are measured first */
    segFit(pc, items, view, function (nv) {
      if (nv === 'strikes' && view === 'strikes') { local(host, 'sub', sub === 'dte' ? 'strikes' : 'dte'); return; }
      tdset({ deck: nv });
    });
  }

  if (view === 'strikes') deckStrikes(host, D, S);
  else if (view === 'paths') deckPaths(host, D, S);
  else if (view === 'funnel') deckFunnel(host, D, S);
  else if (view === 'params') deckParams(host, D, S);
  else deckClaims(host, D, S);
}

/* ===========================================================================
   8 · D5 · INSPECTOR — permanent, type-polymorphic, never a modal
   =========================================================================== */

/* --- selection history, kept on the panel element ------------------------- */
function histOf(host) {
  var p = panelOf(host);
  if (!p) return null;
  if (!p.__hist) { p.__hist = []; p.__hi = -1; }
  return p;
}
function sameSel(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && String(a.id) === String(b.id);
}
function pushHist(host, sel) {
  var p = histOf(host);
  if (!p || !sel) return;
  if (sameSel(p.__hist[p.__hi], sel)) return;
  p.__hist = p.__hist.slice(0, p.__hi + 1);
  p.__hist.push({ type: sel.type, id: sel.id });
  if (p.__hist.length > 40) p.__hist.shift();
  p.__hi = p.__hist.length - 1;
}
function stepHist(host, d) {
  var p = histOf(host);
  if (!p) return;
  var ni = p.__hi + d;
  if (ni < 0 || ni >= p.__hist.length) return;
  p.__hi = ni;
  tdset({ sel: { type: p.__hist[ni].type, id: p.__hist[ni].id } });
}

/* --- resolvers ------------------------------------------------------------ */
function blotterByKey(D, key) {
  var all = D.blotter.by.all;
  for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return null;
}
function refusalOf(D, id) {
  var s = String(id);
  var k = s.indexOf(':') >= 0 ? parseInt(s.split(':')[1], 10) : parseInt(s, 10);
  return D.refusals.rows[k] || null;
}
function decisionOf(D, id) {
  var s = String(id);
  if (s.indexOf('dec:') === 0) return blotterByKey(D, s);
  var k = parseInt(s, 10);
  return D.blotter.by.decisions[k] || blotterByKey(D, s);
}

/* --- shared blocks -------------------------------------------------------- */
function stepList(items, onPick) {
  var ol = E('ol', 'steps');
  items.forEach(function (it, i) {
    var li = E('li', 'step');
    attr(li, 'data-out', it.out || 'none');
    li.appendChild(E('span', 'dot'));
    li.appendChild(E('span', 'lab', it.label));
    li.appendChild(E('span', 'trunc', it.text == null ? DASH : it.text));
    if (it.title) li.title = it.title;
    if (it.rec) {
      li.addEventListener('click', function () { onPick(it, i); });
    } else {
      li.style.cursor = 'default';
    }
    ol.appendChild(li);
  });
  return ol;
}

function sectionLabel(text, note) {
  var r = E('div', 'row');
  r.appendChild(E('span', 'lab', text));
  if (note) r.appendChild(E('span', 'c-faint trunc', note));
  return r;
}

/* --- the type renderers --------------------------------------------------- */

function insTick(host, D, S, i) {
  var f = doc.createDocumentFragment();
  var t = D.byTick[i];
  if (!t) {
    f.appendChild(notpub('series[] at tick ' + i, 'the shared axis has ' + D.spine.n + ' ticks', 'derive.js'));
    return f;
  }
  var b = t.books;
  var pairs = [
    ['TICK', (i + 1) + ' of ' + D.spine.n + DOT + fmt.ts(t.t, 'full')],
    ['SESSION', t.day + DOT + 'tick ' + (i - D.spine.days[t.dayIdx].i0 + 1) + ' of ' +
      D.spine.days[t.dayIdx].n + DOT + (t.stamps > 1 ? t.stamps + ' journal stamps in this cluster' : '1 stamp')]
  ];
  D.books.order.forEach(function (key) {
    var p = b[key];
    pairs.push([D.books.byKey[key].label, p && p.v != null
      ? (money(p.v) + (key === 'real' && p.u != null
          ? (DOT + 'u ' + money(p.u) + DOT + 'r ' + money(p.r) + (p.eq != null ? DOT + 'eq ' + plain(p.eq) : ''))
          : ''))
      : null, { cls: 'num ' + (key === 'real' ? 'bk-real' : key === 'shadow_nogates' ? 'bk-nogates' :
        key === 'shadow_nohedge' ? 'bk-nohedge' : 'bk-naive') }]);
  });
  if (t.greeks && (t.greeks.d != null || t.greeks.th != null || t.greeks.vg != null)) {
    pairs.push(['GREEKS', 'Δ ' + fmt.greek(t.greeks.d) + DOT + 'Θ ' + fmt.greek(t.greeks.th) +
      DOT + 'V ' + fmt.greek(t.greeks.vg), { cls: 'num' }]);
  }
  if (t.signal) {
    pairs.push(['SIGNAL', t.signal.sym + DOT + 'spot ' + nm(t.signal.spot, 2) +
      DOT + 'IV ' + fmt.vol(t.signal.iv) + DOT + 'RV ' + fmt.vol(t.signal.rv) +
      DOT + 'VRP ' + nm(t.signal.vrp, 2) + (t.signal.dq ? DOT + t.signal.dq : '')]);
  }
  if (t.desk) {
    pairs.push(['DESK', (t.desk.a || '?') + ' / ' + (t.desk.b || '?') +
      (t.desk.mult != null ? DOT + 'size ' + TIMES + nm(t.desk.mult, 2) : '') +
      (t.desk.veto ? DOT + 'VETO' : '') + (t.desk.dis ? DOT + 'disagreement' : '') +
      (t.desk.dark ? DOT + 'no model reachable' : ''),
      { title: t.desk.why || '' }]);
  }
  pairs.push(['GATES', t.gates.length
    ? (t.gates.length + ' evaluation' + (t.gates.length > 1 ? 's' : '') + DOT +
       t.gates.filter(function (g) { return g.passed; }).length + ' passed')
    : 'none at this tick']);
  if (t.refusals.length) {
    pairs.push(['REFUSALS', t.refusals.map(function (r) { return r.kind + (r.gate ? ' ' + r.gate : ''); }).join(DOT),
      { title: t.refusals.map(function (r) { return r.reason; }).join('\n') }]);
  }
  if (t.integrity) pairs.push(['INTEGRITY', t.integrity.ok ? 'ok' : ('EXCEPTION ' + t.integrity.reason)]);
  if (t.tick) {
    pairs.push(['TICK RECORD', (t.tick.mock ? 'mock' : 'live') + (t.tick.dry ? DOT + 'dry run' : '') +
      (t.tick.dur != null ? DOT + nm(t.tick.dur, 1) + 's' : '') +
      (t.tick.te ? DOT + 'ended ' + fmt.ts(t.tick.te, 'hms') : '')]);
  }
  if (t.derisk) pairs.push(['DERISK', t.derisk.reason || 'derisk window']);
  if (t.quarantine.length) pairs.push(['QUARANTINE', t.quarantine.map(function (q) { return q.book; }).join(', ')]);
  if (t.manage.length) {
    pairs.push(['MANAGE', t.manage.length + ' structure' + (t.manage.length > 1 ? 's' : '') + DOT +
      t.manage.map(function (m) { return short8(m.sid) + ' ' + m.a; }).join(DOT),
      { title: t.manage.map(function (m) { return short8(m.sid) + ' ' + m.a + ' ' + m.w + ' ' + money(m.p); }).join('\n') }]);
  }
  if (t.entries.length) {
    pairs.push(['ENTRIES', t.entries.map(function (e) { return e.dir.toUpperCase() + ' ' + short8(e.id); }).join(DOT)]);
  }
  if (t.reprice.length) {
    pairs.push(['REPRICE', t.reprice.map(function (r) {
      return short8(r.sid) + ' #' + r.attempt + ' ' + nm(r.from, 2) + ' ' + ARR + ' ' + nm(r.to, 2);
    }).join(DOT)]);
  }
  if (t.brokerCheck.length) {
    pairs.push(['BROKER CHECK', t.brokerCheck.map(function (c) {
      return 'store ' + plain(c.store) + ' vs broker ' + plain(c.broker) + DOT + c.diffs + ' diffs';
    }).join(DOT)]);
  }
  f.appendChild(dl(pairs, true));

  if (t.decisions.length) {
    f.appendChild(sectionLabel('JOURNAL AT THIS TICK', count(t.decisions.length) + ' rows'));
    f.appendChild(table([
      { k: 'kind', label: 'KIND', get: function (r) { return TDD.KIND_LABEL[r.kind] || r.kind; },
        sev: function (r) { return TDD.sevOf(r.kind); } },
      { k: 'reason', label: 'REASON', get: function (r) { return r.reason || r.action || ''; } }
    ], t.decisions, {
      onRow: function (r) { raw(host, r.d || r, (TDD.KIND_LABEL[r.kind] || r.kind) + ' ' + fmt.ts(r.t, 'hms')); },
      rowTitle: function (r) { return fmt.ts(r.t, 'full') + '\n' + (r.reason || ''); }
    }));
  }
  return f;
}

function insStructure(host, D, S, id) {
  var f = doc.createDocumentFragment();
  var s = D.structures.byId[String(id)];
  if (!s) { f.appendChild(notpub('positions[] id=' + id, 'no structure in the export carries this id', 'tools/site_data.py')); return f; }

  var card = D.paths.cards.filter(function (c) { return c.sid === s.id; })[0] || null;
  var evals = D.gates.evals.filter(function (e) { return e.sid === s.id; });
  var reprices = D.overlays.reprice.filter(function (r) { return r.sid === s.id; });
  var sig = s.iOpen != null && s.iOpen >= 0 ? D.signal.byTick[s.iOpen] : null;
  var meeting = s.iOpen != null && s.iOpen >= 0 ? D.desk.byTick[s.iOpen] : null;
  var checks = D.recon.brokerChecks.filter(function (c) {
    return arr(c.repaired).some(function (r) { return r && String(r.structure_id || '').indexOf(s.id) === 0; });
  });

  f.appendChild(dl([
    ['ID', s.id, { cls: 'id' }],
    ['KIND', s.kind + DOT + s.sleeve + DOT + s.status],
    ['QTY', s.qty == null ? null : fmt.sgn(s.qty, 0), { cls: 'num' }],
    ['CREDIT', s.credit == null ? null : plain(s.credit, 2), { cls: 'num' }],
    ['MAX LOSS', s.max_loss == null ? null : plain(s.max_loss, 2), { cls: 'num' }],
    ['P&L', s.pnl == null ? null : money(s.pnl) + (s.r != null ? DOT + fmt.sgn(s.r, 2) + 'R' : ''), { cls: 'num' }],
    ['DTE', s.dte == null ? null : nm(s.dte, 1) + ' at ' + fmt.ts(D.strikes.asof, 'md'), { cls: 'num' }],
    ['OPENED', s.opened ? fmt.ts(s.opened, 'full') + DOT + fmt.age(s.opened) : null],
    ['CLOSED', s.closed ? fmt.ts(s.closed, 'full') + DOT + fmt.dur(s.hours) + ' held'
      : (s.hours != null ? 'open ' + fmt.dur(s.hours) : null)]
  ], true));

  f.appendChild(sectionLabel('LEGS', count(s.legCount) + DOT + (s.expiry || '')));
  f.appendChild(table([
    { k: 'symbol', label: 'LEG', cls: 'id' },
    { k: 'qty', label: 'QTY', num: true, get: function (l) { return fmt.sgn(l.qty, 0); } },
    { k: 'strike', label: 'STRIKE', num: true, get: function (l) { return nm(l.strike, 0); } },
    { k: 'entry', label: 'ENTRY', num: true, get: function (l) { return nm(l.entry, 2); } }
  ], s.legs, {
    onRow: function (l) { select('leg', l.symbol); },
    rowTitle: function (l) { return l.symbol + DOT + (l.short ? 'short' : 'long'); }
  }));

  if (card) {
    var sp = E('div', 'row');
    sp.appendChild(E('span', 'lab', 'PATH'));
    var holder = AP(sp, E('span', 'spark'));
    TDC.spark(holder, {
      pts: card.line, w: 130, h: 14, color: TDC.C.ink, zero: true,
      mark: card.close ? 'close' : 'last', markColor: TDC.C.gate
    });
    sp.appendChild(E('span', 'num c-soft', card.n + ' pts'));
    f.appendChild(sp);
    f.appendChild(sectionLabel('', D.paths.valueMeaning));
  }

  /* the lifecycle stepper, keyed by structure_id */
  var steps = [];
  steps.push({
    label: 'SIGNALS', out: sig ? 'pass' : 'none',
    text: sig ? (sig.sym + ' spot ' + nm(sig.spot, 2) + DOT + 'IV ' + fmt.vol(sig.iv) +
      DOT + 'RV ' + fmt.vol(sig.rv) + DOT + 'VRP ' + nm(sig.vrp, 2)) : 'no signal row at the entry tick',
    rec: sig, title: sig ? fmt.ts(sig.t, 'full') : ''
  });
  steps.push({
    label: 'DESK', out: meeting ? (meeting.veto ? 'fail' : (meeting.dis ? 'gate' : 'pass')) : 'none',
    text: meeting ? ((meeting.a || '?') + ' / ' + (meeting.b || '?') +
      (meeting.mult != null ? DOT + 'size ' + TIMES + nm(meeting.mult, 2) : '') +
      (meeting.veto ? DOT + 'VETO' : '') + (meeting.dis ? DOT + 'disagreement' : '') +
      (meeting.dark ? DOT + 'no model reachable' : '')) : 'no meeting at the entry tick',
    rec: meeting, title: meeting ? (meeting.why || '') : ''
  });
  if (evals.length) {
    evals.forEach(function (e) {
      steps.push({
        label: 'GATES', out: e.passed ? 'pass' : 'gate',
        text: e.nPassed + ' of ' + e.nEvaluated + ' passed' +
          (e.passed ? '' : DOT + (e.firstFail || '') + ': ' + (e.fails.length ? e.fails[0].reason : '')),
        rec: e, title: fmt.ts(e.t, 'full') + '\n' + e.fails.map(function (x) { return x.gate + ': ' + x.reason; }).join('\n')
      });
    });
  } else {
    steps.push({ label: 'GATES', out: 'none', text: 'no gate evaluation in the export names this structure' });
  }
  steps.push({
    label: 'ORDER', out: reprices.length ? 'gate' : (s.status === 'unfilled' ? 'fail' : 'pass'),
    text: reprices.length
      ? reprices.map(function (r) { return '#' + r.attempt + ' ' + nm(r.from, 2) + ' ' + ARR + ' ' + nm(r.to, 2); }).join(DOT)
      : (s.status === 'unfilled' ? 'submitted, never filled' : 'filled at ' + nm(s.credit, 2) + ' credit'),
    rec: reprices.length ? reprices : null,
    title: reprices.length ? 'series.reprice' : ''
  });
  steps.push({
    label: 'RECONCILE', out: checks.length ? 'gate' : 'none',
    text: checks.length
      ? checks.map(function (c) { return fmt.ts(c.t, 'hm') + ' store ' + plain(c.store) + ' vs broker ' + plain(c.broker); }).join(DOT)
      : 'no broker_check names this structure',
    rec: checks.length ? checks : null
  });
  steps.push({
    label: 'MANAGE', out: card ? 'pass' : 'none',
    text: card ? (card.n + ' points' + DOT + card.holds + ' holds' + DOT + card.closes + ' close' +
      (card.holdReasons ? DOT + Object.keys(card.holdReasons).join(' / ') : '')) : 'no manage stream',
    rec: card, title: card ? D.paths.valueMeaning : ''
  });
  steps.push({
    label: 'CLOSE', out: s.closed ? 'pass' : 'none',
    text: s.closed
      ? (fmt.ts(s.closed, 'md') + ' ' + fmt.ts(s.closed, 'hm') + DOT + money(s.pnl) +
         (card && card.exitRule ? DOT + card.exitRule : ''))
      : (s.status === 'open' ? 'still open' : s.status),
    rec: s.trade || null, title: card && card.exitRule ? card.exitRule : ''
  });

  f.appendChild(sectionLabel('LIFECYCLE', 'each step opens its journal record'));
  f.appendChild(stepList(steps, function (it) { raw(host, it.rec, it.label + ' ' + short8(s.id)); }));
  return f;
}

function insTrade(host, D, S, id) {
  var f = doc.createDocumentFragment();
  var t = null;
  D.trades.rows.forEach(function (r) { if (r.id === String(id)) t = r; });
  if (!t) { f.appendChild(notpub('trades[] id=' + id, 'no closed trade carries this id', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['ID', t.id, { cls: 'id' }],
    ['KIND', t.kind + DOT + t.sleeve],
    ['P&L', money(t.pnl), { cls: 'num' }],
    ['R MULTIPLE', t.r == null ? null : fmt.sgn(t.r, 2) + 'R', { cls: 'num', title: 'pnl / max_loss' }],
    ['CREDIT', plain(t.credit, 2), { cls: 'num' }],
    ['MAX LOSS', plain(t.max_loss, 2), { cls: 'num' }],
    ['HELD', fmt.dur(t.hours), { cls: 'num' }],
    ['OPENED', fmt.ts(t.opened, 'full')],
    ['CLOSED', fmt.ts(t.closed, 'full') + DOT + fmt.age(t.closed)],
    ['SHARE OF REALIZED', (D.trades.total ? fmt.pct(t.pnl / D.trades.total, 1) : null), { cls: 'num',
      title: 'of ' + money(D.trades.total) + ' realized across ' + D.trades.n + ' closed trades' }]
  ], true));
  if (t.structure) {
    f.appendChild(sectionLabel('STRUCTURE', 'open the full lifecycle'));
    f.appendChild(row('STRUCTURE', short8(t.structure.id), {
      note: t.structure.kind + DOT + t.structure.legCount + ' legs',
      click: function () { select('structure', t.structure.id); }
    }));
  }
  return f;
}

function insGateEval(host, D, S, k) {
  var f = doc.createDocumentFragment();
  var e = D.gates.evals[parseInt(k, 10)];
  if (!e) { f.appendChild(notpub('series.gates[' + k + ']', 'the export carries ' + D.gates.n + ' evaluations', 'tools/site_data.py')); return f; }

  f.appendChild(dl([
    ['EVALUATION', (e.k + 1) + ' of ' + D.gates.n + DOT + fmt.ts(e.t, 'full')],
    ['STRUCTURE', e.sid ? short8(e.sid) : null, { cls: 'id', click: e.sid ? function () { select('structure', e.sid); } : null }],
    ['CANDIDATE', (e.kind || '?') + (e.qty != null ? DOT + 'qty ' + fmt.sgn(e.qty, 0) : '')],
    ['OUTCOME', e.passed ? ('PASSED ' + e.nPassed + ' of ' + e.nEvaluated)
      : ('REFUSED at ' + (e.firstFail || '?') + DOT + e.nPassed + ' of ' + e.nEvaluated + ' passed'),
      { cls: e.passed ? '' : 'c-gate' }],
    ['WORST CASE', e.wc && e.wc.pnl != null
      ? (money(e.wc.pnl) + DOT + 'spot ' + fmt.pctRaw(e.wc.spot_rel * 100, 1) + DOT + e.wc.scenario)
      : null, { cls: 'num', title: 'series.gates[].wc — the whole book repriced over the spot grid' }]
  ], true));

  /* every result, pass and fail alike, with its verbatim reason */
  var failBy = {};
  e.fails.forEach(function (x) { failBy[x.gate] = x.reason; });
  var rows = D.gates.ids.map(function (id) {
    var has = Object.prototype.hasOwnProperty.call(e.r, id);
    return {
      id: id,
      state: !has ? 'not reached' : (e.r[id] ? 'pass' : 'fail'),
      reason: failBy[id] || '',
      def: D.gates.defById[id] || null,
      first: e.firstFail === id
    };
  });
  f.appendChild(sectionLabel('RESULTS', count(e.nEvaluated) + ' of ' + count(D.gates.ids.length) + ' gates reached'));
  f.appendChild(table([
    { k: 'id', label: 'GATE', cls: 'id' },
    { k: 'state', label: '', w: '62px', get: function (r) { return r.state === 'fail' ? (r.first ? 'FAIL ◀' : 'FAIL') : r.state; },
      sev: function (r) { return r.state === 'fail' ? 'gate' : (r.state === 'pass' ? null : 'soft'); } },
    { k: 'reason', label: 'REASON', get: function (r) { return r.reason || (r.def ? r.def.what : ''); } }
  ], rows, {
    onRow: function (r) { select('gate', r.id); },
    rowTitle: function (r) { return r.id + (r.def ? '\n' + r.def.what : '') + (r.reason ? '\n' + r.reason : ''); },
    dim: function (r) { return r.state === 'not reached'; }
  }));

  if (!D.gates.operandsPublished) {
    f.appendChild(notpubFor(D, 'gate_operands', 'series.gates[].d'));
  }
  return f;
}

function insGate(host, D, S, id) {
  var f = doc.createDocumentFragment();
  var st = D.gates.stats[String(id)];
  if (!st) { f.appendChild(notpub('gate ' + id, 'the export carries ' + D.gates.ids.length + ' gate keys', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['GATE', st.id, { cls: 'id' }],
    ['WHAT IT DOES', st.what || null, { cls: 'wrap' }],
    ['PARAMS', st.params.length ? st.params.join(DOT) : null,
      { title: 'gate_defs[].params — the config keys that define this gate' }],
    ['EVALUATED', count(st.evals) + ' of ' + count(D.gates.n) +
      (st.notReached ? DOT + count(st.notReached) + ' not reached' : ''), { cls: 'num' }],
    ['FAILED', ofRate(st.fail, st.evals), { cls: 'num' }],
    ['DECISIVE', count(st.firstFail) + ' refusals name it first', { cls: 'num',
      title: 'a refusal names only the first failing gate; the matrix counts every failure' }]
  ], true));

  if (!st.fail) {
    var d = D.gates.degenerate[st.id];
    var np = E('div', 'notpub');
    np.appendChild(E('b', null, d ? d.note : 'never bound'));
    np.appendChild(E('span', null, 'evaluated ' + count(st.evals) + ' times, failed 0'));
    np.appendChild(E('span', null, 'operands would come from series.gates[].d'));
    f.appendChild(np);
    return f;
  }

  f.appendChild(sectionLabel('EVERY FAILURE', count(st.failures.length) + DOT + 'verbatim reasons'));
  f.appendChild(table([
    { k: 't', label: 'TIME', get: function (r) { return fmt.ts(r.t, 'md') + ' ' + fmt.ts(r.t, 'hm'); } },
    { k: 'sid', label: 'ID', cls: 'id col-structure', get: function (r) { return r.sid ? short8(r.sid) : DASH; } },
    { k: 'reason', label: 'REASON', get: function (r) { return r.reason; },
      sev: function (r) { return r.decisive ? 'gate' : null; } }
  ], st.failures, {
    onRow: function (r) { select('gateeval', r.k); },
    rowTitle: function (r) { return fmt.ts(r.t, 'full') + '\n' + r.reason + (r.decisive ? '\n(decisive: this refusal names it)' : ''); }
  }));
  return f;
}

function insRefusal(host, D, S, id) {
  var f = doc.createDocumentFragment();
  var r = refusalOf(D, id);
  if (!r) { f.appendChild(notpub('series.refusals[' + id + ']', 'the export carries ' + D.refusals.n + ' refusals', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['KIND', TDD.KIND_LABEL[r.kind] || r.kind, { cls: r.kind ? '' : '', title: r.kind }],
    ['WHEN', fmt.ts(r.t, 'full') + DOT + fmt.age(r.t)],
    ['GATE', r.gate || null, { cls: 'id', click: r.gate ? function () { select('gate', r.gate); } : null }],
    ['REASON', r.reason || null, { cls: 'wrap' }],
    ['VRP AT THE TIME', nm(r.vrp, 3), { cls: 'num' }],
    ['TICK', r.i >= 0 ? (r.i + 1) + ' of ' + D.spine.n : null,
      { cls: 'num', click: r.i >= 0 ? function () { TDC.cursor.lock(r.i, 'p-inspector'); } : null }]
  ], true));
  f.appendChild(sectionLabel('SEMANTICS', 'a refusal names only the first failing gate; the matrix counts every failure'));
  return f;
}

function insBlotterRow(host, D, S, key, typeLabel) {
  var f = doc.createDocumentFragment();
  var r = (typeof key === 'string' && key.indexOf(':') > 0) ? blotterByKey(D, key) : decisionOf(D, key);
  if (!r) { f.appendChild(notpub('decisions[' + key + ']', D.blotter.coverage.note, 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['KIND', r.label + (r.kind && r.label !== r.kind ? DOT + r.kind : ''), { cls: '' }],
    ['WHEN', fmt.ts(r.t, 'full') + DOT + fmt.age(r.t)],
    ['ID', r.id || null, { cls: 'id', click: r.id ? function () { select('structure', r.id); } : null }],
    ['ACTION', r.action || null],
    ['REASON', r.reason || null, { cls: 'wrap' }],
    ['P&L', r.pnl == null ? null : money(r.pnl), { cls: 'num' }],
    ['SOURCE', r.src + DOT + r.key, { cls: 'id' }]
  ], true));
  if (r.d) {
    f.appendChild(sectionLabel('RAW RECORD', 'the journal data object, verbatim'));
    var pre = E('div', 'json');
    pre.textContent = safeJson(r.d);
    f.appendChild(pre);
  } else {
    f.appendChild(notpub('decisions[].d', 'this row carries no raw payload in the export', 'tools/site_data.py'));
  }
  return f;
}

function insMeeting(host, D, S, k) {
  var f = doc.createDocumentFragment();
  var m = D.desk.rows[parseInt(k, 10)];
  if (!m) { f.appendChild(notpub('series.desk[' + k + ']', 'the export carries ' + D.desk.n + ' meetings', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['MEETING', (m.k + 1) + ' of ' + D.desk.n + DOT + fmt.ts(m.t, 'full')],
    ['ANALYST', m.a || null],
    ['SECOND OPINION', m.b || null],
    ['OUTCOME', (m.veto ? 'VETO' : (m.dis ? 'DISAGREEMENT' : 'agreed')) +
      (m.dark ? DOT + 'no model reachable' : ''), { cls: m.veto || m.dis ? 'c-gate' : '' }],
    ['SIZE MULTIPLIER', m.mult == null ? null : TIMES + nm(m.mult, 2), { cls: 'num' }],
    ['SEVERITY', m.sev || null],
    ['WHY', m.why || null, { cls: 'wrap' }],
    ['ROLE CALLS', m.rolesOk + ' of ' + m.rolesN + ' answered', { cls: 'num' }]
  ], true));

  if (m.roles.length) {
    f.appendChild(sectionLabel('WHAT THE MODELS RETURNED', 'series.desk[].roles[].txt'));
    m.roles.forEach(function (r) {
      var rr = AP(f, E('div', 'row tall'));
      rr.appendChild(E('span', 'lab', r.role || '?'));
      rr.appendChild(badge(r.provider || '?', 'llm', r.model || ''));
      if (!r.ok) rr.appendChild(E('span', 'c-gate trunc', 'fallback: ' + (r.fallback || 'no reason journalled')));
      else rr.appendChild(E('span', 'c-soft trunc', r.text || '(empty)'));
      rr.title = (r.role || '') + DOT + (r.provider || '') + '/' + (r.model || '') +
        (r.ok ? '' : (DOT + 'FALLBACK: ' + r.fallback)) + '\n' + (r.text || '');
    });
  }
  return f;
}

function insIntegrity(host, D, S, k) {
  var f = doc.createDocumentFragment();
  var c = D.integrity.cells[parseInt(k, 10)];
  if (!c) { f.appendChild(notpub('series.integrity[' + k + ']', 'the export carries ' + D.integrity.n + ' events', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['EVENT', (c.k + 1) + ' of ' + D.integrity.n + DOT + fmt.ts(c.t, 'full')],
    ['RESULT', c.ok ? 'ok' : 'EXCEPTION', { cls: c.ok ? '' : 'c-breach' }],
    ['REASON', c.reason || (c.ok ? 'no exception recorded' : null), { cls: 'wrap' }],
    ['TICK', c.i >= 0 ? (c.i + 1) + ' of ' + D.spine.n : null,
      { cls: 'num', click: c.i >= 0 ? function () { TDC.cursor.lock(c.i, 'p-inspector'); } : null }],
    ['THIS SESSION', D.integrity.perDay[c.day] ? (count(D.integrity.perDay[c.day]) + ' events on ' + c.day) : null, { cls: 'num' }]
  ], true));
  return f;
}

function insClaim(host, D, S, n) {
  var f = doc.createDocumentFragment();
  var c = null;
  D.claims.rows.forEach(function (r) { if (String(r.n) === String(n) || r.name === String(n)) c = r; });
  if (!c) { f.appendChild(notpub('verification.claims[' + n + ']', 'the export carries ' + D.claims.n + ' claims', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['CLAIM', c.n + DOT + c.name],
    ['VALUE', c.value, { cls: 'num' }],
    ['REGENERATE', c.src || null, { cls: 'wrap', title: 'the command that reproduces this figure' }],
    ['THIS PAGE COMPUTES', c.check.value == null ? null : String(c.check.value), { cls: 'num' }],
    ['FROM', c.check.src || null, { cls: 'wrap' }],
    ['RESULT', c.check.ok === true ? 'reconciles' : (c.check.ok === false ? 'MISMATCH' : 'not derivable from this export'),
      { cls: c.check.ok === false ? 'c-breach' : '' }]
  ], true));
  if (c.check.ok == null) {
    f.appendChild(sectionLabel('WHY NO BADGE',
      'the published export does not carry a complete counter-source for this figure, so the page asserts nothing'));
  }
  return f;
}

function insParam(host, D, S, path) {
  var f = doc.createDocumentFragment();
  var p = D.params.byPath[String(path)];
  if (!p) { f.appendChild(notpub('params.' + path, 'no such key in the published config', 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['KEY', p.path, { cls: 'id' }],
    ['VALUE', Array.isArray(p.value) ? p.value.join(', ') : String(p.value), { cls: 'num wrap' }],
    ['SECTION', p.section],
    ['GATES', p.gates.length ? p.gates.join(DOT) : 'no gate cites this key',
      { title: p.gates.map(function (g) { return D.gates.defById[g] ? g + ': ' + D.gates.defById[g].what : g; }).join('\n') }],
    ['DRAWN ON', p.panels.length ? p.panels.map(function (x) { return PANEL_LABEL[x] || x; }).join(DOT) : 'no panel draws it']
  ], true));
  p.gates.forEach(function (g) {
    var st = D.gates.stats[g];
    if (!st) return;
    f.appendChild(row(g, ofRate(st.fail, st.evals), {
      note: st.what, click: function () { select('gate', g); }
    }));
  });
  return f;
}

function insLeg(host, D, S, symbol) {
  var f = doc.createDocumentFragment();
  var found = null, owner = null;
  D.structures.all.forEach(function (s) {
    s.legs.forEach(function (l) { if (l.symbol === String(symbol)) { found = l; owner = s; } });
  });
  if (!found) { f.appendChild(notpub('positions[].legs[] ' + symbol, 'no held leg carries this symbol', 'tools/site_data.py')); return f; }
  var occ = TDD.occ(found.symbol) || {};
  f.appendChild(dl([
    ['LEG', found.symbol, { cls: 'id' }],
    ['UNDERLYING', found.underlying],
    ['RIGHT', found.right === 'P' ? 'PUT' : (found.right === 'C' ? 'CALL' : found.right)],
    ['STRIKE', nm(found.strike, 2), { cls: 'num' }],
    ['QTY', fmt.sgn(found.qty, 0) + DOT + (found.short ? 'short' : 'long'), { cls: 'num' }],
    ['ENTRY', nm(found.entry, 2), { cls: 'num' }],
    ['EXPIRY', found.expiry || (occ.expiry || null)],
    ['DTE', nm(found.dte, 1), { cls: 'num' }],
    ['STRUCTURE', short8(owner.id) + DOT + owner.kind + DOT + owner.status,
      { cls: 'id', click: function () { select('structure', owner.id); } }]
  ], true));
  f.appendChild(sectionLabel('QUOTE WIDTH', 'published for the book, not per leg'));
  f.appendChild(row('BOOK QUOTES', nm(D.recon.quotes.narrowest_c, 1) + 'c / ' +
    nm(D.recon.quotes.median_c, 1) + 'c / ' + nm(D.recon.quotes.widest_c, 1) + 'c', {
    note: 'narrowest / median / widest across ' + count(D.recon.legs) + ' legs'
  }));
  return f;
}

function insDay(host, D, S, day) {
  var f = doc.createDocumentFragment();
  var d = null;
  D.days.rows.forEach(function (r) { if (r.day === String(day)) d = r; });
  if (!d) { f.appendChild(notpub('series[] day=' + day, 'the axis covers ' + D.days.n + ' sessions', 'derive.js')); return f; }
  f.appendChild(dl([
    ['SESSION', d.dow + ' ' + d.day + DOT + 'day ' + (d.dayIdx + 1) + ' of ' + D.days.n],
    ['TICKS', count(d.ticks) + DOT + count(d.spineTicks) + ' on the shared axis', { cls: 'num' }],
    ['SIGNALS', count(d.signals), { cls: 'num' }],
    ['MEETINGS', count(d.meetings), { cls: 'num' }],
    ['GATE EVALUATIONS', count(d.gateEvals), { cls: 'num' }],
    ['REFUSALS', count(d.refusals), { cls: 'num' }],
    ['OPENED / CLOSED', count(d.opened) + ' / ' + count(d.closed), { cls: 'num' }],
    ['BOOK P&L', d.pnlLast == null ? null : money(d.pnlLast) +
      (d.pnlDelta == null ? '' : DOT + money(d.pnlDelta) + ' on the day'), { cls: 'num' }],
    ['COUNTERS', d.counters
      ? ('entries ' + (d.counters.entries == null ? DASH : d.counters.entries) +
         DOT + 'gate rejections ' + (d.counters.gate_rejections == null ? DASH : d.counters.gate_rejections) +
         DOT + 'new risk ' + (d.counters.new_risk == null ? DASH : plain(d.counters.new_risk)))
      : null, { cls: 'num', title: d.counters && d.counters.partial ? 'this row publishes only the keys it has' : '' }]
  ], true));
  return f;
}

function insUnderlying(host, D, S, sym) {
  var f = doc.createDocumentFragment();
  var u = null;
  D.tree.universe.forEach(function (r) { if (r.sym === String(sym)) u = r; });
  if (!u) { f.appendChild(notpub('params.universe.underlyings ' + sym, 'not in the authorised universe', 'config')); return f; }
  f.appendChild(dl([
    ['UNDERLYING', u.sym + (u.primary ? DOT + 'primary' : '')],
    ['SIGNAL ROWS', u.covered ? count(u.obs) : null, { cls: 'num' }],
    ['SPOT', u.spot == null ? null : nm(u.spot, 2) + (u.spotSrc ? DOT + u.spotSrc : ''), { cls: 'num' }],
    ['IV / RV', u.iv == null ? null : fmt.vol(u.iv) + ' / ' + fmt.vol(u.rv), { cls: 'num' }],
    ['VRP', u.vrp == null ? null : nm(u.vrp, 3) + (u.state ? DOT + u.state : ''), { cls: 'num' }],
    ['ROTATIONS', count(u.rotations.tried) + ' tried' + DOT + count(u.rotations.taken) + ' taken', { cls: 'num' }],
    ['LEGS HELD', count(u.legsHeld), { cls: 'num' }]
  ], true));
  if (!u.covered) f.appendChild(notpub('series.signal[] sym=' + u.sym, u.missing, 'tools/site_data.py'));
  return f;
}

function insBook(host, D, S, key) {
  var f = doc.createDocumentFragment();
  var b = D.books.byKey[String(key)];
  if (!b) { f.appendChild(notpub('series.books.' + key, 'the export carries ' + D.books.order.join(', '), 'tools/site_data.py')); return f; }
  f.appendChild(dl([
    ['BOOK', b.label + DOT + key, { cls: 'id' }],
    ['FINAL P&L', b.final ? money(b.final.v) : null, { cls: 'num' }],
    ['REALIZED / UNREALIZED', b.final ? (money(b.final.r) + ' / ' + money(b.final.u)) : null, { cls: 'num' }],
    ['MARKS', count(b.n) + DOT + count(b.ticksCovered) + ' ticks', { cls: 'num' }],
    ['PEAK / TROUGH', money(b.peak) + ' / ' + money(b.trough), { cls: 'num' }],
    ['DEEPEST DRAWDOWN', money(b.maxDD), { cls: 'num' }],
    ['BROKER EQUITY', b.eqCount ? (count(b.eqCount) + ' of ' + count(b.n) + ' rows carry eq') : null, { cls: 'num' }]
  ], true));
  var ab = D.ablation.vs[String(key)];
  if (ab) {
    f.appendChild(row('REAL − ' + b.label, money(ab.final), {
      note: 'over ' + count(ab.n) + ' ticks where both books carry a mark'
    }));
  }
  return f;
}

/* the default: the session summary, then the most recent tick in full */
function insSession(host, D, S) {
  var f = doc.createDocumentFragment();
  var live = D.liveness(Date.now());
  var last = D.spine.n ? D.spine.n - 1 : null;
  var top = D.refusals.byGateRankedRate && D.refusals.byGateRankedRate.length
    ? D.refusals.byGateRankedRate[0] : null;

  /* the last thing that actually happened, in prose */
  var acts = D.blotter.by.decisions.filter(function (r) {
    return r.sev === 'order' || r.sev === 'gate' || r.sev === 'breach' || r.kind === 'manage';
  });
  var lastAct = acts.length ? acts[acts.length - 1] : null;

  var p = AP(f, E('div', 'prose'));
  p.appendChild(E('b', null, 'SESSION SUMMARY. '));
  p.appendChild(doc.createTextNode(
    'The desk is holding ' + D.structures.open.length + ' open structure' + (D.structures.open.length === 1 ? '' : 's') +
    ' against ' + D.structures.closed.length + ' closed and ' + D.structures.unfilled.length + ' never filled. ' +
    'The market is ' + live.marketState.toLowerCase() + '; the last tick ran ' +
    (D.status.tickMode || 'unrecorded') + ' at ' + fmt.ts(D.status.lastTick.t, 'hm') + 'Z, ' +
    fmt.age(D.status.lastTick.t) + '. ' +
    (D.signal.current.regime
      ? ('The regime reads ' + D.signal.current.regime + ' — implied ' + fmt.vol(D.signal.current.atm_iv) +
         ' over realized ' + fmt.vol(D.signal.current.rv20) + ', VRP ' + nm(D.signal.current.vrp, 2) + '. ')
      : '') +
    (top ? ('The binding constraint is ' + top.gate + ': it failed ' + ofRate(top.matrixFails, top.evals) +
            ' gate evaluations, more often than any other gate. ') : '') +
    (lastAct ? ('Last action: ' + lastAct.label + (lastAct.reason ? ' — ' + lastAct.reason : '') +
                ', ' + fmt.age(lastAct.t) + '.') : '')));

  f.appendChild(dl([
    ['BOOK', money(D.kpi.book.pnl) + DOT + 'realized ' + money(D.kpi.book.realized) +
      DOT + 'unrealized ' + money(D.kpi.book.unrealized), { cls: 'num' }],
    ['REFUSED', count(D.refusals.n) + ' across ' + count(Object.keys(D.refusals.byKindMap).length) + ' kinds', { cls: 'num' }],
    ['STRUCTURES', D.structures.open.length + ' open ' + DOT + D.structures.closed.length + ' closed ' +
      DOT + D.structures.unfilled.length + ' unfilled of ' + D.structures.n, { cls: 'num' }],
    ['JOURNAL', count(D.status.chain.entries) + ' entries' + DOT + (D.status.chain.ok ? 'chain intact' : 'CHAIN BROKEN'), { cls: 'num' }]
  ], true));

  if (last != null) {
    f.appendChild(sectionLabel('LATEST TICK', 'lock the cursor to pin any other tick here'));
    f.appendChild(insTick(host, D, S, last));
  }
  return f;
}

function renderInspector(host, D, S) {
  remember(host, renderInspector, D, S);
  var p = histOf(host);
  var sel = (S && S.sel) ? S.sel : null;

  /* PIN keeps an explicit selection while the cursor moves */
  var pinned = vget(host, 'pin', '0') === '1';
  if (sel && sel.type !== 'tick' && p) p.__pin = { type: sel.type, id: sel.id };
  if (pinned && p && p.__pin && (!sel || sel.type === 'tick')) sel = p.__pin;
  if (!sel && S && S.locked && S.cur != null) sel = { type: 'tick', id: S.cur };
  if (sel) pushHist(host, sel);

  /* ---- controls: history, pin, copy link ---- */
  var pc = controls(host);
  if (pc) {
    clear(pc);
    var canBack = p && p.__hi > 0;
    var canFwd = p && p.__hi >= 0 && p.__hi < p.__hist.length - 1;
    pc.appendChild(ibtn('◂', 'previous selection', canBack ? function () { stepHist(host, -1); } : null));
    pc.appendChild(ibtn('▸', 'next selection', canFwd ? function () { stepHist(host, 1); } : null));
    pc.appendChild(chip('PIN', pinned, function () { local(host, 'pin', pinned ? '0' : '1'); },
      { title: 'keep this selection while the cursor moves' }));
    pc.appendChild(ibtn('⧉', 'copy a link to this exact view', function (ev) {
      copyLink();
      var b = ev.currentTarget;
      b.textContent = '✓';
      global.setTimeout(function () { b.textContent = '⧉'; }, 900);
    }));
  }

  /* ---- readout ---- */
  var type = sel ? sel.type : 'session';
  var idTxt = sel ? String(sel.id) : '';
  if (type === 'tick') idTxt = (parseInt(sel.id, 10) + 1) + '/' + D.spine.n;
  readoutFit(host,
    sel ? [type.toUpperCase() + ' ' + idTxt,
           type.toUpperCase() + ' ' + (idTxt.length > 13 ? idTxt.slice(0, 12) + '…' : idTxt),
           type.toUpperCase()]
        : ['SESSION' + DOT + D.days.n + ' sessions', 'SESSION'],
    sel ? (type + ' ' + String(sel.id)) : ('no selection' + DOT + D.days.n + ' sessions'));

  /* ---- body ---- */
  var body = clear(host);
  var node, provText;

  switch (type) {
    case 'tick':
      node = insTick(host, D, S, parseInt(sel.id, 10));
      provText = 'every series joined at one tick of the shared 300s axis';
      break;
    case 'structure': case 'position':
      node = insStructure(host, D, S, sel.id);
      provText = 'positions[] · series.gates · series.desk · series.reprice · series.manage · trades[]';
      break;
    case 'trade':
      node = insTrade(host, D, S, sel.id);
      provText = 'trades[] · R = pnl / max_loss';
      break;
    case 'gateeval':
      node = insGateEval(host, D, S, sel.id);
      provText = 'series.gates[].r · .fails · .wc';
      break;
    case 'gate':
      node = insGate(host, D, S, sel.id);
      provText = 'gate_defs[] · series.gates[].r · refusals.by_gate';
      break;
    case 'refusal':
      node = insRefusal(host, D, S, sel.id);
      provText = 'series.refusals[]';
      break;
    case 'decision': case 'blotter':
      node = insBlotterRow(host, D, S, sel.id);
      provText = 'decisions[] · decisions[].d is the journal record';
      break;
    case 'meeting': case 'desk':
      node = insMeeting(host, D, S, sel.id);
      provText = 'series.desk[] · roles[].txt is what the model returned';
      break;
    case 'integrity':
      node = insIntegrity(host, D, S, sel.id);
      provText = 'series.integrity[]';
      break;
    case 'claim':
      node = insClaim(host, D, S, sel.id);
      provText = 'verification.claims[] · CHECK recomputed from the series';
      break;
    case 'param':
      node = insParam(host, D, S, sel.id);
      provText = 'params · gate_defs[].params';
      break;
    case 'leg':
      node = insLeg(host, D, S, sel.id);
      provText = 'positions[].legs[]';
      break;
    case 'day':
      node = insDay(host, D, S, sel.id);
      provText = 'series[] grouped by session · series.daily counters';
      break;
    case 'underlying':
      node = insUnderlying(host, D, S, sel.id);
      provText = 'params.universe · series.signal · series.alt';
      break;
    case 'book':
      node = insBook(host, D, S, sel.id);
      provText = 'series.books.' + sel.id;
      break;
    case 'brokercheck':
      node = (function () {
        var f = doc.createDocumentFragment();
        var c = D.recon.brokerChecks[parseInt(sel.id, 10)];
        if (!c) { f.appendChild(notpub('series.brokercheck[' + sel.id + ']', 'the export carries ' + D.recon.brokerChecks.length + ' checks', 'tools/site_data.py')); return f; }
        f.appendChild(dl([
          ['WHEN', fmt.ts(c.t, 'full')],
          ['STORE', plain(c.store), { cls: 'num' }],
          ['BROKER', plain(c.broker), { cls: 'num' }],
          ['DIFFERENCE', c.delta == null ? null : money(c.delta), { cls: 'num' }],
          ['FIELDS REPAIRED', count(arr(c.repaired).length), { cls: 'num' }],
          ['AFTER', plain(c.after), { cls: 'num' }]
        ], true));
        if (arr(c.repaired).length) {
          var pre = E('div', 'json');
          pre.textContent = safeJson(c.repaired);
          f.appendChild(pre);
        }
        return f;
      })();
      provText = 'series.brokercheck[]';
      break;
    default:
      if (sel) {
        node = doc.createDocumentFragment();
        node.appendChild(notpub('inspector view for "' + type + '"',
          'no renderer is defined for this selection type', 'panels-d.js · TDP.inspector'));
        node.appendChild(insSession(host, D, S));
        provText = 'unknown selection type';
      } else {
        node = insSession(host, D, S);
        provText = 'no selection · the desk as it stands, then the latest tick in full';
      }
  }
  body.appendChild(node);

  /* ---- footer: the raw record ---- */
  var pf = hookOf(host, 'provenance');
  if (pf) {
    clear(pf);
    pf.appendChild(doc.createTextNode(provText + DOT));
    if (sel) {
      var b2 = E('button', 'chip', 'RAW');
      b2.type = 'button';
      b2.title = 'open the underlying record';
      b2.addEventListener('click', function () { raw(host, rawOf(D, sel), type + ' ' + idTxt); });
      pf.appendChild(b2);
    }
    pf.title = provText;
  }
}

/* the object behind a selection, as close to the journal record as the export
   allows.  Never invented: what is not published is simply not here. */
function rawOf(D, sel) {
  var id = sel.id;
  switch (sel.type) {
    case 'tick': return D.byTick[parseInt(id, 10)] || null;
    case 'structure': case 'position': return D.structures.byId[String(id)] || null;
    case 'trade': return D.trades.rows.filter(function (r) { return r.id === String(id); })[0] || null;
    case 'gateeval': return D.gates.evals[parseInt(id, 10)] || null;
    case 'gate': return D.gates.stats[String(id)] || null;
    case 'refusal': return refusalOf(D, id);
    case 'decision': case 'blotter': {
      var r = (typeof id === 'string' && id.indexOf(':') > 0) ? blotterByKey(D, id) : decisionOf(D, id);
      return r ? (r.d || r.raw || r) : null;
    }
    case 'meeting': case 'desk': return D.desk.rows[parseInt(id, 10)] || null;
    case 'integrity': return D.integrity.cells[parseInt(id, 10)] || null;
    case 'claim': return D.claims.rows.filter(function (r) { return String(r.n) === String(id); })[0] || null;
    case 'param': return D.params.byPath[String(id)] || null;
    case 'book': return D.books.byKey[String(id)] ? D.books.byKey[String(id)].final : null;
    case 'brokercheck': return D.recon.brokerChecks[parseInt(id, 10)] || null;
    default: return sel;
  }
}

/* ===========================================================================
   9 · EXPORT
   =========================================================================== */

Object.assign(global.TDP, {
  recon: renderRecon,
  integrity: renderIntegrityPanel,
  trades: renderTrades,
  deck: renderDeck,
  inspector: renderInspector
});

})(typeof window !== 'undefined' ? window : this);
