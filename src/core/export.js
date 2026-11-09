'use strict';
// Compare result as Markdown, CSV or HTML: path, status, both sizes and modified times. Pure.

const LABEL = { same: 'Same', changed: 'Changed', pending: 'Checking', left: 'Only left', right: 'Only right', error: 'Error' };

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
}
function fmtTime(ms) { return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : ''; }

function rowsOf(entries, onlyDiff) {
  return entries.filter(e => e.kind !== 'dir' && (!onlyDiff || e.status !== 'same')).map(e => ({
    path: (e.l || e.r).rel + (e.l && e.r && e.l.rel !== e.r.rel ? ` (right: ${e.r.rel})` : ''),
    status: LABEL[e.status] || e.status,
    leftSize: e.l && e.l.kind !== 'dir' ? e.l.size : null,
    rightSize: e.r && e.r.kind !== 'dir' ? e.r.size : null,
    leftTime: e.l ? e.l.mtimeMs : 0,
    rightTime: e.r ? e.r.mtimeMs : 0,
    note: e.note || '',
  }));
}

const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) || /^[=+\-@\t]/.test(s) ? '"' + (/^[=+\-@\t]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
const mdCell = v => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function summaryLine(c) {
  return `${c.changed} changed, ${c.left} only left, ${c.right} only right, ${c.same} same` + (c.error ? `, ${c.error} errors` : '');
}

/**
 * @param {'md'|'csv'|'html'} format
 * @param {{left:string, right:string, entries:object[], counts:object, onlyDiff?:boolean, when?:Date, mode?:string}} r
 */
function exportResult(format, r) {
  const rows = rowsOf(r.entries, r.onlyDiff);
  const when = (r.when || new Date()).toISOString().replace('T', ' ').slice(0, 16);
  if (format === 'csv') {
    const head = ['path', 'status', 'left_size', 'right_size', 'left_modified', 'right_modified', 'note'];
    return [head.join(','), ...rows.map(x => [x.path, x.status, x.leftSize, x.rightSize, fmtTime(x.leftTime), fmtTime(x.rightTime), x.note].map(csvCell).join(','))].join('\r\n') + '\r\n';
  }
  if (format === 'md') {
    const lines = [
      `# Folder compare`, '',
      `- Left: \`${r.left}\``, `- Right: \`${r.right}\``, `- When: ${when}` + (r.mode ? `, ${r.mode} mode` : ''), `- Result: ${summaryLine(r.counts)}`, '',
      '| Path | Status | Left size | Right size | Left modified | Right modified | Note |', '|---|---|---:|---:|---|---|---|',
      ...rows.map(x => `| ${mdCell(x.path)} | ${x.status} | ${fmtSize(x.leftSize)} | ${fmtSize(x.rightSize)} | ${fmtTime(x.leftTime)} | ${fmtTime(x.rightTime)} | ${mdCell(x.note)} |`),
    ];
    return lines.join('\n') + '\n';
  }
  const cls = { Same: 's', Changed: 'c', 'Only left': 'l', 'Only right': 'r', Error: 'e', Checking: 'p' };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Folder compare</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}th{background:#161b22!important}td,th{border-color:#30363d!important}}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa;position:sticky;top:0}td.n{text-align:right;white-space:nowrap}
.c{color:#bf8700}.l{color:#cf222e}.r{color:#1a7f37}.e{color:#cf222e;font-weight:600}.s{opacity:.7}code{font-size:13px}
</style></head><body>
<h1>Folder compare</h1>
<p>Left: <code>${esc(r.left)}</code><br>Right: <code>${esc(r.right)}</code><br>When: ${esc(when)}${r.mode ? ', ' + esc(r.mode) + ' mode' : ''}<br>Result: ${esc(summaryLine(r.counts))}</p>
<table><thead><tr><th>Path</th><th>Status</th><th>Left size</th><th>Right size</th><th>Left modified</th><th>Right modified</th><th>Note</th></tr></thead><tbody>
${rows.map(x => `<tr><td>${esc(x.path)}</td><td class="${cls[x.status] || ''}">${esc(x.status)}</td><td class="n">${esc(fmtSize(x.leftSize))}</td><td class="n">${esc(fmtSize(x.rightSize))}</td><td>${esc(fmtTime(x.leftTime))}</td><td>${esc(fmtTime(x.rightTime))}</td><td>${esc(x.note)}</td></tr>`).join('\n')}
</tbody></table></body></html>
`;
}

module.exports = { exportResult, fmtSize, fmtTime, rowsOf, LABEL, summaryLine };
