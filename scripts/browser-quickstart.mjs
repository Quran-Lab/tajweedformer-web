// The README's quick start (examples/quickstart.html) in a real browser, from a real capture device to the
// model's output: headless Chrome plays a recitation clip as its microphone (its fake capture device), the page
// asks for the microphone, runs the AudioWorklet and prints what the model heard.
//
//   TAJWEED_MODEL_30=<the folder that holds full/sdk/v4.0 and local30.json> node scripts/browser-quickstart.mjs
//   CHROME=<path to chrome>   PORT=8799   SECONDS=20
//   BUILT=1   open a Vite build of examples/vite instead of the source page (after `npm run example:build`): the
//             build is made here through Vite's API with one alias, the package's name to a module that makes
//             the Client with this script's test seams; the chunks, the Worker bundle and the wasm are Vite's
//   STORAGE=blocked   the browser blocks cookies and site data for every site (Chrome's content setting
//             profile.default_content_setting_values.cookies = 2, in a throwaway profile): IndexedDB, Cache
//             Storage and localStorage are there and refuse. The SDK then keeps the model in memory for the page
//             load. The script checks that the storage is blocked, runs the same takes, loads the page again and
//             checks that every model file is downloaded again and that a take runs.
// Without TAJWEED_MODEL_30 (the model is gated and not in this repository) it says so and exits 0.
//
// What is real: the page's script (only its import line is pointed at a module that makes the Client with the
// SDK's test seams: this script's local API and the keys below), the package's modules and engine (web/ and
// dist/ of this checkout, the engine in a module Worker), the model folder and its verification, getUserMedia,
// the AudioWorklet. What is a stand-in: the API (it answers a config that names the folder's version and build,
// signed with a throwaway key made here), the key the folder is signed with (a throwaway key, named by the
// folders' local30.json, not Quran Lab's) and the microphone's sound (a clip of the folder's self-test set, or TAJWEED_QUICKSTART_WAV, a
// 48 kHz mono wav). After the microphone take the page's sample clip button runs the same path with no
// microphone.
// Needs dist/tajweedformer.mjs (npm run build) and puppeteer-core (a dev dependency). Exits 1 on failure.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const UPLOAD = process.env.TAJWEED_MODEL_30 ? path.join(process.env.TAJWEED_MODEL_30, 'full', 'sdk', 'v4.0') : '';
const PORT = Number(process.env.PORT || 8799);
const SECONDS = Number(process.env.SECONDS || 20);
if (!UPLOAD || !existsSync(path.join(UPLOAD, 'manifest.json'))) { console.log('browser quick start: skipped (set TAJWEED_MODEL_30 to a folder that holds full/sdk/v4.0)'); process.exit(0); }
if (!existsSync(path.join(root, 'dist/tajweedformer.mjs'))) { console.error('dist/tajweedformer.mjs is missing: npm run build'); process.exit(2); }

// the microphone's sound: a 48 kHz mono 16-bit wav
const work = mkdtempSync(path.join(tmpdir(), 'tf-quickstart-'));
let wav = process.env.TAJWEED_QUICKSTART_WAV;
if (!wav) {
  const set = JSON.parse(gunzipSync(readFileSync(path.join(UPLOAD, 'selftest/selftest.json.gz'))).toString('utf8'));
  const s16 = gunzipSync(readFileSync(path.join(UPLOAD, 'selftest', `${set.clips[0].file}.gz`)));   // 16 kHz
  const data = Buffer.alloc(s16.length * 3);
  for (let i = 0; i + 1 < s16.length; i += 2) for (let k = 0; k < 3; k++) s16.copy(data, (i * 3) + 2 * k, i, i + 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(48000, 24); head.writeUInt32LE(96000, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  wav = path.join(work, 'microphone.wav');
  writeFileSync(wav, Buffer.concat([head, data]));
}

// the page: the example, with the configure call pointed at the local API
const base = `http://127.0.0.1:${PORT}`;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const kid = createHash('sha256').update(rawPublic).digest('hex').slice(0, 16);
const example = readFileSync(path.join(root, 'examples/quickstart.html'), 'utf8');
const importLine = "import { TajweedClient } from '@quran-lab/tajweedformer';";
if (!example.includes(importLine)) { console.error('examples/quickstart.html no longer has the import line this script replaces'); process.exit(1); }
const page = example.replace(importLine, "import { TajweedClient } from '/quickstart-client.mjs';");
// the model: its version from the manifest, its build id the first 40 hex of the manifest's SHA-256
const manifestBytes = readFileSync(path.join(UPLOAD, 'manifest.json'));
const modelVersion = JSON.parse(manifestBytes.toString('utf8')).version;
const modelBuild = createHash('sha256').update(manifestBytes).digest('hex').slice(0, 40);
// the key the local folder is signed with: the throwaway key the folders' own index names, passed through the
// test seam only
const modelKey = JSON.parse(readFileSync(path.join(process.env.TAJWEED_MODEL_30, 'local30.json'), 'utf8')).public_key_hex;
const shim = "import { createClient } from '/web/api/client.js';\n"
  + `const seams = { apiUrl: '${base}', modelsUrl: '${base}/models', modelKeys: ['${modelKey}'], `
  + `trustedKeys: [Uint8Array.from(atob('${rawPublic.toString('base64')}'), (c) => c.charCodeAt(0))] };\n`
  + "export const TajweedClient = { create: (o) => createClient({ ...o, key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa' }, seams) };\n";

// BUILT=1: the page is a Vite build of examples/vite
const BUILT = process.env.BUILT === '1';
let builtDir = null;
if (BUILT) {
  const ex = path.join(root, 'examples', 'vite');
  const pkgDir = path.join(ex, 'node_modules', '@quran-lab', 'tajweedformer');
  const viteEntry = path.join(ex, 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!existsSync(viteEntry) || !existsSync(path.join(pkgDir, 'web', 'index.js'))) { console.error('BUILT=1 needs the example installed: npm run example:build'); process.exit(2); }
  const slash = (f) => f.split(path.sep).join('/');
  const rel = slash(path.relative(work, pkgDir));
  const seamsFile = path.join(work, 'client-with-seams.js');
  writeFileSync(seamsFile, `import { createClient } from '${rel}/web/api/client.js';\nexport * from '${rel}/web/index.js';\n`
    + `const seams = { apiUrl: '${base}', modelsUrl: '${base}/models', modelKeys: ['${modelKey}'], `
    + `trustedKeys: [Uint8Array.from(atob('${rawPublic.toString('base64')}'), (c) => c.charCodeAt(0))] };\n`
    + "export const TajweedClient = { create: (o) => createClient({ ...o, key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa' }, seams) };\n");
  builtDir = path.join(work, 'built');
  const { build } = await import(pathToFileURL(viteEntry).href);
  await build({ root: ex, configFile: false, logLevel: 'warn', build: { outDir: builtDir, emptyOutDir: true },
    resolve: { alias: [{ find: /^@quran-lab\/tajweedformer$/, replacement: slash(seamsFile) }] } });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
function file(res, f, req) {
  if (!existsSync(f) || !statSync(f).isFile()) { res.writeHead(404).end(); return; }
  const size = statSync(f).size;
  const h = { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { ...h, 'content-length': size }); createReadStream(f).pipe(res); return; }
  const lo = Number(m[1]), hi = Math.min(m[2] === '' ? size - 1 : Number(m[2]), size - 1);
  res.writeHead(206, { ...h, 'content-range': `bytes ${lo}-${hi}/${size}`, 'content-length': hi - lo + 1 });
  createReadStream(f, { start: lo, end: hi }).pipe(res);
}
const requests = [];
const server = createServer((req, res) => {
  const u = new URL(req.url, base);
  requests.push(`${req.method} ${u.pathname}`);
  req.resume();
  const json = (status, o, h = {}) => res.writeHead(status, { 'content-type': 'application/json', ...h }).end(JSON.stringify(o));
  if (u.pathname === '/examples/quickstart.html') return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(page);
  if (u.pathname === '/quickstart-client.mjs') return res.writeHead(200, { 'content-type': TYPES['.mjs'] }).end(shim);
  if (BUILT && u.pathname === '/built.html') return file(res, path.join(builtDir, 'index.html'), req);
  if (BUILT && u.pathname.startsWith('/assets/') && !u.pathname.includes('..')) return file(res, path.join(builtDir, u.pathname), req);
  if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.t.s', expires_in: 86400, attested: false });
  if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: `web:${base}`, store_status: 'pending' });
  if (u.pathname === '/v1/config') {
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ v: 1, app: `web:${base}`, channel: 'stable', issued_at: now, expires_at: now + 86400, models: {},
      recommended: { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: modelBuild, version: modelVersion, source: 'stable' },
      denylist: [], flags: { analytics: false, issues: false, contributions: false } }));
    return res.writeHead(200, { 'content-type': 'application/json', 'x-qlab-signature': `ed25519=${sign(null, body, privateKey).toString('base64url')}`,
      'x-qlab-key-id': kid, etag: '"1"' }).end(body);
  }
  if (u.pathname.startsWith('/v1/')) return json(202, { ok: true });
  if (u.pathname === '/favicon.ico') return res.writeHead(204).end();
  const rel = decodeURIComponent(u.pathname);
  if (rel.includes('..')) return res.writeHead(400).end();
  if (rel.startsWith('/models/')) return file(res, path.join(UPLOAD, rel.split('/sdk/v4.0/')[1] || ''), req);
  return file(res, path.join(root, rel), req);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// STORAGE=blocked: a profile of its own whose cookie setting is "block"
const BLOCKED = process.env.STORAGE === 'blocked';
const profile = path.join(work, 'profile');
if (BLOCKED) {
  mkdirSync(path.join(profile, 'Default'), { recursive: true });
  writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { cookies: 2 } } }));
}
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  ...(BLOCKED ? { userDataDir: profile } : {}),
  executablePath: process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'),
  headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`],
});
let failed = null, heard = '';
try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  tab.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await tab.goto(`${base}${BUILT ? '/built.html' : '/examples/quickstart.html'}`, { waitUntil: 'load' });
  if (!(await tab.evaluate(() => isSecureContext))) failed = 'the page is not a secure context';
  // the page makes its Client and downloads the model before it wires the buttons: wait for that (the tap of a
  // person comes later still)
  const ready = Date.now();
  while (!failed && !(await tab.evaluate(() => typeof document.querySelector('#listen').onclick === 'function'))) {
    if (errors.length) failed = errors.join('; ');
    else if (Date.now() - ready > 120000) failed = `the page was not ready after 120 s (requests: ${[...new Set(requests)].slice(-12).join(', ')})`;
    else await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`ready (Client, model downloaded, verified and warm) in ${((Date.now() - ready) / 1000).toFixed(1)} s`);
  const t0 = Date.now();
  if (!failed) await tab.click('#listen');
  let last = '', quiet = 0;
  while (!failed && Date.now() - t0 < SECONDS * 1000 && quiet < 8) {
    await new Promise((r) => setTimeout(r, 500));
    heard = await tab.evaluate(() => document.querySelector('#heard').textContent);
    quiet = heard && heard === last ? quiet + 1 : 0;
    last = heard;
    if (errors.length) failed = errors.join('; ');
  }
  const count = (s) => s.split(' ').filter((x) => x && x !== '|').length;
  const tokens = count(heard);
  console.log(`microphone: heard ${tokens} tokens in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!failed && tokens < 10) failed = `the model heard ${tokens} tokens, at least 10 expected`;
  if (!failed && !requests.includes('GET /v1/config')) failed = 'the page never fetched its config';
  if (!failed && !BUILT && !requests.includes('GET /web/api/worker.js')) failed = 'the engine did not run in a Worker (web/api/worker.js was never fetched)';
  if (!failed && BUILT) {
    // the Worker bundle and the engine's wasm came from the build; the main-thread copy of the engine (a chunk
    // the SDK imports only when a Worker cannot start) was never asked for
    const got = (re) => requests.some((r) => re.test(r));
    if (!got(/^GET \/assets\/worker-[^/]*\.js$/)) failed = 'the built Worker was never fetched';
    else if (!got(/^GET \/assets\/tajweedformer-[^/.]*\.wasm$/)) failed = 'the built wasm of the engine was never fetched';
    else if (got(/^GET \/assets\/tajweedformer-[^/.]*\.js$/)) failed = 'the engine ran on the page\'s thread: the built Worker did not start';
  }
  // the sample clip button: the same path with no microphone
  const sampleClip = async (label) => {
    await tab.evaluate(() => { document.querySelector('#heard').textContent = ''; });
    const t1 = Date.now();
    await tab.click('#clip');
    let clip = '';
    last = ''; quiet = 0;
    while (!failed && Date.now() - t1 < SECONDS * 1000 && quiet < 8) {
      await new Promise((r) => setTimeout(r, 500));
      clip = await tab.evaluate(() => document.querySelector('#heard').textContent);
      quiet = clip && clip === last ? quiet + 1 : 0;
      last = clip;
      if (errors.length) failed = errors.join('; ');
    }
    console.log(`${label}: heard ${count(clip)} tokens in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    if (!failed && count(clip) < 10) failed = `from the ${label} the model heard ${count(clip)} tokens, at least 10 expected`;
  };
  if (!failed) await sampleClip('sample clip');
  // STORAGE=blocked: the storage really is blocked, the model ran all the same, and the next visit downloads it again
  if (!failed && BLOCKED) {
    const state = await tab.evaluate(async () => {
      const out = {};
      try { localStorage.getItem('x'); out.localStorage = 'works'; } catch (e) { out.localStorage = e.name; }
      try { await caches.has('x'); out.cacheStorage = 'works'; } catch (e) { out.cacheStorage = e.name; }
      out.indexedDB = await new Promise((res) => {
        let q;
        try { q = indexedDB.open('x', 1); } catch (e) { res(e.name); return; }
        q.onerror = (ev) => { ev.preventDefault(); res(q.error.name); };
        q.onsuccess = () => { q.result.close(); res('works'); };
      });
      return out;
    });
    console.log(`storage in this profile: localStorage ${state.localStorage}, CacheStorage ${state.cacheStorage}, indexedDB.open ${state.indexedDB}`);
    if (state.cacheStorage !== 'SecurityError' || state.indexedDB === 'works') failed = `the profile does not block storage (${JSON.stringify(state)}): nothing was tested`;
    const modelFiles = (from) => new Set(requests.slice(from).filter((r) => r.startsWith('GET /models/') && !r.endsWith('/manifest.json')));
    const first = modelFiles(0);
    if (!failed && first.size < 4) failed = `the first load asked for ${first.size} model files`;
    const mark = requests.length;
    if (!failed) {
      await tab.reload({ waitUntil: 'load' });
      const again = Date.now();
      while (!failed && !(await tab.evaluate(() => typeof document.querySelector('#listen').onclick === 'function'))) {
        if (errors.length) failed = errors.join('; ');
        else if (Date.now() - again > 120000) failed = 'the second load was not ready after 120 s';
        else await new Promise((r) => setTimeout(r, 250));
      }
      console.log(`second load: ready in ${((Date.now() - again) / 1000).toFixed(1)} s`);
      if (!failed) await sampleClip('sample clip on the second load');
      // every model file of the first load (the model's and the sample clip's) was asked for again
      const second = modelFiles(mark);
      console.log(`second load: ${second.size} model files were asked for again (the first load asked for ${first.size})`);
      if (!failed && [...first].some((f) => !second.has(f))) failed = `the second load did not download every model file again (${second.size} of ${first.size})`;
    }
  }
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); // the browser lets go of its profile a moment after it closed
}
if (failed) { console.error('FAILED:', failed); process.exit(1); }
console.log(`OK${BUILT ? ' (the Vite build of examples/vite)' : ''}: key, model, microphone, AudioWorklet, the engine in a Worker, model output; and the sample clip${BLOCKED ? '; with the browser\'s storage blocked, and the model downloaded again at the second load' : ''}`);
