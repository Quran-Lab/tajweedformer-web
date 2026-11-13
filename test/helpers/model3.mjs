// Test helpers for the 3.0 API: a synthetic model build (manifest format 3 with a version, signed with the
// shared test vector's seed, never the production key), a stub of Quran Lab's API and CDN as one fetch, and a
// fake engine host with deterministic heads. None of this is the engine: the engine's numbers are checked by
// the conformance tests; these helpers let the Client, Model and Session be tested with no WebAssembly.
import { gzipSync } from 'node:zlib';
import { signedText, sha256Hex } from '../../web/tajweed/manifest.js';
import { fakeHost, audioFor } from './fakehost.mjs';
import { keyId } from '../../web/platform/client.js';
import { memoryState } from '../../web/platform/storage.js';
import { memoryStore } from '../../web/tajweed/delivery.js';
// (an SDK before 3.1.0 has no install record: the helpers then give no device key)
const { memoryDeviceKey } = await import('../../web/tajweed/install.js').catch(() => ({ memoryDeviceKey: () => undefined }));
import { MemoryStorage } from '../../web/sharing/outbox.js';
import { sign, testKeyHex, enc, TOKENS, calFixture } from '../tajweed/folder.mjs';

export { testKeyHex, enc, TOKENS, fakeHost, audioFor };
export const KEY = 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa';
export const ORIGIN = 'https://app.example';
const b64u = (b) => Buffer.from(b).toString('base64url');

/** A clip of the synthetic self-test set as signed 16-bit PCM bytes. */
function s16(ids) {
  const f = audioFor(ids);
  const b = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) b.writeInt16LE(Math.round(f[i] * 32768), 2 * i);
  return new Uint8Array(b);
}

export const CLIP_TOKENS = [0, 0, 3, 3, 0, 5, 5, 5, 1, 7, 0, 0, 9, 9, 0, 0];
/** The reference table of the synthetic build, as the fake host reads it (the real table is the engine's format). */
export const REFERENCE = { '1:1': { units: [3, 5, 1, 7, 9], words: [0, 0, 0, 1, 1], nWords: 2 }, '112:1': { units: [4, 1, 6], words: [0, 0, 1], nWords: 2 } };

/**
 * A synthetic 3.0 model build: { files (the transport folder, by stored path), manifest, bytes, build }.
 * o: { version = '4.0.0', minSdk = '3.0.0', calibration = true, reference = true, selftest = true, edit(manifest),
 *      signed = true, goldenRaw (a golden_raw_tolerance object written into the manifest) }.
 */
export async function build3(o = {}) {
  const logical = [];
  const add = (path, bytes, role, { context = '*', need = 'required', gzip = false, platforms = '*' } = {}) => logical.push({ path, bytes, role, context, need, gzip, platforms });
  add('tokens.txt', enc(TOKENS), 'tokens');
  if (o.calibration !== false) add('calibration.json', enc(calFixture), 'calibration', { gzip: true });
  add('layers.zfw', new Uint8Array(3000).map((_, i) => (i * 7) & 255), 'weights', { gzip: true });
  add('frontend.zfw', enc('frontend'), 'frontend');
  for (const c of ['c16_l64', 'c8_l64', 'c24_l72']) {
    add(`${c}/frames.zfw`, enc(`frames ${c}`), 'frames', { context: c });
    add(`${c}/model_engine2.onnx.zfg`, enc(`graph ${c}`), 'graph', { context: c });
    add(`${c}/model_engine2.onnx`, enc(`ort ${c}`), 'ort-graph', { context: c, need: 'optional', platforms: ['native'] });
  }
  if (o.reference !== false) add('expected_tj3.zfx', enc(JSON.stringify(REFERENCE)), 'reference', { need: 'optional', gzip: true });
  if (o.selftest !== false) {
    add('selftest/selftest.json', enc(JSON.stringify({ format: 'quranlab.selftest/1', clips: [
      { id: 'Clip_001001', kind: 'clean', surah: 1, ayah: 1, file: 'Clip_001001.s16', samples: CLIP_TOKENS.length * 640, sample_rate: 16000 },
      { id: 'Clip_planted', kind: 'planted', surah: 1, ayah: 1, file: 'Clip_planted.s16', samples: 8 * 640, sample_rate: 16000 }] })), 'selftest', { need: 'optional' });
    add('selftest/Clip_001001.s16', s16(CLIP_TOKENS), 'selftest', { need: 'optional', gzip: true });
    add('selftest/Clip_planted.s16', s16([0, 4, 4, 0, 6, 0, 0, 0]), 'selftest', { need: 'optional' });
    // the shape of the production build's file: tokens only (format, context, engine, and per clip chunks and tokens)
    add('selftest/expected_c16_l64.json', enc(JSON.stringify({ format: 'quranlab.selftest-expected/1', context: 'c16_l64', engine: 'a fake engine, exact',
      clips: { Clip_001001: { chunks: 2, tokens: [3, 5, 1, 7, 9] } } })), 'selftest', { need: 'optional', context: 'c16_l64' });
  }
  const files = {}, list = [];
  for (const f of logical) {
    const entry = { platforms: f.platforms, soc: '*', context: f.context, role: f.role, need: f.need };
    if (f.gzip) {
      const gz = new Uint8Array(gzipSync(f.bytes));
      files[f.path + '.gz'] = gz;
      list.push({ path: f.path + '.gz', size: gz.length, sha256: await sha256Hex(gz), ...entry, encoding: 'gzip',
        decoded: { path: f.path, size: f.bytes.length, sha256: await sha256Hex(f.bytes) } });
    } else {
      files[f.path] = f.bytes;
      list.push({ path: f.path, size: f.bytes.length, sha256: await sha256Hex(f.bytes), ...entry, encoding: 'identity' });
    }
  }
  const m = { format: 3, model_id: 'v4.0', family: 'tajweedformer', revision: 'v4.0-test', version: o.version === undefined ? '4.0.0' : o.version,
    min_sdk_version: o.minSdk || '3.0.0', engine_format: 3, coreml_format: 9, tokens: 'tokens.txt', tokens_sha256: await sha256Hex(enc(TOKENS)),
    default_context: 'c16_l64', contexts: ['c16_l64', 'c8_l64', 'c24_l72'], files: list };
  if (m.version === null) delete m.version;
  if (o.goldenRaw) m.golden_raw_tolerance = o.goldenRaw;
  if (o.edit) o.edit(m, files);
  if (o.signed !== false) m.signature = await sign(signedText(m));
  const bytes = enc(JSON.stringify(m, null, 2));
  files['manifest.json'] = bytes;
  return { files, manifest: m, bytes, build: (await sha256Hex(bytes)).slice(0, 40) };
}

/**
 * Quran Lab's API and CDN as one fetch. o: { build (from build3), flags, inference, pinAnswer, sdkLatest }.
 * Returns { fetch, log, pub, state }: state.offline = true makes every request fail as a dead network;
 * state.status[path] forces an error answer for an API path ({ status, error, message, reason, min_sdk });
 * state.cdnAnswer = { status, body } forces the CDN's answer to every model request; state.token is the token
 * the API gives and the CDN takes (change it to make the one in the SDK's hands invalid).
 */
export async function stubPlatform(o = {}) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const kid = await keyId(pub);
  const log = [];
  const state = { offline: false, status: {}, build: o.build || null, builds: o.builds || {}, flags: o.flags || { analytics: true, issues: true, contributions: false },
    inference: o.inference, configVersion: 1, sdkLatest: o.sdkLatest, cdnRequests: 0, cutAfter: null, cdnAnswer: null, token: 'qlt_v1.test.sig' };
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetch = async (url, init = {}) => {
    if (state.offline) throw new TypeError('fetch failed');
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (u.host === 'cdn.test') {
      state.cdnRequests++;
      if (state.cutAfter !== null && state.cdnRequests > state.cutAfter) throw new TypeError('fetch failed');
      const mm = /^\/models\/Quran-Lab\/tajweedformer-v4\/([0-9a-f]{40})\/sdk\/v4\.0\/(.+)$/.exec(u.pathname);
      log.push({ method: 'GET', host: 'cdn', path: mm ? decodeURIComponent(mm[2]) : u.pathname, build: mm && mm[1], headers: h, redirect: init.redirect });
      if (state.cdnAnswer) return json(state.cdnAnswer.status, state.cdnAnswer.body);
      // the CDN of 3.1.0 (SPEC 15.4): the install's token, and the key. (STUB_CDN_OF_TODAY=1: the CDN of 2026-11,
      // which reads the key and ignores the token; with it the tests of the other rules of 3.1.0 can be run on
      // the released code and seen to fail for their own reason.)
      if (process.env.STUB_CDN_OF_TODAY !== '1' && h.authorization !== `Bearer ${state.token}`) return json(401, { error: 'invalid_token', message: 'Renew the token.' });
      if (h['x-qlab-key'] !== KEY) return json(401, { error: 'missing or invalid x-qlab-key' });
      const b = mm && (state.builds[mm[1]] || (state.build && state.build.build === mm[1] ? state.build : null));
      const file = b && b.files[decodeURIComponent(mm[2])];
      if (!file) return new Response(null, { status: 404 });
      const r = /^bytes=(\d+)-(\d+)$/.exec(h.range || '');
      if (!r) return new Response(file, { status: 200 });
      const lo = Number(r[1]), hi = Math.min(file.length - 1, Number(r[2]));
      return new Response(file.slice(lo, hi + 1), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/${file.length}` } });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    log.push({ method: init.method || 'GET', host: 'api', path: u.pathname, query: u.search, headers: h, body });
    const forced = state.status[u.pathname];
    if (forced) return json(forced.status, { error: forced.error, message: forced.message || '', ...(forced.reason ? { reason: forced.reason } : {}), ...(forced.min_sdk ? { min_sdk: forced.min_sdk } : {}) });
    if (u.pathname === '/v1/attest') {
      if (h['x-qlab-key'] !== KEY) return json(401, { error: 'invalid_key' });
      return json(200, { token: state.token, expires_in: 86400, attested: false });
    }
    if (h.authorization !== `Bearer ${state.token}`) return json(401, { error: 'invalid_token' });
    if (u.pathname === '/v1/register') return json(200, { ok: true, app_id: `${body.platform}:${body.bundle_id}`, store_status: 'pending' });
    if (u.pathname === '/v1/config') {
      const want = u.searchParams.get('model_version');
      const etag = `"v${state.configVersion}-${want || ''}"`;
      if (h['if-none-match'] === etag) return new Response(null, { status: 304 });
      const now = Math.floor(Date.now() / 1000);
      let b = state.build, pin;
      if (want) {
        const hit = Object.values(state.builds).find((x) => x.manifest.version === want) || (b && b.manifest.version === want ? b : null);
        if (hit) b = hit; else pin = { version: want, status: 'unavailable' };
      }
      const cfg = { v: 1, app: `web:${ORIGIN}`, channel: 'stable', issued_at: now, expires_at: now + 86400, models: {},
        recommended: b ? { model: 'Quran-Lab/tajweedformer-v4', model_id: 'v4.0', folder: 'sdk/v4.0', revision: b.build, version: b.manifest.version, source: 'stable' } : null,
        denylist: [], flags: state.flags, base: 'https://cdn.test/models',
        ...(state.inference ? { inference: state.inference } : {}), ...(pin ? { pin } : {}), ...(state.sdkLatest ? { sdk_latest: state.sdkLatest } : {}) };
      const bytes = enc(JSON.stringify(cfg));
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, bytes));
      return new Response(bytes, { status: 200, headers: { 'x-qlab-signature': `ed25519=${b64u(sig)}`, 'x-qlab-key-id': kid, etag } });
    }
    if (u.pathname === '/v1/events') return json(202, { ok: true, points: 1 });
    if (u.pathname === '/v1/issues') return json(202, { ok: true });
    return json(404, { error: 'not_found' });
  };
  return { fetch, log, pub, state };
}

/** The seams of createClient for a stub platform: memory storage, the test keys, no page listeners. */
export function seamsFor(api, extra = {}) {
  return { fetch: api.fetch, apiUrl: 'https://api.test', trustedKeys: [api.pub], modelKeys: [testKeyHex], origin: ORIGIN, platform: 'web',
    state: memoryState(), store: memoryStore(), sharingStorage: new MemoryStorage(), autoSend: false, host: fakeHost(),
    installKey: memoryDeviceKey(), // this test device's key store (SPEC 15.2); pass the same one for a relaunch
    lifecycle: { document: null, window: null }, ...extra };
}
