// What `npm publish` would ship, checked before it ships:  npm run check:package  [-- --publish]
//
// SDK 4.0 (API 4). The package is the hosted loader's thin wrapper for browsers (web/index.js) and the Node path for
// desktop apps (sdk4/node/): never a model file, and never the engine (the Node path fetches the signed engine from
// web.quranlab.ai and verifies it). Runs `npm pack --dry-run --json` and fails unless
// - the tarball holds README.md, CHANGELOG.md, NAMES.md, package.json, the type declarations, every file the exports
//   map names, every file README.md, AGENTS.md and the shipped docs link by a relative path, and AGENTS.md where the
//   repository has one (the release tooling writes it into the public repository);
// - every module the entry points reach is in it: static and dynamic imports, re-exports and the `new URL(...,
//   import.meta.url)` of the Node path's Worker, followed from module to module (a missing file breaks every Node app);
// - nothing that does not belong is in it: node_modules, test/, dist/, vendor/, WebAssembly, a model or engine file, a
//   log (2.0.2 and 3.x shipped what they should not have, or missed what they should);
// - every place that states the package's version states the same one: the SDK_VERSION constants, the first line of
//   the type declarations, the newest CHANGELOG entry, the title of docs/api.md, and any pinned
//   @quran-lab/tajweedformer@x.y.z in a shipped text;
// - with --publish (the publish workflow, after scripts/stamp-engine.mjs): the Node entry's built-in engine
//   (sdk4/node/engine.js BUILTIN_ENGINE) is an engine id. In a source tree it is null, which is fine without --publish.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const publishing = process.argv.includes('--publish');
const problems = [];
const notes = [];

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error(`check-package: npm pack failed:\n${(r.stderr || r.stdout || '').slice(-800)}`); process.exit(1); }
let packed;
try { packed = JSON.parse(r.stdout.slice(r.stdout.indexOf('['))); } catch (e) { console.error(`check-package: cannot read npm pack's answer: ${e.message}`); process.exit(1); }
const files = new Set(packed[0].files.map((f) => f.path.replace(/\\/g, '/')));

// the files a 4.0 package must hold
const exported = [];
for (const e of Object.values(pkg.exports)) for (const f of typeof e === 'string' ? [e] : Object.values(e)) exported.push(f.replace(/^\.\//, ''));
const haveAgents = existsSync(path.join(root, 'AGENTS.md'));
if (!pkg.files.includes('AGENTS.md')) problems.push('"AGENTS.md" is not in package.json "files"');
if (!haveAgents) notes.push('AGENTS.md is not in this repository (the release tooling writes it into the public one): not checked here');
const required = ['README.md', 'CHANGELOG.md', 'NAMES.md', 'package.json', ...(haveAgents ? ['AGENTS.md'] : []), ...new Set(exported),
  'web/index.d.ts', 'docs/api.md', 'docs/migrating-to-4.md'];
for (const f of required) if (!files.has(f)) problems.push(`${f} is not in the package`);

// every file the README, AGENTS.md and the shipped docs link by a relative path is shipped
for (const doc of ['README.md', ...(haveAgents ? ['AGENTS.md'] : []), ...[...files].filter((f) => /^docs\/.*\.md$/.test(f))]) {
  if (!existsSync(path.join(root, doc))) continue;
  for (const m of read(doc).matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(doc), m[1]));
    if (/^\.github\/|^docs\/banner-|^LICENSE$/.test(target)) continue; // the repository's own pages and images
    if (!files.has(target)) problems.push(`${doc} links ${m[1]}, which is not in the package`);
  }
}

// every module the entry points reach
const IMPORTS = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];
const seen = new Set();
const queue = exported.filter((f) => /\.m?js$/.test(f));
while (queue.length) {
  const f = queue.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  if (!files.has(f)) { problems.push(`${f} is reached from an entry point and is not in the package`); continue; }
  const text = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const rx of IMPORTS) {
    for (const m of text.matchAll(rx)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (/\.m?js$/.test(target)) queue.push(target);
      else if (!files.has(target)) problems.push(`${f} loads ${m[1]}, which is not in the package`);
    }
  }
}

// nothing that does not belong
for (const f of files) {
  if (/(^|\/)node_modules\/|^test\/|^dist\/|^vendor\/|^examples\/vite\/|\.(wasm|qle|zfx|tflite|onnx|log)$/.test(f)) problems.push(`${f} must not be in the package`);
}

// one version everywhere it is stated
const constant = (f) => (existsSync(path.join(root, f)) ? (/export const SDK_VERSION = '([^']+)'/.exec(read(f)) || [])[1] : 'missing');
const stated = [
  ['sdk4/loader/client.js SDK_VERSION', constant('sdk4/loader/client.js')],
  ['sdk4/node/index.js SDK_VERSION', constant('sdk4/node/index.js')],
  ['web/tajweed/manifest.js SDK_VERSION', constant('web/tajweed/manifest.js')],
  ['web/platform/client.js SDK_VERSION', constant('web/platform/client.js')],
  ['web/sharing/uploader.js SDK_VERSION', constant('web/sharing/uploader.js')],
  ['the first line of web/index.d.ts', (/@quran-lab\/tajweedformer (\d+\.\d+\.\d+)/.exec(read('web/index.d.ts').split('\n')[0]) || [])[1]],
  ['the newest entry of CHANGELOG.md', (/^## (\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md')) || [])[1]],
  ['the title of docs/api.md', (/^# .*?(\d+\.\d+\.\d+)/m.exec(read('docs/api.md')) || [])[1]],
];
for (const [where, v] of stated) if (v !== pkg.version) problems.push(`${where} says ${v}, package.json says ${pkg.version}`);
for (const f of files) {
  if (!/\.(md|js|mjs|html|json|ts)$/.test(f) || f === 'CHANGELOG.md' || !existsSync(path.join(root, f))) continue;
  for (const m of read(f).matchAll(/@quran-lab\/tajweedformer@(\d+\.\d+\.\d+)/g)) if (m[1] !== pkg.version) problems.push(`${f} names @quran-lab/tajweedformer@${m[1]}`);
}

// the Node entry's built-in engine
const builtIn = /^export const BUILTIN_ENGINE = (null|'([^']*)');$/m.exec(read('sdk4/node/engine.js'));
if (!builtIn) problems.push('sdk4/node/engine.js has no line `export const BUILTIN_ENGINE = ...;`');
else if (builtIn[2] !== undefined && !/^[0-9]{8}\.[0-9a-f]{12}$/.test(builtIn[2])) problems.push(`BUILTIN_ENGINE '${builtIn[2]}' is not an engine id`);
else if (publishing && builtIn[1] === 'null') problems.push('BUILTIN_ENGINE is null: run node scripts/stamp-engine.mjs <engine id> before publishing');
else notes.push(`BUILTIN_ENGINE: ${builtIn[1]}`);

for (const n of notes) console.log(`check-package: note: ${n}`);
if (problems.length) {
  console.error(`check-package: FAILED (${problems.length})`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-package: OK: ${pkg.name}@${pkg.version}, ${files.size} files, ${Math.round(packed[0].unpackedSize / 1024)} KB unpacked; `
  + `README.md, ${haveAgents ? 'AGENTS.md, ' : ''}CHANGELOG.md, NAMES.md, the type declarations, the ${new Set(exported).size} files of the exports map `
  + `and the ${seen.size} modules they reach are in it; nothing of the engine or the model; one version everywhere`);
