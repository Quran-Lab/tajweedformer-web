// The README's quick start (examples/quickstart.html): the README shows exactly the example's script, the script
// is a valid module, and, where a real V4 folder and the built engine are there, the script runs in Node from the
// "microphone" to the model's output.
//
// The run uses stand-ins for the four browser objects the script touches (the button and the output element,
// AudioContext, AudioWorkletNode, getUserMedia): the stand-in microphone hands a recitation clip to the worklet
// port in 128-sample blocks, as a browser's audio thread does. Everything of the SDK is real: the platform
// client (against a local API that signs its config with a throwaway key), the model download and verification,
// the engine, the decoded layer. A real browser run with a real microphone device is scripts/browser-quickstart.mjs.
//
//   TAJWEED_V4_UPLOAD=<sdk/v4.0 as served: manifest.json signed by Quran Lab, gzip files>   (else the run skips)
//   TAJWEED_QUICKSTART_CLIP=<raw float32 mono 48 kHz samples>   (default: the folder's first self-test clip, resampled)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(path.join(root, 'examples/quickstart.html'), 'utf8').replace(/\r\n/g, '\n');
const script = html.split('// README:begin\n')[1].split('// README:end')[0];

test('quick start: the README shows the example\'s script, character for character', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = readme.split('\n## Quick start\n');
  assert.equal(section.length, 2, 'README.md has one "## Quick start" section');
  const shown = section[1].split('```js\n')[1].split('```')[0];
  assert.equal(shown, script);
});

test('quick start: only names the package exports, and no placeholder helpers', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const m of script.matchAll(/from '(@quran-lab\/tajweedformer[^']*)'/g)) {
    const sub = m[1] === pkg.name ? '.' : `./${m[1].slice(pkg.name.length + 1)}`;
    assert.ok(pkg.exports[sub], `${m[1]} is an export of the package`);
  }
  assert.ok(html.includes('"@quran-lab/tajweedformer/platform": "../web/platform/index.js"'), 'the import map covers the imports');
  assert.match(script, /key: 'qlk_v1_\.\.\.'/, 'the key placeholder is the documented one');
});

const UPLOAD = process.env.TAJWEED_V4_UPLOAD || '';
const haveModel = UPLOAD && existsSync(path.join(UPLOAD, 'manifest.json'));
const haveEngine = existsSync(path.join(root, 'dist', 'tajweedformer.mjs'));

test('quick start: runs from the microphone to the model output (Node, stand-in browser objects)', {
  skip: !haveEngine ? 'needs dist/tajweedformer.mjs (npm run build)' : !haveModel ? 'set TAJWEED_V4_UPLOAD to a served V4 folder' : false,
  timeout: 600000,
}, async () => {
  // a local API: the config recommends the folder, signed with a throwaway key the run trusts
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  const kid = createHash('sha256').update(rawPublic).digest('hex').slice(0, 16);
  const requests = [];
  const fetchStub = async (url, init = {}) => {
    const u = new URL(url);
    requests.push(`${init.method || 'GET'} ${u.pathname}`);
    const json = (status, o) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'models.test') {
      const rel = decodeURIComponent(u.pathname.split('/sdk/v4.0/')[1] || '');
      const f = path.join(UPLOAD, rel);
      if (!rel || rel.includes('..') || !existsSync(f)) return new Response(null, { status: 404 });
      const b = readFileSync(f);
      const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const r = /^bytes=(\d+)-(\d+)$/.exec(h.range || '');
      if (!r) return new Response(b, { status: 200 });
      const lo = Number(r[1]), hi = Math.min(Number(r[2]), b.length - 1);
      return new Response(b.subarray(lo, hi + 1), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/${b.length}` } });
    }
    if (u.pathname === '/v1/attest') return json(200, { token: 'qlt_v1.t.s', expires_in: 86400, attested: false });
    if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: 'web:https://app.example', store_status: 'pending' });
    if (u.pathname === '/v1/config') {
      const now = Math.floor(Date.now() / 1000);
      const body = Buffer.from(JSON.stringify({ v: 1, app: 'web:https://app.example', channel: 'stable', issued_at: now, expires_at: now + 86400, models: {},
        recommended: { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: 'quickstart', source: 'stable' },
        denylist: [], flags: { analytics: false, issues: false, contributions: false } }));
      return new Response(body, { status: 200, headers: { 'x-qlab-signature': `ed25519=${sign(null, body, privateKey).toString('base64url')}`, 'x-qlab-key-id': kid, etag: '"1"' } });
    }
    return json(202, { ok: true });
  };

  // the clip the stand-in microphone plays: float32 mono at 48 kHz
  let clip;
  if (process.env.TAJWEED_QUICKSTART_CLIP) {
    const b = readFileSync(process.env.TAJWEED_QUICKSTART_CLIP);
    clip = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  } else {
    // the folder's first self-test clip (16 kHz int16), each sample three times: crude, and enough for the model
    const set = JSON.parse(gunzipSync(readFileSync(path.join(UPLOAD, 'selftest/selftest.json.gz'))).toString('utf8'));
    const s16 = gunzipSync(readFileSync(path.join(UPLOAD, 'selftest', `${set.clips[0].file}.gz`)));
    const pcm = new Int16Array(s16.buffer.slice(s16.byteOffset, s16.byteOffset + s16.byteLength));
    clip = new Float32Array(pcm.length * 3);
    for (let i = 0; i < pcm.length; i++) clip[3 * i] = clip[3 * i + 1] = clip[3 * i + 2] = pcm[i] / 32768;
  }

  // the browser objects the script uses
  const button = {}, heard = { textContent: '' };
  const saved = {};
  const globals = {
    document: { querySelector: (q) => (q === '#listen' ? button : q === '#heard' ? heard : null) },
    AudioContext: class {
      constructor(o) { this.sampleRate = o.sampleRate; this.audioWorklet = { addModule: async () => {} }; }
      createMediaStreamSource() {
        return { connect: (node) => { queueMicrotask(() => { for (let at = 0; at < clip.length; at += 128) node.port.onmessage({ data: clip.subarray(at, at + 128) }); node.done(); }); } };
      }
    },
    AudioWorkletNode: class { constructor() { this.port = {}; this.finished = new Promise((r) => { this.done = r; }); globals.lastNode = this; } },
  };
  for (const k of ['document', 'AudioContext', 'AudioWorkletNode']) { saved[k] = globalThis[k]; globalThis[k] = globals[k]; }
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async (c) => { assert.ok(c.audio); return {}; } } } });

  // the script itself, with only the configure call pointed at the local API (the SDK's test options)
  const cfg = "QuranLab.configure({ key: 'qlk_v1_...' })";
  assert.ok(script.includes(cfg), 'the script has the configure line this test replaces');
  globalThis.__quickstart = { fetch: fetchStub, trustedKeys: [rawPublic] };
  const run = script.replace(cfg, "QuranLab.configure({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', origin: 'https://app.example', bundleId: 'https://app.example', "
    + "apiUrl: 'https://api.test', modelsUrl: 'https://models.test', autoSend: false, ...globalThis.__quickstart })");
  const file = path.join(root, 'test', `.quickstart-run-${process.pid}.mjs`);
  writeFileSync(file, run);
  try {
    await import(pathToFileURL(file).href);          // the package name resolves to this package itself
    assert.equal(typeof button.onclick, 'function', 'the script waits for the tap');
    await button.onclick();
    await globals.lastNode.finished;
    const tokens = heard.textContent.split(' ').filter(Boolean);
    assert.ok(tokens.length >= 10, `the model heard the clip: ${tokens.length} tokens`);
    assert.ok(requests.includes('GET /v1/config'), 'the key was used: the signed config was fetched');
    assert.ok(requests.some((r) => r.endsWith('/manifest.json')), 'the model came from the config\'s recommendation');
  } finally {
    rmSync(file, { force: true });
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k]; }
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
    delete globalThis.__quickstart;
  }
});
