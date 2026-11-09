'use strict';
// One folder compare in a webview tab. The walk and the byte compare run in a worker thread; this side keeps
// the result, answers the webview, opens file diffs and does Copy, Delete, Export and Sync after a confirmation.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { validate, compactRows } = require('./protocol');
const { rollup, countStatuses } = require('./core/compare');
const { planCopy, planDelete, planSync } = require('./core/plan');
const { exportResult, fmtSize, summaryLine } = require('./core/export');
const git = require('./core/git');
const { showLinks, commandUris } = require('./support');

const VIEW = 'folderDiff.compare';
const MAX_LIST = 25;

function abs(root, rel) { return path.join(root, ...rel.split('/')); }

/** The lines of a confirmation: at most MAX_LIST, then "and N more". */
function listLines(lines) {
  const out = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) out.push(`...and ${lines.length - MAX_LIST} more`);
  return out.join('\n');
}

class ComparePanel {
  /**
   * @param {object} deps { vscode, context, opener, rating, pro, settings, sessions }
   * @param {{left:object, right:object, mode?:string}} job left/right: {kind:'dir', path} or {kind:'git', cwd, ref}
   */
  constructor(deps, job) {
    this.deps = deps;
    const { vscode, context } = deps;
    this.vscode = vscode;
    this.job = { mode: deps.settings().compareMode, ...job };
    this.entries = [];
    this.counts = null;
    this.running = false;
    this.worker = null;
    this.blobCache = new Map();
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(VIEW, this.title(), vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist, media],
      enableCommandUris: commandUris('folderDiff'),
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'tab-icon.svg');
    this.panel.webview.html = buildHtml({
      cspSource: this.panel.webview.cspSource,
      scriptUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: this.title(),
      showSupportLinks: showLinks(vscode, 'folderDiff'),
    });
    this.panel.webview.onDidReceiveMessage(raw => this.onMessage(raw));
    this.panel.onDidDispose(() => { this.disposed = true; this.stopWorker(); });
  }

  get git() { return this.job.left.kind === 'git'; }
  leftRoot() { return this.git ? this.job.left.cwd : this.job.left.path; }
  rightRoot() { return this.job.right.path; }
  leftLabel() { return this.git ? this.job.left.ref : 'Left'; }
  rightLabel() { return this.git ? 'Working tree' : 'Right'; }

  title() {
    const b = p => path.basename(p) || p;
    return this.git ? `${b(this.job.right.path)} ↔ ${this.job.left.ref}` : `${b(this.job.left.path)} ↔ ${b(this.job.right.path)}`;
  }

  post(m) { if (!this.disposed) this.panel.webview.postMessage(m); }

  sideInfo() {
    return {
      left: { label: this.leftLabel(), path: this.git ? `${this.job.left.ref}:${this.job.left.cwd}` : this.job.left.path, readOnly: this.git },
      right: { label: this.rightLabel(), path: this.job.right.path, readOnly: false },
    };
  }

  stopWorker() {
    if (this.worker) { const w = this.worker; this.worker = null; w.postMessage({ type: 'stop' }); setTimeout(() => w.terminate().catch(() => {}), 200); }
    this.running = false;
  }

  start() {
    this.stopWorker();
    const s = this.deps.settings();
    this.entries = [];
    this.counts = null;
    this.blobCache.clear();
    this.failed = false;
    this.post({ type: 'init', ...this.sideInfo(), mode: this.job.mode, showSame: s.showSame, git: this.git, pro: this.deps.pro.labels() });
    const file = path.join(this.deps.context.extensionUri.fsPath, 'dist', 'scan-worker.js');
    const w = new Worker(file, { resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    this.worker = w;
    this.running = true;
    this.t0 = Date.now();
    w.on('message', m => { if (this.worker === w) this.onWorker(m); });
    w.on('error', err => { if (this.worker === w) this.fail(String((err && err.message) || err)); });
    w.on('exit', code => { if (this.worker === w && this.running) this.fail('The compare stopped (code ' + code + ').'); });
    w.postMessage({ type: 'start', job: {
      left: this.job.left, right: this.job.right, mode: this.job.mode, exclude: s.exclude, useGitignore: s.useGitignore,
      followSymlinks: s.followSymlinks, mtimeToleranceMs: s.mtimeToleranceSeconds * 1000, concurrency: 4,
    } });
  }

  fail(message) {
    this.running = false;
    this.failed = true;
    this.worker = null;
    this.deps.rating.failure();
    let text = message;
    if (/ENOENT/.test(message)) text = 'A folder was not found. It may have been moved or deleted. ' + message;
    else if (/EACCES|EPERM/.test(message)) text = 'No permission to read a folder. ' + message;
    this.post({ type: 'fatal', message: text });
  }

  onWorker(m) {
    if (m.type === 'progress') return this.post(m);
    if (m.type === 'fatal') { this.stopWorker(); return this.fail(m.message); }
    if (m.type === 'tree') {
      this.entries = m.entries;
      this.counts = m.counts;
      this.info = m.info;
      return this.post({ type: 'tree', rows: compactRows(this.entries), counts: m.counts, info: m.info, ms: m.ms });
    }
    if (m.type === 'update') {
      const notes = {};
      for (const [i, status, note] of m.changes) {
        const e = this.entries[i];
        if (!e) continue;
        e.status = status;
        if (note !== e.note) { e.note = note; notes[i] = note; }
      }
      rollup(this.entries);
      this.counts = countStatuses(this.entries);
      return this.post({ type: 'status', codes: this.entries.map(e => e.status), notes, counts: this.counts, done: m.done, total: m.total, bytesDone: m.bytesDone, bytesTotal: m.bytesTotal });
    }
    if (m.type === 'done') {
      this.running = false;
      const w = this.worker; this.worker = null; if (w) w.terminate().catch(() => {});
      this.post({ type: 'done', ms: m.ms, counts: this.counts });
      if (!this.failed) this.deps.rating.success(this.vscode.Uri.file(this.job.right.path));
    }
  }

  sideOf(e, which) {
    const s = which === 'left' ? e.l : e.r;
    if (!s) return null;
    if (which === 'left' && this.git) return { git: true, oid: s.oid, size: s.size, rel: s.rel, label: this.job.left.ref, display: `${this.job.left.ref}:${s.rel}` };
    const root = which === 'left' ? this.leftRoot() : this.rightRoot();
    const p = abs(root, s.rel);
    return { fsPath: p, size: s.size, rel: s.rel, label: which === 'left' ? this.leftLabel() : this.rightLabel(), display: p };
  }

  async gitBlob(side, maxBytes) {
    if (this.blobCache.has(side.oid)) return { ok: true, bytes: this.blobCache.get(side.oid) };
    if (side.size > maxBytes) return { ok: false, error: `The committed file is ${fmtSize(side.size)}, over the ${fmtSize(maxBytes)} limit (setting folderDiff.maxConvertMB).` };
    const r = await git.catBlob(this.job.left.cwd, side.oid, maxBytes);
    if (r.ok) { this.blobCache.set(side.oid, r.bytes); while (this.blobCache.size > 6) this.blobCache.delete(this.blobCache.keys().next().value); }
    return r;
  }

  async onMessage(raw) {
    const msg = validate(raw);
    if (!msg) return;
    const { vscode } = this;
    try {
      switch (msg.type) {
        case 'ready': return this.start();
        case 'refresh': return this.start();
        case 'cancel':
          if (this.running) { this.stopWorker(); this.post({ type: 'cancelled' }); }
          return;
        case 'mode': this.job.mode = msg.mode; return this.start();
        case 'swap':
          if (this.git) return;
          this.job = { ...this.job, left: this.job.right, right: this.job.left };
          this.panel.title = this.title();
          return this.start();
        case 'changeLeft': case 'changeRight': {
          const which = msg.type === 'changeLeft' ? 'left' : 'right';
          if (which === 'left' && this.git) return;
          const cur = this.job[which].path;
          const p = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.Uri.file(path.dirname(cur)), openLabel: `Use as ${which}`, title: `Folder Diff: pick the ${which} folder` });
          if (!p || !p[0]) return;
          this.job[which] = { kind: 'dir', path: p[0].fsPath };
          this.panel.title = this.title();
          return this.start();
        }
        case 'open': return this.openDiff(msg.i);
        case 'reveal': case 'copyPath': {
          const e = this.entries[msg.i];
          const s = e && this.sideOf(e, msg.side);
          if (!s || s.git) return;
          if (msg.type === 'reveal') return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.fsPath));
          await vscode.env.clipboard.writeText(s.fsPath);
          return vscode.window.setStatusBarMessage('Folder Diff: path copied', 2500);
        }
        case 'copy': return this.copy(msg.dir, msg.sel);
        case 'delete': return this.remove(msg.side, msg.sel);
        case 'export': return this.exportTo(msg.format, msg.onlyDiff);
        case 'editExclude': return this.editExclude();
        case 'saveSession': return this.saveSession();
        case 'sync': return this.sync();
        case 'report': return this.report();
        case 'error': return undefined;
      }
    } catch (err) {
      vscode.window.showErrorMessage('Folder Diff: ' + ((err && err.message) || String(err)));
    }
    return undefined;
  }

  async openDiff(i) {
    const e = this.entries[i];
    if (!e || e.kind === 'dir') return;
    if (e.kind === 'mixed') return this.vscode.window.showInformationMessage(`${e.name} is a ${e.l.kind} on the left and a ${e.r.kind} on the right. There is no file diff for that.`);
    if ((e.l && e.l.kind === 'link') || (e.r && e.r.kind === 'link')) {
      return this.vscode.window.showInformationMessage(`${e.name} is a symbolic link. Left: ${e.l ? e.l.target || '(none)' : '(missing)'}. Right: ${e.r ? e.r.target || '(none)' : '(missing)'}.`);
    }
    const left = this.sideOf(e, 'left'), right = this.sideOf(e, 'right');
    const name = e.name;
    const kind = this.deps.opener.kindOf(name);
    const go = () => this.deps.opener.open(left, right, name);
    if (kind && left && right) {
      return this.vscode.window.withProgress({ location: this.vscode.ProgressLocation.Notification, title: `Folder Diff: reading ${name}` }, go);
    }
    if (left && right && Math.max(left.size, right.size) > 32 * 1048576) {
      return this.vscode.window.withProgress({ location: this.vscode.ProgressLocation.Notification, title: `Folder Diff: comparing the bytes of ${name}` }, go);
    }
    return go();
  }

  /** Runs a list of copies. Each item: {srcRel, rel, kind}. from/to: 'left' | 'right'. */
  async runCopies(items, from, to) {
    let done = 0;
    const errors = [];
    const srcRoot = from === 'left' ? this.leftRoot() : this.rightRoot();
    const dstRoot = to === 'left' ? this.leftRoot() : this.rightRoot();
    for (const it of items) {
      const dst = abs(dstRoot, it.rel);
      try {
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        if (from === 'left' && this.git) {
          const e = this.entries.find(x => x.l && x.l.rel === it.srcRel);
          const r = await git.catBlob(this.job.left.cwd, e.l.oid, Math.max(e.l.size + 1, 1 << 20));
          if (!r.ok) throw new Error(r.error);
          if (it.kind === 'link') { await fs.promises.rm(dst, { force: true }); await fs.promises.symlink(r.bytes.toString('utf8'), dst); }
          else await fs.promises.writeFile(dst, r.bytes);
        } else {
          const src = abs(srcRoot, it.srcRel);
          const st = await fs.promises.lstat(src);
          if (st.isSymbolicLink()) { const t = await fs.promises.readlink(src); await fs.promises.rm(dst, { force: true }); await fs.promises.symlink(t, dst); }
          else {
            await fs.promises.copyFile(src, dst);
            await fs.promises.utimes(dst, st.atime, st.mtime).catch(() => {});
          }
        }
        done++;
      } catch (err) { errors.push(`${it.rel}: ${(err && err.message) || err}`); }
    }
    return { done, errors };
  }

  async copy(dir, sel) {
    const { vscode } = this;
    if (this.running) return vscode.window.showInformationMessage('Folder Diff: wait until the compare has finished, or press Cancel.');
    if (dir === 'toLeft' && this.git) return vscode.window.showInformationMessage(`Folder Diff: the ${this.job.left.ref} side is a Git ref and cannot be written.`);
    const plan = planCopy(this.entries, sel, dir);
    if (!plan.items.length) {
      const why = plan.blocked.length ? ' ' + plan.blocked.slice(0, 3).join('. ') : plan.skipped ? ' The selected files are already the same on both sides.' : '';
      return vscode.window.showInformationMessage('Folder Diff: nothing to copy.' + why);
    }
    const from = dir === 'toRight' ? 'left' : 'right', to = dir === 'toRight' ? 'right' : 'left';
    const toRoot = to === 'left' ? this.leftRoot() : this.rightRoot();
    const bytes = plan.items.reduce((s, x) => s + (x.size || 0), 0);
    const over = plan.items.filter(x => x.action === 'overwrite').length;
    const n = plan.items.length;
    const detail = `From ${from === 'left' ? this.sideInfo().left.path : this.rightRoot()}\nTo ${toRoot}\n${fmtSize(bytes)}. ${over} overwritten, ${n - over} new.${plan.skipped ? ` ${plan.skipped} equal files are skipped.` : ''}${plan.blocked.length ? `\nNot copied: ${plan.blocked.slice(0, 5).join('; ')}` : ''}\n\n` +
      listLines(plan.items.map(x => (x.action === 'overwrite' ? 'overwrite  ' : 'new        ') + x.rel));
    const ok = `Copy ${n} ${n === 1 ? 'file' : 'files'} to the ${to}`;
    const pick = await vscode.window.showWarningMessage(`Copy ${n} ${n === 1 ? 'file' : 'files'} from the ${from} side to the ${to} side?`, { modal: true, detail }, ok);
    if (pick !== ok) return undefined;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Folder Diff: copying ${n} files` }, () => this.runCopies(plan.items, from, to));
    this.report_(r, 'Copied');
    return this.start();
  }

  report_(r, verb) {
    if (r.errors.length) this.vscode.window.showWarningMessage(`Folder Diff: ${verb} ${r.done}. ${r.errors.length} failed: ${r.errors.slice(0, 3).join('; ')}`);
    else this.vscode.window.setStatusBarMessage(`Folder Diff: ${verb} ${r.done}`, 4000);
  }

  async runDeletes(items, side) {
    const root = side === 'left' ? this.leftRoot() : this.rightRoot();
    const trash = this.deps.settings().deleteToTrash;
    let done = 0;
    const errors = [];
    for (const it of items) {
      const uri = this.vscode.Uri.file(abs(root, it.rel));
      try { await this.vscode.workspace.fs.delete(uri, { recursive: true, useTrash: trash }); done++; } catch (err) { errors.push(`${it.rel}: ${(err && err.message) || err}`); }
    }
    return { done, errors };
  }

  async remove(side, sel) {
    const { vscode } = this;
    if (this.running) return vscode.window.showInformationMessage('Folder Diff: wait until the compare has finished, or press Cancel.');
    if (side === 'left' && this.git) return vscode.window.showInformationMessage(`Folder Diff: the ${this.job.left.ref} side is a Git ref and cannot be changed.`);
    const plan = planDelete(this.entries, sel, side);
    if (!plan.items.length) return vscode.window.showInformationMessage(`Folder Diff: the selected rows have nothing on the ${side} side.`);
    const files = plan.items.reduce((s, x) => s + x.files, 0);
    const trash = this.deps.settings().deleteToTrash;
    const root = side === 'left' ? this.leftRoot() : this.rightRoot();
    const detail = `In ${root}\n${trash ? 'They go to the Trash (setting folderDiff.deleteToTrash).' : 'They are deleted for good: folderDiff.deleteToTrash is off.'}\n\n` +
      listLines(plan.items.map(x => (x.kind === 'dir' ? `folder     ${x.rel}/ (${x.files} files)` : `file       ${x.rel}`)));
    const ok = trash ? `Move ${plan.items.length} to Trash` : `Delete ${plan.items.length} for good`;
    const pick = await vscode.window.showWarningMessage(`Delete ${plan.items.length} ${plan.items.length === 1 ? 'item' : 'items'} (${files} ${files === 1 ? 'file' : 'files'}) on the ${side} side?`, { modal: true, detail }, ok);
    if (pick !== ok) return undefined;
    const r = await this.runDeletes(plan.items, side);
    this.report_(r, trash ? 'Moved to Trash' : 'Deleted');
    return this.start();
  }

  async exportTo(format, onlyDiff) {
    const { vscode } = this;
    if (!this.entries.length) return undefined;
    const ext = { md: 'md', csv: 'csv', html: 'html' }[format];
    const base = this.git ? `compare-${path.basename(this.rightRoot())}-${this.job.left.ref.replace(/[^\w.-]+/g, '_')}` : `compare-${path.basename(this.leftRoot())}-${path.basename(this.rightRoot())}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(this.rightRoot()), `${base}.${ext}`)),
      filters: { [format === 'md' ? 'Markdown' : format.toUpperCase()]: [ext] }, saveLabel: 'Export',
    });
    if (!target) return undefined;
    const text = exportResult(format, { left: this.sideInfo().left.path, right: this.rightRoot(), entries: this.entries, counts: this.counts, onlyDiff, mode: this.git ? 'Git' : this.job.mode === 'quick' ? 'Quick' : 'Content' });
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
    const pick = await vscode.window.showInformationMessage(`Folder Diff: exported ${path.basename(target.fsPath)}.`, 'Open');
    if (pick === 'Open') await vscode.commands.executeCommand('vscode.open', target);
    return undefined;
  }

  async editExclude() {
    const { vscode } = this;
    const cfg = vscode.workspace.getConfiguration('folderDiff');
    const cur = cfg.get('exclude', []);
    const v = await vscode.window.showInputBox({
      title: 'Folder Diff: leave out (comma separated)', value: cur.join(', '),
      prompt: 'Names and globs. A trailing / matches folders only. Example: node_modules/, *.log, build/',
    });
    if (v === undefined) return undefined;
    const list = v.split(',').map(s => s.trim()).filter(Boolean);
    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update('exclude', list, target);
    return this.start();
  }

  // ----- Pro candidates (free while PRO_ENABLED is false in src/pro.js) -----

  async saveSession() {
    if (!(await this.deps.pro.allow('Saved compares', 'Save this pair of folders and its settings, and open it again later from "Open Saved Compare".'))) return undefined;
    const name = await this.vscode.window.showInputBox({ title: 'Folder Diff: save this compare', value: this.title(), prompt: 'A name for the list in "Open Saved Compare"' });
    if (!name) return undefined;
    await this.deps.sessions.save({ name, left: this.job.left, right: this.job.right, mode: this.job.mode });
    this.vscode.window.setStatusBarMessage(`Folder Diff: saved "${name}"`, 4000);
    return undefined;
  }

  async sync() {
    const { vscode } = this;
    if (this.running) return vscode.window.showInformationMessage('Folder Diff: wait until the compare has finished, or press Cancel.');
    if (!(await this.deps.pro.allow('Folder sync', 'Make one folder equal to the other, or copy the newer files both ways, after a preview of every change.'))) return undefined;
    const items = [
      { label: 'Update both ways', description: 'newer file wins, missing files are copied, nothing is deleted', how: 'update' },
      { label: `Mirror ${this.leftLabel()} to ${this.rightLabel()}`, description: 'the right side becomes equal to the left (copies and deletes)', how: 'mirrorRight' },
    ];
    if (!this.git) items.push({ label: 'Mirror Right to Left', description: 'the left side becomes equal to the right (copies and deletes)', how: 'mirrorLeft' });
    const pick = await vscode.window.showQuickPick(items, { title: 'Folder Diff: sync', placeHolder: 'You see the full plan before anything is written' });
    if (!pick) return undefined;
    let how = pick.how;
    const plan = planSync(this.entries, how);
    if (this.git) { plan.copyToLeft.items = []; plan.deleteLeft.items = []; }
    const parts = [
      ['Copy to the right', plan.copyToRight.items.map(x => `${x.action === 'overwrite' ? 'overwrite' : 'new'}: ${x.rel}`)],
      ['Copy to the left', plan.copyToLeft.items.map(x => `${x.action === 'overwrite' ? 'overwrite' : 'new'}: ${x.rel}`)],
      ['Delete on the right', plan.deleteRight.items.map(x => x.kind === 'dir' ? `${x.rel}/ (${x.files} files)` : x.rel)],
      ['Delete on the left', plan.deleteLeft.items.map(x => x.kind === 'dir' ? `${x.rel}/ (${x.files} files)` : x.rel)],
    ];
    const total = parts.reduce((s, p) => s + p[1].length, 0);
    if (!total) return vscode.window.showInformationMessage('Folder Diff: nothing to sync. Equal files and errors are never touched.');
    const md = [`# Sync plan: ${pick.label}`, '', `- Left: \`${this.sideInfo().left.path}\``, `- Right: \`${this.rightRoot()}\``, ''];
    for (const [h, lines] of parts) if (lines.length) md.push(`## ${h} (${lines.length})`, '', ...lines.map(l => `- ${l}`), '');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md.join('\n') });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const summary = parts.filter(p => p[1].length).map(p => `${p[0]}: ${p[1].length}`).join('\n');
    const ok = `Apply ${total} changes`;
    const go = await vscode.window.showWarningMessage(`Sync: ${pick.label}?`, { modal: true, detail: `The full list is in the plan next to this compare.\n\n${summary}${this.deps.settings().deleteToTrash ? '\n\nDeleted files go to the Trash.' : '\n\nDeletes are for good (folderDiff.deleteToTrash is off).'}` }, ok);
    if (go !== ok) return undefined;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Folder Diff: syncing' }, async () => {
      const a = await this.runCopies(plan.copyToRight.items, 'left', 'right');
      const b = await this.runCopies(plan.copyToLeft.items, 'right', 'left');
      const c = await this.runDeletes(plan.deleteRight.items, 'right');
      const d = await this.runDeletes(plan.deleteLeft.items, 'left');
      return { done: a.done + b.done + c.done + d.done, errors: [...a.errors, ...b.errors, ...c.errors, ...d.errors] };
    });
    this.report_(r, 'Synced');
    how = null;
    return this.start();
  }

  async report() {
    const { vscode } = this;
    if (this.running) return vscode.window.showInformationMessage('Folder Diff: wait until the compare has finished, or press Cancel.');
    if (!(await this.deps.pro.allow('Document change report', 'One Markdown report of the text changes inside every changed Word, Excel, CSV, Parquet and PDF file.'))) return undefined;
    const docs = this.entries.filter(e => e.status === 'changed' && e.l && e.r && e.l.kind === 'file' && e.r.kind === 'file' && this.deps.opener.kindOf(e.name)).slice(0, 300);
    if (!docs.length) return vscode.window.showInformationMessage('Folder Diff: no changed Word, Excel, CSV, Parquet or PDF files in this compare.');
    const out = [`# Document changes`, '', `- Left: \`${this.sideInfo().left.path}\``, `- Right: \`${this.rightRoot()}\``, `- ${summaryLine(this.counts)}`, `- ${docs.length} changed documents`, ''];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Folder Diff: document report', cancellable: true }, async (progress, token) => {
      let k = 0;
      for (const e of docs) {
        if (token.isCancellationRequested) { out.push('', '(stopped by the user)'); break; }
        progress.report({ message: `${++k} of ${docs.length}: ${e.name}`, increment: 100 / docs.length });
        const kind = this.deps.opener.kindOf(e.name);
        const [a, b] = await Promise.all([this.deps.opener.convertSide(kind, this.sideOf(e, 'left'), e.name), this.deps.opener.convertSide(kind, this.sideOf(e, 'right'), e.name)]);
        out.push(`## ${e.l.rel}`, '');
        if (!a.ok || !b.ok) { out.push(`Could not read: ${!a.ok ? a.error : b.error}`, ''); continue; }
        const { removed, added } = lineChanges(a.text, b.text);
        if (!removed.length && !added.length) { out.push('Same text. Only formatting, images or metadata differ.', ''); continue; }
        out.push(`${removed.length} lines only on the left, ${added.length} lines only on the right.`, '');
        for (const l of removed.slice(0, 8)) out.push(`- \`-\` ${mdLine(l)}`);
        for (const l of added.slice(0, 8)) out.push(`- \`+\` ${mdLine(l)}`);
        if (removed.length > 8 || added.length > 8) out.push('- ...');
        out.push('');
      }
    });
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: out.join('\n') });
    await vscode.window.showTextDocument(doc, { preview: false });
    return undefined;
  }
}

function mdLine(s) { const t = s.trim().replace(/\s+/g, ' '); return (t.length > 160 ? t.slice(0, 160) + '...' : t).replace(/[`|]/g, m => '\\' + m); }

/** Lines only on one side (multiset difference). Fast and good enough for a summary. */
function lineChanges(a, b) {
  const count = new Map();
  const la = a.split('\n').filter(l => l.trim()), lb = b.split('\n').filter(l => l.trim());
  for (const l of la) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of lb) { const c = count.get(l) || 0; if (c > 0) count.set(l, c - 1); else added.push(l); }
  const removed = [];
  const left = new Map(count);
  for (const l of la) { const c = left.get(l) || 0; if (c > 0) { removed.push(l); left.set(l, c - 1); } }
  return { removed, added };
}

module.exports = { ComparePanel, lineChanges, listLines, VIEW };
