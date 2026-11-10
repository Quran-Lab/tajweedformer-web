// The README's quick start (examples/quickstart.html) in a real browser, from a real capture device to the
// model's output: headless Chrome plays a recitation clip as its microphone (its fake capture device), the page
// asks for the microphone, runs the AudioWorklet and prints what the model heard.
//
//   TAJWEED_V4_UPLOAD=<sdk/v4.0 as served: manifest.json signed by Quran Lab, gzip files> node scripts/browser-quickstart.mjs
//   CHROME=<path to chrome>   PORT=8799   SECONDS=20
//
// What is real: the page's script (only its configure call is pointed at this script's local API, with the SDK's
// test options), the package's modules and engine (web/ and dist/ of this checkout), the model folder and its
// verification with Quran Lab's key, getUserMedia, the AudioWorklet. What is a stand-in: the API (it answers a
// config that recommends the folder, signed with a throwaway key made here) and the microphone's sound (a clip
// of the folder's self-test set, or TAJWEED_QUICKSTART_WAV, a 48 kHz mono wav).
// Needs dist/tajweedformer.mjs (npm run build) and puppeteer-core (a dev dependency). Exits 1 on failure.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const UPLOAD = process.env.TAJWEED_V4_UPLOAD || '';
const PORT = Number(process.env.PORT || 8799);
const SECONDS = Number(process.env.SECONDS || 20);
if (!existsSync(path.join(UPLOAD, 'manifest.json'))) { console.error('set TAJWEED_V4_UPLOAD to a served V4 folder'); process.exit(2); }
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
const call = "QuranLab.configure({ key: 'qlk_v1_...' })";
if (!example.includes(call)) { console.error('examples/quickstart.html no longer has the configure call this script replaces'); process.exit(1); }
const page = example.replace(call, `QuranLab.configure({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', apiUrl: '${base}', modelsUrl: '${base}/models', `
  + `trustedKeys: [Uint8Array.from(atob('${rawPublic.toString('base64')}'), (c) => c.charCodeAt(0))] })`);

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
  if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.t.s', expires_in: 86400, attested: false });
  if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: `web:${base}`, store_status: 'pending' });
  if (u.pathname === '/v1/config') {
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ v: 1, app: `web:${base}`, channel: 'stable', issued_at: now, expires_at: now + 86400, models: {},
      recommended: { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: 'quickstart', source: 'stable' },
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

const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
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
  await tab.goto(`${base}/examples/quickstart.html`, { waitUntil: 'load' });
  if (!(await tab.evaluate(() => isSecureContext))) failed = 'the page is not a secure context';
  const t0 = Date.now();
  await tab.click('#listen');
  let last = '', quiet = 0;
  while (!failed && Date.now() - t0 < SECONDS * 1000 && quiet < 8) {
    await new Promise((r) => setTimeout(r, 500));
    heard = await tab.evaluate(() => document.querySelector('#heard').textContent);
    quiet = heard && heard === last ? quiet + 1 : 0;
    last = heard;
    if (errors.length) failed = errors.join('; ');
  }
  const tokens = heard.split(' ').filter(Boolean).length;
  console.log(`heard ${tokens} tokens in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!failed && tokens < 10) failed = `the model heard ${tokens} tokens, at least 10 expected`;
  if (!failed && !requests.includes('GET /v1/config')) failed = 'the page never fetched its config';
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
if (failed) { console.error('FAILED:', failed); process.exit(1); }
console.log('OK: key, model, microphone, AudioWorklet, model output');
