'use strict';
// Runs the bundled webview (dist/webview.js) in jsdom: hostile file names stay text, the More menu shows the three
// Zovo Pro tools with their free tries only when folderDiff.showProTools is on, and nothing about Pro shows before a
// click. jsdom is not a dependency of this extension: the test reuses the copy in the DOCX product (or JSDOM_PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const candidates = [process.env.JSDOM_PATH, path.join(__dirname, '..', 'node_modules', 'jsdom'), path.join(__dirname, '..', '..', 'docx-viewer-vscode', 'node_modules', 'jsdom')].filter(Boolean);
let JSDOM = null;
for (const c of candidates) { try { ({ JSDOM } = require(c)); break; } catch (_) { /* next */ } }
const SCRIPT = path.join(__dirname, '..', 'dist', 'webview.js');

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const sent = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m), getState: () => null, setState() {} });
  dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));
  const post = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { dom, sent, post, doc: dom.window.document };
}

const HOSTILE = ['<img src=x onerror=alert(1)>.txt', '"><script>alert(2)</script>', 'café ملف \u{1F600}.md', 'x'.repeat(250) + '.txt', '$(touch pwned).sh'];
function treeMsg() {
  const rows = HOSTILE.map((n) => ({ n, d: 0, k: 'file', s: 'changed', nt: '<b>note</b>', p: -1, l: ['file', 3, 1, n], r: ['file', 4, 2, n] }));
  return { type: 'tree', rows, counts: { same: 0, changed: rows.length, left: 0, right: 0, error: 0, pending: 0 }, info: { left: { files: 5 }, right: { files: 5 } }, ms: 1 };
}
const init = (pro) => ({ type: 'init', left: { label: 'Left', path: '/a/<b>left</b>' }, right: { label: 'Right', path: '/b/right' }, mode: 'content', showSame: true, git: false, pro });

test('webview: hostile names render as text, no element is injected, paths are text', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { post, doc, sent } = boot();
  assert.equal(sent[0].type, 'ready');
  post(init({ show: true, licensed: false, tries: { sync: 3, merge3: 3, docReport: 3 } }));
  post(treeMsg());
  post({ type: 'done', ms: 5, counts: treeMsg().counts });
  const text = doc.body.textContent;
  for (const n of HOSTILE) assert.ok(text.includes(n), 'shown as text: ' + n.slice(0, 30));
  assert.equal(doc.querySelectorAll('img, script, b > b').length, 0);
  assert.ok(text.includes('/a/<b>left</b>'));
  // nothing about Pro before a click
  assert.ok(!/Zovo Pro|free tr/i.test(text), 'no Pro text on open');
});

test('webview: More menu lists the Pro tools with tries left, hides them with showProTools off, follows updates', { skip: !JSDOM && 'jsdom not found' }, () => {
  const { post, doc, sent } = boot();
  post(init({ show: true, licensed: false, tries: { sync: 2, merge3: 3, docReport: 0 } }));
  post(treeMsg());
  const more = [...doc.querySelectorAll('button')].find((b) => b.textContent.startsWith('More'));
  more.click();
  let items = [...doc.querySelectorAll('.menu button')].map((b) => b.textContent);
  assert.ok(items.some((t) => /^Sync folders with a preview\.\.\.\s+\(Zovo Pro, 2 free tries left\)$/.test(t)), items.join(' | '));
  assert.ok(items.some((t) => /^Report of document changes\s+\(Zovo Pro\)$/.test(t)));
  assert.ok(items.some((t) => /^Three-way compare and merge\.\.\.\s+\(Zovo Pro, 3 free tries left\)$/.test(t)));
  assert.ok(items.includes('Save this compare...'), 'saved compares are free');
  [...doc.querySelectorAll('.menu button')].find((b) => b.textContent.startsWith('Three-way')).click();
  assert.equal(sent[sent.length - 1].type, 'threeWay');
  // setting off: the Pro rows go away
  post({ type: 'pro', pro: { show: false, licensed: false, tries: {} } });
  more.click();
  items = [...doc.querySelectorAll('.menu button')].map((b) => b.textContent);
  assert.ok(!items.some((t) => /Zovo Pro|Sync folders|Three-way|document changes/.test(t)), items.join(' | '));
  // licensed: the tools without a note
  post({ type: 'pro', pro: { show: true, licensed: true, tries: {} } });
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape' }));
  more.click();
  items = [...doc.querySelectorAll('.menu button')].map((b) => b.textContent);
  assert.ok(items.includes('Sync folders with a preview...'));
  assert.ok(!items.some((t) => /Zovo Pro/.test(t)));
});
