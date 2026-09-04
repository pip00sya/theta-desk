/* ============================================================================
   VIEWS — the switcher for the four screens views.css lays out.

   Deliberately self-contained: it owns one attribute on <html>, builds one bar,
   and asks app.js to render again after the layout changes. It does not touch
   TD.S, so nothing it does can desynchronise the cursor, the selection or the
   filters — switching view leaves all of them exactly as they were.
   ========================================================================== */
(function () {
  'use strict';

  var VIEWS = [
    { id: 'overview', label: 'Overview', sub: 'what happened' },
    { id: 'signal',   label: 'Signal',   sub: 'why we traded' },
    { id: 'risk',     label: 'Risk',     sub: 'what we refused' },
    { id: 'book',     label: 'Book',     sub: 'every decision' }
  ];
  var KEY = 'td.view';
  var root = document.documentElement;

  function current() {
    var h = /[#&]v=([a-z]+)/.exec(location.hash || '');
    if (h && VIEWS.some(function (v) { return v.id === h[1]; })) return h[1];
    try {
      var s = localStorage.getItem(KEY);
      if (s && VIEWS.some(function (v) { return v.id === s; })) return s;
    } catch (e) { /* private mode */ }
    return 'overview';
  }

  function apply(id, remember) {
    root.setAttribute('data-view', id);
    Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-selected', String(b.dataset.view === id));
    });
    if (remember) { try { localStorage.setItem(KEY, id); } catch (e) {} }
    // charts measure their container, and a container that was display:none has
    // no width — so the panels now on screen have to be drawn again
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (window.TD && TD.render) { try { TD.render(); } catch (e) {} }
        window.dispatchEvent(new Event('resize'));
      });
    });
  }

  var bar = document.createElement('div');
  bar.className = 'viewbar';
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'View');
  VIEWS.forEach(function (v) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.view = v.id;
    b.innerHTML = '';
    b.appendChild(document.createTextNode(v.label));
    var s = document.createElement('span');
    s.className = 'vb-sub';
    s.textContent = v.sub;
    b.appendChild(s);
    b.addEventListener('click', function () { apply(v.id, true); });
    bar.appendChild(b);
  });
  var spacer = document.createElement('span');
  spacer.className = 'vb-spacer';
  bar.appendChild(spacer);
  var note = document.createElement('span');
  note.className = 'vb-note';
  note.textContent = '1 – 4 to switch · ? for keys';
  bar.appendChild(note);

  function mount() {
    var cmd = document.getElementById('p-command');
    if (!cmd) return;
    cmd.insertBefore(bar, cmd.firstChild);
    apply(current(), false);
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    var i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i < 0) return;
    e.preventDefault();
    apply(VIEWS[i].id, true);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
