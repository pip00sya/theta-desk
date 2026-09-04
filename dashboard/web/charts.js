/* ===========================================================================
   THETA DESK — charts.js — window.TDC
   The chart kernel and nothing else (SPEC §6).

   Knows about: SVG, numbers, time, and the shared tick index.
   Knows nothing about: any panel, the state object S, or data.json's meaning.
   TDC.index.build(data) is handed the data; it never reaches for it.

   No dependencies, no build step, classic script, one global.

   HOUSE RULES OBSERVED IN THIS FILE
     · Not one hex literal.  Every colour comes from TDC.C (§3.7), which is
       read once at boot from the CSS custom properties.  `make lint-hex`
       (grep -nE "#[0-9A-Fa-f]{3,8}") must return nothing here.
     · The token name for the integrity green appears EXACTLY ONCE, in the
       TOKENS table below — the single definition §3.1 permits.
     · Green is never used by any mark by default.  TDC.strip is the one mark
       that can render it, because the 97-cell integrity strip is one of the
       three places §3.1 allows it, and it is opt-in through `colors`.
     · No mark colours by sentiment.  A negative number is ink with a leading
       U+2212 and geometry below a labelled zero rule.
     · Every numeral is tabular: the mounted <svg> carries
       font-variant-numeric:tabular-nums, which every <text> inherits.
     · Every element id this file mints is prefixed `tdc-`, so no generated
       url(#…) reference can ever look like a hex colour.

   LAYOUT MODEL
     mount() gives you an <svg> sized to its host with four stacked <g>
     layers — bg, series, fg, overlay — each translated by the pad, so every
     mark works in inner-box coordinates where (0,0) is the top-left of the
     plot and (iw,ih) the bottom-right.  Axis furniture may draw at negative
     coordinates into the pad; only the `series` layer is clipped to the box.
   =========================================================================== */

(function (global, doc) {
'use strict';

var SVGNS = 'http://www.w3.org/2000/svg';
var MINUS = '−';          /* U+2212 MINUS SIGN — never a hyphen */
var HAIR  = ' ';          /* thin space, for "g17 26/57" style counts */
var TDC   = {};

/* ---------------------------------------------------------------------------
   0 · CONSTANTS.  Chart geometry defaults live here so panels can read them
   instead of inventing numbers (§2.2 keeps magic numbers out of panels).
   --------------------------------------------------------------------------- */
var K = {
  pad:      { t: 8, r: 8, b: 18, l: 44 },   /* default plot padding          */
  padTight: { t: 4, r: 4, b: 4,  l: 4 },    /* lanes, sparks, strips         */
  fs:       { micro: 8.5, small: 9.5, axis: 10.5, body: 11.5, val: 14 },
  lineW:    1.25,
  dotR:     2,
  gapMs:    300000,     /* §6.2 tick clustering threshold, 300 seconds       */
  brushMin: 6,          /* §6.7 drag beyond 6px becomes a brush             */
  dash:     '3 3',
  dotted:   '1 2',
  axisDensity: { full: 560, thin: 300 },    /* §6.6 breakpoints              */
  layers:   ['bg', 'series', 'fg', 'overlay']
};
TDC.K = K;

/* ---------------------------------------------------------------------------
   1 · TDC.C — the token mirror (§3.7)
   Read once at boot from getComputedStyle(:root).  charts.js cannot afford a
   custom-property lookup per frame and SVG presentation attributes cannot read
   them at all, so the values are mirrored here.  Fallbacks are rgb() triples
   of the same tokens so that a page which has not loaded styles.css (the
   standalone probe, a stylesheet failure) still draws a legible instrument
   rather than a black rectangle.
   --------------------------------------------------------------------------- */
var TOKENS = [
  ['ground',    '--ground',    'rgb(11,11,12)'],
  ['surface',   '--surface',   'rgb(20,20,22)'],
  ['surface2',  '--surface2',  'rgb(26,26,29)'],
  ['raised',    '--raised',    'rgb(33,33,37)'],
  ['rule',      '--rule',      'rgb(38,38,42)'],
  ['ruleHi',    '--rule-hi',   'rgb(51,51,58)'],
  ['ink',       '--ink',       'rgb(242,242,240)'],
  ['soft',      '--soft',      'rgb(142,142,136)'],
  ['faint',     '--faint',     'rgb(92,92,88)'],
  ['gate',      '--gate',      'rgb(255,212,0)'],
  ['sel',       '--sel',       'rgb(169,139,255)'],
  ['breach',    '--breach',    'rgb(255,90,71)'],
  ['ok',        '--ok',        'rgb(47,217,143)'],
  ['bkReal',    '--bk-real',   'rgb(242,242,240)'],
  ['bkNogates', '--bk-nogates','rgb(91,157,255)'],
  ['bkNohedge', '--bk-nohedge','rgb(142,142,136)'],
  ['bkNaive',   '--bk-naive',  'rgb(110,106,90)'],
  ['iv',        '--iv',        'rgb(255,212,0)'],
  ['rv',        '--rv',        'rgb(127,166,201)'],
  ['premium',   '--premium',   'rgba(255,212,0,0.14)']
];

var C = null;   /* let-bound below; every mark reads C.<token> at call time,
                   so a re-read propagates to already-registered draw fns.   */

function readTokens() {
  var out = {}, cs = null;
  try { cs = global.getComputedStyle(doc.documentElement); } catch (e) { cs = null; }
  for (var i = 0; i < TOKENS.length; i++) {
    var name = TOKENS[i][0], prop = TOKENS[i][1], fall = TOKENS[i][2], v = '';
    if (cs) { try { v = (cs.getPropertyValue(prop) || '').trim(); } catch (e2) { v = ''; } }
    out[name] = v || fall;
  }
  /* Book identity by series key, so panels never map key→colour by hand. */
  out.book = {
    real:            out.bkReal,
    shadow_nogates:  out.bkNogates,
    shadow_nohedge:  out.bkNohedge,
    baseline_naive:  out.bkNaive
  };
  C = Object.freeze(out);
  TDC.C = C;
  return C;
}
TDC.readTokens = readTokens;
readTokens();

/* ---------------------------------------------------------------------------
   2 · Small utilities
   --------------------------------------------------------------------------- */
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function num(v) { return (v === null || v === undefined || v === '' || isNaN(+v)) ? null : +v; }
function arr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

/* Naive-UTC parse.  The journal writes "2026-09-03T19:47:12" with no zone and
   means UTC; a few fields ("2026-09-04T00:32:51+00:00") carry one.  Anything
   without an explicit offset is read as UTC — never as browser-local, which
   would slide the whole instrument by the reader's timezone. */
var TZ_RE = /(?:Z|z|[+-]\d{2}:?\d{2})$/;
function ms(t) {
  if (t == null || t === '') return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  var s = String(t).trim();
  if (!s) return NaN;
  if (s.indexOf('T') < 0 && s.indexOf(' ') > 0) s = s.replace(' ', 'T');
  if (s.indexOf('T') < 0) { var d0 = Date.parse(s); return isNaN(d0) ? NaN : d0; }
  if (!TZ_RE.test(s)) s += 'Z';
  var d = Date.parse(s);
  return isNaN(d) ? NaN : d;
}
TDC.ms = ms;

function dayKey(m) { return new Date(m).toISOString().slice(0, 10); }

/* Binary search: index of the last element of `a` whose value is <= v. */
function bisect(a, v, key) {
  var lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1, x = key ? key(a[mid]) : a[mid];
    if (x <= v) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/* Nice-number machinery for linear axes. */
function niceNum(x, round) {
  if (!(x > 0)) return 1;
  var exp = Math.floor(Math.log(x) / Math.LN10), f = x / Math.pow(10, exp), nf;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else       nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}
function niceStep(lo, hi, n) {
  var span = niceNum(hi - lo || Math.abs(hi) || 1, false);
  return niceNum(span / Math.max(n - 1, 1), true);
}
function round2(v, step) {                    /* kill float dust on ticks */
  var dp = Math.max(0, -Math.floor(Math.log(step) / Math.LN10));
  return +v.toFixed(Math.min(dp + 1, 12));
}

/* ---------------------------------------------------------------------------
   3 · TDC.fmt — formatters (§6.1)
   pct() takes a FRACTION (0.4561 -> "45.61%").  pctRaw() takes a number that
   is already in percent units (book.pnl_pct = 0.461 -> "0.46%").  Two names,
   because this export mixes both conventions and a silent 100× is the kind of
   error a judge finds.
   --------------------------------------------------------------------------- */
var NFC = {};
function group(v, dp) {
  var k = dp | 0, f = NFC[k];
  if (!f) {
    try {
      f = new Intl.NumberFormat('en-US', { minimumFractionDigits: k, maximumFractionDigits: k });
    } catch (e) {
      f = { format: function (x) { return x.toFixed(k); } };
    }
    NFC[k] = f;
  }
  return f.format(v);
}
function sign(v, plus) { return v < 0 ? MINUS : (plus ? '+' : ''); }

var fmt = {
  DASH: '—',                                   /* the one "no value" glyph */

  num: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, false) + group(Math.abs(v), dp);
  },
  int: function (v) { return fmt.num(v, 0); },
  sgn: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, true) + group(Math.abs(v), dp);
  },
  usd: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, true) + '$' + group(Math.abs(v), dp);
  },
  usd0: function (v) { return fmt.usd(v, 0); },
  /* money with no forced sign, for a limit or a ceiling */
  money: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, false) + '$' + group(Math.abs(v), dp);
  },
  pct: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, false) + group(Math.abs(v) * 100, dp) + '%';
  },
  pctRaw: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    dp = dp == null ? 2 : dp;
    return sign(v, false) + group(Math.abs(v), dp) + '%';
  },
  vol: function (v) {
    v = num(v); if (v === null) return fmt.DASH;
    return sign(v, false) + Math.abs(v).toFixed(4);
  },
  ratio: function (v, dp) {
    v = num(v); if (v === null) return fmt.DASH;
    return group(v, dp == null ? 2 : dp) + '×';
  },
  greek: function (v, dp) {                       /* signed, 2dp, no currency */
    return fmt.sgn(v, dp == null ? 2 : dp);
  },
  count: function (v) {
    v = num(v); if (v === null) return fmt.DASH;
    return group(Math.round(v), 0);
  },
  /* "26/57 (45.6%)" — a rate is never printed without its denominator. */
  rate: function (n, d, dp) {
    n = num(n); d = num(d);
    if (n === null || !d) return fmt.DASH;
    return fmt.count(n) + '/' + fmt.count(d) + ' (' + (n / d * 100).toFixed(dp == null ? 1 : dp) + '%)';
  },

  ts: function (t, mode) {
    var m = ms(t);
    if (isNaN(m)) return fmt.DASH;
    var d = new Date(m), iso = d.toISOString();
    switch (mode || 'abs') {
      case 'iso':  return iso.replace('.000', '');
      case 'hm':   return iso.slice(11, 16);
      case 'hms':  return iso.slice(11, 19);
      case 'md':   return iso.slice(5, 10);
      case 'ymd':  return iso.slice(0, 10);
      case 'dow':  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] + ' ' +
                          d.getUTCDate() + ' ' +
                          ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      case 'rel':  return fmt.age(t);
      case 'full': return iso.slice(0, 10) + ' ' + iso.slice(11, 19) + 'Z';
      default:     return iso.slice(5, 10) + ' ' + iso.slice(11, 16) + 'Z';
    }
  },
  age: function (t, now) {
    var m = ms(t);
    if (isNaN(m)) return fmt.DASH;
    var s = Math.round(((now == null ? Date.now() : now) - m) / 1000), ahead = s < 0;
    s = Math.abs(s);
    var out;
    if (s < 45) out = 'just now';
    else if (s < 3600) out = Math.round(s / 60) + 'm';
    else if (s < 86400) out = Math.floor(s / 3600) + 'h ' + Math.round(s % 3600 / 60) + 'm';
    else out = Math.floor(s / 86400) + 'd ' + Math.round(s % 86400 / 3600) + 'h';
    if (out === 'just now') return out;
    return ahead ? ('in ' + out) : (out + ' ago');
  },
  dur: function (hours) {
    var v = num(hours); if (v === null) return fmt.DASH;
    return v < 1 ? (Math.round(v * 60) + 'm') : (v.toFixed(1) + 'h');
  },
  /* HTML, not text — callers assign to innerHTML. */
  id: function (sid) {
    var s = sid == null ? '' : String(sid);
    return '<span class="id">' + esc(s.slice(0, 8)) + '</span>';
  },
  short: function (sid, n) {
    var s = sid == null ? '' : String(sid);
    return s.slice(0, n || 8);
  },
  hair: HAIR,
  minus: MINUS
};
TDC.fmt = fmt;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
TDC.esc = esc;

/* ---------------------------------------------------------------------------
   4 · The shared tick index (§6.2)

   The series do not share timestamps: 85 of 91 series.signal times are absent
   from series.books.real, and the four books hold 88/87/87/87 points over a
   union of 89.  Plotting by array position offsets the shadow books by hours
   and silently misrepresents the ablation, so every chart on this page is
   plotted against ONE ordinal index built by clustering every timestamp in the
   export with a 300-second threshold.  A vertical rule at index i therefore
   means the same tick in every panel.

   NO PANEL MAY COMPUTE AN X POSITION FROM AN ARRAY INDEX.
   --------------------------------------------------------------------------- */
var SERIES_FOR_INDEX = ['signal', 'gates', 'desk', 'refusals', 'integrity', 'derisk', 'ticks'];

function collectStamps(data) {
  var out = [];
  if (!data) return out;
  var S = data.series || {}, i, k;

  function eat(rows, field) {
    if (!rows || !rows.length) return;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      if (!r) continue;
      var t = r[field || 't'];
      if (t) out.push(t);
      if (r.te) out.push(r.te);          /* series.ticks carries t and te */
    }
  }
  for (i = 0; i < SERIES_FOR_INDEX.length; i++) eat(S[SERIES_FOR_INDEX[i]]);
  if (S.books) for (k in S.books) if (Object.prototype.hasOwnProperty.call(S.books, k)) eat(S.books[k]);
  if (S.manage) for (k in S.manage) if (Object.prototype.hasOwnProperty.call(S.manage, k)) eat(S.manage[k]);
  eat(data.decisions);
  return out;
}

function buildIndex(stamps) {
  /* unique, parsed, sorted */
  var seen = Object.create(null), pts = [], i;
  for (i = 0; i < stamps.length; i++) {
    var s = stamps[i];
    if (s == null) continue;
    var key = typeof s === 'string' ? s : String(s);
    if (seen[key] !== undefined) continue;
    var m = ms(s);
    if (isNaN(m)) { seen[key] = -1; continue; }
    seen[key] = m;
    pts.push(m);
  }
  pts.sort(function (a, b) { return a - b; });

  var ticks = [], cur = null;
  for (i = 0; i < pts.length; i++) {
    if (cur && pts[i] - cur.end <= K.gapMs) { cur.end = pts[i]; cur.k++; }
    else { cur = { i: ticks.length, ms: pts[i], end: pts[i], k: 1 }; ticks.push(cur); }
  }

  var dayBreaks = [], days = [], prevDay = null;
  for (i = 0; i < ticks.length; i++) {
    var t = ticks[i], d = dayKey(t.ms);
    t.day = d;
    t.t = new Date(t.ms).toISOString().replace('.000', '');
    t.first = d !== prevDay;
    if (t.first) {
      if (i > 0) dayBreaks.push(i);
      days.push({ day: d, i0: i, i1: i, idx: days.length });
      prevDay = d;
    }
    t.dayIdx = days.length - 1;
    days[days.length - 1].i1 = i;
    t.span = Math.round((t.end - t.ms) / 1000);
  }

  var starts = ticks.map(function (x) { return x.ms; });
  var cache = Object.create(null);

  var ix = {
    n: ticks.length,
    ticks: ticks,
    days: days,
    dayBreaks: dayBreaks,
    ms0: ticks.length ? ticks[0].ms : NaN,
    ms1: ticks.length ? ticks[ticks.length - 1].end : NaN,

    /* exact-or-containing; -1 when the stamp falls in a closed gap */
    at: function (t) {
      if (t == null) return -1;
      var key = typeof t === 'string' ? t : null;
      if (key !== null && cache[key] !== undefined) return cache[key];
      var m = ms(t), r = -1;
      if (!isNaN(m)) {
        var j = bisect(starts, m);
        if (j >= 0 && m <= ticks[j].end + 1) r = j;
      }
      if (key !== null) cache[key] = r;
      return r;
    },
    /* nearest cluster; never fails while the index has ticks */
    near: function (t) {
      if (!ticks.length) return -1;
      var m = typeof t === 'number' ? t : ms(t);
      if (isNaN(m)) return -1;
      var j = bisect(starts, m);
      if (j < 0) return 0;
      if (m <= ticks[j].end) return j;
      if (j + 1 >= ticks.length) return j;
      return (m - ticks[j].end) <= (ticks[j + 1].ms - m) ? j : j + 1;
    },
    /* exact-or-nearest, for a row whose stamp sits inside a closed gap */
    of: function (t) { var i2 = ix.at(t); return i2 >= 0 ? i2 : ix.near(t); },

    msOf: function (i) { var t2 = ticks[i]; return t2 ? t2.ms : NaN; },
    tOf:  function (i) { var t2 = ticks[i]; return t2 ? t2.t : null; },
    dayOf: function (i) { var t2 = ticks[i]; return t2 ? t2.day : null; },

    isBreak: function (i) { return i > 0 && i < ticks.length && ticks[i].first; },
    breakBetween: function (a, b) {
      if (a === b) return false;
      var lo = Math.min(a, b), hi = Math.max(a, b);
      for (var j = 0; j < dayBreaks.length; j++) {
        if (dayBreaks[j] > lo && dayBreaks[j] <= hi) return true;
      }
      return false;
    },

    /* '1d' | '3d' | 'Nd' | 'all' | [i0,i1] -> [i0,i1] */
    slice: function (range) {
      var last = Math.max(ticks.length - 1, 0);
      if (!ticks.length) return [0, 0];
      if (Array.isArray(range)) {
        var a = clamp(Math.round(num(range[0]) || 0), 0, last);
        var b = clamp(Math.round(num(range[1]) === null ? last : num(range[1])), 0, last);
        return a <= b ? [a, b] : [b, a];
      }
      var s = String(range || 'all').toLowerCase();
      if (s === 'all' || s === '') return [0, last];
      var mm = /^(\d+)d$/.exec(s);
      if (mm) {
        var k = Math.max(1, +mm[1]);
        var from = days[Math.max(0, days.length - k)];
        return [from ? from.i0 : 0, last];
      }
      /* a bare session date, e.g. '2026-09-02' */
      for (var j = 0; j < days.length; j++) if (days[j].day === s) return [days[j].i0, days[j].i1];
      return [0, last];
    },

    label: function (i, mode) {
      var t2 = ticks[i];
      if (!t2) return fmt.DASH;
      return fmt.ts(t2.ms, mode || 'abs');
    },

    /* diagnostics — the probe prints these */
    stats: function () {
      var spans = ticks.map(function (t2) { return t2.span; }).sort(function (a, b) { return a - b; });
      return {
        stamps: pts.length,
        ticks: ticks.length,
        days: days.length,
        maxSpan: spans.length ? spans[spans.length - 1] : 0,
        medianSpan: spans.length ? spans[spans.length >> 1] : 0
      };
    }
  };
  return ix;
}

var idxCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
TDC.index = {
  build: function (data) {
    if (!data) return buildIndex([]);
    if (idxCache && idxCache.has(data)) return idxCache.get(data);
    var ix = buildIndex(collectStamps(data));
    if (idxCache) idxCache.set(data, ix);
    return ix;
  },
  from: function (stamps) { return buildIndex(arr(stamps)); },
  stamps: collectStamps
};

/* Map a raw series onto the index once: [{t,…}] -> [{i, v, row}].
   `val` may be a field name or a function. */
TDC.bind = function (rows, index, val, opts) {
  opts = opts || {};
  var out = [], f = (typeof val === 'function') ? val : function (r) { return r[val]; };
  for (var j = 0; j < (rows || []).length; j++) {
    var r = rows[j];
    if (!r) continue;
    var i = index.of(r.t);
    if (i < 0) continue;
    var v = f(r, j);
    if (v === undefined) v = null;
    if (opts.drop && (v === null || !isFinite(v))) continue;
    out.push({ i: i, v: (v === null ? null : +v), row: r });
  }
  out.sort(function (a, b) { return a.i - b.i; });
  return out;
};

/* Extent of a bound series, ignoring nulls. */
TDC.extent = function () {
  var lo = Infinity, hi = -Infinity;
  for (var a = 0; a < arguments.length; a++) {
    var pts = arguments[a] || [];
    for (var j = 0; j < pts.length; j++) {
      var v = pts[j] && pts[j].v;
      if (v === null || v === undefined || !isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return (lo === Infinity) ? null : [lo, hi];
};

/* ---------------------------------------------------------------------------
   5 · Scales (§6.4)
   --------------------------------------------------------------------------- */
TDC.scaleOrdinal = function (o) {
  var n = Math.max(o.n | 0, 0), r = o.range || [0, 1], po = o.padOuter || 0;
  var x0 = r[0] + po, x1 = r[1] - po, span = x1 - x0;
  var step = n > 1 ? span / (n - 1) : 0;
  var f = function (i) {
    if (n <= 1) return (x0 + x1) / 2;
    return x0 + i * step;
  };
  f.invert = function (px) {
    if (n <= 1) return 0;
    return clamp(Math.round((px - x0) / step), 0, n - 1);
  };
  f.band = n > 1 ? step : (span || 1);
  f.n = n; f.step = step; f.range = [r[0], r[1]]; f.kind = 'ordinal';
  return f;
};

TDC.scaleLinear = function (o) {
  var d = o.domain || [0, 1], r = o.range || [0, 1];
  var lo = num(d[0]), hi = num(d[1]);
  if (lo === null || hi === null) { lo = 0; hi = 1; }
  if (lo > hi) { var t = lo; lo = hi; hi = t; }
  if (lo === hi) { var p = Math.abs(lo) * 0.05 || 1; lo -= p; hi += p; }
  var want = o.ticks || 4, step = null;
  if (o.nice !== false) {
    step = niceStep(lo, hi, want + 1);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (o.zero && lo > 0) lo = 0;
    if (o.zero && hi < 0) hi = 0;
  }
  var f = function (v) {
    v = num(v);
    if (v === null) return NaN;
    return r[0] + (v - lo) / (hi - lo) * (r[1] - r[0]);
  };
  f.invert = function (px) { return lo + (px - r[0]) / (r[1] - r[0]) * (hi - lo); };
  f.ticks = function (k) {
    k = k || want;
    var st = niceStep(lo, hi, k + 1), out = [], v = Math.ceil(lo / st) * st, guard = 0;
    while (v <= hi + st * 1e-6 && guard++ < 200) { out.push(round2(v, st)); v += st; }
    return out;
  };
  f.domain = [lo, hi]; f.range = [r[0], r[1]]; f.step = step; f.kind = 'linear';
  f.clamp = function (v) { return clamp(num(v) === null ? lo : +v, lo, hi); };
  return f;
};

/* The scale every time panel uses.  Both modes take an INDEX and return an x,
   so a panel's marks keep their {i,v} shape whichever axis mode is live and no
   panel ever divides by an array length. */
TDC.scaleTick = function (o) {
  var ix = o.index, r = o.range || [0, 1];
  var last = Math.max((ix ? ix.n : 1) - 1, 0);
  var i0 = clamp(o.i0 == null ? 0 : o.i0 | 0, 0, last);
  var i1 = clamp(o.i1 == null ? last : o.i1 | 0, 0, last);
  if (i1 < i0) { var t = i0; i0 = i1; i1 = t; }
  var mode = o.mode === 'time' ? 'time' : 'session';
  var f, ord, lin;

  if (mode === 'time' && ix && ix.n) {
    lin = TDC.scaleLinear({
      domain: [ix.ticks[i0].ms, ix.ticks[i1].ms],
      range: r, nice: false
    });
    f = function (i) {
      var t2 = ix.ticks[clamp(Math.round(i), 0, last)];
      return t2 ? lin(t2.ms) : NaN;
    };
    f.invert = function (px) { return clamp(ix.near(lin.invert(px)), i0, i1); };
    f.band = (r[1] - r[0]) / Math.max(i1 - i0, 1);
    f.time = lin;
  } else {
    ord = TDC.scaleOrdinal({ n: (i1 - i0 + 1), range: r, padOuter: o.padOuter || 0 });
    f = function (i) { return ord(i - i0); };
    f.invert = function (px) { return i0 + ord.invert(px); };
    f.band = ord.band;
  }
  f.i0 = i0; f.i1 = i1; f.mode = mode; f.index = ix; f.range = [r[0], r[1]]; f.kind = 'tick';
  f.visible = function (i) { return i >= i0 && i <= i1; };
  return f;
};

/* ---------------------------------------------------------------------------
   6 · Mount and context (§6.3)
   --------------------------------------------------------------------------- */
var uid = 0;
var frame = { queued: false, jobs: [] };
function schedule(fn) {
  frame.jobs.push(fn);
  if (frame.queued) return;
  frame.queued = true;
  (global.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
    frame.queued = false;
    var jobs = frame.jobs; frame.jobs = [];
    for (var i = 0; i < jobs.length; i++) { try { jobs[i](); } catch (e) { err(e); } }
  });
}
function err(e) { if (global.console && console.error) console.error('[TDC]', e); }

/* clientWidth/Height include the host's padding, so anything sized from them
   overflows a padded panel body.  Everything measures the content box. */
function contentBox(el) {
  var w = el.clientWidth || 0, h = el.clientHeight || 0;
  if (!w && !h) return [0, 0];
  try {
    var cs = global.getComputedStyle(el);
    w = Math.max(0, w - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
    h = Math.max(0, h - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0));
  } catch (e) { /* keep the padded numbers rather than none */ }
  return [w, h];
}

function svgNode(tag, attrs, text) {
  var e = doc.createElementNS(SVGNS, tag);
  if (attrs) for (var k in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    e.setAttribute(k, String(v));
  }
  if (text !== null && text !== undefined) e.textContent = String(text);
  return e;
}
TDC.node = svgNode;

function makeCtx(host, opts) {
  var id = ++uid;
  var svg = svgNode('svg', {
    'class': 'tdc',
    'data-tdc': id,
    preserveAspectRatio: 'xMinYMin meet',
    role: 'img',
    focusable: 'false'
  });
  svg.style.display = 'block';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.fontVariantNumeric = 'tabular-nums';   /* every numeral, §hard rule */
  svg.style.overflow = 'visible';

  var defs = svgNode('defs');
  var clipId = 'tdc-clip-' + id;
  var clipRect = svgNode('rect', { x: 0, y: 0, width: 1, height: 1 });
  var clip = svgNode('clipPath', { id: clipId });
  clip.appendChild(clipRect);
  defs.appendChild(clip);
  svg.appendChild(defs);

  var ctx = {
    id: id, el: host, svg: svg, defs: defs, clipId: clipId,
    w: 0, h: 0, iw: 0, ih: 0,
    pad: { t: K.pad.t, r: K.pad.r, b: K.pad.b, l: K.pad.l },
    x: null, y: null, y2: null, index: null,
    fixed: null,
    draw: null,
    _layers: {},
    _subs: [],
    _order: (opts && opts.layers) ? opts.layers.slice() : K.layers.slice()
  };

  ctx.g = function (name) {
    var g = ctx._layers[name];
    if (!g) {
      g = svgNode('g', {
        'class': 'lyr lyr-' + name, 'data-layer': name,
        transform: 'translate(' + ctx.pad.l + ',' + ctx.pad.t + ')'
      });
      ctx._layers[name] = g;
      svg.appendChild(g);
      if (name === 'series') g.setAttribute('clip-path', 'url(' + '#' + clipId + ')');
    }
    return g;
  };
  ctx.clear = function (name) {
    if (name === undefined) { for (var k in ctx._layers) ctx.clear(k); return; }
    var g = ctx._layers[name];
    if (g) while (g.firstChild) g.removeChild(g.firstChild);
  };
  ctx.node = svgNode;
  ctx.add = function (layer, tag, attrs, text) {
    var e = svgNode(tag, attrs, text);
    ctx.g(layer || 'series').appendChild(e);
    return e;
  };
  ctx.setX = function (s) { ctx.x = s; return s; };
  ctx.setY = function (s) { ctx.y = s; return s; };
  ctx.setIndex = function (ix) { ctx.index = ix; return ix; };
  ctx.px = function (i) { return ctx.x ? ctx.x(i) : NaN; };
  ctx.py = function (v) { return ctx.y ? ctx.y(v) : NaN; };

  ctx.setContentSize = function (w, h) {
    ctx.fixed = { w: w, h: h };
    apply(w, h);
    svg.style.width = w + 'px';
    svg.style.height = h + 'px';
  };

  function apply(w, h) {
    ctx.w = w; ctx.h = h;
    ctx.iw = Math.max(0, w - ctx.pad.l - ctx.pad.r);
    ctx.ih = Math.max(0, h - ctx.pad.t - ctx.pad.b);
    svg.setAttribute('viewBox', '0 0 ' + Math.max(w, 1) + ' ' + Math.max(h, 1));
    for (var k in ctx._layers) {
      ctx._layers[k].setAttribute('transform', 'translate(' + ctx.pad.l + ',' + ctx.pad.t + ')');
    }
    clipRect.setAttribute('width', Math.max(ctx.iw, 1));
    clipRect.setAttribute('height', Math.max(ctx.ih, 1));
  }

  ctx.measure = function () {
    ctx.fixed = null;
    svg.style.width = '100%';
    svg.style.height = '100%';
    var cb = contentBox(host), w = cb[0], h = cb[1];
    apply(w, h);
    return w > 0 && h > 0;
  };

  ctx.render = function () {
    if (!(ctx.w > 0 && ctx.h > 0)) return false;
    ctx._painters = [];          /* draw() re-registers its overlay painters */
    ctx.clear();
    if (typeof ctx.draw === 'function') { try { ctx.draw(ctx); } catch (e) { err(e); } }
    ctx.paint();
    return true;
  };
  /* overlay-only repaint — the hover path, target under 4ms */
  ctx.paint = function () {
    for (var i = 0; i < ctx._painters.length; i++) {
      try { ctx._painters[i](); } catch (e) { err(e); }
    }
  };
  ctx._painters = [];
  ctx.onPaint = function (fn) {
    ctx._painters.push(fn);
    return function () {
      var j = ctx._painters.indexOf(fn);
      if (j >= 0) ctx._painters.splice(j, 1);
    };
  };
  /* Exactly one cursor subscription per ctx per group, created once and kept
     for the life of the ctx — draw() runs on every state pass and must not
     stack up listeners. */
  ctx._cursorGroups = {};
  ctx.subscribeCursor = function (group) {
    group = group || 'time';
    if (ctx._cursorGroups[group]) return;
    ctx._cursorGroups[group] = true;
    ctx.own(TDC.cursor.on(function () { ctx.paint(); }, group));
  };
  ctx.own = function (off) { if (typeof off === 'function') ctx._subs.push(off); return off; };

  ctx.destroy = function () {
    for (var i = 0; i < ctx._subs.length; i++) { try { ctx._subs[i](); } catch (e) { err(e); } }
    ctx._subs = []; ctx._painters = [];
    if (ctx._ro) { try { ctx._ro.disconnect(); } catch (e2) {} ctx._ro = null; }
    if (svg.parentNode) svg.parentNode.removeChild(svg);
    if (host.__tdc === ctx) { try { delete host.__tdc; } catch (e3) { host.__tdc = null; } }
  };

  /* layers in declared order */
  for (var i = 0; i < ctx._order.length; i++) ctx.g(ctx._order[i]);
  host.appendChild(svg);

  if (global.ResizeObserver) {
    var lastW = -1, lastH = -1, pending = false;
    ctx._ro = new global.ResizeObserver(function () {
      var w = host.clientWidth || 0, h = host.clientHeight || 0;
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      if (pending) return;
      pending = true;
      schedule(function () { pending = false; ctx.measure(); ctx.render(); });
    });
    try { ctx._ro.observe(host); } catch (e4) { err(e4); }
  }
  return ctx;
}

/* Idempotent: the same host always yields the same ctx.  Panels re-mount on
   every state pass; nothing accumulates. */
TDC.mount = function (host, opts) {
  if (!host) return null;
  opts = opts || {};
  var ctx = host.__tdc;
  if (ctx && (!ctx.svg || ctx.svg.parentNode !== host)) { try { ctx.destroy(); } catch (e) {} ctx = null; }
  if (!ctx) { ctx = makeCtx(host, opts); host.__tdc = ctx; }
  if (opts.pad) {
    ctx.pad = {
      t: opts.pad.t == null ? K.pad.t : opts.pad.t,
      r: opts.pad.r == null ? K.pad.r : opts.pad.r,
      b: opts.pad.b == null ? K.pad.b : opts.pad.b,
      l: opts.pad.l == null ? K.pad.l : opts.pad.l
    };
  }
  if (opts.layers) { for (var i = 0; i < opts.layers.length; i++) ctx.g(opts.layers[i]); }
  if (opts.index) ctx.index = opts.index;
  if (opts.draw) ctx.draw = opts.draw;
  if (opts.label) ctx.svg.setAttribute('aria-label', opts.label);
  ctx._painters = [];                 /* overlays re-register inside draw */
  ctx.measure();
  ctx.render();
  return ctx;
};

TDC.unmount = function (host) {
  if (host && host.__tdc) host.__tdc.destroy();
};

/* A bare svg for the DOM-hosted marks (spark, strip, bullets, barsH).  No
   observer, no layers — these are cheap, redrawn wholesale by their panel. */
function mini(el, w, h, cls, par) {
  while (el.firstChild) el.removeChild(el.firstChild);
  var svg = svgNode('svg', {
    'class': 'tdc ' + (cls || ''),
    viewBox: '0 0 ' + Math.max(w, 1) + ' ' + Math.max(h, 1),
    /* text-bearing marks keep their aspect ratio if a stylesheet stretches
       them; a sparkline is happy to stretch. */
    preserveAspectRatio: par || 'xMinYMin meet',
    focusable: 'false'
  });
  svg.style.display = 'block';
  svg.style.width = w + 'px';
  svg.style.height = h + 'px';
  svg.style.fontVariantNumeric = 'tabular-nums';
  el.appendChild(svg);
  return {
    svg: svg,
    add: function (tag, attrs, text) { var e = svgNode(tag, attrs, text); svg.appendChild(e); return e; }
  };
}
TDC.mini = mini;

/* Mono advance is ~0.6em.  A gutter is a promise: text that will not fit is
   truncated with an ellipsis and keeps its full value in a <title>, rather
   than running across the mark next to it. */
function tw(s, fs) { return String(s == null ? '' : s).length * (fs || K.fs.small) * 0.6; }
function fitText(s, maxW, fs) {
  s = String(s == null ? '' : s);
  var per = (fs || K.fs.small) * 0.6, n = Math.floor(maxW / per);
  if (n >= s.length) return s;
  if (n <= 1) return '';
  return s.slice(0, n - 1) + '…';
}

function hostBox(el, w, h, dw, dh) {
  var cb = contentBox(el);
  var W = w || cb[0] || dw || 100;
  var H = h || cb[1] || dh || 20;
  return [Math.max(1, Math.round(W)), Math.max(1, Math.round(H))];
}

/* ---------------------------------------------------------------------------
   7 · Marks (§6.5)
   Every mark takes the layer to draw into (`layer`, default 'series') and an
   optional `key`, written as data-key so selection dimming can find it:
   TDC.dim(ctx, k => k === selectedKey).
   --------------------------------------------------------------------------- */
function segments(pts, x, y, opts) {
  /* Split into contiguous runs, breaking on null values and — when gaps are on
     and an index is available — on a session boundary, so the overnight close
     is a discontinuity and not a straight line across the night. */
  var idx = opts.index, gaps = opts.gaps !== false;
  var out = [], run = [], prev = null;
  for (var j = 0; j < pts.length; j++) {
    var p = pts[j], v = p ? p.v : null;
    if (v === null || v === undefined || !isFinite(v)) { if (run.length) { out.push(run); run = []; } prev = null; continue; }
    if (prev !== null && gaps && idx && idx.breakBetween(prev, p.i)) { if (run.length) { out.push(run); run = []; } }
    var X = x(p.i), Y = y(v);
    if (isFinite(X) && isFinite(Y)) run.push([X, Y, p]);
    prev = p.i;
  }
  if (run.length) out.push(run);
  return out;
}
function dPath(run, closeTo) {
  var d = '', j;
  for (j = 0; j < run.length; j++) d += (j ? 'L' : 'M') + run[j][0].toFixed(2) + ' ' + run[j][1].toFixed(2);
  if (closeTo !== undefined && run.length) {
    d += 'L' + run[run.length - 1][0].toFixed(2) + ' ' + closeTo.toFixed(2);
    d += 'L' + run[0][0].toFixed(2) + ' ' + closeTo.toFixed(2) + 'Z';
  }
  return d;
}
function stepRun(run) {
  var d = '', j;
  for (j = 0; j < run.length; j++) {
    if (!j) d += 'M' + run[j][0].toFixed(2) + ' ' + run[j][1].toFixed(2);
    else d += 'L' + run[j][0].toFixed(2) + ' ' + run[j - 1][1].toFixed(2) +
              'L' + run[j][0].toFixed(2) + ' ' + run[j][1].toFixed(2);
  }
  return d;
}
function scalesOf(ctx, o) {
  return { x: o.x || ctx.x, y: o.y || ctx.y, index: o.index || ctx.index };
}

TDC.line = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var runs = segments(o.pts || [], s.x, s.y, { index: s.index, gaps: o.gaps });
  var g = ctx.add(layer, 'g', {
    'class': 'mk mk-line' + (o.cls ? ' ' + o.cls : ''),
    'data-key': o.key || null,
    'data-sel': o.sel ? '1' : null
  });
  for (var j = 0; j < runs.length; j++) {
    g.appendChild(svgNode('path', {
      d: dPath(runs[j]),
      fill: 'none',
      stroke: o.color || C.ink,
      'stroke-width': o.width == null ? K.lineW : o.width,
      'stroke-dasharray': o.dash || null,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      opacity: o.opacity == null ? null : o.opacity,
      'vector-effect': 'non-scaling-stroke'
    }));
  }
  if (o.dot === 'last' && runs.length) {
    var lastRun = runs[runs.length - 1], p = lastRun[lastRun.length - 1];
    g.appendChild(svgNode('circle', {
      cx: p[0].toFixed(2), cy: p[1].toFixed(2), r: o.dotR || K.dotR,
      fill: o.color || C.ink, 'class': 'mk-dot'
    }));
  }
  if (o.title) g.appendChild(svgNode('title', null, o.title));
  return g;
};

TDC.area = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var base = s.y(o.baseline == null ? 0 : o.baseline);
  if (!isFinite(base)) base = ctx.ih;
  var runs = segments(o.pts || [], s.x, s.y, { index: s.index, gaps: o.gaps });
  var g = ctx.add(layer, 'g', {
    'class': 'mk mk-area' + (o.cls ? ' ' + o.cls : ''),
    'data-key': o.key || null
  });
  for (var j = 0; j < runs.length; j++) {
    if (runs[j].length < 2) continue;
    g.appendChild(svgNode('path', {
      d: dPath(runs[j], base),
      fill: o.fill || C.ink,
      'fill-opacity': o.opacity == null ? 0.18 : o.opacity,
      stroke: 'none'
    }));
  }
  if (o.line) {
    TDC.line(ctx, {
      pts: o.pts, color: o.lineColor || o.fill || C.ink, width: o.lineWidth || 1,
      index: s.index, x: s.x, y: s.y, layer: layer, key: o.key, gaps: o.gaps
    });
  }
  if (o.title) g.appendChild(svgNode('title', null, o.title));
  return g;
};

/* The IV/RV premium fill: the area between two series on the same index. */
TDC.band = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var up = {}, j, i;
  for (j = 0; j < (o.upper || []).length; j++) { var pu = o.upper[j]; if (pu && isNum(pu.v)) up[pu.i] = pu.v; }
  var pairs = [];
  for (j = 0; j < (o.lower || []).length; j++) {
    var pl = o.lower[j];
    if (!pl || !isNum(pl.v)) continue;
    if (up[pl.i] === undefined) continue;
    pairs.push({ i: pl.i, a: up[pl.i], b: pl.v });
  }
  pairs.sort(function (p, q) { return p.i - q.i; });

  var g = ctx.add(layer, 'g', { 'class': 'mk mk-band' + (o.cls ? ' ' + o.cls : ''), 'data-key': o.key || null });
  var run = [], prev = null;
  function flush() {
    if (run.length > 1) {
      var d = '', r;
      for (i = 0; i < run.length; i++) { r = run[i]; d += (i ? 'L' : 'M') + s.x(r.i).toFixed(2) + ' ' + s.y(r.a).toFixed(2); }
      for (i = run.length - 1; i >= 0; i--) { r = run[i]; d += 'L' + s.x(r.i).toFixed(2) + ' ' + s.y(r.b).toFixed(2); }
      d += 'Z';
      g.appendChild(svgNode('path', { d: d, fill: o.fill || C.premium, 'fill-opacity': o.opacity == null ? null : o.opacity, stroke: 'none' }));
    }
    run = [];
  }
  for (j = 0; j < pairs.length; j++) {
    if (prev !== null && o.gaps !== false && s.index && s.index.breakBetween(prev, pairs[j].i)) flush();
    run.push(pairs[j]); prev = pairs[j].i;
  }
  flush();
  if (o.title) g.appendChild(svgNode('title', null, o.title));
  return g;
};

TDC.step = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var runs = segments(o.pts || [], s.x, s.y, { index: s.index, gaps: o.gaps });
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-step' + (o.cls ? ' ' + o.cls : ''), 'data-key': o.key || null });
  for (var j = 0; j < runs.length; j++) {
    var run = runs[j], d = stepRun(run);
    if (run.length === 1) d = 'M' + run[0][0].toFixed(2) + ' ' + run[0][1].toFixed(2) + 'h' + (s.x.band || 2).toFixed(2);
    g.appendChild(svgNode('path', {
      d: d, fill: 'none', stroke: o.color || C.ink,
      'stroke-width': o.width == null ? K.lineW : o.width,
      'stroke-dasharray': o.dash || null,
      'vector-effect': 'non-scaling-stroke'
    }));
  }
  if (o.fill) {
    for (var k = 0; k < runs.length; k++) {
      if (runs[k].length < 2) continue;
      var base = s.y(o.baseline == null ? 0 : o.baseline);
      g.appendChild(svgNode('path', {
        d: stepRun(runs[k]) + 'L' + runs[k][runs[k].length - 1][0].toFixed(2) + ' ' + base.toFixed(2) +
           'L' + runs[k][0][0].toFixed(2) + ' ' + base.toFixed(2) + 'Z',
        fill: o.fill, 'fill-opacity': o.opacity == null ? 0.14 : o.opacity, stroke: 'none'
      }));
    }
  }
  return g;
};

/* Stacked area over the union of indices, last value carried forward — the
   honest join for series that do not share timestamps. */
TDC.stack = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var series = o.series || [], all = {}, j, k;
  for (j = 0; j < series.length; j++) {
    for (k = 0; k < (series[j].pts || []).length; k++) all[series[j].pts[k].i] = 1;
  }
  var idxs = Object.keys(all).map(Number).sort(function (a, b) { return a - b; });
  var maps = series.map(function (se) {
    var m = {};
    for (var q = 0; q < (se.pts || []).length; q++) if (isNum(se.pts[q].v)) m[se.pts[q].i] = se.pts[q].v;
    return m;
  });
  var running = new Array(idxs.length), last = series.map(function () { return 0; });
  for (j = 0; j < idxs.length; j++) running[j] = 0;
  var bands = [];
  var base = o.baseline == null ? 0 : o.baseline;
  for (k = 0; k < series.length; k++) {
    var top = [], bot = [];
    for (j = 0; j < idxs.length; j++) {
      var v = maps[k][idxs[j]];
      if (v === undefined) v = last[k]; else last[k] = v;
      bot.push({ i: idxs[j], v: base + running[j] });
      running[j] += v;
      top.push({ i: idxs[j], v: base + running[j] });
    }
    bands.push(TDC.band(ctx, {
      upper: top, lower: bot, fill: series[k].fill || C.soft,
      opacity: series[k].opacity == null ? 0.5 : series[k].opacity,
      x: s.x, y: s.y, index: s.index, layer: layer, key: series[k].key,
      title: series[k].label, gaps: o.gaps
    }));
  }
  return bands;
};

/* Vertical bars on the tick index. */
TDC.barsV = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x || !s.y) return null;
  var w = o.width || Math.max(1, Math.min(10, (s.x.band || 3) * 0.7));
  var base = s.y(o.baseline == null ? 0 : o.baseline);
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-barsv', 'data-key': o.key || null });
  for (var j = 0; j < (o.bars || []).length; j++) {
    var b = o.bars[j];
    if (!b || !isNum(b.v)) continue;
    var X = s.x(b.i), Y = s.y(b.v);
    if (!isFinite(X) || !isFinite(Y)) continue;
    var r = svgNode('rect', {
      x: (X - w / 2).toFixed(2), y: Math.min(Y, base).toFixed(2),
      width: w.toFixed(2), height: Math.max(Math.abs(Y - base), 0.75).toFixed(2),
      fill: b.color || o.color || C.ink,
      'fill-opacity': b.opacity == null ? (o.opacity == null ? 0.8 : o.opacity) : b.opacity,
      'data-key': b.key || null, 'data-sel': b.sel ? '1' : null, 'class': 'bar'
    });
    if (b.title) r.appendChild(svgNode('title', null, b.title));
    if (o.onBar) { r.style.cursor = 'pointer'; (function (bb) { r.addEventListener('click', function (ev) { o.onBar(bb, ev); }); })(b); }
    g.appendChild(r);
  }
  return g;
};

/* Histogram of raw values; builds its own local scales and returns them so the
   panel can hang axes off the same numbers. */
TDC.histogram = function (ctx, o) {
  var vals = (o.values || []).map(num).filter(function (v) { return v !== null; });
  var layer = o.layer || 'series';
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-hist', 'data-key': o.key || null });
  if (!vals.length) return { g: g, bins: [], x: null, y: null };
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (lo === hi) { hi = lo + 1; }
  var nb = Math.max(2, o.bins || 20), step = (hi - lo) / nb, bins = [], j;
  for (j = 0; j < nb; j++) bins.push({ lo: lo + j * step, hi: lo + (j + 1) * step, n: 0 });
  for (j = 0; j < vals.length; j++) {
    var b = clamp(Math.floor((vals[j] - lo) / step), 0, nb - 1);
    bins[b].n++;
  }
  var maxN = 0;
  for (j = 0; j < nb; j++) maxN = Math.max(maxN, bins[j].n);
  var x = TDC.scaleLinear({ domain: [lo, hi], range: o.range || [0, ctx.iw], nice: false });
  var y = TDC.scaleLinear({ domain: [0, maxN], range: o.rangeY || [ctx.ih, 0], nice: true });
  var gap = o.gap == null ? 1 : o.gap;
  for (j = 0; j < nb; j++) {
    var X0 = x(bins[j].lo), X1 = x(bins[j].hi), Y = y(bins[j].n), Y0 = y(0);
    var r = svgNode('rect', {
      x: (X0 + gap / 2).toFixed(2), y: Y.toFixed(2),
      width: Math.max(0.5, X1 - X0 - gap).toFixed(2), height: Math.max(0, Y0 - Y).toFixed(2),
      fill: o.color || C.soft, 'fill-opacity': o.opacity == null ? 0.7 : o.opacity, 'class': 'bar'
    });
    r.appendChild(svgNode('title', null, fmt.num(bins[j].lo, 2) + ' – ' + fmt.num(bins[j].hi, 2) + ': ' + bins[j].n));
    g.appendChild(r);
  }
  return { g: g, bins: bins, x: x, y: y };
};

TDC.scatter = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  var xs = o.xScale || s.x, ys = o.y || s.y;
  if (!xs || !ys) return null;
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-scatter', 'data-key': o.key || null });
  for (var j = 0; j < (o.pts || []).length; j++) {
    var p = o.pts[j];
    if (!p || !isNum(p.v)) continue;
    var X = (p.x !== undefined && o.xScale) ? xs(p.x) : xs(p.i);
    var Y = ys(p.v);
    if (!isFinite(X) || !isFinite(Y)) continue;
    var c = svgNode('circle', {
      cx: X.toFixed(2), cy: Y.toFixed(2), r: p.r || o.r || K.dotR,
      fill: p.color || o.color || C.ink,
      'fill-opacity': p.opacity == null ? (o.opacity == null ? 0.85 : o.opacity) : p.opacity,
      stroke: p.stroke || o.stroke || null, 'stroke-width': o.strokeWidth || null,
      'data-key': p.key || null, 'data-sel': p.sel ? '1' : null, 'class': 'dot'
    });
    if (p.title) c.appendChild(svgNode('title', null, p.title));
    if (o.onPoint) { c.style.cursor = 'pointer'; (function (pp) { c.addEventListener('click', function (ev) { o.onPoint(pp, ev); }); })(p); }
    g.appendChild(c);
  }
  return g;
};

/* Categorical ribbon lane — regime, analyst vote, second opinion.  Runs of the
   same category merge into one rect, so 68 meetings are a handful of nodes. */
TDC.categoryLane = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x) return null;
  var y = o.y == null ? 0 : o.y, h = o.h == null ? 12 : o.h;
  var colors = o.colors || {}, band = s.x.band || 3;
  var pts = (o.pts || []).slice().sort(function (a, b) { return a.i - b.i; });
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-lane' + (o.cls ? ' ' + o.cls : ''), 'data-key': o.key || null });
  var j, run = null, out = [];
  for (j = 0; j < pts.length; j++) {
    var p = pts[j];
    if (run && run.c === p.c && p.i === run.i1 + 1 && !(s.index && s.index.isBreak(p.i))) { run.i1 = p.i; run.n++; }
    else { run = { c: p.c, i0: p.i, i1: p.i, n: 1, row: p.row }; out.push(run); }
  }
  for (j = 0; j < out.length; j++) {
    var r = out[j];
    var x0 = s.x(r.i0) - band / 2, x1 = s.x(r.i1) + band / 2;
    var col = colors[r.c] === undefined ? (colors._ || C.raised) : colors[r.c];
    if (col === null) continue;
    var rect = svgNode('rect', {
      x: x0.toFixed(2), y: y, width: Math.max(x1 - x0, 1).toFixed(2), height: h,
      fill: col, 'fill-opacity': o.opacity == null ? null : o.opacity,
      'class': 'lane-cell', 'data-c': r.c == null ? null : String(r.c),
      'data-i0': r.i0, 'data-i1': r.i1
    });
    rect.appendChild(svgNode('title', null,
      (o.label ? o.label + ' · ' : '') + (r.c == null ? fmt.DASH : r.c) +
      (r.n > 1 ? (' ×' + r.n) : '') +
      (s.index ? (' · ' + s.index.label(r.i0, 'abs')) : '')));
    if (o.onCell) { rect.style.cursor = 'pointer'; (function (rr) { rect.addEventListener('click', function (ev) { o.onCell(rr, ev); }); })(r); }
    g.appendChild(rect);
  }
  /* the label sits in the left pad, so it must not go in the clipped layer */
  if (o.label && o.labelAt !== false) {
    ctx.add(o.labelLayer || 'fg', 'text', {
      x: -6, y: y + h - Math.max(0, (h - K.fs.small) / 2), 'text-anchor': 'end',
      fill: C.faint, 'font-size': K.fs.small, 'class': 'lane-label'
    }, o.label);
  }
  return g;
};

/* Event lane — refusal ticks, entry carets, derisk bands, veto markers. */
TDC.eventLane = function (ctx, o) {
  var s = scalesOf(ctx, o), layer = o.layer || 'series';
  if (!s.x) return null;
  var y = o.y == null ? 0 : o.y, h = o.h == null ? 10 : o.h;
  var glyph = o.glyph || 'tick', band = s.x.band || 3;
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-events mk-' + glyph, 'data-key': o.key || null });
  var marks = (o.marks || []).slice().sort(function (a, b) { return a.i - b.i; });
  var j, e;

  /* label first: every glyph gets one, and it lives in the unclipped pad */
  if (o.label) {
    ctx.add(o.labelLayer || 'fg', 'text', {
      x: -6, y: y + h, 'text-anchor': 'end', fill: C.faint, 'font-size': K.fs.small, 'class': 'lane-label'
    }, o.label);
  }

  if (glyph === 'band') {
    var runs = [], cur = null, maxGap = o.bandGap == null ? 1 : o.bandGap;
    for (j = 0; j < marks.length; j++) {
      var m = marks[j];
      if (cur && m.i - cur.i1 <= maxGap) { cur.i1 = m.i; cur.n++; }
      else { cur = { i0: m.i, i1: m.i, n: 1, mark: m }; runs.push(cur); }
    }
    for (j = 0; j < runs.length; j++) {
      var rn = runs[j], bx0 = s.x(rn.i0) - band / 2, bx1 = s.x(rn.i1) + band / 2;
      e = svgNode('rect', {
        x: bx0.toFixed(2), y: y, width: Math.max(bx1 - bx0, 1).toFixed(2), height: h,
        fill: rn.mark.color || o.color || C.gate,
        'fill-opacity': o.opacity == null ? 0.16 : o.opacity,
        'class': 'ev ev-band', 'data-kind': rn.mark.kind || null,
        'data-sel': rn.mark.sel ? '1' : null
      });
      e.appendChild(svgNode('title', null, (rn.mark.title || rn.mark.kind || '') + (rn.n > 1 ? (' ×' + rn.n) : '')));
      g.appendChild(e);
    }
    return g;
  }

  for (j = 0; j < marks.length; j++) {
    var mk = marks[j], X = s.x(mk.i);
    if (!isFinite(X)) continue;
    var col = mk.color || o.color || C.gate;
    if (glyph === 'caret') {
      e = svgNode('path', {
        d: 'M' + X.toFixed(2) + ' ' + y + 'L' + (X + h / 2).toFixed(2) + ' ' + (y + h) +
           'L' + (X - h / 2).toFixed(2) + ' ' + (y + h) + 'Z',
        fill: col, 'class': 'ev ev-caret'
      });
    } else if (glyph === 'hollow') {
      e = svgNode('circle', {
        cx: X.toFixed(2), cy: (y + h / 2).toFixed(2), r: Math.min(h, 7) / 2 - 0.5,
        fill: 'none', stroke: col, 'stroke-width': 1, 'class': 'ev ev-hollow'
      });
    } else {
      e = svgNode('rect', {
        x: (X - (o.w || 1) / 2).toFixed(2), y: y, width: (o.w || 1), height: h,
        fill: col, 'class': 'ev ev-tick'
      });
    }
    e.setAttribute('data-kind', mk.kind || '');
    if (mk.sel) e.setAttribute('data-sel', '1');
    if (mk.key) e.setAttribute('data-key', mk.key);
    e.appendChild(svgNode('title', null, mk.title || mk.kind || (s.index ? s.index.label(mk.i, 'abs') : '')));
    if (o.onMark) { e.style.cursor = 'pointer'; (function (mm) { e.addEventListener('click', function (ev) { o.onMark(mm, ev); }); })(mk); }
    g.appendChild(e);
  }
  return g;
};

/* The gate matrix.  value(row, col) -> 1 pass | 0 fail | null not reached.
   Sizes itself and asks the ctx for the content width, so the panel body
   scrolls horizontally rather than the cells shrinking into mush. */
TDC.heatmap = function (ctx, o) {
  var rows = o.rows || [], cols = Array.isArray(o.cols) ? o.cols.length : (o.cols | 0);
  var cell = o.cell || {}, cw = cell.w || 6, ch = cell.h || 12, gap = cell.gap == null ? 1 : cell.gap;
  var labelW = o.labelW == null ? 108 : o.labelW, rightW = o.rightW == null ? 62 : o.rightW;
  var headH = o.headH == null ? 0 : o.headH;
  var colors = o.colors || {};
  var cPass = colors.pass || C.raised, cFail = colors.fail || C.breach, cNone = colors.none || 'none';
  var needW = labelW + cols * (cw + gap) + rightW + ctx.pad.l + ctx.pad.r;
  var needH = headH + rows.length * (ch + gap) + ctx.pad.t + ctx.pad.b;
  if (o.fit !== false) ctx.setContentSize(Math.max(needW, ctx.w || 0), Math.max(needH, o.minH || 0, ctx.h || 0));

  var layer = o.layer || 'series';
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-heat' });
  var j, k;
  for (j = 0; j < rows.length; j++) {
    var row = rows[j], y = headH + j * (ch + gap);
    var lab = svgNode('text', {
      x: labelW - 6, y: y + ch - Math.max(0, (ch - K.fs.small) / 2) - 1, 'text-anchor': 'end',
      fill: (row.sel ? C.sel : (row.mute ? C.faint : C.soft)), 'font-size': K.fs.small,
      'class': 'heat-row-label', 'data-key': row.id || null, 'data-sel': row.sel ? '1' : null
    }, fitText(row.label == null ? row.id : row.label, labelW - 8, K.fs.small));
    if (o.onRow) { lab.style.cursor = 'pointer'; (function (rr) { lab.addEventListener('click', function (ev) { o.onRow(rr, ev); }); })(row); }
    lab.appendChild(svgNode('title', null,
      (row.label == null ? row.id : row.label) + (row.title ? ('\n' + row.title) : '')));
    g.appendChild(lab);

    for (k = 0; k < cols; k++) {
      var v = o.value ? o.value(row, k) : null;
      var x = labelW + k * (cw + gap);
      var attrs = {
        x: x, y: y, width: cw, height: ch, 'class': 'cell',
        'data-r': row.id || j, 'data-c': k,
        'data-state': v === null || v === undefined ? 'none' : (v ? 'pass' : 'fail')
      };
      if (v === null || v === undefined) {
        attrs.fill = cNone;
        attrs.stroke = C.rule;
        attrs['stroke-dasharray'] = K.dotted;
        attrs['stroke-width'] = 1;
      } else if (v) {
        attrs.fill = cPass;
      } else {
        attrs.fill = cFail;
        attrs['fill-opacity'] = colors.failOpacity == null ? 0.55 : colors.failOpacity;
      }
      var r2 = svgNode('rect', attrs);
      if (v) { /* pass cells carry the 1px top edge §5 C1 */
        g.appendChild(svgNode('rect', { x: x, y: y, width: cw, height: 1, fill: C.ruleHi, 'class': 'cell-edge' }));
      }
      var ttl = o.cellTitle ? o.cellTitle(row, k, v) : null;
      if (ttl) r2.appendChild(svgNode('title', null, ttl));
      if (o.onCell) { r2.style.cursor = 'pointer'; (function (rr, kk, vv) { r2.addEventListener('click', function (ev) { o.onCell(rr, kk, vv, ev); }); })(row, k, v); }
      if (o.onHover) { (function (rr, kk) { r2.addEventListener('mouseenter', function (ev) { o.onHover(rr, kk, ev); }); })(row, k); }
      g.appendChild(r2);
    }
    if (o.rowRight) {
      var txt = o.rowRight(row, j);
      if (txt != null) {
        g.appendChild(svgNode('text', {
          x: labelW + cols * (cw + gap) + rightW - 4, y: y + ch - Math.max(0, (ch - K.fs.small) / 2) - 1,
          'text-anchor': 'end', fill: row.hot ? C.gate : C.soft, 'font-size': K.fs.small, 'class': 'heat-row-right'
        }, txt));
      }
    }
  }
  if (o.colRule) {
    for (k = 0; k < cols; k++) {
      if (!o.colRule(k)) continue;
      g.appendChild(svgNode('rect', {
        x: labelW + k * (cw + gap) - gap / 2, y: 0, width: 1, height: headH + rows.length * (ch + gap),
        fill: C.rule, 'class': 'heat-col-rule'
      }));
    }
  }
  g.__geom = { labelW: labelW, cw: cw, ch: ch, gap: gap, headH: headH, cols: cols };
  return g;
};

/* Six bullet bars against published ceilings (C2).  Neutral until the limit is
   crossed, then amber.  A row with used===null draws its limit and prints why
   the used side is missing — it never draws a zero. */
TDC.bullets = function (el, o) {
  var rows = o.rows || [];
  var rowH = o.rowH || 22, box = hostBox(el, o.w, o.h || rows.length * rowH, 240, rows.length * rowH);
  var W = box[0], H = Math.max(box[1], rows.length * rowH);
  var m = mini(el, W, H, 'tdc-bullets');
  var warnAt = o.warnAt == null ? 1.0 : o.warnAt;
  var j, r;

  /* size the value gutter from the widest string it will actually hold */
  var rightText = [], widest = 0;
  for (j = 0; j < rows.length; j++) {
    r = rows[j];
    var fj = r.fmt || fmt.money, lj = num(r.limit), uj = num(r.used);
    var s = (uj === null)
      ? (r.note || 'used: not published')
      : (fj(uj) + ' / ' + fj(lj) + (lj ? ('  ' + (uj / lj * 100).toFixed(0) + '%') : ''));
    rightText.push(s);
    widest = Math.max(widest, tw(s, K.fs.small));
  }
  var labelW = o.labelW == null ? Math.min(96, W * 0.3) : o.labelW;
  var valueW = o.valueW == null ? clamp(widest + 6, 56, W * 0.55) : o.valueW;
  var barX = labelW + 4, barW = Math.max(20, W - labelW - valueW - 10);

  for (j = 0; j < rows.length; j++) {
    r = rows[j];
    var y = j * rowH, mid = y + rowH / 2;
    var f = r.fmt || fmt.money;
    var lim = num(r.limit), used = num(r.used), cap = num(r.cap);
    var top = Math.max(lim || 0, cap || 0, used || 0) || 1;
    var bh = o.barH || 7, by = mid - bh / 2 + 1;

    var lt = m.add('text', {
      x: 0, y: mid + 3, fill: r.sel ? C.sel : C.soft, 'font-size': K.fs.small,
      'class': 'bullet-label', 'data-key': r.id || r.label
    }, fitText(r.label, labelW - 4, K.fs.small));
    lt.appendChild(svgNode('title', null, r.label));

    m.add('rect', { x: barX, y: by, width: barW, height: bh, fill: C.raised, 'class': 'bullet-trough' });

    if (used !== null && lim) {
      var frac = used / top, ratio = used / lim;
      m.add('rect', {
        x: barX, y: by, width: Math.max(1, barW * clamp(frac, 0, 1)), height: bh,
        fill: ratio >= warnAt ? C.gate : C.soft, 'fill-opacity': ratio >= warnAt ? 0.9 : 0.55,
        'class': 'bullet-fill', 'data-warn': ratio >= warnAt ? '1' : '0'
      });
    }
    if (lim) {
      var lx = barX + barW * clamp(lim / top, 0, 1);
      m.add('rect', { x: lx - 0.5, y: by - 2, width: 1, height: bh + 4, fill: C.gate, 'class': 'bullet-limit' });
    }
    if (cap && cap !== lim) {
      var cx = barX + barW * clamp(cap / top, 0, 1);
      m.add('rect', { x: cx - 0.5, y: by - 2, width: 1, height: bh + 4, fill: C.faint, 'class': 'bullet-cap' });
    }
    var right = rightText[j];
    m.add('text', {
      x: W, y: mid + 3, 'text-anchor': 'end',
      fill: used === null ? C.faint : (lim && used / lim >= warnAt ? C.gate : C.ink),
      'font-size': K.fs.small, 'class': 'bullet-value'
    }, right);
    if (o.onRow) {
      var hit = m.add('rect', { x: 0, y: y, width: W, height: rowH, fill: C.ground, 'fill-opacity': 0, 'class': 'bullet-hit' });
      hit.style.cursor = 'pointer';
      (function (rr) { hit.addEventListener('click', function (ev) { o.onRow(rr, ev); }); })(r);
      hit.appendChild(svgNode('title', null, r.title || r.label));
    }
  }
  return m.svg;
};

/* Paired horizontal bars — COUNT and RATE on separate scales (C3).  'shared'
   scales each series across all rows; 'row' normalises each pair to its row. */
TDC.barsH = function (el, o) {
  var rows = o.rows || [], rowH = o.rowH || 22;
  var box = hostBox(el, o.w, o.h || rows.length * rowH, 240, rows.length * rowH);
  var W = box[0], H = Math.max(box[1], rows.length * rowH);
  var m = mini(el, W, H, 'tdc-barsh');
  var labelW = o.labelW == null ? Math.min(112, W * 0.36) : o.labelW;
  var valueW = o.valueW == null ? Math.min(84, W * 0.26) : o.valueW;
  var barX = labelW + 4, barW = Math.max(16, W - labelW - valueW - 8);
  var cols = o.colors || [C.soft, C.gate];
  var maxA = 0, maxB = 0, j;
  for (j = 0; j < rows.length; j++) {
    maxA = Math.max(maxA, Math.abs(num(rows[j].a) || 0));
    maxB = Math.max(maxB, Math.abs(num(rows[j].b) || 0));
  }
  var fa = (o.fmt && o.fmt.a) || fmt.count, fb = (o.fmt && o.fmt.b) || function (v) { return fmt.pct(v, 1); };

  for (j = 0; j < rows.length; j++) {
    var r = rows[j], y = j * rowH;
    var a = num(r.a), b = num(r.b);
    var ta = o.scale === 'row' ? Math.max(Math.abs(a || 0), Math.abs(b || 0)) || 1 : (maxA || 1);
    var tb = o.scale === 'row' ? Math.max(Math.abs(a || 0), Math.abs(b || 0)) || 1 : (maxB || 1);
    /* the pair needs enough vertical room for two value labels to clear each
       other; at the default rowH that is 12px of baseline separation */
    var bh = o.barH || 5, gap = o.pairGap == null ? 3 : o.pairGap;
    var yA = y + rowH / 2 - bh - gap, yB = y + rowH / 2 + gap;

    var blt = m.add('text', {
      x: 0, y: y + rowH / 2 + 3, fill: r.sel ? C.sel : C.soft, 'font-size': K.fs.small,
      'class': 'barh-label', 'data-key': r.id || r.label, 'data-sel': r.sel ? '1' : null
    }, fitText(r.label, labelW - 4, K.fs.small));
    blt.appendChild(svgNode('title', null, r.title || r.label));

    if (a !== null) {
      m.add('rect', {
        x: barX, y: yA, width: Math.max(1, barW * clamp(Math.abs(a) / ta, 0, 1)), height: bh,
        fill: cols[0], 'fill-opacity': 0.85, 'class': 'barh-a'
      });
    }
    if (b !== null) {
      m.add('rect', {
        x: barX, y: yB, width: Math.max(1, barW * clamp(Math.abs(b) / tb, 0, 1)), height: bh,
        fill: cols[1], 'fill-opacity': 0.85, 'class': 'barh-b'
      });
    }
    m.add('text', {
      x: W, y: yA + bh - 1, 'text-anchor': 'end', fill: C.ink, 'font-size': K.fs.small, 'class': 'barh-va'
    }, a === null ? fmt.DASH : fa(a));
    m.add('text', {
      x: W, y: yB + bh + 4, 'text-anchor': 'end', fill: C.soft, 'font-size': K.fs.small, 'class': 'barh-vb'
    }, b === null ? fmt.DASH : fb(b));

    if (o.onRow) {
      var hit = m.add('rect', { x: 0, y: y, width: W, height: rowH, fill: C.ground, 'fill-opacity': 0, 'class': 'barh-hit' });
      hit.style.cursor = 'pointer';
      (function (rr) { hit.addEventListener('click', function (ev) { o.onRow(rr, ev); }); })(r);
      if (r.title) hit.appendChild(svgNode('title', null, r.title));
    }
  }
  return m.svg;
};

/* Closed-trade waterfall (D3).  Direction is geometry against a labelled zero
   rule; every bar is the same ink, because a loss is not a different colour. */
TDC.waterfall = function (ctx, o) {
  var items = o.items || [], total = o.total || null;
  var n = items.length + (total ? 1 : 0);
  if (!n) return null;
  var layer = o.layer || 'series';
  var run = 0, steps = [], j, lo = 0, hi = 0;
  for (j = 0; j < items.length; j++) {
    var v = num(items[j].v) || 0;
    steps.push({ label: items[j].label, id: items[j].id, v: v, from: run, to: run + v, item: items[j] });
    run += v;
    lo = Math.min(lo, run); hi = Math.max(hi, run);
  }
  if (total) {
    var tv = num(total.v) === null ? run : num(total.v);
    steps.push({ label: total.label, id: total.id, v: tv, from: 0, to: tv, total: true });
    lo = Math.min(lo, tv, 0); hi = Math.max(hi, tv, 0);
  }
  var x = TDC.scaleOrdinal({ n: n, range: [0, ctx.iw], padOuter: ctx.iw / (n * 2) });
  var y = o.y || TDC.scaleLinear({ domain: [lo, hi], range: [ctx.ih - (o.labelH == null ? 12 : o.labelH), 0], nice: true, zero: true });
  var bw = Math.max(4, (x.band || 12) * (o.barFrac || 0.62));
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-waterfall' });

  for (j = 0; j < steps.length; j++) {
    var s = steps[j], X = x(j), y0 = y(s.from), y1 = y(s.to);
    var rect = svgNode('rect', {
      x: (X - bw / 2).toFixed(2), y: Math.min(y0, y1).toFixed(2),
      width: bw.toFixed(2), height: Math.max(Math.abs(y1 - y0), 1).toFixed(2),
      fill: C.ink, 'fill-opacity': s.total ? 0.92 : 0.5,
      'class': 'wf-bar' + (s.total ? ' wf-total' : ''), 'data-key': s.id || s.label,
      'data-sel': (o.selId && s.id === o.selId) ? '1' : null
    });
    rect.appendChild(svgNode('title', null, (s.label || '') + ' · ' + fmt.usd(s.v)));
    if (o.onBar) { rect.style.cursor = 'pointer'; (function (ss) { rect.addEventListener('click', function (ev) { o.onBar(ss, ev); }); })(s); }
    g.appendChild(rect);

    if (j < steps.length - 1 && !steps[j + 1].total) {
      g.appendChild(svgNode('rect', {
        x: X.toFixed(2), y: y(s.to).toFixed(2), width: Math.max(1, x.step - bw).toFixed(2), height: 1,
        fill: C.rule, 'class': 'wf-link'
      }));
    }
    if (o.labels !== false) {
      g.appendChild(svgNode('text', {
        x: X.toFixed(2), y: (Math.min(y0, y1) - 3).toFixed(2), 'text-anchor': 'middle',
        fill: s.total ? C.ink : C.soft, 'font-size': K.fs.micro, 'class': 'wf-val'
      }, fmt.usd(s.v, 0)));
      g.appendChild(svgNode('text', {
        x: X.toFixed(2), y: (ctx.ih - 2).toFixed(2), 'text-anchor': 'middle',
        fill: C.faint, 'font-size': K.fs.micro, 'class': 'wf-label'
      }, s.label));
    }
  }
  TDC.rule(ctx, { axis: 'y', value: 0, y: y, color: C.faint, dash: null, label: '0', side: 'left', layer: 'bg' });
  return { g: g, x: x, y: y, steps: steps };
};

/* The 97-cell integrity strip.  This is one of the three places §3.1 permits
   green, and the only mark that will ever draw it — opt in via colors.ok. */
TDC.strip = function (el, o) {
  var cells = o.cells || [], w = o.w || 6, h = o.h || 10, gap = o.gap == null ? 1 : o.gap;
  var box = hostBox(el, o.width, null, 200, 24);
  var W = box[0];
  var per = Math.max(1, Math.floor((W + gap) / (w + gap)));
  var rowsN = Math.ceil(cells.length / per) || 1;
  var H = rowsN * (h + gap) - gap;
  var m = mini(el, W, H, 'tdc-strip');
  var cols = o.colors || {};
  for (var j = 0; j < cells.length; j++) {
    var c = cells[j], r = Math.floor(j / per), k = j % per;
    var fill = c.ok === null || c.ok === undefined
      ? (cols.none || C.raised)
      : (c.ok ? (cols.ok || C.ok) : (cols.bad || C.breach));
    var e = m.add('rect', {
      x: k * (w + gap), y: r * (h + gap), width: w, height: h,
      fill: fill, 'fill-opacity': c.ok === false ? 1 : (o.opacity == null ? 0.9 : o.opacity),
      'class': 'cell ' + (c.ok === false ? 'bad' : (c.ok ? 'ok' : 'none')),
      'data-i': j, 'data-key': c.id == null ? null : String(c.id),
      'data-sel': c.sel ? '1' : null
    });
    if (c.title) e.appendChild(svgNode('title', null, c.title));
    if (o.onCell) { e.style.cursor = 'pointer'; (function (cc, jj) { e.addEventListener('click', function (ev) { o.onCell(cc, jj, ev); }); })(c, j); }
  }
  return m.svg;
};

/* Sparkline.  pts may be [{i,v}] or a bare number array. */
TDC.spark = function (el, o) {
  var raw = o.pts || [], j, pts = [];
  for (j = 0; j < raw.length; j++) {
    var p = raw[j];
    if (p == null) { pts.push({ i: j, v: null }); continue; }
    if (typeof p === 'number') pts.push({ i: j, v: p });
    else pts.push({ i: p.i == null ? j : p.i, v: num(p.v) });
  }
  var box = hostBox(el, o.w, o.h, 44, 16);
  var W = box[0], H = box[1];
  var m = mini(el, W, H, 'tdc-spark', 'none');
  var vals = pts.filter(function (p2) { return p2.v !== null; });
  if (!vals.length) return m.svg;

  var lo = Infinity, hi = -Infinity;
  for (j = 0; j < vals.length; j++) { lo = Math.min(lo, vals[j].v); hi = Math.max(hi, vals[j].v); }
  if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  var i0 = pts[0].i, i1 = pts[pts.length - 1].i;
  var padY = o.padY == null ? 1.5 : o.padY;
  var xs = function (i) { return i1 === i0 ? W / 2 : (i - i0) / (i1 - i0) * (W - 2) + 1; };
  var ys = function (v) { return H - padY - (v - lo) / (hi - lo) * (H - 2 * padY); };

  if (o.zero && lo <= 0 && hi >= 0) {
    m.add('rect', { x: 0, y: ys(0).toFixed(2), width: W, height: 0.75, fill: C.faint, 'fill-opacity': 0.6, 'class': 'spark-zero' });
  }
  if (o.fill) {
    var base = (o.zero && lo <= 0 && hi >= 0) ? ys(0) : H;
    var da = '';
    for (j = 0; j < pts.length; j++) {
      if (pts[j].v === null) continue;
      da += (da ? 'L' : 'M') + xs(pts[j].i).toFixed(2) + ' ' + ys(pts[j].v).toFixed(2);
    }
    if (da) {
      da += 'L' + xs(vals[vals.length - 1].i).toFixed(2) + ' ' + base.toFixed(2) +
            'L' + xs(vals[0].i).toFixed(2) + ' ' + base.toFixed(2) + 'Z';
      m.add('path', { d: da, fill: o.fill, 'fill-opacity': o.fillOpacity == null ? 0.16 : o.fillOpacity, stroke: 'none' });
    }
  }
  var d = '', broke = true;
  for (j = 0; j < pts.length; j++) {
    if (pts[j].v === null) { broke = true; continue; }
    d += (broke ? 'M' : 'L') + xs(pts[j].i).toFixed(2) + ' ' + ys(pts[j].v).toFixed(2);
    broke = false;
  }
  if (o.mode === 'bars') {
    var bwid = Math.max(0.75, (W - 2) / Math.max(pts.length, 1) - 0.5);
    for (j = 0; j < pts.length; j++) {
      if (pts[j].v === null) continue;
      var yb = ys(pts[j].v), y0 = (o.zero && lo <= 0 && hi >= 0) ? ys(0) : H;
      m.add('rect', {
        x: (xs(pts[j].i) - bwid / 2).toFixed(2), y: Math.min(yb, y0).toFixed(2),
        width: bwid.toFixed(2), height: Math.max(Math.abs(y0 - yb), 0.75).toFixed(2),
        fill: o.color || C.soft, 'fill-opacity': 0.8
      });
    }
  } else if (d) {
    m.add('path', {
      d: d, fill: 'none', stroke: o.color || C.ink, 'stroke-width': o.width || 1,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke'
    });
  }
  var mark = o.mark === undefined ? 'last' : o.mark;
  if (mark !== 'none' && vals.length) {
    var lastP = vals[vals.length - 1];
    m.add('circle', {
      cx: xs(lastP.i).toFixed(2), cy: ys(lastP.v).toFixed(2), r: mark === 'close' ? 1.9 : 1.4,
      fill: mark === 'close' ? 'none' : (o.color || C.ink),
      stroke: mark === 'close' ? (o.markColor || C.gate) : null,
      'stroke-width': mark === 'close' ? 1 : null, 'class': 'spark-mark'
    });
  }
  if (o.title) m.svg.appendChild(svgNode('title', null, o.title));
  return m.svg;
};

/* Reference rule.  axis:'y' -> horizontal at a value; axis:'x' -> vertical at
   a tick index.  Both label themselves; neither is ever unlabelled. */
TDC.rule = function (ctx, o) {
  var layer = o.layer || 'fg';
  var g = ctx.add(layer, 'g', { 'class': 'mk mk-rule', 'data-key': o.key || null, 'data-sel': o.sel ? '1' : null });
  var col = o.color || C.faint, dash = (o.dash === null ? null : (o.dash || K.dash));
  var lab, tx, ty, anchor;

  if (o.axis === 'x') {
    var xs = o.x || ctx.x;
    if (!xs) return null;
    var X = xs(o.value);
    if (!isFinite(X)) return null;
    g.appendChild(svgNode('line', {
      x1: X.toFixed(2), y1: o.y0 == null ? 0 : o.y0, x2: X.toFixed(2), y2: o.y1 == null ? ctx.ih : o.y1,
      stroke: col, 'stroke-width': o.width || 1, 'stroke-dasharray': dash, 'vector-effect': 'non-scaling-stroke'
    }));
    if (o.label != null) {
      var wv = tw(o.label, K.fs.small);
      anchor = o.side === 'left' ? 'end' : 'start';
      tx = X + (o.side === 'left' ? -3 : 3);
      /* flip inward rather than run off the plot */
      if (anchor === 'start' && tx + wv > ctx.iw) { anchor = 'end'; tx = X - 3; }
      if (anchor === 'end' && tx - wv < 0) { anchor = 'start'; tx = X + 3; }
      ty = o.labelY == null ? 9 : o.labelY;
      lab = svgNode('text', { x: tx.toFixed(2), y: ty, 'text-anchor': anchor, fill: o.labelColor || col, 'font-size': K.fs.small, 'class': 'rule-label' }, o.label);
      g.appendChild(lab);
    }
  } else {
    var ys = o.y || ctx.y;
    if (!ys) return null;
    var Y = ys(o.value);
    if (!isFinite(Y)) return null;
    g.appendChild(svgNode('line', {
      x1: o.x0 == null ? 0 : o.x0, y1: Y.toFixed(2), x2: o.x1 == null ? ctx.iw : o.x1, y2: Y.toFixed(2),
      stroke: col, 'stroke-width': o.width || 1, 'stroke-dasharray': dash, 'vector-effect': 'non-scaling-stroke'
    }));
    if (o.label != null) {
      var right = o.side === 'right';
      var lw = tw(o.label, K.fs.small);
      var room = right ? (ctx.w - ctx.pad.l - ctx.iw) : ctx.pad.l;
      var inside = lw + 6 > room;          /* no gutter for it — put it inside */
      lab = svgNode('text', {
        x: right ? (inside ? ctx.iw - 3 : ctx.iw + 3) : (inside ? 3 : -4),
        y: (Y - 2).toFixed(2),
        'text-anchor': right ? (inside ? 'end' : 'start') : (inside ? 'start' : 'end'),
        fill: o.labelColor || col, 'font-size': K.fs.small, 'class': 'rule-label'
      }, o.label);
      g.appendChild(lab);
    }
  }
  if (o.title) g.appendChild(svgNode('title', null, o.title));
  return g;
};

/* Selection dimming without removal (§3.5): keep(key) -> true stays lit. */
TDC.dim = function (ctx, keep) {
  var nodes = ctx.svg.querySelectorAll('[data-key]');
  for (var j = 0; j < nodes.length; j++) {
    var k = nodes[j].getAttribute('data-key');
    if (keep == null) nodes[j].removeAttribute('data-dim');
    else if (keep(k)) nodes[j].removeAttribute('data-dim');
    else nodes[j].setAttribute('data-dim', '1');
  }
};

/* ---------------------------------------------------------------------------
   8 · Axes (§6.6)
   --------------------------------------------------------------------------- */
function pickDensity(iw, given) {
  if (given) return given;
  if (iw >= K.axisDensity.full) return 'full';
  if (iw >= K.axisDensity.thin) return 'thin';
  return 'ends';
}

TDC.axisX = function (ctx, o) {
  o = o || {};
  var xs = o.x || ctx.x, ix = o.index || ctx.index || (xs && xs.index);
  if (!xs || !ix || !ix.n) return null;
  var layer = o.layer || 'bg';
  var mode = o.mode || xs.mode || 'session';
  var density = pickDensity(ctx.iw, o.density);
  var y = o.y == null ? ctx.ih : o.y;
  var g = ctx.add(layer, 'g', { 'class': 'ax ax-x' });
  var i0 = xs.i0 == null ? 0 : xs.i0, i1 = xs.i1 == null ? ix.n - 1 : xs.i1, j;

  if (o.baseline !== false) {
    g.appendChild(svgNode('rect', { x: 0, y: y, width: Math.max(ctx.iw, 1), height: 1, fill: C.rule, 'class': 'ax-base' }));
  }

  /* visible sessions */
  var days = [];
  for (j = 0; j < ix.days.length; j++) {
    var d = ix.days[j];
    if (d.i1 < i0 || d.i0 > i1) continue;
    days.push({ day: d.day, i0: Math.max(d.i0, i0), i1: Math.min(d.i1, i1), idx: d.idx });
  }

  if (o.dayRules !== false) {
    for (j = 1; j < days.length; j++) {
      var b = days[j].i0;
      var xr = (xs(b - 1) + xs(b)) / 2;
      if (!isFinite(xr)) continue;
      g.appendChild(svgNode('rect', {
        x: xr.toFixed(2), y: o.ruleTop == null ? 0 : o.ruleTop, width: 1,
        height: Math.max((o.ruleH == null ? y : o.ruleH), 1), fill: C.rule, 'class': 'ax-daybreak'
      }));
    }
  }

  if (o.labelDays === false) return g;

  var show = [];
  if (density === 'ends') show = days.length > 1 ? [days[0], days[days.length - 1]] : days.slice();
  else if (density === 'full' || days.length <= 3) show = days.slice();
  else show = [days[0], days[days.length >> 1], days[days.length - 1]];

  /* A one-tick session is narrower than its own label, so labels are thinned
     rather than allowed to overlap: greedy left to right, and the final
     session always wins the last slot. */
  var cand = [], seen = {};
  for (j = 0; j < show.length; j++) {
    var dd = show[j];
    if (!dd || seen[dd.day]) continue;
    seen[dd.day] = 1;
    var cx = (xs(dd.i0) + xs(dd.i1)) / 2;
    if (!isFinite(cx)) continue;
    var txt = o.dayFormat ? o.dayFormat(dd.day) : dd.day.slice(5);
    var half = tw(txt, K.fs.axis) / 2;
    cand.push({ day: dd.day, x: cx, text: txt, l: cx - half, r: cx + half });
  }
  var kept = [];
  for (j = 0; j < cand.length; j++) {
    if (!kept.length || cand[j].l > kept[kept.length - 1].r + 6) kept.push(cand[j]);
  }
  if (cand.length && kept[kept.length - 1] !== cand[cand.length - 1]) {
    var lastC = cand[cand.length - 1];
    while (kept.length && kept[kept.length - 1].r + 6 >= lastC.l) kept.pop();
    kept.push(lastC);
  }
  for (j = 0; j < kept.length; j++) {
    g.appendChild(svgNode('text', {
      x: kept[j].x.toFixed(2), y: y + (o.labelDy == null ? 11 : o.labelDy), 'text-anchor': 'middle',
      fill: C.faint, 'font-size': K.fs.axis, 'class': 'ax-label ax-day', 'data-day': kept[j].day
    }, kept[j].text));
  }

  if (o.times) {
    /* first and last clock time — skipped where a session label already owns
       that end of the axis, rather than stacked on top of one */
    var ty2 = y + (o.labelDy == null ? 11 : o.labelDy);
    var t0 = ix.label(i0, 'hm'), t1 = ix.label(i1, 'hm');
    var w0 = tw(t0, K.fs.micro), w1 = tw(t1, K.fs.micro);
    var clear0 = true, clear1 = true;
    for (j = 0; j < kept.length; j++) {
      if (kept[j].l < w0 + 4) clear0 = false;
      if (kept[j].r > ctx.iw - w1 - 4) clear1 = false;
    }
    if (clear0) {
      g.appendChild(svgNode('text', {
        x: 0, y: ty2, 'text-anchor': 'start',
        fill: C.faint, 'font-size': K.fs.micro, 'class': 'ax-label ax-time'
      }, t0));
    }
    if (clear1) {
      g.appendChild(svgNode('text', {
        x: ctx.iw, y: ty2, 'text-anchor': 'end',
        fill: C.faint, 'font-size': K.fs.micro, 'class': 'ax-label ax-time'
      }, t1));
    }
  }
  g.setAttribute('data-mode', mode);
  g.setAttribute('data-density', density);
  return g;
};

TDC.axisY = function (ctx, o) {
  o = o || {};
  var ys = o.scale || o.y || ctx.y;
  if (!ys) return null;
  var layer = o.layer || 'bg';
  var side = o.side === 'right' ? 'right' : 'left';
  var want = o.ticks == null ? 4 : o.ticks;
  var room = Math.max(2, Math.floor((o.h == null ? ctx.ih : o.h) / 26));
  var n = Math.max(2, Math.min(want, room));
  var f = o.format || function (v) { return fmt.num(v, Math.abs(v) >= 100 ? 0 : 2); };
  var ticks = ys.ticks ? ys.ticks(n) : [];
  var g = ctx.add(layer, 'g', { 'class': 'ax ax-y ax-' + side });
  var x0 = o.x0 == null ? 0 : o.x0, x1 = o.x1 == null ? ctx.iw : o.x1;

  for (var j = 0; j < ticks.length; j++) {
    var v = ticks[j], Y = ys(v);
    if (!isFinite(Y)) continue;
    var isZero = Math.abs(v) < 1e-9;
    if (isZero && o.zeroRule === false) continue;
    if (o.gridlines !== false || isZero) {
      g.appendChild(svgNode('rect', {
        x: x0, y: Y.toFixed(2), width: Math.max(x1 - x0, 1), height: 1,
        fill: isZero ? C.faint : C.rule,
        'fill-opacity': isZero ? 0.85 : 1,
        'class': 'ax-grid' + (isZero ? ' ax-zero' : '')
      }));
    }
    if (o.labels === false) continue;
    var lt = f(v), lw2 = tw(lt, K.fs.axis);
    var gutter = side === 'right' ? (ctx.w - ctx.pad.l - x1) : (ctx.pad.l + x0);
    var inside2 = lw2 + 5 > gutter;
    g.appendChild(svgNode('text', {
      x: side === 'right' ? (inside2 ? x1 - 3 : x1 + 4) : (inside2 ? x0 + 3 : x0 - 4),
      y: (Y + (inside2 ? -3 : 3)).toFixed(2),
      'text-anchor': side === 'right' ? (inside2 ? 'end' : 'start') : (inside2 ? 'start' : 'end'),
      fill: C.faint, 'font-size': K.fs.axis, 'class': 'ax-label ax-yval'
    }, lt));
  }
  /* the zero rule is always drawn and labelled, even when it is not a tick */
  if (o.zeroRule !== false && ticks.length) {
    var hasZero = ticks.some(function (t) { return Math.abs(t) < 1e-9; });
    var d = ys.domain || [0, 1];
    if (!hasZero && d[0] < 0 && d[1] > 0) {
      var Z = ys(0);
      g.appendChild(svgNode('rect', { x: x0, y: Z.toFixed(2), width: Math.max(x1 - x0, 1), height: 1, fill: C.faint, 'class': 'ax-grid ax-zero' }));
      if (o.labels !== false) {
        g.appendChild(svgNode('text', {
          x: side === 'right' ? (x1 + 4) : (x0 - 4), y: (Z + 3).toFixed(2),
          'text-anchor': side === 'right' ? 'start' : 'end',
          fill: C.faint, 'font-size': K.fs.axis, 'class': 'ax-label ax-yval ax-zerolabel'
        }, '0'));
      }
    }
  }
  if (o.title) {
    g.appendChild(svgNode('text', {
      x: side === 'right' ? x1 + 4 : x0 - 4, y: -4,
      'text-anchor': side === 'right' ? 'start' : 'end',
      fill: C.faint, 'font-size': K.fs.micro, 'class': 'ax-title'
    }, o.title));
  }
  return g;
};

/* ---------------------------------------------------------------------------
   9 · The crosshair bus (§6.7)

   One cursor for the whole page.  Hover NEVER goes through TD.set(): it moves
   an overlay in every subscriber and nothing else.  A click locks, and the lock
   is published to app.js through onLock() so that TD.set({cur,locked}) — and
   the hash, the inspector and the blotter scope — happen in exactly one place.
   --------------------------------------------------------------------------- */
TDC.cursor = (function () {
  var groups = {};
  function bus(name) {
    if (!groups[name]) groups[name] = { subs: [], locks: [], i: null, li: null, locked: false, source: null, dirty: false };
    return groups[name];
  }
  function emit(b) {
    if (b.dirty) return;
    b.dirty = true;
    schedule(function () {
      b.dirty = false;
      var st = { i: b.i, li: b.li, locked: b.locked, source: b.source };
      for (var j = 0; j < b.subs.length; j++) { try { b.subs[j](b.i, st); } catch (e) { err(e); } }
    });
  }
  var api = {
    set: function (i, source, group) {
      var b = bus(group || 'time');
      i = (i === null || i === undefined || i < 0) ? null : Math.round(i);
      if (b.i === i && b.source === source) return;
      b.i = i; b.source = source || null;
      emit(b);
    },
    lock: function (i, source, group) {
      var b = bus(group || 'time');
      i = (i === null || i === undefined || i < 0) ? null : Math.round(i);
      b.li = i; b.i = i; b.locked = i !== null; b.source = source || null;
      emit(b);
      for (var j = 0; j < b.locks.length; j++) { try { b.locks[j](i, b.locked, source); } catch (e) { err(e); } }
    },
    unlock: function (group) {
      var b = bus(group || 'time');
      if (!b.locked && b.li === null) return;
      b.li = null; b.locked = false;
      emit(b);
      for (var j = 0; j < b.locks.length; j++) { try { b.locks[j](null, false, 'unlock'); } catch (e) { err(e); } }
    },
    toggle: function (i, source, group) {
      var b = bus(group || 'time');
      if (b.locked) api.unlock(group); else api.lock(i == null ? b.i : i, source, group);
    },
    get: function (group) {
      var b = bus(group || 'time');
      return { i: b.i, li: b.li, locked: b.locked, source: b.source };
    },
    /* subscribe to cursor movement; returns off() */
    on: function (fn, group) {
      var b = bus(group || 'time');
      b.subs.push(fn);
      return function () { var j = b.subs.indexOf(fn); if (j >= 0) b.subs.splice(j, 1); };
    },
    /* app.js hooks this and routes it to TD.set({cur, locked}) */
    onLock: function (fn, group) {
      var b = bus(group || 'time');
      b.locks.push(fn);
      return function () { var j = b.locks.indexOf(fn); if (j >= 0) b.locks.splice(j, 1); };
    },
    /* Adopt state that already came through TD.set() — the hash router
       restoring x=41&lk=1 on load.  Subscribers repaint; the lock sinks do
       NOT fire, so this cannot bounce back into TD.set(). */
    adopt: function (i, locked, group) {
      var b = bus(group || 'time');
      i = (i === null || i === undefined || i < 0) ? null : Math.round(i);
      b.i = i; b.li = locked ? i : null; b.locked = !!locked && i !== null; b.source = 'state';
      emit(b);
    },
    /* app.js keyboard: step within the visible window */
    step: function (delta, i0, i1, group) {
      var b = bus(group || 'time');
      var cur = b.li !== null ? b.li : (b.i !== null ? b.i : i1);
      api.lock(clamp(cur + delta, i0, i1), 'key', group);
    },
    reset: function (group) {
      var b = bus(group || 'time');
      b.i = null; b.li = null; b.locked = false; b.source = null;
      emit(b);
    }
  };
  return api;
})();

/* The overlay every time panel installs: a locked rule in --sel, a hover rule
   in --rule-hi, and an optional value chip pinned at the panel's right edge.
   Only the overlay layer is touched, so hovering costs one path per panel. */
TDC.cursorOverlay = function (ctx, o) {
  o = o || {};
  var group = o.group || 'time';
  function paint() {
    var xs = o.x || ctx.x;
    if (!xs) return;
    ctx.clear('overlay');
    var st = TDC.cursor.get(group);
    var g = ctx.g('overlay');
    var i;
    for (var pass = 0; pass < 2; pass++) {
      i = pass === 0 ? st.li : st.i;
      if (i === null || i === undefined) continue;
      if (pass === 1 && st.li === i) continue;
      if (xs.visible && !xs.visible(i)) continue;
      var X = xs(i);
      if (!isFinite(X)) continue;
      g.appendChild(svgNode('rect', {
        x: (X - 0.5).toFixed(2), y: o.y0 == null ? 0 : o.y0, width: 1,
        height: (o.y1 == null ? ctx.ih : o.y1),
        fill: pass === 0 ? C.sel : C.ruleHi,
        'class': pass === 0 ? 'cur cur-lock' : 'cur cur-hover'
      }));
      if (pass === 0 && o.dot !== false && o.valueAt) {
        var v = o.valueAt(i);
        if (isNum(v) && ctx.y) {
          g.appendChild(svgNode('circle', { cx: X.toFixed(2), cy: ctx.y(v).toFixed(2), r: 2.5, fill: C.sel, 'class': 'cur-dot' }));
        }
      }
    }
    var showI = st.li !== null ? st.li : st.i;
    if (o.chip && showI !== null && showI !== undefined) {
      var txt = o.chip(showI);
      if (txt) {
        g.appendChild(svgNode('text', {
          x: ctx.iw - 2, y: o.chipY == null ? 9 : o.chipY, 'text-anchor': 'end',
          fill: st.locked ? C.sel : C.soft, 'font-size': K.fs.small, 'class': 'cur-chip'
        }, txt));
      }
    }
  }
  ctx.subscribeCursor(group);
  ctx.onPaint(paint);
  paint();
  return paint;
};

/* Transparent capture rect: hover -> cursor.set, click -> cursor.lock,
   drag past 6px -> brush, double-click -> brush reset. */
TDC.hitline = function (ctx, o) {
  o = o || {};
  var xs = o.x || ctx.x, ix = o.index || ctx.index || (xs && xs.index);
  if (!xs) return null;
  var group = o.group || 'time';
  var g = ctx.g(o.layer || 'hit');
  g.setAttribute('transform', 'translate(' + ctx.pad.l + ',' + ctx.pad.t + ')');
  var rect = svgNode('rect', {
    x: 0, y: o.y0 == null ? 0 : o.y0,
    width: Math.max(ctx.iw, 1), height: Math.max((o.y1 == null ? ctx.ih : o.y1), 1),
    fill: C.ground, 'fill-opacity': 0, 'class': 'hit'
  });
  rect.style.cursor = o.cursor || 'crosshair';
  g.appendChild(rect);

  var brushRect = null, down = null, brushing = false;

  function localX(ev) {
    var b = rect.getBoundingClientRect();
    if (!b.width) return 0;
    return clamp((ev.clientX - b.left) / b.width * ctx.iw, 0, ctx.iw);
  }
  function idxAt(ev) { return xs.invert ? xs.invert(localX(ev)) : 0; }

  rect.addEventListener('pointermove', function (ev) {
    var i = idxAt(ev);
    if (down && !brushing && Math.abs(ev.clientX - down.cx) > K.brushMin) brushing = true;
    if (brushing) {
      if (!brushRect) {
        brushRect = svgNode('rect', { y: 0, height: Math.max(ctx.ih, 1), fill: C.sel, 'fill-opacity': 0.12, 'class': 'brush' });
        g.insertBefore(brushRect, rect);
      }
      var a = Math.min(down.x, localX(ev)), b2 = Math.max(down.x, localX(ev));
      brushRect.setAttribute('x', a.toFixed(2));
      brushRect.setAttribute('width', Math.max(b2 - a, 1).toFixed(2));
    }
    TDC.cursor.set(i, o.id || ctx.id, group);
    if (o.onMove) o.onMove(i, ev);
  });
  rect.addEventListener('pointerleave', function (ev) {
    if (!brushing) TDC.cursor.set(null, o.id || ctx.id, group);
    if (o.onLeave) o.onLeave(ev);
  });
  rect.addEventListener('pointerdown', function (ev) {
    down = { cx: ev.clientX, x: localX(ev), i: idxAt(ev) };
    try { rect.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  rect.addEventListener('pointerup', function (ev) {
    var i = idxAt(ev);
    try { rect.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (brushing && down) {
      var a = Math.min(down.i, i), b2 = Math.max(down.i, i);
      if (brushRect && brushRect.parentNode) brushRect.parentNode.removeChild(brushRect);
      brushRect = null;
      if (o.onBrush && b2 > a) o.onBrush([a, b2]);
    } else {
      if (o.onClick) o.onClick(i, ev);
      else TDC.cursor.lock(i, o.id || ctx.id, group);
    }
    brushing = false; down = null;
  });
  rect.addEventListener('dblclick', function (ev) {
    if (o.onBrush) o.onBrush(null);
    if (o.onDblClick) o.onDblClick(ev);
  });
  return rect;
};

/* ---------------------------------------------------------------------------
   10 · Tooltip singleton (§6.7)
   No fact may exist only in a tooltip — every panel's header readout carries
   its exact current values.  This is for the extra detail, never the number.
   --------------------------------------------------------------------------- */
TDC.tip = (function () {
  var el = null;
  function ensure() {
    if (el && el.parentNode) return el;
    el = doc.createElement('div');
    el.className = 'tdc-tip';
    el.setAttribute('role', 'tooltip');
    el.style.position = 'fixed';
    el.style.zIndex = '9999';
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    el.style.fontVariantNumeric = 'tabular-nums';
    doc.body.appendChild(el);
    /* If styles.css has not claimed .tdc-tip, fall back to the token mirror so
       the tip is legible instead of invisible.  Styled pages keep their rules. */
    var bg = '';
    try { bg = global.getComputedStyle(el).backgroundColor || ''; } catch (e) { bg = ''; }
    if (!bg || bg === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) {
      el.style.background = C.surface2;
      el.style.color = C.ink;
      el.style.border = '1px solid ' + C.ruleHi;
      el.style.padding = '4px 6px';
      el.style.font = '11px/1.35 ' + (K.tipFont || 'ui-monospace, monospace');
      el.style.maxWidth = '280px';
      el.style.whiteSpace = 'normal';
    }
    return el;
  }
  return {
    show: function (x, y, html) {
      var e = ensure();
      e.innerHTML = html;
      e.style.display = 'block';
      e.style.left = '0px'; e.style.top = '0px';
      var b = e.getBoundingClientRect();
      var vw = global.innerWidth || doc.documentElement.clientWidth;
      var vh = global.innerHeight || doc.documentElement.clientHeight;
      var lx = x + 12, ly = y + 12;
      if (lx + b.width > vw - 4) lx = x - b.width - 12;
      if (ly + b.height > vh - 4) ly = y - b.height - 12;
      e.style.left = Math.max(2, lx) + 'px';
      e.style.top = Math.max(2, ly) + 'px';
      return e;
    },
    hide: function () { if (el) el.style.display = 'none'; },
    el: function () { return el; }
  };
})();

/* ---------------------------------------------------------------------------
   11 · Legend (§6.7) — one-way.  It renders what it is given and calls back;
   it never holds its own state.
   --------------------------------------------------------------------------- */
TDC.legend = function (el, o) {
  if (!el) return null;
  var items = o.items || [];
  while (el.firstChild) el.removeChild(el.firstChild);
  el.className = (el.className.indexOf('legend') >= 0 ? el.className : (el.className + ' legend')).trim();
  for (var j = 0; j < items.length; j++) {
    (function (it) {
      var b = doc.createElement('button');
      b.type = 'button';
      b.className = 'lg chip' + (it.struck ? ' struck' : '');
      b.setAttribute('data-key', it.key);
      b.setAttribute('data-on', it.on === false ? '0' : '1');
      b.setAttribute('aria-pressed', it.on === false ? 'false' : 'true');
      if (it.title) b.title = it.title;
      var sw = doc.createElementNS(SVGNS, 'svg');
      sw.setAttribute('class', 'sw');
      sw.setAttribute('viewBox', '0 0 8 8');
      sw.setAttribute('width', '8'); sw.setAttribute('height', '8');
      sw.setAttribute('aria-hidden', 'true');
      sw.appendChild(svgNode('rect', { x: 0, y: 2.5, width: 8, height: 3, fill: it.color || C.soft }));
      b.appendChild(sw);
      var t = doc.createElement('span');
      t.className = 'lb';
      t.textContent = it.label;
      b.appendChild(t);
      if (it.note != null) {
        var n2 = doc.createElement('span');
        n2.className = 'ln';
        n2.textContent = it.note;
        b.appendChild(n2);
      }
      if (o.onToggle) b.addEventListener('click', function (ev) { o.onToggle(it.key, it.on === false, ev); });
      el.appendChild(b);
    })(items[j]);
  }
  return el;
};

/* ---------------------------------------------------------------------------
   12 · CSV export (§6.7)
   A download started inside a sandboxed component iframe is unreliable, so the
   clipboard is not the fallback — it is the guarantee.  Returns a promise with
   what actually happened so the caller can flash the honest message.
   --------------------------------------------------------------------------- */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
TDC.csvText = function (rows, cols) {
  rows = rows || [];
  var head = [], get = [], j;
  if (!cols || !cols.length) {
    var keys = {};
    for (j = 0; j < rows.length; j++) for (var k in rows[j]) keys[k] = 1;
    cols = Object.keys(keys);
  }
  for (j = 0; j < cols.length; j++) {
    var c = cols[j];
    if (typeof c === 'string') { head.push(c); get.push((function (kk) { return function (r) { return r[kk]; }; })(c)); }
    else {
      head.push(c.label == null ? c.key : c.label);
      get.push((function (cc) {
        return function (r) {
          var v = cc.get ? cc.get(r) : r[cc.key];
          return cc.fmt ? cc.fmt(v, r) : v;
        };
      })(c));
    }
  }
  var out = [head.map(csvCell).join(',')];
  for (j = 0; j < rows.length; j++) {
    var line = [];
    for (var q = 0; q < get.length; q++) line.push(csvCell(get[q](rows[j])));
    out.push(line.join(','));
  }
  return out.join('\r\n');
};
TDC.csv = function (rows, cols, filename) {
  var text = TDC.csvText(rows, cols);
  var res = { rows: (rows || []).length, bytes: text.length, downloaded: false, copied: false, text: text };
  try {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url; a.download = filename || 'theta-desk.csv';
    a.style.position = 'fixed'; a.style.left = '-9999px';
    doc.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { doc.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {}
    }, 1000);
    res.downloaded = true;
  } catch (e) { res.downloaded = false; }

  function legacyCopy() {
    try {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
      doc.body.appendChild(ta);
      ta.select();
      var ok = doc.execCommand && doc.execCommand('copy');
      doc.body.removeChild(ta);
      return !!ok;
    } catch (e2) { return false; }
  }
  var P = (typeof Promise === 'function') ? Promise : null;
  if (global.navigator && navigator.clipboard && navigator.clipboard.writeText && P) {
    return navigator.clipboard.writeText(text).then(function () {
      res.copied = true; return res;
    }, function () {
      res.copied = legacyCopy(); return res;
    });
  }
  res.copied = legacyCopy();
  return P ? P.resolve(res) : res;
};
TDC.copy = function (text) {
  var P = (typeof Promise === 'function') ? Promise : null;
  if (global.navigator && navigator.clipboard && navigator.clipboard.writeText && P) {
    return navigator.clipboard.writeText(String(text)).then(function () { return true; }, function () { return false; });
  }
  try {
    var ta = doc.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed'; ta.style.left = '-9999px';
    doc.body.appendChild(ta); ta.select();
    var ok = doc.execCommand && doc.execCommand('copy');
    doc.body.removeChild(ta);
    return P ? P.resolve(!!ok) : !!ok;
  } catch (e) { return P ? P.resolve(false) : false; }
};

/* ---------------------------------------------------------------------------
   13 · Smoke test (§2.3) — nothing else may start until this passes against
   series.books.real.  The probe page prints it; app.js may assert it in dev.
   --------------------------------------------------------------------------- */
TDC.smoke = function (data) {
  var out = { ok: true, checks: [] };
  function chk(name, cond, detail) {
    out.checks.push({ name: name, ok: !!cond, detail: detail == null ? '' : String(detail) });
    if (!cond) out.ok = false;
  }
  try {
    var ix = TDC.index.build(data);
    var st = ix.stats();
    chk('index.build', ix.n > 0, st.ticks + ' ticks from ' + st.stamps + ' stamps, ' +
        st.days + ' sessions, max cluster span ' + st.maxSpan + 's, median ' + st.medianSpan + 's');
    var real = (data.series && data.series.books && data.series.books.real) || [];
    chk('books.real bound', real.length > 0, real.length + ' rows');
    var pts = TDC.bind(real, ix, 'v');
    chk('every row lands on a tick', pts.length === real.length, pts.length + ' of ' + real.length);
    var ext = TDC.extent(pts);
    chk('extent', !!ext, ext ? (fmt.usd(ext[0]) + ' → ' + fmt.usd(ext[1])) : 'none');
    var host = doc.createElement('div');
    host.style.position = 'fixed'; host.style.left = '-9999px';
    host.style.width = '600px'; host.style.height = '200px';
    doc.body.appendChild(host);
    var drew = 0;
    var ctx = TDC.mount(host, {
      pad: K.pad,
      draw: function (c) {
        c.setIndex(ix);
        c.setX(TDC.scaleTick({ index: ix, mode: 'session', range: [0, c.iw] }));
        c.setY(TDC.scaleLinear({ domain: ext, range: [c.ih, 0] }));
        TDC.axisY(c, { format: fmt.usd0 });
        TDC.axisX(c, { index: ix });
        TDC.line(c, { pts: pts, color: C.bkReal, dot: 'last' });
        drew++;
      }
    });
    chk('TDC.mount + draw', drew === 1 && ctx.svg.querySelectorAll('path').length > 0,
        ctx.svg.querySelectorAll('path').length + ' paths, ' + ctx.iw + '×' + ctx.ih + ' inner box');
    chk('TDC.axisX', ctx.svg.querySelectorAll('.ax-x .ax-day').length > 0,
        ctx.svg.querySelectorAll('.ax-x .ax-day').length + ' session labels');
    var got = null, off = TDC.cursor.on(function (i) { got = i; });
    TDC.cursor.set(3, 'smoke');
    chk('TDC.cursor.set', TDC.cursor.get().i === 3, 'i=' + TDC.cursor.get().i);
    TDC.cursor.reset(); off();
    ctx.destroy();
    doc.body.removeChild(host);
    void got;
  } catch (e) {
    chk('exception', false, e && e.message ? e.message : String(e));
  }
  return out;
};

/* --------------------------------------------------------------------------- */
TDC.version = '1.0.0';
global.TDC = TDC;

})(window, document);
