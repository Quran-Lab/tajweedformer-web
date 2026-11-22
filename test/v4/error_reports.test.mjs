// Error reports in 4.0 (quranlab-contract sdk_4.0.0 ERRORS_40.md, section 24): the contract's vectors through the
// shared reporter (web/platform/error-reports.js, which the frame's platform client runs), then the frame's own
// errors: what the controller and the engine loader mark on an SdkError, the code the loader gets, and that serve()
// reports every error it answers with. The 3.x Client's end-to-end cases are test/error_reports_3x.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ErrorReports, classify, parseBrowser, storageBucket, telemetryReason, tag, tagEngine, SIMD, THREADS, LIMITS, STAGES, NOT_REPORTED } from '../../web/platform/error-reports.js';
import { toTajweedError, TajweedError } from '../../web/api/errors.js';
import { PlatformError } from '../../web/platform/client.js';
import { DeliveryError, memoryStore } from '../../web/tajweed/delivery.js';
import { ModelFolderError } from '../../web/tajweed/manifest.js';
import { memoryState } from '../../web/platform/storage.js';

const V = JSON.parse(readFileSync(new URL('../vectors40/errors_40.json', import.meta.url), 'utf8'));
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


// ---- the 4.0 frame ----
import { SdkError } from '../../sdk4/frame/controller.js';
import { errorOf, serve } from '../../sdk4/frame/serve.js';
import { loadEngine } from '../../sdk4/frame/engine-loader.js';

const sdk = (code, extra) => new SdkError(code, 'x', extra);
const FRAME = [
  // [the SdkError as the controller makes it, the code the loader gets, stage, reason, status]
  [sdk('needs_connection', { stage: 'config', why: 'network' }), 'needs_connection', 'config', 'network', undefined],
  [sdk('download_failed', { stage: 'config', why: 'http', http_status: 503 }), 'download_failed', 'config', 'http', 503],
  [sdk('download_failed', { stage: 'config', why: 'signature' }), 'download_failed', 'config', 'signature', undefined],
  [sdk('model_unavailable', { stage: 'config', why: 'unavailable' }), 'model_unavailable', 'config', 'unavailable', undefined],
  [sdk('download_failed', { stage: 'lease', why: 'http', http_status: 502 }), 'download_failed', 'lease', 'http', 502],
  [sdk('needs_connection', { stage: 'lease', why: 'network' }), 'needs_connection', 'lease', 'network', undefined],
  [sdk('server_rejected', { stage: 'lease', why: 'refused', http_status: 403, error_code: 'lease_attestation_required' }), 'server_rejected', 'lease', 'refused', 403],
  [sdk('invalid_key', { reason: 'key_revoked', status: 401 }), 'invalid_key', 'config', 'refused', undefined],
  [sdk('download_failed', { stage: 'manifest', why: 'rate_limited', http_status: 429 }), 'download_failed', 'manifest', 'rate_limited', 429],
  [sdk('checksum_mismatch', { stage: 'download', why: 'hash' }), 'checksum_mismatch', 'download', 'hash', undefined],
  [sdk('storage_failed', { stage: 'storage', why: 'write', error_code: '7' }), 'storage_failed', 'storage', 'write', undefined],
  [sdk('engine_failed', { stage: 'model_open', why: 'memory', error_code: '9' }), 'engine_failed', 'model_open', 'memory', undefined],
  [sdk('runtime_unsupported', { stage: 'runtime', why: 'wasm_compile' }), 'runtime_unsupported', 'runtime', 'wasm_compile', undefined],
];

test('the frame: an SdkError keeps the code it was made with and reports its stage and reason (an SdkError reason is the stop reason, never the report reason)', () => {
  for (const [e, code, stage, reason, status] of FRAME) {
    assert.equal(errorOf(e).code, code);
    const r = classify(e);
    assert.deepEqual([r.stage, r.reason, r.http_status], [stage, reason, status], `${code} ${stage}/${reason}`);
  }
  // a raw failure the frame did not make: classified from its class
  const mem = classify(new RangeError('WebAssembly.Memory(): could not allocate memory'));
  assert.equal(mem.error_name, 'RangeError');
});

test('serve(): every error it answers with is reported once with the code the loader gets; the answer is unchanged but for its cause (4.0.2)', async () => {
  const seen = [];
  const ctl = {
    init: async () => { throw new SdkError('download_failed', 'x', { stage: 'config', why: 'http', http_status: 503 }); },
    reportFailure: (err, code) => { seen.push([err.code, code]); throw new Error('a reporter that throws changes nothing'); },
  };
  const ch = new MessageChannel();
  serve(ch.port1, ctl);
  const answer = await new Promise((resolve) => { ch.port2.onmessage = (m) => resolve(m.data); ch.port2.postMessage({ id: 1, op: 'init', args: { pending: [] } }); });
  ch.port1.close(); ch.port2.close();
  // 4.0.2 (24.13): the cause beside the code, from the same reading as the report (tokens only)
  assert.deepEqual(answer, { id: 1, ok: false, error: { code: 'download_failed', message: 'x', reason: null, cause: { stage: 'config', reason: 'http', httpStatus: 503 } } });
  assert.deepEqual(seen, [['download_failed', 'download_failed']]);
});

test('the engine loader: an engine file that does not load is runtime/wasm_fetch with its status; no engine named is wasm_unsupported', async () => {
  const fetch = async () => new Response('{}', { status: 404 });
  const config = { web: { engine: { id: '20261118.aaaaaaaaaaaa' } } };
  let err = null;
  try { await loadEngine({ base: 'https://web.test/4/engine/', config, pinned: [], fetch }); } catch (e) { err = e; }
  assert.ok(err instanceof SdkError);
  const r = classify(err);
  assert.equal(r.stage, 'runtime');
  assert.ok(['wasm_fetch', 'wasm_unsupported'].includes(r.reason), r.reason);
  assert.ok(err.failures === undefined || Array.isArray(err.failures));
});

// ---- a page session's first start (as release-3.1.7, 1d9e98d and afee186): the report names the request that failed.
// The token gates the config (24.4 rule 3a): a token request with no answer is attest/network, one answered 503 is
// attest/http; a config answered 401 invalid_token with no stop reason is the token's own answer, config/http, never
// refused. The code the page gets is the same as before: needs_connection for no answer, download_failed for an answer.
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine as testEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { errorFrom } from '../../sdk4/loader/errors.js';
import { integrityCode, integrityDetail } from '../../web/platform/error-reports.js';

const engine4 = await testEngine();
const build4 = testBuild();
const skip4 = !engine4 ? 'no packaged engine (python scripts/build_web4.py engine)' : !build4 ? 'no protected test build (QL_TEST_BUILD)' : false;

// a first start (nothing kept) whose API answers `fault(method path)` where it returns an answer (null: the fake's own)
async function firstStart(fault) {
  const srv = await fakeServer({ cdnDir: build4 });
  const fetch = async (url, init = {}) => {
    const f = fault(srv, `${init.method || 'GET'} ${new URL(url).pathname}`);
    if (f === 'none') throw new TypeError('fetch failed');
    return f ? new Response(JSON.stringify(f.body), { status: f.status, headers: { 'content-type': 'application/json' } }) : srv.fetch(url, init);
  };
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch,
    files: new MemoryFiles(), kv: new MemoryKV(), engine: engine4, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false });
  await c.init();
  let err = null;
  try { await c.openModel(); } catch (e) { err = e; }
  assert.ok(err, 'the model call fails');
  const code = errorOf(err).code;
  c.reportFailure(err, code);
  const q = c.ql.errors.queue.map((r) => [r.stage, r.reason, r.code, r.http_status || 0]);
  // what the page's loader makes of the frame's answer (serve's errorOf), and each report's error_code and body
  const message = errorFrom(errorOf(err)).message;
  const ec = c.ql.errors.queue.map((r) => (r.fields && r.fields.error_code) || null);
  const bodies = c.ql.errors.queue.map((r) => c.ql.errors.body(r));
  await c.close();
  return { code, q, ec, message, bodies, first: c.ql.errors.queue.map((r) => r.first_launch) };
}

test('a first start with no network: needs_connection, reported as the token request that got no answer (attest/network); the launch reports nothing', { skip: skip4 }, async () => {
  const r = await firstStart(() => 'none');
  assert.equal(r.code, 'needs_connection');
  assert.deepEqual(r.q, [['attest', 'network', 'needs_connection', 0]]);
  assert.deepEqual(r.first, [true]);
});

test('a first start whose token request is answered 503: the launch\'s silent report, then the call\'s download_failed, both attest/http 503', { skip: skip4 }, async () => {
  const r = await firstStart((_, p) => (p === 'POST /v1/attest' ? { status: 503, body: { error: 'unavailable' } } : null));
  assert.equal(r.code, 'download_failed');
  assert.deepEqual(r.q, [['attest', 'http', 'none', 503], ['attest', 'http', 'download_failed', 503]]);
});

test('a config answered 401 invalid_token with no stop reason, again after a new token: download_failed, config/http 401, never refused', { skip: skip4 }, async () => {
  const r = await firstStart((_, p) => (p === 'GET /v1/config' ? { status: 401, body: { error: 'invalid_token' } } : null));
  assert.equal(r.code, 'download_failed');
  assert.deepEqual(r.q, [['config', 'http', 'download_failed', 401]]);
});

// ---- a 403 lease_integrity_failed names the check that failed (ERRORS_40.md 24.3, contract 69326fb; as Android
// sdk-4.0.0 38ffa96): the report's error_code is why:check, why alone, or lease_integrity_failed; the developer's
// message names the same check; the code stays server_rejected; the signature (stage, reason, code, status) is unchanged.

test('integrity: error_code why:check within 32 characters, why alone, nothing without a why; only tokens are read', () => {
  assert.equal(integrityCode('verdict', 'boot'), 'verdict:boot');
  assert.equal(integrityCode('verdict', 'digest'), 'verdict:digest');
  assert.equal(integrityCode('verdict', 'recorded'), 'verdict:recorded');
  assert.equal(integrityCode('downgrade'), 'downgrade');
  assert.equal(integrityCode('core', null), 'core');
  assert.equal(integrityCode('verdict', 'a'.repeat(25)), 'verdict', 'past 32 characters: why alone');
  assert.equal(integrityCode('verdict', 'b'.repeat(24)), 'verdict:' + 'b'.repeat(24), 'exactly 32: both');
  assert.equal(integrityCode('verdict', 'Boot check!'), 'verdict', 'a check that is not a token is left out');
  assert.equal(integrityCode('not a token', 'boot'), null);
  assert.equal(integrityCode(undefined, 'boot'), null);
  for (const [w, c] of [['verdict', 'boot'], ['verdict', 'digest'], ['downgrade', null], ['core', null], ['verdict', 'app_unrecognized']]) {
    assert.match(integrityCode(w, c), /^[A-Za-z0-9_.:-]{1,32}$/, 'a token of 24.2');
  }
});

test('integrity: the developer\'s detail says the check in words, then the server\'s tokens; free text is never echoed', () => {
  assert.equal(integrityDetail('verdict', 'boot'), "this phone's bootloader is unlocked or its boot is not verified, and Quran Lab gives such a phone no lease (lease_integrity_failed, why verdict, check boot)");
  assert.equal(integrityDetail('core'), 'the Quran Lab Core in this app could not be verified (lease_integrity_failed, why core)');
  assert.equal(integrityDetail('downgrade'), 'this install attested with a stronger check before and did not this time (lease_integrity_failed, why downgrade)');
  assert.match(integrityDetail('verdict', 'digest'), /signing certificate .* \(lease_integrity_failed, why verdict, check digest\)$/);
  assert.equal(integrityDetail(), 'the install could not be verified (lease_integrity_failed)');
  assert.equal(integrityDetail('<script>', 'x y'), 'the install could not be verified (lease_integrity_failed)');
});

test('integrity: the classifier reads a token request refused 403 lease_integrity_failed as attest/integrity_failed with why:check', () => {
  const e = Object.assign(new PlatformError(403, 'lease_integrity_failed', ''), { stage: 'attest', serverWhy: 'verdict', serverCheck: 'boot' });
  const r = classify(e);
  assert.deepEqual([r.stage, r.reason, r.http_status, r.error_code], ['attest', 'integrity_failed', 403, 'verdict:boot']);
  const bare = classify(Object.assign(new PlatformError(403, 'lease_integrity_failed', ''), { stage: 'attest' }));
  assert.deepEqual([bare.reason, bare.error_code], ['integrity_failed', 'lease_integrity_failed']);
  // another refusal as before
  const other = classify(Object.assign(new PlatformError(403, 'app_blocked', ''), { stage: 'config', reason: 'app_blocked' }));
  assert.deepEqual([other.reason, other.error_code], ['refused', 'app_blocked']);
});

const LEASE_403 = (body) => (_, p) => (p === 'POST /v1/model-key' ? { status: 403, body: { error: 'lease_integrity_failed', message: 'free text the SDK never echoes', ...body } } : null);

test('integrity at the lease: server_rejected, the loader\'s message names the check, the report lease/integrity_failed/403 with why:check', { skip: skip4 }, async () => {
  for (const [body, ec, words] of [
    [{ why: 'core' }, 'core', 'the Quran Lab Core in this app could not be verified (lease_integrity_failed, why core)'],
    [{ why: 'verdict', check: 'boot' }, 'verdict:boot', 'bootloader is unlocked or its boot is not verified, and Quran Lab gives such a phone no lease (lease_integrity_failed, why verdict, check boot)'],
    [{ why: 'downgrade' }, 'downgrade', 'stronger check before and did not this time (lease_integrity_failed, why downgrade)'],
    [{}, 'lease_integrity_failed', 'the install could not be verified (lease_integrity_failed)'],
  ]) {
    const r = await firstStart(LEASE_403(body));
    assert.equal(r.code, 'server_rejected', JSON.stringify(body));
    assert.deepEqual(r.q, [['lease', 'integrity_failed', 'server_rejected', 403]], JSON.stringify(body));
    assert.deepEqual(r.ec, [ec]);
    assert.equal(r.bodies[0].error.error_code, ec);
    assert.ok(r.message.startsWith('Quran Lab refused this app: ') && r.message.includes(words), r.message);
    assert.ok(!JSON.stringify(r.bodies).includes('free text') && !r.message.includes('free text'), 'the answer\'s message is never echoed');
  }
});

test('integrity at the attest: server_rejected naming the check; the launch\'s silent report and the call\'s, both attest/integrity_failed/403 verdict:boot', { skip: skip4 }, async () => {
  const r = await firstStart((_, p) => (p === 'POST /v1/attest' ? { status: 403, body: { error: 'lease_integrity_failed', why: 'verdict', check: 'boot' } } : null));
  assert.equal(r.code, 'server_rejected');
  assert.deepEqual(r.q, [['attest', 'integrity_failed', 'none', 403], ['attest', 'integrity_failed', 'server_rejected', 403]]);
  assert.deepEqual(r.ec, ['verdict:boot', 'verdict:boot']);
  assert.ok(r.message.includes('(lease_integrity_failed, why verdict, check boot)'), r.message);
});

test('integrity: another refusal at the lease is as before (refused, its error)', { skip: skip4 }, async () => {
  const r = await firstStart((_, p) => (p === 'POST /v1/model-key' ? { status: 403, body: { error: 'lease_attestation_required' } } : null));
  assert.equal(r.code, 'server_rejected');
  assert.deepEqual(r.q, [['lease', 'refused', 'server_rejected', 403]]);
  assert.deepEqual(r.ec, ['lease_attestation_required']);
});

// ---- 4.0.1: errors_40.json of contract 564c144 ----
import { CoreError, QLC as QLC4 } from '../../sdk4/frame/core.js';

test('core_open: a Core status the model open fails with, to the report\'s reason and error_code (24.3)', () => {
  assert.ok(V.core_open.length >= 4);
  for (const c of V.core_open) {
    const e = Controller.prototype._coreError.call({}, new CoreError(c.status, 0, 'qlc_model_open'), 'the model could not be opened');
    assert.equal(e.code, c.code, c.name);
    assert.equal(e.stage, c.stage, c.name);
    assert.equal(e.why, c.reason, c.name);
    assert.equal(e.error_code, c.error_code, c.name);
    assert.equal(QLC4[c.name.replace(/^QLC_/, '')], c.status, `${c.name} is the binding's status`);
  }
});

test('bodies with host_role and fallback (28.7): the report the SDK builds is the vector\'s; a role not of the three, or a fallback that is not a bool, never goes out', async () => {
  let n = 0;
  for (const b of V.bodies.filter((x) => x.accepted && x.body.error && 'host_role' in x.body.error)) {
    const want = b.body.error;
    const r = new ErrorReports({ state: memoryState(), clock: () => at(b.body.day), top: () => ({ platform: b.body.platform, sdk_version: b.body.sdk_version, app_version: b.body.app_version, os_version: b.body.os_version, device_class: b.body.device_class }) });
    r.occur({ stage: want.stage, reason: want.reason, code: b.body.code, revision: b.body.revision, http_status: want.http_status, error_code: want.error_code,
      retries: want.retries, host_role: want.host_role, fallback: want.fallback, first_launch: want.first_launch });
    let body = null;
    await r.flush(async (x) => { body = x; });
    assert.ok(body, `${b.name}: a report`);
    for (const k of ['stage', 'reason', 'http_status', 'error_code', 'host_role', 'fallback']) assert.deepEqual(body.error[k], want[k], `${b.name}: ${k}`);
    n++;
  }
  assert.ok(n >= 4, 'the 4.0.1 bodies are there');
  for (const b of V.bodies.filter((x) => !x.accepted && x.body.error && ('host_role' in x.body.error || 'fallback' in x.body.error))) {
    const e = b.body.error;
    const r = new ErrorReports({ state: memoryState(), clock: () => at(b.body.day), top: () => ({}) });
    r.occur({ stage: e.stage, reason: e.reason, code: b.body.code, host_role: e.host_role, fallback: e.fallback });
    let body = null;
    await r.flush(async (x) => { body = x; });
    if (body) {
      assert.ok(!('host_role' in body.error) || ['api', 'models', 'web_frame'].includes(body.error.host_role), b.name);
      assert.ok(!('fallback' in body.error) || typeof body.error.fallback === 'boolean', b.name);
    }
  }
});
