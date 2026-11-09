'use strict';
// Ignore rules for the folder walk: the user's glob list (setting folderDiff.exclude) and .gitignore files.
// Pure functions, no vscode module, so tests can call them.

/** Turns one glob into a RegExp source. Supports **, *, ?, [abc] and {a,b}. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more folders, a trailing "**" matches everything below.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      let set = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (set[0] === '!') set = '^' + set.slice(1);
      re += '[' + set + ']';
      i = end;
    } else if (c === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
      i = end;
    } else if ('.+^$()|\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return re;
}

/**
 * One rule. A pattern without "/" (other than a trailing one) matches a name at any depth; with a "/" it is
 * anchored at the base folder. A trailing "/" matches folders only. "!" turns a match into "keep".
 */
function compileRule(line, base) {
  let s = line.replace(/\r$/, '');
  if (!s.trim() || s.startsWith('#')) return null;
  s = s.replace(/(?<!\\)\s+$/, '');
  let negate = false;
  if (s.startsWith('!')) { negate = true; s = s.slice(1); }
  if (s.startsWith('\\')) s = s.slice(1);
  let dirOnly = false;
  if (s.endsWith('/')) { dirOnly = true; s = s.slice(0, -1); }
  if (!s) return null;
  const anchored = s.includes('/');
  if (s.startsWith('/')) s = s.slice(1);
  const body = globToRegex(s);
  const re = new RegExp(anchored ? '^' + body + '(?:/.*)?$' : '(?:^|/)' + body + '(?:/.*)?$');
  return { negate, dirOnly, re, base: base || '', source: line };
}

/** Rules from one .gitignore file's text. base is the folder of the .gitignore, relative to the walk root. */
function parseGitignore(text, base) {
  const out = [];
  for (const line of String(text).split('\n')) { const r = compileRule(line, base); if (r) out.push(r); }
  return out;
}

/** Rules from the setting's glob list (strings). They apply at every level. */
function parseGlobs(list) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    if (typeof g !== 'string') continue;
    const r = compileRule(g.trim(), '');
    if (r) out.push(r);
  }
  return out;
}

/**
 * Whether a path is ignored. rel is the POSIX path from the walk root; rules are applied in order and the
 * last match wins, as in git. A rule from a nested .gitignore only sees paths below its folder.
 */
function isIgnored(rules, rel, isDir) {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    let p = rel;
    if (r.base) {
      if (!rel.startsWith(r.base + '/')) continue;
      p = rel.slice(r.base.length + 1);
    }
    if (r.re.test(p)) ignored = !r.negate;
  }
  return ignored;
}

const DEFAULT_EXCLUDE = ['node_modules/', '.git/', 'dist/', '.DS_Store', 'Thumbs.db'];

module.exports = { globToRegex, compileRule, parseGitignore, parseGlobs, isIgnored, DEFAULT_EXCLUDE };
