// Folder compare view: two labelled panels (Left and Right, with their full paths), a virtual list that stays
// fast with 100,000+ rows, filters, selection and the toolbar. All data comes from the extension by postMessage.
(function () {
  const vscode = acquireVsCodeApi();
  const ROW_H = 22;
  const app = document.getElementById('app');

  const S = {
    left: null, right: null, git: false, mode: 'content', pro: [],
    rows: [], paths: [], counts: null, info: null,
    showSame: false, statusFilter: null, nameFilter: '',
    collapsed: new Set(), visible: [], sel: new Set(), anchor: -1, focus: -1,
    phase: 'idle', progress: null, doneMs: 0, fatal: '', saved: vscode.getState() || {},
  };
  const LABEL = { same: 'Same', changed: 'Changed', pending: 'Checking', left: 'Only left', right: 'Only right', error: 'Error' };
  const GLYPH = { same: '=', changed: '≠', pending: '…', left: '◀', right: '▶', error: '!' };

  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    for (const c of kids) if (c !== null && c !== undefined) n.append(c);
    return n;
  };
  const fmtNum = n => Number(n || 0).toLocaleString('en-US');
  function fmtSize(n) {
    if (n == null || n < 0) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms), p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- layout ----------
  const sideBox = which => {
    const label = el('span', { class: 'tag' });
    const pathEl = el('span', { class: 'path' });
    const change = el('button', { class: 'link', title: `Pick another ${which} folder`, onclick: () => vscode.postMessage({ type: which === 'left' ? 'changeLeft' : 'changeRight' }) }, 'Change');
    const box = el('div', { class: 'side ' + which }, label, pathEl, change);
    return { box, label, pathEl, change };
  };
  const L = sideBox('left'), R = sideBox('right');
  const swap = el('button', { class: 'icon swap', title: 'Swap left and right', 'aria-label': 'Swap left and right', onclick: () => vscode.postMessage({ type: 'swap' }) }, '⇄');
  const chips = el('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filter by status' });
  const showSameBox = el('input', { type: 'checkbox', id: 'showSame' });
  showSameBox.addEventListener('change', () => { S.showSame = showSameBox.checked; save(); rebuild(); });
  const filter = el('input', { type: 'search', class: 'filter', placeholder: 'Filter by name', 'aria-label': 'Filter by name' });
  let ft = 0;
  filter.addEventListener('input', () => { clearTimeout(ft); ft = setTimeout(() => { S.nameFilter = filter.value.trim().toLowerCase(); rebuild(); }, 150); });
  const modeSel = el('select', { title: 'Compare mode', 'aria-label': 'Compare mode' },
    el('option', { value: 'content' }, 'Content (exact)'), el('option', { value: 'quick' }, 'Quick (size and time)'));
  modeSel.addEventListener('change', () => vscode.postMessage({ type: 'mode', mode: modeSel.value }));

  const btn = (text, title, fn, cls) => el('button', { class: 'btn ' + (cls || ''), title, onclick: fn }, text);
  const selection = () => (S.sel.size ? [...S.sel] : S.focus >= 0 ? [S.focus] : []);
  const needSel = (fn) => () => { const s = selection(); if (!s.length) { flash('Select one or more rows first.'); return; } fn(s); };
  const bCopyR = btn('Copy to right ▶', 'Copy the selected files from the left to the right (asks first)', needSel(sel => vscode.postMessage({ type: 'copy', dir: 'toRight', sel })));
  const bCopyL = btn('◀ Copy to left', 'Copy the selected files from the right to the left (asks first)', needSel(sel => vscode.postMessage({ type: 'copy', dir: 'toLeft', sel })));
  const bDel = btn('Delete ▾', 'Delete the selected files on one side (asks first)', ev => menu(ev.currentTarget, [
    ['Delete on the left...', needSel(sel => vscode.postMessage({ type: 'delete', side: 'left', sel })), S.git],
    ['Delete on the right...', needSel(sel => vscode.postMessage({ type: 'delete', side: 'right', sel }))],
  ]));
  const bExport = btn('Export ▾', 'Save the compare result', ev => menu(ev.currentTarget, [
    ['Markdown (.md)', () => vscode.postMessage({ type: 'export', format: 'md', onlyDiff: !S.showSame })],
    ['CSV (.csv)', () => vscode.postMessage({ type: 'export', format: 'csv', onlyDiff: !S.showSame })],
    ['HTML (.html)', () => vscode.postMessage({ type: 'export', format: 'html', onlyDiff: !S.showSame })],
  ]));
  const proMark = name => (S.pro.includes(name) ? ' (Pro)' : '');
  const bMore = btn('More ▾', 'Sync, document report, saved compares, ignore rules', ev => menu(ev.currentTarget, [
    ['Sync folders with a preview...' + proMark('Folder sync'), () => vscode.postMessage({ type: 'sync' })],
    ['Report of document changes' + proMark('Document change report'), () => vscode.postMessage({ type: 'report' })],
    ['Save this compare...' + proMark('Saved compares'), () => vscode.postMessage({ type: 'saveSession' })],
    ['Ignore rules...', () => vscode.postMessage({ type: 'editExclude' })],
    ['Expand all', () => { S.collapsed.clear(); save(); rebuild(); }],
    ['Collapse all', () => { S.rows.forEach((r, i) => { if (r.k === 'dir') S.collapsed.add(S.paths[i]); }); save(); rebuild(); }],
  ]));
  const bRefresh = btn('⟳ Refresh', 'Compare again', () => vscode.postMessage({ type: 'refresh' }));
  const bar = el('div', { class: 'bar' }, chips, el('label', { class: 'check', for: 'showSame' }, showSameBox, ' Show equal files'), filter, modeSel,
    el('span', { class: 'grow' }), bRefresh);
  const actions = el('div', { class: 'bar actions' }, bCopyL, bCopyR, bDel, bExport, bMore);
  const progFill = el('div', { class: 'fill' });
  const progText = el('span', { class: 'ptext', role: 'status', 'aria-live': 'polite' });
  const cancel = btn('Cancel', 'Stop this compare', () => vscode.postMessage({ type: 'cancel' }), 'small');
  const prog = el('div', { class: 'progress' }, el('div', { class: 'track' }, progFill), progText, cancel);
  const colHead = el('div', { class: 'cols' },
    el('div', { class: 'c name' }, 'Name'), el('div', { class: 'c num' }, 'Size'), el('div', { class: 'c time' }, 'Modified'),
    el('div', { class: 'c st' }, ''),
    el('div', { class: 'c name' }, 'Name'), el('div', { class: 'c num' }, 'Size'), el('div', { class: 'c time' }, 'Modified'));
  const spacer = el('div', { class: 'spacer' });
  const rowsBox = el('div', { class: 'rows' });
  spacer.append(rowsBox);
  const list = el('div', { class: 'list', tabindex: '0', role: 'grid', 'aria-label': 'Compare result' }, spacer);
  const empty = el('div', { class: 'empty' });
  const detail = el('div', { class: 'detail' });
  const toast = el('div', { class: 'toast', role: 'status' });
  app.textContent = '';
  app.append(el('div', { class: 'top' }, el('div', { class: 'sides' }, L.box, swap, R.box), bar, actions, prog), colHead, list, empty, detail, toast);

  let toastT = 0;
  function flash(t) { toast.textContent = t; toast.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toast.classList.remove('on'), 2500); }

  let openMenu = null;
  function menu(anchor, items) {
    closeMenu();
    const m = el('div', { class: 'menu', role: 'menu' });
    for (const [label, fn, disabled] of items) {
      m.append(el('button', { role: 'menuitem', disabled: !!disabled, onclick: () => { closeMenu(); fn(); } }, label));
    }
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = r.bottom + 2 + 'px';
    m.style.left = Math.max(4, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
    openMenu = m;
    const first = m.querySelector('button:not([disabled])'); if (first) first.focus();
  }
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener('mousedown', e => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

  function save() { vscode.setState({ showSame: S.showSame, collapsed: [...S.collapsed].slice(0, 5000) }); }

  // ---------- data ----------
  function computePaths() {
    S.paths = new Array(S.rows.length);
    for (let i = 0; i < S.rows.length; i++) { const r = S.rows[i]; S.paths[i] = r.p >= 0 ? S.paths[r.p] + '/' + r.n : r.n; }
  }

  function rebuild() {
    const rows = S.rows, n = rows.length;
    const keep = new Uint8Array(n);
    // Which rows pass the filters on their own; folders pass when any child passes.
    const statusOk = r => (S.statusFilter ? r.s === S.statusFilter : (S.showSame || r.s !== 'same'));
    for (let i = n - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.k !== 'dir') {
        const nameOk = !S.nameFilter || r.n.toLowerCase().includes(S.nameFilter) || S.paths[i].toLowerCase().includes(S.nameFilter);
        if (nameOk && statusOk(r)) keep[i] = 1;
      } else if (!keep[i]) {
        // A folder that is only on one side (or unreadable) is a result of its own, even when empty.
        const oneSided = r.s === 'left' || r.s === 'right' || r.s === 'error';
        const nameOk = !S.nameFilter || r.n.toLowerCase().includes(S.nameFilter);
        if (oneSided && nameOk && statusOk(r)) keep[i] = 1;
      }
      if (keep[i] && r.p >= 0) keep[r.p] = 1;
    }
    const vis = [];
    let skipDepth = -1;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      if (skipDepth >= 0) { if (r.d > skipDepth) continue; skipDepth = -1; }
      if (!keep[i]) continue;
      vis.push(i);
      if (r.k === 'dir' && S.collapsed.has(S.paths[i])) skipDepth = r.d;
    }
    S.visible = vis;
    spacer.style.height = vis.length * ROW_H + 'px';
    renderChips();
    renderEmpty();
    render();
  }

  function renderChips() {
    chips.textContent = '';
    const c = S.counts;
    if (!c) return;
    const items = [['changed', 'Changed'], ['left', 'Only left'], ['right', 'Only right'], ['same', 'Same'], ['error', 'Errors'], ['pending', 'Checking']];
    for (const [k, label] of items) {
      if ((k === 'error' || k === 'pending') && !c[k]) continue;
      const on = S.statusFilter === k;
      chips.append(el('button', { class: 'chip ' + k + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: on ? 'Show all statuses' : `Show only: ${label}`,
        onclick: () => { S.statusFilter = on ? null : k; if (k === 'same' && !on) { S.showSame = true; showSameBox.checked = true; } rebuild(); } },
      el('span', { class: 'g' }, GLYPH[k]), ` ${label} `, el('b', null, fmtNum(c[k]))));
    }
  }

  function renderEmpty() {
    empty.textContent = '';
    empty.className = 'empty';
    if (S.fatal) {
      empty.className = 'empty on bad';
      empty.append(el('p', null, S.fatal), el('button', { class: 'btn', onclick: () => vscode.postMessage({ type: 'refresh' }) }, 'Try again'));
      return;
    }
    if (!S.counts || S.visible.length) return;
    const c = S.counts;
    const diffs = c.changed + c.left + c.right + c.error + c.pending;
    empty.className = 'empty on';
    if (!diffs && S.phase === 'done') {
      empty.append(el('p', { class: 'big' }, '= The folders are the same'), el('p', null, `${fmtNum(c.files)} files and ${fmtNum(c.folders)} folders compared${S.mode === 'quick' ? ' by size and time' : ' byte by byte'}.`));
      if (!S.showSame && c.files) empty.append(el('button', { class: 'btn', onclick: () => { S.showSame = true; showSameBox.checked = true; save(); rebuild(); } }, 'Show equal files'));
    } else if (S.nameFilter || S.statusFilter) {
      empty.append(el('p', null, 'No rows match the filter.'), el('button', { class: 'btn', onclick: () => { S.nameFilter = ''; filter.value = ''; S.statusFilter = null; rebuild(); } }, 'Clear the filter'));
    } else if (!diffs) {
      empty.append(el('p', null, 'No differences so far.'));
    }
  }

  function sideCells(r, side, i) {
    const s = side === 'l' ? r.l : r.r;
    const name = el('div', { class: 'c name' });
    name.style.paddingLeft = (6 + r.d * 14) + 'px';
    if (!s) {
      name.classList.add('missing');
      return [name, el('div', { class: 'c num missing' }), el('div', { class: 'c time missing' })];
    }
    const isDir = s[0] === 'dir';
    if (isDir) {
      const open = !S.collapsed.has(S.paths[i]);
      name.append(el('span', { class: 'tw', 'data-tw': '1' }, open ? '▾' : '▸'));
    } else name.append(el('span', { class: 'tw' }));
    name.append(el('span', { class: 'ic ' + (isDir ? 'dir' : s[0] === 'link' ? 'link' : 'file') }), el('span', { class: 'nm' }, s[3] || r.n));
    return [name, el('div', { class: 'c num' }, isDir ? '' : fmtSize(s[1])), el('div', { class: 'c time' }, fmtTime(s[2]))];
  }

  function render() {
    const top = list.scrollTop, h = list.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(S.visible.length, Math.ceil((top + h) / ROW_H) + 10);
    rowsBox.style.transform = `translateY(${first * ROW_H}px)`;
    rowsBox.textContent = '';
    const frag = document.createDocumentFragment();
    for (let v = first; v < last; v++) {
      const i = S.visible[v];
      const r = S.rows[i];
      const row = el('div', { class: `row s-${r.s}${r.k === 'dir' ? ' dir' : ''}${S.sel.has(i) ? ' sel' : ''}${S.focus === i ? ' focus' : ''}`, 'data-i': String(i), role: 'row', 'aria-selected': S.sel.has(i) ? 'true' : 'false', title: r.nt || '' });
      row.append(...sideCells(r, 'l', i), el('div', { class: 'c st', title: LABEL[r.s] + (r.nt ? ': ' + r.nt : '') }, GLYPH[r.s] || ''), ...sideCells(r, 'r', i));
      frag.append(row);
    }
    rowsBox.append(frag);
    renderDetail();
  }

  function renderDetail() {
    detail.textContent = '';
    const i = S.focus;
    if (i < 0 || !S.rows[i]) {
      detail.append(el('span', { class: 'hint' }, 'Double-click a file or press Enter to open its diff. Ctrl or Cmd click and Shift click select several rows.'));
      return;
    }
    const r = S.rows[i];
    const side = (s, label) => (s ? `${label}: ${s[0] === 'dir' ? 'folder' : fmtSize(s[1])}${s[2] ? ', ' + fmtTime(s[2]) : ''}` : `${label}: missing`);
    detail.append(el('b', null, S.paths[i]), el('span', { class: 'sd s-' + r.s }, ' ' + LABEL[r.s]), el('span', null, '  ·  ' + side(r.l, S.left ? S.left.label : 'Left') + '  ·  ' + side(r.r, S.right ? S.right.label : 'Right')));
    if (r.nt) detail.append(el('span', { class: 'note' }, '  ·  ' + r.nt));
    if (r.k !== 'dir') {
      const acts = el('span', { class: 'acts' });
      acts.append(el('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'open', i }) }, 'Open diff'));
      if (r.l && !S.git) acts.append(el('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'reveal', i, side: 'left' }) }, 'Reveal left'));
      if (r.r) acts.append(el('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'reveal', i, side: 'right' }) }, 'Reveal right'));
      if (r.r) acts.append(el('button', { class: 'link', onclick: () => vscode.postMessage({ type: 'copyPath', i, side: 'right' }) }, 'Copy path'));
      detail.append(acts);
    }
  }

  list.addEventListener('scroll', () => requestAnimationFrame(render));
  window.addEventListener('resize', () => render());

  function toggle(i) {
    const p = S.paths[i];
    if (S.collapsed.has(p)) S.collapsed.delete(p); else S.collapsed.add(p);
    save(); rebuild();
  }

  rowsBox.addEventListener('click', e => {
    const rowEl = e.target.closest('.row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    if (e.target.dataset.tw) { toggle(i); return; }
    // The second click of a double-click: the row was re-rendered after the first one, so "dblclick" may not fire.
    if (e.detail >= 2 && !e.shiftKey && !e.metaKey && !e.ctrlKey) { if (S.rows[i].k === 'dir') toggle(i); else vscode.postMessage({ type: 'open', i }); return; }
    if (e.shiftKey && S.anchor >= 0) {
      const a = S.visible.indexOf(S.anchor), b = S.visible.indexOf(i);
      if (!(e.metaKey || e.ctrlKey)) S.sel.clear();
      for (let v = Math.min(a, b); v <= Math.max(a, b); v++) S.sel.add(S.visible[v]);
    } else if (e.metaKey || e.ctrlKey) {
      if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i);
      S.anchor = i;
    } else { S.sel.clear(); S.sel.add(i); S.anchor = i; }
    S.focus = i;
    list.focus();
    render();
  });

  function moveFocus(dv, extend) {
    if (!S.visible.length) return;
    let v = S.visible.indexOf(S.focus);
    v = Math.max(0, Math.min(S.visible.length - 1, (v < 0 ? 0 : v + dv)));
    const i = S.visible[v];
    if (extend && S.anchor >= 0) {
      S.sel.clear();
      const a = S.visible.indexOf(S.anchor);
      for (let k = Math.min(a, v); k <= Math.max(a, v); k++) S.sel.add(S.visible[k]);
    } else { S.sel.clear(); S.sel.add(i); S.anchor = i; }
    S.focus = i;
    const y = v * ROW_H;
    if (y < list.scrollTop) list.scrollTop = y;
    else if (y + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW_H - list.clientHeight;
    render();
  }
  list.addEventListener('keydown', e => {
    const page = Math.max(1, Math.floor(list.clientHeight / ROW_H) - 1);
    if (e.key === 'ArrowDown') { moveFocus(1, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { moveFocus(-1, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'PageDown') { moveFocus(page, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'PageUp') { moveFocus(-page, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'Home') { moveFocus(-1e9, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'End') { moveFocus(1e9, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'Enter' && S.focus >= 0) { if (S.rows[S.focus].k === 'dir') toggle(S.focus); else vscode.postMessage({ type: 'open', i: S.focus }); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && S.focus >= 0) {
      const r = S.rows[S.focus];
      if (r.k === 'dir' && !S.collapsed.has(S.paths[S.focus])) toggle(S.focus);
      else if (r.p >= 0) { S.focus = r.p; S.sel.clear(); S.sel.add(r.p); render(); }
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && S.focus >= 0) {
      if (S.rows[S.focus].k === 'dir' && S.collapsed.has(S.paths[S.focus])) toggle(S.focus);
      e.preventDefault();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { S.visible.forEach(i => S.sel.add(i)); render(); e.preventDefault(); }
  });

  // ---------- progress ----------
  function setProgress(text, frac, running) {
    prog.classList.toggle('on', true);
    prog.classList.toggle('running', !!running);
    progText.textContent = text;
    progFill.style.width = frac == null ? '100%' : Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    progFill.classList.toggle('indet', frac == null && running);
    cancel.hidden = !running;
  }
  function summary(c) {
    return `${fmtNum(c.changed)} changed, ${fmtNum(c.left)} only left, ${fmtNum(c.right)} only right, ${fmtNum(c.same)} same` + (c.error ? `, ${fmtNum(c.error)} errors` : '');
  }

  function setSides() {
    L.label.textContent = S.left.label === 'Left' ? 'LEFT' : S.left.label;
    // The path is cut at its start (the folder names that matter are at the end); <bdi> keeps its slashes in place.
    L.pathEl.textContent = ''; L.pathEl.append(el('bdi', { dir: 'ltr' }, S.left.path)); L.pathEl.title = S.left.path;
    R.label.textContent = S.right.label === 'Right' ? 'RIGHT' : S.right.label;
    R.pathEl.textContent = ''; R.pathEl.append(el('bdi', { dir: 'ltr' }, S.right.path)); R.pathEl.title = S.right.path;
    L.change.hidden = S.git;
    swap.hidden = S.git;
    modeSel.value = S.mode; modeSel.disabled = S.git;
    modeSel.title = S.git ? 'Git compares use the object ids: exact and fast' : 'Compare mode';
    bCopyL.disabled = S.git;
    colHead.children[0].textContent = S.left.label === 'Left' ? 'Left' : S.left.label;
    colHead.children[4].textContent = S.right.label === 'Right' ? 'Right' : S.right.label;
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        S.left = m.left; S.right = m.right; S.git = m.git; S.mode = m.mode; S.pro = m.pro || [];
        if (!S.inited) S.showSame = typeof S.saved.showSame === 'boolean' ? S.saved.showSame : !!m.showSame;
        S.inited = true;
        showSameBox.checked = S.showSame;
        S.phase = 'scan'; S.fatal = ''; S.counts = null; S.rows = []; S.visible = []; S.sel.clear(); S.focus = -1;
        spacer.style.height = '0px'; rowsBox.textContent = ''; renderChips(); renderEmpty();
        setSides();
        setProgress('Reading both folders...', null, true);
        break;
      case 'progress':
        if (m.phase === 'scan') setProgress(`Reading folders: ${fmtNum(m.done)} entries on the ${m.side} side...`, null, true);
        else setProgress(`Comparing contents: ${fmtNum(m.done)} of ${fmtNum(m.total)} files (${fmtSize(m.bytesDone)} of ${fmtSize(m.bytesTotal)})`, m.bytesTotal ? m.bytesDone / m.bytesTotal : m.total ? m.done / m.total : 0, true);
        break;
      case 'tree': {
        const keepCollapsed = S.collapsed;
        S.rows = m.rows; S.counts = m.counts; S.info = m.info;
        computePaths();
        S.collapsed = keepCollapsed;
        rebuild();
        const t = `${fmtNum(m.info.left.files)} files left, ${fmtNum(m.info.right.files)} files right`;
        if (m.counts.pending) setProgress(`${t}. Comparing ${fmtNum(m.counts.pending)} files of the same size...`, 0, true);
        else setProgress(`${t}. ${summary(m.counts)}`, 1, false);
        if (m.info.left.capped || m.info.right.capped) flash('Very large tree: the list stops at 2,000,000 entries.');
        break;
      }
      case 'status': {
        for (let i = 0; i < m.codes.length && i < S.rows.length; i++) S.rows[i].s = m.codes[i];
        for (const k in m.notes) if (S.rows[k]) S.rows[k].nt = m.notes[k];
        S.counts = m.counts;
        rebuild();
        break;
      }
      case 'done':
        S.phase = 'done';
        if (m.counts) S.counts = m.counts;
        setProgress(`Done in ${(m.ms / 1000).toFixed(1)} s: ${S.counts ? summary(S.counts) : ''}`, 1, false);
        renderChips(); renderEmpty();
        break;
      case 'cancelled':
        S.phase = 'done';
        setProgress('Stopped. Rows marked "Checking" were not compared. Press Refresh to compare again.', 1, false);
        break;
      case 'fatal':
        S.phase = 'done'; S.fatal = m.message;
        setProgress('The compare stopped.', 1, false);
        renderEmpty();
        break;
    }
  });

  // Read-only state for the real-app gate (scripts/gate-vscode.mjs). Nothing calls it in normal use.
  window.folderDiffProbe = () => ({ phase: S.phase, fatal: S.fatal, counts: S.counts, rows: S.rows.length, visible: S.visible.length,
    left: S.left && S.left.path, right: S.right && S.right.path, progress: progText.textContent,
    find: (name) => S.rows.findIndex(r => r.n === name), status: (name) => { const r = S.rows.find(x => x.n === name); return r ? [r.s, r.nt] : null; } });
  window.folderDiffSelect = (name) => { const i = S.rows.findIndex(r => r.n === name); if (i < 0) return false; S.collapsed.clear(); rebuild(); const v = S.visible.indexOf(i); if (v < 0) return false; list.scrollTop = Math.max(0, v * ROW_H - 100); S.sel.clear(); S.sel.add(i); S.focus = i; S.anchor = i; render(); return true; };
  if (S.saved.collapsed) S.saved.collapsed.forEach(p => S.collapsed.add(p));
  vscode.postMessage({ type: 'ready' });
})();
