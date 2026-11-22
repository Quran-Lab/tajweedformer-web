// SDK 4.0.2, ERRORS_40.md 24.13: the cause on the app's error. `TajweedError.errorCause` (JavaScript errors have a
// `cause` of their own, the underlying error, which stays): a frozen { stage, reason, httpStatus?, errorName?,
// errorCode?, needs? } from the same reading as the error's report, each value held to 24.2's patterns, or undefined
// for the codes 24.1 never reports. Here: the vector's `causes` through the builder; the frame's error crossing to the
// page (serve(), the port, the loader's errorFrom) with what may and may not cross; and the failures themselves
// through the frame's real Controller and Core where the web meets them (the stand-in API and CDN, test keys), the
// microphone (the stand-in browser objects) and a store that is full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicCause, classify, tag, tagEngine } from '../../web/platform/error-reports.js';
import { TajweedError, toTajweedError, setErrorCause } from '../../web/api/errors.js';
import { serve, errorOf } from '../../sdk4/frame/serve.js';
import { caller } from '../../sdk4/shared/protocol.js';
import { errorFrom } from '../../sdk4/loader/errors.js';
import { Controller, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';
import { Microphone } from '../../web/api/microphone.js';
import { fakeMicrophone } from '../helpers/fakemic.mjs';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';

const V = JSON.parse(readFileSync(new URL('../vectors40/errors_40.json', import.meta.url), 'utf8'));
const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
// the vector's names (the report's) to the JavaScript ones
const js = (c) => (c === null ? undefined : Object.fromEntries(Object.entries(c).map(([k, v]) => [{ http_status: 'httpStatus', error_name: 'errorName', error_code: 'errorCode' }[k] || k, v])));

test('errors_40.json causes: every row through the builder (the code the SDK gave, the report\'s fields, needs from on_device)', () => {
  assert.equal(V.causes.length, 15);
  for (const r of V.causes) {
    const c = publicCause({ stage: r.stage, reason: r.reason, http_status: r.http_status, error_name: r.error_name, error_code: r.error_code }, r.code,
      r.on_device === 'complete' ? 'lease' : 'model');
    assert.deepEqual(c, js(r.cause), r.label);
    if (c) assert.ok(Object.isFrozen(c), r.label);
  }
  // the codes 24.1 never reports carry none, whatever the occurrence
  for (const code of V.codes_not_reported) assert.equal(publicCause({ stage: 'session', reason: 'engine' }, code), undefined, code);
});

test('a TajweedError reads its cause from its failure, the same reading as its report; the platform\'s cause stays the underlying error', () => {
  const denied = Object.assign(new Error('Permission denied by system'), { name: 'NotAllowedError' });
  const e = toTajweedError(denied);
  assert.equal(e.code, 'microphone_denied');
  assert.equal(e.cause, denied);
  assert.deepEqual(e.errorCause, { stage: 'audio', reason: 'permission_denied', errorName: 'NotAllowedError' });
  assert.ok(Object.isFrozen(e.errorCause));
  assert.equal(e.errorCause, e.errorCause, 'read once, then kept');
  // what classify() gives the report, field for field
  const c = classify(e);
  assert.deepEqual(e.errorCause, publicCause(c, e.code));
  // an engine file that did not compile (24.3 runtime, wasm_compile)
  const ce = toTajweedError(tagEngine(Object.assign(new Error('WebAssembly.Module(): Compiling function failed'), { name: 'CompileError' }), 'runtime'));
  assert.equal(ce.code, 'engine_failed');
  assert.equal(ce.errorCause.stage, 'runtime');
  assert.ok(['wasm_compile', 'simd'].includes(ce.errorCause.reason));
  assert.equal(ce.errorCause.errorName, 'CompileError');
  // a mark made where the failure is seen (the session's deadline) is the cause's stage and reason
  assert.deepEqual(tag(new TajweedError('engine_failed', { detail: 'slow' }), { stage: 'session', reason: 'deadline' }).errorCause, { stage: 'session', reason: 'deadline' });
  // the app's own misuse: none; in JSON the cause is there for a log
  assert.equal(new TajweedError('invalid_argument', { detail: 'x' }).errorCause, undefined);
  assert.equal(JSON.parse(JSON.stringify(e)).errorCause.reason, 'permission_denied');
});

test('the microphone refused, through Microphone.open: microphone_denied with its cause', async () => {
  const fake = fakeMicrophone({ sampleRate: 48000 });
  fake.deny = 'NotAllowedError';
  const e = await Microphone.open(fake.seams).then(() => null, (x) => x);
  assert.equal(e && e.code, 'microphone_denied');
  assert.deepEqual(e.errorCause, { stage: 'audio', reason: 'permission_denied', errorName: 'NotAllowedError' });
});

// the frame's side of the port (serve) with `ctl`, and the loader's (caller, errorFrom): the error the page gets
async function crossed(ctl, op = 'model', args = {}) {
  const ch = new MessageChannel();
  serve(ch.port1, ctl);
  const rpc = caller(ch.port2);
  try { await rpc.call(op, args); return { err: null }; } catch (e) { return { err: errorFrom(e) }; } finally { ch.port1.close(); ch.port2.close(); }
}

test('from the frame to the page: the cause crosses with the error, is held to the patterns again and frozen on the page', async () => {
  const err = new SdkError('download_failed', 'the CDN answered 429', { stage: 'download', why: 'rate_limited', http_status: 429, error_code: 'model_limit' });
  const { err: page } = await crossed({ openModel: async () => { throw err; }, reportFailure() {} });
  assert.ok(page instanceof TajweedError);
  assert.equal(page.code, 'download_failed');
  assert.deepEqual(page.errorCause, { stage: 'download', reason: 'rate_limited', httpStatus: 429, errorCode: 'model_limit' });
  assert.ok(Object.isFrozen(page.errorCause));
  // what crossed is the answer of 4.0.1 with `cause` beside it, and nothing else
  assert.deepEqual(Object.keys(errorOf(err)).sort(), ['code', 'message', 'reason']);
  // needs: the frame's own reading (needsOf) for needs_connection
  const nc = new SdkError('needs_connection', 'no answer', { stage: 'lease', why: 'network' });
  const lease = await crossed({ openModel: async () => { throw nc; }, needsOf: async () => 'lease', reportFailure() {} });
  assert.deepEqual(lease.err.errorCause, { stage: 'lease', reason: 'network', needs: 'lease' });
  const model = await crossed({ openModel: async () => { throw nc; }, reportFailure() {} });
  assert.deepEqual(model.err.errorCause, { stage: 'lease', reason: 'network', needs: 'model' }, 'model when the frame cannot tell');
  // a code the app's misuse: no cause crosses
  const bad = await crossed({ openModel: async () => { throw new SdkError('invalid_argument', 'x'); }, reportFailure() {} });
  assert.equal(bad.err.errorCause, undefined);
});

test('a cause that crossed with more than tokens: only the six fields, each held to its pattern, reach the app', () => {
  const t = new TajweedError('needs_connection');
  setErrorCause(t, { stage: 'download', reason: 'network', httpStatus: 99, errorName: 'getaddrinfo ENOTFOUND cdn.quranlab.ai', errorCode: 'x'.repeat(33),
    needs: 'lease', message: 'secret', url: 'https://cdn.quranlab.ai/models/x', install: 'abc', stack: 'at y' });
  assert.deepEqual(t.errorCause, { stage: 'download', reason: 'network', needs: 'lease' });
  for (const junk of [{ stage: 'nowhere', reason: 'network' }, { stage: 'download', reason: 'Not A Token' }, 'download', 42]) {
    const u = setErrorCause(new TajweedError('download_failed'), junk);
    assert.equal(u.errorCause, undefined, JSON.stringify(junk));
  }
});

// ---- the failures through the frame's real Controller and Core

function controller(srv, { fetch = srv.fetch, files = new MemoryFiles(), kv = new MemoryKV(), clock = null } = {}) {
  return new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, download: { pausesMs: [0, 0, 0, 0, 0] },
    ...(clock ? { clock: () => Date.now() + clock.off, coreClock: { wall: () => Date.now() + clock.off, boot: () => performance.now() } } : {}) });
}
const cdnFile = (url) => { const u = new URL(url); return u.host === 'cdn.test' && /\/sdk\/[^/]+\/.+/.test(u.pathname) && !u.pathname.endsWith('/manifest.json'); };

test('the frame: a model file answered 503 (download_failed, the status), then the daily limit (429 model_limit)', { skip }, async () => {
  for (const [status, body, want] of [[503, { error: 'unavailable' }, { stage: 'download', reason: 'http', httpStatus: 503 }],
    [429, { error: 'model_limit' }, { stage: 'download', reason: 'rate_limited', httpStatus: 429, errorCode: 'model_limit' }]]) {
    const srv = await fakeServer({ cdnDir: dir });
    const ctl = controller(srv, { fetch: async (url, init) => (cdnFile(url) ? new Response(JSON.stringify(body), { status }) : srv.fetch(url, init)) });
    await ctl.init();
    const { err } = await crossed(ctl);
    assert.equal(err && err.code, 'download_failed', String(status));
    assert.deepEqual(err.errorCause, want, String(status));
    await ctl.close();
  }
});

test('the frame: the lease route refused (403 app_blocked) is server_rejected with its cause', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const ctl = controller(srv, { fetch: async (url, init) => (new URL(url).pathname === '/v1/model-key' ? new Response(JSON.stringify({ error: 'app_blocked' }), { status: 403 }) : srv.fetch(url, init)) });
  await ctl.init();
  const { err } = await crossed(ctl);
  assert.equal(err && err.code, 'server_rejected', err && err.message);
  assert.deepEqual(err.errorCause, { stage: 'lease', reason: 'refused', httpStatus: 403, errorCode: 'app_blocked' });
  await ctl.close();
});

test('the frame: a first install whose lease request gets no answer is needs_connection, needs model', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const ctl = controller(srv, { fetch: async (url, init) => { if (new URL(url).pathname === '/v1/model-key') throw new TypeError('fetch failed'); return srv.fetch(url, init); } });
  await ctl.init();
  const { err } = await crossed(ctl);
  assert.equal(err && err.code, 'needs_connection', err && err.message);
  assert.equal(err.errorCause.stage, 'lease');
  assert.equal(err.errorCause.needs, 'model');
  await ctl.close();
});

test('the frame: the model on the device and no lease to open it, offline: needs_connection, needs lease', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const files = new MemoryFiles(), kv = new MemoryKV();
  const a = controller(srv, { files, kv, clock });
  await a.init();
  await a.openModel();
  await a.close();
  // past the lease's end and its grace, with no network
  clock.off = 49 * 3_600_000;
  srv.state.offline = true;
  const b = controller(srv, { files, kv, clock });
  await b.init();
  const { err } = await crossed(b);
  assert.equal(err && err.code, 'needs_connection', err && err.message);
  // the request with no answer is the lease's, or the token it needs first (a new page holds none: attest)
  assert.ok(['lease', 'attest'].includes(err.errorCause.stage), err.errorCause.stage);
  assert.ok(['network', 'expired'].includes(err.errorCause.reason), err.errorCause.reason);
  assert.equal(err.errorCause.needs, 'lease', 'every file is on the device');
  await b.close();
});

test('the frame: a store that is full while the files are written is storage_full, storage/quota, QuotaExceededError', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const files = new MemoryFiles();
  const put = files.put.bind(files);
  files.put = async (form, path, bytes) => {
    if (form === QLC.FORM_CDN && !path.includes('.part.')) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    return put(form, path, bytes);
  };
  const ctl = controller(srv, { files });
  await ctl.init();
  const { err } = await crossed(ctl);
  assert.equal(err && err.code, 'storage_full', err && err.message);
  assert.deepEqual(err.errorCause, { stage: 'storage', reason: 'quota', errorName: 'QuotaExceededError' });
  await ctl.close();
});
