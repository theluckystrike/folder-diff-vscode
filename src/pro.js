'use strict';
// Zovo Pro switch. PRO_ENABLED = false ships every feature free: no "Pro" label, no prompt, no license code runs.
// When the owner turns it on, these features ask for Zovo Pro (one-time, all Zovo tools) after FREE_TRIES uses:
//   three-way compare and merge, folder sync with a preview plan, the document change report, saved compares.
// Comparing folders, opening any file diff, copy, delete, export and Git compare stay free for good.
const PRO_ENABLED = false;
const SKU = 'folder-diff-pro';
const FREE_TRIES = 3;
const PRO_FEATURES = ['Three-way compare and merge', 'Folder sync', 'Document change report', 'Saved compares'];

function createPro({ vscode, context, enabled = PRO_ENABLED, license }) {
  vscode.commands.executeCommand('setContext', 'folderDiff.proEnabled', !!enabled);
  let lic = null;
  if (enabled) {
    lic = license || require('./license').createLicense({ vscode, context, sku: SKU, name: 'Folder Diff', commandPrefix: 'folderDiff' });
  } else {
    // The license commands are listed in package.json but hidden while Pro is off. Called anyway, they say so.
    const free = () => vscode.window.showInformationMessage('Every Folder Diff feature is free in this version. Nothing to unlock.');
    for (const c of ['unlockWithSponsors', 'enterLicenseKey', 'getPro', 'removeLicense']) context.subscriptions.push(vscode.commands.registerCommand('folderDiff.' + c, free));
  }
  const KEY = 'folderDiff.proTries';
  return {
    enabled: !!enabled,
    /** Labels for the webview: empty while Pro is off, so no "Pro" mark shows anywhere. */
    labels() { return enabled && lic && !lic.isPro(SKU) ? PRO_FEATURES : []; },
    /** True when the feature may run. Free while Pro is off; else licensed, or one of the first FREE_TRIES uses. */
    async allow(feature, detail) {
      if (!enabled) return true;
      await lic.ready;
      if (lic.isPro(SKU)) { if (lic.refresh) lic.refresh(); return true; }
      const tries = context.globalState.get(KEY, {});
      const used = tries[feature] || 0;
      if (used < FREE_TRIES) { tries[feature] = used + 1; await context.globalState.update(KEY, tries); return true; }
      return lic.requirePro(feature, detail);
    },
  };
}

module.exports = { createPro, PRO_ENABLED, SKU, FREE_TRIES, PRO_FEATURES };
