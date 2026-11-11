// Builds the plain Vite example (examples/vite) the way an app builds: `vite build` with no config file.
//
//   npm run example:build        (needs dist/: npm run build:all)
//
// Fails when the example has a Vite config, when the build fails, or when its output names a `node:` module
// ("Module "node:path" has been externalized for browser compatibility" was the 2.x fault: the package's browser
// entry reached Node built-ins). Installs the example's packages first: Vite, and this checkout as
// @quran-lab/tajweedformer, packed the way `npm publish` packs it (the example's .npmrc sets install-links, so
// the build sees the files an app gets from npm, not a link to the repository). Prints the build's last lines.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = path.join(root, 'examples', 'vite');
const fail = (m) => { console.error(`example build: FAILED: ${m}`); process.exit(1); };

for (const f of ['dist/tajweedformer.mjs', 'dist/tajweedformer.wasm', 'dist/tajweedformer-opus.mjs', 'dist/tajweedformer-opus.wasm']) {
  if (!existsSync(path.join(root, f))) fail(`${f} is missing (npm run build:all)`);
}
const config = readdirSync(dir).filter((f) => /^vite\.config\./.test(f));
if (config.length) fail(`the example must build with no config file, found ${config.join(', ')}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' && cmd === npm, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
// a fresh copy of the package every time (a copy does not follow later changes of the checkout)
rmSync(path.join(dir, 'node_modules', '@quran-lab'), { recursive: true, force: true });
rmSync(path.join(dir, 'package-lock.json'), { force: true });
rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
const i = run(npm, ['install', '--install-links', '--no-audit', '--no-fund']);
if (i.status !== 0) fail(`npm install: ${(i.stderr || i.stdout || '').slice(-800)}`);
const installed = path.join(dir, 'node_modules', '@quran-lab', 'tajweedformer');
if (!existsSync(path.join(installed, 'web', 'index.js')) || existsSync(path.join(installed, 'test'))) fail('the package was not installed as a packed copy');
const b = run(process.execPath, [path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build']);
const out = `${b.stdout || ''}${b.stderr || ''}`;
console.log(out.trimEnd().split('\n').slice(-16).join('\n'));
if (b.status !== 0) fail(`vite build exited with ${b.status}`);
const bad = out.split('\n').filter((l) => /node:[a-z]|externalized for browser compatibility/i.test(l));
if (bad.length) fail(`the build names a Node module:\n${bad.join('\n')}`);
const assets = readdirSync(path.join(dir, 'dist', 'assets'));
for (const [what, re] of [['the engine\'s Worker', /^worker-.*\.js$/], ['the engine\'s wasm', /^tajweedformer-[^.]*\.wasm$/]]) {
  if (!assets.some((f) => re.test(f))) fail(`${what} is not in the build (${assets.join(', ')})`);
}
console.log(`example build: OK (vite build with no config file; ${assets.length} files in dist/assets, the Worker and the wasm among them)`);
