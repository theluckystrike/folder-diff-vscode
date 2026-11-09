'use strict';
// The Git side of "Compare Folder with Git Ref". git runs without a shell, with repository hooks and the
// fsmonitor command switched off, so a compare never runs code from the repository config.
// Only plumbing commands are used: rev-parse, for-each-ref, ls-tree and cat-file (no textconv, smudge or LFS).
const { execFile } = require('child_process');
const { parseGlobs, isIgnored } = require('./ignore');
const { keyOf } = require('./walk');

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '--no-optional-locks'];

function runGit(args, cwd, opts = {}) {
  const run = opts.exec || execFile;
  return new Promise(resolve => {
    run('git', [...SAFE, ...args], { cwd, encoding: 'buffer', maxBuffer: opts.maxBuffer || 512 * 1024 * 1024, timeout: opts.timeout || 60000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.length ? stderr.toString('utf8') : String(err.message || err)).trim();
        return resolve({ ok: false, code: err.code, error: friendly(msg, err.code) });
      }
      resolve({ ok: true, stdout });
    });
  });
}

function friendly(msg, code) {
  if (code === 'ENOENT') return 'Git is not installed or not on the PATH.';
  if (/not a git repository/i.test(msg)) return 'This folder is not in a Git repository.';
  if (/unknown revision|bad revision|not a valid object name|invalid object name|Needed a single revision/i.test(msg)) return 'Git does not know that ref.';
  if (/maxBuffer/i.test(msg) || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'The Git output is too large.';
  return 'Git: ' + msg.slice(0, 300);
}

/** Branches, tags and HEAD for the ref picker. */
async function listRefs(cwd, opts) {
  const r = await runGit(['for-each-ref', '--format=%(refname:short)%09%(objecttype)%09%(committerdate:short)', '--sort=-committerdate', '--count=200', 'refs/heads', 'refs/tags', 'refs/remotes'], cwd, opts);
  if (!r.ok) return r;
  const refs = r.stdout.toString('utf8').split('\n').filter(Boolean).map(l => { const [name, type, date] = l.split('\t'); return { name, type, date }; })
    .filter(x => !/\/HEAD$/.test(x.name));
  return { ok: true, refs };
}

/** The repository's object format, "sha1" or "sha256". */
async function objectFormat(cwd, opts) {
  const r = await runGit(['rev-parse', '--show-object-format'], cwd, opts);
  return r.ok && /sha256/.test(r.stdout.toString()) ? 'sha256' : 'sha1';
}

/** Checks the ref and returns the commit id. */
async function resolveRef(cwd, ref, opts) {
  if (!/^[\w./@{}^~:+-]+$/.test(ref) || ref.startsWith('-')) return { ok: false, error: 'That does not look like a Git ref.' };
  const r = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}'], cwd, opts);
  if (!r.ok) return { ok: false, error: 'Git does not know the ref "' + ref + '".' };
  return { ok: true, commit: r.stdout.toString().trim() };
}

/**
 * Parses `git ls-tree -r -t -l -z` output into the same map shape as walk(): key -> entry.
 * Lines: "<mode> SP <type> SP <oid> SP <size>\t<path>\0". Submodules (type commit) become folders without content.
 */
function parseLsTree(buf, rules) {
  const map = new Map();
  let files = 0, dirs = 0, bytes = 0;
  const text = buf.toString('utf8');
  for (const rec of text.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, sizeStr] = rec.slice(0, tab).split(/\s+/);
    const rel = rec.slice(tab + 1);
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const isDir = type === 'tree' || type === 'commit';
    if (rules && rules.length && (isIgnored(rules, rel, isDir) || ancestorIgnored(rules, rel))) continue;
    const ent = { rel, name, kind: 'file', size: 0, mtimeMs: 0 };
    if (isDir) { ent.kind = 'dir'; dirs++; if (type === 'commit') ent.note = 'Submodule'; }
    else if (mode === '120000') { ent.kind = 'link'; ent.oid = oid; ent.size = Number(sizeStr) || 0; }
    else { ent.size = Number(sizeStr) || 0; ent.oid = oid; files++; bytes += ent.size; }
    map.set(keyOf(rel), ent);
  }
  return { map, files, dirs, bytes };
}

function ancestorIgnored(rules, rel) {
  let i = rel.indexOf('/');
  while (i > 0) { if (isIgnored(rules, rel.slice(0, i), true)) return true; i = rel.indexOf('/', i + 1); }
  return false;
}

/** Lists the tree of `ref` below `cwd` (paths relative to cwd). */
async function lsTree(cwd, ref, excludeGlobs, opts) {
  const r = await runGit(['ls-tree', '-r', '-t', '-l', '-z', '--end-of-options', ref, '--', '.'], cwd, opts);
  if (!r.ok) return r;
  return { ok: true, ...parseLsTree(r.stdout, parseGlobs(excludeGlobs)) };
}

/** Bytes of one blob. */
async function catBlob(cwd, oid, maxBytes, opts) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid)) return { ok: false, error: 'Bad object id.' };
  const r = await runGit(['cat-file', 'blob', oid], cwd, { ...(opts || {}), maxBuffer: Math.max(maxBytes || 0, 1 << 20) });
  if (!r.ok) return r;
  return { ok: true, bytes: r.stdout };
}

/** Reads a symlink blob (its target) for the link compare. */
module.exports = { runGit, listRefs, resolveRef, lsTree, parseLsTree, catBlob, objectFormat, SAFE };
