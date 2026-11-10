'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { guardDest } = require('../src/core/dest');

test('guardDest: never writes through a link on the target side', async () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-dest-'));
  try {
    const root = path.join(w, 'right'), out = path.join(w, 'outside');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true }); fs.mkdirSync(path.join(out, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(out, 'secret.txt'), 'SECRET');
    fs.symlinkSync(path.join(out, 'secret.txt'), path.join(root, 'a.txt'));
    fs.symlinkSync(path.join(out, 'dir'), path.join(root, 'sub'));
    // a link at the destination is removed, so the copy replaces the link and the outside file stays
    await guardDest(root, path.join(root, 'a.txt'));
    assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(out, 'secret.txt'), 'utf8'), 'SECRET');
    // a target folder that links outside is refused, also for new subfolders below it
    await assert.rejects(guardDest(root, path.join(root, 'sub', 'b.txt')), /outside/);
    await assert.rejects(guardDest(root, path.join(root, 'sub', 'new', 'deep', 'b.txt')), /outside/);
    // normal targets pass: an existing real folder, a new folder, the root itself
    await guardDest(root, path.join(root, 'real', 'x.txt'));
    await guardDest(root, path.join(root, 'new', 'y.txt'));
    await guardDest(root, path.join(root, 'z.txt'));
    // a root reached through a link of its own is fine
    fs.symlinkSync(root, path.join(w, 'rootlink'));
    await guardDest(path.join(w, 'rootlink'), path.join(w, 'rootlink', 'real', 'x.txt'));
    // a link inside the root that points inside the root is fine as a folder
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'inner'));
    await guardDest(root, path.join(root, 'inner', 'x.txt'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('guardDelete: a delete stays inside the compared folder and never goes through a linked parent', async () => {
  const { guardDelete } = require('../src/core/dest');
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-del-'));
  try {
    const root = path.join(w, 'right'), out = path.join(w, 'outside');
    fs.mkdirSync(path.join(root, 'real'), { recursive: true }); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'secret.txt'), 'SECRET');
    fs.symlinkSync(out, path.join(root, 'sub'));
    await assert.rejects(guardDelete(root, path.join(root, 'sub', 'secret.txt')), /outside/);
    await assert.rejects(guardDelete(root, path.join(w, 'outside', 'secret.txt')), /outside/);
    await assert.rejects(guardDelete(root, path.join(root, '..', 'outside')), /outside/);
    await assert.rejects(guardDelete(root, root), /compared folder itself/);
    await guardDelete(root, path.join(root, 'sub'));            // the link itself: allowed (removes the link only)
    await guardDelete(root, path.join(root, 'real'));
    await guardDelete(root, path.join(root, 'real', 'x.txt'));
    assert.equal(fs.readFileSync(path.join(out, 'secret.txt'), 'utf8'), 'SECRET');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('guardDest: a destination outside the root by .. is refused', async () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-dot-'));
  try {
    const root = path.join(w, 'right');
    fs.mkdirSync(root, { recursive: true });
    await assert.rejects(guardDest(root, path.join(root, '..', 'escape.txt')), /outside/);
    assert.ok(!fs.existsSync(path.join(w, 'escape.txt')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
