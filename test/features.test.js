'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkWork, write, rm } = require('./helpers/tree');
const { merge } = require('../src/core/compare');
const { planCopy, planDelete, planSync, plan3, expand } = require('../src/core/plan');
const { exportResult } = require('../src/core/export');
const { validate, compactRows } = require('../src/protocol');
const git = require('../src/core/git');
const { runConvert, kindOf } = require('../src/diffopen');
const { lineChanges, listLines } = require('../src/panel.js');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const W = path.join(ROOT, 'dist', 'convert-worker.mjs');

// A small hand-made result: folder d with 3 children, plus two top-level files.
function result() {
  const f = (rel, size, mtimeMs = 1) => ({ rel, name: rel.split('/').pop(), kind: 'file', size, mtimeMs });
  const d = rel => ({ rel, name: rel, kind: 'dir', size: 0, mtimeMs: 0 });
  const L = new Map([['d', d('d')], ['d/same.txt', f('d/same.txt', 1)], ['d/chg.txt', f('d/chg.txt', 1, 50)], ['d/left.txt', f('d/left.txt', 3)], ['top.txt', f('top.txt', 9, 100)]]);
  const R = new Map([['d', d('d')], ['d/same.txt', f('d/same.txt', 1)], ['d/chg.txt', f('d/chg.txt', 2, 10)], ['new', d('new')], ['new/n.txt', f('new/n.txt', 4)], ['top.txt', f('top.txt', 9, 900)]]);
  const r = merge(L, R, { mode: 'quick', mtimeToleranceMs: 0 });
  return r.entries;
}
const idx = (entries, rel) => entries.findIndex(e => e.rel === rel);

test('copy plan: a folder expands, equal files are skipped, overwrite vs new is marked', () => {
  const E = result();
  const p = planCopy(E, [idx(E, 'd')], 'toRight');
  assert.deepStrictEqual(p.items.map(x => [x.rel, x.action]).sort(), [['d/chg.txt', 'overwrite'], ['d/left.txt', 'create']]);
  assert.strictEqual(p.skipped, 1);
  const back = planCopy(E, [idx(E, 'new')], 'toLeft');
  assert.deepStrictEqual(back.items.map(x => x.rel), ['new/n.txt']);
  assert.deepStrictEqual(planCopy(E, [idx(E, 'new')], 'toRight').items, [], 'nothing on the source side: nothing to copy');
});

test('delete plan: a folder is one item with its file count; the other side is untouched', () => {
  const E = result();
  const p = planDelete(E, [idx(E, 'd'), idx(E, 'd/chg.txt')], 'left');
  assert.deepStrictEqual(p.items, [{ rel: 'd', kind: 'dir', files: 3 }]);
  assert.deepStrictEqual(planDelete(E, [idx(E, 'd/left.txt')], 'right').items, []);
  assert.deepStrictEqual(expand(E, [idx(E, 'd')]).length, 4);
});

test('sync plans: mirror copies and deletes; update copies newer both ways and never deletes', () => {
  const E = result();
  const m = planSync(E, 'mirrorRight');
  assert.deepStrictEqual(m.copyToRight.items.map(x => x.rel).sort(), ['d/chg.txt', 'd/left.txt', 'top.txt']);
  assert.deepStrictEqual(m.deleteRight.items.map(x => x.rel), ['new']);
  const u = planSync(E, 'update');
  assert.deepStrictEqual(u.copyToRight.items.map(x => x.rel).sort(), ['d/chg.txt', 'd/left.txt'], 'left chg is newer (50 > 10)');
  assert.deepStrictEqual(u.copyToLeft.items.map(x => x.rel).sort(), ['new/n.txt', 'top.txt']);
  assert.strictEqual(u.deleteLeft.items.length + u.deleteRight.items.length, 0);
});

test('three-way plan: one-sided changes merge, both-changed-differently is a conflict', () => {
  const f = (rel, size) => ({ rel, name: rel, kind: 'file', size, mtimeMs: 0 });
  const base = new Map([['a', f('a', 1)], ['b', f('b', 1)], ['c', f('c', 1)], ['gone', f('gone', 1)]]);
  const left = new Map([['a', f('a', 2)], ['b', f('b', 1)], ['c', f('c', 3)], ['add', f('add', 1)]]);
  const right = new Map([['a', f('a', 1)], ['b', f('b', 5)], ['c', f('c', 4)], ['gone', f('gone', 1)]]);
  const bl = merge(base, left, { mode: 'quick', mtimeToleranceMs: 0 }).entries;
  const br = merge(base, right, { mode: 'quick', mtimeToleranceMs: 0 }).entries;
  const rows = Object.fromEntries(plan3(bl, br, () => false).map(r => [r.rel, r]));
  assert.strictEqual(rows.a.result, 'left'); assert.strictEqual(rows.a.action, 'copyLeft');
  assert.strictEqual(rows.b.result, 'right'); assert.strictEqual(rows.b.action, 'copyRight');
  assert.strictEqual(rows.c.result, 'conflict'); assert.strictEqual(rows.c.action, 'none');
  assert.strictEqual(rows.add.result, 'left'); assert.strictEqual(rows.add.action, 'copyLeft');
  assert.strictEqual(rows.gone.result, 'left'); assert.strictEqual(rows.gone.action, 'delete');
  const same = Object.fromEntries(plan3(bl, br, k => k === 'c').map(r => [r.rel, r]));
  assert.strictEqual(same.c.result, 'both-same');
});

test('export: Markdown, CSV (formula-safe) and HTML (escaped)', () => {
  const E = result();
  E[0].note = 'a|b';
  const counts = { same: 1, changed: 2, left: 1, right: 1, error: 0 };
  const md = exportResult('md', { left: '/x/L', right: '/x/R', entries: E, counts, onlyDiff: true });
  assert.match(md, /\| d\/chg.txt \| Changed \|/);
  assert.ok(!/same\.txt/.test(md), 'differences only');
  const csv = exportResult('csv', { left: 'L', right: 'R', entries: [{ kind: 'file', rel: '=cmd.txt', l: { rel: '=cmd.txt', size: 1, kind: 'file' }, r: null, status: 'left' }], counts, onlyDiff: false });
  assert.match(csv, /^"'=cmd.txt",Only left/m, 'a leading = is quoted so spreadsheets do not run it');
  const html = exportResult('html', { left: '<b>', right: 'R', entries: [{ kind: 'file', rel: '<img src=x>', l: { rel: '<img src=x>', size: 1, kind: 'file' }, r: null, status: 'left' }], counts });
  assert.ok(!html.includes('<img src=x>') && html.includes('&lt;img src=x&gt;'));
});

test('protocol: only known, well-formed messages pass', () => {
  assert.deepStrictEqual(validate({ type: 'open', i: 3 }), { type: 'open', i: 3 });
  assert.strictEqual(validate({ type: 'open', i: -1 }), null);
  assert.strictEqual(validate({ type: 'copy', dir: 'sideways', sel: [1] }), null);
  assert.strictEqual(validate({ type: 'delete', side: 'left', sel: ['1'] }), null);
  assert.deepStrictEqual(validate({ type: 'export', format: 'html', onlyDiff: 1 }), { type: 'export', format: 'html', onlyDiff: true });
  assert.strictEqual(validate({ type: 'export', format: 'exe' }), null);
  assert.strictEqual(validate({ type: 'runShell', cmd: 'rm -rf /' }), null);
  assert.strictEqual(validate(null), null);
  const rows = compactRows(result());
  assert.ok(rows.every(r => !JSON.stringify(r).includes('/x/')), 'no absolute paths go to the webview');
  assert.strictEqual(rows[1].p, 0, 'children point to their folder');
});

test('git: ls-tree side, blob ids, refs; hooks never run', async (t) => {
  const w = mkWork('unit-git');
  t.after(() => rm(w));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: w, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  write(w, { 'a.txt': 'one\n', 'sub/b.txt': 'two\n', 'node_modules/x.js': 'x' });
  fs.symlinkSync('a.txt', path.join(w, 'link'));
  g('add', '-A'); g('commit', '-q', '-m', 'first'); g('tag', 'v1');
  // A hook that would leave a mark if git ran it.
  fs.writeFileSync(path.join(w, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch HOOK_RAN\n', { mode: 0o755 });
  const refs = await git.listRefs(w);
  assert.ok(refs.ok && refs.refs.some(r => r.name === 'v1') && refs.refs.some(r => r.name === 'main'));
  assert.ok((await git.resolveRef(w, 'v1')).ok);
  assert.strictEqual((await git.resolveRef(w, 'nope')).ok, false);
  assert.strictEqual((await git.resolveRef(w, '--output=/tmp/x')).ok, false, 'option-like refs are refused');
  const t1 = await git.lsTree(w, 'v1', ['node_modules/']);
  assert.ok(t1.ok);
  const keys = [...t1.map.keys()].sort();
  assert.deepStrictEqual(keys, ['a.txt', 'link', 'sub', 'sub/b.txt']);
  assert.strictEqual(t1.map.get('link').kind, 'link');
  const blob = await git.catBlob(w, t1.map.get('a.txt').oid, 1000);
  assert.strictEqual(blob.bytes.toString(), 'one\n');
  assert.ok(!fs.existsSync(path.join(w, 'HOOK_RAN')));
  assert.strictEqual((await git.lsTree(path.join(w, '..'), 'HEAD', [])).ok, false);
});

test('engines: Word, Excel, CSV, PDF and binary pairs of the samples', async () => {
  if (!fs.existsSync(W)) return assert.fail('build first: dist/convert-worker.mjs is missing');
  const A = path.join(SAMPLES, 'release-1.0'), B = path.join(SAMPLES, 'release-1.1');
  const conv = async (kind, rel) => {
    const ext = path.extname(rel).toLowerCase();
    const job = p => (kind === 'table' ? { kind, ext, path: p } : { kind, ext, bytes: new Uint8Array(fs.readFileSync(p)) });
    return [await runConvert(W, job(path.join(A, rel))), await runConvert(W, job(path.join(B, rel)))];
  };
  const [d1, d2] = await conv('docx', 'docs/Q3 Field Report.docx');
  assert.ok(d1.ok && d2.ok);
  assert.match(d1.text, /18\.2 MW/); assert.match(d2.text, /19\.4 MW/);
  const [x1, x2] = await conv('table', 'data/sales.xlsx');
  assert.match(x1.text, /=== Sheet: Sales ===/); assert.match(x1.text, /North,10,2\.5/); assert.match(x2.text, /North,14,2\.5/);
  const [c1, c2] = await conv('table', 'data/sales.csv');
  assert.ok(!/Central/.test(c1.text) && /Central,5,3\.3/.test(c2.text));
  const [p1, p2] = await conv('pdf', 'docs/manual.pdf');
  assert.match(p1.text, /=== Page 2 ===/); assert.match(p2.text, /--region north/);
  const bin = await runConvert(W, { kind: 'binary', left: path.join(A, 'assets/logo.png'), right: path.join(B, 'assets/logo.png') });
  assert.ok(bin.ok && bin.diffBytes > 0 && bin.leftLines.length === bin.rightLines.length);
  const bad = await runConvert(W, { kind: 'docx', ext: '.docx', bytes: new Uint8Array(Buffer.from('not a zip at all')) });
  assert.strictEqual(bad.ok, false, 'a broken document is an error, not a crash');
  const badPdf = await runConvert(W, { kind: 'pdf', ext: '.pdf', bytes: new Uint8Array(Buffer.from('%PDF-1.4 garbage')) });
  assert.strictEqual(badPdf.ok, false);
  assert.strictEqual(kindOf('a.DOCX'), 'docx'); assert.strictEqual(kindOf('a.parquet'), 'table'); assert.strictEqual(kindOf('a.bin'), null);
});

test('report helpers: line changes and confirmation lists', () => {
  const r = lineChanges('a\nb\nc\nb', 'a\nc\nd\nb');
  assert.deepStrictEqual(r, { removed: ['b'], added: ['d'] });
  const l = listLines(Array.from({ length: 30 }, (_, i) => 'f' + i));
  assert.match(l, /\.\.\.and 5 more$/);
});

test('hostile documents: a ZIP that declares a huge part is refused before it is unpacked; a cut ZIP is a message', async () => {
  // A local header, one central directory entry that claims 300 MB, and the end record. Nothing real to inflate.
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt32LE(10, 20); cd.writeUInt32LE(300 * 1048576, 24); cd.writeUInt16LE(name.length, 28);
  const cdOff = local.length + name.length + 10;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length + name.length, 12); end.writeUInt32LE(cdOff, 16);
  const bomb = Buffer.concat([local, name, Buffer.alloc(10), cd, name, end]);
  const t0 = Date.now();
  const r = await runConvert(W, { kind: 'docx', ext: '.docx', bytes: new Uint8Array(bomb) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /zip bomb/);
  assert.ok(Date.now() - t0 < 10000);
  const cut = await runConvert(W, { kind: 'docx', ext: '.docx', bytes: new Uint8Array(Buffer.concat([local, name, Buffer.alloc(100)])) });
  assert.strictEqual(cut.ok, false);
  // The real sample documents pass the check
  const real = fs.readFileSync(path.join(SAMPLES, 'release-1.1', 'docs', 'Q3 Field Report.docx'));
  const ok = await runConvert(W, { kind: 'docx', ext: '.docx', bytes: new Uint8Array(real) });
  assert.ok(ok.ok, ok.error);
});
