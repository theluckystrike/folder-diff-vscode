'use strict';
// Opens the right diff for one file pair:
//   text files               VS Code's own diff editor on the real files (editable)
//   .docx .doc .odt          Markdown of both documents, side by side
//   .xlsx .xls .ods .csv .parquet   CSV text of every sheet, side by side
//   .pdf                     the text of every page, side by side
//   anything else (binary)   hex lines around every differing byte range, plus a count
// The converters run in a worker thread with a memory cap and a time limit. Nothing leaves the machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { looksBinary, headBytes } = require('./core/bytes');
const { fmtSize } = require('./core/export');

const SCHEME = 'folder-diff';
const DOC_RE = /\.(docx|dotx|docm|odt|ott|doc|dot)$/i;
const TABLE_RE = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|tab|psv|parquet|pq)$/i;
const PDF_RE = /\.pdf$/i;
const TEXTISH = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|swift|php|sh|bash|zsh|ps1|bat|sql|r|lua|pl|vue|svelte|tex|rst|log|env|gitignore|dockerfile|makefile|gradle|properties|svg)$/i;

function kindOf(name) {
  if (DOC_RE.test(name)) return 'docx';
  if (TABLE_RE.test(name)) return 'table';
  if (PDF_RE.test(name)) return 'pdf';
  return null;
}

/** Bounded map of virtual document texts, so long sessions do not grow forever. */
class TextStore {
  constructor(max) { this.max = max || 60; this.map = new Map(); this.seq = 0; }
  put(text) {
    const key = String(++this.seq);
    this.map.set(key, text);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return key;
  }
  get(key) { return this.map.has(key) ? this.map.get(key) : null; }
}

function safeSeg(s) { return String(s).replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 120) || '_'; }

/** Runs one job in the converter worker with a time limit and a memory cap. */
function runConvert(workerFile, job, limits = {}) {
  const timeoutMs = limits.timeoutMs || 120000;
  const maxOld = limits.maxHeapMb || 1536;
  return new Promise(resolve => {
    let done = false;
    const w = new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: maxOld, stackSizeMb: 64 } });
    const finish = v => { if (done) return; done = true; clearTimeout(t); w.terminate().catch(() => {}); resolve(v); };
    const t = setTimeout(() => finish({ ok: false, error: `Stopped after ${Math.round(timeoutMs / 1000)} seconds. The file may be very large or damaged.` }), timeoutMs);
    w.once('message', m => finish(m.result));
    w.once('error', err => {
      const oom = /ERR_WORKER_OUT_OF_MEMORY|out of memory/i.test(String(err && (err.code || err.message)));
      finish({ ok: false, error: oom ? `The converter stopped at ${maxOld} MB of memory. The file may hold a very large or compressed part.` : String((err && err.message) || err).slice(0, 300) });
    });
    w.once('exit', code => finish({ ok: false, error: 'The converter exited with code ' + code + '.' }));
    const transfer = job.bytes ? [job.bytes.buffer] : [];
    w.postMessage(job, transfer);
  });
}

/**
 * @param {object} deps { vscode, context, settings(), gitBlob(side, maxBytes) -> {ok, bytes}|{ok:false,error} }
 */
function createDiffOpener(deps) {
  const { vscode, context } = deps;
  const store = new TextStore();
  const convertWorker = path.join(context.extensionUri.fsPath, 'dist', 'convert-worker.mjs');
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
    provideTextDocumentContent: uri => { const v = store.get(uri.query); return v === null ? '(This compare is closed. Open the file from the folder compare again.)' : v; },
  }));
  const virtualUri = (label, name, text, ext) => vscode.Uri.from({ scheme: SCHEME, path: '/' + safeSeg(label) + '/' + safeSeg(name) + (ext || ''), query: store.put(text) });

  async function bytesOf(side, maxBytes) {
    if (side.git) {
      const r = await deps.gitBlob(side, maxBytes);
      if (!r.ok) throw new Error(r.error);
      return new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength).slice();
    }
    const st = await fs.promises.stat(side.fsPath);
    if (st.size > maxBytes) throw new Error(`${path.basename(side.fsPath)} is ${fmtSize(st.size)}, over the ${fmtSize(maxBytes)} limit (setting folderDiff.maxConvertMB).`);
    return new Uint8Array(await fs.promises.readFile(side.fsPath));
  }

  async function sizeOf(side) { return side.git ? side.size : (await fs.promises.stat(side.fsPath)).size; }

  async function convertSide(kind, side, name) {
    const s = deps.settings();
    const maxBytes = s.maxConvertMB * 1048576;
    const ext = path.extname(name).toLowerCase();
    let job;
    if (kind === 'table' && !side.git) {
      const size = await sizeOf(side);
      if (size > maxBytes) return { ok: false, error: `${name} is ${fmtSize(size)}, over the ${fmtSize(maxBytes)} limit (setting folderDiff.maxConvertMB).` };
      job = { kind, ext, path: side.fsPath, maxRows: s.maxCompareRows };
    } else job = { kind, ext, bytes: await bytesOf(side, maxBytes), maxRows: s.maxCompareRows };
    return runConvert(convertWorker, job, { timeoutMs: s.convertTimeoutSec * 1000 });
  }

  /** Writes a Git blob to a temp file for the byte compare. Returns the path and a cleanup function. */
  async function tempOf(side) {
    if (!side.git) return { file: side.fsPath, done: async () => {} };
    const r = await deps.gitBlob(side, deps.settings().maxConvertMB * 1048576);
    if (!r.ok) throw new Error(r.error);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'folder-diff-'));
    const file = path.join(dir, 'blob');
    await fs.promises.writeFile(file, r.bytes);
    return { file, done: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) };
  }

  async function binaryDiff(left, right, name, why) {
    const a = await tempOf(left), b = await tempOf(right);
    try {
      const r = await runConvert(convertWorker, { kind: 'binary', left: a.file, right: b.file, maxRanges: 200, maxLines: 3000 }, { timeoutMs: 600000 });
      if (!r.ok) throw new Error(r.error);
      const head = (side, size) => [
        `Byte compare of ${name}${why ? ' (' + why + ')' : ''}`,
        `${side.label}: ${side.display} (${fmtSize(size)}, ${size.toLocaleString('en-US')} bytes)`,
        r.diffBytes === 0 ? 'The bytes are the same.' : `${r.diffBytes.toLocaleString('en-US')} bytes differ in ${r.ranges}${r.more ? '+' : ''} ranges${r.more ? ' (the first ' + r.ranges + ' are shown)' : ''}.`,
        'Offsets are hexadecimal, 16 bytes per line. "--" marks bytes past the end of the shorter file.',
        '',
      ];
      const lt = head(left, r.sizeA).concat(r.leftLines).join('\n') + '\n';
      const rt = head(right, r.sizeB).concat(r.rightLines).join('\n') + '\n';
      await vscode.commands.executeCommand('vscode.diff', virtualUri(left.label, name, lt, '.hex.txt'), virtualUri(right.label, name, rt, '.hex.txt'), `${name} (bytes, ${left.label} ↔ ${right.label})`, { preview: false });
      return { ok: true, diffBytes: r.diffBytes };
    } finally { await a.done(); await b.done(); }
  }

  /** Opens the diff for a pair. left/right: {fsPath?|git:{cwd,oid}, label, display, size} or null. */
  async function open(left, right, name) {
    const s = deps.settings();
    if (!left || !right) {
      const one = left || right;
      if (one.git) {
        const r = await deps.gitBlob(one, s.maxConvertMB * 1048576);
        if (!r.ok) throw new Error(r.error);
        const doc = await vscode.workspace.openTextDocument(virtualUri(one.label, name, looksBinary(r.bytes) ? '(binary file, ' + fmtSize(r.bytes.length) + ')' : r.bytes.toString('utf8')));
        await vscode.window.showTextDocument(doc, { preview: false });
        return { ok: true };
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(one.fsPath), { preview: false });
      return { ok: true };
    }
    const kind = kindOf(name);
    if (kind) {
      const [a, b] = await Promise.all([convertSide(kind, left, name), convertSide(kind, right, name)]);
      if (!a.ok || !b.ok) {
        const why = !a.ok ? `${left.label}: ${a.error}` : `${right.label}: ${b.error}`;
        vscode.window.showWarningMessage(`Folder Diff could not read ${name} as text (${why}). Showing the byte compare instead.`);
        return binaryDiff(left, right, name, 'the converter failed');
      }
      const ext = kind === 'docx' ? '.md' : kind === 'table' ? '.csv' : '.txt';
      const what = kind === 'docx' ? 'as Markdown' : kind === 'table' ? 'as CSV' : 'PDF text';
      if (a.text === b.text) vscode.window.showInformationMessage(`Folder Diff: the text of ${name} is the same on both sides. Only formatting, images or metadata differ.`);
      await vscode.commands.executeCommand('vscode.diff', virtualUri(left.label, name, a.text, ext), virtualUri(right.label, name, b.text, ext), `${name} (${left.label} ↔ ${right.label}, ${what})`, { preview: false });
      return { ok: true };
    }
    // Text or binary? Look at the first 8000 bytes of both sides.
    const [sa, sb] = await Promise.all([sizeOf(left), sizeOf(right)]);
    const big = Math.max(sa, sb) > s.maxTextDiffMB * 1048576;
    let binary = false;
    if (!TEXTISH.test(name) || big) {
      const ha = left.git ? (await deps.gitBlob(left, Math.max(sa, 1))).bytes : await headBytes(left.fsPath);
      const hb = right.git ? (await deps.gitBlob(right, Math.max(sb, 1))).bytes : await headBytes(right.fsPath);
      binary = (ha && looksBinary(ha)) || (hb && looksBinary(hb));
    }
    if (binary || big) return binaryDiff(left, right, name, big && !binary ? `over ${s.maxTextDiffMB} MB, setting folderDiff.maxTextDiffMB` : '');
    const leftUri = left.git ? virtualUri(left.label, name, (await deps.gitBlob(left, sa + 1)).bytes.toString('utf8')) : vscode.Uri.file(left.fsPath);
    const rightUri = right.git ? virtualUri(right.label, name, (await deps.gitBlob(right, sb + 1)).bytes.toString('utf8')) : vscode.Uri.file(right.fsPath);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${name} (${left.label} ↔ ${right.label})`, { preview: false });
    return { ok: true };
  }

  return { open, convertSide, binaryDiff, store, kindOf };
}

module.exports = { createDiffOpener, kindOf, TextStore, runConvert, SCHEME };
