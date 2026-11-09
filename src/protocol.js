'use strict';
// Checks every message from the webview before the extension host acts on it. Unknown or malformed
// messages are dropped. Pure, so tests can call it.

const MAX_SEL = 200000;
const isIdx = v => Number.isSafeInteger(v) && v >= 0 && v < 10000000;
const sel = v => (Array.isArray(v) && v.length <= MAX_SEL && v.every(isIdx) ? v : null);

function validate(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string') return null;
  switch (m.type) {
    case 'ready': case 'refresh': case 'swap': case 'cancel': case 'editExclude': case 'saveSession': case 'sync': case 'report':
    case 'changeLeft': case 'changeRight':
      return { type: m.type };
    case 'open': return isIdx(m.i) ? { type: 'open', i: m.i } : null;
    case 'reveal': case 'copyPath':
      return isIdx(m.i) && (m.side === 'left' || m.side === 'right') ? { type: m.type, i: m.i, side: m.side } : null;
    case 'copy': {
      const s = sel(m.sel);
      return s && (m.dir === 'toRight' || m.dir === 'toLeft') ? { type: 'copy', dir: m.dir, sel: s } : null;
    }
    case 'delete': {
      const s = sel(m.sel);
      return s && (m.side === 'left' || m.side === 'right') ? { type: 'delete', side: m.side, sel: s } : null;
    }
    case 'mode': return m.mode === 'content' || m.mode === 'quick' ? { type: 'mode', mode: m.mode } : null;
    case 'export':
      return ['md', 'csv', 'html'].includes(m.format) ? { type: 'export', format: m.format, onlyDiff: !!m.onlyDiff } : null;
    case 'error': return { type: 'error', message: String(m.message || '').slice(0, 500) };
    default: return null;
  }
}

/** Compact rows for the webview: short keys, no absolute paths. */
function compactRows(entries) {
  const idx = new Map();
  entries.forEach((e, i) => idx.set(e.key, i));
  return entries.map(e => ({
    n: e.name, d: e.depth, k: e.kind, s: e.status, nt: e.note || '', p: e.parent ? (idx.has(e.parent) ? idx.get(e.parent) : -1) : -1,
    l: e.l ? [e.l.kind, e.l.kind === 'dir' ? -1 : e.l.size, e.l.mtimeMs || 0, e.l.rel.slice(e.l.rel.lastIndexOf('/') + 1)] : null,
    r: e.r ? [e.r.kind, e.r.kind === 'dir' ? -1 : e.r.size, e.r.mtimeMs || 0, e.r.rel.slice(e.r.rel.lastIndexOf('/') + 1)] : null,
  }));
}

module.exports = { validate, compactRows };
