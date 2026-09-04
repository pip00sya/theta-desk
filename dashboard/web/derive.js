/* ==========================================================================
   THETA DESK  ·  derive.js  ·  window.TDD
   --------------------------------------------------------------------------
   One export:   TDD.derive(data) -> D
   D is the derived dataset handed to every renderer.  It is computed once per
   data load, memoised on the identity of the `data` object, and NEVER mutates
   its input: raw rows are held by reference and read-only; every field this
   file adds lives on an object this file created.

   Rules obeyed here, from the spec:
     - the tick spine is built by the 6.2 algorithm exactly (300s clustering);
       no panel may compute an x position from an array index.
     - nothing is interpolated, nothing is forward-filled.  A series that has
       no row at a tick has `null` at that tick and the line breaks there.
     - anything the published export cannot support is `null` and is listed in
       D.missing with the field path that would unblock it, so the panel can
       render the .notpub empty state instead of a zero.
     - no colours, no markup, no DOM.  Arithmetic only.

   Load order: this file is a classic script and must run before panels.js.
   ========================================================================== */
(function (root) {
'use strict';

/* ==========================================================================
   0 · PRIMITIVES
   ========================================================================== */

var GAP_MS       = 300000;      /* 6.2 cluster threshold, 300 seconds        */
var CADENCE_MIN  = 15;          /* scheduler cadence                          */
var WIN_OPEN     = 13 * 60 + 30;/* session window, minutes past UTC midnight  */
var WIN_CLOSE    = 20 * 60;
var STALE_MIN    = 30;          /* amber past 30 min, inside the window only  */
var DAY_MS       = 86400000;

var DOW  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var MON  = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function A(v) { return Array.isArray(v) ? v : []; }
function O(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function str(v) { return (typeof v === 'string' && v.length) ? v : null; }
function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

/* Every timestamp in the export is UTC.  Naive forms ("2026-09-03T19:47:39")
   are parsed as LOCAL time by JS, which would shift the whole page, so a Z is
   appended when the string carries no zone. */
function ms(t) {
  if (typeof t !== 'string' || !t) return NaN;
  var s = /[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z';
  var v = Date.parse(s);
  return isFinite(v) ? v : NaN;
}
function dayOf(v) {
  if (typeof v === 'string') v = ms(v);
  if (!isFinite(v)) return null;
  return new Date(v).toISOString().slice(0, 10);
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function hm(v) {
  var d = new Date(v);
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}
function md(v) {
  var d = new Date(v);
  return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

function r2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000; }

function sum(a) { var s = 0, i; for (i = 0; i < a.length; i++) if (num(a[i]) != null) s += a[i]; return s; }
function mean(a) { var f = a.filter(function (v) { return num(v) != null; }); return f.length ? sum(f) / f.length : null; }
function median(a) {
  var f = a.filter(function (v) { return num(v) != null; }).slice().sort(function (x, y) { return x - y; });
  if (!f.length) return null;
  var m = Math.floor(f.length / 2);
  return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
}
function minOf(a) { var f = a.filter(function (v) { return num(v) != null; }); return f.length ? Math.min.apply(null, f) : null; }
function maxOf(a) { var f = a.filter(function (v) { return num(v) != null; }); return f.length ? Math.max.apply(null, f) : null; }

function stats(a) {
  var f = A(a).filter(function (v) { return num(v) != null; });
  return {
    n: f.length,
    min: f.length ? Math.min.apply(null, f) : null,
    max: f.length ? Math.max.apply(null, f) : null,
    sum: f.length ? sum(f) : null,
    mean: f.length ? sum(f) / f.length : null,
    median: median(f)
  };
}

/* Equal-width histogram buckets.  Returns [] for an empty or degenerate set
   rather than one fake bucket. */
function buckets(values, k) {
  var f = A(values).filter(function (v) { return num(v) != null; });
  if (!f.length) return [];
  k = Math.max(1, k | 0);
  var lo = Math.min.apply(null, f), hi = Math.max.apply(null, f);
  if (lo === hi) return [{ lo: lo, hi: hi, n: f.length, mid: lo }];
  var w = (hi - lo) / k, out = [], i;
  for (i = 0; i < k; i++) out.push({ lo: lo + i * w, hi: lo + (i + 1) * w, mid: lo + (i + 0.5) * w, n: 0 });
  f.forEach(function (v) {
    var j = Math.min(k - 1, Math.floor((v - lo) / w));
    out[j].n++;
  });
  return out;
}

function census(arr, key) {
  var o = {}, i, k;
  for (i = 0; i < arr.length; i++) {
    k = typeof key === 'function' ? key(arr[i], i) : arr[i][key];
    if (k === undefined || k === null || k === '') continue;
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}
function censusRows(obj) {
  return Object.keys(obj)
    .map(function (k) { return { key: k, n: obj[k] }; })
    .sort(function (a, b) { return b.n - a.n || (a.key < b.key ? -1 : 1); });
}

/* OCC option symbol -> its parts.  "SPY260918P00712000" */
function occ(symbol) {
  var m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(symbol || ''));
  if (!m) return null;
  return {
    root: m[1],
    expiry: '20' + m[2] + '-' + m[3] + '-' + m[4],
    expiryMs: Date.parse('20' + m[2] + '-' + m[3] + '-' + m[4] + 'T20:00:00Z'),
    right: m[5],
    strike: parseInt(m[6], 10) / 1000
  };
}

/* ==========================================================================
   1 · THE SHARED TICK SPINE  (spec 6.2, verbatim algorithm)
   ========================================================================== */

function buildSpine(data) {
  var stamps = [];
  function pushRows(rows, field) {
    A(rows).forEach(function (r) {
      var t = r && r[field || 't'];
      if (typeof t === 'string' && t) stamps.push(t);
    });
  }
  var S = O(data.series);

  pushRows(S.signal);
  Object.keys(O(S.books)).forEach(function (k) { pushRows(S.books[k]); });
  pushRows(S.gates);
  pushRows(S.desk);
  pushRows(S.refusals);
  pushRows(S.integrity);
  pushRows(S.derisk);
  pushRows(S.ticks);
  Object.keys(O(S.manage)).forEach(function (sid) { pushRows(S.manage[sid]); });
  pushRows(data.decisions);

  var seen = Object.create(null), pairs = [], i, v;
  for (i = 0; i < stamps.length; i++) {
    if (seen[stamps[i]]) continue;
    seen[stamps[i]] = 1;
    v = ms(stamps[i]);
    if (isFinite(v)) pairs.push([v, stamps[i]]);
  }
  pairs.sort(function (a, b) { return a[0] - b[0]; });

  var ticks = [], cur = null, uniq = pairs.length;
  for (i = 0; i < pairs.length; i++) {
    if (!cur || pairs[i][0] - cur.t1 > GAP_MS) {
      cur = { ms: pairs[i][0], t: pairs[i][1], t0: pairs[i][0], t1: pairs[i][0], n: 1 };
      ticks.push(cur);
    } else {
      cur.t1 = pairs[i][0];
      cur.n++;
    }
  }

  var days = [], lastDay = null;
  ticks.forEach(function (tk, k) {
    tk.i = k;
    tk.day = dayOf(tk.ms);
    tk.span = (tk.t1 - tk.t0) / 1000;
    tk.hm = hm(tk.ms);
    tk.md = md(tk.ms);
    tk.first = tk.day !== lastDay;
    if (tk.first) {
      days.push({ day: tk.day, dayIdx: days.length, i0: k, i1: k, n: 0 });
      lastDay = tk.day;
    }
    var d = days[days.length - 1];
    d.i1 = k; d.n++;
    tk.dayIdx = d.dayIdx;
    tk.last = false;
  });
  days.forEach(function (d) { if (ticks[d.i1]) ticks[d.i1].last = true; });

  var n = ticks.length;
  var starts = ticks.map(function (t) { return t.t0; });

  function lower(v) {                       /* greatest k with starts[k] <= v */
    var lo = 0, hi = n - 1, best = -1, mid;
    while (lo <= hi) {
      mid = (lo + hi) >> 1;
      if (starts[mid] <= v) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  var index = {
    n: n,
    ticks: ticks,
    days: days,
    dayBreaks: days.slice(1).map(function (d) { return d.i0; }),
    uniqueStamps: uniq,
    gapMs: GAP_MS,
    maxSpanS: ticks.length ? Math.max.apply(null, ticks.map(function (t) { return t.span; })) : null,
    medianSpanS: median(ticks.map(function (t) { return t.span; })),

    /* exact-or-containing */
    at: function (t) {
      var v = typeof t === 'number' ? t : ms(t);
      if (!isFinite(v) || !n) return -1;
      var k = lower(v);
      if (k < 0) return -1;
      return v <= ticks[k].t1 ? k : -1;
    },
    /* nearest preceding cluster; clamps to 0 for anything before the first */
    near: function (t) {
      var v = typeof t === 'number' ? t : ms(t);
      if (!isFinite(v) || !n) return -1;
      var k = lower(v);
      return k < 0 ? 0 : k;
    },
    /* The join used everywhere: the containing tick, else the CLOSEST tick by
       distance to its interval.  Not nearest-preceding: positions[].opened and
       trades[].closed are minute-truncated, so they sit one to three seconds
       BEFORE the tick that produced them and a preceding-only rule would park
       every entry marker on the previous tick — a fifteen-minute error. */
    bind: function (t) {
      var v = typeof t === 'number' ? t : ms(t);
      if (!isFinite(v) || !n) return -1;
      var k = lower(v);
      if (k >= 0 && v <= ticks[k].t1) return k;      /* inside a cluster */
      if (k < 0) return 0;                            /* before the first */
      if (k + 1 >= n) return k;                       /* after the last   */
      var before = v - ticks[k].t1;
      var after = ticks[k + 1].t0 - v;
      return after < before ? k + 1 : k;
    },
    slice: function (range) {
      if (!n) return [0, 0];
      if (Array.isArray(range) && range.length === 2) {
        var a = Math.max(0, Math.min(n - 1, range[0] | 0));
        var b = Math.max(0, Math.min(n - 1, range[1] | 0));
        return a <= b ? [a, b] : [b, a];
      }
      var k = range === '1d' ? 1 : range === '3d' ? 3 : range === '5d' ? 5 : null;
      if (k == null || !days.length) return [0, n - 1];
      var ds = days.slice(-k);
      return [ds[0].i0, ds[ds.length - 1].i1];
    },
    /* everything a panel footer needs about the visible window */
    window: function (range) {
      var s = index.slice(range);
      var a = ticks[s[0]], b = ticks[s[1]];
      var ds = days.filter(function (d) { return d.i1 >= s[0] && d.i0 <= s[1]; });
      return {
        i0: s[0], i1: s[1], n: s[1] - s[0] + 1,
        t0: a ? a.t : null, t1: b ? b.t : null,
        ms0: a ? a.ms : null, ms1: b ? b.ms : null,
        days: ds.map(function (d) { return d.day; }),
        sessions: ds.length
      };
    },
    inRange: function (i, range) {
      var s = index.slice(range);
      return i >= s[0] && i <= s[1];
    },
    label: function (i, mode) {
      var tk = ticks[i];
      if (!tk) return '';
      if (mode === 'hm') return tk.hm;
      if (mode === 'md' || mode === 'day') return tk.md;
      if (mode === 'iso') return tk.t;
      if (mode === 'time') return tk.md + ' ' + tk.hm;
      return tk.first ? tk.md : tk.hm;      /* 'session', the default */
    },
    dayOfTick: function (i) { return ticks[i] ? ticks[i].day : null; }
  };
  return index;
}

/* Bind a row list onto the spine.  Returns {rows, byTick, idx} where `idx` is
   the parallel array of tick indices and `byTick` buckets rows per tick. */
function bindRows(rows, spine, field) {
  rows = A(rows);
  var f = field || 't';
  var idx = new Array(rows.length);
  var byTick = new Array(spine.n);
  var k, i;
  for (k = 0; k < rows.length; k++) {
    i = spine.bind(rows[k] && rows[k][f]);
    idx[k] = i;
    if (i >= 0) (byTick[i] || (byTick[i] = [])).push(rows[k]);
  }
  return { rows: rows, idx: idx, byTick: byTick };
}
function lastPerTick(bound, spine) {
  var out = new Array(spine.n), i;
  for (i = 0; i < spine.n; i++) {
    var b = bound.byTick[i];
    out[i] = b && b.length ? b[b.length - 1] : null;
  }
  return out;
}

/* A 300s cluster can hold more than one row of the same series — the four
   tick_starts of 2026-08-28 are 20s to 3m apart and collapse into one spine
   tick.  A chart line must not carry two points at the same x, so every line
   array is reduced to one entry per tick, the last observation winning.  The
   full row list is always kept alongside it. */
function lastByTick(list, n) {
  var slot = new Array(n), out = [], i;
  for (i = 0; i < list.length; i++) if (list[i].i >= 0 && list[i].i < n) slot[list[i].i] = list[i];
  for (i = 0; i < n; i++) if (slot[i]) out.push(slot[i]);
  return out;
}
function lineOf(list, field, n) {
  return lastByTick(list.filter(function (p) { return p[field] != null; }), n)
    .map(function (p) { return { i: p.i, v: p[field] }; });
}
function laneOf(list, field, n) {
  return lastByTick(list.filter(function (p) { return p[field] != null; }), n)
    .map(function (p) { return { i: p.i, c: p[field] }; });
}
/* mark every row a later row in the same tick supersedes */
function markDupes(list) {
  var seen = Object.create(null), i, d = 0;
  for (i = list.length - 1; i >= 0; i--) {
    if (list[i].i < 0) continue;
    if (seen[list[i].i]) { list[i].dupe = true; d++; }
    else { seen[list[i].i] = 1; list[i].dupe = false; }
  }
  return d;
}

/* ==========================================================================
   2 · BOOKS, DRAWDOWN, SESSIONS, ABLATION
   ========================================================================== */

var BOOK_ORDER = ['real', 'shadow_nogates', 'shadow_nohedge', 'baseline_naive'];
var BOOK_LABEL = {
  real: 'REAL',
  shadow_nogates: 'NO GATES',
  shadow_nohedge: 'NO HEDGE',
  baseline_naive: 'NAIVE'
};

function deriveBooks(data, spine) {
  var src = O(O(data.series).books);
  var keys = BOOK_ORDER.filter(function (k) { return A(src[k]).length; })
    .concat(Object.keys(src).filter(function (k) { return BOOK_ORDER.indexOf(k) < 0 && A(src[k]).length; }));

  var byKey = {}, dupes = 0;

  keys.forEach(function (k) {
    var rows = A(src[k]).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
    var bound = bindRows(rows, spine);
    var pts = [], peak = null, maxDD = 0, maxDDAt = null, worst = null, worstAt = null,
        best = null, bestAt = null, prev = null;

    rows.forEach(function (r, j) {
      var i = bound.idx[j];
      var v = num(r.v);
      if (v != null) { if (peak == null || v > peak) { peak = v; } }
      var dd = (v == null || peak == null) ? null : v - peak;
      if (dd != null && dd < maxDD) { maxDD = dd; maxDDAt = i; }
      var chg = (v != null && prev != null) ? v - prev : null;
      if (chg != null) {
        if (worst == null || chg < worst) { worst = chg; worstAt = i; }
        if (best == null || chg > best) { best = chg; bestAt = i; }
      }
      if (v != null) prev = v;
      pts.push({
        i: i, k: j, t: r.t, ms: ms(r.t), day: dayOf(r.t),
        v: v, u: num(r.u), r: num(r.r), eq: num(r.eq),
        d: num(r.d), th: num(r.th), vg: num(r.vg),
        chg: chg, dd: dd, peak: peak
      });
    });

    /* per-session P&L: first mark, last mark, and the change inside the day */
    var sessions = [], curDay = null, cur = null;
    pts.forEach(function (p) {
      if (p.day !== curDay) {
        curDay = p.day;
        cur = { day: p.day, i0: p.i, i1: p.i, first: p.v, last: p.v, min: p.v, max: p.v, n: 0, delta: null };
        sessions.push(cur);
      }
      cur.i1 = p.i; cur.last = p.v; cur.n++;
      if (p.v != null) {
        if (cur.min == null || p.v < cur.min) cur.min = p.v;
        if (cur.max == null || p.v > cur.max) cur.max = p.v;
      }
    });
    sessions.forEach(function (s, j) {
      var prevLast = j > 0 ? sessions[j - 1].last : null;
      s.delta = (s.last != null && prevLast != null) ? r2(s.last - prevLast) : null;
      s.intraday = (s.last != null && s.first != null) ? r2(s.last - s.first) : null;
    });

    var lastPt = pts.length ? pts[pts.length - 1] : null;
    var dup = markDupes(pts);
    dupes += dup;

    byKey[k] = {
      key: k,
      label: BOOK_LABEL[k] || k.toUpperCase(),
      present: pts.length > 0,
      n: pts.length,
      pts: pts,
      dupePoints: dup,
      ticksCovered: pts.length - dup,
      idxByTick: lastPerTick(bound, spine),
      v: lineOf(pts, 'v', spine.n), u: lineOf(pts, 'u', spine.n),
      r: lineOf(pts, 'r', spine.n), eq: lineOf(pts, 'eq', spine.n),
      dd: lineOf(pts, 'dd', spine.n),
      final: lastPt ? { t: lastPt.t, i: lastPt.i, v: lastPt.v, u: lastPt.u, r: lastPt.r, eq: lastPt.eq } : null,
      peak: peak, trough: minOf(pts.map(function (p) { return p.v; })),
      maxDD: r2(maxDD), maxDDAt: maxDDAt,
      worstTick: r2(worst), worstTickAt: worstAt,
      bestTick: r2(best), bestTickAt: bestAt,
      eqCount: pts.filter(function (p) { return p.eq != null; }).length,
      greekCount: pts.filter(function (p) { return p.d || p.th || p.vg; }).length,
      sessions: sessions,
      first: pts.length ? pts[0].t : null,
      lastT: lastPt ? lastPt.t : null
    };
  });

  /* ablation: real minus each shadow, on ticks where BOTH have a mark */
  var real = byKey.real;
  var vs = {}, scaleMax = 0;
  if (real) {
    keys.forEach(function (k) {
      if (k === 'real') return;
      var other = byKey[k];
      var perTick = [], j, a, b, maxAbs = 0, maxAt = null;
      for (j = 0; j < spine.n; j++) {
        a = real.idxByTick[j]; b = other.idxByTick[j];
        if (!a || !b || num(a.v) == null || num(b.v) == null) continue;
        var dv = a.v - b.v;
        perTick.push({ i: j, v: r2(dv), real: a.v, shadow: b.v, t: a.t });
        if (Math.abs(dv) > maxAbs) { maxAbs = Math.abs(dv); maxAt = j; }
      }
      var fin = (real.final && other.final && real.final.v != null && other.final.v != null)
        ? r2(real.final.v - other.final.v) : null;
      if (fin != null) scaleMax = Math.max(scaleMax, Math.abs(fin));
      vs[k] = {
        key: k, label: byKey[k].label,
        perTick: perTick,
        line: perTick.map(function (p) { return { i: p.i, v: p.v }; }),
        final: fin,
        maxAbs: r2(maxAbs), maxAbsAt: maxAt,
        n: perTick.length
      };
    });
  }

  return {
    order: keys,
    labels: BOOK_LABEL,
    byKey: byKey,
    dupePoints: dupes,
    unionTicks: (function () {
      var s = {}; keys.forEach(function (k) { byKey[k].pts.forEach(function (p) { s[p.i] = 1; }); });
      return Object.keys(s).length;
    })(),
    ablation: { base: 'real', vs: vs, scaleMax: r2(scaleMax) },
    shadowsCarryGreeks: keys.some(function (k) { return k !== 'real' && byKey[k].greekCount > 0; }),
    shadowsCarryEquity: keys.some(function (k) { return k !== 'real' && byKey[k].eqCount > 0; })
  };
}

/* ==========================================================================
   3 · SIGNAL AND THE PREMIUM (implied minus realized)
   ========================================================================== */

function deriveSignal(data, spine) {
  var rows = A(O(data.series).signal).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  var bound = bindRows(rows, spine);
  var reg = O(O(data.params).regime);
  var rich = num(reg.vrp_rich_threshold);
  var cheap = num(reg.vrp_cheap_threshold);

  var per = rows.map(function (r, j) {
    var iv = num(r.iv), rv = num(r.rv), vrp = num(r.vrp);
    var pts = (iv != null && rv != null) ? r4((iv - rv) * 100) : null;
    var ratio = (iv != null && rv != null && rv !== 0) ? r4(iv / rv) : null;
    var regime = vrp == null ? null
      : (rich != null && vrp >= rich) ? 'rich'
      : (cheap != null && vrp <= cheap) ? 'cheap' : 'neutral';
    return {
      i: bound.idx[j], k: j, t: r.t, ms: ms(r.t), day: dayOf(r.t),
      sym: str(r.sym), spot: num(r.spot), iv: iv, rv: rv, vrp: vrp, dq: str(r.dq),
      pts: pts, ratio: ratio, regime: regime,
      clean: r.dq === 'full'
    };
  });

  var spot = per.map(function (p) { return p.spot; });
  var spotMedian = median(spot);
  var SUSPECT_RULE = 'spot deviates more than 25% from the series median';
  per.forEach(function (p) {
    p.suspect = (p.spot != null && spotMedian) ? Math.abs(p.spot / spotMedian - 1) > 0.25 : false;
  });

  var dupes = markDupes(per);
  function pack(list) {
    var n = spine.n;
    return {
      rows: list,
      iv: lineOf(list, 'iv', n), rv: lineOf(list, 'rv', n), vrp: lineOf(list, 'vrp', n),
      spot: lineOf(list, 'spot', n), pts: lineOf(list, 'pts', n), ratio: lineOf(list, 'ratio', n),
      band: { upper: lineOf(list, 'iv', n), lower: lineOf(list, 'rv', n) },
      regime: laneOf(list, 'regime', n)
    };
  }
  var clean = per.filter(function (p) { return p.clean; });
  var last = per.length ? per[per.length - 1] : null;

  var sig = O(data.signals);
  var days = Object.keys(census(per, function (p) { return p.day; }));

  return {
    n: per.length,
    rows: per,
    dupePoints: dupes,
    ticksCovered: per.length - dupes,
    all: pack(per),
    clean: pack(clean),
    cleanN: clean.length,
    byTick: lastPerTick(bound, spine),
    last: last,
    /* the snapshot scalars, which are the desk's own current read */
    current: {
      spot: num(sig.spot), rv20: num(sig.rv20), atm_iv: num(sig.atm_iv),
      vrp: num(sig.vrp), regime: str(sig.regime), data_quality: str(sig.data_quality),
      pts: (num(sig.atm_iv) != null && num(sig.rv20) != null) ? r4((sig.atm_iv - sig.rv20) * 100) : null,
      ratio: (num(sig.atm_iv) != null && num(sig.rv20)) ? r4(sig.atm_iv / sig.rv20) : null
    },
    thresholds: { rich: rich, cheap: cheap, rvLookbackDays: num(reg.rv_lookback_days) },
    dqCensus: census(per, function (p) { return p.dq == null ? '(null)' : p.dq; }),
    symCensus: census(per, function (p) { return p.sym; }),
    spot: { min: minOf(spot), max: maxOf(spot), median: spotMedian },
    suspect: per.filter(function (p) { return p.suspect; }),
    suspectRule: SUSPECT_RULE,
    sessions: days,
    sessionCount: days.length,
    first: per.length ? per[0].t : null,
    lastT: last ? last.t : null,
    /* a percentile needs 20 sessions of history; we have this many */
    ivRank: null,
    ivRankReason: days.length + ' sessions collected of the ' +
      (num(reg.rv_lookback_days) || 20) + ' a percentile needs; no historical IV is served'
  };
}

/* ==========================================================================
   4 · GREEKS  (real book only — the shadows store 0.0 on every row)
   ========================================================================== */

function deriveGreeks(books, data, spine) {
  var real = books.byKey.real;
  var g = O(data.greeks);
  var start = num(O(data.book).start);
  var eqNow = num(O(data.broker).equity);
  var N = spine.n;

  function one(field, key, label, unit) {
    if (!real) return { key: key, label: label, unit: unit, present: false, series: [], cur: null };
    var pts = real.pts.filter(function (p) { return p[field] != null; });
    var cur = num(g[key]);
    if (cur == null && pts.length) cur = pts[pts.length - 1][field];
    return {
      key: key, label: label, unit: unit, present: pts.length > 0,
      cur: cur,
      series: lineOf(pts, field, N),
      /* per $1,000 of starting equity — complete, one denominator */
      per1kStart: start ? lastByTick(pts, N).map(function (p) {
        return { i: p.i, v: r4(p[field] / (start / 1000)) }; }) : [],
      /* per $1,000 of the broker equity stamped on that same mark — null where
         the mark carries no equity; never forward-filled */
      per1kEq: lastByTick(pts.filter(function (p) { return p.eq != null; }), N)
                  .map(function (p) { return { i: p.i, v: r4(p[field] / (p.eq / 1000)) }; }),
      curPer1kStart: (cur != null && start) ? r4(cur / (start / 1000)) : null,
      curPer1kEq: (cur != null && eqNow) ? r4(cur / (eqNow / 1000)) : null,
      n: pts.length,
      nonZero: pts.filter(function (p) { return p[field] !== 0; }).length,
      min: minOf(pts.map(function (p) { return p[field]; })),
      max: maxOf(pts.map(function (p) { return p[field]; }))
    };
  }

  return {
    book: 'real',
    onlyRealBook: true,
    shadowsAllZero: !books.shadowsCarryGreeks,
    shadowRowCount: books.order.filter(function (k) { return k !== 'real'; })
      .reduce(function (a, k) { return a + books.byKey[k].n; }, 0),
    delta: one('d', 'delta', 'DELTA', '$/1pt'),
    theta: one('th', 'theta', 'THETA', '$/day'),
    vega: one('vg', 'vega', 'VEGA', '$/volpt'),
    n: real ? real.n : 0,
    nonZero: real ? real.greekCount : 0,
    equityStart: start,
    equityNow: eqNow
  };
}

/* ==========================================================================
   5 · THE DESK RECORD
   ========================================================================== */

function deriveDesk(data, spine) {
  var rows = A(O(data.series).desk).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  var bound = bindRows(rows, spine);

  var roleCalls = 0, roleFail = 0, providers = {}, models = {}, roleNames = {};
  var per = rows.map(function (r, j) {
    var roles = A(r.roles).map(function (x) {
      roleCalls++;
      if (!x.ok) roleFail++;
      if (x.p) providers[x.p] = (providers[x.p] || 0) + 1;
      if (x.m) models[x.m] = (models[x.m] || 0) + 1;
      if (x.r) roleNames[x.r] = (roleNames[x.r] || 0) + 1;
      return {
        role: str(x.r), provider: str(x.p), model: str(x.m),
        ok: !!x.ok, fallback: str(x.fb), text: typeof x.txt === 'string' ? x.txt : '',
        hasText: !!(x.txt && x.txt.length)
      };
    });
    return {
      i: bound.idx[j], k: j, t: r.t, ms: ms(r.t), day: dayOf(r.t),
      a: str(r.a), b: str(r.b),
      dis: !!r.dis, veto: !!r.veto, dark: !!r.dark,
      mult: num(r.mult), sev: str(r.sev), why: str(r.why) || '',
      roles: roles,
      rolesOk: roles.filter(function (x) { return x.ok; }).length,
      rolesN: roles.length
    };
  });

  var dupes = markDupes(per);
  var multC = census(per, function (p) { return p.mult == null ? null : String(p.mult); });
  var vetoes = per.filter(function (p) { return p.veto; });
  var dis = per.filter(function (p) { return p.dis; });
  var dark = per.filter(function (p) { return p.dark; });
  var agree = per.filter(function (p) { return p.a && p.b && p.a === p.b; });

  return {
    n: per.length,
    rows: per,
    byTick: lastPerTick(bound, spine),
    census: {
      analyst: census(per, 'a'),
      second: census(per, 'b'),
      mult: multC,
      severity: census(per, 'sev')
    },
    agreements: agree.length,
    agreementRate: per.length ? r4(agree.length / per.length) : null,
    disagreements: dis.length,
    disagreementIdx: dis.map(function (p) { return p.i; }),
    disagreementRows: dis,
    vetoes: vetoes.length,
    vetoRows: vetoes,
    dark: dark.length,
    darkIdx: dark.map(function (p) { return p.i; }),
    meetingsReported: num(O(data.desk).meetings),
    darkReported: num(O(data.desk).llm_dark),
    roleCalls: roleCalls,
    roleFailures: roleFail,
    roleOk: roleCalls - roleFail,
    providers: providers,
    models: models,
    roleNames: roleNames,
    dupePoints: dupes,
    ticksCovered: per.length - dupes,
    /* size multiplier as a step line, and the count at each level */
    lanes: {
      analyst: laneOf(per, 'a', spine.n),
      second: laneOf(per, 'b', spine.n),
      mult: lineOf(per, 'mult', spine.n),
      dark: dark.map(function (p) { return { i: p.i, kind: 'dark', title: 'no model reachable' }; }),
      veto: vetoes.map(function (p) { return { i: p.i, kind: 'veto', title: p.why }; }),
      disagreement: dis.map(function (p) { return { i: p.i, kind: 'disagreement', title: p.a + ' vs ' + p.b }; })
    },
    multPredominant: (function () {
      var best = null;
      Object.keys(multC).forEach(function (k) { if (!best || multC[k] > multC[best]) best = k; });
      return best == null ? null : { mult: parseFloat(best), n: multC[best], of: per.length };
    })()
  };
}

/* ==========================================================================
   6 · THE GATE MATRIX
   ========================================================================== */

function deriveGates(data, spine) {
  var defs = A(data.gate_defs).map(function (g) {
    return { id: str(g.id), label: str(g.label) || str(g.id), what: str(g.what) || '', params: A(g.params) };
  });
  var defById = {};
  defs.forEach(function (d) { defById[d.id] = d; });

  var evals = A(O(data.series).gates).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  var bound = bindRows(evals, spine);

  /* rows are the union of keys present in r, ordered by gate_defs */
  var present = {};
  evals.forEach(function (e) { Object.keys(O(e.r)).forEach(function (k) { present[k] = 1; }); });
  var ids = defs.map(function (d) { return d.id; }).filter(function (id) { return present[id]; });
  Object.keys(present).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });

  var per = evals.map(function (e, j) {
    var fails = A(e.fails).map(function (f) { return { gate: str(f.gate), reason: str(f.reason) || '' }; });
    return {
      i: bound.idx[j], k: j, t: e.t, ms: ms(e.t), day: dayOf(e.t),
      sid: str(e.sid), kind: str(e.kind), qty: num(e.qty), passed: !!e.passed,
      r: O(e.r),
      d: e.d == null ? null : e.d,
      wc: e.wc == null ? null : {
        pnl: num(e.wc.pnl), spot_rel: num(e.wc.spot_rel), scenario: str(e.wc.scenario)
      },
      fails: fails,
      firstFail: fails.length ? fails[0].gate : null,
      nEvaluated: Object.keys(O(e.r)).length,
      nPassed: Object.keys(O(e.r)).filter(function (k) { return e.r[k]; }).length
    };
  });

  var nEvals = per.length;
  var matrix = {}, statsBy = {};
  ids.forEach(function (id) {
    var col = new Array(nEvals), passN = 0, failN = 0, nrN = 0;
    per.forEach(function (e, j) {
      if (!has(e.r, id)) { col[j] = null; nrN++; return; }
      var v = e.r[id] ? 1 : 0;
      col[j] = v;
      if (v) passN++; else failN++;
    });
    matrix[id] = col;
    var def = defById[id] || { id: id, label: id, what: '', params: [] };
    var evaluated = passN + failN;
    statsBy[id] = {
      id: id, label: def.label, what: def.what, params: def.params,
      evals: evaluated, notReached: nrN,
      pass: passN, fail: failN,
      failRate: evaluated ? r4(failN / evaluated) : null,
      failRateOfAll: nEvals ? r4(failN / nEvals) : null,
      passRate: evaluated ? r4(passN / evaluated) : null,
      everBound: failN > 0,
      firstFail: 0,                              /* filled from refusals below */
      failures: per.filter(function (e) { return has(e.r, id) && !e.r[id]; })
                   .map(function (e) {
                     var f = e.fails.filter(function (x) { return x.gate === id; })[0];
                     return { i: e.i, k: e.k, t: e.t, sid: e.sid, kind: e.kind,
                              reason: f ? f.reason : '', decisive: e.firstFail === id };
                   })
    };
  });

  var byGate = O(O(data.refusals).by_gate);
  Object.keys(byGate).forEach(function (id) {
    if (statsBy[id]) statsBy[id].firstFail = num(byGate[id]) || 0;
  });

  var everBound = ids.filter(function (id) { return statsBy[id].everBound; });
  var neverBound = ids.filter(function (id) { return !statsBy[id].everBound; });

  var degenerate = {};
  ids.forEach(function (id) {
    var s = statsBy[id];
    if (s.fail === 0) {
      degenerate[id] = {
        id: id, kind: 'never fired',
        note: 'never bound',
        evals: s.evals, notReached: s.notReached, of: nEvals,
        operandsNeeded: 'series.gates[].d'
      };
    }
  });

  var wc = per.filter(function (e) { return e.wc && e.wc.pnl != null; });

  return {
    defs: defs, defById: defById,
    ids: ids,
    n: nEvals,
    evals: per,
    byTick: bound.byTick,
    matrix: matrix,
    stats: statsBy,
    statRows: ids.map(function (id) { return statsBy[id]; }),
    everBound: everBound, neverBound: neverBound,
    functionsDefined: defs.length,
    passed: per.filter(function (e) { return e.passed; }).length,
    refused: per.filter(function (e) { return !e.passed; }).length,
    kindCensus: census(per, 'kind'),
    sidCensus: census(per, 'sid'),
    dayCensus: census(per, 'day'),
    degenerate: degenerate,
    /* operands: gates.py stores them, site_data does not publish them yet */
    operandsPublished: per.some(function (e) { return e.d != null; }),
    operandRows: per.filter(function (e) { return e.d != null; }).length,
    worstCase: {
      published: wc.length > 0,
      n: wc.length, of: nEvals,
      /* one point per tick for a line; several candidates can share a tick, so
         seriesAll keeps every evaluation with its own tick index */
      series: lastByTick(wc.map(function (e) { return { i: e.i, v: e.wc.pnl }; }), spine.n),
      seriesAll: wc.map(function (e) { return { i: e.i, v: e.wc.pnl, k: e.k }; }),
      rows: wc.map(function (e) {
        return { i: e.i, k: e.k, t: e.t, sid: e.sid, kind: e.kind, passed: e.passed,
                 pnl: e.wc.pnl, spot_rel: e.wc.spot_rel, scenario: e.wc.scenario };
      }),
      min: minOf(wc.map(function (e) { return e.wc.pnl; })),
      max: maxOf(wc.map(function (e) { return e.wc.pnl; })),
      scenarios: census(wc, function (e) { return e.wc.scenario; })
    }
  };
}

/* ==========================================================================
   7 · REFUSALS — count, rate, kind
   ========================================================================== */

function deriveRefusals(data, spine, gates) {
  var rows = A(O(data.series).refusals).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  var bound = bindRows(rows, spine);

  var per = rows.map(function (r, j) {
    return {
      i: bound.idx[j], k: j, t: r.t, ms: ms(r.t), day: dayOf(r.t),
      kind: str(r.kind) || 'entry_refused',
      gate: str(r.gate),
      reason: str(r.reason) || '',
      vrp: num(r.vrp)
    };
  });

  var byGateSrc = O(O(data.refusals).by_gate);
  var byKindSrc = O(O(data.refusals).by_kind);
  var byKindLocal = census(per, 'kind');
  var byGateLocal = census(per, 'gate');

  var nEvals = gates.n;
  var gateRows = gates.ids.map(function (id) {
    var s = gates.stats[id];
    var first = num(byGateSrc[id]) != null ? byGateSrc[id] : (byGateLocal[id] || 0);
    return {
      gate: id, label: s.label,
      count: first,                    /* first-failure count — a refusal names one gate */
      matrixFails: s.fail,             /* every failure the matrix counted */
      evals: s.evals,
      rate: s.failRate,                /* fails / evaluations of that gate */
      rateOfAll: s.failRateOfAll
    };
  }).filter(function (r) { return r.count > 0 || r.matrixFails > 0; });

  var byCount = gateRows.slice().sort(function (a, b) { return b.count - a.count || b.matrixFails - a.matrixFails; });
  var byRate  = gateRows.slice().sort(function (a, b) { return (b.rate || 0) - (a.rate || 0); });
  var disagree = !!(byCount.length && byRate.length && byCount[0].gate !== byRate[0].gate);

  var kindRows = censusRows(Object.keys(byKindSrc).length ? byKindSrc : byKindLocal)
    .map(function (r) { return { kind: r.key, count: r.n }; });

  return {
    n: per.length,
    rows: per,
    byTick: bound.byTick,
    total: num(O(data.refusals).total),
    gated: byKindLocal.entry_refused || num(O(data.refusals).total) || 0,
    byGate: gateRows,
    byGateRankedCount: byCount,
    byGateRankedRate: byRate,
    rankingsDisagree: disagree,
    topByCount: byCount[0] || null,
    topByRate: byRate[0] || null,
    byKind: kindRows,
    byKindMap: Object.keys(byKindSrc).length ? byKindSrc : byKindLocal,
    kindsPublished: per.length > (num(O(data.refusals).total) || 0),
    perDay: census(per, 'day'),
    denominator: {
      gateEvaluations: nEvals,
      ticks: A(O(data.series).ticks).length,
      spineTicks: spine.n,
      note: 'a rate needs the denominator its numerator was counted against'
    },
    firstFailureNote: 'a refusal names only the first failing gate; the matrix counts every failure'
  };
}

/* ==========================================================================
   8 · RISK UTILISATION
   ========================================================================== */

function deriveRisk(data, gates, structures) {
  var lim = O(data.limits);
  var risk = O(O(data.params).risk);
  var eq = num(O(data.broker).equity);
  var hwm = num(O(data.kv).high_watermark);
  var realized = num(O(data.book).realized);

  var openRows = structures.open;
  var openMaxLoss = openRows.map(function (p) { return num(p.max_loss); });
  var openSum = openMaxLoss.length ? r2(sum(openMaxLoss)) : null;
  var openMax = maxOf(openMaxLoss);
  var drawdown = (hwm != null && eq != null) ? r2(hwm - eq) : null;

  var daily = A(O(data.series).daily);
  var lastDaily = daily.length ? daily[daily.length - 1] : null;
  var lastDailyWithRisk = null, i;
  for (i = daily.length - 1; i >= 0; i--) {
    if (num(daily[i].new_risk) != null) { lastDailyWithRisk = daily[i]; break; }
  }

  /* `used` is the engine's own operand and is unpublished until
     series.gates[].d lands.  `proxy` is what the published export CAN
     support, always with its source and its confidence stated.  They are
     never conflated and a panel may draw either or neither. */
  function bar(key, label, limit, gate, proxy) {
    return {
      key: key, label: label,
      limit: num(limit),
      used: null,
      usedMissing: 'series.gates[].d',
      pct: null,
      gate: gate,
      params: gate && gates.stats[gate] ? gates.stats[gate].params : [],
      proxy: proxy ? proxy.value : null,
      proxyPct: (proxy && proxy.value != null && num(limit)) ? r4(proxy.value / limit) : null,
      proxyLabel: proxy ? proxy.label : null,
      proxySrc: proxy ? proxy.src : null,
      proxyConfidence: proxy ? proxy.confidence : null,
      proxyNote: proxy ? (proxy.note || null) : null
    };
  }

  var bars = [
    bar('per_structure', 'PER STRUCTURE', lim.per_structure, 'g7_structure_size',
        openMax == null ? null : {
          value: openMax, label: 'largest open structure',
          src: 'positions.open[].max_loss',
          confidence: 'proxy',
          note: 'the gate sizes the CANDIDATE, not the largest position already open'
        }),
    bar('portfolio', 'PORTFOLIO WORST CASE', lim.portfolio, 'g8_portfolio_worst_case',
        openSum == null ? null : {
          value: openSum, label: 'sum of open defined risk',
          src: 'positions.open[].max_loss',
          confidence: 'proxy',
          note: 'the gate reprices book plus candidate over a plus/minus 20% grid; this is a sum of max losses, a different quantity'
        }),
    bar('portfolio_cap', 'PORTFOLIO CAP', lim.portfolio_cap, 'g8_portfolio_worst_case', null),
    bar('daily_new', 'DAILY NEW RISK', lim.daily_new, 'g9_daily_budget',
        (lastDaily && num(lastDaily.new_risk) != null) ? {
          value: num(lastDaily.new_risk), label: 'new risk on ' + lastDaily.day,
          src: 'series.daily[last].new_risk', confidence: 'direct'
        } : (lastDailyWithRisk ? {
          value: num(lastDailyWithRisk.new_risk),
          label: 'last published day with a figure: ' + lastDailyWithRisk.day,
          src: 'series.daily[].new_risk',
          confidence: 'stale',
          note: 'the most recent daily row publishes no new_risk key'
        } : null)),
    bar('cheap_sleeve', 'CHEAP SLEEVE', lim.cheap_sleeve, 'g18_sleeve_budget', null),
    bar('drawdown_halt', 'DRAWDOWN HALT', lim.drawdown_halt, 'g14_halt',
        drawdown == null ? null : {
          value: drawdown, label: 'high-water mark minus broker equity',
          src: 'kv.high_watermark − broker.equity', confidence: 'direct'
        })
  ];

  /* the earned-budget rule, stated as arithmetic */
  var base = num(lim.portfolio), cap = num(lim.portfolio_cap), gm = num(risk.earned_budget_gain_mult);
  var earned = (gm != null && realized != null) ? r2(gm * realized) : null;
  var budget = (base != null && earned != null && cap != null) ? r2(Math.min(base + earned, cap)) : null;

  return {
    bars: bars,
    limits: lim,
    params: risk,
    equity: eq,
    highWatermark: hwm,
    drawdown: drawdown,
    drawdownFrac: (drawdown != null && hwm) ? r4(drawdown / hwm) : null,
    haltFrac: num(risk.drawdown_halt_frac),
    openRisk: { sum: openSum, max: openMax, n: openRows.length,
                src: 'positions.open[].max_loss' },
    earnedBudget: {
      base: base, cap: cap, gainMult: gm, realized: realized,
      earned: earned, budget: budget,
      progress: (budget != null && base != null && cap != null && cap !== base)
        ? r4((budget - base) / (cap - base)) : null,
      formula: 'min(portfolio + earned_budget_gain_mult x realized, portfolio_cap)',
      baseFrac: num(risk.portfolio_worst_case_frac),
      capFrac: num(risk.portfolio_worst_case_cap)
    },
    worstCase: gates.worstCase,
    operandsPublished: gates.operandsPublished,
    sleeveLabelsSeen: census(structures.all, 'sleeve')
  };
}

/* ==========================================================================
   9 · STRUCTURES, TRADES, PATHS, STRIKES
   ========================================================================== */

function deriveStructures(data, spine) {
  var P = O(data.positions);
  var trades = A(data.trades);
  var tradeById = {};
  trades.forEach(function (t) { tradeById[str(t.id)] = t; });
  var asof = ms(str(data.last_tick_utc) || str(data.generated_utc));

  function build(row, status) {
    var legs = A(row.legs).map(function (l) {
      var o = occ(l.symbol);
      return {
        symbol: str(l.symbol), underlying: str(l.underlying), right: str(l.right),
        strike: num(l.strike), qty: num(l.qty), entry: num(l.entry),
        short: num(l.qty) != null && l.qty < 0,
        expiry: o ? o.expiry : null,
        expiryMs: o ? o.expiryMs : null,
        dte: (o && isFinite(asof)) ? r2((o.expiryMs - asof) / DAY_MS) : null
      };
    });
    var tr = tradeById[str(row.id)] || null;
    var openedMs = ms(row.opened), closedMs = ms(row.closed);
    var dte = minOf(legs.map(function (l) { return l.dte; }));
    var pnl = num(row.pnl);
    if (pnl == null && tr) pnl = num(tr.pnl);
    var maxLoss = num(row.max_loss);
    return {
      id: str(row.id),
      kind: str(row.kind), sleeve: str(row.sleeve),
      status: str(row.status) || status, bucket: status,
      qty: num(row.qty), credit: num(row.credit), max_loss: maxLoss,
      opened: str(row.opened), openedMs: isFinite(openedMs) ? openedMs : null,
      closed: str(row.closed), closedMs: isFinite(closedMs) ? closedMs : null,
      iOpen: spine.bind(row.opened), iClose: row.closed ? spine.bind(row.closed) : null,
      pnl: pnl,
      r: (pnl != null && maxLoss) ? r4(pnl / maxLoss) : null,
      hours: tr ? num(tr.hours)
        : (isFinite(openedMs) ? r2(((isFinite(closedMs) ? closedMs : asof) - openedMs) / 3600000) : null),
      hoursOpenEnded: !row.closed,
      legs: legs,
      legCount: legs.length,
      underlyings: Object.keys(census(legs, 'underlying')),
      dte: dte,
      expiry: legs.length ? legs[0].expiry : null,
      trade: tr ? { pnl: num(tr.pnl), hours: num(tr.hours), credit: num(tr.credit), max_loss: num(tr.max_loss) } : null
    };
  }

  var open = A(P.open).map(function (r) { return build(r, 'open'); });
  var closed = A(P.closed).map(function (r) { return build(r, 'closed'); });
  var unfilled = A(P.unfilled).map(function (r) { return build(r, 'unfilled'); });
  var all = open.concat(closed).concat(unfilled);
  var byId = {};
  all.forEach(function (s) { byId[s.id] = s; });

  var counts = O(data.counts);
  return {
    all: all, byId: byId,
    open: open, closed: closed, unfilled: unfilled,
    n: all.length,
    maxLossMax: maxOf(all.map(function (s) { return s.max_loss; })),
    maxLossSum: r2(sum(all.map(function (s) { return s.max_loss; }).filter(function (v) { return v != null; }))),
    legCount: all.reduce(function (a, s) { return a + s.legCount; }, 0),
    kindCensus: census(all, 'kind'),
    sleeveCensus: census(all, 'sleeve'),
    underlyingCensus: census(all.reduce(function (a, s) { return a.concat(s.legs); }, []), 'underlying'),
    reported: {
      total: num(counts.structures_total),
      open: num(counts.structures_open),
      closed: num(counts.structures_closed),
      unfilled: num(counts.structures_unfilled)
    },
    reconciles: (num(counts.structures_total) === all.length),
    expiries: census(all, 'expiry'),
    qtyPublished: all.every(function (s) { return s.qty != null; })
  };
}

function deriveTrades(data, structures, spine) {
  var rows = A(data.trades).map(function (t) {
    var pnl = num(t.pnl), maxLoss = num(t.max_loss);
    return {
      id: str(t.id), kind: str(t.kind), sleeve: str(t.sleeve),
      pnl: pnl, credit: num(t.credit), max_loss: maxLoss, hours: num(t.hours),
      opened: str(t.opened), closed: str(t.closed),
      openedMs: ms(t.opened), closedMs: ms(t.closed),
      iOpen: spine.bind(t.opened), iClose: spine.bind(t.closed),
      r: (pnl != null && maxLoss) ? r4(pnl / maxLoss) : null,
      win: pnl != null ? pnl > 0 : null,
      structure: structures.byId[str(t.id)] || null
    };
  });

  var pnls = rows.map(function (r) { return r.pnl; });
  var wins = rows.filter(function (r) { return r.pnl != null && r.pnl > 0; });
  var losses = rows.filter(function (r) { return r.pnl != null && r.pnl < 0; });
  var flats = rows.filter(function (r) { return r.pnl === 0; });
  var avgWin = wins.length ? r2(sum(wins.map(function (r) { return r.pnl; })) / wins.length) : null;
  var avgLoss = losses.length ? r2(sum(losses.map(function (r) { return r.pnl; })) / losses.length) : null;
  var winRate = rows.length ? r4(wins.length / rows.length) : null;
  var expectancy = rows.length ? r2(sum(pnls) / rows.length) : null;
  var total = r2(sum(pnls));
  var realized = num(O(data.book).realized);

  /* running total for the waterfall */
  var run = 0;
  var waterfall = rows.map(function (r) {
    var from = run;
    run = r2(run + (r.pnl || 0));
    return { id: r.id, label: r.id, kind: r.kind, v: r.pnl, from: from, to: run, win: r.win, i: r.iClose };
  });

  return {
    n: rows.length,
    rows: rows,
    waterfall: waterfall,
    total: total,
    realized: realized,
    reconciles: (total != null && realized != null) ? Math.abs(total - realized) < 0.01 : null,
    wins: wins.length, losses: losses.length, flats: flats.length,
    winRate: winRate,
    winDots: rows.map(function (r) { return r.win; }),
    avgWin: avgWin, avgLoss: avgLoss,
    expectancy: expectancy,
    payoff: (avgWin != null && avgLoss) ? r4(avgWin / Math.abs(avgLoss)) : null,
    pnl: stats(pnls),
    r: stats(rows.map(function (r) { return r.r; })),
    hours: stats(rows.map(function (r) { return r.hours; })),
    medianHours: median(rows.map(function (r) { return r.hours; })),
    buckets: {
      pnl: buckets(pnls, 6),
      r: buckets(rows.map(function (r) { return r.r; }), 6),
      hours: buckets(rows.map(function (r) { return r.hours; }), 6)
    },
    kindCensus: census(rows, 'kind'),
    sleeveCensus: census(rows, 'sleeve'),
    /* six closed trades over five sessions: state the sample, draw no trend */
    sampleNote: rows.length + ' closed trades — no rolling statistic is defensible at this n',
    rollingDrawn: false
  };
}

function derivePaths(data, spine, structures) {
  var src = O(O(data.series).manage);
  var cards = Object.keys(src).map(function (sid) {
    var rows = A(src[sid]).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
    var pos = structures.byId[sid] || null;
    var pts = rows.map(function (r) {
      return {
        i: spine.bind(r.t), t: r.t, ms: ms(r.t), day: dayOf(r.t),
        p: num(r.p), a: str(r.a), w: str(r.w) || ''
      };
    });
    var closeRow = null, j;
    for (j = pts.length - 1; j >= 0; j--) { if (pts[j].a === 'close') { closeRow = pts[j]; break; } }
    var vals = pts.map(function (p) { return p.p; });
    return {
      sid: sid,
      position: pos,
      kind: pos ? pos.kind : null,
      sleeve: pos ? pos.sleeve : null,
      status: pos ? pos.status : null,
      realizedPnl: pos ? pos.pnl : null,
      n: pts.length,
      pts: pts,
      line: lineOf(pts, 'p', spine.n),
      dupePoints: markDupes(pts),
      actions: census(pts, 'a'),
      holds: pts.filter(function (p) { return p.a === 'hold'; }).length,
      closes: pts.filter(function (p) { return p.a === 'close'; }).length,
      close: closeRow,
      exitRule: closeRow ? closeRow.w : null,
      holdReasons: census(pts.filter(function (p) { return p.a === 'hold'; }), 'w'),
      first: pts.length ? pts[0] : null,
      last: pts.length ? pts[pts.length - 1] : null,
      min: minOf(vals), max: maxOf(vals),
      i0: pts.length ? pts[0].i : null,
      i1: pts.length ? pts[pts.length - 1].i : null
    };
  }).sort(function (a, b) { return b.n - a.n; });

  var flat = cards.reduce(function (a, c) { return a.concat(c.pts); }, []);
  return {
    cards: cards,
    n: cards.length,
    points: flat.length,
    actions: census(flat, 'a'),
    reasons: census(flat, 'w'),
    exitRules: cards.filter(function (c) { return c.exitRule; })
                    .map(function (c) { return { sid: c.sid, rule: c.exitRule, t: c.close.t, i: c.close.i }; }),
    /* the field is the desk's estimate at manage time, not a mark-to-market */
    valueField: 'p',
    valueMeaning: 'desk estimate at manage time',
    perStructureMarks: false,
    perStructureMarksReason: 'marks are journalled per book, not per structure, so no per-structure mark-to-market series exists'
  };
}

function deriveStrikes(data, structures, signal) {
  var asof = ms(str(data.last_tick_utc) || str(data.generated_utc));
  var ev = O(O(data.params).events);
  var sigmas = num(ev.event_shield_sigmas);
  var mgmt = O(O(data.params).management);

  /* one published spot per underlying: the signal series for the one it
     covers, series.alt for anything else it saw */
  var spots = {};
  if (signal.last && signal.last.sym && signal.last.spot != null) {
    spots[signal.last.sym] = { spot: signal.last.spot, t: signal.last.t, src: 'series.signal[last].spot' };
  }
  A(O(data.series).alt).forEach(function (a) {
    if (a && a.sym && num(a.spot) != null) {
      var cur = spots[a.sym];
      if (!cur || ms(a.t) > ms(cur.t)) spots[a.sym] = { spot: num(a.spot), t: a.t, src: 'series.alt[last with a spot].spot' };
    }
  });
  var ivBySym = {};
  if (signal.current.atm_iv != null && signal.last && signal.last.sym) ivBySym[signal.last.sym] = signal.current.atm_iv;

  var groups = {};
  structures.all.forEach(function (s) {
    s.legs.forEach(function (l) {
      var u = l.underlying || 'UNKNOWN';
      var g = groups[u] || (groups[u] = { underlying: u, legs: [], structures: {} });
      g.legs.push({
        symbol: l.symbol, right: l.right, strike: l.strike, qty: l.qty, entry: l.entry,
        short: l.short, expiry: l.expiry, dte: l.dte,
        sid: s.id, kind: s.kind, status: s.status, sleeve: s.sleeve
      });
      g.structures[s.id] = 1;
    });
  });

  var byUnderlying = Object.keys(groups).map(function (u) {
    var g = groups[u];
    var strikes = g.legs.map(function (l) { return l.strike; });
    var sp = spots[u] || null;
    var iv = ivBySym[u] != null ? ivBySym[u] : null;
    var dte = minOf(g.legs.map(function (l) { return l.dte; }));
    var sigma = (sp && iv != null && dte != null && dte > 0)
      ? r2(sp.spot * iv * Math.sqrt(dte / 365)) : null;
    return {
      underlying: u,
      legs: g.legs.sort(function (a, b) { return a.strike - b.strike; }),
      legCount: g.legs.length,
      structures: Object.keys(g.structures),
      strikeMin: minOf(strikes), strikeMax: maxOf(strikes),
      spot: sp ? sp.spot : null,
      spotSrc: sp ? sp.src : null,
      spotAt: sp ? sp.t : null,
      iv: iv,
      dte: dte,
      sigma: sigma,
      shield: (sigma != null && sigmas != null && sp) ? {
        sigmas: sigmas,
        lo: r2(sp.spot - sigmas * sigma),
        hi: r2(sp.spot + sigmas * sigma),
        oneSigma: sigma,
        src: 'params.events.event_shield_sigmas x ATM IV x sqrt(dte/365)'
      } : null,
      shieldMissing: (sigma == null)
        ? (iv == null ? 'no ATM IV published for ' + u : 'no spot or DTE for ' + u)
        : null
    };
  }).sort(function (a, b) { return b.legCount - a.legCount; });

  var dteRows = structures.all.map(function (s) {
    return {
      id: s.id, kind: s.kind, status: s.status, dte: s.dte, expiry: s.expiry,
      timeStop: num(mgmt.time_stop_dte), minEntry: num(mgmt.min_entry_dte),
      pastTimeStop: (s.dte != null && num(mgmt.time_stop_dte) != null) ? s.dte <= mgmt.time_stop_dte : null
    };
  });

  return {
    byUnderlying: byUnderlying,
    legCount: structures.legCount,
    asof: str(data.last_tick_utc) || str(data.generated_utc),
    dte: dteRows,
    timeStopDte: num(mgmt.time_stop_dte),
    minEntryDte: num(mgmt.min_entry_dte),
    sigmas: sigmas
  };
}

/* ==========================================================================
   10 · RECONCILIATION
   ========================================================================== */

function deriveRecon(data, books, spine) {
  var b = O(data.book), br = O(data.broker), q = O(data.quotes);
  var start = num(b.start), pnl = num(b.pnl);
  var marked = (start != null && pnl != null) ? r2(start + pnl) : null;
  var equity = num(br.equity);
  var gap = (equity != null && marked != null) ? r2(equity - marked) : null;
  var legs = num(q.legs);

  /* one cent on one contract is one dollar.  A half-spread envelope over the
     legs we actually hold is  legs x cents x 0.5  dollars. */
  function env(cents) {
    return (legs != null && num(cents) != null) ? r2(legs * cents * 0.5) : null;
  }
  var narrow = env(q.narrowest_c), medEnv = env(q.median_c), wide = env(q.widest_c);
  var perLegCents = (gap != null && legs) ? r2(Math.abs(gap) / legs) : null;

  var real = books.byKey.real;
  var history = real ? lastByTick(
      real.pts.filter(function (p) { return p.eq != null && p.v != null; }), spine.n)
    .map(function (p) {
      var mk = start != null ? r2(start + p.v) : null;
      return { i: p.i, t: p.t, eq: p.eq, marked: mk, gap: mk != null ? r2(p.eq - mk) : null };
    }) : [];

  var checks = A(O(data.series).brokercheck).map(function (c) {
    return {
      i: spine.bind(c.t), t: c.t, day: dayOf(c.t),
      store: num(c.store), broker: num(c.broker),
      diffs: num(c.diffs), repaired: A(c.repaired), after: num(c.after),
      delta: (num(c.broker) != null && num(c.store) != null) ? r2(c.broker - c.store) : null
    };
  });

  return {
    start: start, pnl: pnl, realized: num(b.realized), unrealized: num(b.unrealized),
    pnlPct: num(b.pnl_pct),
    markedEquity: marked, markedAt: str(b.marked_at),
    brokerEquity: equity, brokerCash: num(br.cash), brokerAsOf: str(br.asof_utc),
    gap: gap, gapAbs: gap == null ? null : Math.abs(gap),
    legs: legs,
    quotes: { narrowest_c: num(q.narrowest_c), median_c: num(q.median_c), widest_c: num(q.widest_c) },
    envelope: { narrow: narrow, median: medEnv, wide: wide },
    perLegCents: perLegCents,
    withinNarrow: (gap != null && narrow != null) ? Math.abs(gap) <= narrow : null,
    withinMedian: (gap != null && medEnv != null) ? Math.abs(gap) <= medEnv : null,
    withinWide: (gap != null && wide != null) ? Math.abs(gap) <= wide : null,
    history: history,
    historyLine: history.map(function (h) { return { i: h.i, v: h.gap }; }),
    historyN: history.length,
    historyOf: real ? real.n : 0,
    gapStats: stats(history.map(function (h) { return h.gap; })),
    brokerChecks: checks,
    /* the two rows are different quantities measured at different instants */
    note: 'broker equity is polled at ' + (str(br.asof_utc) || '?') +
          '; the book is marked at ' + (str(b.marked_at) || '?')
  };
}

/* ==========================================================================
   11 · INTEGRITY, VERIFICATION, CLAIMS
   ========================================================================== */

function deriveIntegrity(data, spine) {
  var rows = A(O(data.series).integrity).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  var cells = rows.map(function (r, j) {
    return {
      k: j, i: spine.bind(r.t), t: r.t, day: dayOf(r.t),
      ok: r.ok !== false, reason: str(r.reason) || ''
    };
  });
  var fails = cells.filter(function (c) { return !c.ok; });
  return {
    n: cells.length,
    cells: cells,
    ok: cells.length - fails.length,
    fail: fails.length,
    failures: fails,
    allClear: fails.length === 0,
    perDay: census(cells, 'day'),
    reasons: census(fails, 'reason')
  };
}

function deriveClaims(data, ctx) {
  var V = O(data.verification);
  var claims = A(V.claims);
  var kinds = O(data.kinds);
  var counts = O(data.counts);

  /* Only claims with a COMPLETE published counter-source are auto-checked.
     Anything sourced from the truncated decisions array returns ok:null —
     a false red badge in front of a judge is worse than an honest blank. */
  var checkers = {
    journal_entries: function () {
      var s = sum(Object.keys(kinds).map(function (k) { return kinds[k]; }));
      return { value: s, src: 'sum of the 34-kind census in .kinds' };
    },
    journal_chain: function () {
      return { value: V.chain_ok ? 'intact' : 'broken', src: 'verification.chain_ok' };
    },
    ticks: function () {
      return { value: A(O(data.series).ticks).length, src: 'series.ticks[].length' };
    },
    gate_evaluations: function () {
      return { value: ctx.gates.n, src: 'series.gates[].length' };
    },
    entries_refused_by_gates: function () {
      return { value: ctx.refusals.rows.filter(function (r) { return r.kind === 'entry_refused'; }).length,
               src: "series.refusals[] where kind='entry_refused'" };
    },
    structures_total: function () {
      return { value: ctx.structures.n, src: 'positions.open + closed + unfilled' };
    },
    structures_open: function () { return { value: ctx.structures.open.length, src: 'positions.open[].length' }; },
    structures_closed: function () { return { value: ctx.structures.closed.length, src: 'positions.closed[].length' }; },
    realized_pnl_usd: function () { return { value: num(O(data.book).realized), src: 'book.realized' }; },
    realized_pnl_per_broker_fills_usd: function () {
      return { value: ctx.trades.total, src: 'sum of trades[].pnl' };
    },
    book_worst_case_peak_usd: function () {
      var m = ctx.gates.worstCase.min;
      return { value: m == null ? null : Math.abs(m), src: 'min of series.gates[].wc.pnl' };
    },
    orders_submitted_live: function () {
      var n = (num(kinds.order_open) || 0) + (num(kinds.order_close) || 0);
      return { value: n, src: 'kinds.order_open + kinds.order_close' };
    },
    desk_meetings_total: function () { return { value: ctx.desk.n, src: 'series.desk[].length' }; },
    desk_meetings_llm_dark: function () { return { value: ctx.desk.dark, src: 'series.desk[] where dark' }; },
    llm_fallbacks_recorded: function () {
      return { value: ctx.desk.roleFailures, src: 'series.desk[].roles[] where ok is false' };
    },
    marks_quarantined: function () {
      return { value: A(O(data.series).quarantine).length, src: 'series.quarantine[].length' };
    },
    test_functions: function () { return { value: num(V.test_defs), src: 'verification.test_defs' }; }
  };

  var rows = claims.map(function (c) {
    var name = str(c.name);
    var fn = checkers[name];
    var check = { value: null, src: null, ok: null };
    if (fn) {
      var got = fn();
      check.value = got.value;
      check.src = got.src;
      if (got.value != null) {
        var a = String(got.value), b = String(c.value);
        var na = parseFloat(a), nb = parseFloat(b);
        check.ok = (isFinite(na) && isFinite(nb)) ? Math.abs(na - nb) < 0.005 : a === b;
      }
    }
    return {
      n: str(c.n), name: name, value: c.value, src: str(c.src),
      check: check,
      verifiable: !!fn
    };
  });

  return {
    rows: rows,
    n: rows.length,
    total: num(V.claims_total),
    checked: rows.filter(function (r) { return r.check.ok != null; }).length,
    passing: rows.filter(function (r) { return r.check.ok === true; }).length,
    failing: rows.filter(function (r) { return r.check.ok === false; }).length,
    unverifiable: rows.filter(function (r) { return r.check.ok == null; }).length,
    srcPublished: rows.every(function (r) { return !!r.src; })
  };
}

/* ==========================================================================
   12 · DAYS, DAILY COUNTERS, THE CONTEXT TREE
   ========================================================================== */

function deriveDays(data, spine, ctx) {
  var ticksB = bindRows(O(data.series).ticks, spine);
  var tickPerDay = census(A(O(data.series).ticks), function (r) { return dayOf(r.t); });
  var daily = A(O(data.series).daily);
  var dailyByDay = {};
  daily.forEach(function (d) { dailyByDay[str(d.day)] = d; });

  var real = ctx.books.byKey.real;
  var sessByDay = {};
  if (real) real.sessions.forEach(function (s) { sessByDay[s.day] = s; });

  var days = spine.days.map(function (d) {
    var dl = dailyByDay[d.day] || null;
    var sess = sessByDay[d.day] || null;
    return {
      day: d.day, dayIdx: d.dayIdx, i0: d.i0, i1: d.i1,
      spineTicks: d.n,
      ticks: tickPerDay[d.day] || 0,
      signals: ctx.signal.rows.filter(function (r) { return r.day === d.day; }).length,
      marks: real ? real.pts.filter(function (p) { return p.day === d.day; }).length : 0,
      meetings: ctx.desk.rows.filter(function (r) { return r.day === d.day; }).length,
      gateEvals: ctx.gates.evals.filter(function (r) { return r.day === d.day; }).length,
      refusals: ctx.refusals.rows.filter(function (r) { return r.day === d.day; }).length,
      derisk: A(O(data.series).derisk).filter(function (r) { return dayOf(r.t) === d.day; }).length,
      opened: ctx.structures.all.filter(function (s) { return dayOf(s.opened) === d.day; }).length,
      closed: ctx.structures.all.filter(function (s) { return s.closed && dayOf(s.closed) === d.day; }).length,
      pnlLast: sess ? sess.last : null,
      pnlDelta: sess ? sess.delta : null,
      pnlMin: sess ? sess.min : null,
      pnlMax: sess ? sess.max : null,
      counters: dl ? {
        entries: num(dl.entries),
        gate_rejections: num(dl.gate_rejections),
        new_risk: num(dl.new_risk),
        partial: !(has(dl, 'entries') && has(dl, 'gate_rejections') && has(dl, 'new_risk'))
      } : null,
      dow: DOW[new Date(ms(d.day + 'T00:00:00')).getUTCDay()]
    };
  });

  var journalDays = {};
  days.forEach(function (d) { journalDays[d.day] = 1; });
  var orphanCounters = daily.filter(function (d) { return !journalDays[str(d.day)]; })
    .map(function (d) {
      return {
        day: str(d.day), entries: num(d.entries), gate_rejections: num(d.gate_rejections),
        new_risk: num(d.new_risk),
        note: 'counters are keyed by the exchange day; no journal entry carries this UTC date'
      };
    });

  return {
    rows: days,
    n: days.length,
    orphanCounters: orphanCounters,
    dailyRows: daily.map(function (d) {
      return {
        day: str(d.day), entries: num(d.entries), gate_rejections: num(d.gate_rejections),
        new_risk: num(d.new_risk),
        partial: !(has(d, 'entries') && has(d, 'gate_rejections') && has(d, 'new_risk')),
        orphan: !journalDays[str(d.day)]
      };
    })
  };
}

function deriveTree(data, ctx) {
  var uni = A(O(O(data.params).universe).underlyings);
  var primary = str(O(O(data.params).universe).primary);
  var alt = A(O(data.series).alt);
  var altBySym = {};
  alt.forEach(function (a) {
    var s = str(a.sym); if (!s) return;
    var e = altBySym[s] || (altBySym[s] = { tried: 0, taken: 0, lastSpot: null, lastT: null, reasons: {} });
    e.tried++;
    if (a.taken) e.taken++;
    if (num(a.spot) != null) { e.lastSpot = num(a.spot); e.lastT = str(a.t); }
    if (str(a.reason)) e.reasons[a.reason] = (e.reasons[a.reason] || 0) + 1;
  });

  var sigSym = ctx.signal.symCensus;
  var th = ctx.signal.thresholds;
  var universe = uni.map(function (sym) {
    var covered = !!sigSym[sym];
    var rows = covered ? ctx.signal.rows.filter(function (r) { return r.sym === sym; }) : [];
    var last = rows.length ? rows[rows.length - 1] : null;
    var a = altBySym[sym] || { tried: 0, taken: 0, lastSpot: null, lastT: null, reasons: {} };
    var vrp = last ? last.vrp : null;
    return {
      sym: sym,
      primary: sym === primary,
      covered: covered,
      obs: rows.length,
      vrp: vrp,
      iv: last ? last.iv : null,
      rv: last ? last.rv : null,
      pts: last ? last.pts : null,
      ratio: last ? last.ratio : null,
      spot: last ? last.spot : a.lastSpot,
      spotSrc: last ? 'series.signal' : (a.lastSpot != null ? 'series.alt' : null),
      at: last ? last.t : a.lastT,
      state: vrp == null ? null
        : (th.rich != null && vrp >= th.rich) ? 'rich'
        : (th.cheap != null && vrp <= th.cheap) ? 'cheap' : 'neutral',
      spark: lineOf(rows, 'vrp', ctx.spine.n),
      rotations: { tried: a.tried, taken: a.taken },
      neverTaken: a.tried > 0 && a.taken === 0,
      legsHeld: ctx.structures.underlyingCensus[sym] || 0,
      missing: covered ? null : 'series.signal[] carries no row with sym=' + sym,
      reasonPublished: Object.keys(a.reasons).length > 0
    };
  });

  var structures = ctx.structures.all.map(function (s) {
    return {
      id: s.id, kind: s.kind, sleeve: s.sleeve, status: s.status, bucket: s.bucket,
      qty: s.qty, credit: s.credit, max_loss: s.max_loss, pnl: s.pnl, r: s.r,
      opened: s.opened, closed: s.closed, dte: s.dte,
      meterFrac: (s.max_loss != null && ctx.structures.maxLossMax)
        ? r4(s.max_loss / ctx.structures.maxLossMax) : null
    };
  });

  var gates = ctx.gates.ids.map(function (id) {
    var s = ctx.gates.stats[id];
    return {
      id: id, label: s.label, what: s.what, params: s.params,
      fail: s.fail, evals: s.evals, notReached: s.notReached,
      rate: s.failRate, everBound: s.everBound, firstFail: s.firstFail
    };
  });

  return {
    universe: universe,
    universeCovered: universe.filter(function (u) { return u.covered; }).length,
    structures: structures,
    maxLossMax: ctx.structures.maxLossMax,
    gates: gates,
    days: ctx.days.rows.map(function (d) {
      return { day: d.day, dow: d.dow, pnlLast: d.pnlLast, pnlDelta: d.pnlDelta,
               ticks: d.ticks, i0: d.i0, i1: d.i1 };
    })
  };
}

/* ==========================================================================
   13 · THE BLOTTER — normalised rows, one shape for eight tabs
   ========================================================================== */

var SEV_GATE = ['entry_refused', 'desk_veto', 'derisk_mode', 'no_candidate', 'market_closed'];
var SEV_BREACH = ['tick_crash', 'data_suspect', 'repair', 'chain_relinked', 'flatten_all', 'alert'];

function sevOf(kind) {
  if (!kind) return 'default';
  if (SEV_GATE.indexOf(kind) >= 0) return 'gate';
  if (SEV_BREACH.indexOf(kind) >= 0) return 'breach';
  if (kind.indexOf('order') === 0) return 'order';
  if (kind === 'manage') return 'manage';
  return 'default';
}

var KIND_LABEL = {
  manage: 'MANAGE', tick_start: 'TICK START', tick_end: 'TICK END', integrity: 'INTEGRITY',
  signals: 'SIGNALS', marks: 'MARKS', desk: 'DESK MEETING', gates: 'GATE EVAL',
  entry_refused: 'ENTRY REFUSED', alt_underlying_none: 'NO ALT UNDERLYING',
  alt_underlying: 'ALT UNDERLYING', derisk_mode: 'DERISK MODE',
  underlying_order: 'UNDERLYING ORDER', no_candidate: 'NO CANDIDATE',
  order_open: 'ORDER OPEN', order_close: 'ORDER CLOSE', order_hedge: 'ORDER HEDGE',
  open_reconcile: 'OPEN RECONCILE', close_reconcile: 'CLOSE RECONCILE',
  entry_skipped_duplicate: 'DUPLICATE SKIPPED', market_closed: 'MARKET CLOSED',
  baseline_naive_entry: 'BASELINE ENTRY', desk_veto: 'DESK VETO',
  broker_check: 'BROKER CHECK', new_risk_released: 'NEW RISK RELEASED',
  reprice: 'REPRICE', hedge_not_needed: 'HEDGE NOT NEEDED', flatten_all: 'FLATTEN ALL',
  repair: 'REPAIR', data_suspect: 'DATA SUSPECT', alert: 'ALERT',
  tick_crash: 'TICK CRASH', close_cross_spread: 'CLOSE CROSS SPREAD',
  chain_relinked: 'CHAIN RELINKED',
  position: 'POSITION', trade: 'TRADE', refusal: 'REFUSAL'
};

function nrow(o) {
  return {
    src: o.src, key: o.key,
    t: o.t, ms: ms(o.t), i: o.i, day: dayOf(o.t),
    kind: o.kind || '', label: KIND_LABEL[o.kind] || (o.kind || '').toUpperCase().replace(/_/g, ' '),
    id: o.id || '', action: o.action || '', reason: o.reason || '',
    gate: o.gate || null, pnl: o.pnl == null ? null : o.pnl,
    sev: sevOf(o.kind),
    sel: o.sel || null,
    d: o.d == null ? null : o.d,
    raw: o.raw
  };
}

function deriveBlotter(data, spine, ctx) {
  var decisions = A(data.decisions).map(function (r, j) {
    return nrow({
      src: 'decisions', key: 'dec:' + j,
      t: r.t, i: spine.bind(r.t), kind: str(r.kind) || '', id: str(r.id) || '',
      action: str(r.action) || '', reason: str(r.reason) || '',
      gate: /^g\d/.test(str(r.action) || '') ? r.action : null,
      pnl: num(r.pnl), d: r.d == null ? null : r.d, raw: r,
      sel: str(r.id) ? { type: 'structure', id: str(r.id) } : { type: 'decision', id: 'dec:' + j }
    });
  });

  var refusals = ctx.refusals.rows.map(function (r, j) {
    return nrow({
      src: 'refusals', key: 'ref:' + j,
      t: r.t, i: r.i, kind: r.kind, id: '', action: r.gate || '',
      reason: r.reason, gate: r.gate, pnl: null, raw: r,
      sel: { type: 'refusal', id: 'ref:' + j }
    });
  });

  var positions = ctx.structures.all.map(function (s) {
    return nrow({
      src: 'positions', key: 'pos:' + s.id,
      t: s.opened, i: s.iOpen, kind: 'position', id: s.id,
      action: s.status || '', reason: s.kind + ' · ' + s.sleeve +
        (s.max_loss != null ? ' · max loss ' + s.max_loss : ''),
      pnl: s.pnl, raw: s, sel: { type: 'structure', id: s.id }
    });
  });

  var trades = ctx.trades.rows.map(function (t) {
    return nrow({
      src: 'trades', key: 'trd:' + t.id,
      t: t.closed, i: t.iClose, kind: 'trade', id: t.id,
      action: 'closed', reason: t.kind + ' · ' + (t.hours != null ? t.hours + 'h' : '') +
        (t.r != null ? ' · ' + t.r + 'R' : ''),
      pnl: t.pnl, raw: t, sel: { type: 'trade', id: t.id }
    });
  });

  var gateRows = ctx.gates.evals.map(function (e) {
    return nrow({
      src: 'gates', key: 'gev:' + e.k,
      t: e.t, i: e.i, kind: 'gates', id: e.sid || '',
      action: e.passed ? 'passed' : (e.firstFail || 'refused'),
      reason: e.passed
        ? e.nPassed + ' of ' + e.nEvaluated + ' gates passed'
        : (e.fails.length ? e.fails[0].reason : ''),
      gate: e.firstFail, pnl: null, raw: e,
      sel: { type: 'gateeval', id: e.k }
    });
  });

  var deskRows = ctx.desk.rows.map(function (m) {
    return nrow({
      src: 'desk', key: 'dsk:' + m.k,
      t: m.t, i: m.i, kind: m.veto ? 'desk_veto' : 'desk', id: '',
      action: m.veto ? 'veto' : (m.dis ? 'disagreement' : (m.dark ? 'dark' : 'agreed')),
      reason: (m.a || '?') + ' / ' + (m.b || '?') +
        (m.mult != null ? ' · size x' + m.mult : '') +
        (m.why ? ' · ' + m.why : ''),
      pnl: null, raw: m, sel: { type: 'meeting', id: m.k }
    });
  });

  var integrityRows = ctx.integrity.cells.map(function (c) {
    return nrow({
      src: 'integrity', key: 'int:' + c.k,
      t: c.t, i: c.i, kind: 'integrity', id: '',
      action: c.ok ? 'ok' : 'exception', reason: c.reason, pnl: null, raw: c,
      sel: { type: 'integrity', id: c.k }
    });
  });

  /* ALL = every decision, plus the series rows the truncated decisions array
     does not already carry (same kind, same second, same id). */
  var seen = Object.create(null);
  decisions.forEach(function (r) { seen[r.kind + '|' + r.t + '|' + r.id] = 1; });
  var extra = [];
  [refusals, gateRows, deskRows, integrityRows].forEach(function (list) {
    list.forEach(function (r) {
      var k = r.kind + '|' + r.t + '|' + r.id;
      if (!seen[k]) { seen[k] = 1; extra.push(r); }
    });
  });
  var all = decisions.concat(extra).sort(function (a, b) { return a.ms - b.ms || (a.key < b.key ? -1 : 1); });

  var decMs = decisions.map(function (r) { return r.ms; });
  var journalTotal = sum(Object.keys(O(data.kinds)).map(function (k) { return data.kinds[k]; }));

  return {
    by: {
      decisions: decisions,
      refusals: refusals,
      positions: positions,
      trades: trades,
      gates: gateRows,
      desk: deskRows,
      integrity: integrityRows,
      all: all
    },
    counts: {
      decisions: decisions.length, refusals: refusals.length, positions: positions.length,
      trades: trades.length, gates: gateRows.length, desk: deskRows.length,
      integrity: integrityRows.length, all: all.length
    },
    kindCensus: census(decisions, 'kind'),
    journalKinds: O(data.kinds),
    journalTotal: journalTotal,
    coverage: {
      decisions: decisions.length,
      journalTotal: journalTotal,
      truncated: journalTotal > decisions.length,
      from: decMs.length ? new Date(Math.min.apply(null, decMs)).toISOString() : null,
      to: decMs.length ? new Date(Math.max.apply(null, decMs)).toISOString() : null,
      addedFromSeries: extra.length,
      note: 'decisions is the newest ' + decisions.length + ' journal rows of ' +
            journalTotal + '; the series tabs carry the full history for their own kind'
    },
    perDay: censusRows(census(decisions, 'day')).sort(function (a, b) { return a.key < b.key ? -1 : 1; })
                .map(function (r) { return { day: r.key, n: r.n }; }),
    vetoSource: 'series.desk[].veto',
    vetoNote: 'the decisions export carries desk_veto rows only inside its window; the desk tab counts every meeting'
  };
}

/* run-collapsing: consecutive rows with an identical (kind, action, reason)
   fold into one carrying n and a time range.  Order and fill rows never fold. */
function collapseRuns(rows, opts) {
  rows = A(rows);
  opts = O(opts);
  var never = opts.never || function (r) {
    return r.sev === 'order' || r.kind === 'open_reconcile' || r.kind === 'close_reconcile' ||
           r.kind === 'position' || r.kind === 'trade';
  };
  var out = [], cur = null, i, r, k;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    k = r.kind + '\x00' + r.action + '\x00' + r.reason;
    if (cur && cur.runKey === k && !never(r)) {
      cur.n++;
      cur.t1 = r.t; cur.ms1 = r.ms; cur.i1 = r.i;
      cur.members.push(r);
      if (r.pnl != null) cur.pnlSum = r2((cur.pnlSum || 0) + r.pnl);
      continue;
    }
    cur = {
      run: true, runKey: k, n: 1,
      t: r.t, ms: r.ms, i: r.i, day: r.day,
      t1: r.t, ms1: r.ms, i1: r.i,
      kind: r.kind, label: r.label, id: r.id, action: r.action, reason: r.reason,
      gate: r.gate, sev: r.sev, sel: r.sel, pnl: r.pnl, pnlSum: r.pnl,
      head: r, members: [r]
    };
    out.push(cur);
    if (never(r)) cur = null;
  }
  return out;
}

function viewStats(rows) {
  rows = A(rows);
  var kinds = census(rows, 'kind');
  var gatesC = census(rows, 'gate');
  var msv = rows.map(function (r) { return r.ms; }).filter(isFinite);
  var top = null;
  Object.keys(gatesC).forEach(function (g) { if (!top || gatesC[g] > gatesC[top]) top = g; });
  var orders = rows.filter(function (r) { return r.sev === 'order'; }).length;
  var refused = rows.filter(function (r) { return r.sev === 'gate'; }).length;
  return {
    n: rows.length,
    orders: orders,
    refused: refused,
    kinds: kinds,
    gates: gatesC,
    topGate: top ? { gate: top, n: gatesC[top] } : null,
    from: msv.length ? new Date(Math.min.apply(null, msv)).toISOString() : null,
    to: msv.length ? new Date(Math.max.apply(null, msv)).toISOString() : null,
    perDay: censusRows(census(rows, 'day')).sort(function (a, b) { return a.key < b.key ? -1 : 1; })
              .map(function (r) { return { day: r.key, n: r.n }; }),
    pnl: stats(rows.map(function (r) { return r.pnl; }))
  };
}

function perDay(rows) {
  return censusRows(census(A(rows), 'day')).sort(function (a, b) { return a.key < b.key ? -1 : 1; })
    .map(function (r) { return { day: r.key, n: r.n }; });
}

/* ==========================================================================
   14 · OVERLAYS, FUNNEL, PARAMS, AUTHORITY, CAVEATS
   ========================================================================== */

function deriveOverlays(data, spine, ctx) {
  var derisk = A(O(data.series).derisk).map(function (r) {
    return { i: spine.bind(r.t), t: r.t, day: dayOf(r.t), reason: str(r.reason) || '' };
  }).sort(function (a, b) { return a.i - b.i; });

  var bands = [], cur = null;
  derisk.forEach(function (d) {
    if (cur && d.i <= cur.i1 + 1) { cur.i1 = d.i; cur.n++; }
    else { cur = { i0: d.i, i1: d.i, n: 1, reason: d.reason, t: d.t }; bands.push(cur); }
  });

  var quarantine = A(O(data.series).quarantine).map(function (r) {
    return { i: spine.bind(r.t), t: r.t, book: str(r.book), reason: str(r.reason) || '' };
  });
  var qByTick = {};
  quarantine.forEach(function (q) {
    (qByTick[q.i] || (qByTick[q.i] = { i: q.i, t: q.t, books: [], reason: q.reason })).books.push(q.book);
  });

  var reprice = A(O(data.series).reprice).map(function (r) {
    return { i: spine.bind(r.t), t: r.t, sid: str(r.sid), attempt: num(r.attempt),
             from: num(r.from), to: num(r.to),
             haircut: (num(r.from) && num(r.to) != null) ? r4(1 - r.to / r.from) : null };
  });

  var alt = A(O(data.series).alt).map(function (r) {
    return { i: spine.bind(r.t), t: r.t, sym: str(r.sym), spot: num(r.spot),
             taken: !!r.taken, reason: str(r.reason) || '' };
  });

  /* entries: complete, from positions.  orders: partial, from decisions. */
  var entries = [];
  ctx.structures.all.forEach(function (s) {
    if (s.opened) entries.push({ i: s.iOpen, t: s.opened, id: s.id, kind: s.kind,
                                 dir: 'open', status: s.status });
    if (s.closed) entries.push({ i: s.iClose, t: s.closed, id: s.id, kind: s.kind,
                                 dir: 'close', status: s.status, pnl: s.pnl });
  });
  entries.sort(function (a, b) { return a.i - b.i; });

  var orderRows = ctx.blotter.by.decisions.filter(function (r) { return r.sev === 'order'; })
    .map(function (r) { return { i: r.i, t: r.t, kind: r.kind, id: r.id, reason: r.reason }; });

  var kinds = O(data.kinds);
  var orderTotal = (num(kinds.order_open) || 0) + (num(kinds.order_close) || 0) + (num(kinds.order_hedge) || 0);

  var hwm = num(O(data.kv).high_watermark);
  var start = num(O(data.book).start);
  var real = ctx.books.byKey.real;

  return {
    derisk: derisk,
    deriskBands: bands,
    deriskN: derisk.length,
    quarantine: quarantine,
    quarantineTicks: Object.keys(qByTick).map(function (k) { return qByTick[k]; }),
    quarantineN: quarantine.length,
    quarantineReported: num(data.marks_quarantined),
    reprice: reprice,
    alt: alt,
    entries: entries,
    entriesSrc: 'positions[].opened / .closed',
    orders: orderRows,
    ordersPartial: orderRows.length < orderTotal,
    ordersTotal: orderTotal,
    ordersNote: 'decisions is truncated, so only ' + orderRows.length + ' of ' + orderTotal +
                ' order rows are inside it; positions carry every structure',
    hwm: hwm == null ? null : {
      equity: hwm,
      pnlEquivalent: start != null ? r2(hwm - start) : null,
      note: 'an equity high-water mark; the P&L curve peaks at ' +
            (real && real.peak != null ? real.peak : '?') + ' — different quantities',
      haltAt: num(O(data.limits).drawdown_halt)
    },
    broker: real ? lastByTick(real.pts.filter(function (p) { return p.eq != null; }), spine.n)
      .map(function (p) { return { i: p.i, v: p.eq, pnlEquivalent: start != null ? r2(p.eq - start) : null }; }) : [],
    brokerN: real ? real.eqCount : 0,
    brokerOf: real ? real.n : 0
  };
}

function deriveFunnel(data, ctx) {
  var counts = O(data.counts);
  var kinds = O(data.kinds);
  var byKind = ctx.refusals.byKindMap;

  var stages = [
    { key: 'ticks', label: 'TICK STARTS', n: num(counts.ticks), src: 'counts.ticks' },
    { key: 'signals', label: 'SIGNALS', n: ctx.signal.n, src: 'series.signal[].length' },
    { key: 'meetings', label: 'DESK MEETINGS', n: ctx.desk.n, src: 'series.desk[].length' },
    { key: 'gateEvals', label: 'GATE EVALUATIONS', n: ctx.gates.n, src: 'series.gates[].length' },
    { key: 'passed', label: 'PASSED ALL GATES', n: ctx.gates.passed, src: 'series.gates[] where passed' },
    { key: 'orders', label: 'ORDERS SUBMITTED', n: num(kinds.order_open), src: 'kinds.order_open' },
    { key: 'filled', label: 'STRUCTURES FILLED',
      n: ctx.structures.open.length + ctx.structures.closed.length,
      src: 'positions.open + positions.closed' },
    { key: 'open', label: 'STILL OPEN', n: ctx.structures.open.length, src: 'positions.open[].length' }
  ];

  var leaks = [
    { key: 'no_candidate', label: 'NO CANDIDATE', n: num(byKind.no_candidate), src: 'refusals.by_kind.no_candidate' },
    { key: 'derisk_mode', label: 'DERISK MODE', n: num(byKind.derisk_mode), src: 'refusals.by_kind.derisk_mode' },
    { key: 'entry_refused', label: 'REFUSED BY A GATE', n: num(byKind.entry_refused), src: 'refusals.by_kind.entry_refused' },
    { key: 'entry_skipped_duplicate', label: 'DUPLICATE', n: num(byKind.entry_skipped_duplicate), src: 'refusals.by_kind.entry_skipped_duplicate' },
    { key: 'market_closed', label: 'MARKET CLOSED', n: num(byKind.market_closed), src: 'refusals.by_kind.market_closed' },
    { key: 'desk_veto', label: 'DESK VETO', n: num(byKind.desk_veto), src: 'refusals.by_kind.desk_veto' },
    { key: 'data_suspect', label: 'DATA SUSPECT', n: num(byKind.data_suspect), src: 'refusals.by_kind.data_suspect' },
    { key: 'unfilled', label: 'SUBMITTED, NEVER FILLED', n: ctx.structures.unfilled.length, src: 'positions.unfilled[].length' }
  ].filter(function (l) { return l.n != null; });

  return {
    stages: stages,
    leaks: leaks,
    /* five different denominators; the spec forbids treating them as one */
    denominators: ctx.denominators
  };
}

function deriveParams(data, ctx) {
  var P = O(data.params);
  var gateByParam = {};
  ctx.gates.defs.forEach(function (d) {
    A(d.params).forEach(function (p) { (gateByParam[p] || (gateByParam[p] = [])).push(d.id); });
  });

  /* which panel draws a threshold.  Panel ids only; no styling, no markup. */
  var PANEL = {
    'regime.vrp_rich_threshold': ['b3', 'a1'], 'regime.vrp_cheap_threshold': ['b3', 'a1'],
    'regime.rv_lookback_days': ['a1'],
    'risk.per_structure_max_loss_frac': ['c2'], 'risk.portfolio_worst_case_frac': ['c2'],
    'risk.portfolio_worst_case_cap': ['c2'], 'risk.daily_new_risk_frac': ['c2'],
    'risk.cheap_sleeve_budget_frac': ['c2'], 'risk.cheap_sleeve_budget_cap': ['c2'],
    'risk.drawdown_halt_frac': ['c2', 'b2'], 'risk.earned_budget_gain_mult': ['c2'],
    'liquidity.max_rel_spread': ['c1', 'd1'], 'liquidity.max_quote_age_min': ['c1'],
    'timing.no_trade_first_min': ['c1'], 'timing.no_trade_last_min': ['c1'],
    'events.derisk_hours_before': ['b5'], 'events.event_shield_sigmas': ['d4'],
    'management.time_stop_dte': ['d4'], 'management.min_entry_dte': ['d4'],
    'sizing.disagreement_mult': ['b5'], 'sizing.neutral_regime_mult': ['b5'],
    'universe.underlyings': ['a2'], 'universe.primary': ['a2']
  };

  var rows = [];
  Object.keys(P).forEach(function (section) {
    var v = P[section];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.keys(v).forEach(function (k) {
        var path = section + '.' + k;
        rows.push({
          section: section, key: k, path: path, value: v[k],
          type: Array.isArray(v[k]) ? 'array' : typeof v[k],
          gates: gateByParam[path] || [],
          panels: PANEL[path] || []
        });
      });
    } else {
      rows.push({ section: section, key: '', path: section, value: v,
                  type: typeof v, gates: gateByParam[section] || [], panels: PANEL[section] || [] });
    }
  });

  return {
    rows: rows,
    n: rows.length,
    sections: Object.keys(P),
    byPath: (function () { var o = {}; rows.forEach(function (r) { o[r.path] = r; }); return o; })(),
    gateByParam: gateByParam,
    raw: P
  };
}

function deriveAuthority(data, ctx) {
  var kinds = O(data.kinds);
  var V = O(data.verification);
  var counts = O(data.counts);
  var mult = ctx.desk.multPredominant;

  return {
    rows: [
      { key: 'inputs', label: 'INPUTS', badge: 'DATA', metrics: {
          signals: ctx.signal.n, ticks: num(counts.ticks), marks: num(kinds.marks),
          quality: ctx.signal.dqCensus, quarantined: num(data.marks_quarantined) } },
      { key: 'regime', label: 'REGIME', badge: 'LLM', llm: true, metrics: {
          meetings: ctx.desk.n, dark: ctx.desk.dark, vetoes: ctx.desk.vetoes,
          disagreements: ctx.desk.disagreements, agreementRate: ctx.desk.agreementRate } },
      { key: 'strategy', label: 'STRATEGY', badge: 'CODE', metrics: {
          candidates: ctx.gates.n, kinds: ctx.gates.kindCensus,
          noCandidate: num(ctx.refusals.byKindMap.no_candidate) } },
      { key: 'sizing', label: 'SIZING', badge: 'CODE', metrics: {
          multipliers: ctx.desk.census.mult,
          predominant: mult, meetings: ctx.desk.n } },
      { key: 'gates', label: 'GATES', badge: 'CODE', metrics: {
          evaluations: ctx.gates.n, functions: ctx.gates.functionsDefined,
          refusals: ctx.refusals.gated, everBound: ctx.gates.everBound.length } },
      { key: 'critic', label: 'CRITIC', badge: 'LLM', llm: true, metrics: {
          severity: ctx.desk.census.severity, vetoes: ctx.desk.vetoes,
          roleCalls: ctx.desk.roleCalls, roleFailures: ctx.desk.roleFailures } },
      { key: 'execution', label: 'EXECUTION', badge: 'CODE', metrics: {
          ordersLive: num(counts.orders_live), repricings: A(O(data.series).reprice).length,
          rejections: null, rejectionsMissing: 'no journal kind records a submit rejection',
          fills: ctx.structures.open.length + ctx.structures.closed.length,
          unfilled: ctx.structures.unfilled.length } },
      { key: 'record', label: 'RECORD', badge: 'CODE', metrics: {
          entries: num(V.journal_entries), chainOk: V.chain_ok === true,
          chainMsg: str(V.chain_msg), integrity: ctx.integrity.n,
          exceptions: ctx.integrity.fail } }
    ],
    llmRows: ['regime', 'critic'],
    llmConstraints: {
      canCompute: false, canLoosenGate: false, canSize: false,
      journalled: true,
      note: 'the roles argue and veto; they never compute a price, never loosen a gate, and every fallback is journalled'
    }
  };
}

function deriveCaveats(data, ctx) {
  var nogates = ctx.books.byKey.shadow_nogates;
  var ab = ctx.books.ablation.vs;
  return {
    ablationUpperBound: {
      nogatesFinal: nogates && nogates.final ? nogates.final.v : null,
      nogatesRealized: nogates && nogates.final ? nogates.final.r : null,
      realRealized: ctx.books.byKey.real && ctx.books.byKey.real.final ? ctx.books.byKey.real.final.r : null,
      deltaNogates: ab.shadow_nogates ? ab.shadow_nogates.final : null,
      deltaNohedge: ab.shadow_nohedge ? ab.shadow_nohedge.final : null,
      deltaNaive: ab.baseline_naive ? ab.baseline_naive.final : null,
      sharesEntries: true
    },
    sampleSize: {
      closedTrades: ctx.trades.n, sessions: ctx.days.n,
      rollingStatisticsDrawn: false
    },
    fills: {
      paper: true, gap: ctx.recon.gap, envelope: ctx.recon.envelope,
      perLegCents: ctx.recon.perLegCents, legs: ctx.recon.legs
    },
    universe: {
      authorised: A(O(O(data.params).universe).underlyings).length,
      covered: ctx.tree.universeCovered,
      neverTaken: ctx.tree.universe.filter(function (u) { return u.neverTaken; })
        .map(function (u) { return { sym: u.sym, tried: u.rotations.tried }; })
    },
    quality: {
      quarantined: num(data.marks_quarantined),
      quarantineRows: ctx.overlays.quarantineN,
      marksTotal: (num(O(data.kinds).marks) || 0),
      signalDq: ctx.signal.dqCensus
    },
    desk: { meetings: ctx.desk.n, dark: ctx.desk.dark },
    structures: {
      open: ctx.structures.open.length, closed: ctx.structures.closed.length,
      unfilled: ctx.structures.unfilled.length, total: ctx.structures.n,
      reconciles: ctx.structures.reconciles
    }
  };
}

/* ==========================================================================
   15 · STATUS, LIVENESS, KPIs
   ========================================================================== */

function marketOpenAt(v) {
  var d = new Date(v), dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  var m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= WIN_OPEN && m < WIN_CLOSE;
}
function nextOpenFrom(v) {
  var d = new Date(v), i;
  for (i = 0; i < 8; i++) {
    var day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i));
    var dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    var open = day.getTime() + WIN_OPEN * 60000;
    if (open > v) return open;
  }
  return null;
}

function liveness(D, now) {
  now = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
  var lt = D.meta.lastTickMs;
  var ageMs = (lt != null) ? now - lt : null;
  var open = marketOpenAt(now);
  var nextTick = (lt != null) ? lt + CADENCE_MIN * 60000 : null;
  var nextOpen = open ? null : nextOpenFrom(now);
  return {
    now: now,
    marketOpen: open,
    marketState: open ? 'OPEN' : 'CLOSED',
    ageMs: ageMs,
    ageMin: ageMs == null ? null : Math.floor(ageMs / 60000),
    nextTickMs: nextTick,
    nextTickInMin: (nextTick != null) ? Math.round((nextTick - now) / 60000) : null,
    nextOpenMs: nextOpen,
    nextOpenInMin: nextOpen == null ? null : Math.round((nextOpen - now) / 60000),
    stale: !!(open && ageMs != null && ageMs > STALE_MIN * 60000),
    staleAfterMin: STALE_MIN,
    cadenceMin: CADENCE_MIN,
    generatedAgeMin: D.meta.generatedMs == null ? null : Math.floor((now - D.meta.generatedMs) / 60000)
  };
}

function deriveStatus(data, ctx) {
  var lt = str(data.last_tick_utc);
  var ltMs = ms(lt);
  var d = isFinite(ltMs) ? new Date(ltMs) : null;
  var V = O(data.verification);

  return {
    lastTick: {
      t: lt, ms: isFinite(ltMs) ? ltMs : null, day: dayOf(ltMs),
      dow: d ? d.getUTCDay() : null,
      dowName: d ? DOW[d.getUTCDay()] : null,
      monName: d ? MON[d.getUTCMonth()] : null,
      dayNum: d ? d.getUTCDate() : null,
      hm: d ? hm(ltMs) : null,
      openAtTick: d ? marketOpenAt(ltMs) : null
    },
    tickMode: str(O(data.kv).last_tick_mode),
    tickModeAt: str(O(data.kv).last_tick_ts),
    deriskUntil: str(O(data.kv).derisk_until),
    ticks: num(O(data.counts).ticks),
    spineTicks: ctx.spine.n,
    integrity: {
      n: ctx.integrity.n, ok: ctx.integrity.ok, fail: ctx.integrity.fail,
      allClear: ctx.integrity.allClear, failures: ctx.integrity.failures
    },
    chain: { ok: V.chain_ok === true, msg: str(V.chain_msg), entries: num(V.journal_entries) },
    verifyCommand: 'python -m thetadesk.main verify-journal',
    window: { openMin: WIN_OPEN, closeMin: WIN_CLOSE, days: 'Mon-Fri', cadenceMin: CADENCE_MIN,
              text: '13:30-20:00 UTC Mon-Fri, every ' + CADENCE_MIN + ' min' }
  };
}

function deriveKpi(data, ctx) {
  var b = O(data.book), counts = O(data.counts), V = O(data.verification);
  var real = ctx.books.byKey.real;
  function spark(field) {
    return real ? lineOf(real.pts, field, ctx.spine.n) : [];
  }
  return {
    cells: [
      { key: 'book', label: 'BOOK P&L', value: num(b.pnl), fmt: 'usd',
        spark: spark('v'), src: 'book.pnl' },
      { key: 'realized', label: 'REALIZED', value: num(b.realized), fmt: 'usd',
        spark: spark('r'), src: 'book.realized' },
      { key: 'unrealized', label: 'UNREALIZED', value: num(b.unrealized), fmt: 'usd',
        spark: spark('u'), src: 'book.unrealized' },
      { key: 'refused', label: 'REFUSED', value: num(O(data.refusals).total), fmt: 'int',
        spark: null, src: 'refusals.total', tab: 'refusals' },
      { key: 'structures', label: 'STRUCTURES', value: ctx.structures.n, fmt: 'int',
        spark: null, src: 'positions.*',
        parts: { open: ctx.structures.open.length, closed: ctx.structures.closed.length,
                 unfilled: ctx.structures.unfilled.length }, tab: 'positions' },
      { key: 'journal', label: 'JOURNAL', value: num(V.journal_entries), fmt: 'int',
        spark: null, src: 'verification.journal_entries', tab: 'all' }
    ],
    book: {
      pnl: num(b.pnl), pnlPct: num(b.pnl_pct), realized: num(b.realized),
      unrealized: num(b.unrealized), start: num(b.start),
      brokerEquity: num(O(data.broker).equity), markedAt: str(b.marked_at)
    },
    session: {
      ticks: num(counts.ticks), gateEvals: ctx.gates.n,
      ordersLive: num(counts.orders_live), refused: num(O(data.refusals).total),
      meetings: ctx.desk.n, signals: ctx.signal.n
    },
    cycle: (function () {
      var e = ctx.gates.evals;
      if (!e.length) return null;
      var lastT = e[e.length - 1].t;
      var grp = e.filter(function (x) { return x.t === lastT; });
      return {
        t: lastT, i: grp[0].i,
        candidates: grp.length,
        gated: grp.filter(function (x) { return !x.passed; }).length,
        entered: grp.filter(function (x) { return x.passed; }).length
      };
    })(),
    quality: {
      mode: 'all',
      excluded: num(data.marks_quarantined),
      cleanSignals: ctx.signal.cleanN, totalSignals: ctx.signal.n
    }
  };
}

/* ==========================================================================
   16 · THE MISSING REGISTRY — every null, with the path that would fix it
   ========================================================================== */

function deriveMissing(data, ctx) {
  var out = [];
  function add(key, path, why, panels, fix) {
    out.push({ key: key, path: path, why: why, panels: panels || [], fix: fix || 'tools/site_data.py' });
  }

  if (!ctx.gates.operandsPublished) {
    add('gate_operands', 'series.gates[].d',
        'null on all ' + ctx.gates.n + ' evaluations — the operands were added to the journal after these rows were written',
        ['c2', 'c1', 'd5'], 'src/thetadesk/engine/gates.py GateReport.to_dict + tools/site_data.py _series');
  }
  ctx.tree.universe.forEach(function (u) {
    if (!u.covered) {
      add('signal_' + u.sym, 'series.signal[] with sym=' + u.sym,
          'the signal series carries ' + ctx.signal.n + ' rows and every one is ' +
          Object.keys(ctx.signal.symCensus).join('/') + '; no volatility metric exists for ' + u.sym,
          ['a2', 'a1']);
    }
  });
  if (!ctx.tree.universe.some(function (u) { return u.reasonPublished; })) {
    add('alt_reason', 'series.alt[].reason',
        'empty string on all ' + A(O(data.series).alt).length + ' rows, so the per-underlying refusal reason cannot be named',
        ['a2']);
  }
  if (ctx.signal.ivRank == null) {
    add('iv_rank', 'iv percentile', ctx.signal.ivRankReason, ['a1'], 'not computable: no historical IV is served');
  }
  add('per_structure_marks', 'series.manage[sid][].p',
      ctx.paths.perStructureMarksReason, ['d4'], 'not computable from the journal as written');
  if (ctx.blotter.coverage.truncated) {
    add('decisions_window', 'decisions[]',
        ctx.blotter.coverage.note + '; the window starts ' + ctx.blotter.coverage.from,
        ['c4'], 'tools/site_data.py row cap');
  }
  if (!ctx.risk.bars.some(function (b) { return b.used != null; })) {
    add('risk_used', 'series.gates[].d',
        'no bar can print a used side; the limits are published but the operands are not',
        ['c2']);
  }
  if (ctx.risk.sleeveLabelsSeen.cheap == null) {
    add('cheap_sleeve_used', "positions[].sleeve = 'cheap'",
        'positions carry the sleeve labels ' + Object.keys(ctx.risk.sleeveLabelsSeen).join('/') +
        ', so no position can be attributed to the cheap sleeve',
        ['c2']);
  }
  var lastDaily = ctx.days.dailyRows.length ? ctx.days.dailyRows[ctx.days.dailyRows.length - 1] : null;
  if (lastDaily && lastDaily.partial) {
    add('daily_partial', 'series.daily[last]',
        'the row for ' + lastDaily.day + ' publishes only the keys it has; entries and new_risk are absent',
        ['c2', 'a2']);
  }
  if (ctx.days.orphanCounters.length) {
    add('daily_orphan', 'series.daily[].day',
        ctx.days.orphanCounters.map(function (o) { return o.day; }).join(', ') +
        ' carries counters but no journal row shares that UTC date (exchange-day keying)',
        ['a2']);
  }
  if (!ctx.books.shadowsCarryGreeks) {
    add('shadow_greeks', 'series.books.<shadow>[].{d,th,vg}',
        'stored as exactly 0.0 on all ' + ctx.greeks.shadowRowCount + ' shadow rows, so a four-book greeks chart would be four flat lines',
        ['b4'], 'not a defect: the shadow books do not compute greeks');
  }
  if (!ctx.books.shadowsCarryEquity) {
    add('shadow_equity', 'series.books.<shadow>[].eq',
        'null on every shadow row; only the real book carries broker equity',
        ['b2', 'd1']);
  }
  var sc = ctx.gates.worstCase.scenarios;
  if (Object.keys(sc).length === 1) {
    add('wc_scenarios', 'series.gates[].wc.scenario',
        "'" + Object.keys(sc)[0] + "' on all " + ctx.gates.worstCase.n +
        ' evaluations — the vol-shock branch never bound, so it is a scalar not a series',
        ['c2', 'd5'], 'not a defect');
  }
  add('tick_mode', 'series.ticks[].mode',
      'per-tick mode is not published; only kv.last_tick_mode (' +
      (str(O(data.kv).last_tick_mode) || 'null') + ') and the market_closed / data_suspect / tick_crash journal kinds',
      ['p00', 'b5']);
  add('order_rejections', 'a journal kind for a submit rejection',
      'nothing in the 34-kind census records an order rejected at submit, so the count can only be asserted, not derived',
      ['a3']);

  return out;
}

/* ==========================================================================
   17 · ASSEMBLY
   ========================================================================== */

function build(data) {
  data = O(data);
  var spine = buildSpine(data);

  var books = deriveBooks(data, spine);
  var signal = deriveSignal(data, spine);
  var greeks = deriveGreeks(books, data, spine);
  var desk = deriveDesk(data, spine);
  var gates = deriveGates(data, spine);
  var refusals = deriveRefusals(data, spine, gates);
  var structures = deriveStructures(data, spine);
  var trades = deriveTrades(data, structures, spine);
  var paths = derivePaths(data, spine, structures);
  var strikes = deriveStrikes(data, structures, signal);
  var recon = deriveRecon(data, books, spine);
  var integrity = deriveIntegrity(data, spine);
  var risk = deriveRisk(data, gates, structures);

  var ctx = {
    spine: spine, books: books, signal: signal, greeks: greeks, desk: desk,
    gates: gates, refusals: refusals, structures: structures, trades: trades,
    paths: paths, strikes: strikes, recon: recon, integrity: integrity, risk: risk
  };

  ctx.days = deriveDays(data, spine, ctx);
  ctx.tree = deriveTree(data, ctx);
  ctx.blotter = deriveBlotter(data, spine, ctx);
  ctx.overlays = deriveOverlays(data, spine, ctx);
  ctx.claims = deriveClaims(data, ctx);
  ctx.params = deriveParams(data, ctx);
  ctx.authority = deriveAuthority(data, ctx);

  var kinds = O(data.kinds);
  ctx.denominators = {
    spineTicks: spine.n,
    tickStart: A(O(data.series).ticks).length,
    ticksReported: num(O(data.counts).ticks),
    signals: signal.n,
    marksJournal: num(kinds.marks),
    marksReal: books.byKey.real ? books.byKey.real.n : 0,
    meetings: desk.n,
    gateEvaluations: gates.n,
    refusalRows: refusals.n,
    integrity: integrity.n,
    decisions: A(data.decisions).length,
    journalEntries: num(O(data.verification).journal_entries),
    note: 'these are different denominators and are not interchangeable'
  };

  /* B3's own object: the thesis chart's two panes, its rules, its event lane
     and every number its mandatory readout line prints. */
  var lastSig = signal.last;
  ctx.premium = {
    rows: signal.rows,
    lines: signal.all,
    clean: signal.clean,
    band: signal.all.band,
    thresholds: signal.thresholds,
    last: lastSig,
    readout: lastSig ? {
      iv: lastSig.iv, rv: lastSig.rv, spread: lastSig.pts, ratio: lastSig.ratio, vrp: lastSig.vrp
    } : null,
    range: {
      iv: stats(signal.rows.map(function (p) { return p.iv; })),
      rv: stats(signal.rows.map(function (p) { return p.rv; })),
      vrp: stats(signal.rows.map(function (p) { return p.vrp; })),
      pts: stats(signal.rows.map(function (p) { return p.pts; })),
      ratio: stats(signal.rows.map(function (p) { return p.ratio; }))
    },
    events: {
      refusals: refusals.rows.map(function (r) {
        return { i: r.i, t: r.t, kind: r.kind, gate: r.gate, reason: r.reason, k: r.k };
      }),
      gated: refusals.rows.filter(function (r) { return r.kind === 'entry_refused'; })
        .map(function (r) { return { i: r.i, t: r.t, gate: r.gate, reason: r.reason, k: r.k }; }),
      gatedN: refusals.rows.filter(function (r) { return r.kind === 'entry_refused'; }).length,
      entries: ctx.overlays.entries.filter(function (e) { return e.dir === 'open'; }),
      entriesN: ctx.overlays.entries.filter(function (e) { return e.dir === 'open'; }).length,
      entriesSrc: 'positions[].opened',
      orderOpenJournal: num(O(data.kinds).order_open),
      entriesNote: 'positions carry every structure that was ever opened; the journal counts ' +
        (num(O(data.kinds).order_open) || 0) + ' order_open rows, which include resubmissions'
    },
    obs: signal.n,
    sessions: signal.sessionCount,
    first: signal.first,
    lastT: signal.lastT,
    /* the forbidden things, stated so a renderer cannot reach for them */
    coneDrawn: false,
    coneReason: signal.ivRankReason
  };

  ctx.funnel = deriveFunnel(data, ctx);
  ctx.caveats = deriveCaveats(data, ctx);
  ctx.status = deriveStatus(data, ctx);
  ctx.kpi = deriveKpi(data, ctx);

  /* per-tick join: every series that belongs to this tick, nothing filled in */
  var deriskB = bindRows(O(data.series).derisk, spine);
  var ticksB = bindRows(O(data.series).ticks, spine);
  var decB = bindRows(data.decisions, spine);
  var manageByTick = new Array(spine.n);
  Object.keys(O(O(data.series).manage)).forEach(function (sid) {
    A(O(data.series).manage[sid]).forEach(function (r) {
      var i = spine.bind(r.t);
      if (i < 0) return;
      (manageByTick[i] || (manageByTick[i] = [])).push({
        sid: sid, t: r.t, a: str(r.a), w: str(r.w) || '', p: num(r.p)
      });
    });
  });
  var altB = bindRows(O(data.series).alt, spine);
  var qB = bindRows(O(data.series).quarantine, spine);
  var bcB = bindRows(O(data.series).brokercheck, spine);
  var rpB = bindRows(O(data.series).reprice, spine);
  var refB = bindRows(refusals.rows, spine);
  var deskByTick = desk.byTick;
  var sigByTick = signal.byTick;

  var byTick = spine.ticks.map(function (tk, i) {
    var bookRow = {};
    books.order.forEach(function (k) { bookRow[k] = books.byKey[k].idxByTick[i]; });
    return {
      i: i, t: tk.t, ms: tk.ms, day: tk.day, dayIdx: tk.dayIdx,
      first: tk.first, last: tk.last, span: tk.span, stamps: tk.n,
      signal: sigByTick[i] || null,
      books: bookRow,
      greeks: bookRow.real ? { d: bookRow.real.d, th: bookRow.real.th, vg: bookRow.real.vg } : null,
      desk: deskByTick[i] || null,
      gates: gates.byTick[i] || [],
      refusals: refB.byTick[i] || [],
      integrity: (function () {
        var c = integrity.cells.filter(function (x) { return x.i === i; });
        return c.length ? c[c.length - 1] : null;
      })(),
      derisk: deriskB.byTick[i] ? deriskB.byTick[i][deriskB.byTick[i].length - 1] : null,
      tick: ticksB.byTick[i] ? ticksB.byTick[i][ticksB.byTick[i].length - 1] : null,
      manage: manageByTick[i] || [],
      decisions: decB.byTick[i] || [],
      alt: altB.byTick[i] || [],
      quarantine: qB.byTick[i] || [],
      brokerCheck: bcB.byTick[i] || [],
      reprice: rpB.byTick[i] || [],
      entries: ctx.overlays.entries.filter(function (e) { return e.i === i; })
    };
  });

  var D = {
    raw: data,
    version: 1,

    meta: {
      generatedUtc: str(data.generated_utc), generatedMs: (function () { var v = ms(data.generated_utc); return isFinite(v) ? v : null; })(),
      commit: str(data.commit), account: str(data.account),
      lastTickUtc: str(data.last_tick_utc), lastTickMs: (function () { var v = ms(data.last_tick_utc); return isFinite(v) ? v : null; })(),
      markedAt: str(O(data.book).marked_at), markedMs: (function () { var v = ms(O(data.book).marked_at); return isFinite(v) ? v : null; })(),
      first: spine.n ? spine.ticks[0].t : null,
      last: spine.n ? spine.ticks[spine.n - 1].t : null,
      sessions: spine.days.map(function (d) { return d.day; }),
      sessionCount: spine.days.length
    },

    spine: spine,
    index: spine,
    byTick: byTick,

    status: ctx.status,
    liveness: function (now) { return liveness(D, now); },
    kpi: ctx.kpi,
    funnels: {
      cycle: ctx.kpi.cycle,
      session: ctx.kpi.session,
      book: ctx.kpi.book
    },

    signal: signal,
    premium: ctx.premium,
    greeks: greeks,
    books: books,
    ablation: books.ablation,
    desk: desk,
    gates: gates,
    refusals: refusals,
    risk: risk,
    structures: structures,
    trades: trades,
    paths: paths,
    strikes: strikes,
    recon: recon,
    integrity: integrity,
    verification: O(data.verification),
    claims: ctx.claims,
    days: ctx.days,
    tree: ctx.tree,
    blotter: ctx.blotter,
    overlays: ctx.overlays,
    funnel: ctx.funnel,
    params: ctx.params,
    authority: ctx.authority,
    caveats: ctx.caveats,
    denominators: ctx.denominators,
    limits: O(data.limits),
    kinds: O(data.kinds),
    quality: {
      excluded: num(data.marks_quarantined),
      quarantine: ctx.overlays.quarantine,
      signalDq: signal.dqCensus,
      cleanSignals: signal.cleanN,
      totalSignals: signal.n,
      suspect: signal.suspect,
      suspectRule: signal.suspectRule
    },
    missing: null
  };

  D.missing = deriveMissing(data, ctx);
  D.missingByKey = (function () { var o = {}; D.missing.forEach(function (m) { o[m.key] = m; }); return o; })();
  D.missingByPanel = (function () {
    var o = {};
    D.missing.forEach(function (m) { m.panels.forEach(function (p) { (o[p] || (o[p] = [])).push(m); }); });
    return o;
  })();

  return D;
}

/* ==========================================================================
   18 · MEMOISATION AND EXPORT
   ========================================================================== */

var memoKey = null, memoVal = null;
var memoMap = (typeof WeakMap === 'function') ? new WeakMap() : null;

function derive(data) {
  if (data == null) return build({});
  if (memoMap) {
    if (memoMap.has(data)) return memoMap.get(data);
    var d = build(data);
    memoMap.set(data, d);
    return d;
  }
  if (memoKey === data) return memoVal;
  memoKey = data;
  memoVal = build(data);
  return memoVal;
}

function summary(D) {
  return {
    ticks: D.spine.n, days: D.spine.days.length,
    uniqueStamps: D.spine.uniqueStamps, maxSpanS: D.spine.maxSpanS,
    books: D.books.order.map(function (k) {
      return k + ' ' + D.books.byKey[k].n + ' final ' + (D.books.byKey[k].final ? D.books.byKey[k].final.v : '-');
    }),
    ablation: Object.keys(D.ablation.vs).map(function (k) { return k + ' ' + D.ablation.vs[k].final; }),
    signals: D.signal.n, meetings: D.desk.n, gateEvals: D.gates.n,
    refusals: D.refusals.n, structures: D.structures.n, trades: D.trades.n,
    blotter: D.blotter.counts, missing: D.missing.length
  };
}

root.TDD = {
  version: 1,
  derive: derive,
  summary: summary,
  /* pure helpers a panel may need after it has filtered rows */
  collapseRuns: collapseRuns,
  viewStats: viewStats,
  perDay: perDay,
  liveness: liveness,
  stats: stats,
  buckets: buckets,
  census: census,
  censusRows: censusRows,
  ms: ms,
  dayOf: dayOf,
  occ: occ,
  sevOf: sevOf,
  KIND_LABEL: KIND_LABEL,
  BOOK_ORDER: BOOK_ORDER,
  BOOK_LABEL: BOOK_LABEL,
  GAP_MS: GAP_MS
};

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
