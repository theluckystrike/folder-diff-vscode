'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkWork, write, rm } = require('./helpers/tree');
const { globToRegex, parseGlobs, parseGitignore, isIgnored, DEFAULT_EXCLUDE } = require('../src/core/ignore');
const { walk } = require('../src/core/walk');
const { merge, quickStatus, rollup, countStatuses } = require('../src/core/compare');
const { filesEqual, diffRanges, hexDump, gitBlobId, looksBinary } = require('../src/core/bytes');

const byName = (entries) => Object.fromEntries(entries.map(e => [e.rel, e]));
async function compare(a, b, o = {}) {
  const rules = parseGlobs(o.exclude || DEFAULT_EXCLUDE);
  const [L, R] = await Promise.all([walk(a, { rules, useGitignore: o.useGitignore !== false }), walk(b, { rules, useGitignore: o.useGitignore !== false })]);
  return merge(L.map, R.map, { mode: o.mode || 'content' });
}

test('globs: *, **, ?, sets and braces', () => {
  const m = (g, p) => new RegExp('^' + globToRegex(g) + '$').test(p);
  assert.ok(m('*.log', 'a.log'));
  assert.ok(!m('*.log', 'x/a.log'));
  assert.ok(m('src/**/*.map', 'src/a/b/c.map'));
  assert.ok(m('src/**/*.map', 'src/c.map'));
  assert.ok(m('file?.txt', 'file1.txt'));
  assert.ok(m('*.{png,jpg}', 'a.jpg'));
  assert.ok(m('[ab].txt', 'b.txt') && !m('[ab].txt', 'c.txt'));
  assert.ok(m('a+b(1).txt', 'a+b(1).txt'), 'regex characters are literal');
});

test('ignore rules: names at any depth, folder-only, anchored, negation, nested .gitignore', () => {
  const rules = parseGlobs(['node_modules/', '*.log', '/build', 'docs/*.tmp']);
  assert.ok(isIgnored(rules, 'node_modules', true));
  assert.ok(isIgnored(rules, 'pkg/node_modules', true));
  assert.ok(!isIgnored(rules, 'node_modules', false), 'trailing / matches folders only');
  assert.ok(isIgnored(rules, 'deep/x/app.log', false));
  assert.ok(isIgnored(rules, 'build', true) && !isIgnored(rules, 'src/build', true), 'leading / anchors');
  assert.ok(isIgnored(rules, 'docs/a.tmp', false) && !isIgnored(rules, 'x/docs/a.tmp', false));
  const gi = parseGitignore('# comment\n*.csv\n!keep.csv\n\nout/\n', 'sub');
  assert.ok(isIgnored(gi, 'sub/a.csv', false));
  assert.ok(!isIgnored(gi, 'sub/keep.csv', false), '! keeps a file');
  assert.ok(!isIgnored(gi, 'a.csv', false), 'a nested .gitignore only applies below its folder');
  assert.ok(isIgnored(gi, 'sub/x/out', true));
});

test('walk + merge: same, changed, only left, only right, folders roll up, default excludes, .gitignore', async (t) => {
  const w = mkWork('unit-basic');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b');
  write(a, { 'same.txt': 'x', 'chg.txt': 'one', 'sizeeq.txt': 'abc', 'only-left.txt': 'l', 'dir/inner.txt': 'i', 'node_modules/m.js': '1', 'ign.tmp': 't', '.gitignore': '*.tmp\n' });
  write(b, { 'same.txt': 'x', 'chg.txt': 'two!', 'sizeeq.txt': 'abd', 'only-right.txt': 'r', 'dir/inner.txt': 'i', 'node_modules/m.js': '2', 'newdir/n.txt': 'n', '.gitignore': '*.tmp\n' });
  const r = await compare(a, b);
  const e = byName(r.entries);
  assert.strictEqual(e['same.txt'].status, 'pending', 'same size: bytes are compared later');
  assert.strictEqual(e['chg.txt'].status, 'changed');
  assert.strictEqual(e['sizeeq.txt'].status, 'pending');
  assert.strictEqual(e['only-left.txt'].status, 'left');
  assert.strictEqual(e['only-right.txt'].status, 'right');
  assert.strictEqual(e['newdir'].status, 'right');
  assert.strictEqual(e['newdir/n.txt'].status, 'right');
  assert.ok(!e['node_modules'] && !e['node_modules/m.js'], 'node_modules is left out by default');
  assert.ok(!e['ign.tmp'], '.gitignore is applied');
  // tree order: folders first, children after their folder
  const order = r.entries.map(x => x.rel);
  assert.ok(order.indexOf('dir') < order.indexOf('dir/inner.txt'));
  assert.ok(order.indexOf('dir') < order.indexOf('chg.txt'));
  // byte compare of the pending ones, then roll up
  for (const x of r.entries.filter(x => x.status === 'pending' && x.kind !== 'dir')) {
    const eq = await filesEqual(path.join(a, x.l.rel), path.join(b, x.r.rel));
    x.status = eq.equal ? 'same' : 'changed';
  }
  rollup(r.entries);
  assert.strictEqual(e['same.txt'].status, 'same');
  assert.strictEqual(e['sizeeq.txt'].status, 'changed');
  assert.strictEqual(e['dir'].status, 'same');
  const c = countStatuses(r.entries);
  assert.deepStrictEqual([c.same, c.changed, c.left, c.right], [3, 2, 1, 2]);
});

test('quick mode: size and time only', () => {
  const l = { kind: 'file', size: 5, mtimeMs: 1000 }, r = { kind: 'file', size: 5, mtimeMs: 2500 };
  assert.strictEqual(quickStatus(l, r, { mode: 'quick', mtimeToleranceMs: 2000 }).status, 'same');
  assert.strictEqual(quickStatus(l, { ...r, mtimeMs: 9000 }, { mode: 'quick', mtimeToleranceMs: 2000 }).status, 'changed');
  assert.strictEqual(quickStatus(l, { ...r, size: 6 }, { mode: 'quick' }).status, 'changed');
  assert.strictEqual(quickStatus(l, r, { mode: 'content' }).status, 'pending');
  assert.strictEqual(quickStatus({ kind: 'file', size: 0 }, { kind: 'file', size: 0 }, { mode: 'content' }).status, 'same');
  assert.strictEqual(quickStatus({ kind: 'dir' }, { kind: 'file', size: 1 }, { mode: 'content' }).status, 'changed');
});

test('hostile: symlink loop, unreadable file and folder, NFC and NFD names, case-only rename', async (t) => {
  const w = mkWork('unit-hostile');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b');
  write(a, { 'x/1.txt': '1', 'secret.txt': 'top secret', 'Readme.md': 'hello', 'locked/in.txt': 'i' });
  write(b, { 'x/1.txt': '1', 'secret.txt': 'top secret', 'README.md': 'hello', 'locked/in.txt': 'i' });
  fs.symlinkSync('..', path.join(a, 'x', 'loop'));
  fs.symlinkSync('..', path.join(b, 'x', 'loop'));
  fs.symlinkSync('loop2', path.join(a, 'loop1'));
  fs.symlinkSync('loop1', path.join(a, 'loop2'));
  const nfc = 'café.txt', nfd = 'café.txt';
  fs.writeFileSync(path.join(a, nfc), 'c');
  fs.writeFileSync(path.join(b, nfd), 'c');
  fs.chmodSync(path.join(a, 'secret.txt'), 0o000);
  fs.chmodSync(path.join(b, 'locked'), 0o000);
  t.after(() => { try { fs.chmodSync(path.join(a, 'secret.txt'), 0o644); fs.chmodSync(path.join(b, 'locked'), 0o755); } catch (_) {} });
  const r = await compare(a, b);
  const e = byName(r.entries);
  assert.strictEqual(e['x/loop'].kind, 'link');
  assert.strictEqual(e['x/loop'].status, 'same', 'links compare by target and are not followed');
  assert.strictEqual(e['loop1'].status, 'left');
  // Unicode: the NFC and NFD names pair up
  const cafe = r.entries.find(x => x.name.normalize('NFC') === nfc);
  assert.ok(cafe && cafe.l && cafe.r, 'NFC and NFD names pair');
  assert.match(cafe.note, /Unicode/);
  // Case-only rename pairs on any disk, with a note
  const readme = r.entries.find(x => x.name.toLowerCase() === 'readme.md');
  assert.ok(readme.l && readme.r);
  if (readme.l.rel !== readme.r.rel) assert.match(readme.note, /case/);
  // Unreadable folder: an error entry, the walk goes on
  if (process.getuid && process.getuid() !== 0) {
    assert.strictEqual(e['locked'].status, 'error');
    assert.match(e['locked'].note, /permission/i);
    await assert.rejects(filesEqual(path.join(a, 'secret.txt'), path.join(b, 'secret.txt')), /EACCES|permission/i);
  }
  // follow mode detects the loop instead of hanging
  const F = await walk(a, { rules: [], followSymlinks: true });
  const loop = [...F.map.values()].find(x => x.rel === 'x/loop');
  assert.ok(loop && /loop/i.test(loop.error || ''), 'loop reported when following links');
});

test('bytes: filesEqual, diffRanges with different sizes and a range cap, aligned hex dump', async (t) => {
  const w = mkWork('unit-bytes');
  t.after(() => rm(w));
  const A = path.join(w, 'a.bin'), B = path.join(w, 'b.bin'), C = path.join(w, 'c.bin');
  const buf = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
  fs.writeFileSync(A, buf);
  const b2 = Buffer.from(buf); b2[5] = 1; b2[6] = 2; b2[2 * 1024 * 1024 + 3] = 9;
  fs.writeFileSync(B, Buffer.concat([b2, Buffer.from('tail')]));
  fs.writeFileSync(C, buf);
  assert.deepStrictEqual(await filesEqual(A, C), { equal: true, changedDuringCompare: false });
  const ne = await filesEqual(A, B);
  assert.strictEqual(ne.equal, false);
  const d = await diffRanges(A, B);
  assert.strictEqual(d.diffBytes, 3 + 4);
  assert.deepStrictEqual(d.ranges.map(r => [r.start, r.end]), [[5, 7], [2 * 1024 * 1024 + 3, 2 * 1024 * 1024 + 4], [buf.length, buf.length + 4]]);
  const capped = await diffRanges(A, B, { maxRanges: 1 });
  assert.strictEqual(capped.ranges.length, 1);
  assert.ok(capped.more);
  assert.strictEqual(capped.diffBytes, 7, 'bytes are still counted after the list is full');
  const la = await hexDump(A, d.ranges, { context: 0 }), lb = await hexDump(B, d.ranges, { context: 0 });
  assert.strictEqual(la.length, lb.length, 'both sides get the same lines');
  assert.match(la[la.length - 1], /-- --/, 'bytes past the end show as --');
  assert.match(lb[0], /07 07 07 07 07 01 02 07/);
});

test('bytes: git blob id matches git hash-object; binary sniffing', async (t) => {
  const w = mkWork('unit-git-oid');
  t.after(() => rm(w));
  const f = path.join(w, 'f.txt');
  fs.writeFileSync(f, 'hello\nworld\n');
  const want = execFileSync('git', ['hash-object', f], { encoding: 'utf8' }).trim();
  assert.strictEqual(await gitBlobId(f), want);
  assert.ok(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1])));
  assert.ok(!looksBinary(Buffer.from('plain text, ünïcode\n')));
});

test('large tree: 20,000 files walk and merge in a few seconds', async (t) => {
  const w = mkWork('unit-large');
  t.after(() => rm(w));
  const a = path.join(w, 'a'), b = path.join(w, 'b');
  for (const root of [a, b]) for (let d = 0; d < 100; d++) {
    const dir = path.join(root, 'd' + d);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), root === b && d === 3 && i < 10 ? 'changed!' : 'same');
  }
  const t0 = Date.now();
  const r = await compare(a, b, { mode: 'quick' });
  const ms = Date.now() - t0;
  assert.strictEqual(r.counts.files, 10000);
  assert.ok(r.counts.changed >= 10);
  assert.ok(ms < 15000, `took ${ms} ms`);
});
