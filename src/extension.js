'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { ComparePanel } = require('./panel');
const { createDiffOpener } = require('./diffopen');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');
const { createPro } = require('./pro');
const git = require('./core/git');
const { guardDest, guardDelete } = require('./core/dest');
const { plan3 } = require('./core/plan');
const { filesEqual } = require('./core/bytes');

const EXT_ID = 'zovo.zovo-folder-diff';
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration('folderDiff');
  return {
    compareMode: c.get('compareMode', 'content') === 'quick' ? 'quick' : 'content',
    exclude: c.get('exclude', ['node_modules/', '.git/', 'dist/', '.DS_Store', 'Thumbs.db']),
    useGitignore: c.get('useGitignore', true),
    followSymlinks: c.get('followSymlinks', false),
    showSame: c.get('showSame', false),
    mtimeToleranceSeconds: Math.max(0, Number(c.get('mtimeToleranceSeconds', 2)) || 0),
    maxTextDiffMB: Math.max(1, Number(c.get('maxTextDiffMB', 50)) || 50),
    maxConvertMB: Math.max(1, Number(c.get('maxConvertMB', 200)) || 200),
    maxCompareRows: Math.max(100, Number(c.get('maxCompareRows', 100000)) || 100000),
    convertTimeoutSec: Math.max(10, Number(c.get('convertTimeoutSec', 120)) || 120),
    deleteToTrash: c.get('deleteToTrash', true),
  };
}

const isFolder = async uri => { try { return (await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory; } catch (_) { return false; } };

async function pickFolder(title, defaultUri) {
  const p = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Select', title, defaultUri });
  return p && p[0] ? p[0] : null;
}

function sessionsStore(context) {
  const KEY = 'folderDiff.sessions';
  return {
    list: () => context.globalState.get(KEY, []),
    async save(s) {
      const list = context.globalState.get(KEY, []).filter(x => x.name !== s.name);
      list.unshift({ ...s, savedAt: Date.now() });
      await context.globalState.update(KEY, list.slice(0, 50));
    },
    async remove(name) { await context.globalState.update(KEY, context.globalState.get(KEY, []).filter(x => x.name !== name)); },
  };
}

/** Runs the scan worker once to the end and returns the entries (for the three-way compare). */
function scanOnce(context, left, right, s, token) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(context.extensionUri.fsPath, 'dist', 'scan-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    let entries = null;
    const sub = token && token.onCancellationRequested(() => { w.terminate(); reject(new Error('cancelled')); });
    w.on('message', m => {
      if (m.type === 'tree') entries = m.entries;
      else if (m.type === 'update') for (const [i, status, note] of m.changes) { entries[i].status = status; entries[i].note = note; }
      else if (m.type === 'fatal') { w.terminate(); if (sub) sub.dispose(); reject(new Error(m.message)); }
      else if (m.type === 'done') { w.terminate(); if (sub) sub.dispose(); resolve(entries); }
    });
    w.on('error', e => { if (sub) sub.dispose(); reject(e); });
    w.postMessage({ type: 'start', job: { left: { kind: 'dir', path: left }, right: { kind: 'dir', path: right }, mode: 'content', exclude: s.exclude, useGitignore: s.useGitignore, followSymlinks: false, concurrency: 4 } });
  });
}

function activate(context) {
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: 'folderDiff', name: 'Folder Compare' });
  registerSupport({ vscode, context, prefix: 'folderDiff', selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  const refreshPro = () => { for (const p of panels) p.post({ type: 'pro', pro: pro.state() }); };
  context.subscriptions.push(pro.onDidChange(() => refreshPro()));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('folderDiff.showProTools')) refreshPro(); }));
  const sessions = sessionsStore(context);
  const panels = new Set();
  let current = null;
  const opener = createDiffOpener({ vscode, context, settings, gitBlob: (side, max) => (current ? current.gitBlob(side, max) : Promise.resolve({ ok: false, error: 'The compare is closed.' })) });

  function openCompare(job) {
    const p = new ComparePanel({ vscode, context, opener, rating, pro, settings, sessions }, job);
    panels.add(p);
    current = p;
    p.panel.onDidChangeViewState(e => { if (e.webviewPanel.active) current = p; });
    p.panel.onDidDispose(() => { panels.delete(p); if (current === p) current = [...panels].pop() || null; });
    return p;
  }

  async function compareDirs(a, b) {
    if (!a || !b) return;
    if (a.scheme !== 'file' || b.scheme !== 'file') { vscode.window.showInformationMessage('Folder Compare compares folders on this computer (or in a Remote window, on that machine).'); return; }
    if (!(await isFolder(a)) || !(await isFolder(b))) { vscode.window.showInformationMessage('Folder Compare: pick two folders. To compare two files, select them and use "Compare Selected".'); return; }
    if (path.resolve(a.fsPath) === path.resolve(b.fsPath)) { vscode.window.showInformationMessage('Folder Compare: that is the same folder twice. Pick two different folders.'); return; }
    openCompare({ left: { kind: 'dir', path: a.fsPath }, right: { kind: 'dir', path: b.fsPath } });
  }

  const wsDefault = () => (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri : undefined);

  context.subscriptions.push(
    vscode.commands.registerCommand('folderDiff.compareSelected', async (uri, uris) => {
      const list = Array.isArray(uris) ? uris.filter(u => u instanceof vscode.Uri) : [];
      if (list.length === 2) return compareDirs(list[0], list[1]);
      if (list.length > 2) return vscode.window.showInformationMessage('Folder Compare: select exactly two folders.');
      const a = uri instanceof vscode.Uri ? uri : await pickFolder('Folder Compare: pick the left folder', wsDefault());
      if (!a) return undefined;
      const b = await pickFolder(`Folder Compare: compare ${path.basename(a.fsPath)} with`, vscode.Uri.file(path.dirname(a.fsPath)));
      return compareDirs(a, b);
    }),
    vscode.commands.registerCommand('folderDiff.compareFolders', async () => {
      const a = await pickFolder('Folder Compare: pick the left folder', wsDefault());
      if (!a) return undefined;
      const b = await pickFolder(`Folder Compare: compare ${path.basename(a.fsPath)} with (right folder)`, vscode.Uri.file(path.dirname(a.fsPath)));
      return compareDirs(a, b);
    }),
    vscode.commands.registerCommand('folderDiff.compareWith', async (uri) => {
      const a = uri instanceof vscode.Uri ? uri : await pickFolder('Folder Compare: pick the left folder', wsDefault());
      if (!a) return undefined;
      const b = await pickFolder(`Folder Compare: compare ${path.basename(a.fsPath)} with (right folder)`, vscode.Uri.file(path.dirname(a.fsPath)));
      return compareDirs(a, b);
    }),
    vscode.commands.registerCommand('folderDiff.compareWithGitRef', async (uri) => {
      if (!vscode.workspace.isTrusted) return vscode.window.showInformationMessage('Compare with a Git ref runs git, so it needs a trusted workspace. Trust this folder first.');
      const dir = uri instanceof vscode.Uri ? uri : await pickFolder('Folder Compare: pick a folder in a Git repository', wsDefault());
      if (!dir || dir.scheme !== 'file') return undefined;
      const refs = await git.listRefs(dir.fsPath);
      if (!refs.ok) return vscode.window.showWarningMessage('Folder Compare: ' + refs.error);
      const items = [{ label: 'HEAD', description: 'the last commit' }, ...refs.refs.map(r => ({ label: r.name, description: `${r.type === 'tag' ? 'tag' : r.name.includes('/') && !r.name.startsWith('refs') ? 'branch' : 'branch'} ${r.date || ''}`.trim() })),
        { label: '$(edit) Type a ref or commit...', description: 'for example HEAD~3 or a commit id', custom: true }];
      const pick = await vscode.window.showQuickPick(items, { title: `Folder Compare: compare ${path.basename(dir.fsPath)} with`, placeHolder: 'Pick a branch, tag or HEAD' });
      if (!pick) return undefined;
      let ref = pick.label;
      if (pick.custom) { ref = (await vscode.window.showInputBox({ title: 'Folder Compare: Git ref', prompt: 'A branch, tag, HEAD~n or a commit id' })) || ''; if (!ref) return undefined; }
      const ok = await git.resolveRef(dir.fsPath, ref);
      if (!ok.ok) return vscode.window.showWarningMessage('Folder Compare: ' + ok.error);
      openCompare({ left: { kind: 'git', cwd: dir.fsPath, ref }, right: { kind: 'dir', path: dir.fsPath } });
      return undefined;
    }),
    vscode.commands.registerCommand('folderDiff.openSaved', async () => {
      const list = sessions.list();
      if (!list.length) return vscode.window.showInformationMessage('Folder Compare: no saved compares yet. Press Save in a compare to add one.');
      const pick = await vscode.window.showQuickPick(list.map(s => ({ label: s.name, description: s.left.kind === 'git' ? `${s.right.path} ↔ ${s.left.ref}` : `${s.left.path} ↔ ${s.right.path}`, s,
        buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remove from the list' }] })), { title: 'Folder Compare: saved compares' });
      if (!pick) return undefined;
      const missing = [pick.s.left, pick.s.right].filter(x => x.kind === 'dir' && !fs.existsSync(x.path)).map(x => x.path);
      if (missing.length) return vscode.window.showWarningMessage('Folder Compare: this folder is gone: ' + missing.join(', '));
      openCompare({ left: pick.s.left, right: pick.s.right, mode: pick.s.mode });
      return undefined;
    }),
    vscode.commands.registerCommand('folderDiff.threeWay', () => threeWay(context, pro)),
    vscode.commands.registerCommand('folderDiff.trySample', async () => {
      const base = vscode.Uri.joinPath(context.extensionUri, 'samples');
      openCompare({ left: { kind: 'dir', path: vscode.Uri.joinPath(base, 'release-1.0').fsPath }, right: { kind: 'dir', path: vscode.Uri.joinPath(base, 'release-1.1').fsPath } });
    }),
    vscode.commands.registerCommand('folderDiff.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#folderDiff.start`, false)),
  );
  return { openCompare, panels: () => [...panels] };
}

async function threeWay(context, pro) {
  if (!(await pro.allowed('merge3'))) return;
  const base = await pickFolder('Three-way compare 1 of 3: the BASE folder (the common original)');
  if (!base) return;
  const left = await pickFolder('Three-way compare 2 of 3: the LEFT copy (yours)', vscode.Uri.file(path.dirname(base.fsPath)));
  if (!left) return;
  const right = await pickFolder('Three-way compare 3 of 3: the RIGHT copy (theirs)', vscode.Uri.file(path.dirname(base.fsPath)));
  if (!right) return;
  const s = settings();
  let rows;
  try {
    rows = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Folder Compare: three-way compare', cancellable: true }, async (progress, token) => {
      progress.report({ message: 'base and left' });
      const bl = await scanOnce(context, base.fsPath, left.fsPath, s, token);
      progress.report({ message: 'base and right' });
      const br = await scanOnce(context, base.fsPath, right.fsPath, s, token);
      // Both sides changed a file: equal if the left and right bytes are the same.
      const lrSame = new Map();
      const lmap = new Map(bl.filter(e => e.r).map(e => [e.key, e.r.rel])), rmap = new Map(br.filter(e => e.r).map(e => [e.key, e.r.rel]));
      const brByKey = new Map(br.map(x => [x.key, x]));
      for (const e of bl) {
        if (e.kind === 'dir' || e.status === 'same') continue;
        const other = brByKey.get(e.key);
        if (!other || other.status === 'same' || !lmap.has(e.key) || !rmap.has(e.key)) continue;
        try { lrSame.set(e.key, (await filesEqual(path.join(left.fsPath, lmap.get(e.key)), path.join(right.fsPath, rmap.get(e.key)))).equal); } catch (_) { lrSame.set(e.key, false); }
      }
      return plan3(bl, br, k => !!lrSame.get(k));
    });
  } catch (e) {
    if (String(e && e.message) !== 'cancelled') vscode.window.showErrorMessage('Folder Compare: ' + (e.message || e));
    return;
  }
  const by = r => rows.filter(x => x.result === r);
  const conflicts = by('conflict'), acts = rows.filter(x => x.action !== 'none');
  const md = [`# Three-way folder compare`, '', `- Base: \`${base.fsPath}\``, `- Left: \`${left.fsPath}\``, `- Right: \`${right.fsPath}\``, '',
    `${by('left').length} changed on the left only, ${by('right').length} on the right only, ${by('both-same').length} changed the same way on both, ${conflicts.length} conflicts, ${by('unchanged').length} unchanged.`, ''];
  const sect = (h, list, f) => { if (list.length) md.push(`## ${h} (${list.length})`, '', ...list.map(f), ''); };
  sect('Conflicts (changed differently on both sides; merge never touches these)', conflicts, r => `- ${r.rel} (left: ${r.left}, right: ${r.right})`);
  sect('Changed on the left only', by('left'), r => `- ${r.rel} (${r.left})`);
  sect('Changed on the right only', by('right'), r => `- ${r.rel} (${r.right})`);
  sect('Changed the same way on both sides', by('both-same'), r => `- ${r.rel}`);
  sect('Errors', by('error'), r => `- ${r.rel}`);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md.join('\n') });
  await vscode.window.showTextDocument(doc, { preview: false });
  await pro.produced('merge3'); // the report is on screen: that is the output of a try
  if (!acts.length) { vscode.window.showInformationMessage(`Folder Compare: nothing to merge into the base. ${conflicts.length} conflicts are listed in the report.`); return; }
  const ok = `Merge ${acts.length} into Base`;
  const lines = acts.slice(0, 25).map(a => `${a.action === 'delete' ? 'delete     ' : a.action === 'copyLeft' ? 'from left  ' : 'from right '} ${a.rel}`);
  if (acts.length > 25) lines.push(`...and ${acts.length - 25} more`);
  const go = await vscode.window.showWarningMessage(`Merge the one-sided changes into the base folder?`, { modal: true, detail: `Base: ${base.fsPath}\n${conflicts.length} conflicts stay as they are.\n\n${lines.join('\n')}` }, ok);
  if (go !== ok) return;
  const errors = [];
  let done = 0;
  for (const a of acts) {
    const dst = path.join(base.fsPath, ...(a.baseRel || a.leftRel || a.rightRel).split('/'));
    try {
      if (a.action === 'delete') {
        await guardDelete(base.fsPath, dst);
        await vscode.workspace.fs.delete(vscode.Uri.file(dst), { recursive: true, useTrash: settings().deleteToTrash });
      } else {
        const src = a.action === 'copyLeft' ? path.join(left.fsPath, ...a.leftRel.split('/')) : path.join(right.fsPath, ...a.rightRel.split('/'));
        await guardDest(base.fsPath, dst);
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
        const st = await fs.promises.stat(src);
        await fs.promises.utimes(dst, st.atime, st.mtime).catch(() => {});
      }
      done++;
    } catch (e) { errors.push(`${a.rel}: ${e.message || e}`); }
  }
  if (errors.length) vscode.window.showWarningMessage(`Folder Compare: merged ${done}. ${errors.length} failed: ${errors.slice(0, 3).join('; ')}`);
  else vscode.window.showInformationMessage(`Folder Compare: merged ${done} changes into the base. ${conflicts.length} conflicts are left for you.`);
}

function deactivate() {}

module.exports = { activate, deactivate, settings };
