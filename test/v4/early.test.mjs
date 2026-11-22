// 4.0.1: a fresh open no longer waits for the lease to fetch the model. The first lease's challenge and its invisible
// Turnstile start at the page's start (init), and the signed manifest and the ciphertext come from the build's model
// folder while the lease is asked. The files stay ciphertext (the CDN form) until the Core holds the lease, are used
// only when the lease answer names the same folder. A lease refused or stopped drops what came down; from 4.0.2 (SPEC
// 16.7) one only unreachable (no answer, a 5xx, a 429, 503 lease_unavailable) keeps what verified, and the next call
// asks none of it again (4.0.1 dropped it: 18 model requests for a first install whose slow lease answer was a 503,
// against 9). Through the real Core, against the fake API and CDN (test keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, SdkError, EARLY_MAX_MS } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;

// a file store that notes, for each device form the Core commits, how many API and CDN requests had been made
class NotingFiles extends MemoryFiles {
  constructor(srv) { super(); this.srv = srv; this.deviceCommits = []; }
  commit(form, path) {
    if (form === QLC.FORM_DEVICE) this.deviceCommits.push({ path, at: this.srv.state.calls.length });
    return super.commit(form, path);
  }
}

async function page(srv, { files = new MemoryFiles(), kv = new MemoryKV(), turnstile = srv.turnstile, fetch = srv.fetch, clock, prepare } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile, autoSend: false, ...(prepare ? { turnstilePrepare: prepare } : {}), ...(clock ? { clock } : {}) });
  await c.init();
  return c;
}

const leaseAt = (srv) => srv.state.calls.indexOf('POST /v1/model-key');
const cdnCalls = (srv) => srv.state.calls.filter((x) => x.includes('/models/'));
// whatever of the model is stored: files of any form, kept blocks, and the manifest record
async function leftovers(c, files) {
  const list = await files.list();
  return { files: list.map((f) => `${f.form}:${f.path}`), manifests: [...c.state.m.keys()].filter((k) => k.startsWith('manifest:') || k.startsWith('part:')) };
}

test('Turnstile starts at the page\'s start: its script is loaded then, the lease uses the early challenge and token, one of each', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const asked = [];
  let prepared = 0;
  const turnstile = async (q) => { asked.push({ ...q, beforeModelCall: !modelCalled }); return srv.turnstile(q); };
  let modelCalled = false;
  const c = await page(srv, { turnstile, prepare: () => { prepared++; } });
  assert.equal(prepared, 1, 'the frame was told to load the script at init');
  await new Promise((r) => setTimeout(r, 50));
  modelCalled = true;
  await c.openModel();
  assert.equal(asked.length, 1, 'one Turnstile run for the page');
  assert.equal(asked[0].beforeModelCall, true, 'it ran before the model call');
  assert.equal(srv.state.challenges.size, 1, 'one challenge');
  assert.equal(srv.state.passed.size, 1, 'the lease passed Turnstile with the early token');
  assert.equal(srv.state.leases, 1);
  assert.ok(c.turnstilePassed);
  await c.close();
});

test('a page with a kept lease starts no Turnstile and asks no challenge', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await page(srv, { kv, files });
  await a.openModel();
  await a.close();
  const challenges = srv.state.challenges.size;
  let asked = 0, prepared = 0;
  const b = await page(srv, { kv, files, turnstile: async (q) => { asked++; return srv.turnstile(q); }, prepare: () => { prepared++; } });
  await b.openModel();
  assert.equal(asked, 0);
  assert.equal(prepared, 0);
  assert.equal(srv.state.challenges.size, challenges);
  assert.equal(srv.state.leases, 1, 'the kept lease');
  await b.close();
});

test('an early challenge older than EARLY_MAX_MS is not used: the lease asks a new challenge and a new token', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let t = Date.now();
  let asked = 0;
  const c = await page(srv, { clock: () => t, turnstile: async (q) => { asked++; return srv.turnstile(q); } });
  await new Promise((r) => setTimeout(r, 50));
  t += EARLY_MAX_MS + 1000;
  await c.openModel();
  assert.equal(asked, 2, 'a second Turnstile run, for the new challenge');
  assert.equal(srv.state.challenges.size, 2);
  assert.equal(srv.state.passed.size, 1);
  await c.close();
});

test('the files come while the lease is asked, stay ciphertext until the Core holds the lease, and are not asked again', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new NotingFiles(srv);
  // the lease route answers only once the early fetch has stored every file of the build (Turnstile slow, a far API)
  let atHold = null;
  const roles = new Set(['weights', 'frontend', 'graph', 'graph-data', 'frames', 'tokens', 'layout', 'reference', 'calibration']);
  const want = srv.manifest.files.filter((f) => (f.context === '*' || f.context === 'c16_l64') && roles.has(f.role)).length;
  srv.state.hold = (async () => {
    // (blocks of a file being fetched, <path>.part.<n>, are not files yet)
    const whole = async () => (await files.list()).filter((f) => !f.path.includes('.part.'));
    for (let i = 0; i < 400 && (await whole()).length < want; i++) await new Promise((r) => setTimeout(r, 25));
    atHold = await whole();
  })();
  const c = await page(srv, { files });
  const info = await c.openModel();
  assert.ok(info.tokens.length > 0);
  assert.equal(atHold.length, want, 'every file of the build was stored before the lease answer came');
  assert.ok(atHold.every((f) => f.form === QLC.FORM_CDN || (f.form === QLC.FORM_PLAIN && !f.path.endsWith('.qle'))), JSON.stringify(atHold));
  assert.ok(atHold.some((f) => f.form === QLC.FORM_CDN && f.path.includes('layers')), 'the weights came before the lease');
  // every device form was written after the lease was asked (the Core installs only with the lease)
  assert.ok(files.deviceCommits.length > 0);
  assert.ok(files.deviceCommits.every((d) => d.at > leaseAt(srv)), JSON.stringify(files.deviceCommits));
  // each file asked once, the manifest once
  const cdn = cdnCalls(srv);
  assert.equal(new Set(cdn).size, cdn.length, cdn.join(' | '));
  // nothing but device forms and the plain calibration stays
  for (const f of await files.list()) assert.ok(f.form === QLC.FORM_DEVICE || f.form === QLC.FORM_PLAIN, `${f.form}:${f.path}`);
  await c.close();
});

for (const [name, setup, check] of [
  ['refused (403, not asked again)', (srv) => { srv.state.plan = ['refuse']; }, (e) => e.code === 'server_rejected'],
  ['a signed stop', (srv) => { srv.state.stop = 'key_revoked'; }, (e) => e.code === 'invalid_key'],
]) {
  test(`a lease that does not come, ${name}: nothing that came down stays`, { skip }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const files = new MemoryFiles();
    let fetch = srv.fetch;
    if (setup) setup(srv);
    // the lease route's answer waits until the early fetch has stored files, so there is something to drop
    let release;
    const gate = new Promise((r) => { release = r; });
    const held = (async () => { for (let i = 0; i < 400 && (await files.list()).length < 3; i++) await new Promise((r) => setTimeout(r, 25)); release(); })();
    if (!setup) fetch = async (url, init = {}) => { if (String(url).endsWith('/v1/model-key')) { await gate; throw new TypeError('fetch failed'); } return srv.fetch(url, init); };
    else srv.state.hold = gate;
    const c = await page(srv, { files, fetch });
    await assert.rejects(c.openModel(), (e) => e instanceof SdkError && check(e));
    await held;
    assert.ok(cdnCalls(srv).length > 1, 'the early fetch had asked for files');
    const left = await leftovers(c, files);
    assert.deepEqual(left.files, [], JSON.stringify(left));
    assert.deepEqual(left.manifests, [], JSON.stringify(left));
    await c.close();
  });
}

// the model requests by file (the CDN's), and how many there were
const modelAsks = (srv) => {
  const by = {};
  for (const r of srv.state.requests.filter((x) => x.path.includes('/models/'))) { const f = r.path.split('/sdk/')[1].split('/').slice(1).join('/'); by[f] = (by[f] || 0) + 1; }
  return by;
};
// the lease route answers once the early fetch has stored `n` files (or after 10 s)
const whole = async (files) => (await files.list()).filter((f) => !/\.part\.\d+$/.test(f.path));
const afterFiles = (files, n) => (async () => { for (let i = 0; i < 400 && (await whole(files)).length < n; i++) await new Promise((r) => setTimeout(r, 25)); })();

test('4.0.2, SPEC 16.7: a slow lease answer that fails with 503 lease_unavailable keeps the early fetch\'s files; the call that gets a lease asks none again: 9 model requests in all, no file twice (4.0.1: 18)', { skip }, async (t) => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles();
  const all = srv.manifest.files.length;
  srv.state.hold = afterFiles(files, all); // every file of the build stored, then the answer
  srv.state.leaseUnavailable = 1;
  let now = Date.now();
  const c = await page(srv, { files, clock: () => now });
  await assert.rejects(c.openModel(), (e) => e.code === 'download_failed' && e.error_code === 'lease_unavailable');
  assert.equal((await whole(files)).length, all, 'the files that verified stay (ciphertext, the CDN form)');
  assert.equal(c.state.get(`early:${srv.build}`), true);
  srv.state.hold = null;
  now += 31_000; // past the answer's Retry-After (the route is held until then, 28.11 item 2)
  const info = await c.openModel();
  assert.equal(info.build, srv.build);
  const by = modelAsks(srv);
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  t.diagnostic(`REQUESTS | slow lease answer 503, then a lease | ${total} model requests`);
  assert.deepEqual(Object.values(by).filter((n) => n !== 1), [], `no file asked twice: ${JSON.stringify(by)}`);
  assert.equal(total, all + 1, 'each file and the manifest once');
  assert.equal(c.state.get(`early:${srv.build}`), null, 'the lease took them');
  for (const f of await files.list()) assert.ok(f.form === QLC.FORM_DEVICE || f.form === QLC.FORM_PLAIN, `installed: ${f.form}:${f.path}`);
  await c.close();
});

test('4.0.2: no answer from the lease route while a file is in flight: the files stored stay and are never asked again; the one in flight goes on from its kept blocks with one request; needs_connection', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.ranges = true;
  const files = new MemoryFiles();
  const BLOCK = 4 * 1024 * 1024;
  const LARGEST = 'c16_l64/layers.zfw.qle';
  const blocksOf = async () => (await files.list()).filter((f) => f.path.startsWith(`${LARGEST}.part.`)).length;
  let first = true;
  // the first answer of the largest file gives 5 blocks and a bit, then nothing more until the request is aborted
  const slow = async (url, init) => {
    const r = await srv.fetch(url, init);
    const rd = r.body.getReader();
    let held = new Uint8Array(0), sent = 0;
    const body = new ReadableStream({
      async pull(ctl) {
        if (sent >= 5 * BLOCK + 1000) {
          await new Promise((res) => { if (init.signal) init.signal.addEventListener('abort', res, { once: true }); });
          ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        if (!held.length) { const x = await rd.read(); if (x.done) { ctl.close(); return; } held = x.value; }
        const n = Math.min(held.length, 1 << 20);
        ctl.enqueue(held.subarray(0, n)); held = held.subarray(n); sent += n;
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: r.status, headers: r.headers });
  };
  let gate = (async () => { for (let i = 0; i < 400 && ((await whole(files)).length < 3 || (await blocksOf()) < 5); i++) await new Promise((r) => setTimeout(r, 25)); })();
  const fetch = async (url, init = {}) => {
    if (String(url).endsWith('/v1/model-key') && gate) { await gate; throw new TypeError('fetch failed'); }
    if (String(url).endsWith(`/${LARGEST}`) && first) { first = false; return slow(url, init); }
    return srv.fetch(url, init);
  };
  const c = await page(srv, { files, fetch });
  await assert.rejects(c.openModel(), (e) => e instanceof SdkError && e.code === 'needs_connection');
  const stored = (await whole(files)).filter((f) => f.form === QLC.FORM_CDN).map((f) => f.path);
  assert.ok(stored.length >= 2 && !stored.includes(LARGEST), `files stored before the answer failed: ${stored}`);
  assert.equal(await blocksOf(), 5, 'the file in flight keeps its whole blocks');
  assert.equal(await c.needsOf({ code: 'needs_connection' }, 'open'), 'model', 'a file not on the device yet: needs the model');
  gate = null;
  const info = await c.openModel();
  assert.equal(info.build, srv.build);
  const by = modelAsks(srv);
  for (const dec of stored) {
    const f = srv.manifest.files.find((x) => x.decoded && x.decoded.path === dec);
    assert.equal(by[f.path], 1, `${f.path}: stored before, never asked again`);
  }
  assert.equal(by[LARGEST], 2, 'the file in flight: asked once more');
  const resumed = srv.state.requests.filter((r) => r.path.endsWith(`/${LARGEST}`) && r.headers.range);
  assert.deepEqual(resumed.map((r) => r.headers.range), [`bytes=${5 * BLOCK}-`], 'from its first byte not kept');
  assert.equal(by['manifest.json'], 1);
  await c.close();
});

test('4.0.2: what an early fetch kept after an unreachable lease is dropped by a later refusal, all of it (files, blocks, manifest)', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles();
  srv.state.hold = afterFiles(files, 3);
  srv.state.leaseUnavailable = 1;
  let now = Date.now();
  const c = await page(srv, { files, clock: () => now });
  await assert.rejects(c.openModel(), (e) => e.error_code === 'lease_unavailable');
  assert.ok((await whole(files)).length >= 3, 'kept');
  srv.state.hold = null;
  srv.state.plan = ['refuse'];
  now += 31_000;
  await assert.rejects(c.openModel(), (e) => e.code === 'server_rejected');
  const left = await leftovers(c, files);
  assert.deepEqual(left.files, [], JSON.stringify(left));
  assert.deepEqual(left.manifests, [], JSON.stringify(left));
  assert.equal(c.state.get(`early:${srv.build}`), null);
  await c.close();
});

test('a lease answer that names another model folder: the early files are dropped and the files come from the lease\'s base', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.leaseBase = `https://cdn.test/models/Quran-Lab/v4-moved/${srv.build}/sdk/${srv.manifest.model_id}/`;
  const files = new MemoryFiles();
  const c = await page(srv, { files });
  const info = await c.openModel();
  assert.ok(info.tokens.length > 0);
  const moved = cdnCalls(srv).filter((x) => x.includes('/v4-moved/') && x.endsWith('.qle'));
  assert.ok(moved.length > 0, 'the files came from the lease answer\'s base');
  // no file of the early fetch is left: device forms and the calibration only
  for (const f of await files.list()) assert.ok(f.form === QLC.FORM_DEVICE || f.form === QLC.FORM_PLAIN, `${f.form}:${f.path}`);
  await c.close();
});

test('prefetch: the progress of the early fetch and of the files after the lease never goes back', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const c = await page(srv);
  const seen = [];
  const r = await c.prefetch({}, (p) => seen.push(p.bytesDone));
  assert.equal(r.complete, true);
  assert.ok(seen.length > 0);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], seen.join(','));
  await c.close();
});

// 28.4 on release-4.0.1: the folder is the base's path, the same files on every models host. A lease answer from a
// backup host's API names its own model host with the same folder: the early files are used, nothing is asked again
test('a lease answer that names the same folder on a backup model host: the early files are kept, none is asked again', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.leaseBase = `https://cdn-b.tajweedformer.com/models/Quran-Lab/v4-test/${srv.build}/sdk/${srv.manifest.model_id}/`;
  const hosts = [];
  const fetch = (url, init) => { hosts.push(new URL(String(url)).host); return srv.fetch(url, init); };
  const files = new MemoryFiles();
  const c = await page(srv, { files, fetch });
  const info = await c.openModel();
  assert.ok(info.tokens.length > 0);
  assert.equal(hosts.includes('cdn-b.tajweedformer.com'), false, 'nothing asked of the lease base\'s host: the early files were the same folder');
  const cdn = cdnCalls(srv);
  assert.equal(new Set(cdn).size, cdn.length, 'each file asked once');
  for (const f of await files.list()) assert.ok(f.form === QLC.FORM_DEVICE || f.form === QLC.FORM_PLAIN, `${f.form}:${f.path}`);
  await c.close();
});


// 4.0.1 (E7): the files two at a time on the chosen models host, the largest first, so the small files come while the
// weights do; each file one request as before
test('the files come two at a time on the chosen models host, the largest first, each asked once', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let inFlight = 0, most = 0;
  const order = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (!u.includes('/models/') || u.endsWith('/manifest.json')) return srv.fetch(url, init);
    order.push(decodeURIComponent(u.split(`/sdk/${srv.manifest.model_id}/`)[1]));
    inFlight++;
    most = Math.max(most, inFlight);
    try { await new Promise((r) => setTimeout(r, 40)); return await srv.fetch(url, init); } finally { inFlight--; }
  };
  const c = await page(srv, { fetch });
  const info = await c.openModel();
  assert.ok(info.tokens.length > 0);
  assert.equal(most, 2, 'two files at a time, never more');
  assert.equal(new Set(order).size, order.length, 'each file asked once');
  const size = Object.fromEntries(srv.manifest.files.map((f) => [f.path, f.size]));
  const largest = [...order].sort((a, b) => size[b] - size[a])[0];
  assert.equal(order[0], largest, `the largest first (${order.join(', ')})`);
  await c.close();
});

test('an early fetch dropped with two files in flight drops the blocks kept for both', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles();
  const c = await page(srv, { files });
  const two = srv.manifest.files.slice(0, 2).map((f) => ({ ...f }));
  for (const f of two) {
    await files.put(QLC.FORM_CDN, `${f.path}.part.0`, new Uint8Array(8));
    c.state.set(`part:${f.path}`, { size: f.size, block: 8, n: 1, validator: null });
  }
  const pre = { base: 'https://cdn.test/models/x/', build: srv.build, entries: [], inflight: new Set(two), bytes: 0, manStored: false,
    cancel: { on: false, hooks: new Set() }, done: Promise.resolve() };
  await c._preDrop(pre);
  for (const f of two) {
    assert.equal(c.state.get(`part:${f.path}`), null, f.path);
    assert.equal(await files.has(QLC.FORM_CDN, `${f.path}.part.0`), false, f.path);
  }
  assert.equal(pre.inflight.size, 0);
  await c.close();
});
