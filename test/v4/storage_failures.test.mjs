// The frame's stores when the browser's storage fails (R402-3, the hosted patch on 4.0.2; Gate C 11-23: web.ratel and
// prompter on iOS answered engine_failed, session/other, error_name UnknownError, on 27 % of one site's installs).
// A failure of the origin private file system or of IndexedDB used to escape the frame's call as a raw DOMException:
// the app got engine_failed, and the report said session/other with no hint of the call. Here:
//   - every store failure is tagged: stage storage (reason quota, read or write), error_code naming the call, the
//     DOMException's name kept as error_name; the app gets storage_full or storage_failed (ERRORS_40.md 24.4 rule 5);
//   - the OPFS store is probed when it opens (a sync access handle and a writable on a file of its own); a browser
//     that refuses either (WebKit: "Backend does not support this operation"; iOS: UnknownError) gets the memory
//     store, reported once and silently as storage/unavailable, so the learner can still recite;
//   - a file another page of the site holds is asked again in put() and get(), as open() does;
//   - the SDK's own records (the state in IndexedDB, the file index, the lease record) never fail a call: a write
//     that failed is reported silently and written again at the next flush; a lease once granted is never lost to its
//     save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { fakeOpfs, install, dom } from './helpers/fake-opfs.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, OpfsFiles, StateStore, openFiles } from '../../sdk4/frame/stores.js';
import { QLC, CoreError } from '../../sdk4/frame/core.js';
import { errorOf } from '../../sdk4/frame/serve.js';
import { classify } from '../../web/platform/error-reports.js';
import { toTajweedError } from '../../web/api/errors.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const NAME = 'quranlab-sdk4.test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a fake OPFS in place of the runtime's for the length of f
async function withOpfs(opts, f) {
  const fs = fakeOpfs(opts);
  const restore = install(fs);
  try { return await f(fs); } finally { restore(); }
}
// what the app and the report make of a failure (serve.js: the code; classify: the report's fields)
const seen = (e) => { const c = classify(e); return { code: errorOf(e).code, stage: c.stage, reason: c.reason, error_code: c.error_code, error_name: c.error_name }; };
const rejection = async (p) => { try { await p; } catch (e) { return e; } return null; };

// ---------------------------------------------------------------- the file store

for (const name of ['UnknownError', 'NotSupportedError']) {
  test(`a browser whose sync access handle fails (${name}): the memory store, naming the probe that failed`, async () => {
    await withOpfs({ fault: (op) => (op === 'createSyncAccessHandle' ? dom(name, 'Backend does not support this operation') : null) }, async (fs) => {
      const files = await openFiles(NAME);
      assert.equal(files.kind, 'memory');
      assert.deepEqual(files.unavailable, { error_name: name, error_code: 'opfs_probe_sync' });
      assert.deepEqual([...fs.files(NAME).keys()], [], 'the probe leaves no file behind');
    });
  });
}

test('a browser whose writable fails (UnknownError): the memory store, naming the probe that failed', async () => {
  await withOpfs({ fault: (op) => (op === 'createWritable' ? dom('UnknownError') : null) }, async (fs) => {
    const files = await openFiles(NAME);
    assert.equal(files.kind, 'memory');
    assert.deepEqual(files.unavailable, { error_name: 'UnknownError', error_code: 'opfs_probe_writable' });
    assert.deepEqual([...fs.files(NAME).keys()], []);
  });
});

test('a working OPFS: the OPFS store, probed with a file of its own that is gone after', async () => {
  await withOpfs({}, async (fs) => {
    const files = await openFiles(NAME);
    assert.equal(files.kind, 'opfs');
    assert.equal(files.unavailable, undefined);
    assert.ok(fs.ops.some((o) => o.startsWith('createSyncAccessHandle ')), 'the sync access handle was tried');
    await files.put(QLC.FORM_CDN, 'a.qle', new Uint8Array([1, 2, 3]));
    assert.deepEqual([...fs.files(NAME).keys()].sort(), ['1_a.qle', 'index.json']);
  });
});

test('put(): a file another page of the site holds is asked again until it is free', async () => {
  await withOpfs({}, async (fs) => {
    const files = await OpfsFiles.create(NAME);
    await files.put(QLC.FORM_CDN, 'a.qle', new Uint8Array([1]));
    const release = fs.hold(NAME, '1_a.qle');
    setTimeout(release, 300);
    await files.put(QLC.FORM_CDN, 'a.qle', new Uint8Array([7, 7]));
    assert.deepEqual([...(await files.get(QLC.FORM_CDN, 'a.qle'))], [7, 7]);
  });
});

test('get(): a file another page of the site holds is asked again until it is free', async () => {
  await withOpfs({}, async (fs) => {
    const files = await OpfsFiles.create(NAME);
    await files.put(QLC.FORM_PLAIN, 'c.json', new Uint8Array([5]));
    const release = fs.hold(NAME, '0_c.json');
    setTimeout(release, 300);
    assert.deepEqual([...(await files.get(QLC.FORM_PLAIN, 'c.json'))], [5]);
  });
});

test('put() that fails for good: storage_full for a full store, storage_failed otherwise, error_code opfs_put, the error\'s name kept', async () => {
  await withOpfs({ quota: 4096 }, async () => {
    const files = await OpfsFiles.create(NAME);
    const e = await rejection(files.put(QLC.FORM_CDN, 'big.qle', new Uint8Array(10_000)));
    assert.deepEqual(seen(e), { code: 'storage_full', stage: 'storage', reason: 'quota', error_code: 'opfs_put', error_name: 'QuotaExceededError' });
    assert.equal(toTajweedError(e).code, 'storage_full');
  });
  await withOpfs({ fault: (op, n) => (op === 'writable.write' && n === '1_b.qle' ? dom('UnknownError') : null) }, async () => {
    const files = await OpfsFiles.create(NAME);
    const e = await rejection(files.put(QLC.FORM_CDN, 'b.qle', new Uint8Array(10)));
    assert.deepEqual(seen(e), { code: 'storage_failed', stage: 'storage', reason: 'write', error_code: 'opfs_put', error_name: 'UnknownError' });
    assert.equal(await files.has(QLC.FORM_CDN, 'b.qle'), false, 'a put that failed counts nothing');
  });
});

test('close(): an index.json that cannot be written fails nothing; it is said once and written at the next close', async () => {
  let refuse = true;
  await withOpfs({ fault: (op, n) => (refuse && op === 'createWritable' && n === 'index.json' ? dom('UnknownError') : null) }, async (fs) => {
    const files = await OpfsFiles.create(NAME);
    const told = [];
    files.onFailure = (e) => told.push(seen(e));
    await files.put(QLC.FORM_CDN, 'a.qle', new Uint8Array([1, 2]));
    assert.deepEqual(told, [{ code: 'storage_failed', stage: 'storage', reason: 'write', error_code: 'opfs_index', error_name: 'UnknownError' }]);
    assert.equal(await files.has(QLC.FORM_CDN, 'a.qle'), true, 'this page load counts the file');
    refuse = false;
    await files.close();
    const again = await OpfsFiles.create(NAME);
    assert.equal(await again.has(QLC.FORM_CDN, 'a.qle'), true, 'the next page load counts it too');
    assert.ok(fs.files(NAME).has('index.json'));
  });
});

test('a write of the Core past the quota: storage_full, error_code opfs_write (not the Core\'s bare -3)', async () => {
  await withOpfs({ quota: 1024 }, async () => {
    const files = await OpfsFiles.create(NAME);
    await files.open([[QLC.FORM_DEVICE, 'w.bin']]);
    let thrown = null;
    try { files.write(QLC.FORM_DEVICE, 'w.bin', 0, new Uint8Array(4096)); } catch (e) { thrown = e; }
    await files.close();
    assert.ok(thrown, 'the write throws (the Core\'s guard keeps it as the cause of its status)');
    const ce = Object.assign(new CoreError(QLC.E_STORAGE, 0, 'qlc_install'), { cause: thrown });
    const c = new Controller({ key: 'qlk_v1_x', site: 'https://app.example', files: new MemoryFiles(), kv: new MemoryKV(), engine: {} });
    const e = c._coreError(ce, 'install of w.bin');
    assert.equal(e.code, 'storage_full');
    assert.deepEqual(seen(e), { code: 'storage_full', stage: 'storage', reason: 'quota', error_code: 'opfs_write', error_name: 'QuotaExceededError' });
  });
});

// ---------------------------------------------------------------- the state (IndexedDB in a browser)

class FlakyKV extends MemoryKV {
  constructor(fail = () => false) { super(); this.fail = fail; this.n = 0; }
  async write(entries) { this.n++; if (this.fail(this.n)) throw dom('UnknownError', 'An internal error was encountered in the Indexed Database server'); return super.write(entries); }
}

test('the state: a write that fails fails no later flush, is said once, and its keys are written at the next flush', async () => {
  const kv = new FlakyKV((n) => n === 1);
  const st = await StateStore.open(kv);
  const told = [];
  st.onFailure = (e) => told.push(seen(e));
  st.set('a', 1);
  await st.flush();
  st.set('b', 2);
  await st.flush();
  assert.deepEqual(Object.fromEntries(kv.m), { a: 1, b: 2 }, 'the key of the failed write is written with the next');
  assert.equal(told.length, 1);
  assert.deepEqual(told[0], { code: 'storage_failed', stage: 'storage', reason: 'write', error_code: 'kv_write', error_name: 'UnknownError' });
});

// ---------------------------------------------------------------- whole page sessions through the real Core

function noise(seconds, seed = 1) {
  const out = new Float32Array(16000 * seconds);
  let x = seed;
  for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = ((x / 2 ** 32) - 0.5) * 0.05; }
  return out;
}

async function session(srv, { files, kv = new MemoryKV(), leaseStore, extra = {} } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
    files, kv, engine, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(leaseStore ? { leaseStore } : {}), ...extra });
  await c.init();
  return c;
}

async function take(c) {
  await c.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs', 'conf'] });
  const pcm = noise(2);
  let chunks = 0;
  for (let i = 0; i < pcm.length; i += 1600) chunks += (await c.push(pcm.slice(i, i + 1600))).chunks.length;
  return chunks + (await c.finish()).chunks.length;
}

// the model call as the page sees it: its value, or the code it fails with (and the report serve.js makes of it)
async function call(c, f) {
  try { return { value: await f() }; } catch (e) { const out = errorOf(e); c.reportFailure(e, out.code); return { code: out.code, report: seen(e) }; }
}
// the error reports of the stores: those sent (a start sends what it has, so a report made at init is sent with the
// launch) and those queued
const reports = (c, srv) => [
  ...srv.state.issues.filter((b) => b && b.error && b.error.stage === 'storage').map((b) => ({ stage: b.error.stage, reason: b.error.reason, code: b.code, error_name: b.error.error_name, error_code: b.error.error_code })),
  ...c.ql.errors.queue.filter((r) => r.stage === 'storage').map((r) => ({ stage: r.stage, reason: r.reason, code: r.code, error_name: r.fields.error_name, error_code: r.fields.error_code })),
];

test('iOS: every sync access handle fails UnknownError; the model opens from memory, a take gives chunks, and the fallback is said once, silently', { skip }, async () => {
  await withOpfs({ fault: (op) => (op === 'createSyncAccessHandle' ? dom('UnknownError') : null) }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: await openFiles(NAME) });
    const r = await call(c, () => c.openModel());
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(c.diagnose().storage, 'memory');
    assert.ok(await take(c) > 0);
    assert.deepEqual(reports(c, srv), [{ stage: 'storage', reason: 'unavailable', code: 'none', error_name: 'UnknownError', error_code: 'opfs_probe_sync' }]);
    await c.close();
  });
});

test('an index.json that cannot be written: the model opens all the same, and the failure is said silently', { skip }, async () => {
  await withOpfs({ fault: (op, n) => (op === 'createWritable' && n === 'index.json' ? dom('UnknownError') : null) }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: await openFiles(NAME) });
    const r = await call(c, () => c.openModel());
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(c.diagnose().storage, 'opfs');
    assert.ok(await take(c) > 0);
    assert.deepEqual(reports(c, srv), [{ stage: 'storage', reason: 'write', code: 'none', error_name: 'UnknownError', error_code: 'opfs_index' }]);
    await c.close();
  });
});

// R402-4 (a): before, storage_full (storage/quota, opfs_put, QuotaExceededError); a full OPFS is now an install that
// goes on in memory for the page load, said once silently
test('a store too small for the model: the install goes on in memory, said once silently (storage/unavailable, opfs_put, QuotaExceededError)', { skip }, async () => {
  await withOpfs({ quota: 600_000 }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: await openFiles(NAME) });
    const r = await call(c, () => c.openModel());
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(c.diagnose().storage, 'memory');
    assert.deepEqual(reports(c, srv), [{ stage: 'storage', reason: 'unavailable', code: 'none', error_name: 'QuotaExceededError', error_code: 'opfs_put' }]);
    await c.close();
  });
});

// (4.0.2 failed this take with engine_failed, session/other, error_name UnknownError: the field's signature)
test('an IndexedDB write that fails at a take\'s start: the take goes on, and so do the calls after it', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  let armed = false;
  const kv = new FlakyKV(() => { if (!armed) return false; armed = false; return true; });
  const c = await session(srv, { files: new MemoryFiles(), kv });
  await c.openModel();
  armed = true;
  const r = await call(c, () => take(c));
  assert.equal(r.code, undefined, JSON.stringify(r));
  assert.ok(r.value > 0);
  assert.equal(armed, false, 'the write failed once');
  assert.ok(await take(c) > 0, 'the next take');
  assert.ok(reports(c, srv).some((x) => x.stage === 'storage' && x.reason === 'write' && x.code === 'none' && x.error_code === 'kv_write'), JSON.stringify(reports(c, srv)));
  await c.close();
});

// a lease record store whose save fails once the record holds a lease: by rejecting, or by never answering
const leaseRecord = (mode) => ({
  async load() { return null; },
  save(o) { return !o.lease ? Promise.resolve() : mode === 'reject' ? Promise.reject(dom('UnknownError')) : new Promise(() => {}); },
});

for (const mode of ['reject', 'hang']) {
  test(`the lease record's save ${mode === 'reject' ? 'fails' : 'never ends'} after the lease was granted: the model call does not fail for it`, { skip }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: new MemoryFiles(), leaseStore: leaseRecord(mode), extra: { leaseSaveWaitMs: 200 } });
    const r = await Promise.race([call(c, () => c.openModel()), sleep(15_000).then(() => ({ code: 'hung' }))]);
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(srv.state.leases, 1);
    assert.ok(await take(c) > 0);
    await Promise.race([c.close(), sleep(5000)]);
  });
}
