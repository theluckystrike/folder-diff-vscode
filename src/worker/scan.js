'use strict';
// Worker thread: walks both sides, pairs the entries, then compares the bytes of same-size pairs.
// The extension host stays free the whole time; Cancel terminates this thread.
const { parentPort } = require('worker_threads');
const path = require('path');
const { walk } = require('../core/walk');
const { merge } = require('../core/compare');
const { parseGlobs } = require('../core/ignore');
const { filesEqual, gitBlobId } = require('../core/bytes');
const git = require('../core/git');

let stop = false;
const post = m => parentPort.postMessage(m);

async function side(spec, job, label) {
  if (spec.kind === 'git') {
    const r = await git.lsTree(spec.cwd, spec.ref, job.exclude);
    if (!r.ok) throw new Error(r.error);
    // Symbolic links in a commit store their target as the blob text: read those few so links compare by target.
    for (const e of r.map.values()) {
      if (e.kind !== 'link') continue;
      const b = await git.catBlob(spec.cwd, e.oid, 1 << 16);
      if (b.ok) e.target = b.bytes.toString('utf8');
    }
    return { ...r, root: spec.cwd };
  }
  let n = 0;
  const res = await walk(spec.path, {
    rules: parseGlobs(job.exclude), useGitignore: job.useGitignore !== false, followSymlinks: !!job.followSymlinks,
    shouldStop: () => stop, maxEntries: job.maxEntries,
    onProgress: c => { n = c; post({ type: 'progress', phase: 'scan', side: label, done: n }); },
  });
  return { ...res, root: spec.path };
}

async function run(job) {
  const t0 = Date.now();
  post({ type: 'progress', phase: 'scan', side: 'left', done: 0 });
  const [L, R] = await Promise.all([side(job.left, job, 'left'), side(job.right, job, 'right')]);
  if (stop) return;
  const mode = job.left.kind === 'git' ? 'git' : job.mode;
  const { entries, counts } = merge(L.map, R.map, { mode, mtimeToleranceMs: job.mtimeToleranceMs });
  L.map.clear(); R.map.clear();
  post({
    type: 'tree', entries, counts, ms: Date.now() - t0,
    info: { left: { files: L.files, dirs: L.dirs, bytes: L.bytes, capped: !!L.capped }, right: { files: R.files, dirs: R.dirs, bytes: R.bytes, capped: !!R.capped } },
  });
  const pend = entries.filter(e => e.status === 'pending' && e.kind !== 'dir');
  const bytesTotal = pend.reduce((s, e) => s + (e.r ? e.r.size : 0) * (mode === 'git' ? 1 : 1), 0);
  let bytesDone = 0, done = 0, lastPost = Date.now();
  let batch = [];
  const flush = (force) => {
    if (!batch.length && !force) return;
    post({ type: 'update', changes: batch, done, total: pend.length, bytesDone, bytesTotal });
    batch = [];
    lastPost = Date.now();
  };
  const algo = mode === 'git' ? await git.objectFormat(job.left.cwd) : null;
  let next = 0;
  // Many small files: more reads in flight. Few big files: 4, so two disks are not thrashed.
  const small = pend.length > 0 && bytesTotal / pend.length < 256 * 1024;
  const workers = Math.max(1, Math.min(16, small ? 16 : job.concurrency || 4));
  const onBytes = n => { bytesDone += n; };
  async function one(e) {
    const a = path.join(L.root, ...e.l.rel.split('/'));
    const b = path.join(R.root, ...e.r.rel.split('/'));
    let status, note = e.note || '';
    try {
      if (mode === 'git') {
        const oid = await gitBlobId(b, algo, { onBytes, shouldStop: () => stop });
        status = oid === e.l.oid ? 'same' : 'changed';
      } else {
        const r = await filesEqual(a, b, { onBytes, shouldStop: () => stop, expectSize: e.l.size === e.r.size ? e.l.size : null });
        if (r.stopped) return;
        status = r.equal ? 'same' : 'changed';
        if (r.changedDuringCompare) { note = (note ? note + '. ' : '') + 'The file changed while it was compared. Refresh to compare again'; if (r.equal) status = 'changed'; }
      }
    } catch (err) {
      status = 'error';
      const code = err && err.code;
      note = code === 'EACCES' || code === 'EPERM' ? 'No permission to read' : code === 'ENOENT' ? 'Removed during the compare' : String((err && err.message) || err).slice(0, 200);
    }
    batch.push([e.i, status, note]);
    done++;
    if (Date.now() - lastPost > 200) flush();
  }
  const timer = setInterval(() => { if (!stop) post({ type: 'progress', phase: 'content', done, total: pend.length, bytesDone, bytesTotal }); }, 300);
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (!stop && next < pend.length) await one(pend[next++]);
    }));
  } finally { clearInterval(timer); }
  flush(true);
  post({ type: 'done', ms: Date.now() - t0 });
}

parentPort.on('message', m => {
  if (m && m.type === 'stop') { stop = true; return; }
  if (m && m.type === 'start') {
    run(m.job).catch(err => post({ type: 'fatal', message: String((err && err.message) || err).slice(0, 400), code: err && err.code }));
  }
});
