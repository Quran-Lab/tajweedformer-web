// Hosted frame patch R402-4 (11-24 morning read of R402-3's field reports), beside the calibration fix:
//   (a) an OPFS write that fails during an install for a reason other than another page holding the file (UnknownError
//       at opfs_put on iOS Safari 26/27, QuotaExceededError at opfs_write) moves the page load to the memory store and
//       the install goes on there, as a browser whose OPFS probe fails already does; said once, silently
//       (storage/unavailable, error_code the call that failed, error_name its error), never storage_failed;
//   (b) a storage failure of the Core with no store failure behind it (the field's bare "-3") names the Core call and
//       its detail, and the Core callback that answered a failure without an error;
//   (c) every report the frame makes carries the hosted frame's app id (error.frame), so a page still on a cached
//       older frame is told from the newer one; a server that does not take the field yet gets the report without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { fakeOpfs, install, dom } from './helpers/fake-opfs.mjs';
import { Controller, frameAppOf, memoryFallbackOf, frameReports, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, openFiles, storeFailure } from '../../sdk4/frame/stores.js';
import { QLC, CoreError } from '../../sdk4/frame/core.js';
import { errorOf } from '../../sdk4/frame/serve.js';
import { classify, ErrorReports } from '../../web/platform/error-reports.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const NAME = 'quranlab-sdk4.r4024';
const APP = '0123456789ab';

async function withOpfs(opts, f) {
  const fs = fakeOpfs(opts);
  const restore = install(fs);
  try { return await f(fs); } finally { restore(); }
}
async function session(srv, { files, kv = new MemoryKV(), frameApp = null } = {}) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch,
    files, kv, engine, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(frameApp ? { frameApp } : {}) });
  await c.init();
  return c;
}
async function call(c, f) {
  try { return { value: await f() }; } catch (e) { const out = errorOf(e); c.reportFailure(e, out.code); const r = classify(e); return { code: out.code, report: { stage: r.stage, reason: r.reason, error_code: r.error_code, error_name: r.error_name } }; }
}
const storageReports = (c, srv) => [
  ...srv.state.issues.filter((b) => b && b.error && b.error.stage === 'storage').map((b) => ({ reason: b.error.reason, code: b.code, error_name: b.error.error_name, error_code: b.error.error_code })),
  ...c.ql.errors.queue.filter((r) => r.stage === 'storage').map((r) => ({ reason: r.reason, code: r.code, error_name: r.fields.error_name, error_code: r.fields.error_code })),
];
function noise(seconds) { const out = new Float32Array(16000 * seconds); let x = 7; for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = ((x / 2 ** 32) - 0.5) * 0.05; } return out; }
async function take(c) {
  await c.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] });
  const pcm = noise(2);
  let chunks = 0;
  for (let i = 0; i < pcm.length; i += 1600) chunks += (await c.push(pcm.slice(i, i + 1600))).chunks.length;
  return chunks + (await c.finish()).chunks.length;
}

// ---------------------------------------------------------------- (a) the install's write failures

test('(a) which failures move the page load to memory: an OPFS write during an install that is not another page holding the file', () => {
  const put = (name) => storeFailure(dom(name), 'opfs_put');
  assert.deepEqual(memoryFallbackOf(put('UnknownError')), { error_code: 'opfs_put', error_name: 'UnknownError' });
  const core = new SdkError('storage_full', 'install of layers.zfw', { stage: 'storage', why: 'quota', error_code: 'opfs_write', cause: storeFailure(dom('QuotaExceededError'), 'opfs_write') });
  assert.deepEqual(memoryFallbackOf(core), { error_code: 'opfs_write', error_name: 'QuotaExceededError' });
  assert.deepEqual(memoryFallbackOf(storeFailure(dom('UnknownError'), 'opfs_commit')), { error_code: 'opfs_commit', error_name: 'UnknownError' });
  assert.deepEqual(memoryFallbackOf(storeFailure(dom('UnknownError'), 'opfs_open', 'write')), { error_code: 'opfs_open', error_name: 'UnknownError' });
  // another page of the site holds the file: the store asked again already; it stays the call's failure
  assert.equal(memoryFallbackOf(put('NoModificationAllowedError')), null);
  assert.equal(memoryFallbackOf(put('InvalidStateError')), null);
  // a read, the index, the state: not an install's write
  assert.equal(memoryFallbackOf(storeFailure(dom('UnknownError'), 'opfs_open', 'read')), null);
  assert.equal(memoryFallbackOf(storeFailure(dom('UnknownError'), 'opfs_get', 'read')), null);
  assert.equal(memoryFallbackOf(storeFailure(dom('UnknownError'), 'idb_write')), null);
  assert.equal(memoryFallbackOf(new SdkError('download_failed', 'x', { stage: 'download', why: 'network' })), null);
  assert.equal(memoryFallbackOf(new TypeError('x')), null);
});

test('(a) iOS Safari 26/27: every model file\'s OPFS write fails UnknownError (opfs_put); the model opens from memory, a take gives chunks, said once silently', { skip }, async () => {
  await withOpfs({ fault: (op, n) => (op === 'writable.write' && /^[12]_/.test(n) ? dom('UnknownError', 'An unknown error occurred within File System Access API') : null) }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: await openFiles(NAME) });
    assert.equal(c.diagnose().storage, 'opfs', 'the probe passed: OPFS first');
    const r = await call(c, () => c.openModel());
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(c.diagnose().storage, 'memory');
    assert.ok(await take(c) > 0);
    assert.deepEqual(storageReports(c, srv), [{ reason: 'unavailable', code: 'none', error_name: 'UnknownError', error_code: 'opfs_put' }]);
    await c.close();
  });
});

test('(a) a Core write of a device form past the quota (QuotaExceededError at opfs_write): the install goes on in memory, said once silently', { skip }, async () => {
  await withOpfs({ fault: (op, n) => (op === 'sync.write' && /^2_/.test(n) ? dom('QuotaExceededError', 'The quota has been exceeded.') : null) }, async () => {
    const srv = await fakeServer({ cdnDir: dir });
    const c = await session(srv, { files: await openFiles(NAME) });
    const r = await call(c, () => c.openModel());
    assert.equal(r.code, undefined, JSON.stringify(r));
    assert.equal(c.diagnose().storage, 'memory');
    assert.ok(await take(c) > 0);
    assert.deepEqual(storageReports(c, srv), [{ reason: 'unavailable', code: 'none', error_name: 'QuotaExceededError', error_code: 'opfs_write' }]);
    await c.close();
  });
});

// ---------------------------------------------------------------- (b) the Core's own storage failure, named

test('(b) a Core storage failure with no store failure behind it names the Core call and its detail, and the callback that answered a failure', () => {
  const c = new Controller({ key: 'qlk_v1_x', site: 'https://app.example', files: new MemoryFiles(), kv: new MemoryKV(), engine: {} });
  const bare = c._coreError(new CoreError(QLC.E_STORAGE, 7, 'qlc_install'), 'install of layers.zfw');
  assert.equal(bare.code, 'storage_failed');
  assert.equal(classify(bare).error_code, 'qlc_install:7', 'the field had "-3"');
  const read = c._coreError(Object.assign(new CoreError(QLC.E_STORAGE, 0, 'qlc_model_open'), { hostOp: 'read' }), 'open');
  assert.equal(classify(read).error_code, 'qlc_model_open:0:read');
  // a store failure behind it keeps naming the store's call (R402-3)
  const tagged = c._coreError(Object.assign(new CoreError(QLC.E_STORAGE, 0, 'qlc_install'), { cause: storeFailure(dom('UnknownError'), 'opfs_write') }), 'x');
  assert.equal(classify(tagged).error_code, 'opfs_write');
  // never past the report's 32 characters
  const long = c._coreError(Object.assign(new CoreError(QLC.E_STORAGE, -2147483648, 'qlc_accel_prepare'), { hostOp: 'commit' }), 'x');
  assert.ok(classify(long).error_code.length <= 32 && classify(long).error_code.startsWith('qlc_accel_prepare:'), classify(long).error_code);
});

test('(b) through the real Core: a device form the store cannot read is a storage failure naming qlc_model_open and the read callback', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles(), kv = new MemoryKV();
  const a = await session(srv, { files, kv });
  await a.openModel();
  await a.close();
  const read = files.read.bind(files);
  files.read = (form, path, off, dst) => (form === QLC.FORM_DEVICE && /layers/.test(path) ? false : read(form, path, off, dst));
  const b = await session(srv, { files, kv });
  const r = await call(b, () => b.openModel());
  assert.ok(r.code, 'the open fails');
  if (r.report.stage === 'storage') assert.match(r.report.error_code, /^qlc_[a-z_]+:-?\d+:read$/, JSON.stringify(r));
  else assert.notEqual(r.report.error_code, '-3', JSON.stringify(r));
  await b.close();
});

// ---------------------------------------------------------------- (c) the frame's app id on every report

test('(c) the frame\'s app id is read from the path its Worker was served from', () => {
  assert.equal(frameAppOf('/4/app/3166c7b5d2be/worker.js'), '3166c7b5d2be');
  assert.equal(frameAppOf('/4/app/3166C7B5D2BE/worker.js'), null);
  assert.equal(frameAppOf('/4/engine/20261118.4b211eb5e29a/qlcore.mjs'), null);
  assert.equal(frameAppOf(''), null);
  assert.equal(frameAppOf(undefined), null);
});

test('(c) every report the frame makes carries error.frame, the app it was made under (kept with the report until it is sent)', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const c = await session(srv, { files: new MemoryFiles(), frameApp: APP });
  c.reportFailure(new SdkError('download_failed', 'x', { stage: 'download', why: 'http', http_status: 503 }), 'download_failed');
  await c.ql.flushErrors();
  const sent = srv.state.issues.filter((b) => b && b.error);
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((b) => b.error.frame === APP), JSON.stringify(sent.map((b) => b.error)));
  await c.close();
});

test('(c) a report keeps the frame it occurred under (one an older frame queued keeps none); a 400 for a body with error.frame is sent once more without it', async () => {
  const m = new Map();
  const state = { get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => { if (v == null) m.delete(k); else m.set(k, structuredClone(v)); } };
  const r = new ErrorReports({ state, top: () => ({ platform: 'web', sdk_version: '4.0.2' }) });
  // an older frame's report, still queued
  assert.equal(r.occur({ stage: 'session', reason: 'other', code: 'engine_failed', error_name: 'UnknownError' }), true);
  frameReports(r, 'aaaaaaaaaaaa');
  assert.equal(r.occur({ stage: 'storage', reason: 'unavailable', code: 'none', error_code: 'opfs_put' }), true);
  assert.deepEqual(r.queue.map((q) => q.fields.frame), [undefined, 'aaaaaaaaaaaa']);
  // counted again on this frame: still this frame's
  assert.equal(r.occur({ stage: 'storage', reason: 'unavailable', code: 'none', error_code: 'opfs_put' }), false);
  assert.deepEqual(r.queue.map((q) => [q.count, q.fields.frame]), [[1, undefined], [2, 'aaaaaaaaaaaa']]);
  const bodies = [];
  const old = async (b) => { bodies.push(b); if (b.error.frame !== undefined) throw Object.assign(new Error('400'), { status: 400 }); };
  assert.equal(await r.flush(old), 2, 'both taken (the second without the field)');
  assert.deepEqual(bodies.map((b) => b.error.frame), [undefined, 'aaaaaaaaaaaa', undefined]);
  assert.equal(r.queue.length, 0);
});
