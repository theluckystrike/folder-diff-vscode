'use strict';
// Pairs the entries of the left and right walks and gives each one a status. Pure: no file access here.
// Status of a file pair:
//   same      equal (by size and time in Quick mode, by bytes in Content mode)
//   changed   different
//   pending   same size; the bytes are being compared (Content mode)
//   left      only on the left       right   only on the right
//   error     one side could not be read (the note says why)
// A folder is "changed" when anything below it differs, so collapsed folders still show where to look.

const STATUSES = ['same', 'changed', 'pending', 'left', 'right', 'error'];

function sideOf(e) {
  if (!e) return null;
  const s = { kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, rel: e.rel };
  if (e.error) s.error = e.error;
  if (e.target !== undefined) s.target = e.target;
  if (e.oid) s.oid = e.oid;
  return s;
}

/**
 * Quick status of one pair, before any byte is read.
 * @param {object|null} l @param {object|null} r
 * @param {{mode:'quick'|'content'|'git', mtimeToleranceMs:number}} o
 */
function quickStatus(l, r, o) {
  if (!l) return { status: 'right' };
  if (!r) return { status: 'left' };
  if (l.error || r.error) return { status: 'error', note: (l.error ? 'Left: ' + l.error : '') + (l.error && r.error ? '. ' : '') + (r.error ? 'Right: ' + r.error : '') };
  if (l.kind !== r.kind) return { status: 'changed', note: `A ${l.kind} on the left, a ${r.kind} on the right` };
  if (l.kind === 'dir') return { status: 'same' };
  if (l.kind === 'link') return l.target === r.target ? { status: 'same' } : { status: 'changed', note: 'Links point to different targets' };
  if (l.kind !== 'file') return { status: 'same' };
  if (l.size !== r.size) return { status: 'changed' };
  if (o.mode === 'git') return l.oid ? { status: 'pending' } : { status: 'same' };
  const sameTime = Math.abs((l.mtimeMs || 0) - (r.mtimeMs || 0)) <= (o.mtimeToleranceMs == null ? 2000 : o.mtimeToleranceMs);
  if (o.mode === 'quick') return sameTime ? { status: 'same' } : { status: 'changed', note: 'Same size, different modified time (Quick mode does not read the bytes)' };
  if (l.size === 0) return { status: 'same' };
  return { status: 'pending' };
}

/** Parent folder of a POSIX rel path, '' for the top level. */
function parentOf(rel) { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); }

/**
 * Merges two walk maps (key -> entry) into one flat list in tree order: folders first, then files, by name.
 * @returns {{entries:object[], counts:object}}
 */
function merge(leftMap, rightMap, o = {}) {
  const opts = { mode: o.mode || 'content', mtimeToleranceMs: o.mtimeToleranceMs };
  const pairs = new Map();
  for (const [k, e] of leftMap) pairs.set(k, { key: k, l: e, r: null });
  for (const [k, e] of rightMap) { const p = pairs.get(k); if (p) p.r = e; else pairs.set(k, { key: k, l: null, r: e }); }

  // Case-only renames: on a case-insensitive disk "Readme.md" and "README.md" are the same file. Pair an
  // unmatched left entry with an unmatched right entry when the names differ only in case and nothing else
  // in the same folder claims them.
  if (o.pairCase !== false) {
    const byLower = new Map();
    for (const p of pairs.values()) {
      if (p.l && p.r) continue;
      const lk = p.key.toLowerCase();
      if (!byLower.has(lk)) byLower.set(lk, []);
      byLower.get(lk).push(p);
    }
    for (const group of byLower.values()) {
      if (group.length !== 2) continue;
      const a = group.find(p => p.l), b = group.find(p => p.r);
      if (!a || !b || a === b) continue;
      a.r = b.r;
      if (a.l.name !== b.r.name) a.caseNote = `Names differ only in case: "${a.l.name}" and "${b.r.name}"`;
      pairs.delete(b.key);
    }
  }

  // Folders that exist only through a case-paired parent keep their own key: show them under the left name.
  const nodes = [];
  for (const p of pairs.values()) {
    const l = sideOf(p.l), r = sideOf(p.r);
    const q = quickStatus(l, r, opts);
    const rel = (p.l || p.r).rel;
    const name = (p.l || p.r).name;
    const notes = [];
    if (q.note) notes.push(q.note);
    if (p.caseNote) notes.push(p.caseNote);
    else if (p.l && p.r && p.l.rel !== p.r.rel) notes.push('Names use different Unicode forms (NFC and NFD)');
    nodes.push({ key: p.key, rel, name, parent: parentOf(p.key), kind: (l || r).kind === 'dir' || (l && r && (l.kind === 'dir' || r.kind === 'dir') && l.kind === r.kind) ? 'dir' : (l || r).kind, l, r, status: q.status, note: notes.join('. ') });
  }
  // Mixed kinds (file on one side, folder on the other) are shown as a file row: its children are only on one side.
  for (const n of nodes) if (n.l && n.r && n.l.kind !== n.r.kind) n.kind = 'mixed';

  const byKey = new Map(nodes.map(n => [n.key, n]));
  // A case-paired folder: its children were listed under the left spelling on the left and the right spelling on
  // the right. Move the right children under the left spelling, so they pair up.
  const kids = new Map();
  let dirByLower = null;
  for (const n of nodes) {
    let parent = n.parent;
    if (!byKey.has(parent) && parent) {
      // Parent key unknown: its folder was case-paired under another key. Find it by lower-case key.
      if (!dirByLower) { dirByLower = new Map(); for (const m of nodes) if (m.kind === 'dir') dirByLower.set(m.key.toLowerCase(), m.key); }
      parent = dirByLower.get(parent.toLowerCase()) || parent;
    }
    n.parent = parent;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(n);
  }
  const cmp = (a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1, bd = b.kind === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const x = a.name.toLowerCase(), y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  const entries = [];
  const visit = (parentKey, depth) => {
    const list = kids.get(parentKey);
    if (!list) return;
    list.sort(cmp);
    for (const n of list) {
      n.depth = depth;
      entries.push(n);
      if (n.kind === 'dir') visit(n.key, depth + 1);
    }
  };
  visit('', 0);
  // Anything not reached (should not happen) goes at the end, so no entry is lost.
  if (entries.length < nodes.length) {
    const seen = new Set(entries);
    for (const n of nodes) if (!seen.has(n)) { n.depth = 0; entries.push(n); }
  }
  entries.forEach((e, i) => { e.i = i; });
  rollup(entries);
  return { entries, counts: countStatuses(entries) };
}

/** Folder status from the children: changed when any child differs or is pending; recomputed after updates. */
function rollup(entries) {
  // Children come after their folder in tree order, so walk backwards and push the state up.
  const state = new Map();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'dir') {
      const s = state.get(e.key) || { diff: false, pending: false, error: false };
      if (e.l && e.r && !e.l.error && !e.r.error) e.status = s.pending && !s.diff ? 'pending' : (s.diff || s.error ? 'changed' : 'same');
      else if (e.l && e.r) e.status = 'error';
      else e.status = e.l ? 'left' : 'right';
      e.dirty = s.diff || s.error;
    }
    const p = e.parent;
    if (!state.has(p)) state.set(p, { diff: false, pending: false, error: false });
    const ps = state.get(p);
    if (e.status === 'pending') ps.pending = true;
    else if (e.status !== 'same') { if (e.status === 'error') ps.error = true; else ps.diff = true; }
    if (e.kind === 'dir' && e.dirty) ps.diff = true;
  }
}

/** File-level counts (folders are not counted). */
function countStatuses(entries) {
  const c = { same: 0, changed: 0, pending: 0, left: 0, right: 0, error: 0, files: 0, folders: 0 };
  for (const e of entries) {
    if (e.kind === 'dir') { c.folders++; if (e.status === 'error') c.error++; continue; }
    c.files++;
    c[e.status] = (c[e.status] || 0) + 1;
  }
  return c;
}

module.exports = { merge, quickStatus, rollup, countStatuses, parentOf, STATUSES };
