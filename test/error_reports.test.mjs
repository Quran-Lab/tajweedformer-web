// Error reports (3.1.7; quranlab-contract sdk_4.0.0 ERRORS_40.md, section 24): the contract's vectors (the queue, the
// codes the app gets, what the page can tell, the telemetry reasons; test/vectors40/errors_40.json, a byte copy of
// the contract's file at 98e98f4), then the Client end to end: each stage the web SDK reports, from the failure
// itself, on the stub platform.
import test from 'node:test';
import '../web/index.node.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ErrorReports, classify, parseBrowser, storageBucket, telemetryReason, tag, tagEngine, SIMD, THREADS, LIMITS, STAGES, NOT_REPORTED } from '../web/platform/error-reports.js';
import { toTajweedError, TajweedError } from '../web/api/errors.js';
import { PlatformError } from '../web/platform/client.js';
import { DeliveryError, memoryStore } from '../web/tajweed/delivery.js';
import { ModelFolderError } from '../web/tajweed/manifest.js';
import { memoryState } from '../web/platform/storage.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { build3, stubPlatform, seamsFor, KEY } from './helpers/model3.mjs';

const V = JSON.parse(readFileSync(new URL('./vectors40/errors_40.json', import.meta.url), 'utf8'));
const at = (day) => Date.parse(day + 'T12:00:00Z');

test('the vectors: stages, the codes never reported, the limits', () => {
  assert.deepEqual([...STAGES], V.stages);
  assert.deepEqual([...NOT_REPORTED], V.codes_not_reported);
  assert.deepEqual({ daily_signatures: LIMITS.dailySignatures, queue_max: LIMITS.queueMax, reported_max: LIMITS.reportedMax,
    first_again_days: LIMITS.firstAgainDays, keep_days: LIMITS.keepDays, count_max: LIMITS.countMax }, V.limits);
});

test('the vectors: every queue sequence (one report per day and signature, the caps, first_report, the answers)', async () => {
  for (const c of V.queue) {
    let now = 0, on = true;
    const r = new ErrorReports({ state: memoryState(), clock: () => now, enabled: () => on, top: () => ({}) });
    for (const s of c.steps) {
      now = at(s.day || '2026-11-18');
      if (s.op === 'occur') {
        const made = r.occur({ stage: s.stage, reason: s.reason, code: s.code, http_status: s.http_status, first_launch: s.first_launch });
        assert.equal(made, s.expect.made, `${c.name}: occur`);
      } else if (s.op === 'send') {
        const answers = [...s.answers], sent = [];
        await r.flush(async (body) => {
          const a = answers.shift();
          sent.push({ day: body.day, stage: body.error.stage, reason: body.error.reason, code: body.code, http_status: body.error.http_status ?? null,
            count: body.error.count, first_report: body.error.first_report, first_launch: body.error.first_launch, answer: a ?? null });
          if (a !== 202) throw Object.assign(new Error('refused'), a ? { status: a } : {});
        });
        assert.deepEqual(sent, s.expect.requests, `${c.name}: send`);
      } else { on = false; r.clear(); }
    }
  }
});

// What the web SDK raises for each case of the vectors it can meet, as the internal failure it really sees
const PE = (status, code, reason) => Object.assign(new PlatformError(status, code, ''), reason ? { reason } : {}, { stage: 'config' });
const DE = (code, extra) => new DeliveryError(code, 'x', extra);
const named = (name, message = 'x') => Object.assign(new Error(message), { name });
const WEB = {
  'config network none': () => tag(new PlatformError(0, 'offline', ''), { stage: 'config', reason: 'network' }),
  'config http none': () => PE(503, 'http_503'),
  'config signature none': () => PE(0, 'signature_invalid'),
  'config expired none': () => PE(0, 'config_expired'),
  'config unavailable none': () => tag(new PlatformError(0, 'model_unavailable', ''), { stage: 'config', reason: 'unavailable' }),
  'config refused complete': () => PE(403, 'app_blocked', 'app_blocked'),
  'config refused none': (c) => (c.error_code === 'key_revoked' ? PE(401, 'invalid_key', 'key_revoked') : PE(403, 'sdk_too_old')),
  'manifest network none': () => DE('offline', { path: 'manifest.json', nothingCached: true }),
  'manifest http none': () => DE('http', { status: 502, path: 'manifest.json' }),
  'manifest signature none': () => new ModelFolderError('signature_invalid', 'x'),
  'manifest rate_limited none': () => DE('http', { status: 429, error: 'model_limit', path: 'manifest.json' }),
  'download network partial': () => DE('offline', { path: 'c16_l64/model.bin' }),
  'download http partial': () => DE('http', { status: 503, path: 'c16_l64/model.bin' }),
  'download invalid_answer none': () => DE('http', { status: 200, path: 'c16_l64/model.bin', wrong: true }),
  'download hash partial': () => DE('checksum_mismatch', { path: 'c16_l64/model.bin' }),
  'download quota partial': () => tag(named('QuotaExceededError'), { stage: 'download', reason: 'quota' }),
  'download storage partial': () => tag(named('UnknownError'), { stage: 'download', reason: 'storage' }),
  'download refused none': () => DE('http', { status: 403, error: 'model_attestation_required', path: 'c16_l64/model.bin' }),
  'verify hash complete': () => new ModelFolderError('checksum_mismatch', 'x'),
  'storage quota none': () => named('QuotaExceededError'),
  'storage write none': () => tag(named('UnknownError'), { stage: 'storage', reason: 'write' }),
  'runtime simd complete': () => tag(named('CompileError'), { stage: 'runtime', reason: 'simd' }),
  'runtime webcrypto none': () => new PlatformError(0, 'runtime_unsupported', 'no WebCrypto'),
  'runtime memory complete': () => tagEngine(new RangeError('WebAssembly.Memory(): could not allocate memory'), 'runtime'),
  'runtime wasm_fetch complete': () => tagEngine(new TypeError('Failed to fetch dynamically imported module'), 'runtime'),
  'runtime wasm_compile complete': () => tagEngine(named('CompileError', 'WebAssembly.instantiate(): expected magic word'), 'runtime'),
  'model_open memory complete': () => tagEngine(Object.assign(new Error('Out of memory'), { workerName: 'RangeError' }), 'model_open'),
  'audio permission_denied complete': () => named('NotAllowedError'),
  'audio context complete': () => tag(named('InvalidStateError'), { stage: 'audio', reason: 'context' }),
  'audio interrupted complete': () => tag(new TajweedError('interrupted', { detail: 'x' }), { stage: 'audio', reason: 'interrupted' }),
  'session deadline complete': () => tag(new TajweedError('engine_failed', { detail: 'x' }), { stage: 'session', reason: 'deadline' }),
};
const FALLBACK = { audio: 'microphone_unavailable', download: 'download_failed', manifest: 'download_failed' };

test('the vectors: the code the app gets and the stage and reason reported, for every case the web SDK can meet', () => {
  let n = 0;
  for (const c of V.codes) {
    const make = WEB[`${c.stage} ${c.reason} ${c.on_device}`];
    if (!make || c.code === 'none') continue;
    const e = make(c);
    const t = toTajweedError(e, { fallback: FALLBACK[c.stage] || 'engine_failed', sdk: '3.1.7' });
    assert.equal(t.code, c.code, `${c.stage}/${c.reason}: code`);
    const r = classify(t);
    assert.deepEqual([r.stage, r.reason], [c.stage, c.reason], `${c.stage}/${c.reason}: classified`);
    // a page sees no status for its engine's own files (a module import that failed says nothing more)
    if (c.http_status && c.reason !== 'invalid_answer' && c.stage !== 'runtime') assert.equal(r.http_status, c.http_status, `${c.stage}/${c.reason}: status`);
    n++;
  }
  assert.ok(n >= 30, `${n} cases`);
  // the cases web cannot meet: download/network with nothing on the device (the manifest is asked first, so that
  // is the manifest's), a timeout and a redirect (the page sees neither as such: both are no answer)
});

test('a 401 invalid_token with no stop reason is the token answer: reason http, never refused; with a stop reason it is refused', () => {
  const bare = classify(Object.assign(new PlatformError(401, 'invalid_token', ''), { stage: 'config' }));
  assert.deepEqual([bare.stage, bare.reason, bare.http_status], ['config', 'http', 401]);
  const stop = classify(Object.assign(new PlatformError(401, 'invalid_token', ''), { stage: 'config', reason: 'key_revoked' }));
  assert.equal(stop.reason, 'refused');
  assert.equal(classify(new DeliveryError('http', 'x', { status: 401, error: 'invalid_token', path: 'a.bin' })).reason, 'http');
  assert.equal(toTajweedError(Object.assign(new PlatformError(401, 'invalid_token', ''), { stage: 'config' }), { fallback: 'download_failed' }).code, 'download_failed');
});

test('the vectors: the browser, the OS and mobile; the storage buckets; the two modules; the telemetry reasons', () => {
  for (const c of V.web.user_agents) assert.deepEqual(parseBrowser(c.user_agent, c.user_agent_data, c.max_touch_points), c.expect, c.user_agent);
  for (const c of V.web.storage_free) assert.equal(storageBucket(c.bytes), c.storage_free);
  assert.deepEqual([...SIMD], V.web.simd_module);
  assert.deepEqual([...THREADS], V.web.threads_module);
  for (const c of V.telemetry) assert.equal(telemetryReason(c.reason), c.failure_reason, c.reason);
});

test('the body: the contract fields only, no message, no URL, no user agent', async () => {
  const r = new ErrorReports({ state: memoryState(), clock: () => at('2026-11-18'), top: () => ({ platform: 'web', sdk_version: '3.1.7', app_version: '1', os_version: '13', device_class: 'browser' }) });
  r.occur({ stage: 'runtime', reason: 'memory', code: 'engine_failed', error_name: 'RangeError', first_launch: true, revision: '4.0.0', build: 'ab'.repeat(20),
    web: { browser: 'chrome', browser_major: 131, os: 'android', mobile: true, simd: true } });
  let body = null;
  await r.flush(async (b) => { body = b; });
  const full = V.bodies.find((x) => x.name === 'web, every field').body;
  for (const k of Object.keys(body)) assert.ok(k in full, `top: ${k}`);
  for (const k of Object.keys(body.error)) assert.ok(k in full.error, `error: ${k}`);
  assert.deepEqual(body.error, { stage: 'runtime', reason: 'memory', error_name: 'RangeError', count: 1, first_launch: true, first_report: true,
    build: 'ab'.repeat(20), web: { browser: 'chrome', browser_major: 131, os: 'android', mobile: true, simd: true } });
  assert.equal(body.revision, '4.0.0');
});

// ---- the Client, end to end on the stub platform ----

const build = await build3();
async function setup(o = {}, extra = {}, before = null) {
  resetClientForTests();
  const api = await stubPlatform({ build, ...o });
  if (before) before(api);
  const seams = seamsFor(api, extra);
  const client = await createClient({ key: KEY, appVersion: '1.0' }, seams);
  return { api, seams, client, ql: client._ql };
}
const queued = (ql) => ql.errors.queue.map((r) => [r.stage, r.reason, r.code, r.http_status]);
const sentReports = (api) => api.log.filter((x) => x.path === '/v1/issues').map((x) => x.body);

test('a CDN that answers 503: download_failed (never needs_connection), a manifest/http/503 report, a failed download in telemetry', async () => {
  const { api, client, ql } = await setup({}, {}, (a) => { a.state.cdnAnswer = { status: 503, body: { error: 'unavailable' } }; });
  await assert.rejects(client.model(), (e) => e.code === 'download_failed' && /503/.test(e.message));
  assert.deepEqual(queued(ql), [['manifest', 'http', 'download_failed', 503]]);
  ql.telemetry.seal();
  const d = ql.telemetry.pending().flatMap((p) => p.downloads || []);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].failed, d[0].success, d[0].failure_reasons], [1, 0, { http: 1 }]);
  await ql.flushErrors();
  const [b] = sentReports(api);
  assert.deepEqual([b.kind, b.code, b.error.stage, b.error.reason, b.error.http_status, b.error.count], ['error', 'download_failed', 'manifest', 'http', 503, 1]);
  assert.equal(ql.errors.queue.length, 0);
  await client.close();
});

test('the config answers 503 at the launch: a silent report; the model call then fails with download_failed and its own report', async () => {
  const { client, ql, api } = await setup({}, {}, (a) => { a.state.status['/v1/config'] = { status: 503, error: 'unavailable' }; });
  // made and sent at the launch's own send point
  assert.deepEqual(sentReports(api).map((b) => [b.error.stage, b.error.reason, b.code, b.error.http_status]), [['config', 'http', 'none', 503]]);
  assert.deepEqual(queued(ql), []);
  await assert.rejects(client.model(), (e) => e.code === 'download_failed');
  assert.deepEqual(queued(ql), [['config', 'http', 'download_failed', 503]]);
  await client.close();
});

test('no network at all on a first start: needs_connection, reported as the token request that got no answer (attest/network, rule 3a); the launch itself reports nothing', async () => {
  const { client, ql, api } = await setup({}, {}, (a) => { a.state.offline = true; });
  assert.deepEqual(queued(ql), []);
  await assert.rejects(client.model(), (e) => e.code === 'needs_connection');
  assert.deepEqual(queued(ql), [['attest', 'network', 'needs_connection', 0]]);
  const r = ql.errors.queue[0];
  assert.equal(r.first_launch, true);
  assert.equal(r.fields.web.online === undefined || typeof r.fields.web.online === 'boolean', true);
  // the network comes back: sent at the next send point
  api.state.offline = false;
  await ql.flush();
  assert.equal(sentReports(api).length, 1);
  await client.close();
});

test('a browser that blocks storage: a silent storage/unavailable report, the model still runs', async () => {
  const { client, api } = await setup({}, { store: Object.assign(memoryStore(), { blocked: true }) });
  const [b] = sentReports(api);
  assert.deepEqual([b.code, b.error.stage, b.error.reason, b.error.error_name, b.error.first_launch], ['none', 'storage', 'unavailable', 'SecurityError', true]);
  const m = await client.model();
  assert.ok(m.version);
  await client.close();
});

test('the engine cannot get its memory: engine_failed with "not enough memory" (never invalid_argument), reported as runtime/memory', async () => {
  const engine = async () => { throw new RangeError('WebAssembly.Memory(): could not allocate memory'); };
  const { client, ql } = await setup({}, { host: undefined, worker: false, engine });
  await assert.rejects(client.model(), (e) => e.code === 'engine_failed' && /memory/.test(e.message));
  assert.deepEqual(queued(ql), [['runtime', 'memory', 'engine_failed', 0]]);
  assert.equal(ql.errors.queue[0].fields.error_name, 'RangeError');
  await client.close();
});

test('a cache write that runs out of space: storage_full, reported as download/quota', async () => {
  const store = memoryStore();
  const put = store.put.bind(store);
  store.put = async (k, v, o) => { if (k.startsWith('sha256/') || k.startsWith('part/')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return put(k, v, o); };
  const { client, ql } = await setup({}, { store });
  await assert.rejects(client.model(), (e) => e.code === 'storage_full');
  assert.deepEqual(queued(ql), [['download', 'quota', 'storage_full', 0]]);
  await client.close();
});

test('flags.issues false in the signed config: nothing recorded, nothing sent, the queue dropped', async () => {
  const { client, ql, api } = await setup({ flags: { analytics: true, issues: false, contributions: false } }, {}, (a) => { a.state.cdnAnswer = { status: 503, body: {} }; });
  await assert.rejects(client.model(), (e) => e.code === 'download_failed');
  assert.deepEqual(queued(ql), []);
  await ql.flush();
  assert.equal(sentReports(api).length, 0);
  await client.close();
});

test('30 s after a new report the page sends it by itself; a burst before then is one report with its count', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, ql, api } = await setup({}, {}, (a) => { a.state.cdnAnswer = { status: 503, body: {} }; });
  for (let i = 0; i < 3; i++) await assert.rejects(client.model(), (e) => e.code === 'download_failed');
  assert.equal(sentReports(api).length, 0);
  t.mock.timers.tick(30_000);
  for (let i = 0; i < 20 && !sentReports(api).length; i++) await new Promise((r) => setImmediate(r));
  const sent = sentReports(api);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.count, 3);
  t.mock.timers.reset();
  await client.close();
});
