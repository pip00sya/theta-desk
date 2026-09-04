/* ==========================================================================
   THETA DESK — dashboard/web/panels-c.js
   Column C, the evidence stack:

     C1  GATE MATRIX   12 gates x 57 evaluations, horizontal scroll, three
                       cell states, a tooltip per cell naming the gate, the
                       verdict and the verbatim reason, click to select.
     C2  RISK LADDER   six published ceilings.  The 'used' side is the
                       engine's own operand and series.gates[].d is null on
                       all 57 stored evaluations, so NOW draws each limit and
                       says exactly what is missing, HISTORY is the notpub
                       state, and PEAK prints only the peaks a published
                       series can actually support, each naming its source.
     C3  REFUSALS      109 refusals across seven kinds — the Pareto by gate,
                       the census by kind, the rate over time, and the printed
                       sentence that the two rankings disagree.
     C4  BLOTTER       the journal as one table: eight counted tabs, kind and
                       gate pills, free text, dates, a sortable sticky header,
                       run-collapsing, windowed rows so 900 do not stall,
                       click to select, the raw-record drawer, CSV, and the
                       pinned THIS VIEW sentence.

   Contract (§2.4, §7.2): every renderer is fn(host, D, S), idempotent,
   returns nothing, attaches no window/document listener, keeps no state that
   TD.set() does not own, and writes class + data-* attributes.  The single
   inline exception is geometry — meter fill widths, limit-tick offsets,
   virtual-spacer heights, and the flex-wrap on two control rows — which
   styles.css sanctions for meters and which nothing else can express without
   inventing a class.  No colour, no font-size, no hex literal is written
   from here (make lint-hex); the green token is never referenced (lint-green).
   ========================================================================== */

(function (global) {
  'use strict';

  var doc = global.document;
  var TDC = global.TDC;
  var TDD = global.TDD;
  var fmt = TDC ? TDC.fmt : null;
  var C = TDC ? TDC.C : {};
  var DASH = (fmt && fmt.DASH) || '—';
  var HAIR = (fmt && fmt.hair) || ' ';
  var NL = String.fromCharCode(10);          /* newline inside a title= string */

  window.TDP = window.TDP || {};

  /* ========================================================================
     0 · SHARED PLUMBING
     ====================================================================== */

  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }
  function A(v) { return Array.isArray(v) ? v : []; }
  function num(v) {
    var n = (v === '' || v === null || v === undefined) ? null : +v;
    return (n === null || isNaN(n)) ? null : n;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== null && text !== undefined) e.textContent = String(text);
    return e;
  }
  function add(parent, tag, cls, text) {
    var e = el(tag, cls, text);
    if (parent) parent.appendChild(e);
    return e;
  }
  function clear(node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); }
  function title(node, t) { if (node && t) node.setAttribute('title', String(t)); return node; }
  function wrapRow(parent, tall) {
    var r = add(parent, 'div', 'row' + (tall ? ' tall' : ''));
    if (tall) r.style.flexWrap = 'wrap';
    return r;
  }
  /* .row and .thisview are display:flex, so the hidden ATTRIBUTE is powerless
     against them; visibility of a whole row is geometry, written inline */
  function showRow(node, on) { if (node) node.style.display = on ? '' : 'none'; }

  /* Vertical room left for table rows, computed from the PANEL — which the
     grid sizes — rather than from the body, whose height depends on what this
     render pass is in the middle of putting into it. */
  function roomFor(host, chrome) {
    var p = panelOf(host);
    return (p ? (p.clientHeight || 0) : 0) - chrome;
  }

  /* panel chrome — the renderer is handed .pb; the rest hangs off it */
  function panelOf(host) {
    var n = host;
    while (n && n.nodeType === 1) {
      if (n.classList && n.classList.contains('p')) return n;
      n = n.parentNode;
    }
    return host ? host.parentNode : null;
  }
  function hook(host, name) {
    var p = panelOf(host);
    return p ? p.querySelector('[data-' + name + ']') : null;
  }
  function controlsOf(host) { return hook(host, 'controls'); }
  function readoutOf(host) { return hook(host, 'readout'); }
  function provOf(host) { return hook(host, 'provenance'); }

  /* The readout is mandatory (§3.3) and the header is 22px of a 357px column,
     so it is written at the longest variant that measurably fits, with the
     full sentence always in its title.  Mono advance is 0.6em; f10 is 10.5px. */
  function setReadout(host, variants) {
    var pr = readoutOf(host);
    if (!pr) return;
    variants = A(variants).filter(function (s) { return s != null && s !== ''; });
    if (!variants.length) { pr.textContent = DASH; return; }
    var p = panelOf(host);
    var ph = p ? p.querySelector('.ph') : null;
    var h2 = ph ? ph.querySelector('h2') : null;
    var pc = controlsOf(host);
    var avail = ph ? ((ph.clientWidth || 0) - (h2 ? h2.offsetWidth : 0) - (pc ? pc.offsetWidth : 0) - 28) : 0;
    var pick = variants[0];
    if (avail > 0) {
      pick = variants[variants.length - 1];
      for (var j = 0; j < variants.length; j++) {
        if (variants[j].length * 6.35 <= avail) { pick = variants[j]; break; }
      }
    }
    pr.textContent = pick;
    pr.setAttribute('title', variants[0]);
  }

  function setProvenance(host, text, full) {
    var pf = provOf(host);
    if (!pf) return;
    pf.textContent = text;
    pf.setAttribute('title', full || text);
  }

  /* §3.6 — one rule for every missing thing.  Never a zero, never a blank. */
  function notpub(parent, path, why, fix, inline, fill) {
    /* .notpub is height:100%.  As the panel's own empty state that is exactly
       right — it keeps the whole grid cell (§3.6).  As a note UNDER content it
       would inflate to the body's full height, so it goes in an auto-height box. */
    var host = (parent && !inline && !fill && parent.classList && parent.classList.contains('pb'))
      ? add(parent, 'div', null) : parent;
    var n = add(host, 'div', 'notpub' + (inline ? ' inline' : ''));
    add(n, 'b', null, 'not published');
    add(n, 'span', null, path);
    if (why) add(n, 'span', null, why);
    if (fix) add(n, 'span', null, fix);
    n.setAttribute('title', 'not published — ' + path +
      (why ? ('\n' + why) : '') + (fix ? ('\n' + fix) : ''));
    return n;
  }
  function failBox(parent, where, msg) {
    var n = add(parent, 'div', 'notpub');
    add(n, 'b', null, 'render error');
    add(n, 'span', null, where);
    add(n, 'span', null, String(msg));
    n.setAttribute('title', where + '\n' + msg + '\nthe data is intact; this panel threw while drawing it');
    return n;
  }
  function missingOf(D, key) {
    return (D && D.missingByKey) ? (D.missingByKey[key] || null) : null;
  }
  function notpubFrom(parent, D, key, fallbackPath, inline, fill) {
    var m = missingOf(D, key);
    /* an inline one is a single nowrap line inside a scrolling body: it names
       the path and keeps the sentence in its title, or it would set the
       panel's horizontal scroll extent all by itself */
    var n = notpub(parent, m ? m.path : fallbackPath,
      inline ? null : (m ? m.why : null), inline ? null : (m ? m.fix : null), inline, fill);
    if (inline && m) {
      n.setAttribute('title', 'not published — ' + m.path +
        (m.why ? (NL + m.why) : '') + (m.fix ? (NL + m.fix) : ''));
    }
    return n;
  }

  /* ---- state ------------------------------------------------------------
     §7.2: TD.set() is the only way state changes.  LOCAL mirrors the patch so
     these four panels still work when TD is absent (the standalone file, a
     probe) and when TD.set() declines a key it does not know about.  S always
     wins wherever S carries the key. */
  var LOCAL = {};
  var LAST = {};
  var ORDER = ['matrix', 'ladder', 'refusals', 'blotter'];

  function ui(S, key, dflt) {
    if (S && S[key] !== undefined && S[key] !== null) return S[key];
    if (LOCAL[key] !== undefined && LOCAL[key] !== null) return LOCAL[key];
    return dflt;
  }
  function setState(patch) {
    var k;
    for (k in patch) if (has(patch, k)) LOCAL[k] = patch[k];
    var TD = global.TD;
    if (TD && typeof TD.set === 'function') { TD.set(patch); return; }
    for (k in LAST) {
      if (!has(LAST, k) || !LAST[k]) continue;
      var S = LAST[k].S;
      for (var q in patch) if (has(patch, q)) S[q] = patch[q];
    }
    redrawOwn();
  }
  function redrawOwn() {
    for (var j = 0; j < ORDER.length; j++) {
      var r = LAST[ORDER[j]];
      if (!r || !r.host || !r.host.parentNode) continue;
      try { window.TDP[ORDER[j]](r.host, r.D, r.S); } catch (e) { report(e, ORDER[j]); }
    }
  }
  function remember(key, host, D, S) { LAST[key] = { host: host, D: D, S: S }; }
  function stateOf(key, S) { return (LAST[key] && LAST[key].S) || S || {}; }
  function report(e, where) {
    if (global.console && console.error) console.error('[TDP.' + where + ']', e);
  }
  function sameSel(a, b) {
    if (!a || !b) return false;
    return String(a.type) === String(b.type) && String(a.id) === String(b.id);
  }

  /* one cursor subscription per host, kept for the life of the element */
  function bindCursor(host, key, fn) {
    if (!TDC || !TDC.cursor) return;
    var slot = host['__tdpc_' + key];
    if (slot) { slot.fn = fn; return; }
    slot = host['__tdpc_' + key] = { fn: fn };
    TDC.cursor.on(function (i) {
      if (slot.fn) { try { slot.fn(i); } catch (e) { report(e, key); } }
    }, 'time');
  }
  /* One ResizeObserver per PANEL (never the body: the body's own scrollbar
     would feed back into its width and loop).  It corrects the first-paint
     measurement, which lands before the grid has settled, and it keeps the
     DOM-hosted marks and the adaptive column set honest across a resize. */
  function bindResize(host, key) {
    var p = panelOf(host);
    if (!p || p.__tdpRO || !global.ResizeObserver) return;
    var last = p.clientWidth + 'x' + p.clientHeight, pending = false;
    p.__tdpRO = new global.ResizeObserver(function () {
      var now = p.clientWidth + 'x' + p.clientHeight;
      if (now === last || pending) return;
      last = now; pending = true;
      (global.requestAnimationFrame || global.setTimeout)(function () {
        pending = false;
        var rec = LAST[key];
        if (!rec || !rec.host || !rec.host.parentNode) return;
        try { window.TDP[key](rec.host, rec.D, rec.S); } catch (e) { report(e, key); }
      });
    });
    try { p.__tdpRO.observe(p); } catch (e) {}
  }

  /* one listener per host per kind — on the panel's own element, never on
     window or document, and never re-attached by a later render pass */
  function bindOnce(host, flag, type, fn) {
    if (host[flag]) { host[flag].fn = fn; return; }
    var slot = host[flag] = { fn: fn };
    host.addEventListener(type, function (ev) {
      if (slot.fn) { try { slot.fn(ev); } catch (e) { report(e, flag); } }
    }, type === 'scroll' ? { passive: true } : false);
  }

  /* ---- controls (§3.4): real buttons with aria state ------------------- */
  function segment(parent, items, active, onPick) {
    var g = add(parent, 'div', 'seg');
    g.setAttribute('role', 'radiogroup');
    for (var j = 0; j < items.length; j++) {
      (function (it) {
        var b = add(g, 'button', null, it.label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', it.key === active ? 'true' : 'false');
        b.setAttribute('data-v', it.key);
        if (it.title) b.setAttribute('title', it.title);
        b.addEventListener('click', function (ev) { onPick(it.key, ev); });
      })(items[j]);
    }
    return g;
  }
  function chip(parent, o) {
    var b = add(parent, 'button', 'chip' + (o.cls ? (' ' + o.cls) : ''));
    b.type = 'button';
    add(b, 'span', null, o.label);
    if (o.n !== null && o.n !== undefined) add(b, 'span', 'n', HAIR + o.n);
    b.setAttribute('aria-pressed', o.on ? 'true' : 'false');
    if (o.key) b.setAttribute('data-v', o.key);
    if (o.title) b.setAttribute('title', o.title);
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }
  function iconBtn(parent, glyph, ttl, onClick) {
    var b = add(parent, 'button', 'ibtn', glyph);
    b.type = 'button';
    if (ttl) b.setAttribute('title', ttl);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  /* The body's clientWidth is unreliable on the first paint; the panel is
     grid-sized and is not, so a DOM-hosted mark is measured against both. */
  function markWidth(host, inset) {
    var p = panelOf(host);
    var a = host.clientWidth || 0, b = p ? (p.clientWidth || 0) : 0;
    var w = (a && b) ? Math.min(a, b) : (a || b || 300);
    return Math.max(140, w - (inset === undefined ? 10 : inset));
  }

  function pct1(frac) { return (frac === null || frac === undefined) ? DASH : (frac * 100).toFixed(1) + '%'; }
  function money(v, dp) { return fmt ? fmt.money(v, dp === undefined ? 2 : dp) : String(v); }
  function usd(v, dp) { return fmt ? fmt.usd(v, dp === undefined ? 2 : dp) : String(v); }
  function ts(t, mode) { return fmt ? fmt.ts(t, mode) : String(t); }
  function count(v) { return fmt ? fmt.count(v) : String(v); }

  /* ========================================================================
     1 · C1 — GATE MATRIX
     Rows are the union of the keys present in series.gates[].r, ordered by
     gate_defs — never a hardcoded row count.  Columns are the evaluations in
     time order.  The third cell state, "not reached", is itself a
     measurement: g18 was evaluated 50 times of 57 and g19 49.
     ====================================================================== */

  var GM_SORTS = ['order', 'rate', 'count'];
  var GM_SORT_LABEL = { order: 'SORT ORDER', rate: 'SORT RATE', count: 'SORT COUNT' };

  function matrixRows(G, sort, failsOnly) {
    var ids = A(G.ids).slice();
    if (failsOnly) ids = ids.filter(function (id) { return G.stats[id] && G.stats[id].everBound; });
    if (sort === 'rate') {
      ids.sort(function (a, b) {
        return (G.stats[b].failRate || 0) - (G.stats[a].failRate || 0) || G.stats[b].fail - G.stats[a].fail;
      });
    } else if (sort === 'count') {
      ids.sort(function (a, b) {
        return G.stats[b].fail - G.stats[a].fail || (G.stats[b].failRate || 0) - (G.stats[a].failRate || 0);
      });
    }
    return ids;
  }

  function cellTitle(st, e, v, nEval) {
    var lines = [st.id + ' · ' + st.label];
    lines.push(v === null ? 'NOT REACHED — an earlier gate had already refused' : (v ? 'PASS' : 'FAIL'));
    if (v === 0) {
      var f = null, j;
      for (j = 0; j < e.fails.length; j++) if (e.fails[j].gate === st.id) { f = e.fails[j]; break; }
      if (f && f.reason) lines.push(f.reason);
      if (e.firstFail === st.id) lines.push('decisive — this is the gate the refusal names');
    }
    lines.push(ts(e.t, 'full') + ' · ' + (e.kind || DASH) +
      (e.sid ? (' · ' + e.sid) : '') + (e.qty === null ? '' : (' · qty ' + e.qty)));
    lines.push('evaluation ' + (e.k + 1) + ' of ' + nEval + ' · ' +
      e.nPassed + ' of ' + e.nEvaluated + ' gates passed · ' + (e.passed ? 'candidate passed' : 'candidate refused'));
    if (st.what) lines.push(st.what);
    return lines.join('\n');
  }

  function renderMatrix(host, D, S) {
    remember('matrix', host, D, S);
    bindResize(host, 'matrix');
    var G = D && D.gates;
    var pc = controlsOf(host);
    clear(pc);
    clear(host);

    if (!G || !G.n || !A(G.ids).length) {
      notpub(host, 'series.gates[].r', 'no gate evaluation carries a result map', 'tools/site_data.py · _series()', false, true);
      setReadout(host, ['gate evaluations not published']);
      return;
    }

    var sort = ui(S, 'gmSort', 'order');
    if (GM_SORTS.indexOf(sort) < 0) sort = 'order';
    var failsOnly = !!ui(S, 'gmFails', false);
    var selGate = (S && S.gate) || null;
    var sel = (S && S.sel) || null;
    var nEval = G.n;
    var bound = A(G.everBound).length;
    var totalFails = 0, k;
    for (k = 0; k < G.ids.length; k++) totalFails += G.stats[G.ids[k]].fail;

    var headline = G.defs.length + ' gate functions in engine/gates.py · ' + nEval +
      ' evaluations · ' + bound + ' have ever bound';

    /* ---- controls ---- */
    chip(pc, {
      label: GM_SORT_LABEL[sort], on: sort !== 'order',
      title: 'sort the rows: gate_defs order → fail rate → fail count',
      onClick: function () { setState({ gmSort: GM_SORTS[(GM_SORTS.indexOf(sort) + 1) % GM_SORTS.length] }); }
    });
    chip(pc, {
      label: 'FAILS', n: bound, on: failsOnly,
      title: 'collapse to the ' + bound + ' gates that have ever bound; the other ' +
        (G.ids.length - bound) + ' are 0 of their own denominator',
      onClick: function () { setState({ gmFails: !failsOnly }); }
    });

    /* ---- what this panel is a count of ---- */
    title(add(host, 'div', 'degen',
      G.defs.length + ' gates · ' + nEval + ' evaluations · ' + bound + ' ever bound · ' +
      totalFails + ' gate failures'),
      headline + '\nthe 18 in PLAN.md is a claim about its numbering; this panel counts what was measured');

    /* ---- the matrix ---- */
    var ids = matrixRows(G, sort, failsOnly);
    var gm = add(host, 'div', 'gm');
    var widest = 0;
    for (k = 0; k < ids.length; k++) widest = Math.max(widest, ids[k].length);
    gm.style.setProperty('--gml', clamp(Math.round(widest * 6.1) + 14, 84, 156) + 'px');
    gm.style.setProperty('--gmr', '86px');

    var curTick = (S && S.locked && S.cur !== null && S.cur !== undefined) ? S.cur : null;
    var cellsByEval = [];
    for (k = 0; k < nEval; k++) cellsByEval.push([]);

    for (var r = 0; r < ids.length; r++) {
      var id = ids[r], st = G.stats[id];
      var row = add(gm, 'div', 'gmrow');
      row.setAttribute('data-gate', id);
      if (st.everBound) row.setAttribute('data-bind', '1');
      if (selGate === id) row.setAttribute('data-sel', '1');
      else if (selGate) row.setAttribute('data-dim', '1');

      var lab = add(row, 'div', 'gmlab', id);
      lab.setAttribute('role', 'button');
      lab.setAttribute('tabindex', '0');
      title(lab, id + ' — ' + st.label + '\n' + (st.what || '') +
        (st.params && st.params.length ? ('\nparams: ' + st.params.join(', ')) : '') +
        '\n' + st.fail + ' failures in ' + st.evals + ' evaluations' +
        (st.notReached ? (' · ' + st.notReached + ' of ' + nEval + ' never reached it') : '') +
        (st.firstFail ? ('\n' + st.firstFail + ' refusals name it as the first failing gate') : '') +
        '\nclick to filter the page to this gate');

      var cells = add(row, 'div', 'gmcells');
      var col = G.matrix[id];
      for (k = 0; k < nEval; k++) {
        var v = (col[k] === undefined) ? null : col[k];
        var e = G.evals[k];
        var c = add(cells, 'span', v === null ? 'cell nr' : (v ? 'cell pass' : 'cell fail'));
        c.setAttribute('data-c', k);
        c.setAttribute('data-r', id);
        if (sel && sel.type === 'gateeval' && String(sel.id) === String(k)) c.setAttribute('data-sel', '1');
        if (curTick !== null && e.i === curTick) c.classList.add('cur');
        title(c, cellTitle(st, e, v, nEval));
        cellsByEval[k].push(c);
      }

      var rate = add(row, 'div', 'gmrate');
      rate.appendChild(doc.createTextNode(st.fail + '/' + st.evals));
      add(rate, 'span', 'r', pct1(st.failRate));
      title(rate, st.fail + ' failures in ' + st.evals + ' evaluations of ' + id +
        (st.notReached ? (' · ' + st.notReached + ' of ' + nEval + ' never reached this gate') : ''));
    }

    /* ---- degenerate rows: a labelled scalar with its denominator (§3.6) --- */
    for (k = 0; k < G.ids.length; k++) {
      var gid = G.ids[k], gs = G.stats[gid];
      if (!gs.notReached) continue;
      var txt = gid + ' — evaluated ' + gs.evals + ' of ' + nEval + ', ' + gs.notReached +
        ' never reached · ' + (gs.fail ? (gs.fail + ' failures') : 'never bound');
      title(add(host, 'div', 'degen', txt), txt +
        '\nthe denominator comes from the presence of the key in series.gates[].r, not from a constant');
    }
    if (failsOnly && A(G.neverBound).length) {
      var hid = 'hidden — ' + G.neverBound.length + ' gates never bound: ' + G.neverBound.join(', ');
      title(add(host, 'div', 'degen', hid), hid);
    }
    if (!G.operandsPublished) {
      /* inline, not block: C1 draws verdicts and every verdict IS published.
         The operands are D5's and C2's missing thing, named here in one line. */
      var np = notpubFrom(host, D, 'gate_operands', 'series.gates[].d', true);
      title(np, np.getAttribute('title') + NL +
        'the verdicts are published; the operands behind them are not');
    }

    /* ---- one delegated listener per host, rebound to the fresh closure ---- */
    bindOnce(host, '__c1Click', 'click', function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      var Sn = stateOf('matrix', S);
      if (t.classList.contains('gmlab')) {
        var g = t.parentNode.getAttribute('data-gate');
        var off = Sn.gate === g;
        setState({ gate: off ? null : g, sel: off ? null : { type: 'gate', id: g } });
        return;
      }
      if (t.classList.contains('cell')) {
        var ck = +t.getAttribute('data-c');
        var e2 = G.evals[ck];
        var already = Sn.sel && Sn.sel.type === 'gateeval' && String(Sn.sel.id) === String(ck);
        setState({ sel: already ? null : { type: 'gateeval', id: ck } });
        if (!already && e2 && TDC && TDC.cursor) TDC.cursor.lock(e2.i, 'c1');
      }
    });
    bindOnce(host, '__c1Key', 'keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var t = ev.target;
      if (t && t.classList && t.classList.contains('gmlab')) { ev.preventDefault(); t.click(); }
    });
    /* §6.7 bidirectional hover — a matrix column moves the page cursor */
    bindOnce(host, '__c1Hover', 'mouseover', function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1 || !t.classList.contains('cell')) return;
      var e3 = G.evals[+t.getAttribute('data-c')];
      if (e3 && TDC && TDC.cursor) TDC.cursor.set(e3.i, 'c1');
    });

    /* the cursor column, live, without a full render pass */
    bindCursor(host, 'matrix', function () {
      var cs = TDC.cursor.get('time');
      var want = cs.li !== null ? cs.li : cs.i;
      for (var q = 0; q < nEval; q++) {
        var on = (want !== null && want !== undefined && G.evals[q].i === want);
        var list = cellsByEval[q];
        for (var z = 0; z < list.length; z++) {
          if (on) list[z].classList.add('cur'); else list[z].classList.remove('cur');
        }
      }
    });

    /* ---- readout and provenance ---- */
    var byRate = G.ids.slice().sort(function (a, b) {
      return (G.stats[b].failRate || 0) - (G.stats[a].failRate || 0);
    });
    var tS = G.stats[byRate[0]];
    setReadout(host, [
      G.defs.length + ' gates · ' + nEval + ' evals · ' + bound + ' bound · ' + tS.id + ' ' +
        tS.fail + '/' + tS.evals + ' ' + pct1(tS.failRate),
      nEval + ' evals · ' + bound + ' of ' + G.defs.length + ' bound · ' + tS.fail + '/' + tS.evals,
      nEval + ' evals · ' + bound + ' bound',
      bound + '/' + G.defs.length + ' bound'
    ]);
    var g18 = G.stats.g18_sleeve_budget, g19 = G.stats.g19_feed_freshness;
    setProvenance(host,
      nEval + ' evals · ' + ids.length + ' rows · series.gates[].r · gate_defs',
      headline + '\nrows are the union of keys present in series.gates[].r, ordered by gate_defs · ' +
      totalFails + ' gate failures · the denominator differs per gate: ' +
      'g18 ' + (g18 ? g18.evals : DASH) + ', g19 ' + (g19 ? g19.evals : DASH) + ' of ' + nEval);
  }

  /* ========================================================================
     2 · C2 — RISK LADDER
     Every ceiling is published; not one measured 'used' value is.  The panel
     says so per row and once for the panel, and never puts a zero where a
     number it does not have belongs.
     ====================================================================== */

  var RL_MODES = [
    { key: 'now', label: 'NOW', title: 'the published ceilings as they stand right now' },
    { key: 'peak', label: 'PEAK', title: 'the largest value each ceiling ever faced — only where a published series supports one' },
    { key: 'history', label: 'HIST', title: 'utilisation per evaluation against the limit in force at that timestamp — needs series.gates[].d' }
  ];

  /* Peaks that published series can genuinely support.  Anything not here
     stays unpublished; no English gate reason string is parsed, and no limit
     is read back out of config.yaml. */
  function ladderPeaks(D) {
    var out = {}, j;

    var all = D.structures ? A(D.structures.all) : [];
    var mx = null, mxId = null;
    for (j = 0; j < all.length; j++) {
      var ml = num(all[j].max_loss);
      if (ml !== null && (mx === null || ml > mx)) { mx = ml; mxId = all[j].id; }
    }
    if (mx !== null) {
      out.per_structure = { v: mx, src: 'positions[].max_loss',
        note: 'largest defined risk of the ' + all.length + ' structures ever opened (' + mxId +
          ') — the structure as filled, not the candidate the gate sized' };
    }

    var G = D.gates;
    if (G && G.worstCase && G.worstCase.published && G.worstCase.min !== null) {
      var wc = Math.abs(G.worstCase.min);
      out.portfolio = { v: wc, src: 'series.gates[].wc.pnl',
        note: 'deepest worst case over ' + G.worstCase.n + ' evaluations (' + usd(G.worstCase.min) +
          ') — the quantity g8 reprices and compares to this limit' };
      out.portfolio_cap = { v: wc, src: 'series.gates[].wc.pnl',
        note: 'the same measurement, read against the absolute cap rather than the earned budget' };
    }

    var daily = (D.days && D.days.dailyRows) ? A(D.days.dailyRows) : [];
    var dmx = null, dday = null, dn = 0;
    for (j = 0; j < daily.length; j++) {
      var nr = num(daily[j].new_risk);
      if (nr === null) continue;
      dn++;
      if (dmx === null || nr > dmx) { dmx = nr; dday = daily[j].day; }
    }
    if (dmx !== null) {
      out.daily_new = { v: dmx, src: 'series.daily[].new_risk',
        note: 'largest day of new risk released (' + dday + ') · ' + dn + ' of ' + daily.length +
          ' published days carry the key' };
    }

    var B = (D.books && D.books.byKey) ? D.books.byKey.real : null;
    if (B && A(B.pts).length) {
      var peak = null, worst = null, at = null, n = 0;
      for (j = 0; j < B.pts.length; j++) {
        var e = num(B.pts[j].eq);
        if (e === null) continue;
        n++;
        if (peak === null || e > peak) peak = e;
        if (worst === null || peak - e > worst) { worst = peak - e; at = B.pts[j].t; }
      }
      if (worst !== null && n > 1) {
        out.drawdown_halt = { v: worst, src: 'series.books.real[].eq',
          note: 'deepest fall from a running equity peak over ' + n + ' published marks (' + ts(at, 'full') + ')' };
      }
    }
    return out;
  }

  function ladderRow(parent, o) {
    var b = add(parent, 'div', 'bullet');
    if (o.over) b.setAttribute('data-over', '1');
    if (o.sel) b.setAttribute('data-sel', '1');
    if (o.gate) b.setAttribute('data-gate', o.gate);
    title(add(b, 'div', 'lab', o.label), o.title || o.label);

    if (o.missing) {
      var n = add(b, 'div', 'notpub inline');
      add(n, 'b', null, 'not published');
      add(n, 'span', null, o.missing.path);
      n.setAttribute('title', 'not published — ' + o.missing.path +
        (o.missing.why ? ('\n' + o.missing.why) : ''));
      return b;
    }

    /* the used column is 62px: the sentence goes in the title and, in full,
       in the panel's own .notpub below the six rows.  A dash is the one
       no-value glyph on the page — never a zero, never a blank. */
    var cell = add(b, 'div', 'num trunc');
    if (o.value === null || o.value === undefined) {
      title(cell, 'used: not published — series.gates[].d');
      add(cell, 'span', 'c-faint', DASH);
    } else {
      add(cell, 'span', o.soft ? 'c-soft' : null, o.text);
    }

    var mt = add(b, 'div', 'meter' + (o.labelTick ? ' hasl' : ''));
    var lim = num(o.limit);
    var top = (Math.max(lim || 0, (o.value === null || o.value === undefined) ? 0 : Math.abs(o.value)) * 1.15) || 1;
    if (o.value !== null && o.value !== undefined) {
      add(mt, 'i', 'fill').style.width = clamp(Math.abs(o.value) / top * 100, 0, 100).toFixed(2) + '%';
    }
    if (lim !== null) {
      var tk = add(mt, 'i', o.labelTick ? 'tick' : 'tick plain');
      tk.style.left = clamp(lim / top * 100, 0, 100).toFixed(2) + '%';
      if (o.labelTick) tk.setAttribute('data-label', 'limit');
      title(tk, 'limit ' + money(lim));
    }
    if (o.over) mt.setAttribute('data-over', '1');

    title(add(b, 'div', 'lim trunc', o.limitText), 'published limit ' + money(o.limit));
    add(b, 'div', 'pct', o.pctText || DASH);
    return b;
  }

  function renderLadder(host, D, S) {
    remember('ladder', host, D, S);
    bindResize(host, 'ladder');
    var R = D && D.risk;
    var pc = controlsOf(host);
    clear(pc);
    clear(host);

    if (!R || !A(R.bars).length) {
      notpub(host, 'limits', 'the limits object is absent from the published export', 'tools/site_data.py', false, true);
      setReadout(host, ['limits not published']);
      return;
    }

    var mode = ui(S, 'rlMode', 'now');
    if (['now', 'peak', 'history'].indexOf(mode) < 0) mode = 'now';
    var unit = ui(S, 'rlUnit', 'usd');
    var showProxy = !!ui(S, 'rlProxy', false);
    var eq = num(R.equity);
    var bars = A(R.bars);
    var peaks = ladderPeaks(D);
    var proxied = 0, j;
    for (j = 0; j < bars.length; j++) if (bars[j].proxy !== null && bars[j].proxy !== undefined) proxied++;

    function asUnit(v) {
      if (v === null || v === undefined) return DASH;
      if (unit === 'pct' && eq) return (v / eq * 100).toFixed(2) + '% eq';
      return money(v, 0);
    }

    segment(pc, RL_MODES, mode, function (k) { setState({ rlMode: k }); });

    /* the unit switch and the proxy toggle sit at the top of the body: a 22px
       header cannot hold three controls and still print its readout */
    var ctl = wrapRow(host, false);
    segment(ctl, [
      { key: 'usd', label: '$', title: 'ceilings in dollars' },
      { key: 'pct', label: '% EQUITY', title: 'ceilings as a percentage of broker equity ' + money(eq) }
    ], unit, function (k) { setState({ rlUnit: k }); });
    if (mode === 'now') {
      chip(ctl, {
        label: 'PROXY', n: proxied, on: showProxy,
        title: 'draw the honestly derivable stand-in on the ' + proxied + ' rows that have one. ' +
          'It is NOT the gate’s own operand; every row names its source and its confidence.',
        onClick: function () { setState({ rlProxy: !showProxy }); }
      });
    }

    if (mode === 'history') {
      notpubFrom(host, D, 'gate_operands', 'series.gates[].d', false, true);
      add(host, 'div', 'prose',
        'HISTORY would draw one utilisation line per ceiling across the ' + (D.gates ? D.gates.n : 0) +
        ' evaluations, against the limit in force at each timestamp as a step. The limits moved mid-contest, ' +
        'so a stored evaluation has to keep citing its own limit; reading today’s ceilings back over old ' +
        'evaluations would be a fabrication, and the English reason strings are not parsed in the browser.');
      setReadout(host, ['history: used side not published · series.gates[].d', 'history: not published', 'not published']);
      setProvenance(host, 'limits · params.risk · history needs series.gates[].d',
        'the six ceilings are published in full; the operands the gates compared against them are not');
      return;
    }

    var drawn = 0, over = 0;
    for (j = 0; j < bars.length; j++) {
      var b = bars[j];
      var lim = num(b.limit);
      var value = null, text = null, soft = false, miss = null, pctTxt = DASH;
      var note;

      if (mode === 'peak') {
        var pk = peaks[b.key];
        if (pk) {
          value = pk.v; text = asUnit(pk.v);
          note = b.label + ' — peak ' + money(pk.v) + '\nsource: ' + pk.src + '\n' + pk.note +
            '\nlimit ' + money(lim) + ' · gate ' + (b.gate || DASH);
          if (lim) pctTxt = (pk.v / lim * 100).toFixed(1) + '%';
          drawn++;
        } else {
          note = b.label;
          miss = (b.key === 'cheap_sleeve' && missingOf(D, 'cheap_sleeve_used'))
            ? missingOf(D, 'cheap_sleeve_used')
            : { path: 'series.gates[].d', why: 'no published series carries a peak for this ceiling' };
        }
      } else {
        note = b.label + ' · gate ' + (b.gate || DASH) + '\nlimit ' + money(lim) +
          (eq ? (' = ' + (lim / eq * 100).toFixed(2) + '% of equity') : '') +
          '\nused: not published — series.gates[].d' +
          (b.params && b.params.length ? ('\nparams: ' + b.params.join(', ')) : '');
        if (showProxy && b.proxy !== null && b.proxy !== undefined) {
          value = b.proxy; text = asUnit(b.proxy); soft = true;
          note += '\nproxy ' + money(b.proxy) + ' — ' + b.proxyLabel + '\nsource: ' + b.proxySrc +
            ' · confidence: ' + b.proxyConfidence + (b.proxyNote ? ('\n' + b.proxyNote) : '');
          if (lim) pctTxt = (b.proxy / lim * 100).toFixed(1) + '%';
          drawn++;
        }
      }
      var isOver = (value !== null && lim && value >= lim);
      if (isOver) over++;
      ladderRow(host, {
        label: b.label, title: note, gate: b.gate,
        value: value, text: text, soft: soft, missing: miss,
        limit: lim, limitText: asUnit(lim), pctText: pctTxt, over: isOver, labelTick: j === 0,
        sel: !!(S && S.sel && S.sel.type === 'gate' && S.sel.id === b.gate)
      });
    }

    if (mode === 'now') notpubFrom(host, D, 'risk_used', 'series.gates[].d');
    else {
      var srcs = [];
      for (j = 0; j < bars.length; j++) if (peaks[bars[j].key]) srcs.push(peaks[bars[j].key].src);
      var uniq = srcs.filter(function (s, i2) { return srcs.indexOf(s) === i2; });
      title(add(host, 'div', 'degen', 'peak sources: ' + uniq.join(' · ')),
        'PEAK is derived from series that ARE published; it is not the gate’s own operand. ' +
        'Each row names its exact source in its tooltip.');
    }

    /* the earned-budget rule, as arithmetic rather than as a slogan */
    var EB = R.earnedBudget || {};
    if (EB.base !== null && EB.base !== undefined) {
      var pr = add(host, 'div', 'prose');
      pr.appendChild(doc.createTextNode('the portfolio worst-case budget starts at '));
      add(pr, 'b', null, ((EB.baseFrac || 0) * 100).toFixed(1) + '%');
      pr.appendChild(doc.createTextNode(' of equity (' + money(EB.base) + ') and is earned toward the '));
      add(pr, 'b', null, ((EB.capFrac || 0) * 100).toFixed(1) + '%');
      pr.appendChild(doc.createTextNode(' cap (' + money(EB.cap) + ') at ' + EB.gainMult + '× realized profit — ' +
        money(EB.realized) + ' realized earns ' + money(EB.earned) + ', so today’s budget is ' +
        money(EB.budget) + '. '));
      var stp = add(pr, 'span', 'stepper');
      var prog = num(EB.progress);
      for (j = 0; j < 3; j++) add(stp, 'i', (prog !== null && prog > j / 3) ? 'on' : null);
      title(pr, EB.formula + '\nprogress from base to cap: ' + (prog === null ? DASH : (prog * 100).toFixed(1) + '%'));
    }

    /* a gauge selects the gate that enforces it (§5 C2) */
    bindOnce(host, '__c2Click', 'click', function (ev) {
      var n = ev.target;
      while (n && n !== host && !(n.classList && n.classList.contains('bullet'))) n = n.parentNode;
      if (!n || n === host) return;
      var g = n.getAttribute('data-gate');
      if (!g) return;
      var Sn = stateOf('ladder', S);
      var off = Sn.sel && Sn.sel.type === 'gate' && Sn.sel.id === g;
      setState({ gate: off ? null : g, sel: off ? null : { type: 'gate', id: g } });
    });

    var line = (mode === 'peak')
      ? (drawn + ' of ' + bars.length + ' peaks derivable')
      : (showProxy ? (drawn + ' proxies drawn · used not published') : 'used: not published');
    setReadout(host, [
      bars.length + ' ceilings · ' + line + ' · drawdown ' + money(R.drawdown) + ' of ' + money(R.limits.drawdown_halt, 0) +
        (over ? (' · ' + over + ' over') : ''),
      bars.length + ' ceilings · ' + line,
      line
    ]);
    setProvenance(host,
      bars.length + ' ceilings · limits · params.risk' +
        (mode === 'peak' ? ' · positions · series.daily · series.gates.wc · series.books.real.eq' : ''),
      'the limits are published in full; series.gates[].d is not, so no bar prints a measured used value. ' +
      (mode === 'peak'
        ? 'PEAK reads only from published series and every row names its own source.'
        : 'PROXY, when on, draws the derivable stand-in and states its confidence.'));
  }

  /* ========================================================================
     3 · C3 — REFUSALS.  The desk's product: what it did not do, and why.
     Three views on one mark, so a judge compares like with like.
     ====================================================================== */

  var RF_VIEWS = [
    { key: 'gate', label: 'GATE', title: 'by gate — first-failure count and the fail rate of each gate' },
    { key: 'kind', label: 'KIND', title: 'by kind — every refusal kind in the journal, not only the gated ones' },
    { key: 'time', label: 'TIME', title: 'over time — refusals per session against that session’s gate evaluations' }
  ];
  var RF_KIND_NOTE = {
    entry_refused: 'a gate refused a sized, priced candidate',
    derisk_mode: 'the desk was in de-risk mode; no new risk is opened at all',
    no_candidate: 'the selector produced nothing that cleared the credit or liquidity floor',
    entry_skipped_duplicate: 'a structure of that shape was already open',
    market_closed: 'the tick ran outside 13:30–20:00 UTC',
    desk_veto: 'the critic vetoed the meeting',
    data_suspect: 'the mark was quarantined as a one-sided quote'
  };

  function refusalRows(D, view) {
    var Rf = D.refusals, G = D.gates, rows = [], j;

    if (view === 'kind') {
      var kinds = A(Rf.byKind).slice().sort(function (a, b) { return b.count - a.count; });
      for (j = 0; j < kinds.length; j++) {
        var share = Rf.n ? kinds[j].count / Rf.n : null;
        rows.push({
          id: kinds[j].kind, label: kinds[j].kind, kind: kinds[j].kind,
          a: kinds[j].count, b: share,
          title: kinds[j].kind + ' — ' + kinds[j].count + ' of ' + Rf.n + ' refusals (' + pct1(share) + ')\n' +
            (RF_KIND_NOTE[kinds[j].kind] || 'refusals.by_kind') + '\nclick to filter the blotter to this kind'
        });
      }
      return rows;
    }

    if (view === 'time') {
      var byDay = TDD.census(Rf.rows, 'day');
      var evalDay = G ? G.dayCensus : {};
      var gatedDay = TDD.census(Rf.rows.filter(function (r) { return r.kind === 'entry_refused'; }), 'day');
      /* the row set is every SESSION the spine knows, not only the sessions
         that produced a refusal: a clean session is a measurement too, and
         dropping it would quietly flatter the rate */
      var days = A(D.spine && D.spine.days).map(function (x) { return x.day; });
      if (!days.length) days = Object.keys(byDay).sort();
      for (j = 0; j < days.length; j++) {
        var d = days[j], ev = num(evalDay[d]) || 0, gd = num(gatedDay[d]) || 0;
        var tot = num(byDay[d]) || 0;
        rows.push({
          id: d, label: d, day: d,
          a: tot, b: ev ? gd / ev : null,
          title: d + ' — ' + tot + ' refusals of every kind' + NL + gd +
            ' of them were gate refusals, against ' + ev + ' gate evaluations that session' +
            (ev ? (' (' + pct1(gd / ev) + ')') : ' — no gate evaluation ran, so there is no rate') +
            NL + 'click to set the page range to this session'
        });
      }
      return rows;
    }

    var g = A(Rf.byGate).slice().sort(function (a, b) { return b.count - a.count || b.matrixFails - a.matrixFails; });
    for (j = 0; j < g.length; j++) {
      rows.push({
        id: g[j].gate, label: g[j].gate, gate: g[j].gate,
        a: g[j].count, b: g[j].rate,
        title: g[j].gate + ' — ' + g[j].label + '\n' + g[j].count +
          ' refusals name it as the first failing gate (of ' + (Rf.total || Rf.gated) + ')\n' +
          g[j].matrixFails + ' failures in ' + g[j].evals + ' evaluations = ' + pct1(g[j].rate) +
          '\nclick to filter the blotter and the matrix to this gate'
      });
    }
    return rows;
  }

  function renderRefusals(host, D, S) {
    remember('refusals', host, D, S);
    bindResize(host, 'refusals');
    var Rf = D && D.refusals;
    var pc = controlsOf(host);
    clear(pc);
    clear(host);

    if (!Rf || !Rf.n) {
      notpub(host, 'series.refusals[]', 'no refusal rows in the published export', 'tools/site_data.py · _series()', false, true);
      setReadout(host, ['refusals not published']);
      return;
    }

    var view = ui(S, 'rfView', 'gate');
    if (['gate', 'kind', 'time'].indexOf(view) < 0) view = 'gate';
    segment(pc, RF_VIEWS, view, function (k) { setState({ rfView: k }); });

    var rows = refusalRows(D, view);
    var selGate = (S && S.gate) || null, selKind = (S && S.kind) || null;
    for (var j = 0; j < rows.length; j++) {
      rows[j].sel = !!((rows[j].gate && rows[j].gate === selGate) || (rows[j].kind && rows[j].kind === selKind));
    }

    var mount = add(host, 'div', null);
    mount.setAttribute('data-bars', view);
    var rowH = 14;
    var w = markWidth(host, 12);
    TDC.barsH(mount, {
      rows: rows,
      w: w, h: rows.length * rowH, rowH: rowH, barH: 4, pairGap: 2,
      labelW: Math.min(126, Math.round(w * 0.38)),
      valueW: Math.min(80, Math.round(w * 0.25)),
      colors: [C.gate, C.soft],
      fmt: {
        a: function (v) { return count(v); },
        b: function (v) { return v === null ? DASH : pct1(v); }
      },
      onRow: function (r) {
        var Sn = stateOf('refusals', S);
        if (r.gate) {
          var off = r.gate === Sn.gate;
          setState({ gate: off ? null : r.gate, kind: null, tab: 'refusals',
                     sel: off ? null : { type: 'gate', id: r.gate } });
        } else if (r.kind) {
          setState({ kind: r.kind === Sn.kind ? null : r.kind, gate: null, tab: 'refusals' });
        } else if (r.day) {
          var dd = null, q;
          for (q = 0; q < D.spine.days.length; q++) if (D.spine.days[q].day === r.day) dd = D.spine.days[q];
          if (dd) setState({ range: [dd.i0, dd.i1], sel: { type: 'day', id: r.day } });
        }
      }
    });

    /* the sentence — the two rankings genuinely disagree, and it matters */
    var bc = Rf.topByCount, br = Rf.topByRate;
    var s = add(host, 'div', 'prose');
    if (bc && br && Rf.rankingsDisagree) {
      s.appendChild(doc.createTextNode('The two rankings disagree. By count '));
      add(s, 'b', null, bc.gate);
      s.appendChild(doc.createTextNode(' is the commonest refusal (' + bc.count + ' of ' +
        (Rf.total || Rf.gated) + ' first failures) yet binds in only ' + bc.matrixFails + ' of ' +
        bc.evals + ' evaluations (' + pct1(bc.rate) + '); by rate '));
      add(s, 'b', null, br.gate);
      s.appendChild(doc.createTextNode(' binds hardest — ' + br.matrixFails + ' of ' + br.evals + ' (' +
        pct1(br.rate) + '). A count and a rate are different questions.'));
    } else if (bc) {
      s.textContent = 'By count and by rate the same gate leads: ' + bc.gate + ', ' + bc.count +
        ' first failures and ' + bc.matrixFails + ' of ' + bc.evals + ' (' + pct1(bc.rate) + ').';
    }

    /* the denominators, stated rather than assumed */
    var kinds = A(Rf.byKind).length;
    var gated = Rf.gated || Rf.total || 0;
    title(add(host, 'div', 'degen',
      Rf.n + ' refusals · ' + kinds + ' kinds · ' + gated + ' gated of ' +
      Rf.denominator.gateEvaluations + ' evaluations · ' + (Rf.n - gated) + ' refused before a gate ran'),
      'refusals.by_kind carries every kind; refusals.total (' + (Rf.total || 0) +
      ') counts only entry_refused. ' + Rf.firstFailureNote + '. ' + Rf.denominator.note + '.');

    if (selGate || selKind) {
      var clr = wrapRow(host, false);
      chip(clr, {
        label: 'FILTER ✕ ' + (selGate || selKind), cls: 'clear', on: true,
        title: 'clear the refusal filter',
        onClick: function () { setState({ gate: null, kind: null }); }
      });
    }

    setReadout(host, [
      Rf.n + ' refusals · ' + kinds + ' kinds · ' + gated + ' gated · top ' +
        (br ? (br.gate + ' ' + pct1(br.rate)) : DASH),
      Rf.n + ' refusals · ' + kinds + ' kinds · ' + gated + ' gated',
      Rf.n + ' · ' + gated + ' gated · ' + kinds + ' kinds',
      Rf.n + ' · ' + kinds + ' kinds'
    ]);
    setProvenance(host,
      Rf.n + ' refusals · ' + kinds + ' kinds · refusals.by_kind · refusals.by_gate · series.gates[]',
      Rf.firstFailureNote + ' · ' + Rf.denominator.note + ' · gate evaluations ' +
      Rf.denominator.gateEvaluations + ', ticks ' + Rf.denominator.ticks +
      ', spine ticks ' + Rf.denominator.spineTicks);
  }

  /* ========================================================================
     4 · C4 — BLOTTER
     ====================================================================== */

  var TABS = [
    { key: 'decisions', label: 'DEC', full: 'DECISIONS' },
    { key: 'refusals', label: 'REF', full: 'REFUSALS' },
    { key: 'positions', label: 'POS', full: 'POSITIONS' },
    { key: 'trades', label: 'TRD', full: 'TRADES' },
    { key: 'gates', label: 'GATE', full: 'GATE EVALS' },
    { key: 'desk', label: 'DESK', full: 'DESK MEETINGS' },
    { key: 'integrity', label: 'INTEG', full: 'INTEGRITY' },
    { key: 'all', label: 'ALL', full: 'ALL' }
  ];
  var SRC = {
    decisions: 'decisions[]', refusals: 'series.refusals[]', positions: 'positions.*',
    trades: 'trades[]', gates: 'series.gates[]', desk: 'series.desk[]',
    integrity: 'series.integrity[]', all: 'decisions[] + series.*'
  };

  var COLS = {
    t:      { key: 't',      label: 'TIME',        w: 58 },
    kind:   { key: 'kind',   label: 'KIND',        w: 94 },
    id:     { key: 'id',     label: 'ID',          w: 68, cls: 'col-structure' },
    action: { key: 'action', label: 'GATE/ACTION', w: 96 },
    reason: { key: 'reason', label: 'REASON',      w: 0 },
    pnl:    { key: 'pnl',    label: 'Δ/P&L',       w: 70, num: true }
  };
  function columnsFor(w) {
    if (w >= 620) return [COLS.t, COLS.kind, COLS.id, COLS.action, COLS.reason, COLS.pnl];
    if (w >= 452) return [COLS.t, COLS.kind, COLS.action, COLS.reason, COLS.pnl];
    return [COLS.t, COLS.kind, COLS.reason, COLS.pnl];
  }

  function textOf(r) {
    return ((r.kind || '') + ' ' + (r.label || '') + ' ' + (r.id || '') + ' ' +
            (r.action || '') + ' ' + (r.gate || '') + ' ' + (r.reason || '')).toLowerCase();
  }

  /* the whole filter pipeline, exposed so app.js counts exactly what C4 shows */
  function blotterView(D, S) {
    S = S || {};
    var tab = S.tab || 'decisions';
    if (!D || !D.blotter || !D.blotter.by[tab]) tab = 'decisions';
    var rows = A(D.blotter.by[tab]);
    var total = rows.length;
    var gate = S.gate || null, kind = S.kind || null;
    var q = String(S.q || '').trim().toLowerCase();
    var from = S.from || '', to = S.to || '';
    var scoped = !!(S.locked && S.cur !== null && S.cur !== undefined);
    var out = [], j;

    for (j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (gate && r.gate !== gate) continue;
      if (kind && r.kind !== kind) continue;
      if (from && r.day && r.day < from) continue;
      if (to && r.day && r.day > to) continue;
      if (scoped && (r.i === null || r.i === undefined || Math.abs(r.i - S.cur) > 1)) continue;
      if (q && textOf(r).indexOf(q) < 0) continue;
      out.push(r);
    }
    out.sort(function (a, b) { return a.ms - b.ms || (a.key < b.key ? -1 : 1); });
    return {
      tab: tab, rows: out, total: total, scoped: scoped,
      filters: (gate ? 1 : 0) + (kind ? 1 : 0) + (q ? 1 : 0) + (from ? 1 : 0) + (to ? 1 : 0) + (scoped ? 1 : 0)
    };
  }

  function flatten(r) {
    return { run: false, n: 1, t: r.t, t1: r.t, ms: r.ms, i: r.i, day: r.day, kind: r.kind,
             label: r.label, id: r.id, action: r.action, reason: r.reason, gate: r.gate,
             sev: r.sev, sel: r.sel, pnl: r.pnl, members: [r], head: r };
  }
  function runKey(run) { return run.kind + '|' + run.action + '|' + run.reason + '|' + run.t; }
  function sortVal(r, key) {
    if (key === 't') return r.ms;
    if (key === 'pnl') return (r.pnl === null || r.pnl === undefined) ? null : r.pnl;
    if (key === 'kind') return r.label || r.kind || '';
    return String(r[key] || '');
  }

  function displayRows(view, S) {
    var collapse = ui(S, 'blCollapse', true) !== false;
    var openMap = ui(S, 'blOpen', null) || {};
    var out = [], j, z;
    if (collapse) {
      var runs = TDD.collapseRuns(view.rows);
      for (j = 0; j < runs.length; j++) {
        out.push(runs[j]);
        if (runs[j].n > 1 && openMap[runKey(runs[j])]) {
          for (z = 0; z < runs[j].members.length; z++) {
            var m = flatten(runs[j].members[z]);
            m.sub = true;
            out.push(m);
          }
        }
      }
    } else {
      for (j = 0; j < view.rows.length; j++) out.push(flatten(view.rows[j]));
    }
    var sort = ui(S, 'blSort', 't'), dir = ui(S, 'blDir', 'desc');
    if (sort !== 't') {
      out.sort(function (a, b) {
        var va = sortVal(a, sort), vb = sortVal(b, sort);
        if (va === vb) return a.ms - b.ms;
        if (va === null) return 1;
        if (vb === null) return -1;
        return (va < vb ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      });
    } else if (dir === 'desc') {
      out.reverse();
    }
    return out;
  }

  /* the skeleton is built once and updated in place, so typing in the search
     box survives every render pass §7.2 triggers */
  function skeleton(host) {
    var sk = host.__bl;
    if (sk && sk.root && sk.root.parentNode === host) return sk;
    clear(host);
    sk = host.__bl = {};
    sk.root = add(host, 'div', null);
    sk.root.setAttribute('data-blotter', '1');

    sk.tabs = wrapRow(sk.root, true);
    sk.tabs.setAttribute('data-tabs', '1');

    sk.find = wrapRow(sk.root, false);
    sk.find.setAttribute('data-find', '1');

    var srch = add(sk.find, 'label', 'srch');
    sk.q = add(srch, 'input', 'inp');
    sk.q.type = 'search';
    sk.q.id = 'bl-search';
    sk.q.placeholder = 'search reasons…';
    sk.q.setAttribute('data-blotter-search', '1');
    sk.q.setAttribute('aria-label', 'search the blotter reasons');
    sk.q.addEventListener('input', function () { setState({ q: sk.q.value }); });

    sk.from = add(sk.find, 'input', 'inp');
    sk.from.type = 'date';
    sk.from.title = 'from (UTC day)';
    sk.from.setAttribute('aria-label', 'from date');
    sk.from.addEventListener('change', function () { setState({ from: sk.from.value }); });

    sk.to = add(sk.find, 'input', 'inp');
    sk.to.type = 'date';
    sk.to.title = 'to (UTC day)';
    sk.to.setAttribute('aria-label', 'to date');
    sk.to.addEventListener('change', function () { setState({ to: sk.to.value }); });

    sk.pills = wrapRow(sk.root, true);
    sk.pills.setAttribute('data-pills', '1');

    sk.table = add(sk.root, 'table', 'tbl');
    sk.thead = add(sk.table, 'thead');
    sk.headRow = add(sk.thead, 'tr');
    sk.tbody = add(sk.table, 'tbody');
    return sk;
  }

  /* THIS VIEW is pinned under the table: it is a sibling of the body, in the
     panel's own auto grid row, so the table scrolls beneath it (§5 C4). */
  function thisViewEl(host) {
    var p = panelOf(host);
    if (!p) return null;
    var e = null, j;
    for (j = 0; j < p.children.length; j++) {
      if (p.children[j].hasAttribute && p.children[j].hasAttribute('data-thisview')) { e = p.children[j]; break; }
    }
    if (!e) {
      e = el('div', 'thisview');
      e.setAttribute('data-thisview', '1');
      var pf = p.querySelector('.pf');
      if (pf) p.insertBefore(e, pf); else p.appendChild(e);
    }
    var accs = p.getAttribute('data-accs');
    showRow(e, !(accs === 'above' || accs === 'below'));
    /* .p is display:grid with an implicit AUTO column, so any child whose
       max-content is wider than the panel widens the track and drags .pb out
       with it — .pb survives on its own because it is a scroll container,
       this line is not.  Cap it at the panel, which #body sizes at 1fr. */
    e.style.maxWidth = (p.clientWidth || 0) + 'px';
    return e;
  }

  function rowHeight() {
    try {
      var n = parseFloat(global.getComputedStyle(doc.documentElement).getPropertyValue('--rowh'));
      if (n > 0) return n;
    } catch (e) {}
    return 18;
  }

  function spacer(tbody, ncols, h) {
    if (h <= 0) return;
    var tr = add(tbody, 'tr');
    tr.setAttribute('aria-hidden', 'true');
    tr.setAttribute('data-spacer', '1');
    var td = add(tr, 'td');
    td.setAttribute('colspan', ncols);
    td.style.height = h + 'px';
    td.style.padding = '0';
    td.style.borderWidth = '0';
  }

  function rowNode(tbody, r, cols, sel) {
    var tr = add(tbody, 'tr', r.sub ? 'sub' : null);
    var head = r.head || r;
    tr.setAttribute('tabindex', '-1');
    tr.setAttribute('data-key', head.key || '');
    if (r.i !== null && r.i !== undefined) tr.setAttribute('data-i', r.i);
    if (head.d !== null && head.d !== undefined) tr.setAttribute('data-raw', '1');
    if (sameSel(sel, r.sel)) tr.setAttribute('data-sel', '1');
    else if (sel && r.sel && sel.type === r.sel.type &&
             (sel.type === 'structure' || sel.type === 'gate')) tr.setAttribute('data-dim', '1');

    var full = (r.label || r.kind) + '\n' + ts(r.t, 'full') +
      (r.n > 1 ? (' → ' + ts(r.t1, 'full') + ' · ×' + r.n + ' identical reasons') : '') +
      (r.id ? ('\n' + r.id) : '') + (r.gate ? ('\ngate ' + r.gate) : '') +
      (r.action ? ('\n' + r.action) : '') + (r.reason ? ('\n' + r.reason) : '') +
      ((r.pnl === null || r.pnl === undefined) ? '' : ('\n' + usd(r.pnl))) +
      '\nclick selects · Enter or double-click opens ' +
      ((head.d !== null && head.d !== undefined) ? 'the raw journal record' : 'the exported row');

    for (var j = 0; j < cols.length; j++) {
      var col = cols[j];
      var td = add(tr, 'td', (col.num ? 'num' : '') + (col.cls ? (' ' + col.cls) : '') +
                             (col.key === 'id' ? ' id' : ''));
      if (col.key === 't') {
        td.textContent = r.n > 1 ? (ts(r.t, 'hm') + '→' + ts(r.t1, 'hm')) : ts(r.t, 'hm');
        td.setAttribute('title', ts(r.t, 'full') + (r.n > 1 ? (' → ' + ts(r.t1, 'full')) : ''));
      } else if (col.key === 'kind') {
        td.textContent = r.label || r.kind;
        if (r.sev && r.sev !== 'default') td.setAttribute('data-sev', r.sev === 'manage' ? 'soft' : r.sev);
      } else if (col.key === 'id') {
        td.textContent = r.id ? String(r.id).slice(0, 8) : '';
      } else if (col.key === 'action') {
        td.textContent = r.action || r.gate || '';
      } else if (col.key === 'reason') {
        td.textContent = r.reason || '';
        if (r.n > 1) {
          var b = add(td, 'span', 'badge', '×' + r.n);
          b.setAttribute('data-run', '1');
          b.setAttribute('title', 'a run of ' + r.n + ' consecutive rows with this exact reason, ' +
            ts(r.t, 'hm') + ' → ' + ts(r.t1, 'hm') + ' — click to list them');
        }
      } else if (col.key === 'pnl') {
        var v = (r.pnl === null || r.pnl === undefined)
          ? ((r.n > 1 && r.pnlSum !== null && r.pnlSum !== undefined) ? r.pnlSum : null)
          : r.pnl;
        td.textContent = v === null ? '' : usd(v);
      }
      if (col.key !== 't') td.setAttribute('title', full);
    }
    tr.__row = r;
    return tr;
  }

  function paintWindow(host, sk, cols, rows, S, force) {
    var rh = rowHeight();
    var tbodyTop = sk.tbody.offsetTop || 0;
    var vis = Math.ceil((host.clientHeight || 140) / rh) + 12;
    var first = clamp(Math.floor(((host.scrollTop || 0) - tbodyTop) / rh) - 6, 0, Math.max(0, rows.length - 1));
    var n = Math.max(0, Math.min(vis, rows.length - first));
    var sig = first + ':' + n + ':' + rows.length + ':' + cols.length;
    if (!force && sk.winSig === sig) return;
    sk.winSig = sig;

    clear(sk.tbody);
    if (!rows.length) {
      var td0 = add(add(sk.tbody, 'tr'), 'td');
      td0.setAttribute('colspan', cols.length);
      notpub(td0, SRC[(S && S.tab) || 'decisions'] || 'decisions[]',
        'no row in this tab matches the current filters',
        'clear the filters to see the tab whole again');
      return;
    }
    spacer(sk.tbody, cols.length, first * rh);
    var sel = (S && S.sel) || null;
    for (var j = first; j < first + n; j++) rowNode(sk.tbody, rows[j], cols, sel);
    spacer(sk.tbody, cols.length, (rows.length - first - n) * rh);
  }

  function paintThisView(host, D, S, view, rows) {
    var tv = thisViewEl(host);
    if (!tv) return;
    clear(tv);
    var st = TDD.viewStats(view.rows);
    var tabDef = null, j;
    for (j = 0; j < TABS.length; j++) if (TABS[j].key === view.tab) tabDef = TABS[j];

    var txt = st.n + ' ' + (tabDef ? tabDef.full.toLowerCase() : view.tab) + ' — ' +
      st.orders + (st.orders === 1 ? ' order' : ' orders') + ', ' + st.refused + ' refused.';
    if (st.topGate) txt += ' Most refused: ' + st.topGate.gate + ' (' + st.topGate.n + ').';
    if (st.from && st.to) {
      var d0 = ts(st.from, 'md'), d1 = ts(st.to, 'md');
      txt += ' Window ' + d0 + ' ' + ts(st.from, 'hm') +
        (d0 === d1 ? ('–' + ts(st.to, 'hm')) : (' → ' + d1 + ' ' + ts(st.to, 'hm'))) + '.';
    }
    if (view.scoped) txt += ' ±1 tick of the locked cursor.';
    /* One line where the panel is short, two where it can afford them; the
       whole sentence is always in the title, and every count in it is also
       in the header readout or in C3. */
    var tall = roomFor(host, 0) >= 230;
    var span = add(tv, 'span', tall ? null : 'trunc', txt);
    title(span, txt + NL + rows.length + ' rows drawn after run-collapsing · ' +
      ts(st.from, 'full') + ' → ' + ts(st.to, 'full') +
      (st.pnl && st.pnl.n ? (NL + 'P&L over ' + st.pnl.n + ' rows: ' + usd(st.pnl.sum)) : ''));

    /* the 90px sparkline is a nicety; below 420px the sentence needs the room */
    var per = st.perDay;
    if ((tv.clientWidth || 0) < 420 || !per || !per.length) return;
    var sp = add(tv, 'span', 'spark');
    if (per.length > 1) {
      TDC.spark(sp, {
        pts: per.map(function (p) { return p.n; }),
        w: 90, h: 18, mode: 'bars', color: C.soft, mark: 'none',
        title: per.map(function (p) { return p.day + ' ' + p.n; }).join(' · ')
      });
    } else {
      sp.className = 'lab';
      sp.textContent = per[0].day + ' · ' + per[0].n;
    }
  }

  function renderBlotter(host, D, S) {
    remember('blotter', host, D, S);
    if (!D || !D.blotter) {
      clear(host);
      notpub(host, 'decisions[]', 'no journal rows in the published export', 'tools/site_data.py', false, true);
      setReadout(host, ['journal not published']);
      return;
    }
    var pc = controlsOf(host);
    clear(pc);

    var collapse = ui(S, 'blCollapse', true) !== false;
    var view = blotterView(D, S);
    var rows = displayRows(view, S);
    var counts = D.blotter.counts;
    var sk = skeleton(host);
    var j;
    bindResize(host, 'blotter');

    /* ---- header controls ---- */
    chip(pc, {
      label: 'RUNS', on: collapse,
      title: 'fold consecutive rows with an identical reason into one ×N row carrying a time range. ' +
        'Order, fill, position and trade rows never fold.',
      onClick: function () { setState({ blCollapse: !collapse }); }
    });
    var csvBtn = iconBtn(pc, '⇩', 'export these ' + rows.length + ' rows as CSV (x)', function () {
      exportBlotter(csvBtn);
    });

    /* ---- tabs ---- */
    clear(sk.tabs);
    for (j = 0; j < TABS.length; j++) {
      (function (t, n) {
        chip(sk.tabs, {
          label: t.label, n: counts[t.key], on: view.tab === t.key,
          title: t.full + ' — ' + counts[t.key] + ' rows · ' + (SRC[t.key] || '') + ' · key ' + n,
          onClick: function () { setState({ tab: t.key }); }
        });
      })(TABS[j], j + 1);
    }

    /* ---- search and dates: never overwrite what the user is typing ---- */
    if (doc.activeElement !== sk.q && sk.q.value !== (S.q || '')) sk.q.value = S.q || '';
    if (doc.activeElement !== sk.from) sk.from.value = S.from || '';
    if (doc.activeElement !== sk.to) sk.to.value = S.to || '';
    /* two date inputs are 180px of a 349px column; below that width they are
       dropped rather than allowed to squeeze the search box out of existence,
       and the range is still reachable from the day rows in A2 and C3 */
    var wideEnough = bw >= 452 || !!(S.from || S.to);
    sk.from.hidden = !wideEnough;
    sk.to.hidden = !wideEnough;

    /* ---- contextual pills ---- */
    clear(sk.pills);
    var shownPills = 0;
    var Rf = D.refusals;
    if ((view.tab === 'refusals' || view.tab === 'gates') && Rf && A(Rf.byGate).length) {
      var gs = A(Rf.byGate).slice().sort(function (a, b) { return b.count - a.count; });
      for (j = 0; j < gs.length; j++) {
        (function (row) {
          chip(sk.pills, {
            label: row.gate, n: row.count, on: S.gate === row.gate,
            title: row.label + ' · ' + row.count + ' first failures · ' + row.matrixFails +
              ' of ' + row.evals + ' evaluations (' + pct1(row.rate) + ')',
            onClick: function () { setState({ gate: S.gate === row.gate ? null : row.gate, kind: null }); }
          });
        })(gs[j]);
        shownPills++;
      }
    } else {
      var cen = TDD.census(view.rows, 'kind');
      var keys = Object.keys(cen).sort(function (a, b) { return cen[b] - cen[a]; });
      /* the kind pills earn their row only where the table can still show
         rows underneath them; a kind is always reachable from C3's BY KIND */
      if (keys.length > 1 && (roomFor(host, 186) >= 60 || S.kind)) {
        for (j = 0; j < keys.length && j < 9; j++) {
          (function (kk) {
            chip(sk.pills, {
              label: TDD.KIND_LABEL[kk] || kk.toUpperCase().replace(/_/g, ' '),
              n: cen[kk], on: S.kind === kk,
              title: kk + ' · ' + cen[kk] + ' rows in this view',
              onClick: function () { setState({ kind: S.kind === kk ? null : kk }); }
            });
          })(keys[j]);
          shownPills++;
        }
      }
    }
    if (view.filters) {
      chip(sk.pills, {
        label: 'FILTERS ✕', n: view.filters, cls: 'clear', on: true,
        title: 'clear every blotter filter' + (view.scoped ? ', including the ±1 tick cursor scope' : ''),
        onClick: function () {
          setState({ gate: null, kind: null, q: '', from: '', to: '', locked: false });
          if (TDC && TDC.cursor) TDC.cursor.unlock();
        }
      });
      shownPills++;
    }
    showRow(sk.pills, !!shownPills);

    /* ---- sortable sticky head ---- */
    var bw = markWidth(host, 0);
    var cols = columnsFor(bw);
    var sort = ui(S, 'blSort', 't'), dir = ui(S, 'blDir', 'desc');
    clear(sk.headRow);
    for (j = 0; j < cols.length; j++) {
      (function (col) {
        var th = add(sk.headRow, 'th',
          (col.num ? 'num' : '') + (col.cls ? (' ' + col.cls) : ''), col.label);
        if (col.w) th.style.width = col.w + 'px';
        th.setAttribute('aria-sort', sort === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
        th.setAttribute('title', 'sort by ' + col.label +
          (col.key === 't' ? ' — descending is NEWEST FIRST' : ''));
        th.addEventListener('click', function () {
          if (sort === col.key) setState({ blDir: dir === 'asc' ? 'desc' : 'asc' });
          else setState({ blSort: col.key, blDir: col.key === 't' ? 'desc' : 'asc' });
        });
      })(cols[j]);
    }

    /* ---- windowed body: 900 rows, ~20 nodes ---- */
    var sig = view.tab + '|' + view.filters + '|' + sort + dir + collapse + '|' + rows.length;
    if (sk.viewSig !== sig) { sk.viewSig = sig; host.scrollTop = 0; }
    paintWindow(host, sk, cols, rows, S, true);
    bindOnce(host, '__c4Scroll', 'scroll', function () { paintWindow(host, sk, cols, rows, S, false); });

    paintThisView(host, D, S, view, rows);

    /* ---- readout and provenance ---- */
    var tabDef = null;
    for (j = 0; j < TABS.length; j++) if (TABS[j].key === view.tab) tabDef = TABS[j];
    setReadout(host, [
      tabDef.full + ' · ' + rows.length + ' rows of ' + view.rows.length + ' matching · ' +
        view.total + ' in tab' + (view.filters ? (' · ' + view.filters + ' filters') : ''),
      tabDef.full + ' · ' + rows.length + ' of ' + view.total,
      rows.length + '/' + view.total
    ]);
    var cov = D.blotter.coverage;
    setProvenance(host,
      view.total + ' rows · ' + (SRC[view.tab] || 'decisions[]') +
        (cov.truncated && view.tab === 'decisions' ? (' · newest ' + cov.decisions + ' of ' + cov.journalTotal) : ''),
      cov.note + '\n' + D.blotter.vetoNote + '\nseverity is applied by kind, never by sentiment.');
  }

  /* one delegated handler per host, installed once */
  function bindBlotterEvents(host) {
    bindOnce(host, '__c4Click', 'click', function (ev) {
      var t = ev.target;
      if (t && t.classList && t.classList.contains('badge') && t.getAttribute('data-run')) {
        var tr0 = climb(t, 'TR');
        var r0 = tr0 && tr0.__row;
        if (r0 && r0.n > 1) {
          var S0 = stateOf('blotter', null);
          var src = ui(S0, 'blOpen', null) || {}, map = {}, k;
          for (k in src) if (has(src, k)) map[k] = src[k];
          var rk = runKey(r0);
          if (map[rk]) delete map[rk]; else map[rk] = 1;
          setState({ blOpen: map });
        }
        ev.stopPropagation();
        return;
      }
      var tr = climb(t, 'TR');
      var r = tr && tr.__row;
      if (!r || !r.sel) return;
      try { tr.focus(); } catch (e) {}
      var S = stateOf('blotter', null);
      var already = sameSel(S.sel, r.sel);
      setState({ sel: already ? null : r.sel });
      if (!already && r.i !== null && r.i !== undefined && TDC && TDC.cursor) TDC.cursor.set(r.i, 'c4');
    });
    bindOnce(host, '__c4Dbl', 'dblclick', function (ev) {
      var tr = climb(ev.target, 'TR');
      if (tr && tr.__row) openDrawer(tr.__row);
    });
    bindOnce(host, '__c4Key', 'keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      var tr = climb(ev.target, 'TR');
      if (tr && tr.__row) { ev.preventDefault(); openDrawer(tr.__row); }
    });
    /* §6.7 bidirectional hover — a blotter row moves the page cursor */
    bindOnce(host, '__c4Hover', 'mouseover', function (ev) {
      var tr = climb(ev.target, 'TR');
      if (!tr || !tr.__row) return;
      var i = tr.__row.i;
      if (i !== null && i !== undefined && TDC && TDC.cursor) TDC.cursor.set(i, 'c4');
    });
  }
  function climb(n, tag) {
    while (n && n.nodeType === 1 && n.tagName !== tag) n = n.parentNode;
    return (n && n.nodeType === 1 && n.tagName === tag) ? n : null;
  }

  /* the raw-record drawer.  72 of the 900 decisions carry the journal object
     itself in 'd'; every other row can only offer the exported row, and the
     label says which one the drawer is showing. */
  function openDrawer(r) {
    var head = r.head || r;
    var journal = (head.d !== null && head.d !== undefined);
    var raw = journal ? head.d : head.raw;
    if (raw === null || raw === undefined) return;
    var label = (head.label || head.kind || 'record') + ' · ' + ts(head.t, 'full') +
      (journal ? ' · raw journal record' : ' · exported row (no raw record published for this kind)');
    var TD = global.TD;
    if (TD && typeof TD.drawer === 'function') { TD.drawer(raw, label); return; }
    if (head.sel) setState({ sel: head.sel });
  }

  function exportBlotter(btn) {
    var rec = LAST.blotter;
    if (!rec) return null;
    var view = blotterView(rec.D, rec.S);
    var rows = displayRows(view, rec.S);
    var out = rows.map(function (r) {
      return {
        t: r.t, t_end: r.n > 1 ? r.t1 : '', n: r.n || 1, tick: r.i,
        kind: r.kind, label: r.label, id: r.id, gate: r.gate || '',
        action: r.action, reason: r.reason,
        pnl: (r.pnl === null || r.pnl === undefined)
          ? ((r.pnlSum === null || r.pnlSum === undefined) ? '' : r.pnlSum) : r.pnl
      };
    });
    var cols = ['t', 't_end', 'n', 'tick', 'kind', 'label', 'id', 'gate', 'action', 'reason', 'pnl'];
    var res = TDC.csv(out, cols, 'theta-desk-' + view.tab + '.csv');
    function flash(r) {
      if (!btn) return;
      var was = btn.textContent;
      btn.textContent = r.copied ? ('copied ' + r.rows) : (r.downloaded ? ('saved ' + r.rows) : 'no clipboard');
      btn.setAttribute('title',
        (r.downloaded ? ('download started · ') : '') +
        (r.copied ? ('copied ' + r.rows + ' rows, ' + r.bytes + ' bytes, to the clipboard')
                  : 'the clipboard refused the write'));
      global.setTimeout(function () { btn.textContent = was; }, 1600);
    }
    if (res && typeof res.then === 'function') res.then(flash); else flash(res || { rows: out.length });
    return out.length;
  }

  /* ========================================================================
     5 · EXPORTS
     ====================================================================== */

  function guard(name, fn) {
    return function (host, D, S) {
      if (!host) return;
      try { fn(host, D, S || {}); }
      catch (e) {
        report(e, name);
        try { clear(host); failBox(host, 'panels-c.js · TDP.' + name, (e && e.message) ? e.message : e); }
        catch (e2) {}
      }
    };
  }

  Object.assign(window.TDP, {
    matrix: guard('matrix', renderMatrix),
    ladder: guard('ladder', renderLadder),
    refusals: guard('refusals', renderRefusals),
    blotter: guard('blotter', function (host, D, S) {
      bindBlotterEvents(host);
      renderBlotter(host, D, S);
    }),

    /* app.js keyboard hooks (§7.5) */
    blotterExport: function () { return exportBlotter(null); },
    blotterFocus: function () {
      var rec = LAST.blotter;
      var q = (rec && rec.host && rec.host.__bl) ? rec.host.__bl.q : null;
      if (!q) return false;
      try { q.focus(); q.select(); } catch (e) {}
      return true;
    },
    blotterOpenSelected: function () {
      var rec = LAST.blotter;
      if (!rec || !rec.host || !rec.host.__bl) return false;
      var tr = rec.host.__bl.tbody.querySelector('tr[data-sel="1"]');
      if (!tr || !tr.__row) return false;
      openDrawer(tr.__row);
      return true;
    },
    /* the exact rows C4 is showing, for anything that needs the same view */
    blotterView: function (D, S) {
      var v = blotterView(D, S);
      v.display = displayRows(v, S || {});
      return v;
    },
    blotterTabs: TABS
  });

})(typeof window !== 'undefined' ? window : this);
