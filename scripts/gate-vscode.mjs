// Real VS Code gate: installs the .vsix into an isolated profile, opens ~/folder-diff-work as the workspace and
// drives the Explorer, the compare webview, the diff editors and the confirmation dialogs with real mouse and key
// events. Writes screenshots and a JSON report.
// usage: node scripts/gate-vscode.mjs <work> <port> <vsix> <workspace (~/folder-diff-work)> <shotDir> <outJson> [phase]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [work0, port, vsix, ws0, shotDir, outJson, phase = 'main'] = process.argv.slice(2);
const work = path.resolve(work0), ws = path.resolve(ws0), G = path.join(ws, 'gate');
const R = fs.existsSync(outJson) && phase !== 'main' ? JSON.parse(fs.readFileSync(outJson, 'utf8')) : { install: null, steps: [], console: [] };
if (phase === 'main' || phase === 'floor') { fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true }); fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true }); R.install = installVsix(work, vsix); }
const settings = {
  'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'window.menuStyle': 'custom', 'window.titleBarStyle': 'custom',
  'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false, 'folderDiff.deleteToTrash': false,
  'explorer.confirmDragAndDrop': false, 'workbench.tree.expandMode': 'doubleClick', 'files.watcherExclude': { '**/gate/large/**': true, '**/gate/hostile/**': true }, 'workbench.editor.enablePreview': false, 'git.enabled': false, 'git.autoRepositoryDetection': false,
};
const vs = await launch(work, Number(port), ws, settings);
const shots = [];
const shot0 = async name => { const f = path.join(shotDir, `${phase}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const shot = async name => { try { return await shot0(name); } catch (e) { R.steps.push({ phase, name: 'screenshot skipped: ' + name, ok: true, value: String(e.message || e) }); return null; } };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ phase, name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log('PASS', name); }
  catch (e) { R.steps.push({ phase, name, ok: false, error: String(e.message || e).slice(0, 800), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 300)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const W = expr => vs.wbEval(expr);
let wv;
const E = expr => vs.wvEval(wv, expr);
const probe = async () => JSON.parse(await E('JSON.stringify(window.folderDiffProbe())'));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 30000);
const done = async (ms = 120000) => { const p = await vs.waitFor(async () => { const p = await probe(); return p.phase === 'done' ? p : null; }, ms, 250); if (!p) throw new Error('compare did not finish: ' + JSON.stringify(await probe())); return p; };
const tabs = () => W(`[...document.querySelectorAll('.tabs-container .tab')].map(t => (t.getAttribute('aria-label') || t.textContent).trim())`);
const activeTab = () => W(`(document.querySelector('.tabs-container .tab.active') || {}).getAttribute ? document.querySelector('.tabs-container .tab.active').getAttribute('aria-label') : ''`);
// An Explorer row by name; with a parent name, only rows inside that expanded folder count (a, b repeat).
const rowBox = async (name, parent) => JSON.parse(await W(`(() => {
  const rows = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')];
  const nm = r => (r.querySelector('.label-name') || {}).textContent;
  let list = rows;
  const par = ${JSON.stringify(parent || null)};
  if (par) {
    const i = rows.findIndex(r => nm(r) === par);
    if (i < 0) return 'null';
    const lv = Number(rows[i].getAttribute('aria-level'));
    list = [];
    for (let k = i + 1; k < rows.length && Number(rows[k].getAttribute('aria-level')) > lv; k++) if (Number(rows[k].getAttribute('aria-level')) === lv + 1) list.push(rows[k]);
  }
  const r = list.find(r => nm(r) === ${JSON.stringify(name)});
  if (!r) return 'null';
  r.scrollIntoView({ block: 'nearest' });
  const b = r.getBoundingClientRect();
  return JSON.stringify({ x: b.x + 60, y: b.y + b.height / 2, expanded: r.getAttribute('aria-expanded') });
})()`));
const expand = async (name, parent) => { const b = await vs.waitFor(() => rowBox(name, parent), 10000); if (!b) throw new Error('no explorer row ' + name); if (b.expanded !== 'true') { await vs.click(b.x, b.y, { count: 2 }); await sleep(600); } };
const contextMenu = async (label) => {
  const b = await vs.waitFor(async () => JSON.parse(await W(`(() => { const a = [...document.querySelectorAll('.context-view .action-item .action-label, .monaco-menu .action-label')].find(a => a.textContent.trim() === ${JSON.stringify(label)}); if (!a) return 'null'; const b = a.getBoundingClientRect(); return JSON.stringify({ x: b.x + 10, y: b.y + b.height / 2 }); })()`)), 5000);
  if (!b) { const all = await W(`[...document.querySelectorAll('.context-view .action-label')].map(a => a.textContent.trim()).join(' | ')`); await vs.key('Escape', 'Escape'); throw new Error(`menu item "${label}" missing. Menu: ${all}`); }
  await vs.click(b.x, b.y);
};
const compareInExplorer = async (parent, a, b, title) => {
  await expand(parent, 'gate');
  const ra = await rowBox(a, parent), rb = await rowBox(b, parent);
  if (!ra || !rb) throw new Error(`explorer rows ${a} / ${b} under ${parent} not found`);
  await vs.click(ra.x, ra.y);
  await vs.click(rb.x, rb.y, { modifiers: 4 }); // Cmd-click
  await sleep(300);
  await vs.click(rb.x, rb.y, { button: 'right' });
  await sleep(500);
  await contextMenu('Compare Selected Folders');
  wv = await getWv(title);
  if (!wv) throw new Error('no compare webview titled ' + title + '; webviews: ' + JSON.stringify((await vs.webviews()).map(w => w.title)));
  return wv;
};
const dialog = () => W(`(() => { const d = document.querySelector('.monaco-dialog-box'); if (!d) return null; return { text: d.innerText, buttons: [...d.querySelectorAll('.monaco-button')].map(b => b.textContent.trim()) }; })()`);
const dialogClick = async (label) => {
  const b = JSON.parse(await W(`(() => { const x = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!x) return 'null'; const r = x.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  if (!b) throw new Error('no dialog button ' + label);
  await vs.click(b.x, b.y);
};
const openRow = async (name) => {
  if (!(await E(`window.folderDiffSelect(${JSON.stringify(name)})`))) throw new Error('no row ' + name);
  await sleep(150);
  // VS Code 1.90 in a window behind others does not paint, so real clicks miss: send the double-click as an event.
  if (phase === 'floor') { await E(`document.querySelector('.row.focus .nm').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })) && 1`); return; }
  await vs.wvClick(wv, `document.querySelector('.row.focus .nm')`, { count: 2 });
};
const closeEditor = async () => {
  const b = JSON.parse(await W(`(() => { const x = document.querySelector('.tabs-container .tab.active .tab-actions .action-label'); if (!x) return 'null'; const r = x.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  if (b) { await vs.click(b.x, b.y); await sleep(500); }
};
const backToCompare = async (title) => {
  const b = JSON.parse(await W(`(() => { const t = [...document.querySelectorAll('.tabs-container .tab')].find(t => (t.getAttribute('aria-label') || '').startsWith(${JSON.stringify(title)})); if (!t) return 'null'; const r = t.getBoundingClientRect(); return JSON.stringify({ x: r.x + 30, y: r.y + r.height / 2 }); })()`));
  if (b) { await vs.click(b.x, b.y); await sleep(600); }
  wv = await getWv(title);
};
const notifications = () => vs.notifications();
const fileText = p => fs.readFileSync(p, 'utf8');

try {
  await sleep(3000);
  if (phase === 'main') {
    await step('extension installed into a clean profile', async () => { if (R.install.code !== 0) throw new Error(R.install.out); return R.install.out.trim().split('\n').pop(); });

    // 1. A real project at two tags, picked in the Explorer.
    const T1 = 'express-4.17.3 ↔ express-4.21.2';
    await step('Explorer: select two folders, right-click, Compare Selected Folders: Left and Right panels with full paths', async () => {
      await expand('gate');
      await compareInExplorer('oss', 'express-4.17.3', 'express-4.21.2', T1);
      const p = await done();
      const sides = await E(`[...document.querySelectorAll('.side')].map(s => s.innerText.replace(/\\s+/g, ' ')).join(' || ')`);
      if (!sides.includes(path.join(G, 'oss', 'express-4.17.3')) || !sides.includes(path.join(G, 'oss', 'express-4.21.2'))) throw new Error(sides);
      if (!(p.counts.changed > 10)) throw new Error(JSON.stringify(p));
      await sleep(400);
      await shot('oss-compare-dark');
      return { sides, counts: p.counts, progress: p.progress };
    });
    await step('counts match an independent byte check of both trees', async () => {
      const walk = (d, base = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), base + e.name + '/') : [base + e.name]);
      const a = new Set(walk(path.join(G, 'oss', 'express-4.17.3'))), b = new Set(walk(path.join(G, 'oss', 'express-4.21.2')));
      let same = 0, changed = 0;
      for (const f of a) if (b.has(f)) { if (Buffer.compare(fs.readFileSync(path.join(G, 'oss', 'express-4.17.3', f)), fs.readFileSync(path.join(G, 'oss', 'express-4.21.2', f))) === 0) same++; else changed++; }
      const truth = { same, changed, left: [...a].filter(f => !b.has(f)).length, right: [...b].filter(f => !a.has(f)).length };
      const p = await probe();
      for (const k of Object.keys(truth)) if (p.counts[k] !== truth[k]) throw new Error(JSON.stringify({ truth, ui: p.counts }));
      return truth;
    });
    await step('text file: double-click opens the VS Code diff editor', async () => {
      await openRow('History.md');
      const t = await vs.waitFor(async () => { const a = await activeTab(); return /History\.md.*↔/.test(a) ? a : null; }, 10000);
      if (!t) throw new Error('tabs: ' + JSON.stringify(await tabs()));
      await sleep(800);
      await shot('text-diff');
      await closeEditor();
      return t;
    });
    await step('Copy to right asks first with the file list; Cancel writes nothing; Copy writes exactly that file', async () => {
      await backToCompare(T1);
      const rel = 'History.md';
      const L = path.join(G, 'oss', 'express-4.17.3', rel), Rt = path.join(G, 'oss', 'express-4.21.2', rel);
      const before = fileText(Rt);
      await E(`window.folderDiffSelect('History.md')`);
      await vs.wvClick(wv, `[...document.querySelectorAll('button')].find(b => b.textContent === 'Copy to right ▶')`);
      const d1 = await vs.waitFor(dialog, 5000);
      if (!d1 || !/overwrite\s+History\.md/.test(d1.text)) throw new Error('dialog: ' + JSON.stringify(d1));
      await shot('copy-confirm');
      await dialogClick('Cancel');
      await sleep(500);
      if (fileText(Rt) !== before) throw new Error('Cancel changed the file');
      await vs.wvClick(wv, `[...document.querySelectorAll('button')].find(b => b.textContent === 'Copy to right ▶')`);
      await vs.waitFor(dialog, 5000);
      const label = (await dialog()).buttons.find(b => /^Copy 1 file/.test(b));
      await dialogClick(label);
      await vs.waitFor(() => fileText(Rt) === fileText(L), 5000);
      await sleep(800);
      const p = await done();
      const st = await E(`JSON.stringify(window.folderDiffProbe().status('History.md'))`);
      if (fileText(Rt) !== fileText(L) || !/same/.test(st)) throw new Error(st);
      return { dialog: d1.text.split('\n').slice(0, 6).join(' / '), buttons: d1.buttons, after: st, counts: p.counts };
    });
    await step('Delete on the right asks first and removes only the listed file', async () => {
      const p0 = await probe();
      // pick a right-only file
      const target = await E(`(() => { const p = document.querySelectorAll('.row.s-right:not(.dir) .c:nth-child(5) .nm'); return p.length ? p[0].textContent : ''; })()`);
      if (!target) { await vs.wvClick(wv, `[...document.querySelectorAll('.chip')].find(c => c.classList.contains('right'))`); await sleep(300); }
      const t2 = target || await E(`(() => { const p = document.querySelectorAll('.row.s-right:not(.dir) .c:nth-child(5) .nm'); return p.length ? p[0].textContent : ''; })()`);
      if (!t2) throw new Error('no right-only file');
      const found = (function find(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (e.name === t2) return p; } return null; })(path.join(G, 'oss', 'express-4.21.2'));
      await E(`window.folderDiffSelect(${JSON.stringify(t2)})`);
      await vs.wvClick(wv, `[...document.querySelectorAll('button')].find(b => b.textContent === 'Delete ▾')`);
      await sleep(300);
      await vs.wvClick(wv, `[...document.querySelectorAll('.menu button')].find(b => b.textContent.startsWith('Delete on the right'))`);
      const d = await vs.waitFor(dialog, 5000);
      if (!d || !d.text.includes(t2) || !/for good/.test(d.text)) throw new Error(JSON.stringify(d));
      await dialogClick(d.buttons.find(b => /^Delete 1/.test(b)));
      await vs.waitFor(() => !fs.existsSync(found), 5000);
      await sleep(800);
      const p = await done();
      if (fs.existsSync(found)) throw new Error('not deleted');
      if (p.counts.right !== p0.counts.right - 1) throw new Error(JSON.stringify([p0.counts, p.counts]));
      await vs.wvClick(wv, `[...document.querySelectorAll('.chip.on')][0] || document.body`);
      return { deleted: path.relative(G, found), dialog: d.text.split('\n').slice(0, 4).join(' / ') };
    });
    await step('support footer and cross-sell: Rate, More free viewers, Sponsor, PayPal; picker lists Hex, XLSX and DOCX', async () => {
      const links = await E(`[...document.querySelectorAll('#zovo-support a')].map(a => a.textContent)`);
      if (links.join('|') !== 'Rate|More free viewers|Sponsor|PayPal|Hide') throw new Error(JSON.stringify(links));
      await vs.wvClick(wv, `[...document.querySelectorAll('#zovo-support a')].find(a => a.textContent === 'More free viewers')`);
      const items = await vs.waitFor(async () => { const t = await W(`[...document.querySelectorAll('.quick-input-list .monaco-list-row')].map(r => r.textContent).join(' | ')`); return t.length > 20 ? t : null; }, 5000);
      await shot('cross-sell-picker');
      await vs.key('Escape', 'Escape');
      if (!/Hex/.test(items) || !/XLSX/.test(items) || !/DOCX/.test(items)) throw new Error(items);
      return { links, items: items.slice(0, 400) };
    });
    await closeEditor();

    // 2. Office, data, PDF and binary pairs.
    const T2 = 'a ↔ b';
    await step('Office folder compare finishes', async () => {
      await compareInExplorer('office', 'a', 'b', T2);
      const p = await done();
      return p.counts;
    });
    const cases = [
      ['Q3 Field Report.docx', /as Markdown/, 'docx-diff'], ['minutes.doc', /as Markdown/], ['report.odt', /as Markdown/],
      ['sales.xlsx', /as CSV/, 'xlsx-diff'], ['formulas.xlsx', /as CSV/], ['sales.csv', /as CSV/], ['events.parquet', /as CSV|same/],
      ['manual.pdf', /PDF text/, 'pdf-diff'], ['field-report.pdf', /PDF text|same/], ['app-1.2.0.bin', /bytes/, 'binary-diff'], ['logo.png', /bytes/],
    ];
    for (const [name, want, shotName] of cases) {
      await step(`${name}: opens its own diff`, async () => {
        await backToCompare(T2);
        await openRow(name);
        const t = await vs.waitFor(async () => { const a = await activeTab(); return a && a.includes(name) && /↔/.test(a) ? a : null; }, 20000);
        const notes = await notifications();
        if (!t && !(want.test('same') && notes.some(n => /same on both sides/.test(n)))) throw new Error('tab: ' + (await activeTab()) + ' notes: ' + JSON.stringify(notes));
        if (t && !want.test(t)) throw new Error('tab title ' + t);
        await sleep(900);
        if (shotName) await shot(shotName);
        const text = await W(`(document.querySelector('.editor-instance .monaco-diff-editor .modified') || document.body).innerText.slice(0, 300)`);
        if (t) await closeEditor();
        return { tab: t, sameNote: notes.find(n => /same on both sides/.test(n)) || null, rightTextStart: text.replace(/\s+/g, ' ').slice(0, 160) };
      });
    }

    // 3. Hostile input.
    const T3 = 'a ↔ b';
    await step('hostile: link loops, unreadable file and folder, NFC/NFD and case-only names, 4 GB sparse files, a file written during the compare', async () => {
      await W(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
      await vs.command('View: Close All Editors');
      await sleep(600);
      const writer = spawn('python3', ['-I', '-c', `
import time, os, sys
p = sys.argv[1]; end = time.time() + 25
with open(p, 'r+b') as f:
    while time.time() < end:
        f.seek(int(time.time() * 1000) % (60 * 1024 * 1024)); f.write(os.urandom(4096)); f.flush(); time.sleep(0.02)
`, path.join(G, 'hostile', 'b', 'growing.log')], { stdio: 'ignore' });
      try {
        await compareInExplorer('hostile', 'a', 'b', T3);
        const p = await done(180000);
        const st = {};
        for (const n of ['loop-to-parent', 'loop-a', 'loop-b', 'no-read.txt', 'locked-dir', 'Readme.md', 'README.md', 'only-left-4GB.img', 'disk-4GB.img', 'growing.log', 'ok.txt', 'self-loop']) st[n] = JSON.parse(await E(`JSON.stringify(window.folderDiffProbe().status(${JSON.stringify(n)}))`));
        st['café'] = JSON.parse(await E(`JSON.stringify(window.folderDiffProbe().status('caf\\u00e9-menu.txt') || window.folderDiffProbe().status('cafe\\u0301-menu.txt'))`));
        await E(`(() => { const c = document.getElementById('showSame'); c.checked = true; c.dispatchEvent(new Event('change')); return 1; })()`);
        await sleep(400);
        await shot('hostile');
        const bad = [];
        if (!st['no-read.txt'] || st['no-read.txt'][0] !== 'error') bad.push('no-read');
        if (!st['locked-dir'] || st['locked-dir'][0] !== 'error') bad.push('locked-dir');
        if (!st['disk-4GB.img'] || st['disk-4GB.img'][0] !== 'changed') bad.push('4GB pair');
        if (!st['only-left-4GB.img'] || st['only-left-4GB.img'][0] !== 'left') bad.push('4GB one side');
        if (!st['café'] || !/Unicode/.test(st['café'][1])) bad.push('nfc');
        if (!(st['Readme.md'] || st['README.md'])) bad.push('case');
        if (bad.length) throw new Error(bad.join(',') + ' ' + JSON.stringify(st));
        return { ms: p.progress, counts: p.counts, statuses: st };
      } finally { writer.kill(); }
    });
    await step('hostile: the 4 GB pair opens as a byte compare at the 3.9 GB offset', async () => {
      await openRow('disk-4GB.img');
      const t = await vs.waitFor(async () => { const a = await activeTab(); return /disk-4GB\.img.*bytes/.test(a) ? a : null; }, 120000, 500);
      if (!t) throw new Error('tab ' + await activeTab());
      await sleep(800);
      const text = await W(`document.querySelector('.editor-instance .monaco-diff-editor .modified').innerText.slice(0, 600)`);
      await shot('hostile-4gb-bytes');
      await closeEditor();
      if (!/1 bytes differ|bytes differ/.test(text) && !/F9999999|F999/i.test(text)) throw new Error(text);
      return text.replace(/\s+/g, ' ').slice(0, 300);
    });

    // 4. Large tree.
    const T4 = 'a ↔ b';
    await step('large: 100,000 files per side; the view answers during the compare; counts are exact', async () => {
      await W(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
      await vs.command('View: Close All Editors');
      await sleep(600);
      const t0 = Date.now();
      await compareInExplorer('large', 'a', 'b', T4);
      const lat = [];
      let firstTree = null;
      while (Date.now() - t0 < 300000) {
        const a = Date.now();
        const p = await probe();
        lat.push(Date.now() - a);
        if (p.rows && !firstTree) {
          firstTree = Date.now() - t0;
          await E(`(() => { const l = document.querySelector('.list'); l.scrollTop = 600000; l.dispatchEvent(new Event('scroll')); return 1; })()`);
          await sleep(300);
          await shot('large-during');
        }
        if (p.phase === 'done') break;
        await sleep(300);
      }
      const p = await probe();
      const total = Date.now() - t0;
      await E(`(() => { const f = document.querySelector('input.filter'); f.value = 'added-29'; f.dispatchEvent(new Event('input')); return 1; })()`);
      await sleep(600);
      const filtered = (await probe()).visible;
      await shot('large-filtered');
      await E(`(() => { const f = document.querySelector('input.filter'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()`);
      const want = { changed: 500, left: 500, right: 300, same: 99000 };
      for (const k in want) if (p.counts[k] !== want[k]) throw new Error(JSON.stringify(p.counts));
      lat.sort((a, b) => a - b);
      if (lat[lat.length - 1] > 1500) throw new Error('webview answered slowly: ' + lat.slice(-5));
      return { firstTreeMs: firstTree, totalMs: total, counts: p.counts, rows: p.rows, probeLatencyMs: { median: lat[lat.length >> 1], max: lat[lat.length - 1], n: lat.length }, filteredRows: filtered };
    });

    // 5. Light theme.
    await step('light theme: the same compare in Default Light Modern', async () => {
      const f = path.join(work, 'ud', 'User', 'settings.json');
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      s['workbench.colorTheme'] = 'Default Light Modern';
      fs.writeFileSync(f, JSON.stringify(s, null, 1));
      await sleep(2500);
      await W(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
      await vs.command('View: Close All Editors');
      await compareInExplorer('oss', 'express-4.17.3', 'express-4.21.2', T1);
      await done();
      await sleep(500);
      const bg = await E(`getComputedStyle(document.body).backgroundColor`);
      await shot('oss-compare-light');
      s['workbench.colorTheme'] = 'Default Dark Modern';
      fs.writeFileSync(f, JSON.stringify(s, null, 1));
      await sleep(1500);
      return { background: bg };
    });

  }

  if (phase === 'main' || phase === 'git') {
    // 6. Folder against a Git tag.
    await step('Git: compare a folder with a tag from the Explorer menu; the diff of a changed file opens', async () => {
      await W(`(document.querySelector('.part.statusbar') || document.body).focus && 1`);
      await vs.command('View: Close All Editors');
      const g = await rowBox('gate');
      if (g && g.expanded === 'true') { await vs.click(g.x, g.y, { count: 2 }); await sleep(600); }
      const rb = await vs.waitFor(() => rowBox('oss-repo'), 5000);
      await vs.click(rb.x, rb.y);
      await vs.click(rb.x, rb.y, { button: 'right' });
      await sleep(500);
      await contextMenu('Compare Folder with Git Branch or Tag...');
      await vs.waitFor(() => W(`!!document.querySelector('.quick-input-widget .quick-input-list .monaco-list-row')`), 10000);
      await vs.type('v3.0.3');
      await sleep(600);
      await vs.key('Enter', 'Enter');
      wv = await getWv('oss-repo ↔ v3.0.3');
      if (!wv) throw new Error('no git compare view');
      const p = await done();
      await openRow('readme.md');
      const t = await vs.waitFor(async () => { const a = await activeTab(); return /readme\.md.*v3\.0\.3.*Working tree/.test(a) ? a : null; }, 10000);
      await sleep(700);
      await shot('git-ref-diff');
      await closeEditor();
      if (!t) throw new Error('tab ' + await activeTab());
      const head = await E(`document.querySelector('.side.left').innerText`);
      return { counts: p.counts, tab: t, left: head.replace(/\s+/g, ' ') };
    });
  }


  if (phase === 'floor') {
    // The engines floor (VS Code 1.90.2): native context menus there, so the compare starts from the command palette
    // and the simple file dialog.
    const pick = async (p) => {
      await vs.waitFor(() => W(`!!document.querySelector('.quick-input-widget input') && document.querySelector('.quick-input-widget').style.display !== 'none'`), 10000);
      await vs.key('a', 'KeyA', 4, 65);
      await vs.type(p);
      await sleep(900);
      // The simple dialog fills in the rest of a matching name; accept the typed folder as it is.
      const val = await W(`document.querySelector('.quick-input-widget input').value`);
      if (val !== p) { await vs.key('a', 'KeyA', 4, 65); await vs.type(p); await sleep(600); }
      await vs.key('Enter', 'Enter');
      await sleep(1200);
      const still = await W(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent); })()`);
      if (still) {
        const v2 = await W(`document.querySelector('.quick-input-widget input').value`);
        R.steps.push({ phase, name: 'dialog note', ok: true, value: { typed: p, now: v2 } });
        await vs.key('Enter', 'Enter'); await sleep(1200);
      }
    };
    const viaPalette = async (a, b, title) => {
      await vs.command('Folder Diff: Compare Two Folders...');
      await pick(a);
      await pick(b);
      wv = await getWv(title);
      if (!wv) throw new Error('no compare view ' + title + ' ' + JSON.stringify((await vs.webviews()).map(w => w.title)));
    };
    await step('VS Code version is the floor', async () => { const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); if (!/Code\/1\.90\./.test(v['User-Agent'] || v.Browser || '')) throw new Error(JSON.stringify(v)); return v['User-Agent'].match(/Code\/[\d.]+/)[0]; });
    await step('extension installed', async () => { if (R.install.code !== 0) throw new Error(R.install.out); return R.install.out.trim().split('\n').pop(); });
    await step('floor: Try It on Sample Folders (command palette) compares the two sample releases', async () => {
      await vs.command('Folder Diff: Try It on Sample Folders');
      wv = await getWv('release-1.0 ↔ release-1.1');
      if (!wv) throw new Error('no view ' + JSON.stringify((await vs.webviews()).map(w => w.title)));
      const p = await done();
      await shot('floor-samples');
      if (p.counts.changed !== 7 || p.counts.left !== 1 || p.counts.right !== 1 || p.counts.same !== 2) throw new Error(JSON.stringify(p.counts));
      return p.counts;
    });
    for (const [name, want] of [['Q3 Field Report.docx', /as Markdown/], ['sales.xlsx', /as CSV/], ['sales.csv', /as CSV/], ['manual.pdf', /PDF text/], ['logo.png', /bytes/], ['app.js', /↔/]]) {
      await step(`floor: ${name} diff`, async () => {
        await backToCompare('release-1.0 ↔ release-1.1');
        await openRow(name);
        const t = await vs.waitFor(async () => { const a = await activeTab(); return a && a.includes(name) && want.test(a) ? a : null; }, 30000);
        if (!t) throw new Error('tab ' + await activeTab());
        await sleep(600);
        if (name.endsWith('.docx')) await shot('floor-docx');
        await closeEditor();
        return t;
      });
    }
  }

  if (phase === 'rating') {
    // A second session 5 hours later (fake clock): the rating ask v2 shows after a compare that finished without an error.
    await step('rating ask v2: shows after 2 good compares in sessions 4+ hours apart, with Rate it, Later, No thanks', async () => {
      // The ask needs window focus: bring this test VS Code (by pid) to the front for a moment.
      const front = () => spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${vs.child.pid}) to true`], { timeout: 10000 });
      front();
      await sleep(400);
      await expand('gate');
      await compareInExplorer('office', 'a', 'b', 'a ↔ b');
      await done();
      const n = await vs.waitFor(async () => { front(); return (await notifications()).find(x => /Is Folder Diff useful/.test(x)); }, 15000, 1000);
      await shot('rating-ask');
      const focus = await W('document.hasFocus()').catch(() => null);
      if (!n) throw new Error('no ask; window focus=' + focus + '; toasts=' + JSON.stringify(await notifications()));
      return n;
    });
  }
} finally {
  R.console.push(...vs.console.filter(c => !/Cannot load "@napi-rs\/canvas"|Failed to load resource|ERR_|net::/.test(c.text)).slice(0, 40));
  R.shots = (R.shots || []).concat(shots);
  fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
  await vs.close();
}
console.log(JSON.stringify(R.steps.map(s => [s.ok ? 'PASS' : 'FAIL', s.name]), null, 0));
