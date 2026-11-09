'use strict';
// Write guard for Copy, Sync and Merge. A destination must stay inside the folder the user picked: a symbolic link on
// the target side is replaced, never written through, and a target folder that is a link to somewhere else is refused.
const fs = require('fs');
const path = require('path');

const inside = (real, realRoot) => real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);

/** Call before writing dst under root. Throws when dst's existing parent resolves outside root; removes a link at dst. */
async function guardDest(root, dst) {
  const realRoot = await fs.promises.realpath(root);
  let p = path.dirname(dst);
  for (;;) {
    try { await fs.promises.lstat(p); break; } catch (_) { const up = path.dirname(p); if (up === p) break; p = up; }
  }
  const real = await fs.promises.realpath(p);
  if (!inside(real, realRoot)) throw new Error(`not written: ${path.relative(root, p) || '.'} is a link to ${real}, outside ${root}`);
  const st = await fs.promises.lstat(dst).catch(() => null);
  if (st && st.isSymbolicLink()) await fs.promises.rm(dst, { force: true });
}

module.exports = { guardDest };
