/* Interaction test for panels-ab.js.  Loaded by _panels_ab_probe.html only. */
window.__runTest = async function () {
  var R = [];
  function log(k, v) { R.push(k + ': ' + v); }
  function q(sel) { return document.querySelector(sel); }
  function click(sel) { var e = q(sel); if (!e) { log('MISSING', sel); return null; } e.click(); return e; }
  function wait() { return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(r, 70); }); }); }); }
  function n(sel) { return document.querySelectorAll(sel).length; }
  var S = window.TD.S;

  /* B2 modes */
  click('#p-equity .pc .seg button[data-v="four"]'); await wait();
  log('b2 four', S.b2mode + ' lines=' + n('#p-equity svg .mk-line'));
  click('#p-equity .pc .seg button[data-v="underwater"]'); await wait();
  log('b2 uw', S.b2mode + ' | ' + q('#p-equity .pr').textContent);
  click('#p-equity .pc .seg button[data-v="ru"]'); await wait();
  log('b2 ru', S.b2mode + ' | ' + q('#p-equity .pr').textContent);
  click('#p-equity .pc .seg button[data-v="split"]'); await wait();
  log('b2 split', S.b2mode + ' areas=' + n('#p-equity svg .mk-area'));

  /* legend */
  click('#p-equity .pb .legend .lg[data-key="shadow_nogates"]'); await wait();
  log('legend off', JSON.stringify(S.books) + ' areas=' + n('#p-equity svg .mk-area'));
  click('#p-equity .pb .legend .lg[data-key="shadow_nogates"]'); await wait();
  log('legend on', JSON.stringify(S.books) + ' areas=' + n('#p-equity svg .mk-area'));

  /* overlays */
  click('#p-equity .pb [data-chip="broker"]'); await wait();
  log('ov broker', JSON.stringify(S.b2ov) + ' lines=' + n('#p-equity svg .mk-line'));
  click('#p-equity .pb [data-chip="derisk"]'); await wait();
  log('ov derisk off', 'derisk rects=' + n('#p-equity svg [data-key="derisk"]'));
  click('#p-equity .pb [data-chip="derisk"]'); await wait();

  /* quality */
  click('#ctl-quality button[data-v="clean"]'); await wait();
  log('quality clean', S.quality + ' thesis lines=' + n('#p-thesis svg .mk-line') +
      ' filters=' + (q('#ctl-filters').hidden ? 'hidden' : q('#ctl-filters [data-n]').textContent));
  click('#ctl-quality button[data-v="all"]'); await wait();

  /* judge */
  click('#ctl-judge'); await wait();
  var jn = [].filter.call(document.querySelectorAll('.jn'), function (e) { return e.offsetHeight > 0; });
  log('judge', S.judge + ' notes visible=' + jn.length);
  click('#ctl-judge'); await wait();

  /* A1 tile -> B3 emphasis */
  click('#p-signal [data-tile="rv"]'); await wait();
  log('a1 sel', JSON.stringify(S.sel) + ' dimmed=' + n('#p-thesis svg [data-dim="1"]'));
  click('#p-signal [data-tile="rv"]'); await wait();

  /* A1 unit switch */
  click('#p-signal .pc .seg button[data-v="ratio"]'); await wait();
  log('a1 unit', S.a1unit + ' vrp tile=' + q('#p-signal [data-tile="vrp"] .v').textContent);
  click('#p-signal .pc .seg button[data-v="score"]'); await wait();

  /* A2 tree: gate row, day row, filter */
  var rows = document.querySelectorAll('#p-tree [data-g="gates"] .trow');
  if (rows.length) { rows[3].click(); await wait(); }
  log('tree gate', JSON.stringify(S.sel) + ' gate=' + S.gate + ' filters=' +
      (q('#ctl-filters').hidden ? 'hidden' : q('#ctl-filters [data-n]').textContent));
  var days = document.querySelectorAll('#p-tree [data-g="days"] .trow');
  if (days.length) { days[days.length - 1].click(); await wait(); }
  log('tree day', JSON.stringify(S.sel) + ' range=' + JSON.stringify(S.range));
  var inp = q('#p-tree .pc input.inp');
  inp.focus(); inp.value = 'condor';
  inp.dispatchEvent(new Event('input', { bubbles: true })); await wait();
  log('tree filter', 'q="' + S.treeq + '" rows=' + n('#p-tree .trow') +
      ' focus=' + (document.activeElement === q('#p-tree .pc input.inp')) +
      ' value=' + q('#p-tree .pc input.inp').value);
  inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true })); await wait();
  window.TD.set({ range: '3d', sel: null, gate: null });
  await wait();

  /* A2 group collapse */
  click('#p-tree [data-g="days"] .th'); await wait();
  log('tree collapse', q('#p-tree [data-g="days"]').getAttribute('aria-expanded') +
      ' visible day rows=' + [].filter.call(document.querySelectorAll('#p-tree [data-g="days"] .trow'), function (e) { return e.offsetHeight > 0; }).length);
  click('#p-tree [data-g="days"] .th'); await wait();

  /* A3 stage */
  click('#p-authority [data-stage="gates"]'); await wait();
  log('a3', JSON.stringify(S.sel) + ' kind=' + S.kind + ' tab=' + S.tab);
  window.TD.set({ sel: null, kind: null }); await wait();

  /* A4 weakness row 1 */
  var w1 = document.querySelectorAll('#p-weakness .row')[0];
  if (w1) { w1.click(); await wait(); }
  log('a4', 'base=' + S.base + ' b2mode=' + S.b2mode);

  /* B1 baseline + delta cell */
  click('#p-ledger .pc .seg button[data-v="naive"]'); await wait();
  log('b1 base', S.base + ' selrow=' + n('#p-ledger tr[data-sel="1"]'));
  var dcell = document.querySelectorAll('#p-ledger tbody tr')[1].cells[3];
  dcell.click(); await wait();
  log('b1 delta', 'base=' + S.base + ' cur=' + S.cur + ' locked=' + S.locked +
      ' curlines=' + n('#p-equity svg .cur-lock'));

  /* B4 unit + expand */
  click('#p-greeks .pc .seg button[data-v="per1k"]'); await wait();
  log('b4 unit', S.b4unit + ' delta=' + q('#p-greeks [data-greek="delta"] .num').textContent);
  click('#p-greeks .pc .seg button[data-v="usd"]'); await wait();
  click('#p-greeks [data-greek="theta"]'); await wait();
  log('b4 expand', S.b4expand + ' svg=' + n('#p-greeks .chart svg') + ' rowsHidden=' + q('#p-greeks .lanes').hidden);
  click('#p-greeks .pc [data-chip="collapse"]'); await wait();
  log('b4 collapse', S.b4expand + ' rows=' + n('#p-greeks .row'));

  /* B5 filters + lane toggle */
  click('#p-ribbon .pc [data-chip="veto"]'); await wait();
  log('b5 veto', S.b5filter + ' dimmed=' + n('#p-ribbon svg [data-dim="1"]'));
  click('#p-ribbon .pc [data-chip="veto"]'); await wait();
  var lab = document.querySelectorAll('#p-ribbon svg .lane-label')[0];
  if (lab) { lab.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(); }
  log('b5 lane', JSON.stringify(S.b5lanes) + ' cells=' + n('#p-ribbon svg .lane-cell'));
  if (lab) { document.querySelectorAll('#p-ribbon svg .lane-label')[4].dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(); }
  window.TD.set({ b5lanes: null }); await wait();

  /* cursor: lock through the bus, as app.js would */
  TDC.cursor.lock(70, 'test'); await wait();
  log('cursor', 'cur=' + S.cur + ' locked=' + S.locked + ' rules=' + n('#body svg .cur-lock'));
  TDC.cursor.unlock(); await wait();

  /* range brush, as B5 would emit it */
  window.TD.set({ range: [40, 60] }); await wait();
  log('brush', JSON.stringify(S.range) + ' equity pts=' +
      (q('#p-equity svg .mk-line path') ? q('#p-equity svg .mk-line path').getAttribute('d').split('L').length : 0));
  window.TD.set({ range: '3d' }); await wait();

  /* idempotence: 25 renders leave one svg per host */
  for (var i = 0; i < 25; i++) window.TD.set({}), await wait();
  log('idempotent', 'svgs=' + n('#body svg.tdc') + ' tiles=' + n('#p-signal .tile') +
      ' greekRows=' + n('#p-greeks .row') + ' arows=' + n('#p-authority .arow') +
      ' weakness=' + n('#p-weakness .row') + ' ledgerRows=' + n('#p-ledger tbody tr') +
      ' kpis=' + n('#cmd-kpis .kpi') + ' zones=' + n('#status .zone') + ' fsegs=' + n('#foot .fseg'));

  log('errors', JSON.stringify(window.__probeLog));
  return R;
};
