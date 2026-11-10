'use strict';
// npm run package: build, then vsce package into dist/ (no runtime dependencies: everything is bundled by esbuild).
const { spawnSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status || 1); };
run(process.execPath, [path.join('scripts', 'build.js'), '--production']);
run('npx', ['-y', '@vscode/vsce', 'package', '--no-dependencies', '-o', 'dist/']);
