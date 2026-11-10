'use strict';
// The extension host on a mocked VS Code API, with the real worker threads from dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { mkWork, write, rm } = require('./helpers/tree');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const state = { config: {}, warnings: [], infos: [], answer: null, saveTarget: null, executed: [], docs: [], picks: [], status: [] };

function uriOf(p) { return { scheme: 'file', fsPath: p, path: p, with(o) { return uriOf(o.path || p); }, toString() { return 'file://' + p; } }; }
function fakePanel() {
  const sent = [];
  let handler = null, disposer = null;
  const panel = {
    title: '', iconPath: null,
    webview: { html: '', cspSource: 'https://csp', asWebviewUri: u => 'https://res' + u.path, postMessage: async m => { sent.push(m); return true; }, onDidReceiveMessage: h => { handler = h; } },
    onDidDispose: h => { disposer = h; }, onDidChangeViewState: () => {}, reveal() {},
  };
  return { panel, sent, send: m => handler(m), close: () => disposer && disposer() };
}
const panels = [];
const vscodeMock = {
  Uri: { file: uriOf, joinPath: (u, ...s) => uriOf(path.join(u.fsPath, ...s)), parse: s => ({ toString: () => s }), from: o => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query}` }) },
  ViewColumn: { Active: -1, Beside: -2 }, ProgressLocation: { Notification: 15 }, FileType: { Directory: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } dispose() {} },
  workspace: {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: null, isTrusted: true,
    getConfiguration: () => ({ get: (k, d) => (k in state.config ? state.config[k] : d), update: async (k, v) => { state.config[k] = v; } }),
    fs: {
      stat: async u => ({ type: fs.statSync(u.fsPath).isDirectory() ? 2 : 1 }),
      writeFile: async (u, d) => fs.writeFileSync(u.fsPath, d),
      delete: async u => fs.rmSync(u.fsPath, { recursive: true }),
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    openTextDocument: async o => { state.docs.push(o); return o; },
  },
  window: {
    state: { focused: true },
    createWebviewPanel: () => { const f = fakePanel(); panels.push(f); return f.panel; },
    withProgress: async (o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    showWarningMessage: async (msg, opts, ...btns) => { state.warnings.push({ msg, opts, btns }); return state.answer === 'ok' ? btns[0] : undefined; },
    showInformationMessage: async (...a) => { state.infos.push(a); },
    showErrorMessage: async (...a) => { state.infos.push(['ERROR', ...a]); },
    setStatusBarMessage: (m) => { state.status.push(m); return { dispose() {} }; },
    showQuickPick: async (items) => { const f = state.picks.shift(); return f ? f(items) : undefined; },
    registerUriHandler: () => ({ dispose() {} }),
    showSaveDialog: async () => state.saveTarget,
    showTextDocument: async () => {},
    onDidChangeWindowState: () => ({ dispose() {} }),
  },
  commands: { list: new Map(), registerCommand(id, fn) { this.list.set(id, fn); return { dispose() {} }; }, executeCommand: async (...a) => { state.executed.push(a); } },
  env: { clipboard: { writeText: async () => {} }, sessionId: 's1', openExternal: async () => true },
  extensions: { getExtension: () => null },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension.js');
const { buildHtml } = require('../src/html');

const ctx = { extensionUri: uriOf(ROOT), subscriptions: [], globalState: { data: new Map(), get(k, d) { return this.data.has(k) ? this.data.get(k) : d; }, async update(k, v) { this.data.set(k, v); } }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose() {} }) } };
let api;

const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); } throw new Error('timeout'); };

test('manifest: engines floor, commands registered both ways, menus, settings', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
  assert.deepEqual(pkg.activationEvents, []);
  api = ext.activate(ctx);
  const declared = pkg.contributes.commands.map(c => c.command).sort();
  assert.deepEqual([...vscodeMock.commands.list.keys()].sort(), declared);
  for (const m of [...pkg.contributes.menus['explorer/context'], ...pkg.contributes.menus.commandPalette]) assert.ok(declared.includes(m.command), m.command);
  for (const k of ['askForRating', 'showSupportLinks', 'exclude', 'compareMode']) assert.ok(pkg.contributes.configuration.properties['folderDiff.' + k], k);
  const words = pkg.displayName.toLowerCase();
  // Name rule: the measured phrase first and whole, the second phrase whole; never a rival's full name alone.
  assert.ok(pkg.displayName.startsWith('Folder Compare & Folder Diff'), pkg.displayName);
  assert.ok(words.includes('directory compare'));
  assert.ok(pkg.description.toLowerCase().startsWith('folder compare and folder diff'));
  for (const k of ['folder compare', 'folder diff', 'compare folders', 'directory compare', 'directory diff']) assert.ok(pkg.keywords.includes(k), k);
  assert.ok(!['compare folders', 'diff folders'].includes(words));
  assert.equal(pkg.contributes.configuration.properties['folderDiff.showProTools'].default, true);
  const pal = pkg.contributes.menus.commandPalette.find(m => m.command === 'folderDiff.threeWay');
  assert.equal(pal.when, 'config.folderDiff.showProTools');
  assert.ok(!JSON.stringify(pkg).includes('proEnabled'), 'no old Pro switch');
});

test('webview HTML: strict CSP, nonce scripts, no remote origin', () => {
  const html = buildHtml({ cspSource: 'https://csp', scriptUri: 'https://res/w.js', styleUri: 'https://res/w.css', title: 'a ↔ b', nonce: 'N1' });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N1'/);
  assert.ok(!/connect-src/.test(html), 'the webview never fetches');
  assert.ok(!/https?:\/\/(?!csp|res)/.test(html.replace(/https:\/\/(marketplace\.visualstudio\.com|www\.paypal\.com)[^"]*/g, '')), 'no other origin');
});

test('compare panel: full run on the samples, then Copy and Delete ask first and do exactly the list', async (t) => {
  const w = mkWork('unit-ext');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b');
  write(a, { 'x.txt': 'left', 'same.txt': 's', 'only-left.txt': 'L', 'dir/deep.txt': 'd' });
  write(b, { 'x.txt': 'right!', 'same.txt': 's', 'only-right.txt': 'R' });
  const p = api.openCompare({ left: { kind: 'dir', path: a }, right: { kind: 'dir', path: b } });
  const f = panels[panels.length - 1];
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
  await f.send({ type: 'ready' });
  await waitFor(() => f.sent.find(m => m.type === 'done'));
  const init = f.sent.find(m => m.type === 'init');
  assert.equal(init.left.path, a);
  assert.equal(init.right.path, b);
  const tree = f.sent.find(m => m.type === 'tree');
  const names = tree.rows.map(r => r.n);
  assert.deepEqual(names, ['dir', 'deep.txt', 'only-left.txt', 'only-right.txt', 'same.txt', 'x.txt']);
  assert.equal(p.counts.changed, 1); assert.equal(p.counts.left, 2); assert.equal(p.counts.right, 1); assert.equal(p.counts.same, 1);
  // Copy to right: cancelled first, nothing written.
  const sel = [p.entries.findIndex(e => e.rel === 'dir'), p.entries.findIndex(e => e.rel === 'x.txt'), p.entries.findIndex(e => e.rel === 'same.txt')];
  state.answer = null;
  await f.send({ type: 'copy', dir: 'toRight', sel });
  const ask = state.warnings.pop();
  assert.match(ask.msg, /Copy 2 files from the left side to the right side/);
  assert.match(ask.opts.detail, /overwrite\s+x\.txt/);
  assert.match(ask.opts.detail, /new\s+dir\/deep\.txt/);
  assert.match(ask.opts.detail, /1 equal files are skipped/);
  assert.ok(ask.opts.modal);
  assert.equal(fs.readFileSync(path.join(b, 'x.txt'), 'utf8'), 'right!');
  // Now confirm.
  state.answer = 'ok';
  f.sent.length = 0;
  await f.send({ type: 'copy', dir: 'toRight', sel });
  assert.equal(fs.readFileSync(path.join(b, 'x.txt'), 'utf8'), 'left');
  assert.equal(fs.readFileSync(path.join(b, 'dir', 'deep.txt'), 'utf8'), 'd');
  assert.equal(Math.floor(fs.statSync(path.join(b, 'x.txt')).mtimeMs / 1000), Math.floor(fs.statSync(path.join(a, 'x.txt')).mtimeMs / 1000), 'modified time is kept');
  await waitFor(() => f.sent.find(m => m.type === 'done'));
  assert.equal(p.counts.changed, 0);
  // Delete on the right: only the listed item goes.
  state.config.deleteToTrash = false;
  const ir = p.entries.findIndex(e => e.rel === 'only-right.txt');
  await f.send({ type: 'delete', side: 'right', sel: [ir] });
  const del = state.warnings.pop();
  assert.match(del.msg, /Delete 1 item \(1 file\) on the right side/);
  assert.match(del.opts.detail, /deleted for good/);
  assert.ok(!fs.existsSync(path.join(b, 'only-right.txt')));
  assert.ok(fs.existsSync(path.join(b, 'x.txt')) && fs.existsSync(path.join(a, 'only-left.txt')));
  await waitFor(() => f.sent.filter(m => m.type === 'done').length >= 2);
  // Export
  state.saveTarget = uriOf(path.join(w, 'out.csv'));
  await f.send({ type: 'export', format: 'csv', onlyDiff: false });
  assert.match(fs.readFileSync(path.join(w, 'out.csv'), 'utf8'), /^path,status,left_size/);
  // Unknown messages do nothing
  await f.send({ type: 'runShell', cmd: 'x' });
  f.close();
});

test('compare panel: a missing folder gives a message, not a crash; cancel stops the worker', async () => {
  api.openCompare({ left: { kind: 'dir', path: '/nonexistent/folder-a' }, right: { kind: 'dir', path: '/nonexistent/folder-b' } });
  const f = panels[panels.length - 1];
  await f.send({ type: 'ready' });
  const fatal = await waitFor(() => f.sent.find(m => m.type === 'fatal'));
  assert.match(fatal.message, /not found/);
  api.openCompare({ left: { kind: 'dir', path: path.join(ROOT, 'samples', 'release-1.0') }, right: { kind: 'dir', path: path.join(ROOT, 'samples', 'release-1.1') } });
  const g = panels[panels.length - 1];
  await g.send({ type: 'ready' });
  await g.send({ type: 'cancel' });
  g.close();
});

function memState() { return { data: new Map(), get(k, d) { return this.data.has(k) ? this.data.get(k) : d; }, async update(k, v) { this.data.set(k, v); } }; }

test('Zovo Pro: 3 free tries per tool, counted only after output; the 4th click shows the panel with detail and triesUsed', async () => {
  const { createPro, TOOLS, TRIAL_USES } = require('../src/pro');
  assert.equal(TRIAL_USES, 3);
  assert.deepEqual(TOOLS, ['Sync folders', 'Three-way compare and merge', 'Document change report']);
  const asks = [];
  const fake = { ready: Promise.resolve(), isPro: () => false, refresh() {}, requirePro: async (t, o) => { asks.push([t, o]); return false; } };
  const c = { subscriptions: [], globalState: memState() };
  const pro = createPro({ vscode: vscodeMock, context: c, license: fake });
  // allowed() alone never uses a try (the user may press Escape after it)
  for (let i = 0; i < 5; i++) assert.equal(await pro.allowed('sync'), true);
  assert.equal(pro.left('sync'), 3);
  for (let i = 0; i < 3; i++) { assert.equal(await pro.allowed('sync'), true); await pro.produced('sync'); }
  assert.equal(pro.left('sync'), 0);
  assert.match(state.status[state.status.length - 1], /free try 3 of 3 of "Sync folders" used/);
  assert.equal(asks.length, 0);
  assert.equal(await pro.allowed('sync'), false);
  assert.equal(asks.length, 1);
  assert.equal(asks[0][0], 'Sync folders');
  assert.equal(asks[0][1].triesUsed, 3);
  assert.match(asks[0][1].detail, /preview/);
  assert.deepEqual(asks[0][1].tools, TOOLS);
  // other tools keep their own tries
  assert.equal(pro.left('docReport'), 3);
  assert.equal(await pro.allowed('merge3'), true);
  assert.deepEqual(pro.state(), { show: true, licensed: false, tries: { sync: 0, merge3: 3, docReport: 3 } });
  state.config.showProTools = false;
  assert.equal(pro.state().show, false);
  delete state.config.showProTools;
  // licensed: always allowed, nothing counted
  const paid = createPro({ vscode: vscodeMock, context: { subscriptions: [], globalState: memState() }, license: { ...fake, isPro: () => true } });
  for (let i = 0; i < 5; i++) { assert.equal(await paid.allowed('docReport'), true); await paid.produced('docReport'); }
  assert.equal(paid.left('docReport'), 3);
  assert.equal(paid.state().licensed, true);
});

test('Zovo Pro in the compare view: Escape keeps the try, a sync that writes uses one, the 4th sync shows the panel and writes nothing', async (t) => {
  const { ComparePanel } = require('../src/panel');
  const { createPro } = require('../src/pro');
  const w = mkWork('unit-pro');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b');
  const asks = [];
  const fake = { ready: Promise.resolve(), isPro: () => false, refresh() {}, requirePro: async (title, o) => { asks.push([title, o]); return false; } };
  const c = { ...ctx, subscriptions: [], globalState: memState() };
  const pro = createPro({ vscode: vscodeMock, context: c, license: fake });
  const deps = { vscode: vscodeMock, context: c, opener: { kindOf: () => null }, rating: { success() {}, failure() {} }, pro, settings: ext.settings, sessions: { save: async () => {} } };
  const run = async (n) => {
    write(a, { [`new${n}.txt`]: 'L' + n });
    const p = new ComparePanel(deps, { left: { kind: 'dir', path: a }, right: { kind: 'dir', path: b } });
    const f = panels[panels.length - 1];
    await f.send({ type: 'ready' });
    await waitFor(() => f.sent.find(m => m.type === 'done'));
    return { p, f };
  };
  fs.mkdirSync(b, { recursive: true });
  // 1: Escape on the sync choice: no try used, nothing written
  let { f } = await run(0);
  assert.deepEqual(f.sent.find(m => m.type === 'init').pro, { show: true, licensed: false, tries: { sync: 3, merge3: 3, docReport: 3 } });
  state.picks.push(() => undefined);
  await f.send({ type: 'sync' });
  assert.equal(pro.left('sync'), 3);
  assert.ok(!fs.existsSync(path.join(b, 'new0.txt')));
  // 2: Cancel on the confirmation: no try used
  state.picks.push(items => items[0]);
  state.answer = null;
  await f.send({ type: 'sync' });
  assert.equal(pro.left('sync'), 3);
  assert.ok(!fs.existsSync(path.join(b, 'new0.txt')));
  f.close();
  // 3 syncs that copy: one try each
  state.answer = 'ok';
  for (let n = 1; n <= 3; n++) {
    ({ f } = await run(n));
    state.picks.push(items => items[0]);
    await f.send({ type: 'sync' });
    assert.ok(fs.existsSync(path.join(b, `new${n}.txt`)), `sync ${n} copied`);
    assert.equal(pro.left('sync'), 3 - n);
    f.close();
  }
  // 4th: the panel, no quick pick, nothing written
  ({ f } = await run(4));
  const picksBefore = state.picks.length;
  state.picks.push(items => items[0]);
  await f.send({ type: 'sync' });
  assert.equal(asks.length, 1);
  assert.equal(asks[0][0], 'Sync folders');
  assert.equal(asks[0][1].triesUsed, 3);
  assert.ok(!fs.existsSync(path.join(b, 'new4.txt')), 'nothing written after the panel');
  state.picks.length = picksBefore;
  // A report with no changed documents uses no try
  await f.send({ type: 'report' });
  assert.equal(pro.left('docReport'), 3);
  f.close();
  state.answer = null;
});

test('delete never goes through a linked folder: the outside file survives', async (t) => {
  const { ComparePanel } = require('../src/panel');
  const w = mkWork('unit-del');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b'), out = path.join(w, 'outside');
  write(a, { 'sub/x.txt': 'L' });
  write(out, { 'x.txt': 'OUTSIDE' });
  fs.mkdirSync(b, { recursive: true });
  fs.symlinkSync(out, path.join(b, 'sub'));
  const deps = { vscode: vscodeMock, context: ctx, opener: { kindOf: () => null }, rating: { success() {}, failure() {} }, pro: { state: () => ({ show: true, licensed: false, tries: {} }) }, settings: ext.settings, sessions: {} };
  const p = new ComparePanel(deps, { left: { kind: 'dir', path: a }, right: { kind: 'dir', path: b } });
  const r = await p.runDeletes([{ rel: 'sub/x.txt', kind: 'file', files: 1 }], 'right');
  assert.equal(r.done, 0);
  assert.match(r.errors[0], /outside/);
  assert.equal(fs.readFileSync(path.join(out, 'x.txt'), 'utf8'), 'OUTSIDE');
  // the link itself can be deleted; its target stays
  const r2 = await p.runDeletes([{ rel: 'sub', kind: 'file', files: 1 }], 'right');
  assert.equal(r2.done, 1);
  assert.ok(!fs.existsSync(path.join(b, 'sub')));
  assert.equal(fs.readFileSync(path.join(out, 'x.txt'), 'utf8'), 'OUTSIDE');
  panels[panels.length - 1].close();
});
