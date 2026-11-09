'use strict';
// Test folders live in ~/folder-diff-work (not the temp folder) and are removed in teardown.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORK = process.env.FOLDER_DIFF_WORK || path.join(os.homedir(), 'folder-diff-work');

function mkWork(name) {
  const d = path.join(WORK, `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Writes files: { 'a/b.txt': 'text' | Buffer }. */
function write(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}

/** Removes a test folder, first giving back read and write permission that a hostile test took away. */
function rm(d) {
  try { require('child_process').execFileSync('chmod', ['-R', 'u+rwx', d], { stdio: 'ignore' }); } catch (_) {}
  fs.rmSync(d, { recursive: true, force: true });
}

module.exports = { WORK, mkWork, write, rm };
