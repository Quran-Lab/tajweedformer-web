// What `npm publish` would ship, checked before it ships:  npm run check:package
//
// Runs `npm pack --dry-run --json` and fails unless the tarball holds README.md, AGENTS.md, CHANGELOG.md, the type
// declarations, every file the `exports` map names, the engine and its Worker, the docs the README links and the
// examples; and unless every place that states the package's version states the same one (2.0.2 shipped a README
// that pointed to an AGENTS.md the package did not contain, and docs that named 2.0.1 as current).
// AGENTS.md is written into the public repository by the release tooling: where the repository has none (the
// development repository) this says so and checks the rest. dist/ must be built (npm run build:all).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const problems = [];
const notes = [];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error(`check-package: npm pack failed:\n${(r.stderr || r.stdout || '').slice(-800)}`); process.exit(1); }
let packed;
try { packed = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch (e) { console.error(`check-package: cannot read npm pack's answer: ${e.message}`); process.exit(1); }
const files = new Set(packed[0].files.map((f) => f.path.replace(/\\/g, '/')));

// every file the exports map names, for every condition
const exported = [];
for (const e of Object.values(pkg.exports)) for (const f of typeof e === 'string' ? [e] : Object.values(e)) exported.push(f.replace(/^\.\//, ''));
const haveAgents = existsSync(path.join(root, 'AGENTS.md'));
if (!pkg.files.includes('AGENTS.md')) problems.push('"AGENTS.md" is not in package.json "files"');
if (!haveAgents) notes.push('AGENTS.md is not in this repository (the release tooling writes it into the public one): not checked here');
const required = ['README.md', 'CHANGELOG.md', ...(haveAgents ? ['AGENTS.md'] : []), 'package.json', ...new Set(exported),
  'web/index.d.ts', 'web/api/worker.js', 'web/tajweed/node.js', 'web/tajweed/install.js', 'web/platform/node-hook.js',
  'dist/tajweedformer.mjs', 'dist/tajweedformer.wasm', 'dist/tajweedformer-opus.mjs', 'dist/tajweedformer-opus.wasm',
  'docs/api.md', 'docs/migrating-to-3.md', 'examples/quickstart.html', 'examples/node.mjs',
  'examples/vite/index.html', 'examples/vite/main.js', 'examples/vite/package.json', 'examples/vite/README.md'];
for (const f of required) if (!files.has(f)) problems.push(`${f} is not in the package`);
// every file the README and the docs link by a relative path is shipped
for (const doc of ['README.md', 'docs/api.md', 'docs/migrating-to-3.md', ...(haveAgents ? ['AGENTS.md'] : [])]) {
  if (!existsSync(path.join(root, doc))) continue;
  for (const m of read(doc).matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc), m[1]));
    if (/^\.github\/|^docs\/banner-/.test(target)) continue; // the repository's own images, not part of the package
    if (!files.has(target)) problems.push(`${doc} links ${m[1]}, which is not in the package`);
  }
}
// nothing that does not belong
for (const f of files) if (/(^|\/)node_modules\/|^test\/|^vendor\/|^examples\/vite\/dist\/|\.log$/.test(f)) problems.push(`${f} must not be in the package`);

// one version everywhere it is stated
const stated = [
  ['web/tajweed/manifest.js SDK_VERSION', (/export const SDK_VERSION = '([^']+)'/.exec(read('web/tajweed/manifest.js')) || [])[1]],
  ['web/platform/client.js SDK_VERSION', (/export const SDK_VERSION = '([^']+)'/.exec(read('web/platform/client.js')) || [])[1]],
  ['web/sharing/uploader.js SDK_VERSION', (/export const SDK_VERSION = '([^']+)'/.exec(read('web/sharing/uploader.js')) || [])[1]],
  ['the newest entry of CHANGELOG.md', (/^## (\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md')) || [])[1]],
  ['the title of docs/api.md', (/^# .*?(\d+\.\d+\.\d+)/m.exec(read('docs/api.md')) || [])[1]],
];
for (const [where, v] of stated) if (v !== pkg.version) problems.push(`${where} says ${v}, package.json says ${pkg.version}`);
// a pinned package version in a shipped text (a CDN link, an install line) is this version
for (const f of files) {
  if (!/\.(md|js|mjs|html|json|ts)$/.test(f) || f === 'CHANGELOG.md' || f.startsWith('dist/') || !existsSync(path.join(root, f))) continue;
  for (const m of read(f).matchAll(/@quran-lab\/tajweedformer@(\d+\.\d+\.\d+)/g)) if (m[1] !== pkg.version) problems.push(`${f} names @quran-lab/tajweedformer@${m[1]}`);
}

for (const n of notes) console.log(`check-package: note: ${n}`);
if (problems.length) {
  console.error(`check-package: FAILED (${problems.length})`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-package: OK: ${pkg.name}@${pkg.version}, ${files.size} files, ${Math.round(packed[0].unpackedSize / 1024)} KB unpacked; `
  + `README.md, ${haveAgents ? 'AGENTS.md, ' : ''}CHANGELOG.md, the type declarations and the ${new Set(exported).size} files of the exports map are in it; one version everywhere`);
