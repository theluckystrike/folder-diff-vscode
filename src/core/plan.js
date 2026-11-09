'use strict';
// Plans for Copy, Delete, Sync and the three-way merge. A plan is a plain list that the user sees in full
// before anything is written; the executor then does exactly that list. Pure: no file access here.

/** Indexes of the entry and everything below it (entries are in tree order, children follow their folder). */
function subtree(entries, i) {
  const out = [i];
  const d = entries[i].depth;
  for (let j = i + 1; j < entries.length && entries[j].depth > d; j++) out.push(j);
  return out;
}

/** Unique, sorted index list of the selection with every folder expanded to its subtree. */
function expand(entries, selected) {
  const set = new Set();
  for (const i of selected) {
    if (!entries[i]) continue;
    for (const j of subtree(entries, i)) set.add(j);
  }
  return [...set].sort((a, b) => a - b);
}

const isLeafKind = k => k === 'file' || k === 'link' || k === 'mixed';

/**
 * Copy plan. dir 'toRight' copies left versions over the right side, 'toLeft' the other way.
 * Only files and links that differ or are missing on the target are listed; equal files are skipped.
 * @returns {{items:{rel:string, srcRel:string, kind:string, action:'create'|'overwrite'}[], skipped:number, blocked:string[]}}
 */
function planCopy(entries, selected, dir) {
  const src = dir === 'toRight' ? 'l' : 'r';
  const dst = dir === 'toRight' ? 'r' : 'l';
  const items = [], blocked = [];
  let skipped = 0;
  for (const i of expand(entries, selected)) {
    const e = entries[i];
    const s = e[src], t = e[dst];
    if (!s) continue;
    if (e.kind === 'dir' && s.kind === 'dir') continue; // folders are created as needed
    if (!isLeafKind(s.kind)) { skipped++; continue; }
    if (s.error) { blocked.push(`${s.rel}: ${s.error}`); continue; }
    if (t && t.kind === 'dir') { blocked.push(`${s.rel}: a folder with this name is on the other side`); continue; }
    if (t && e.status === 'same') { skipped++; continue; }
    items.push({ rel: t ? t.rel : targetRel(entries, e, dst, s.rel), srcRel: s.rel, kind: s.kind, action: t ? 'overwrite' : 'create', size: s.size || 0 });
  }
  return { items, skipped, blocked };
}

/** Where a new file goes: under the target side's spelling of the parent folder, so case-paired folders work. */
function targetRel(entries, e, dst, srcRel) {
  const name = srcRel.slice(srcRel.lastIndexOf('/') + 1);
  if (!e.parent) return name;
  const p = entries.find(x => x.key === e.parent);
  if (p && p[dst]) return p[dst].rel + '/' + name;
  return srcRel;
}

/**
 * Delete plan for one side. A selected folder is deleted as a whole (one item, with the file count below it).
 * @returns {{items:{rel:string, kind:string, files:number}[]}}
 */
function planDelete(entries, selected, side) {
  const k = side === 'left' ? 'l' : 'r';
  const items = [];
  const covered = new Set();
  for (const i of [...new Set(selected)].sort((a, b) => a - b)) {
    const e = entries[i];
    if (!e || covered.has(i) || !e[k]) continue;
    const sub = subtree(entries, i);
    sub.forEach(j => covered.add(j));
    const files = e.kind === 'dir' ? sub.filter(j => entries[j][k] && entries[j][k].kind !== 'dir').length : 1;
    items.push({ rel: e[k].rel, kind: e[k].kind, files });
  }
  return { items };
}

/**
 * Sync plan (Pro candidate). 'mirrorRight': make the right side equal to the left (copy changed and left-only
 * files, delete right-only entries). 'mirrorLeft': the other way. 'update': both ways, newer file wins, only
 * missing files are copied and nothing is deleted.
 */
function planSync(entries, how) {
  const copyToRight = [], copyToLeft = [], deleteRight = [], deleteLeft = [];
  const skip = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (skip.has(i)) continue;
    const e = entries[i];
    if (e.status === 'same' || e.status === 'pending' || e.status === 'error') continue;
    if (e.kind === 'dir' && e.l && e.r) continue;
    if (how === 'mirrorRight' || how === 'mirrorLeft') {
      const toRight = how === 'mirrorRight';
      const onlyTarget = toRight ? e.status === 'right' : e.status === 'left';
      if (onlyTarget) { (toRight ? deleteRight : deleteLeft).push(i); subtree(entries, i).forEach(j => skip.add(j)); continue; }
      if (e.kind === 'dir') continue; // a source-only folder: its files are listed one by one
      (toRight ? copyToRight : copyToLeft).push(i);
    } else {
      if (e.kind === 'dir') continue;
      if (e.status === 'left') copyToRight.push(i);
      else if (e.status === 'right') copyToLeft.push(i);
      else if (e.status === 'changed' && e.l && e.r && e.l.kind === 'file' && e.r.kind === 'file') {
        if ((e.l.mtimeMs || 0) > (e.r.mtimeMs || 0)) copyToRight.push(i);
        else if ((e.r.mtimeMs || 0) > (e.l.mtimeMs || 0)) copyToLeft.push(i);
      }
    }
  }
  return {
    copyToRight: planCopy(entries, copyToRight, 'toRight'),
    copyToLeft: planCopy(entries, copyToLeft, 'toLeft'),
    deleteRight: planDelete(entries, deleteRight, 'right'),
    deleteLeft: planDelete(entries, deleteLeft, 'left'),
  };
}

/**
 * Three-way plan (Pro candidate). baseLeft and baseRight are the merge() entries of (base, left) and
 * (base, right); leftRightSame(key) tells whether the left and right files are equal (both changed the same way).
 * Each path gets one of: unchanged, left (only the left side changed it), right, both-same, conflict.
 * The merge writes into the base folder: the one changed version, or nothing for a conflict.
 */
function plan3(baseLeft, baseRight, leftRightSame) {
  const files = new Map();
  const add = (entries, side) => {
    for (const e of entries) {
      if (e.kind === 'dir') continue;
      if (!files.has(e.key)) files.set(e.key, { key: e.key, rel: (e.l || e.r).rel, base: e.l || null, left: null, right: null, statusLeft: 'same', statusRight: 'same' });
      const f = files.get(e.key);
      if (!f.base && e.l) f.base = e.l;
      f[side] = e.r || null;
      f[side === 'left' ? 'statusLeft' : 'statusRight'] = e.status === 'left' ? 'deleted' : e.status === 'right' ? 'added' : e.status;
    }
  };
  add(baseLeft, 'left');
  add(baseRight, 'right');
  const rows = [];
  for (const f of files.values()) {
    const L = f.statusLeft, R = f.statusRight;
    let result;
    if (L === 'same' && R === 'same') result = 'unchanged';
    else if (L === 'error' || R === 'error') result = 'error';
    else if (L !== 'same' && R === 'same') result = 'left';
    else if (R !== 'same' && L === 'same') result = 'right';
    else if (L === 'deleted' && R === 'deleted') result = 'both-same';
    else if (L !== 'deleted' && R !== 'deleted' && leftRightSame && leftRightSame(f.key)) result = 'both-same';
    else result = 'conflict';
    // A file missing in base and added on one side shows in only one entry list; the other list has nothing.
    if (!f.base && (!f.left || !f.right) && result === 'conflict') result = f.left ? 'left' : 'right';
    let action = 'none';
    if (result === 'left' || (result === 'both-same' && f.left)) action = f.left ? 'copyLeft' : 'delete';
    else if (result === 'right') action = f.right ? 'copyRight' : 'delete';
    else if (result === 'both-same' && !f.left && !f.right) action = f.base ? 'delete' : 'none';
    rows.push({ rel: f.rel, key: f.key, left: L, right: R, result, action, leftRel: f.left && f.left.rel, rightRel: f.right && f.right.rel, baseRel: f.base && f.base.rel });
  }
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return rows;
}

module.exports = { subtree, expand, planCopy, planDelete, planSync, plan3 };
