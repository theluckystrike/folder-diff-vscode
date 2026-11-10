'use strict';
// Zovo Pro for Folder Compare, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 3 free tries each on this computer. A try counts only after
// the tool produced its output (changes written by a sync or merge, a report on screen); Escape or Cancel never uses
// one. Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no
// tries left. Comparing folders, every file diff, filters, copy, delete, export, Git compare and saved compares stay free.
const { createLicense } = require('./license');

const SKU = 'folder-diff-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'folderDiff.proTrial';
const PREFIX = 'folderDiff';

const FEATURES = {
  sync: {
    title: 'Sync folders',
    detail: 'Makes one folder equal to the other, or copies the newer files both ways, after a preview of every copy and delete.',
  },
  merge3: {
    title: 'Three-way compare and merge',
    detail: 'Compares a common base with two changed copies, lists the conflicts and merges the one-sided changes into the base.',
  },
  docReport: {
    title: 'Document change report',
    detail: 'One Markdown report of the text changes inside every changed Word, Excel, CSV, Parquet and PDF file of the compare.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function createPro({ vscode, context, license, productName = 'Folder Compare' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: PREFIX, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => !!lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one Pro panel. */
  async function allowed(f) {
    if (lic.ready) await lic.ready;
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  /** For the webview: whether to show the Pro tools, and the tries left of each. */
  function state() {
    const show = vscode.workspace.getConfiguration(PREFIX).get('showProTools', true) !== false;
    return { show, licensed: licensed(), tries: Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])) };
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, state,
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS };
