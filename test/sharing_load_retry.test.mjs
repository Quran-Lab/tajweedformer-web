// 4.0.1: a shared recording whose upload got no answer at all (the browser reports a CORS refusal as no answer, as it
// does a dropped connection: for four days in November 2026 a bucket rule held every web PUT that way) waits in the
// outbox on a backoff that reaches 6 hours. The next page tries it once at once, then the backoff goes on. A recording
// the server answered (a refusal, a 4xx, a 5xx, a limit) keeps its backoff. Records an earlier SDK wrote (no
// `lastFailure`) are read from the words of their `lastError`. Consent, deletion and limits are the outbox's as before:
// with sharing off the next page sends nothing. Through the consent controller: at the page's start, with sharing
// on, the outbox is tried without any take.
//
// A "page" is a new pipeline (a new Outbox) on the same storage.
import test from 'node:test';
import '../web/index.node.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, loadOpus, MemoryStorage, segmentName, resetSharingForTests, outbox as pageOutbox } from '../web/sharing/index.js';
import { lastFailedOnNetwork, readJson, writeJson, FILES } from '../web/sharing/outbox.js';
import { enableSharing, SHARING_STATE_KEY } from '../web/consent/index.js';
import { memoryState } from '../web/platform/index.js';
import { stubApi, client, clip16k, listen, NOW } from './sharing_stub_api.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;
const UNATT = { token: 'qlt_v1.eyJ2IjoxfQ.web', attested: false };

// Quran Lab's API and the bucket as one fetch. net.put: 'ok', 'cors' (no answer: a TypeError, as a browser gives for
// a CORS refusal), or a status the bucket answers; net.start likewise for POST /v1/uploads
function server() {
  const net = { put: 'ok', start: 'ok', starts: 0, puts: 0, putsOk: 0 };
  const res = (status, obj) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status });
  const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(Date.now() / 1000) + 604800,
    url: `https://r2.test/v1/${id}/${segmentName(n)}.opus?X-Amz-Signature=s${n}` })) });
  const answer = (how, ok) => {
    if (how === 'ok') return ok();
    if (how === 'cors') throw new TypeError('Failed to fetch');
    return res(how.status, how.body || { error: how.error || `http_${how.status}` });
  };
  net.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'r2.test') {
      net.puts++;
      return answer(net.put, () => { net.putsOk++; return res(200, ''); });
    }
    if (u.pathname === '/v1/uploads') {
      net.starts++;
      return answer(net.start, () => res(201, urls((init.headers || {})['x-qlab-id'], 1)));
    }
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return res(200, urls(m[1], Number(u.searchParams.get('from'))));
    return res(404, { error: 'not_found' });
  };
  return net;
}

// a page: a pipeline on `storage` (sharing on or off, the config's flags)
async function page(net, storage, { enabled = true } = {}) {
  const state = { enabled };
  const sharing = await createSharing({ api: 'https://api.test', fetch: net.fetch, tokenProvider: async () => UNATT, storage, consentVersion: 'deck-1',
    enabled: () => state.enabled, flags: () => ({ share_join_ms: 0, contributions: true, upload_trust: { web: 'capped' } }), opus: async () => opus,
    device: { deviceClass: 'browser', osMajor: 14 } });
  return { sharing, outbox: sharing.outbox, state };
}

// one recording of `seconds`, closed, and one pass of its upload (which fails as the server is told to)
async function recordOne(p, seconds = 12) {
  const s = await p.sharing.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: null } });
  const x = new Float32Array(48000 * seconds);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(i / 20) * 0.1;
  for (let at = 0; at < x.length; at += 480) s.push(x.subarray(at, at + 480));
  await s.finish();
  await p.sharing.closeRecording();
  await p.outbox.drain({ ignoringBackoff: true });
  const [item] = await p.outbox.items();
  return { id: item.id, rec: p.outbox.records.get(item.id) };
}

test('no answer (a CORS refusal of the PUT): the next page tries it at once, once, then the backoff goes on', { skip }, async () => {
  const net = server(), storage = new MemoryStorage();
  net.put = 'cors';
  const a = await page(net, storage);
  const { id, rec } = await recordOne(a);
  assert.equal(rec.lastFailure, 'network');
  assert.ok(rec.nextAttempt > Date.now() + 10_000, 'on its backoff');
  assert.equal(lastFailedOnNetwork(rec), true);
  // the next page, the bucket still refusing: one try at once, none more in the same page; the backoff after it
  resetSharingForTests();
  const b = await page(net, storage);
  const puts0 = net.puts;
  assert.deepEqual(await b.outbox.networkFailed(), [id]);
  await b.outbox.drain();
  assert.equal(net.puts, puts0 + 1, 'tried at once');
  const after = b.outbox.records.get(id);
  assert.ok(after.nextAttempt > Date.now() + 10_000 && after.lastFailure === 'network', 'the backoff goes on');
  await b.outbox.drain();
  assert.equal(net.puts, puts0 + 1, 'once per page');
  // the page after: the bucket fixed; it goes up at the page's start, with no backoff waited for
  resetSharingForTests();
  net.put = 'ok';
  const c = await page(net, storage);
  await c.outbox.drain();
  const [item] = await c.outbox.items();
  assert.equal(item.status, 'uploaded');
  assert.equal(c.outbox.records.get(id).lastFailure, null);
  assert.ok(net.putsOk >= 1);
});

test('an answer keeps its backoff at the next page: a refusal, a 4xx, a 5xx, a limit', { skip }, async () => {
  for (const how of [{ status: 403, error: 'forbidden' }, { status: 400, error: 'invalid_body' }, { status: 503, error: 'unavailable' },
    { status: 429, error: 'volume_limit' }]) {
    const net = server(), storage = new MemoryStorage();
    net.start = how;
    const a = await page(net, storage);
    const { id, rec } = await recordOne(a);
    const label = `${how.status} ${how.error}`;
    if (rec.state !== 'active') { assert.equal(lastFailedOnNetwork(rec), false, label); continue; } // a 400 fails the recording: nothing waits
    assert.equal(rec.lastFailure, 'answer', label);
    assert.ok(rec.nextAttempt > Date.now() + 10_000, `${label}: on its backoff`);
    resetSharingForTests();
    net.start = 'ok';
    const b = await page(net, storage);
    const starts0 = net.starts;
    assert.deepEqual(await b.outbox.networkFailed(), [], label);
    await b.outbox.drain();
    assert.equal(net.starts, starts0, `${label}: not asked before its backoff ends`);
    assert.equal(b.outbox.records.get(id).nextAttempt, rec.nextAttempt, label);
  }
});

test('records an earlier SDK wrote (no lastFailure): read from their lastError', async () => {
  const at = Date.now() + 3_600_000;
  const legacy = (lastError) => ({ state: 'active', nextAttempt: at, lastError });
  for (const e of ['PUT seg-00001.opus: Failed to fetch', 'PUT seg-00003.opus: NetworkError when attempting to fetch resource.', 'Load failed',
    'fetch failed', 'offline']) assert.equal(lastFailedOnNetwork(legacy(e)), true, e);
  for (const e of ['PUT seg-00001.opus: HTTP 403', 'HTTP 503 unavailable', 'HTTP 401 invalid_token', 'HTTP 429 volume_limit: retry tomorrow',
    'token: no answer', 'no token', 'no upload URLs in the answer', 'attestation_required: this install has no attested token; sharing paused',
    'sharing is off; waiting', 'HTTP 403 contributions_disabled: paused', null]) assert.equal(lastFailedOnNetwork(legacy(e)), false, String(e));
  // not waiting: uploaded, failed, or due anyway
  assert.equal(lastFailedOnNetwork({ state: 'uploaded', nextAttempt: at, lastError: 'offline' }), false);
  assert.equal(lastFailedOnNetwork({ state: 'active', nextAttempt: null, lastError: 'offline' }), false);
  // the new field decides when it is there
  assert.equal(lastFailedOnNetwork({ state: 'active', nextAttempt: at, lastError: 'HTTP 503 x', lastFailure: 'network' }), true);
  assert.equal(lastFailedOnNetwork({ state: 'active', nextAttempt: at, lastError: 'offline', lastFailure: 'answer' }), false);
});

test('a 4.0.0 record of a CORS refusal (no lastFailure) is tried at once by the next page; with sharing off nothing is sent', { skip }, async () => {
  const net = server(), storage = new MemoryStorage();
  net.put = 'cors';
  const a = await page(net, storage);
  const { id } = await recordOne(a);
  // as 4.0.0 wrote it: no lastFailure, the browser's words after the segment's name
  const item = await readJson(storage, id, FILES.item);
  delete item.lastFailure;
  item.lastError = 'PUT seg-00001.opus: Failed to fetch';
  await writeJson(storage, id, FILES.item, item);
  net.put = 'ok';
  // sharing off at the next page: nothing goes, the recording waits
  resetSharingForTests();
  const off = await page(net, storage, { enabled: false });
  const puts0 = net.puts;
  await off.outbox.drain();
  assert.equal(net.puts, puts0, 'sharing off: nothing is sent');
  // sharing on at the page after: tried at once and uploaded
  resetSharingForTests();
  const on = await page(net, storage);
  await on.outbox.drain();
  const [x] = await on.outbox.items();
  assert.equal(x.status, 'uploaded');
});

test('through the consent controller: at the page\'s start, with sharing on, the outbox is tried without any take', { skip }, async () => {
  const api = await stubApi({ contributions: true, share_join_ms: 0, upload_trust: { web: 'capped', linux: 'capped' } });
  const net = { r2: 'cors' };
  const fetch = (url, init) => (new URL(url).host === 'r2.test' && net.r2 === 'cors' ? Promise.reject(new TypeError('Failed to fetch')) : api.fetch(url, init));
  const st = memoryState();
  st.set(SHARING_STATE_KEY, { v: 1, consent: 'granted', asks: 1, lastAskSession: 1, sessions: 4, thanked: true, decidedAt: '2026-11-12',
    consentVersion: 'share-2026-11-09', consentTextSha256: null, changes: 1 });
  const storage = new MemoryStorage();
  const open = async () => {
    resetSharingForTests();
    const ql = await client(api, { state: st, fetch });
    ql.sharingStorage = storage;
    const ctl = enableSharing(ql, { lang: 'en', timers: NOW, ask: async () => ({ yes: true }) });
    await ctl.loadRetried;
    return ctl;
  };
  // the first page records one take; its PUTs get no answer
  const first = await open();
  await listen(first, clip16k(12), { complete: false });
  for (let i = 0; i < 100 && !(await storage.sessions()).length; i++) await new Promise((r) => setTimeout(r, 20));
  const id = (await storage.sessions())[0];
  for (let i = 0; i < 100; i++) {
    const item = await readJson(storage, id, FILES.item);
    if (item && item.lastFailure === 'network' && item.nextAttempt) break;
    const pipe = await pageOutbox.sharing();
    if (pipe) await pipe.outbox.drain({ ignoringBackoff: true });
    await new Promise((r) => setTimeout(r, 20));
  }
  const waiting = await readJson(storage, id, FILES.item);
  assert.equal(waiting.lastFailure, 'network');
  assert.equal(api.state.puts.size, 0);
  // the next page, the bucket fixed: no take, and the recording goes up at the start
  net.r2 = 'ok';
  await open();
  const after = await readJson(storage, id, FILES.item);
  assert.equal(after.state, 'uploaded', JSON.stringify(after));
  assert.ok(api.state.puts.size >= 1);
});
