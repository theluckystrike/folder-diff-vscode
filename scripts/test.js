'use strict';
// npm test: build the bundles (production), then run every test file with node's test runner. No network.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (args) => { const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status || 1); };
run([path.join('scripts', 'build.js'), '--production']);
const files = fs.readdirSync(path.join(root, 'test')).filter((f) => /\.test\.m?js$/.test(f)).sort().map((f) => path.join('test', f));
run(['--test', ...files]);
