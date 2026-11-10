'use strict';
// Write guard for Copy, Sync, Delete and Merge. A destination must stay inside the folder the user picked: a symbolic
// link on the target side is replaced, never written through, and a target folder that is a link to somewhere else is
// refused. A delete removes a link itself, never what it points to, and never goes through a linked parent folder.
const fs = require('fs');
const path = require('path');

const inside = (real, realRoot) => real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);

/** The nearest existing folder at or above p. */
async function existingParent(p) {
  for (;;) {
    try { await fs.promises.lstat(p); return p; } catch (_) { const up = path.dirname(p); if (up === p) return p; p = up; }
  }
}

/** Call before writing dst under root. Throws when dst's existing parent resolves outside root; removes a link at dst. */
async function guardDest(root, dst) {
  const realRoot = await fs.promises.realpath(root);
  if (!inside(path.resolve(dst), path.resolve(root))) throw new Error(`not written: ${dst} is outside ${root}`);
  const p = await existingParent(path.dirname(dst));
  const real = await fs.promises.realpath(p);
  if (!inside(real, realRoot)) throw new Error(`not written: ${path.relative(root, p) || '.'} is a link to ${real}, outside ${root}`);
  const st = await fs.promises.lstat(dst).catch(() => null);
  if (st && st.isSymbolicLink()) await fs.promises.rm(dst, { force: true });
}

/** Call before deleting target under root. Throws when target is outside root or its parent folder resolves outside
 * root (a linked folder on the way). The target itself may be a link: the delete then removes only the link. */
async function guardDelete(root, target) {
  if (path.resolve(target) === path.resolve(root)) throw new Error(`not deleted: ${target} is the compared folder itself`);
  if (!inside(path.resolve(target), path.resolve(root))) throw new Error(`not deleted: ${target} is outside ${root}`);
  const realRoot = await fs.promises.realpath(root);
  const realParent = await fs.promises.realpath(path.dirname(target));
  if (!inside(realParent, realRoot)) throw new Error(`not deleted: ${path.relative(root, path.dirname(target)) || '.'} is a link to ${realParent}, outside ${root}`);
}

module.exports = { guardDest, guardDelete };
