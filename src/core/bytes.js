'use strict';
// Streaming byte work on files: equal-or-not, the ranges that differ (for the binary diff), and Git blob ids.
// Every function reads in 1 MB steps with two reused buffers, so a 4 GB file costs 2 MB of memory.
const fs = require('fs');
const crypto = require('crypto');

const CHUNK = 1 << 20;

async function readFull(fh, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got;
}

/**
 * Compares two files byte by byte. Stops at the first difference.
 * @returns {Promise<{equal:boolean, offset?:number, stopped?:boolean, changedDuringCompare?:boolean}>}
 */
const SMALL = 256 * 1024;

async function filesEqual(a, b, opts = {}) {
  const shouldStop = opts.shouldStop || (() => false);
  // Small files (most of a source tree): one read each. A length that differs from the size the walk saw means
  // the file changed in between.
  if (opts.expectSize != null && opts.expectSize <= SMALL) {
    const [x, y] = await Promise.all([fs.promises.readFile(a), fs.promises.readFile(b)]);
    if (opts.onBytes) opts.onBytes(x.length);
    const moved = x.length !== opts.expectSize || y.length !== opts.expectSize;
    if (x.length !== y.length) return { equal: false, offset: Math.min(x.length, y.length), changedDuringCompare: moved };
    if (x.equals(y)) return { equal: true, changedDuringCompare: moved };
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    return { equal: false, offset: i, changedDuringCompare: moved };
  }
  const sa0 = await fs.promises.stat(a), sb0 = await fs.promises.stat(b);
  if (sa0.size !== sb0.size) return { equal: false, offset: Math.min(sa0.size, sb0.size) };
  const fa = await fs.promises.open(a, 'r');
  let fb;
  try {
    fb = await fs.promises.open(b, 'r');
    const ba = opts.bufA || Buffer.allocUnsafe(CHUNK), bb = opts.bufB || Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    const size = sa0.size;
    while (pos < size) {
      if (shouldStop()) return { equal: false, stopped: true };
      const n = Math.min(CHUNK, size - pos);
      const [x, y] = await Promise.all([readFull(fa, ba, n, pos), readFull(fb, bb, n, pos)]);
      if (x !== n || y !== n) return { equal: false, offset: pos + Math.min(x, y), changedDuringCompare: true };
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) {
        let i = 0;
        while (i < n && ba[i] === bb[i]) i++;
        const sa1 = await fa.stat(), sb1 = await fb.stat();
        const moved = sa1.size !== sa0.size || sb1.size !== sb0.size || sa1.mtimeMs !== sa0.mtimeMs || sb1.mtimeMs !== sb0.mtimeMs;
        return { equal: false, offset: pos + i, changedDuringCompare: moved };
      }
      pos += n;
      if (opts.onBytes) opts.onBytes(n);
    }
    const sa1 = await fa.stat(), sb1 = await fb.stat();
    const moved = sa1.size !== sa0.size || sb1.size !== sb0.size || sa1.mtimeMs !== sa0.mtimeMs || sb1.mtimeMs !== sb0.mtimeMs;
    return { equal: true, changedDuringCompare: moved };
  } finally {
    await fa.close().catch(() => {});
    if (fb) await fb.close().catch(() => {});
  }
}

/**
 * Lists the byte ranges that differ (offset N of one file against offset N of the other). Ranges closer than
 * `join` bytes are merged. Bytes past the end of the shorter file form one last range.
 * @returns {Promise<{ranges:{start:number,end:number}[], diffBytes:number, more:boolean, sizeA:number, sizeB:number, stopped?:boolean}>}
 */
async function diffRanges(a, b, opts = {}) {
  const maxRanges = opts.maxRanges || 500;
  const join = opts.join == null ? 16 : opts.join;
  const shouldStop = opts.shouldStop || (() => false);
  const fa = await fs.promises.open(a, 'r');
  let fb;
  try {
    fb = await fs.promises.open(b, 'r');
    const sizeA = (await fa.stat()).size, sizeB = (await fb.stat()).size;
    const min = Math.min(sizeA, sizeB), max = Math.max(sizeA, sizeB);
    const ba = Buffer.allocUnsafe(CHUNK), bb = Buffer.allocUnsafe(CHUNK);
    const ranges = [];
    let diffBytes = 0, more = false, cur = null, pos = 0;
    while (pos < min) {
      if (shouldStop()) return { ranges, diffBytes, more: true, sizeA, sizeB, stopped: true };
      const n = Math.min(CHUNK, min - pos);
      const [x, y] = await Promise.all([readFull(fa, ba, n, pos), readFull(fb, bb, n, pos)]);
      const m = Math.min(x, y);
      if (!(m === n && ba.subarray(0, n).equals(bb.subarray(0, n)))) {
        for (let i = 0; i < m; i++) {
          if (ba[i] === bb[i]) continue;
          const off = pos + i;
          diffBytes++;
          if (more) continue; // the list is full: only count from here on
          if (cur && off - cur.end <= join) cur.end = off + 1;
          else {
            if (cur) ranges.push(cur);
            cur = null;
            if (ranges.length >= maxRanges) { more = true; continue; }
            cur = { start: off, end: off + 1 };
          }
        }
      }
      pos += n;
      if (opts.onBytes) opts.onBytes(n);
    }
    if (cur) ranges.push(cur);
    if (max > min) {
      diffBytes += max - min;
      const last = ranges[ranges.length - 1];
      if (more) { /* list full */ }
      else if (last && min - last.end <= join) last.end = max;
      else if (ranges.length < maxRanges) ranges.push({ start: min, end: max });
      else more = true;
    }
    return { ranges: ranges.slice(0, maxRanges), diffBytes, more, sizeA, sizeB };
  } finally {
    await fa.close().catch(() => {});
    if (fb) await fb.close().catch(() => {});
  }
}

const hex2 = b => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const printable = b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.');

/**
 * Hex dump lines (16 bytes each) for the given ranges plus `context` lines around them, read from one file.
 * Both sides get the same line layout, so VS Code's diff editor lines them up and marks the changed bytes.
 * A byte past the end of the file shows as "--".
 */
async function hexDump(file, ranges, opts = {}) {
  const context = opts.context == null ? 1 : opts.context;
  const maxLines = opts.maxLines || 4000;
  const fh = await fs.promises.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const width = Math.max(8, Math.ceil(Math.log2(Math.max(2, opts.width || size + 1)) / 4));
    const lines = [];
    let lastLine = -1;
    const buf = Buffer.allocUnsafe(16);
    for (const r of ranges) {
      const from = Math.max(0, Math.floor(r.start / 16) - context);
      const to = Math.floor((r.end - 1) / 16) + context;
      if (lastLine >= 0 && from > lastLine + 1) lines.push('   ...');
      for (let ln = Math.max(from, lastLine + 1); ln <= to; ln++) {
        if (lines.length >= maxLines) { lines.push(`(stopped after ${maxLines} lines)`); return lines; }
        const off = ln * 16;
        const got = off < size ? await readFull(fh, buf, Math.min(16, size - off), off) : 0;
        let h = '', asc = '';
        for (let i = 0; i < 16; i++) {
          if (i === 8) h += ' ';
          if (i < got) { h += hex2(buf[i]) + ' '; asc += printable(buf[i]); } else { h += '-- '; asc += ' '; }
        }
        lines.push(off.toString(16).toUpperCase().padStart(width, '0') + '  ' + h + ' |' + asc + '|');
        lastLine = ln;
      }
    }
    return lines;
  } finally { await fh.close().catch(() => {}); }
}

/** Git's object id of a file: sha1 (or sha256) of "blob <size>\0" + bytes, streamed. */
async function gitBlobId(file, algo = 'sha1', opts = {}) {
  const st = await fs.promises.stat(file);
  const h = crypto.createHash(algo === 'sha256' ? 'sha256' : 'sha1');
  h.update(`blob ${st.size}\0`);
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file, { highWaterMark: CHUNK });
    s.on('data', d => { h.update(d); if (opts.onBytes) opts.onBytes(d.length); if (opts.shouldStop && opts.shouldStop()) s.destroy(new Error('stopped')); });
    s.on('error', reject);
    s.on('end', resolve);
  });
  return h.digest('hex');
}

/** True when the first 8000 bytes have a NUL byte or are mostly control bytes (git's binary test plus a bit). */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

async function headBytes(file, n = 8000) {
  const fh = await fs.promises.open(file, 'r');
  try { const b = Buffer.alloc(n); const got = await readFull(fh, b, n, 0); return b.subarray(0, got); } finally { await fh.close().catch(() => {}); }
}

module.exports = { filesEqual, diffRanges, hexDump, gitBlobId, looksBinary, headBytes, readFull, CHUNK };
