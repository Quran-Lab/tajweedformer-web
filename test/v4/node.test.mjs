// The Node path (sdk4/node): a desktop app, no frame. The Client starts a worker_threads Worker that runs the frame's
// Controller with the folder's stores, the install keys sealed under a key of this machine and user, the lease kept
// across runs and the signed engine fetched, verified and kept. Against the fake API and CDN served on a local port
// (test keys only) and the c1 test engine signed with the contract's test key; nothing reaches Quran Lab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeServer, parseCert } from './helpers/fake-api.mjs';
import { ROOT, testBuild } from './helpers/env.mjs';
import { TajweedClient, desktopPlatform, defaultStorage } from '../../sdk4/node/index.js';
import { loadNodeEngine } from '../../sdk4/node/engine.js';
import { NodeLeaseStore } from '../../sdk4/node/store.js';

process.env.QL_NODE_TEST = '1';
const dir = testBuild();
const LATEST = path.join(ROOT, 'dist', 'engine', 'LATEST');
const ENGINE_ID = fs.existsSync(LATEST) ? fs.readFileSync(LATEST, 'utf8').trim() : null;
const ENGINES = path.join(ROOT, 'dist', 'engine');
const skip = !ENGINE_ID ? 'no packaged engine (python scripts/build_web4.py engine --test-key)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
// folders the runs write (the model's ciphertext: about 60 MB each); QL_TMP puts them on another disk
const TMP = process.env.QL_TMP || os.tmpdir();
const made = [];
const folder = () => { const d = fs.mkdtempSync(path.join(TMP, 'qlnode-')); made.push(d); return d; };

let srv = null, API = null, server = null;
before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = /^\/4\/engine\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      if (srv.state.offline) { req.socket.destroy(); return; }
      const p = path.join(ENGINES, m[1], m[2]);
      if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(fs.readFileSync(p)); return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let r;
    try { r = await srv.fetch(`${API}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined }); } catch (_) { req.socket.destroy(); return; }
    const h = {};
    r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h);
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  API = `http://127.0.0.1:${server.address().port}`;
  srv = await fakeServer({ cdnDir: dir, cdnBase: `${API}/models`, engineId: ENGINE_ID, turnstile: 'required' });
});
after(() => { if (server) server.close(); });

const APP = 'org.example.live';
const seams = (machineId = 'machine-A') => ({ apiUrl: API, modelsUrl: `${API}/models`, pins: [srv.trustedKey], engineBase: `${API}/4/engine/`, builtIn: ENGINE_ID, machineId });
// every Client a test made is closed at the end, whatever failed (an open engine thread keeps the process alive)
const clients = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* a file still held */ } }
});
const create = async (storage, machineId) => { const c = await TajweedClient.create({ key: srv.apiKey, appId: APP, storage, _test: seams(machineId) }); clients.push(c); return c; };
const leaseCalls = () => srv.state.calls.filter((c) => c === 'POST /v1/model-key' || c === 'GET /v1/attest/challenge').length;
const noise = (n) => { const a = new Float32Array(n); let x = 3; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = ((x / 2 ** 32) - 0.5) * 0.05; } return a; };

test('create: a desktop key and its app id are needed; the default folder is the OS cache folder', async () => {
  await assert.rejects(TajweedClient.create({ key: 'qlk_v1_abc' }), (e) => e.code === 'invalid_argument' && /appId/.test(e.message));
  await assert.rejects(TajweedClient.create({ key: 'nope', appId: APP }), (e) => e.code === 'invalid_argument');
  // no analytics option in 4.0 (ANALYTICS_40 22.2): refused, naming it and the migration guide
  await assert.rejects(TajweedClient.create({ key: 'qlk_v1_abc', appId: APP, analytics: 'off' }), (e) => e.code === 'invalid_argument' && /analytics option was removed/.test(e.message) && /migrating-to-4\.md/.test(e.message));
  // no audience option in 4.0 (ONE_SHEET_40 26.1): refused the same way
  await assert.rejects(TajweedClient.create({ key: 'qlk_v1_abc', appId: APP, audience: 'general' }), (e) => e.code === 'invalid_argument' && /audience option was removed/.test(e.message) && /migrating-to-4\.md/.test(e.message));
  assert.equal(desktopPlatform('win32'), 'windows');
  assert.equal(desktopPlatform('darwin'), 'macos');
  assert.equal(desktopPlatform('linux'), 'linux');
  assert.equal(defaultStorage('a.b', { platform: 'linux', env: {}, home: '/home/u' }), path.join('/home/u', '.cache', 'quranlab', 'tajweedformer', 'a.b'));
  assert.equal(defaultStorage('a.b', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, home: 'C:\\U' }), path.join('C:\\L', 'quranlab', 'tajweedformer', 'a.b'));
});

test('a run: attest as a desktop app, lease (no site, no Turnstile), install into the folder, open, a take in the engine thread', { skip }, async () => {
  const storage = folder();
  const c = await create(storage);
  const model = await c.model();
  assert.equal(model.build, srv.build);
  assert.equal(model.tokens.count, 38);
  const s = model.session({ heads: ['log_probs', 'conf'] });
  const pcm = noise(16000 * 2);
  for (let i = 0; i < pcm.length; i += 1600) s.push(pcm.subarray(i, i + 1600));
  let n = 0;
  const reader = (async () => { for await (const _ of s.chunks) n++; })();
  const heads = await s.finish();
  await reader;
  assert.ok(n >= 6, `chunks ${n}`);
  assert.ok(heads.get('log_probs').frames > 0);
  const d = await c.diagnose();
  assert.equal(d.sdk.runtime, 'node');
  await c.close();
  // what the server saw: a desktop attest and lease, no site header, no Turnstile token, a lease with no web flag
  const att = srv.state.requests.find((r) => r.path === 'POST /v1/attest' && r.body && r.body.install_key);
  assert.equal(att.body.platform, desktopPlatform());
  assert.equal(att.body.bundle_id, APP);
  assert.ok(srv.state.requests.every((r) => !r.headers['x-qlab-site']), 'no x-qlab-site');
  const lease = srv.state.requests.find((r) => r.path === 'POST /v1/model-key');
  assert.equal(lease.body.platform, desktopPlatform());
  assert.equal(lease.body.turnstile, undefined);
  assert.equal(parseCert(lease.body.install_cert).app, APP);
  // the folder: the device forms, the sealed keys (mode 0600 where the system has modes), never a private key in clear
  const keysBin = fs.readFileSync(path.join(storage, 'keys.bin'));
  const PKCS8_P256 = Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107', 'hex');
  assert.equal(keysBin.indexOf(PKCS8_P256), -1);
  assert.equal(keysBin.indexOf(Buffer.from(PKCS8_P256.toString('base64').slice(0, 24))), -1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(storage, 'keys.bin')).mode & 0o777, 0o600);
  const files = fs.readdirSync(path.join(storage, 'files'));
  assert.ok(files.some((f) => f.startsWith('2_')), 'device forms');
  for (const f of files.filter((x) => x.startsWith('2_'))) assert.deepEqual([...fs.readFileSync(path.join(storage, 'files', f)).subarray(0, 4)], [0x89, 0x51, 0x4c, 0x45]);
  assert.ok(fs.existsSync(path.join(storage, 'engine', ENGINE_ID, 'index.json')), 'the verified engine kept');
});

test('the next run: the kept lease (no lease request), and with no network at all the kept engine and lease open the model', { skip }, async () => {
  const storage = folder();
  const a = await create(storage);
  await a.model();
  await a.close();
  const leases = srv.state.leases, calls = leaseCalls();
  const b = await create(storage);
  const mb = await b.model();
  assert.equal(srv.state.leases, leases, 'no new lease');
  assert.equal(leaseCalls(), calls, 'no challenge or lease request');
  assert.equal((await b.diagnose()).lease.kept, 'restored');
  await b.close();
  srv.state.offline = true;
  try {
    const c = await create(storage);
    const mc = await c.model();
    assert.equal(mc.build, mb.build);
    // listen({ from }) as examples/node.mjs uses it
    const s = await mc.listen({ from: noise(16000 * 2), sampleRate: 16000, pace: 'fast' });
    let n = 0;
    for await (const _ of s.chunks) n++;
    await s.finish();
    assert.ok(n >= 6, `chunks ${n}`);
    await c.close();
  } finally { srv.state.offline = false; }
});

test('keys sealed for another machine or user do not open: a new install (new keys, a new lease), never a crash', { skip }, async () => {
  const storage = folder();
  const a = await create(storage, 'machine-A');
  await a.model();
  await a.close();
  const keysA = srv.state.requests.filter((r) => r.path === 'POST /v1/model-key').map((r) => r.body.install_key).at(-1);
  const leases = srv.state.leases;
  const b = await create(storage, 'machine-B');
  await b.model();
  assert.equal(srv.state.leases, leases + 1);
  const keysB = srv.state.requests.filter((r) => r.path === 'POST /v1/model-key').map((r) => r.body.install_key).at(-1);
  assert.notEqual(keysB, keysA);
  await b.close();
  // the store itself: another machine id is 'machine'
  const s = new NodeLeaseStore(storage, { key: srv.apiKey, appId: APP, read: () => ({ id: 'machine-C', byCommand: false }) });
  assert.equal((await s.load()).why, 'machine');
});

test('the engine: a kept file that is not the signed bytes is fetched again; offline with no good copy nothing runs', { skip }, async () => {
  const storage = folder();
  const a = await create(storage);
  await a.close();
  const wasmFile = path.join(storage, 'engine', ENGINE_ID, 'qlcore.wasm');
  const b = fs.readFileSync(wasmFile); b[200] ^= 1; fs.writeFileSync(wasmFile, b);
  srv.state.offline = true;
  try {
    await assert.rejects(create(storage), (e) => ['signature_invalid', 'download_failed', 'runtime_unsupported'].includes(e.code));
  } finally { srv.state.offline = false; }
  const c = await create(storage);
  await c.close();
  assert.ok(!fs.readFileSync(wasmFile).equals(b), 'the good bytes were fetched again and kept');
  // an index signed with a key that is not pinned is refused
  await assert.rejects(loadNodeEngine({ dir: folder(), config: null, pinned: ['00'.repeat(32)], base: `${API}/4/engine/`, builtIn: ENGINE_ID }),
    (e) => e.code === 'signature_invalid' && e.failures[0].cause === 'signature');
});

test('one Client per folder in a process; another folder is another Client', { skip }, async () => {
  const storage = folder();
  const a = await create(storage);
  await assert.rejects(create(storage), (e) => e.code === 'client_exists');
  await a.close();
  const b = await create(storage);
  await b.close();
});

// ported from the 3.x test/api_listen.test.mjs (the 3.x Client in Node): the Node path has no microphone of the SDK's
test('in Node there is no microphone: listen() without `from` is microphone_unavailable, listen({ from }) works', { skip }, async () => {
  const c = await create(folder());
  const model = await c.model();
  await assert.rejects(model.listen(), (e) => e && e.name === 'TajweedError' && e.code === 'microphone_unavailable');
  const s = await model.listen({ from: noise(16000 * 2), pace: 'fast' });
  let n = 0;
  for await (const _ of s.chunks) n++;
  const heads = await s.finish();
  assert.ok(n >= 6, `chunks ${n}`);
  assert.ok(heads.get('log_probs').frames > 0);
  await c.close();
});
