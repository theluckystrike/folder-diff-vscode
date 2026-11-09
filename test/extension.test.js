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
const state = { config: {}, warnings: [], infos: [], answer: null, saveTarget: null, executed: [], docs: [] };

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
  workspace: {
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
    setStatusBarMessage: () => ({ dispose() {} }),
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
  for (const phrase of ['compare files', 'diff folders', 'compare folders', 'folder compare', 'directory compare']) for (const w of phrase.split(' ')) assert.ok(words.includes(w), `${phrase}: ${w}`);
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

test('Pro switch: off ships everything free, with no label; on gives 3 tries, then asks', async () => {
  const { createPro, PRO_ENABLED } = require('../src/pro');
  assert.equal(PRO_ENABLED, false);
  const c = { subscriptions: [], globalState: ctx.globalState };
  const off = createPro({ vscode: vscodeMock, context: c });
  assert.deepEqual(off.labels(), []);
  assert.equal(await off.allow('Folder sync'), true);
  let asked = 0;
  const fake = { ready: Promise.resolve(), isPro: () => false, refresh() {}, requirePro: async () => { asked++; return false; } };
  const on = createPro({ vscode: vscodeMock, context: { subscriptions: [], globalState: { data: new Map(), get(k, d) { return this.data.get(k) || d; }, async update(k, v) { this.data.set(k, v); } } }, enabled: true, license: fake });
  assert.deepEqual(on.labels().length, 4);
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await on.allow('Folder sync', 'x'));
  assert.deepEqual(r, [true, true, true, false]);
  assert.equal(asked, 1);
  const paid = createPro({ vscode: vscodeMock, context: c, enabled: true, license: { ...fake, isPro: () => true } });
  assert.equal(await paid.allow('Folder sync'), true);
});
