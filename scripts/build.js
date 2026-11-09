'use strict';
// Bundles the extension host, the two worker threads and the webview with esbuild, then checks the licence of
// every npm package that went into a bundle (permissive licences only) and writes THIRD-PARTY-NOTICES.md.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const prod = process.argv.includes('--production');
const common = { bundle: true, minify: prod, sourcemap: false, legalComments: 'none', logLevel: 'warning', absWorkingDir: root, metafile: true };
const ALLOWED = /^(\(?(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|Zlib|0BSD|BlueOak-1\.0\.0|Unlicense)( (OR|AND) (MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|Zlib|GPL-3\.0-or-later))*\)?)$/;

function pkgOf(file) {
  const m = file.replace(/\\/g, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  return m ? m[1] : null;
}

(async () => {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const results = await Promise.all([
    esbuild.build({ ...common, entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] }),
    esbuild.build({ ...common, entryPoints: ['src/worker/scan.js'], outfile: 'dist/scan-worker.js', platform: 'node', format: 'cjs', target: 'node18' }),
    esbuild.build({
      ...common, entryPoints: ['src/worker/convert.mjs'], outfile: 'dist/convert-worker.mjs', platform: 'node', format: 'esm', target: 'node18',
      // CommonJS packages inside an ES module bundle still call require('fs'): give them a real require.
      banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
      // pdf.js probes for optional native canvas packages that this extension never uses.
      external: ['@napi-rs/canvas', 'canvas', 'path2d'],
    }),
    esbuild.build({ ...common, entryPoints: ['src/webview/main.js'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome110' }),
  ]);
  const pkgs = new Map();
  for (const r of results) for (const f of Object.keys(r.metafile.inputs)) { const p = pkgOf(f); if (p) pkgs.set(p, true); }
  const problems = [], notices = [];
  for (const p of [...pkgs.keys()].sort()) {
    const dir = path.resolve(root, p);
    let pj;
    try { pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { problems.push(p + ': no package.json'); continue; }
    const lic = typeof pj.license === 'string' ? pj.license : (pj.license && pj.license.type) || '';
    if (!ALLOWED.test(lic)) problems.push(`${pj.name}@${pj.version}: licence "${lic}" is not on the allowed list`);
    const lf = fs.readdirSync(dir).find(n => /^(licen[sc]e|copying)(\.|$)/i.test(n));
    notices.push(`## ${pj.name} ${pj.version} (${lic})\n\n${lf ? fs.readFileSync(path.join(dir, lf), 'utf8').trim() : 'Licence: ' + lic}\n`);
  }
  if (problems.length) { console.error('Licence check failed:\n  ' + problems.join('\n  ')); process.exit(1); }
  fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), '# Third-party notices\n\nThese packages are bundled into the extension.\n\n' + notices.join('\n'));
  const kb = f => (fs.statSync(path.join(root, 'dist', f)).size / 1024).toFixed(0) + ' KB';
  console.log(`built: extension ${kb('extension.js')}, scan ${kb('scan-worker.js')}, convert ${kb('convert-worker.mjs')}, webview ${kb('webview.js')}; ${pkgs.size} packages, licences ok`);
})().catch(e => { console.error(e); process.exit(1); });
