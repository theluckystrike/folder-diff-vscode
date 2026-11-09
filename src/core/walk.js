'use strict';
// Walks one folder tree and returns every entry with its type, size and modified time. Runs in the worker.
// Symbolic links are listed with their target and not followed, so a link loop cannot hang the walk.
// A folder or file that cannot be read becomes an entry with an error message; the walk goes on.
const fs = require('fs');
const path = require('path');
const { isIgnored, parseGitignore } = require('./ignore');

const STAT_BATCH = 64;

/** The key that pairs entries of the two sides: NFC, so "é" typed as one or two code points matches. */
function keyOf(rel) { return rel.normalize('NFC'); }

function errText(e) {
  const code = e && e.code;
  if (code === 'EACCES' || code === 'EPERM') return 'No permission to read';
  if (code === 'ENOENT') return 'Removed during the compare';
  if (code === 'ELOOP') return 'Symbolic link loop';
  if (code === 'ENAMETOOLONG') return 'Path is too long';
  return (e && e.message ? e.message : String(e)).slice(0, 200);
}

/**
 * @param {string} root absolute folder path
 * @param {{rules?:object[], useGitignore?:boolean, followSymlinks?:boolean, shouldStop?:()=>boolean,
 *          onProgress?:(n:number)=>void, maxEntries?:number}} opts
 * @returns {Promise<{map:Map<string,object>, files:number, dirs:number, bytes:number, stopped:boolean, capped:boolean}>}
 */
async function walk(root, opts = {}) {
  const rules = [...(opts.rules || [])];
  const map = new Map();
  const maxEntries = opts.maxEntries || 2000000;
  const shouldStop = opts.shouldStop || (() => false);
  const res = { map, files: 0, dirs: 0, bytes: 0, stopped: false, capped: false };
  const seenReal = new Set();
  // Stack of folders to read: [absolute path, rel path, rules that apply]
  const stack = [[root, '', rules]];
  if (opts.followSymlinks) { try { seenReal.add(fs.realpathSync(root)); } catch (_) {} }
  let lastReport = 0;
  while (stack.length) {
    if (shouldStop()) { res.stopped = true; break; }
    const [abs, rel, dirRules] = stack.pop();
    let names;
    try {
      names = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if (rel) { const ent = map.get(keyOf(rel)); if (ent) { ent.error = errText(e); } }
      else throw e;
      continue;
    }
    let here = dirRules;
    if (opts.useGitignore && names.some(d => d.name === '.gitignore' && (d.isFile() || d.isSymbolicLink()))) {
      try {
        const txt = await fs.promises.readFile(path.join(abs, '.gitignore'), 'utf8');
        here = dirRules.concat(parseGitignore(txt.slice(0, 1 << 20), rel));
      } catch (_) { /* unreadable .gitignore: ignore it */ }
    }
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      const part = names.slice(i, i + STAT_BATCH);
      await Promise.all(part.map(async d => {
        const name = d.name;
        const childRel = rel ? rel + '/' + name : name;
        const childAbs = path.join(abs, name);
        const looksDir = d.isDirectory();
        if (isIgnored(here, childRel, looksDir)) return;
        if (map.size >= maxEntries) { res.capped = true; return; }
        const ent = { rel: childRel, name, kind: 'other', size: 0, mtimeMs: 0 };
        try {
          const st = await fs.promises.lstat(childAbs);
          ent.mtimeMs = Math.floor(st.mtimeMs);
          if (st.isSymbolicLink()) {
            ent.kind = 'link';
            try { ent.target = await fs.promises.readlink(childAbs); } catch (e) { ent.error = errText(e); }
            if (opts.followSymlinks && !ent.error) {
              try {
                const real = await fs.promises.realpath(childAbs);
                const st2 = await fs.promises.stat(childAbs);
                if (st2.isDirectory()) {
                  if (seenReal.has(real)) ent.error = 'Symbolic link loop (not followed)';
                  else { seenReal.add(real); ent.kind = 'dir'; stack.push([childAbs, childRel, here]); }
                } else if (st2.isFile()) { ent.kind = 'file'; ent.size = st2.size; ent.mtimeMs = Math.floor(st2.mtimeMs); }
              } catch (e) { ent.error = errText(e); }
            }
          } else if (st.isDirectory()) {
            ent.kind = 'dir';
            if (opts.followSymlinks) { try { seenReal.add(await fs.promises.realpath(childAbs)); } catch (_) {} }
            stack.push([childAbs, childRel, here]);
          } else if (st.isFile()) {
            ent.kind = 'file';
            ent.size = st.size;
          }
        } catch (e) { ent.error = errText(e); ent.kind = looksDir ? 'dir' : 'file'; }
        if (ent.kind === 'file') { res.files++; res.bytes += ent.size; }
        else if (ent.kind === 'dir') res.dirs++;
        map.set(keyOf(childRel), ent);
      }));
    }
    if (opts.onProgress && map.size - lastReport >= 2000) { lastReport = map.size; opts.onProgress(map.size); }
  }
  return res;
}

module.exports = { walk, keyOf, errText };
