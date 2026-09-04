/* ===========================================================================
   THETA DESK — app.js — window.TD

   The only file allowed to touch location.hash, localStorage, window/document
   listeners, or fetch (SPEC 2.5).  Everything it owns:

     · the S state object and TD.set(), the single setter          (SPEC 7.1, 7.2)
     · one registration table and ONE render pass over it          (SPEC 7.2)
     · the selection router and its history                        (SPEC 7.3)
     · the page-wide filters and the FILTERS chip's contract       (SPEC 7.4)
     · the complete keyboard map, and the ? overlay generated
       from the same table so the two can never disagree           (SPEC 7.5)
     · the hash router, read on load and on hashchange, written
       once per frame with replaceState                            (SPEC 7.6)
     · loading, liveness and the manual refresh — no auto-timer
       on the DATA, one 30s timer on the CLOCK                     (SPEC 7.7)
     · judge mode, including the three annotations column C does
       not carry (C1 g8, C3 taxonomy, C4 decision chain)           (SPEC 7.8)
     · persistence: five localStorage keys, all try/catch          (SPEC 7.9)
     · the raw-record drawer, the keymap overlay, the breakpoint
       and density controllers, the S-breakpoint accordion, and
       the M/S inspector drawer                                    (SPEC 4.3-4.5)
     · the boot sequence: window.__DATA__ else fetch               (SPEC 2.6)

   HOUSE RULES OBSERVED HERE
     · Not one hex literal and not one colour name.  `make lint-hex` clean.
     · The integrity green is never named.  `make lint-green` clean.
     · Classic script.  No module, no defer, no async, no external anything.
     · A renderer that throws is contained: its panel keeps its cell and
       renders the SPEC 3.6 empty state with the thrown message named.
     · Hover never reaches this file.  TDC.cursor moves overlays; only a LOCK
       is published here, and from here into the hash and the inspector.
   =========================================================================== */

(function (global, doc) {
'use strict';

var TDC = global.TDC;
var TDD = global.TDD;
var TDP = global.TDP || (global.TDP = {});

/* ---------------------------------------------------------------------------
   0 · SMALL UTILITIES
   --------------------------------------------------------------------------- */

function byId(id) { return doc.getElementById(id); }
function qs(sel, root) { return (root || doc).querySelector(sel); }
function qsa(sel, root) {
  var l = (root || doc).querySelectorAll(sel), a = [], i;
  for (i = 0; i < l.length; i++) a.push(l[i]);
  return a;
}
function mk(tag, cls, text) {
  var n = doc.createElement(tag || 'div');
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function clear(n) { if (n) while (n.firstChild) n.removeChild(n.firstChild); }
function attr(n, k, v) {
  if (!n) return n;
  if (v === null || v === undefined || v === false) n.removeAttribute(k);
  else n.setAttribute(k, String(v));
  return n;
}
function esc(s) {
  if (TDC && TDC.esc) return TDC.esc(s);
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function closestEl(el, sel) {
  while (el && el.nodeType === 1) {
    if (el.matches ? el.matches(sel)
                   : (el.msMatchesSelector && el.msMatchesSelector(sel))) return el;
    el = el.parentNode;
  }
  return null;
}
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function warn() {
  if (!global.console || !console.warn) return;
  console.warn.apply(console, arguments);
}

/* fmt is used only for the judge annotations and the refresh readout. */
var F = (TDC && TDC.fmt) || {
  count: function (v) { return String(v); },
  num: function (v, d) { return Number(v).toFixed(d || 0); },
  usd: function (v) { return String(v); },
  pct: function (v, d) { return (Number(v) * 100).toFixed(d == null ? 2 : d) + '%'; },
  vol: function (v) { return Number(v).toFixed(4); },
  greek: function (v) { return Number(v).toFixed(2); },
  ts: function (t) { return String(t); },
  DASH: '—'
};

/* ---------------------------------------------------------------------------
   1 · CONSTANTS
   --------------------------------------------------------------------------- */

var DECKS = ['strikes', 'paths', 'funnel', 'params', 'claims'];
var BASES = ['abs', 'nogates', 'nohedge', 'naive'];
var BOOKS_ALL = ['real', 'shadow_nogates', 'shadow_nohedge', 'baseline_naive'];
var TABS = ['decisions', 'refusals', 'positions', 'trades', 'gates', 'desk', 'integrity', 'all'];

/* Panels that become the right-rail accordion at the S breakpoint, in the
   order SPEC 4.4 lists them.  One slot per panel: the CSS pins a collapsed
   slot at 22px and every panel keeps its own identity and its own readout. */
var ACCORDION = ['p-tree', 'p-matrix', 'p-ladder', 'p-refusals', 'p-recon',
                 'p-integrity', 'p-trades', 'p-deck', 'p-authority', 'p-weakness'];

/* localStorage keys — SPEC 7.9 names exactly these five and nothing else. */
var LS = {
  density: 'td_density',
  axis: 'td_axis',
  deck: 'td_deck',
  treeGroups: 'td_tree_groups',
  accordion: 'td_accordion'
};

/* The keyboard map (SPEC 7.5).  ONE table: it drives the handler, the ?
   overlay and the footer's title attribute, so the three can never drift.
   `k` is authored markup (no user data ever reaches it); `t` is its plain
   text twin for the title attribute. */
var KEYMAP = [
  { t: '1–8',        k: '<kbd>1</kbd>–<kbd>8</kbd>',                     d: 'blotter tabs' },
  { t: '←/→',        k: '<kbd>←</kbd> <kbd>→</kbd>',                     d: 'step the cursor one tick' },
  { t: 'Shift+←/→',  k: '<kbd>⇧</kbd>+<kbd>←</kbd> <kbd>→</kbd>',        d: 'step one session' },
  { t: 'Home/End',   k: '<kbd>Home</kbd> <kbd>End</kbd>',                d: 'first / last tick in range' },
  { t: '.',          k: '<kbd>.</kbd>',                                  d: 'lock / unlock the cursor' },
  { t: '[ ]',        k: '<kbd>[</kbd> <kbd>]</kbd>',                     d: 'cycle the deck sub-view' },
  { t: 'd',          k: '<kbd>d</kbd>',                                  d: 'density — comfortable / compact' },
  { t: 'j',          k: '<kbd>j</kbd>',                                  d: 'judge mode — the inline annotations' },
  { t: 'a',          k: '<kbd>a</kbd>',                                  d: 'axis mode — session / time' },
  { t: 'u',          k: '<kbd>u</kbd>',                                  d: 'quality — all marks / clean only' },
  { t: 'b',          k: '<kbd>b</kbd>',                                  d: 'cycle the ablation baseline' },
  { t: 'i',          k: '<kbd>i</kbd>',                                  d: 'focus the inspector (opens the drawer at M and S)' },
  { t: 'f',          k: '<kbd>f</kbd>',                                  d: 'focus the blotter search' },
  { t: 'c',          k: '<kbd>c</kbd>',                                  d: 'copy a link to this exact view' },
  { t: 'x',          k: '<kbd>x</kbd>',                                  d: 'export the current blotter view as CSV' },
  { t: '?',          k: '<kbd>?</kbd>',                                  d: 'this card' },
  { t: 'Esc',        k: '<kbd>Esc</kbd>',                                d: 'unwind: overlay → selection → cursor lock' }
];

/* ---------------------------------------------------------------------------
   2 · PERSISTENCE (SPEC 7.9) — every read and every write in a try/catch,
   every read falling back to the default.
   --------------------------------------------------------------------------- */

function lsGet(key) {
  try {
    if (!global.localStorage) return null;
    var v = global.localStorage.getItem(key);
    return (v === undefined) ? null : v;
  } catch (e) { return null; }
}
function lsSet(key, val) {
  try {
    if (!global.localStorage) return;
    if (val === null || val === undefined) global.localStorage.removeItem(key);
    else global.localStorage.setItem(key, String(val));
  } catch (e) { /* private mode, quota, blocked storage — never fatal */ }
}
function lsJson(key) {
  var raw = lsGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/* ---------------------------------------------------------------------------
   3 · THE STATE OBJECT (SPEC 7.1)
   Panel-local view keys (b2mode, gmSort, rlUnit …) live on the same object:
   they are merged by set() like any other key so that one setter still drives
   one pass, but only the SPEC 7.6 keys are serialised into the hash.
   --------------------------------------------------------------------------- */

function defaults() {
  return {
    range: '3d',
    axis: 'session',
    cur: null,
    locked: false,
    sel: null,
    books: newSet(BOOKS_ALL),
    base: 'nogates',
    quality: 'all',
    density: 'compact',
    judge: false,
    tab: 'decisions',
    q: '', from: '', to: '',
    gate: null, kind: null, underlying: null,
    deck: 'strikes',
    solo: null,
    /* not serialised: chrome state the hash has no key for */
    inspOpen: false
  };
}
function newSet(keys) {
  if (typeof global.Set === 'function') {
    var s = new global.Set();
    for (var i = 0; i < keys.length; i++) s.add(keys[i]);
    return s;
  }
  return keys.slice();
}
function setToList(b) {
  var out = [], i;
  if (!b) return BOOKS_ALL.slice();
  if (typeof b.forEach === 'function' && typeof b.size === 'number') {
    b.forEach(function (k) { out.push(k); });
    return out;
  }
  if (typeof b.length === 'number') { for (i = 0; i < b.length; i++) out.push(b[i]); return out; }
  for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k]) out.push(k);
  return out;
}

var S = defaults();
var D = null;                 /* the derived dataset (TDD.derive) */
var DATA = null;              /* the raw export */
var READY = false;

/* selection history for D5's ◂ ▸ */
var SELHIST = [];
var SELAT = -1;

/* the user has touched the density control, so the width rule stops applying */
var densityUserSet = lsGet(LS.density) !== null;

/* ---------------------------------------------------------------------------
   4 · CHROME RECONCILIATION
   index.html and styles.css disagree on four ids: styles.css lays the XS bar
   out through #xsbar, the raw drawer through #drawer and the keymap through
   #keymap; index.html ships #xs-warn, #ov-raw and #ov-keymap.  Neither file
   is app.js's to edit, so the ids are reconciled here, once, at boot — the
   nodes and every data-* hook on them keep their identity.  Both overlays are
   also moved inside #body, which is the positioning context styles.css gives
   them (`position:absolute` over column D, never over B or C), and both
   adopt the panel chrome classes so the drawer looks like the instrument
   rather than like an unstyled aside.
   --------------------------------------------------------------------------- */

function reId(oldId, newId) {
  var el = byId(newId);
  if (el) return el;
  el = byId(oldId);
  if (!el) return null;
  el.id = newId;
  attr(el, 'data-alias', oldId);
  return el;
}

var EL = {};

function ensureChrome() {
  EL.shell = byId('shell');
  EL.body = byId('body');
  EL.xsbar = reId('xs-warn', 'xsbar');
  EL.drawer = reId('ov-raw', 'drawer');
  EL.keymap = reId('ov-keymap', 'keymap');

  /* anything that pointed at the old ids keeps working */
  var kb = qs('[data-keymap]');
  if (kb && EL.keymap) attr(kb, 'aria-controls', EL.keymap.id);

  var i;
  var overlays = [EL.drawer, EL.keymap];
  for (i = 0; i < overlays.length; i++) {
    var ov = overlays[i];
    if (!ov) continue;
    if (EL.body && ov.parentNode !== EL.body) EL.body.appendChild(ov);
    adoptChrome(ov);
  }

  /* the scrim: styles.css defines it, index.html has none.  It is the only
     shadow on the page and it exists so the keymap card is dismissible by
     clicking away from it. */
  EL.scrim = qs('.scrim', EL.body || doc);
  if (!EL.scrim && EL.body) {
    EL.scrim = mk('div', 'scrim');
    EL.scrim.hidden = true;
    EL.body.insertBefore(EL.scrim, EL.keymap || null);
    EL.scrim.addEventListener('click', function () { closeTop(); });
  }

  buildKeymapCard();
  wireOverlayButtons();

  /* SPEC 7.5: the footer carries the whole map in its title */
  var foot = byId('p-footer');
  if (foot) attr(foot, 'title', keymapTitle());
}

function adoptChrome(ov) {
  var h = qs('.ovh', ov), b = qs('.ovb', ov), f = qs('.ovf', ov);
  if (h && h.className.indexOf('ph') < 0) h.className += ' ph';
  if (b && b.className.indexOf('pb') < 0) b.className += ' pb';
  if (f && f.className.indexOf('pf') < 0) f.className += ' pf';
  var c = qs('.ovc', ov);
  if (c && c.className.indexOf('pc') < 0) c.className += ' pc';
}

/* The ? card is generated from KEYMAP so it cannot list a shortcut the
   handler does not implement, nor miss one it does.  styles.css styles
   `#keymap .keys > div`, so the shipped <dl>/<dt>/<dd> is replaced by that
   shape — the static markup in index.html is the pre-boot fallback. */
function buildKeymapCard() {
  if (!EL.keymap) return;
  var body = qs('[data-body]', EL.keymap) || qs('.ovb', EL.keymap);
  if (!body) return;
  var host = qs('.keys', body);
  if (host && host.getAttribute('data-built') === '1') return;
  var box = mk('div', 'keys');
  attr(box, 'data-built', '1');
  var i, row;
  for (i = 0; i < KEYMAP.length; i++) {
    row = mk('div');
    row.innerHTML = '<span class="nowrap">' + KEYMAP[i].k + '</span><span class="c-soft">' +
                    esc(KEYMAP[i].d) + '</span>';
    box.appendChild(row);
  }
  clear(body);
  body.appendChild(box);
}
function keymapTitle() {
  var out = [], i;
  for (i = 0; i < KEYMAP.length; i++) out.push(KEYMAP[i].t + ' ' + KEYMAP[i].d);
  return out.join(' · ');
}

function wireOverlayButtons() {
  var i, list = [EL.drawer, EL.keymap];
  for (i = 0; i < list.length; i++) {
    var ov = list[i];
    if (!ov || ov.getAttribute('data-wired-td') === '1') continue;
    attr(ov, 'data-wired-td', '1');
    var close = qs('[data-close]', ov);
    if (close) close.addEventListener('click', function () { closeTop(); });
    var copy = qs('[data-copy]', ov);
    if (copy) copy.addEventListener('click', function () {
      var payload = EL.drawer && EL.drawer.__raw;
      if (payload === undefined || payload === null) return;
      if (TDC && TDC.copy) TDC.copy(jsonText(payload));
      flashEl(this, 'COPIED');
    });
  }
}

/* ---------------------------------------------------------------------------
   5 · THE REGISTRATION TABLE (SPEC 7.2)
   Built from the DOM at boot: every #body > section.p plus the three chrome
   rows, keyed by data-panel, resolved against window.TDP.  TD.register()
   exists for anything that wants to add a drawFn later; nothing in this build
   needs it, because the panel files export by key rather than register.
   --------------------------------------------------------------------------- */

var REG = [];       /* [{id, key, el, host, chrome, fn}] */
var REGBY = {};

function registerAll() {
  REG = [];
  REGBY = {};
  var chrome = [
    { id: 'p-status', key: 'status' },
    { id: 'p-command', key: 'command' }
  ];
  var i;
  for (i = 0; i < chrome.length; i++) addEntry(chrome[i].id, chrome[i].key, true);
  var panels = qsa('#body > section.p');
  for (i = 0; i < panels.length; i++) {
    addEntry(panels[i].id, panels[i].getAttribute('data-panel') || panels[i].id.replace(/^p-/, ''), false);
  }
  addEntry('p-footer', 'footer', true);
}

function addEntry(id, key, chrome) {
  var el = byId(id);
  if (!el) return null;
  var host = chrome ? el : (qs('[data-body]', el) || qs('.pb', el) || el);
  var e = { id: id, key: key, el: el, host: host, chrome: !!chrome, fn: null, fails: 0 };
  REG.push(e);
  REGBY[id] = e;
  REGBY[key] = e;
  return e;
}

function drawFnFor(e) {
  if (e.fn) return e.fn;
  var f = TDP[e.key];
  return (typeof f === 'function') ? f : null;
}

/* SPEC 7.2's published hook. */
function register(panelId, drawFn) {
  var e = REGBY[panelId];
  if (!e) e = addEntry(panelId, panelId.replace(/^p-/, ''), false);
  if (e) e.fn = drawFn;
  return !!e;
}

/* A renderer that throws keeps its cell and names the failure (SPEC 3.6).
   The panel is retried on the next pass: a throw caused by one state is not
   a permanent verdict on the panel. */
function drawOne(e) {
  var fn = drawFnFor(e);
  if (!fn) { missingRenderer(e); return; }
  try {
    fn(e.host, D, S);
    if (e.el.getAttribute('data-err')) {
      attr(e.el, 'data-err', null);
      var stale = qs('[data-err-note]', e.el);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    }
    dropBoot(e);
    e.fails = 0;
  } catch (err) {
    e.fails++;
    if (global.console && console.error) console.error('[TD] renderer ' + e.key + ' threw', err);
    failNotice(e, err && err.message ? err.message : String(err));
  }
}

/* index.html ships every panel body with a labelled `not rendered` placeholder
   so a renderer that never runs leaves a named empty instrument rather than a
   white box.  A renderer that builds its body by reusing slots (the A/B
   panels do) never removes it, so the boot sequence retires it here — but only
   once the renderer has actually produced something, because an empty body is
   the one thing SPEC 3.6 forbids more than a placeholder. */
function dropBoot(e) {
  var boot = qs('[data-boot]', e.host);
  if (!boot) return;
  var kids = e.host.children, i, other = 0;
  for (i = 0; i < kids.length; i++) if (kids[i] !== boot) other++;
  if (!other) return;
  boot.parentNode.removeChild(boot);
}

function failNotice(e, msg) {
  attr(e.el, 'data-err', '1');
  var file = e.key === 'matrix' || e.key === 'ladder' || e.key === 'refusals' || e.key === 'blotter'
    ? 'panels-c.js'
    : (e.key === 'recon' || e.key === 'integrity' || e.key === 'trades' || e.key === 'deck' || e.key === 'inspector'
       ? 'panels-d.js' : 'panels-ab.js');
  var box = mk('div', 'notpub');
  attr(box, 'data-err-note', '1');
  box.appendChild(mk('b', null, 'renderer failed'));
  box.appendChild(mk('span', null, 'TDP.' + e.key + ' — ' + msg));
  box.appendChild(mk('span', null, file + ' · this panel is the only thing affected'));
  attr(box, 'title', 'TDP.' + e.key + ' threw: ' + msg);
  if (e.chrome) {
    /* never wipe the status rail or the command strip: they carry controls
       other panels' failures must not take away */
    var old = qs('[data-err-note]', e.el);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    e.el.appendChild(box);
  } else {
    clear(e.host);
    e.host.appendChild(box);
  }
}

function missingRenderer(e) {
  if (e.el.getAttribute('data-missing') === '1') return;
  attr(e.el, 'data-missing', '1');
  if (e.chrome) return;
  var boot = qs('[data-boot]', e.host);
  if (boot) return;                       /* index.html's own placeholder stands */
  var box = mk('div', 'notpub');
  box.appendChild(mk('b', null, 'not rendered'));
  box.appendChild(mk('span', null, 'TDP.' + e.key + ' is not defined'));
  box.appendChild(mk('span', null, 'panels-*.js'));
  clear(e.host);
  e.host.appendChild(box);
}

/* ---------------------------------------------------------------------------
   6 · THE SETTER AND THE SINGLE PASS (SPEC 7.2)
   --------------------------------------------------------------------------- */

var pending = false;
var rendering = false;
var queued = null;

function set(patch) {
  if (!patch) return S;
  var k;
  if (rendering) {
    /* a renderer that patches state during a pass does not re-enter it */
    queued = queued || {};
    for (k in patch) if (has(patch, k)) queued[k] = patch[k];
    return S;
  }
  for (k in patch) if (has(patch, k)) S[k] = patch[k];
  normalise(patch);
  persistFrom(patch);
  schedule();
  return S;
}
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* Everything that has to be true of S no matter who wrote it. */
function normalise(patch) {
  patch = patch || {};

  if (S.books && !(typeof S.books.forEach === 'function' && typeof S.books.size === 'number')) {
    S.books = newSet(setToList(S.books));
  }
  if (!S.books || setToList(S.books).length === 0) S.books = newSet(BOOKS_ALL);

  if (S.axis !== 'time') S.axis = 'session';
  if (S.quality !== 'clean') S.quality = 'all';
  if (S.density !== 'comfortable') S.density = 'compact';
  if (DECKS.indexOf(S.deck) < 0) S.deck = 'strikes';
  if (BASES.indexOf(S.base) < 0) S.base = 'nogates';
  if (TABS.indexOf(S.tab) < 0) S.tab = 'decisions';
  S.judge = !!S.judge;
  S.locked = !!S.locked;

  if (S.cur !== null && S.cur !== undefined) {
    var n = D && D.spine ? D.spine.n : 0;
    S.cur = Math.round(Number(S.cur));
    if (!isNum(S.cur) || S.cur < 0) S.cur = null;
    else if (n && S.cur > n - 1) S.cur = n - 1;
  } else S.cur = null;
  if (S.cur === null) S.locked = false;

  if (S.sel && (!S.sel.type || S.sel.id === undefined || S.sel.id === null)) S.sel = null;

  /* SPEC 6.7: a lock fills the inspector with the tick view.  Expressing that
     as a selection of type `tick` means one mechanism does the work — the
     inspector, the hash and the cross-panel highlight all already follow
     S.sel — instead of a second, invisible rule inside D5. */
  if (has(patch, 'locked') || has(patch, 'cur')) {
    if (S.locked && S.cur !== null && !has(patch, 'sel')) {
      S.sel = { type: 'tick', id: S.cur };
    } else if (!S.locked && S.sel && S.sel.type === 'tick' && !has(patch, 'sel')) {
      S.sel = null;
    }
  }

  if (has(patch, 'sel')) pushSelHistory(S.sel);

  /* a selection opens the inspector where the inspector is a drawer */
  if (has(patch, 'sel') && S.sel && (band() === 'm' || band() === 's')) S.inspOpen = true;

  /* range may arrive as a brush [i0,i1] */
  if (S.range && typeof S.range === 'object' && typeof S.range.length === 'number') {
    var a = Math.round(S.range[0]), b = Math.round(S.range[1]);
    if (!isNum(a) || !isNum(b) || b <= a) S.range = 'all';
    else S.range = [a, b];
  } else if (typeof S.range === 'string') {
    if (!/^(1d|3d|all|\d{4}-\d{2}-\d{2})$/.test(S.range)) S.range = '3d';
  } else S.range = '3d';
}

function persistFrom(patch) {
  if (has(patch, 'density')) { densityUserSet = true; lsSet(LS.density, S.density); }
  if (has(patch, 'axis')) lsSet(LS.axis, S.axis);
  if (has(patch, 'deck')) lsSet(LS.deck, S.deck);
  if (has(patch, 'treeGroups')) {
    try { lsSet(LS.treeGroups, JSON.stringify(S.treeGroups)); } catch (e) { /* ignore */ }
  }
}

function schedule() {
  if (pending) return;
  pending = true;
  var raf = global.requestAnimationFrame;
  if (raf) raf(renderPass); else global.setTimeout(renderPass, 16);
}

function renderPass() {
  pending = false;
  if (!READY) return;
  rendering = true;
  try {
    writeHash();
    applyRoot();
    applyBreakpointState();
    syncCursorBus();
    var i;
    for (i = 0; i < REG.length; i++) drawOne(REG[i]);
    /* app.js's own additions are contained the same way a panel is: a data
       shape it did not expect must not be able to blank the instrument */
    try { judgeAnnotations(); } catch (e1) { warn('[TD] judge annotations', e1); }
    try {
      var cs = (TDC && TDC.cursor) ? TDC.cursor.get() : { i: null, locked: false };
      paintCursorZone(cs.i, cs.locked);
    } catch (e2) { warn('[TD] cursor readout', e2); }
    syncOverlays();
  } finally {
    rendering = false;
  }
  if (queued) {
    var q = queued;
    queued = null;
    set(q);
  }
}

/* ---------------------------------------------------------------------------
   7 · ROOT ATTRIBUTES, BREAKPOINTS, DENSITY, ACCORDION
   --------------------------------------------------------------------------- */

function band() {
  var w = global.innerWidth || doc.documentElement.clientWidth || 0;
  var h = global.innerHeight || doc.documentElement.clientHeight || 0;
  if (w < 1000 || h < 560 || h > w) return 'xs';
  if (w < 1180) return 's';
  if (w < 1400) return 'm';
  if (w < 1680) return 'l';
  return 'xl';
}

function applyRoot() {
  var r = doc.documentElement;
  attr(r, 'data-density', S.density);
  attr(r, 'data-judge', S.judge ? '1' : null);
  attr(r, 'data-bp', band());
  r.style.setProperty('--an', String(ACCORDION.length));

  /* SPEC 7.1's solo: one panel promoted to the whole body, or none */
  var i, panels = qsa('#body > section.p');
  for (i = 0; i < panels.length; i++) {
    attr(panels[i], 'data-solo', (S.solo && panels[i].id === S.solo) ? '1' : null);
  }
}

function applyBreakpointState() {
  var bp = band();
  var i, id, el;

  /* the accordion (SPEC 4.4) — the attributes are inert above 1179px, so
     they are written unconditionally and the S band costs no extra pass */
  var open = accordionOpen();
  var openIdx = ACCORDION.indexOf(open);
  if (openIdx < 0) openIdx = ACCORDION.indexOf('p-matrix');
  for (i = 0; i < ACCORDION.length; i++) {
    el = byId(ACCORDION[i]);
    if (!el) continue;
    attr(el, 'data-acc', '1');
    el.style.setProperty('--ai', String(i));
    attr(el, 'data-accs', i < openIdx ? 'above' : (i === openIdx ? 'open' : 'below'));
  }

  /* the inspector is a panel at XL/L and an overlay drawer at M and S */
  var insp = byId('p-inspector');
  if (insp) {
    if (bp === 'm' || bp === 's') attr(insp, 'data-open', S.inspOpen ? '1' : null);
    else attr(insp, 'data-open', '1');
  }

  /* density follows the width rule until the user chooses (SPEC 3.3) */
  if (!densityUserSet) {
    var want = ((global.innerWidth || 0) >= 1600) ? 'comfortable' : 'compact';
    if (S.density !== want) { S.density = want; attr(doc.documentElement, 'data-density', want); }
  }
}

function accordionOpen() {
  var v = lsGet(LS.accordion);
  if (v && ACCORDION.indexOf(v) >= 0) return v;
  return 'p-matrix';                      /* SPEC 4.4's default open slot */
}
function setAccordion(id) {
  if (ACCORDION.indexOf(id) < 0) return;
  lsSet(LS.accordion, id);
  schedule();
}

/* ---------------------------------------------------------------------------
   8 · SELECTION (SPEC 7.3)
   --------------------------------------------------------------------------- */

function sameSel(a, b) {
  if (!a || !b) return a === b;
  return String(a.type) === String(b.type) && String(a.id) === String(b.id);
}
function pushSelHistory(sel) {
  if (!sel) return;
  if (SELAT >= 0 && sameSel(SELHIST[SELAT], sel)) return;
  SELHIST = SELHIST.slice(0, SELAT + 1);
  SELHIST.push({ type: sel.type, id: sel.id });
  if (SELHIST.length > 40) SELHIST.shift();
  SELAT = SELHIST.length - 1;
}
function selBack() {
  if (SELAT <= 0) return false;
  SELAT--;
  var s = SELHIST[SELAT];
  S.sel = { type: s.type, id: s.id };
  schedule();
  return true;
}
function selForward() {
  if (SELAT >= SELHIST.length - 1) return false;
  SELAT++;
  var s = SELHIST[SELAT];
  S.sel = { type: s.type, id: s.id };
  schedule();
  return true;
}
function select(type, id) { return set({ sel: { type: type, id: id } }); }

/* ---------------------------------------------------------------------------
   9 · FILTERS (SPEC 7.4)
   --------------------------------------------------------------------------- */

function activeFilters() {
  var out = [];
  if (S.gate) out.push({ key: 'gate', label: 'gate ' + S.gate });
  if (S.kind) out.push({ key: 'kind', label: 'kind ' + S.kind });
  if (S.underlying) out.push({ key: 'underlying', label: 'underlying ' + S.underlying });
  if (S.q) out.push({ key: 'q', label: 'search "' + S.q + '"' });
  if (S.from) out.push({ key: 'from', label: 'from ' + S.from });
  if (S.to) out.push({ key: 'to', label: 'to ' + S.to });
  if (S.quality === 'clean') out.push({ key: 'quality', label: 'clean marks only' });
  return out;
}
function clearFilters() {
  return set({ gate: null, kind: null, underlying: null, q: '', from: '', to: '', quality: 'all' });
}

/* ---------------------------------------------------------------------------
   10 · THE CURSOR BRIDGE (SPEC 6.7)
   Hover never reaches here.  A lock does, exactly once, through onLock.
   --------------------------------------------------------------------------- */

function bindCursor() {
  if (!TDC || !TDC.cursor) return;
  TDC.cursor.onLock(function (i, locked) {
    if (locked) set({ cur: i, locked: true });
    else set({ cur: null, locked: false });
  });
  /* Hover: SPEC 6.7 forbids it reaching set(), so this subscriber writes one
     string into app.js's own status-rail zone and nothing else — no state, no
     hash, no render pass.  The chart panels paint their own value chip at
     their right edge; this is the readout for the panels that are not charts,
     and it is what makes the shared cursor legible from anywhere on the page. */
  TDC.cursor.on(function (i, st) { paintCursorZone(i, st && st.locked); });
}

/* --- the page-wide cursor readout ---------------------------------------- */
/* Owned end-to-end by app.js: it creates the zone, keeps it in place after
   every pass, and is the only writer.  §5 P00 gives the status rail the tick
   readout, so the hovered tick belongs in the same rail rather than in a new
   piece of chrome the spec does not have. */
function cursorZone() {
  var rail = byId('status') || byId('p-status');
  if (!rail) return null;
  var z = byId('st-cursor');
  if (!z) {
    /* .trunc is styles.css's own overflow:hidden; min-width:0; nowrap — it
       lets this zone shrink instead of pushing the refresh, commit and ?
       buttons off the right edge of the rail at the narrow bands */
    z = mk('div', 'rz zone trunc');
    z.id = 'st-cursor';
    attr(z, 'title', 'the shared tick cursor — hover any chart; click to lock it, ' +
                     'which scopes the blotter to ±1 tick and fills the inspector');
    var lab = mk('span', 'c-faint', 'CURSOR');
    var val = mk('span', 'mono');
    attr(val, 'data-cursor', '');
    z.appendChild(lab);
    z.appendChild(val);
    z.style.display = 'none';
    /* geometry only, and the one thing an inline style is for here: this zone
       is the first thing in the rail that gives way.  Without it the flex
       shrink is distributed proportionally and a long cursor string clips the
       refresh, commit and ? buttons off the right edge. */
    z.style.flexShrink = '1000';
  }
  var right = byId('st-right');
  if (right && right.parentNode && z.nextSibling !== right) right.parentNode.insertBefore(z, right);
  else if (!right && z.parentNode !== rail) rail.appendChild(z);
  return z;
}

function paintCursorZone(i, locked) {
  var z = cursorZone();
  if (!z) return;
  var val = qs('[data-cursor]', z);
  if (i === null || i === undefined || i < 0 || !D || !D.byTick || !D.byTick[i]) {
    z.style.display = 'none';
    if (val) val.textContent = '';
    return;
  }
  var t = D.byTick[i], p = [];
  p.push('tick ' + (i + 1) + '/' + D.spine.n);
  p.push(F.ts(t.t, 'hm') + 'Z ' + t.day.slice(5));
  if (t.books && t.books.real) p.push('real ' + F.usd(t.books.real.v));
  if (t.signal) {
    p.push('iv ' + F.vol(t.signal.iv) + ' rv ' + F.vol(t.signal.rv));
    if (isNum(t.signal.vrp)) p.push('vrp ' + F.num(t.signal.vrp, 2));
  }
  if (t.greeks && isNum(t.greeks.th)) p.push('θ ' + F.greek(t.greeks.th));
  var ev = (t.gates ? t.gates.length : 0) + (t.refusals ? t.refusals.length : 0) +
           (t.entries ? t.entries.length : 0);
  if (ev) p.push(ev + ' event' + (ev === 1 ? '' : 's'));
  if (locked) p.push('LOCKED');
  var line = p.join(' · ');
  if (val) val.textContent = line;
  attr(z, 'title', line + ' — the shared tick cursor. Hover any chart to move it; ' +
                   'click to lock it, which scopes the blotter to ±1 tick and fills the inspector.');
  z.style.display = '';
  if (z.classList) { if (locked) z.classList.add('act'); else z.classList.remove('act'); }
}

/* Push S back into the bus only when they actually disagree: adopting on
   every pass would clobber a live hover position. */
function syncCursorBus() {
  if (!TDC || !TDC.cursor) return;
  var st = TDC.cursor.get();
  var want = S.locked ? S.cur : null;
  if (st.locked === !!S.locked && st.li === want) return;
  TDC.cursor.adopt(S.cur, S.locked);
}

function visibleWindow() {
  if (!D || !D.spine) return { i0: 0, i1: 0 };
  var w = D.spine.slice(S.range);
  return { i0: w[0], i1: w[1] };
}

function stepCursor(delta) {
  if (!D || !D.spine || !TDC || !TDC.cursor) return;
  var w = visibleWindow();
  var cur = (S.cur === null) ? w.i1 : S.cur;
  TDC.cursor.lock(clamp(cur + delta, w.i0, w.i1), 'key');
}
function stepSession(dir) {
  if (!D || !D.spine) return;
  var w = visibleWindow();
  var cur = (S.cur === null) ? w.i1 : S.cur;
  var days = D.spine.days, i, at = 0;
  for (i = 0; i < days.length; i++) if (cur >= days[i].i0 && cur <= days[i].i1) { at = i; break; }
  var next = clamp(at + dir, 0, days.length - 1);
  var target = (dir < 0 && cur > days[at].i0) ? days[at].i0 : days[next].i0;
  TDC.cursor.lock(clamp(target, w.i0, w.i1), 'key');
}

/* ---------------------------------------------------------------------------
   11 · JUDGE MODE (SPEC 7.8)
   panels-ab carries five annotations (A3, B1, B2, B4, B5) and panels-d one
   (D2).  The three column-C notes are written here, from D — never from the
   spec's prose — and re-asserted after every pass so a renderer that rebuilds
   its body cannot lose them.  Each is inert until :root[data-judge="1"].
   --------------------------------------------------------------------------- */

/* The note goes FIRST in the body, not last: C4's body is a virtual scroller
   17,000px tall, so an appended annotation would sit behind 940 rows and no
   judge would ever reach it.  Leading with it is also what "the annotations
   are the value" asks for — turn judge mode on and the panel opens with its
   own caveat.  It is re-asserted after every pass, so a renderer that rebuilds
   its body cannot lose it. */
function jn(panelId, key, markup) {
  var p = byId(panelId);
  if (!p) return;
  var host = qs('[data-body]', p) || qs('.pb', p);
  if (!host) return;
  var node = qs('[data-jn="' + key + '"]', host);
  if (!node) {
    node = mk('div', 'jn');
    attr(node, 'data-jn', key);
  }
  if (node.parentNode !== host || host.firstChild !== node) {
    host.insertBefore(node, host.firstChild || null);
  }
  if (node.__md !== markup) { node.innerHTML = markup; node.__md = markup; }
}

function judgeAnnotations() {
  if (!D || !D.gates || !D.refusals) return;
  var g = D.gates, r = D.refusals, P = D.params && D.params.byPath ? D.params.byPath : {};

  function pv(path) {
    var row = P[path];
    return (row && row.value !== undefined && row.value !== null) ? row.value : null;
  }
  var lo = pv('risk.price_grid_low'), hi = pv('risk.price_grid_high');
  var step = pv('risk.price_grid_step'), exp = pv('expiry.target_expiry');
  var frac = pv('risk.portfolio_worst_case_frac'), cap = pv('risk.portfolio_worst_case_cap');
  var span = (isNum(lo) && isNum(hi))
    ? ('±' + F.num((hi - 1) * 100, 0) + '% of spot (' + F.num(lo, 3) + '–' + F.num(hi, 3) + '×')
      + (isNum(step) ? ', ' + F.num(step * 100, 1) + '% steps)' : ')')
    : 'the published price grid';

  jn('p-matrix', 'c1',
    '<b>What g8 actually does.</b> It is not a limit on the candidate: it reprices the ' +
    'entire book <i>plus</i> the candidate over a ' + esc(span) + ' grid at the ' +
    esc(exp || 'target') + ' expiry and compares the worst point against the budget' +
    (isNum(frac) ? ' (' + esc(F.pct(frac, 1)) + ' of equity, capped at ' + esc(F.pct(cap, 1)) + ')' : '') +
    '. ' + (g && g.worstCase && g.worstCase.published
      ? ('Published on ' + esc(String(g.worstCase.n)) + ' of ' + esc(String(g.evals.length)) +
         ' evaluations; the worst point ever computed was ' + esc(F.usd(g.worstCase.min)) +
         ' and the scenario column is <code>base</code> on every one of them, so the ' +
         'vol-shock branch is a scalar that never bound, not a series.')
      : 'The worst-case payload is not published, so this note names the mechanism only.') +
    ' Eight of the twelve gates never bound at all: a gate that never fires is evidence about the ' +
    'regime, not dead code, and it keeps its row.');

  var kinds = (r && r.byKind) ? r.byKind : [];
  var kindTxt = [], i;
  for (i = 0; i < kinds.length; i++) kindTxt.push(esc(kinds[i].kind) + ' ' + esc(String(kinds[i].count)));
  jn('p-refusals', 'c3',
    '<b>The refusal taxonomy.</b> A refusal is not one thing. ' +
    esc(String(r ? r.rows.length : 0)) + ' rows across ' + esc(String(kinds.length)) +
    ' kinds: ' + kindTxt.join(' · ') + '. Only <code>entry_refused</code> names a gate; ' +
    'the rest are the desk declining to be in the market at all. ' +
    (r && r.firstFailureNote ? esc(r.firstFailureNote) + ', ' : '') +
    'which is why this panel and the matrix disagree by construction' +
    (r && r.rankingsDisagree && r.topByCount && r.topByRate
      ? ' — by count the binding gate is ' + esc(r.topByCount.gate) + ' (' + esc(String(r.topByCount.count)) +
        '), by rate it is ' + esc(r.topByRate.gate) + ' (' + esc(F.pct(r.topByRate.rate, 1)) + ' of ' +
        esc(String(r.topByRate.evals)) + ' evaluations). Both are printed; neither is the headline.'
      : '.'));

  var cov = D.blotter && D.blotter.coverage ? D.blotter.coverage : null;
  jn('p-blotter', 'c4',
    '<b>The decision chain.</b> Every row here is one line of <code>data/journal/desk.jsonl</code>, ' +
    'appended and never rewritten: there is no update path and no delete path in the codebase, and ' +
    'each line carries the SHA-256 of the line before it' +
    (D.status && D.status.chain ? ' (' + esc(String(D.status.chain.entries)) + ' entries, ' +
      esc(D.status.chain.msg) + ')' : '') + '. ' +
    (cov ? ('The DECISIONS tab is the newest ' + esc(String(cov.decisions)) + ' of ' +
            esc(String(cov.journalTotal)) + ' rows — the export is capped, and the tab says so rather ' +
            'than implying the journal is that short; the other seven tabs carry the complete history ' +
            'for their own kind.') : '') +
    ' Selecting a row selects the same object in the matrix, the ribbon and the inspector, and ' +
    '<kbd>Enter</kbd> opens the verbatim record.');
}

/* ---------------------------------------------------------------------------
   12 · OVERLAYS — the raw-record drawer and the keymap card
   --------------------------------------------------------------------------- */

function overlayOpen(el) { return !!(el && !el.hidden); }

function showOverlay(el, on) {
  if (!el) return;
  el.hidden = !on;
  if (el === EL.keymap && EL.scrim) EL.scrim.hidden = !on;
}
function syncOverlays() {
  if (EL.scrim) EL.scrim.hidden = !overlayOpen(EL.keymap);
}

/* SPEC 7.3's unwind order: overlay → selection → cursor lock. */
function closeTop() {
  if (overlayOpen(EL.keymap)) { showOverlay(EL.keymap, false); return 'keymap'; }
  if (overlayOpen(EL.drawer)) { showOverlay(EL.drawer, false); return 'drawer'; }
  var bp = band();
  if ((bp === 'm' || bp === 's') && S.inspOpen) { S.inspOpen = false; schedule(); return 'inspector'; }
  if (S.sel) { set({ sel: null }); return 'selection'; }
  if (S.locked) {
    if (TDC && TDC.cursor) TDC.cursor.unlock(); else set({ cur: null, locked: false });
    return 'cursor';
  }
  if (S.solo) { set({ solo: null }); return 'solo'; }
  return null;
}

function keymapToggle(force) {
  var on = (force === undefined) ? !overlayOpen(EL.keymap) : !!force;
  if (on && overlayOpen(EL.drawer)) showOverlay(EL.drawer, false);
  showOverlay(EL.keymap, on);
  return on;
}

/* The raw-record drawer.  One journal object, verbatim, as collapsible JSON. */
function drawer(obj, label) {
  if (!EL.drawer) return false;
  EL.drawer.__raw = obj;
  var head = qs('.ovh h2', EL.drawer) || qs('h2', EL.drawer);
  if (head) head.textContent = 'RAW RECORD';
  var prov = qs('[data-provenance]', EL.drawer);
  if (prov) prov.textContent = (label ? label + ' · ' : '') + 'data/journal/desk.jsonl';
  var body = qs('[data-body]', EL.drawer) || qs('.ovb', EL.drawer);
  if (body) {
    clear(body);
    if (obj === null || obj === undefined) {
      var np = mk('div', 'notpub');
      np.appendChild(mk('b', null, 'not published'));
      np.appendChild(mk('span', null, 'no raw journal record for this row'));
      np.appendChild(mk('span', null, 'tools/site_data.py · decisions[].d'));
      body.appendChild(np);
    } else {
      var box = mk('div', 'json');
      box.innerHTML = jsonHtml(obj, 0);
      body.appendChild(box);
    }
  }
  showOverlay(EL.keymap, false);
  showOverlay(EL.drawer, true);
  return true;
}

function jsonText(o) {
  try { return JSON.stringify(o, null, 2); } catch (e) { return String(o); }
}
function jsonHtml(v, depth) {
  var t = typeof v, i, out, k, keys;
  if (v === null) return '<span class="b">null</span>';
  if (t === 'number') return '<span class="nu">' + esc(String(v)) + '</span>';
  if (t === 'boolean') return '<span class="b">' + esc(String(v)) + '</span>';
  if (t === 'string') return '<span class="s">' + esc(JSON.stringify(v)) + '</span>';
  if (Object.prototype.toString.call(v) === '[object Array]') {
    if (!v.length) return '[]';
    out = [];
    for (i = 0; i < v.length; i++) out.push('<div>' + jsonHtml(v[i], depth + 1) + '</div>');
    return wrapDetails('[ ' + v.length + ' items ]', out.join(''), depth);
  }
  if (t === 'object') {
    keys = [];
    for (k in v) if (has(v, k)) keys.push(k);
    if (!keys.length) return '{}';
    out = [];
    for (i = 0; i < keys.length; i++) {
      out.push('<div><span class="k">' + esc(keys[i]) + '</span> ' + jsonHtml(v[keys[i]], depth + 1) + '</div>');
    }
    return wrapDetails('{ ' + keys.length + ' keys }', out.join(''), depth);
  }
  return esc(String(v));
}
function wrapDetails(summary, inner, depth) {
  var open = depth < 2 ? ' open' : '';
  return '<details' + open + '><summary>' + esc(summary) + '</summary>' +
         '<div style="padding-left:10px">' + inner + '</div></details>';
}

/* ---------------------------------------------------------------------------
   13 · THE KEYBOARD MAP (SPEC 7.5)
   --------------------------------------------------------------------------- */

function typing(ev) {
  var el = ev.target || doc.activeElement;
  if (!el || !el.tagName) return false;
  var tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

function onKey(ev) {
  if (ev.defaultPrevented) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  var k = ev.key;
  if (k === undefined) return;

  if (typing(ev)) {
    if (k === 'Escape') { try { ev.target.blur(); } catch (e) {} ev.preventDefault(); }
    return;
  }
  if (!READY && k !== '?') return;

  var w = visibleWindow(), handled = true;

  if (k >= '1' && k <= '8' && !ev.shiftKey) {
    set({ tab: TABS[parseInt(k, 10) - 1] });
  } else if (k === 'ArrowLeft') {
    if (ev.shiftKey) stepSession(-1); else stepCursor(-1);
  } else if (k === 'ArrowRight') {
    if (ev.shiftKey) stepSession(1); else stepCursor(1);
  } else if (k === 'Home') {
    if (TDC && TDC.cursor) TDC.cursor.lock(w.i0, 'key');
  } else if (k === 'End') {
    if (TDC && TDC.cursor) TDC.cursor.lock(w.i1, 'key');
  } else if (k === '.') {
    if (S.locked) { if (TDC && TDC.cursor) TDC.cursor.unlock(); else set({ cur: null, locked: false }); }
    else if (TDC && TDC.cursor) TDC.cursor.lock(S.cur === null ? w.i1 : S.cur, 'key');
  } else if (k === '[' || k === ']') {
    var di = DECKS.indexOf(S.deck);
    if (di < 0) di = 0;
    set({ deck: DECKS[(di + (k === '[' ? DECKS.length - 1 : 1)) % DECKS.length] });
  } else if (k === 'd' || k === 'D') {
    set({ density: S.density === 'compact' ? 'comfortable' : 'compact' });
  } else if (k === 'j' || k === 'J') {
    set({ judge: !S.judge });
  } else if (k === 'a' || k === 'A') {
    set({ axis: S.axis === 'session' ? 'time' : 'session' });
  } else if (k === 'u' || k === 'U') {
    set({ quality: S.quality === 'all' ? 'clean' : 'all' });
  } else if (k === 'b' || k === 'B') {
    var bi = BASES.indexOf(S.base);
    set({ base: BASES[(bi < 0 ? 0 : bi + 1) % BASES.length] });
  } else if (k === 'i' || k === 'I') {
    focusInspector();
  } else if (k === 'f' || k === 'F') {
    if (!(TDP.blotterFocus && TDP.blotterFocus())) goTo('p-blotter');
  } else if (k === 'c' || k === 'C') {
    copyLink();
  } else if (k === 'x' || k === 'X') {
    exportView();
  } else if (k === '?' || (k === '/' && ev.shiftKey)) {
    keymapToggle();
  } else if (k === 'Escape') {
    closeTop();
  } else if (k === 'Enter') {
    if (!(TDP.blotterOpenSelected && TDP.blotterOpenSelected())) handled = false;
  } else {
    handled = false;
  }

  if (handled) ev.preventDefault();
}

function focusInspector() {
  var bp = band();
  var insp = byId('p-inspector');
  if (!insp) return;
  if (bp === 'm' || bp === 's') { S.inspOpen = true; schedule(); }
  goTo('p-inspector');
  var b = qs('[data-body]', insp);
  if (b) { attr(b, 'tabindex', '-1'); try { b.focus({ preventScroll: true }); } catch (e) { try { b.focus(); } catch (e2) {} } }
}

/* ---------------------------------------------------------------------------
   14 · THE HASH ROUTER (SPEC 7.6)
   --------------------------------------------------------------------------- */

var lastHash = null;

function hashString() {
  var p = [];
  function add(k, v) { p.push(k + '=' + encodeURIComponent(v)); }
  if (S.range !== '3d') {
    add('r', (typeof S.range === 'object') ? (S.range[0] + '-' + S.range[1]) : S.range);
  }
  if (S.axis !== 'session') add('ax', S.axis);
  if (S.cur !== null) add('x', S.cur);
  if (S.locked) add('lk', '1');
  if (S.sel) add('sel', S.sel.type + ':' + S.sel.id);
  if (S.tab !== 'decisions') add('tab', S.tab);
  if (S.gate) add('gate', S.gate);
  if (S.kind) add('kind', S.kind);
  if (S.underlying) add('u', S.underlying);
  if (S.q) add('q', S.q);
  if (S.from) add('from', S.from);
  if (S.to) add('to', S.to);
  if (S.density !== 'compact') add('d', S.density);
  if (S.judge) add('j', '1');
  if (S.base !== 'nogates') add('b', S.base);
  if (S.deck !== 'strikes') add('deck', S.deck);
  if (S.quality !== 'all') add('qual', S.quality);
  var bl = setToList(S.books);
  if (bl.length !== BOOKS_ALL.length) add('bk', bl.join(','));
  if (S.solo) add('solo', S.solo);
  return p.join('&');
}

function writeHash() {
  var h = hashString();
  if (h === lastHash) return;
  lastHash = h;
  try {
    var url = global.location.pathname + global.location.search + (h ? '#' + h : '#');
    if (global.history && global.history.replaceState) global.history.replaceState(null, '', url);
    else global.location.hash = h;
  } catch (e) { /* sandboxed component: the hash is a nicety, not a dependency */ }
}

/* The persisted preferences (SPEC 7.9) sit under the hash, not over it: they
   are the defaults a bare URL restores, and any key the hash carries wins. */
function persistedDefaults() {
  var patch = {};
  var a = lsGet(LS.axis); if (a === 'time' || a === 'session') patch.axis = a;
  var dk = lsGet(LS.deck); if (dk && DECKS.indexOf(dk) >= 0) patch.deck = dk;
  var den = lsGet(LS.density);
  patch.density = (den === 'comfortable' || den === 'compact')
    ? den : (((global.innerWidth || 0) >= 1600) ? 'comfortable' : 'compact');
  var tg = lsJson(LS.treeGroups); if (tg) patch.treeGroups = tg;
  return patch;
}

function readHash(initial) {
  var raw = '';
  try { raw = String(global.location.hash || '').replace(/^#/, ''); } catch (e) { raw = ''; }
  if (raw === lastHash && !initial) return;
  lastHash = raw;

  /* a hashchange (the back button, a pasted link) restores the whole view, so
     everything the hash does not carry returns to its default */
  var patch = initial ? {} : defaults();
  if (!initial) delete patch.inspOpen;
  var pd = persistedDefaults(), pk;
  for (pk in pd) if (has(pd, pk)) patch[pk] = pd[pk];
  if (initial) {
    /* ?judge=1 still works (SPEC 7.6) */
    try {
      if (/[?&]judge=1\b/.test(String(global.location.search || ''))) patch.judge = true;
    } catch (e2) { /* ignore */ }
  }

  var parts = raw ? raw.split('&') : [], i, kv, k, v;
  for (i = 0; i < parts.length; i++) {
    kv = parts[i].split('=');
    k = kv[0];
    v = kv.length > 1 ? decodeURIComponent(kv.slice(1).join('=')) : '';
    if (!k) continue;
    if (k === 'r') {
      if (/^\d+-\d+$/.test(v)) { var ab = v.split('-'); patch.range = [parseInt(ab[0], 10), parseInt(ab[1], 10)]; }
      else patch.range = v;
    } else if (k === 'ax') patch.axis = v;
    else if (k === 'x') patch.cur = parseInt(v, 10);
    else if (k === 'lk') patch.locked = v === '1';
    else if (k === 'sel') {
      var ci = v.indexOf(':');
      patch.sel = ci > 0 ? { type: v.slice(0, ci), id: v.slice(ci + 1) } : null;
    }
    else if (k === 'tab') patch.tab = v;
    else if (k === 'gate') patch.gate = v || null;
    else if (k === 'kind') patch.kind = v || null;
    else if (k === 'u') patch.underlying = v || null;
    else if (k === 'q') patch.q = v;
    else if (k === 'from') patch.from = v;
    else if (k === 'to') patch.to = v;
    else if (k === 'd') patch.density = v;
    else if (k === 'j') patch.judge = v === '1';
    else if (k === 'b') patch.base = v;
    else if (k === 'deck') patch.deck = v;
    else if (k === 'qual') patch.quality = v;
    else if (k === 'bk') patch.books = newSet(v ? v.split(',') : []);
    else if (k === 'solo') patch.solo = v || null;
  }

  if (initial) {
    for (k in patch) if (has(patch, k)) S[k] = patch[k];
    normalise(patch);
  } else {
    set(patch);
  }
  /* a restored cursor must repaint the overlays without re-firing the lock
     sinks, or the adopted state bounces straight back into set() */
  if (TDC && TDC.cursor) TDC.cursor.adopt(S.cur, S.locked);
}

/* ---------------------------------------------------------------------------
   15 · LOADING, LIVENESS AND THE MANUAL REFRESH (SPEC 7.7)
   There is NO auto-refresh timer on the data.  There is one 30-second timer on
   the CLOCK: it re-renders the status rail only, so `23m ago` stays true
   instead of freezing at the moment of load.  It fetches nothing.
   --------------------------------------------------------------------------- */

function load(force) {
  if (global.__DATA__ && !force) { bootData(global.__DATA__); return; }
  if (typeof global.fetch !== 'function') {
    if (global.__DATA__) { bootData(global.__DATA__); return; }
    fatal('fetch is unavailable and window.__DATA__ was not injected');
    return;
  }
  global.fetch('data.json?ts=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (j) { bootData(j); })
    .catch(function (e) { fatal(e && e.message ? e.message : String(e)); });
}

function refresh(force) {
  var out = qs('[data-refresh-out]');
  if (typeof global.fetch !== 'function') {
    flashEl(out, 'hosted snapshot — refresh unavailable', 4000);
    return;
  }
  global.fetch('data.json?ts=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
    .then(function (j) {
      var was = DATA ? DATA.generated_utc : null;
      var now = j.generated_utc;
      if (now !== was) {
        bootData(j);
        flashEl(out, 'updated · generated ' + shortStamp(now), 6000);
      } else {
        flashEl(out, 'unchanged · generated ' + shortStamp(now), 6000);
      }
    })
    .catch(function () {
      flashEl(out, 'hosted snapshot — refresh unavailable', 6000);
    });
  return true;
}

function shortStamp(t) {
  var s = String(t || '');
  var m = /T(\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? m[1] + 'Z' : s;
}

function flashEl(el, msg, ms) {
  if (!el) return;
  el.textContent = msg;
  if (el.classList) el.classList.add('flash');
  if (el.__t) global.clearTimeout(el.__t);
  el.__t = global.setTimeout(function () {
    if (el.classList) el.classList.remove('flash');
    el.textContent = '';
    el.__t = null;
  }, ms || 2400);
}

function fatal(msg) {
  var b = byId('body');
  if (!b) return;
  var box = mk('div', 'notpub');
  box.appendChild(mk('b', null, 'data.json could not be loaded'));
  box.appendChild(mk('span', null, msg));
  box.appendChild(mk('span', null, 'dashboard/web/data.json · serve the directory, or open it through dashboard/app.py'));
  var panels = qsa('#body > section.p'), i;
  for (i = 0; i < panels.length; i++) {
    var host = qs('[data-body]', panels[i]);
    if (!host) continue;
    clear(host);
    host.appendChild(box.cloneNode(true));
  }
  if (global.console && console.error) console.error('[TD] ' + msg);
}

var clockTimer = null;
function startClock() {
  if (clockTimer) return;
  clockTimer = global.setInterval(function () {
    if (!READY) return;
    var e = REGBY['p-status'];
    if (e) drawOne(e);
  }, 30000);
}

/* ---------------------------------------------------------------------------
   16 · SMALL PUBLIC HELPERS THE PANELS CALL
   --------------------------------------------------------------------------- */

function goTo(id) {
  var p = byId(id);
  if (!p) return false;
  var bp = band();
  if ((bp === 's') && ACCORDION.indexOf(id) >= 0) setAccordion(id);
  if ((bp === 'm' || bp === 's') && id === 'p-inspector') { S.inspOpen = true; schedule(); }
  try { p.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { try { p.scrollIntoView(); } catch (e2) {} }
  attr(p, 'data-sel', '1');
  global.setTimeout(function () {
    if (p.getAttribute('data-sel') === '1' && !(S.sel && S.sel.id === id)) p.removeAttribute('data-sel');
  }, 1500);
  return true;
}

function link() {
  try { return String(global.location.href).split('#')[0] + '#' + hashString(); }
  catch (e) { return '#' + hashString(); }
}

function copyLink() {
  var href = link();
  if (TDC && TDC.copy) TDC.copy(href);
  flashEl(qs('[data-refresh-out]'), 'view link copied', 2400);
  return href;
}

function exportView() {
  var btn = byId('ctl-export');
  if (typeof TDP.blotterExport !== 'function') { flashEl(qs('[data-refresh-out]'), 'export unavailable', 2400); return 0; }
  var n = 0;
  try { n = TDP.blotterExport() || 0; } catch (e) { n = 0; }
  if (btn) flashEl(qs('[data-refresh-out]'), 'exported ' + n + ' rows', 3000);
  return n;
}

/* ---------------------------------------------------------------------------
   17 · GLOBAL LISTENERS — every addEventListener on window/document in the
   whole page is in this function (SPEC 2.5).
   --------------------------------------------------------------------------- */

var resizeT = null;
var lastBand = null;

function bindGlobals() {
  doc.addEventListener('keydown', onKey, false);

  global.addEventListener('hashchange', function () { readHash(false); }, false);

  global.addEventListener('resize', function () {
    if (resizeT) global.clearTimeout(resizeT);
    resizeT = global.setTimeout(function () {
      resizeT = null;
      var b = band();
      if (b !== lastBand || !densityUserSet) { lastBand = b; schedule(); }
    }, 120);
  }, false);

  /* the S-breakpoint accordion: a collapsed header is the control that opens
     its slot.  Delegated, so it costs one listener and survives every
     rebuild a renderer performs inside its own panel. */
  doc.addEventListener('click', function (ev) {
    var p = closestEl(ev.target, '.p[data-acc]');
    if (!p) return;
    if (band() !== 's') return;
    var ph = closestEl(ev.target, '.ph');
    if (!ph || ph.parentNode !== p) return;
    if (closestEl(ev.target, 'button') || closestEl(ev.target, '.pc')) return;
    setAccordion(p.id);
  }, false);
}

/* ---------------------------------------------------------------------------
   18 · BOOT (SPEC 2.6)
   --------------------------------------------------------------------------- */

/* SPEC 6.2 defines ONE TickIndex and forbids a second clustering.  derive.js
   owns it (D.spine), and every panel takes its x from it — but charts.js's
   marks also call three methods derive does not expose (of, isBreak,
   breakBetween: `gaps:true` needs them to break a path at a session
   boundary).  A panel that hands D.spine straight to ctx.setIndex therefore
   throws inside the draw callback, where charts.js swallows it and the line
   silently loses its day breaks.  Completing the object here — additively,
   with the same definitions the A/B adapter uses — keeps exactly one index on
   the page and closes the gap for every consumer at once. */
function completeSpine(s) {
  if (!s || typeof s.n !== 'number') return;
  if (typeof s.of !== 'function') {
    s.of = function (t) { var i = s.bind ? s.bind(t) : s.at(t); return (i === null || i === undefined) ? -1 : i; };
  }
  if (typeof s.isBreak !== 'function') {
    s.isBreak = function (i) {
      var b = s.dayBreaks || [], j;
      for (j = 0; j < b.length; j++) if (b[j] === i) return true;
      return false;
    };
  }
  if (typeof s.breakBetween !== 'function') {
    s.breakBetween = function (a, b) {
      var ta = s.ticks[a], tb = s.ticks[b];
      return !!(ta && tb && ta.dayIdx !== tb.dayIdx);
    };
  }
}

function bootData(data) {
  DATA = data;
  try {
    D = TDD ? TDD.derive(data) : null;
  } catch (e) {
    if (global.console && console.error) console.error('[TD] derive failed', e);
    fatal('derive.js threw: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  if (!D) { fatal('derive.js did not load'); return; }
  completeSpine(D.spine);
  TD.D = D;
  READY = true;
  normalise({ cur: S.cur, locked: S.locked });   /* clamp a hash cursor to the real spine */
  renderPass();
  startClock();
}

function start() {
  if (!TDC) {
    if (global.console && console.error) console.error('[TD] charts.js did not load');
  }
  ensureChrome();
  registerAll();
  bindCursor();
  bindGlobals();
  lastBand = band();

  /* seed panel-local defaults the A/B panels publish, so a panel that reads
     one of them gets its documented default rather than undefined */
  var seeds = TDP.stateKeysAB || {}, k;
  for (k in seeds) if (has(seeds, k) && S[k] === undefined) S[k] = seeds[k];

  readHash(true);
  applyRoot();
  applyBreakpointState();
  load(false);
}

/* ---------------------------------------------------------------------------
   19 · window.TD
   --------------------------------------------------------------------------- */

var TD = {
  version: '1.0.0',

  /* state */
  S: S,
  D: null,                              /* mirrored on every boot, below */
  set: set,
  register: register,
  render: function () { schedule(); },

  /* selection */
  select: select,
  selBack: selBack,
  selForward: selForward,
  selHistory: function () { return { at: SELAT, n: SELHIST.length, rows: SELHIST.slice() }; },

  /* filters */
  filters: activeFilters,
  clearFilters: clearFilters,

  /* chrome */
  drawer: drawer,
  keymap: keymapToggle,
  closeTop: closeTop,
  goto: goTo,
  link: link,
  hash: function () { return '#' + hashString(); },
  copyLink: copyLink,
  export: exportView,
  refresh: refresh,
  load: load,
  accordion: setAccordion,
  band: band,

  /* cursor, for anything that needs the window the keys use */
  window: visibleWindow,
  step: stepCursor,
  stepSession: stepSession,

  /* diagnostics — the probe pages and the console use these */
  keymapTable: KEYMAP,
  registry: function () {
    var out = [], i;
    for (i = 0; i < REG.length; i++) {
      out.push({ id: REG[i].id, key: REG[i].key, bound: !!drawFnFor(REG[i]),
                 err: REG[i].el.getAttribute('data-err') === '1', fails: REG[i].fails });
    }
    return out;
  }
};

global.TD = TD;

/* SPEC 2.6.2: classic script at the end of <body>, so the DOM exists — but
   the static-file case still guards on readyState. */
if (doc.readyState === 'loading') {
  doc.addEventListener('DOMContentLoaded', start, false);
} else {
  start();
}

})(window, document);
