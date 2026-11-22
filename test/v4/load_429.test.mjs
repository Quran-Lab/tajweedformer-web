// SDK 4.0.2, ENDPOINTS_40.md 28.11: under load. Every route honours Retry-After on a 429 and on a 503 that carries one
// (no request of that route goes to that host before it; a 429 is never taken to another host, 28.3), and optional
// traffic (telemetry, error reports, shared-recording uploads) steps back after a 429: the larger of Retry-After (300 s
// when there is none) and its own next send point, doubling per 429 in a row up to 3600 s, nothing dropped. The tests of
// 28.11 item 6 on the code that makes the requests: the endpoint set (every api route), the frame's model file download
// (Controller._get), the platform client's telemetry and reports (QuranLab.flush), and the sharing outbox. 28.11 items 3
// and 6: each route's hold and each step back are kept in the SDK's state, so a new page load or process 10 s after a
// 429 with Retry-After: 90 sends nothing on that route for the remaining 80 s (the SDK's own call of each route: the
// config, register, attest, the challenge, the lease, events, issues, the uploads).
//
// 4.0.1 per route: a 429 already stayed on its host (28.3) on every route. Retry-After was read on the lease route only,
// where it replaced the retry step (18.4.7.3 now). Elsewhere it was not read: the config kept its own refresh schedule,
// telemetry waited 1 min, then 10 min, then the next launch, error reports their next send point (30 s after a new one,
// every 15 minutes), the uploads the outbox's backoff (30 s doubling, jittered; a volume_limit until the next UTC day),
// and the model files were asked again at the next call.
import { test } from 'node:test';
import '../../web/index.node.js'; // Node's parts of the SDK (the sharing pipeline in Node)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Endpoints, ROLES, StepBack } from '../../sdk4/shared/endpoints.js';
import { QuranLab } from '../../web/platform/client.js';
import { QuranLab4 } from '../../sdk4/frame/api4.js';
import { respond, TRUSTED } from './helpers/vector-answers.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, StateStore } from '../../sdk4/frame/stores.js';
import { createSharing, MemoryStorage, loadOpus, segmentName } from '../../web/sharing/index.js';
import { clipSeconds } from '../sharing_stream_checks.mjs';

const [A, B] = ROLES.api;
const [C1, C2] = ROLES.models;
const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const root = fileURLToPath(new URL('../..', import.meta.url));
const haveOpus = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));

test('28.11 item 6: a 429 on any route asks no other host', async () => {
  for (const route of ['/v1/config', '/v1/register', '/v1/attest', '/v1/attest/challenge', '/v1/model-key', '/v1/events', '/v1/issues', '/v1/uploads', '/v1/contributions/summary']) {
    const asked = [];
    const fetch = async (url) => { const h = new URL(url).host; asked.push(h); return h === A ? json(429, { error: 'rate_limited' }) : json(200, {}); };
    const got = await new Endpoints({ headMs: 200 }).request('api', route, { method: 'POST' }, { fetch });
    assert.deepEqual([got.cls, got.status, asked], ['slow_down', 429, [A]], route);
  }
});

test('28.11 item 2: a Retry-After holds the route on that host: a 429 answers again from the hold with no request, a 503 goes to the next host; after it the host is asked', async () => {
  let now = 1_000_000;
  const ep = new Endpoints({ headMs: 200, clock: () => now });
  const asked = [];
  let answer = (h) => (h === A ? json(429, { error: 'rate_limited' }, { 'retry-after': '120' }) : json(200, {}));
  const fetch = async (url) => { const h = new URL(url).host; asked.push(`${h}${new URL(url).pathname}`); return answer(h); };
  await ep.request('api', '/v1/events', {}, { fetch });
  now += 30_000;
  let got = await ep.request('api', '/v1/events', {}, { fetch });
  assert.deepEqual([got.cls, got.status, got.res.headers.get('retry-after')], ['slow_down', 429, '90'], 'answered from the hold');
  assert.deepEqual(asked, [`${A}/v1/events`], 'no request during the hold');
  // another route of the same host is not held
  answer = () => json(200, {});
  got = await ep.request('api', '/v1/issues', {}, { fetch });
  assert.deepEqual([got.cls, asked.at(-1)], ['taken', `${A}/v1/issues`]);
  now += 91_000;
  got = await ep.request('api', '/v1/events', {}, { fetch });
  assert.deepEqual([got.cls, asked.at(-1)], ['taken', `${A}/v1/events`], 'asked again once the Retry-After has passed');
  // a 503 with Retry-After: 60 (the lease route's lease_unavailable): within it the next host is asked, never the first
  asked.length = 0;
  answer = (h) => (h === A ? json(503, { error: 'lease_unavailable' }, { 'retry-after': '60' }) : json(200, { ok: true }));
  got = await ep.request('api', '/v1/model-key', {}, { fetch });
  assert.deepEqual([got.host, asked], [B, [`${A}/v1/model-key`, `${B}/v1/model-key`]]);
  now += 10_000;
  ep.roles.api.p = A; // even with the first host preferred again
  got = await ep.request('api', '/v1/model-key', {}, { fetch });
  assert.deepEqual([got.host, asked.slice(2)], [B, [`${B}/v1/model-key`]], 'the held host is not asked');
});

// the frame's download code alone (as test/v4/endpoints_replay.test.mjs): the endpoint set, a token-free header, stores
async function downloader(fetch, clock) {
  const kv = new MemoryKV(), files = new MemoryFiles();
  const c = new Controller({ key: KEY, site: 'https://app.example', files, kv, clock, download: { pausesMs: [1, 1, 1, 1, 1], stallMs: 200 }, endpoints: { headMs: 200 } });
  c.state = await StateStore.open(kv);
  c.ql = { modelHeaders: async () => ({}), rawFetch: fetch, noteModelServed() {}, noteModelRefusal() {}, _token: null };
  return c;
}

test('28.11 item 2: the model files: a 429 ends the call on its host (no other host), and with Retry-After: 120 the next call within it asks nothing', async () => {
  let now = 5_000_000;
  const seen = [];
  const fetch = async (url) => { seen.push(new URL(url).host); return json(429, { error: 'model_limit' }, { 'retry-after': '120' }); };
  const c = await downloader(fetch, () => now);
  const url = `https://${C1}/models/m/b/sdk/v4.0/c16_l64/layers.zfw.qle`;
  const e1 = await c._get(url, { size: 10 }).then(() => null, (e) => e);
  assert.deepEqual([e1.code, e1.why, e1.http_status, e1.error_code, seen], ['download_failed', 'rate_limited', 429, 'model_limit', [C1]]);
  now += 60_000;
  const e2 = await c._get(url, { size: 10 }).then(() => null, (e) => e);
  assert.deepEqual([e2.why, e2.error_code, seen.length], ['rate_limited', 'model_limit', 1], 'within the Retry-After: no request');
  now += 61_000;
  await c._get(url, { size: 10 }).catch(() => {});
  assert.deepEqual(seen, [C1, C1], 'after it, the host is asked again (and no other)');
  assert.ok(!seen.includes(C2));
});

test('28.11 item 2: on the models role a hold is per file path and host: a 503 with Retry-After: 3600 for one file holds that file there, and another file is still asked of that host', async () => {
  let now = 6_000_000;
  const seen = [];
  const ACCEL = '/models/m/b/sdk/v4.0/c16_l64_ane/layers.bin.qle', CPU = '/models/m/b/sdk/v4.0/c16_l64/layers.zfw.qle';
  // the first host does not hold the accelerator build (as a standby, 28.9 item 3): 503 with Retry-After: 3600
  const fetch = async (url) => {
    const u = new URL(url);
    seen.push(`${u.host}${u.pathname}`);
    if (u.host === C1 && u.pathname === ACCEL) return json(503, { error: 'not_held' }, { 'retry-after': '3600' });
    return new Response(new Uint8Array(10), { status: 200 });
  };
  const c = await downloader(fetch, () => now);
  await c._get(`https://${C1}${ACCEL}`, { size: 10 });
  assert.deepEqual(seen, [`${C1}${ACCEL}`, `${C2}${ACCEL}`], 'the 503 goes on to the next host');
  now += 60_000;
  c.ep.roles.models.p = C1; // the first host preferred again
  await c._get(`https://${C1}${CPU}`, { size: 10 });
  assert.equal(seen.at(-1), `${C1}${CPU}`, 'another file is still asked of the first host');
  await c._get(`https://${C1}${ACCEL}`, { size: 10 });
  assert.deepEqual(seen.slice(3), [`${C2}${ACCEL}`], 'the held file is not asked of the first host within the hour');
  now += 3_600_000;
  c.ep.roles.models.p = C1;
  await c._get(`https://${C1}${ACCEL}`, { size: 10 }).catch(() => {});
  assert.equal(seen[4], `${C1}${ACCEL}`, 'after it, asked there again');
});

test('28.7 with 28.11 item 2: a host held from an earlier answer (a 503 with Retry-After kept across a reload) is passed with no request and no failover report; the next host is asked, the retry count and diagnose\'s lastFailover as before', async () => {
  let now = 7_000_000;
  const FILE = '/models/m/b/sdk/v4.0/c16_l64/layers.zfw.qle';
  const seen = [];
  const fetch = async (url) => {
    const u = new URL(url);
    seen.push(`${u.host}${u.pathname}`);
    if (u.host === C1) return json(503, { error: 'unavailable' }, { 'retry-after': '3600' });
    return new Response(new Uint8Array(10), { status: 200 });
  };
  // the page before: the first host asked, answered 503 with Retry-After: 3600 (unreachable, a failover report)
  const before = await downloader(fetch, () => now);
  const reported = [];
  before.ep.onFailover = (f) => reported.push(f);
  await before._get(`https://${C1}${FILE}`, { size: 10 });
  assert.deepEqual([seen, reported.length], [[`${C1}${FILE}`, `${C2}${FILE}`], 1], 'asked and unreachable: reported');
  // the same page, the next request of that file (the hold made by the request before): skipped with no report
  // (ENDPOINTS_40.md 28.7, contract 7cdb1ee: per request), the retry as before
  seen.length = 0;
  const resumes0 = before.dl.resumes;
  before.ep.roles.models.p = C1; // the first host preferred again (as after 28.3's probe back)
  await before._get(`https://${C1}${FILE}`, { size: 10 });
  assert.deepEqual([seen, reported.length, before.dl.resumes - resumes0], [[`${C2}${FILE}`], 1, 1], 'in the page: not asked, no report, one resume');
  // the manifest stage the same way (its own path held on the first host)
  const MAN = '/models/m/b/sdk/v4.0/manifest.json';
  before.ep.roles.models.p = C1;
  await before._get(`https://${C1}${MAN}`, { stage: 'manifest' });
  assert.equal(reported.length, 2, 'the manifest request that asked the first host and got its 503: reported');
  seen.length = 0;
  before.ep.roles.models.p = C1;
  await before._get(`https://${C1}${MAN}`, { stage: 'manifest' });
  assert.deepEqual([seen, reported.length], [[`${C2}${MAN}`], 2], 'the next manifest request skips the held host: no report');
  seen.length = 0;
  const kept = before.ep.holdsState(); // what the SDK's state keeps (QuranLab's onHolds), read back at the next start
  // a reload 60 s later: the kept hold read back (as QuranLab's constructor does), the first host preferred again
  now += 60_000;
  const after = await downloader(fetch, () => now);
  after.ep.restoreHolds(kept);
  const reports = [];
  after.ep.onFailover = (f) => reports.push(f);
  seen.length = 0;
  await after._get(`https://${C1}${FILE}`, { size: 10 });
  assert.deepEqual(seen, [`${C2}${FILE}`], 'the held host is not asked; the next one is');
  assert.equal(reports.length, 0, 'no failover report: the first host was not asked');
  assert.equal(after.dl.resumes, 1, 'the retry count as before (the held host is one step of the order)');
  assert.deepEqual([after.ep.lastFailover.from, after.ep.lastFailover.to], [C1, C2], 'diagnose\'s lastFailover as before');
  // the api role the same way: a 503 with Retry-After kept for the lease route on the first host
  const ep = new Endpoints({ headMs: 200, clock: () => now });
  ep.restoreHolds([{ k: `api /v1/model-key ${A}`, until: now + 60_000, status: 503, error: 'lease_unavailable' }]);
  const apiReports = [];
  ep.onFailover = (f) => apiReports.push(f);
  const asked = [];
  const got = await ep.request('api', '/v1/model-key', { method: 'POST' }, { stage: 'lease', fetch: async (url) => { asked.push(new URL(url).host); return json(200, { ok: true }); } });
  assert.deepEqual([got.host, asked, apiReports.length], [B, [B], 0], 'api: the next host asked, no failover report');
  assert.deepEqual([ep.lastFailover.from, ep.lastFailover.to], [A, B]);
});

test('ERRORS_40 24.3 fallback (4.0.2): true only when the request asked more than one host; a host passed for its hold was not asked (model files, the manifest, the api role)', async () => {
  let now = 8_000_000;
  for (const [what, FILE, opt] of [['a model file', '/models/m/b/sdk/v4.0/c16_l64/frontend.zfw.qle', { size: 10 }], ['the manifest', '/models/m/b/sdk/v4.0/manifest.json', { stage: 'manifest' }]]) {
    // the first host answers 503 with Retry-After: 3600, the second refuses (a 4xx of its own: the call ends there)
    const fetch = async (url) => (new URL(url).host === C1 ? json(503, { error: 'unavailable' }, { 'retry-after': '3600' }) : json(404, { error: 'not_found' }));
    const c = await downloader(fetch, () => now);
    const asked = await c._get(`https://${C1}${FILE}`, opt).then(() => null, (e) => e);
    assert.deepEqual([asked.http_status, asked.error_code, asked.fallback], [404, 'not_found', true], `${what}: two hosts asked, fallback`);
    // the next request of it: the first host held, not asked; only the second asked: no fallback
    c.ep.roles.models.p = C1;
    const held = await c._get(`https://${C1}${FILE}`, opt).then(() => null, (e) => e);
    assert.deepEqual([held.http_status, held.error_code, held.host_role, held.fallback], [404, 'not_found', 'models', false], `${what}: the held host skipped, one host asked`);
  }
  // the api role: the lease route held on the first host, the second refuses
  const ep = new Endpoints({ headMs: 200, clock: () => now });
  ep.restoreHolds([{ k: `api /v1/model-key ${A}`, until: now + 60_000, status: 503, error: 'lease_unavailable' }]);
  const got = await ep.request('api', '/v1/model-key', { method: 'POST' }, { stage: 'lease', fetch: async () => json(403, { error: 'lease_attestation_required' }) });
  assert.deepEqual([got.host, got.cls, got.fallback], [B, 'refused', false]);
});

test('28.7 (4.0.2): the first host asked and unreachable, the next one held by an earlier 429: the request ends on the held answer with no failover report and fallback false; with the next one held by a 503 and a third answering, a report and fallback true (model files, the manifest, the api role)', async () => {
  let now = 9_000_000;
  const C3 = ROLES.models[2];
  for (const [what, FILE, opt] of [['a model file', '/models/m/b/sdk/v4.0/c16_l64/layers.zfw.qle', { size: 10 }], ['the manifest', '/models/m/b/sdk/v4.0/manifest.json', { stage: 'manifest' }]]) {
    for (const [heldStatus, expectReports] of [[429, 0], [503, 1]]) {
      const seen = [];
      const fetch = async (url) => { const u = new URL(url); seen.push(u.host); return u.host === C1 ? json(503, { error: 'unavailable' }) : new Response(new Uint8Array(10), { status: 200 }); };
      const c = await downloader(fetch, () => now);
      // the hold an earlier request (or page load) left on the second host for this path
      c.ep.restoreHolds([{ k: `models ${FILE} ${C2}`, until: now + 600_000, status: heldStatus, error: heldStatus === 429 ? 'rate_limited' : null }]);
      const reports = [];
      c.ep.onFailover = (f) => reports.push(f);
      const e = await c._get(`https://${C1}${FILE}`, opt).then(() => null, (x) => x);
      if (heldStatus === 429) {
        assert.deepEqual([seen, e && e.why, e && e.fallback, reports.length], [[C1], 'rate_limited', false, 0], `${what}: ended on the held 429, only the first host asked, no report`);
      } else {
        assert.deepEqual([seen, e, reports.length], [[C1, C3], null, expectReports], `${what}: the held 503 passed, the third host answered: a report`);
      }
    }
  }
  // the api role
  for (const [heldStatus, expect] of [[429, { cls: 'slow_down', fallback: false, reports: 0, asked: [A] }], [503, { cls: 'taken', fallback: true, reports: 1, asked: [A, ROLES.api[2]] }]]) {
    const ep = new Endpoints({ headMs: 200, clock: () => now });
    ep.restoreHolds([{ k: `api /v1/model-key ${B}`, until: now + 600_000, status: heldStatus, error: heldStatus === 429 ? 'rate_limited' : 'lease_unavailable' }]);
    const reports = [];
    ep.onFailover = (f) => reports.push(f);
    const asked = [];
    const got = await ep.request('api', '/v1/model-key', { method: 'POST' }, { stage: 'lease', fetch: async (url) => { const h = new URL(url).host; asked.push(h); return h === A ? json(503, { error: 'unavailable' }) : json(200, { ok: true }); } });
    assert.deepEqual({ cls: got.cls, fallback: got.fallback, reports: reports.length, asked }, expect, `api, the second host held by a ${heldStatus}`);
  }
});

test('28.11 item 6: a 429 with Retry-After: 120 on events: the send point 30 s later sends nothing, the one after 120 s sends', async () => {
  let now = Date.UTC(2026, 10, 21, 12);
  const seen = [];
  let events = 0;
  const fetch = async (url, init = {}) => {
    const p = new URL(url).pathname;
    seen.push(p);
    if (p === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400 });
    if (p === '/v1/events') return ++events === 1 ? json(429, { error: 'rate_limited' }, { 'retry-after': '120' }) : json(202, { ok: true });
    return json(404, { error: 'not_found' });
  };
  const state = new Map();
  const st = { get: (k) => (state.has(k) ? state.get(k) : null), set: (k, v) => { if (v === null || v === undefined) state.delete(k); else state.set(k, v); } };
  const ql = new QuranLab({ key: KEY, bundleId: 'https://app.example', fetch, state: st, clock: () => now, autoSend: false, issues: false,
    endpoints: new Endpoints({ headMs: 200, clock: () => now }), apiUrl: `https://${A}` });
  st.set('telemetry.sealed', [{ report_id: 'r1', day: '2026-11-20', body: JSON.stringify({ day: '2026-11-20' }), attempts: 0, next: 0 }]);
  const posts = () => seen.filter((p) => p === '/v1/events').length;
  assert.equal(await ql.flush(), 0);
  assert.equal(posts(), 1, 'the 429');
  now += 30_000;
  await ql.flush();
  assert.equal(posts(), 1, '30 s later: nothing sent');
  // 90 s: the report's own schedule (1 minute) has come, the Retry-After has not
  now += 60_000;
  await ql.flush();
  assert.equal(posts(), 1, '90 s: still nothing (the Retry-After is the larger)');
  now += 31_000;
  assert.equal(await ql.flush(), 1, 'after 120 s: sent and accepted');
  assert.equal(posts(), 2);
  assert.deepEqual(ql.telemetry.reports(), [], 'nothing was dropped on the way');
});

test('28.11 item 6: three 429s in a row without Retry-After on uploads give waits of 300, 600 and 1200 s; an accepted answer ends the row', { skip: haveOpus ? false : 'dist/tajweedformer-opus.mjs is not built' }, async () => {
  let now = Date.UTC(2026, 10, 21, 12);
  let starts = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(now / 1000) + 604800, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) });
    if (u.pathname === '/v1/uploads') return ++starts <= 3 ? json(429, { error: 'rate_limited' }) : json(201, urls(init.headers['x-qlab-id'], 1));
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return json(200, urls(m[1], Number(u.searchParams.get('from'))));
    if (u.host === 'r2.test') return new Response('', { status: 200 });
    return json(404, { error: 'not_found' });
  };
  const opus = await loadOpus();
  const sharing = await createSharing({ api: 'https://api.test', fetch, tokenProvider: async () => ({ token: 't', attested: false }), storage: new MemoryStorage(),
    consentVersion: 'deck-1', contributor: 'c'.repeat(32), enabled: () => true, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
    opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, random: () => 0.5, clock: () => now, locks: null, lifecycle: { document: null, window: null }, log: () => {} });
  const t = await sharing.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  const id = t.id;
  const pcm = clipSeconds(48000, 3);
  for (let i = 0; i < pcm.length; i += 960) t.push(pcm.subarray(i, i + 960));
  await t.finish({ completed: true });
  await sharing.closeRecording();
  const waits = [];
  for (let k = 0; k < 3; k++) {
    await sharing.outbox.drain({ ignoringBackoff: true });
    const rec = sharing.outbox.records.get(id);
    waits.push(Math.round((rec.nextAttempt - now) / 1000));
    // its next pass is not before that: a pass now (its own schedule ignored) sends nothing
    now += 1000;
    await sharing.outbox.drain();
    assert.equal(starts, k + 1);
    now = rec.nextAttempt;
  }
  assert.deepEqual(waits, [300, 600, 1200]);
  assert.equal(sharing.outbox.uploadsBack.row, 3);
  for (let i = 0; i < 10 && (await sharing.outbox.items())[0].status !== 'uploaded'; i++) await sharing.outbox.drain();
  assert.equal((await sharing.outbox.items())[0].status, 'uploaded', 'uploaded once the server takes it');
  assert.equal(sharing.outbox.uploadsBack.row, 0, 'the accepted answer ended the row');
});

test('28.11 item 4: the step back: Retry-After or 300 s, doubled per 429 in a row up to 3600 s, never below a Retry-After', () => {
  let now = 0;
  const sb = new StepBack(() => now);
  assert.deepEqual([sb.slowDown(), sb.slowDown(), sb.slowDown(), sb.slowDown(), sb.slowDown(), sb.slowDown()], [300, 600, 1200, 2400, 3600, 3600]);
  sb.ok();
  assert.deepEqual([sb.slowDown(120), sb.slowDown(120)], [120, 240]);
  sb.ok();
  assert.equal(sb.slowDown(7200), 7200, 'a Retry-After above 3600 s is kept');
  assert.equal(sb.left(), 7200_000);
});

// ---------------------------------------------------------------- 28.11 item 6: every route, through the SDK's own call
const memState = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? structuredClone(m.get(k)) : null), set: (k, v) => { if (v === null || v === undefined) m.delete(k); else m.set(k, structuredClone(v)); } }; };
const keys = { spki: new Uint8Array(1), signSpki: new Uint8Array(1), installHex: '00', hw: false, attestSig: async () => 'c2ln' };
// each route: the client that makes it (4.0's for attest, the challenge and the lease), its call, its good answer
const ROUTES = [
  ['config', '/v1/config', false, (ql) => ql.refreshConfig(), () => respond({ status: 200, body: 'json' }, 'config')],
  ['register', '/v1/register', false, (ql) => ql.register(), () => json(200, {})],
  ['attest', '/v1/attest', true, (ql) => { ql._token = null; ql.installCert = null; return ql.token(); }, () => json(200, { token: 'tok', expires_in: 86400 })],
  ['challenge', '/v1/attest/challenge', true, (ql) => ql.challenge(), () => json(200, { challenge: 'c1.0.a.b' })],
  ['lease', '/v1/model-key', true, (ql) => ql.modelKey({ v: 1 }), () => json(200, { v: 1, lease: 'AA', base: 'https://cdn.quranlab.ai/models/x/' })],
  ['events', '/v1/events', false, (ql) => {
    if (!ql.telemetry.reports().length) ql.state.set('telemetry.sealed', [{ report_id: 'r1', day: '2026-11-20', body: JSON.stringify({ day: '2026-11-20' }), attempts: 0, next: 0 }]);
    return ql.flush();
  }, () => json(202, { ok: true })],
  ['issues', '/v1/issues', false, (ql) => {
    if (!ql.errors._load().queue.length) assert.equal(ql.errors.occur({ stage: 'lease', reason: 'http', code: 'download_failed', http_status: 503 }), true);
    return ql.flushErrors();
  }, () => json(202, { ok: true })],
];

for (const [name, route, four, call, good] of ROUTES) {
  test(`28.11 item 6, ${name}: a 429 with Retry-After: 90: no request of ${route} for 90 s, a new process 10 s later sends nothing for the remaining 80 s, then one; another host never asked`, async () => {
    let now = Date.now();
    const asked = [];
    let first = true;
    const fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname === route) {
        asked.push(u.host);
        if (first) { first = false; return json(429, { error: 'rate_limited' }, { 'retry-after': '90' }); }
        return good();
      }
      if (u.pathname === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400 });
      return json(404, { error: 'not_found' });
    };
    const state = memState();
    state.set('bucket', 7);
    // one process: its endpoint set and client, on the SDK's state (the frame's IndexedDB, Node's folder, a page's localStorage)
    const start = () => {
      const o = { key: KEY, bundleId: 'https://app.example', fetch, state, clock: () => now, trustedKeys: TRUSTED, autoSend: false, endpoints: new Endpoints({ headMs: 200, clock: () => now }) };
      const ql = four ? new QuranLab4({ ...o, site: 'https://app.example', keys }) : new QuranLab(o);
      if (four && name !== 'attest') { ql._token = { token: 'tok', exp: now / 1000 + 86400 }; ql.installCert = 'cert'; }
      return ql;
    };
    const one = start();
    await call(one).catch(() => {});
    assert.deepEqual(asked, [A], 'the 429');
    now += 10_000;
    const two = start(); // a new page load or process, 10 s later
    await call(two).catch(() => {});
    now += 20_000;
    await call(one).catch(() => {});
    now += 59_000; // 89 s after the 429
    await call(two).catch(() => {});
    assert.deepEqual(asked, [A], 'nothing sent on the route for 90 s, in the process or after a restart');
    now += 2_000;
    await call(two).catch(() => {});
    assert.deepEqual(asked, [A, A], 'after it: one request, to the same host');
    assert.ok(!asked.includes(B));
  });
}

for (const name of ['events', 'issues']) {
  test(`28.11 items 3 and 4, ${name}: a 429 without Retry-After (no hold): a new process 10 s later keeps the 300 s step back; the send point at 120 s sends nothing, the one after 300 s sends the same report`, async () => {
    let now = Date.UTC(2026, 10, 21, 12);
    const route = `/v1/${name}`;
    const bodies = [];
    let first = true;
    const fetch = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400 });
      if (u.pathname === route) {
        bodies.push(init.body);
        if (first) { first = false; return json(429, { error: 'rate_limited' }); }
        return json(202, { ok: true });
      }
      return json(404, { error: 'not_found' });
    };
    const state = memState();
    const start = () => new QuranLab({ key: KEY, bundleId: 'https://app.example', fetch, state, clock: () => now, autoSend: false, endpoints: new Endpoints({ headMs: 200, clock: () => now }) });
    const send = (ql) => (name === 'events' ? ql.flush() : ql.flushErrors());
    const one = start();
    if (name === 'events') state.set('telemetry.sealed', [{ report_id: 'r1', day: '2026-11-20', body: JSON.stringify({ day: '2026-11-20' }), attempts: 0, next: 0 }]);
    else assert.equal(one.errors.occur({ stage: 'lease', reason: 'http', code: 'download_failed', http_status: 503 }), true);
    await send(one).catch(() => {});
    assert.equal(bodies.length, 1, 'the 429');
    now += 10_000;
    const two = start(); // a new page load or process
    now += 110_000; // 120 s after the 429: past the report's own schedule, within the step back
    await send(two).catch(() => {});
    assert.equal(bodies.length, 1, 'the kept step back: nothing sent at 120 s');
    now += 181_000; // 301 s
    await send(two);
    assert.equal(bodies.length, 2, 'sent after 300 s');
    assert.equal(bodies[1], bodies[0], 'the same report, kept');
  });
}

test('28.11 item 6, uploads: a 429 with Retry-After: 90 on the start of an upload: a pipeline started 10 s later sends nothing for the remaining 80 s, then uploads; another host never asked', { skip: haveOpus ? false : 'dist/tajweedformer-opus.mjs is not built' }, async () => {
  let now = Date.now();
  const asked = [];
  let starts = 0;
  const raw = async (url, init = {}) => {
    const u = new URL(url);
    const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(now / 1000) + 604800, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) });
    if (u.host === 'r2.test') return new Response('', { status: 200 });
    asked.push(`${u.host}${u.pathname}`);
    if (u.pathname === '/v1/attest') return json(200, { token: 'tok', expires_in: 86400 });
    if (u.pathname === '/v1/uploads') return ++starts === 1 ? json(429, { error: 'rate_limited' }, { 'retry-after': '90' }) : json(201, urls(init.headers['x-qlab-id'], 1));
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return json(200, urls(m[1], Number(u.searchParams.get('from'))));
    return json(404, { error: 'not_found' });
  };
  const opus = await loadOpus();
  const state = memState(), storage = new MemoryStorage();
  // the page's pipeline as consent/index.js makes it: the platform client's fetch (its endpoint set, its state)
  const pipeline = async () => {
    const ql = new QuranLab({ key: KEY, bundleId: 'https://app.example', fetch: raw, state, clock: () => now, autoSend: false, endpoints: new Endpoints({ headMs: 200, clock: () => now }) });
    return createSharing({ api: ql.apiUrl, fetch: ql.fetch, tokenProvider: async () => ({ token: 't', attested: false }), storage,
      consentVersion: 'deck-1', contributor: 'c'.repeat(32), enabled: () => true, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
      opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, random: () => 0.5, clock: () => now, locks: null, lifecycle: { document: null, window: null }, log: () => {} });
  };
  const one = await pipeline();
  const t = await one.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact' } });
  const pcm = clipSeconds(48000, 3);
  for (let i = 0; i < pcm.length; i += 960) t.push(pcm.subarray(i, i + 960));
  await t.finish({ completed: true });
  await one.closeRecording();
  await one.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual(asked, [`${A}/v1/uploads`], 'the 429');
  await new Promise((r) => setTimeout(r, 10)); // the step back written to the queue's storage
  now += 10_000;
  const two = await pipeline(); // a new page load, 10 s later, on the same storage and state
  assert.equal(two.outbox.uploadsBack.row, 1, 'the step back was kept');
  await two.outbox.drain();
  now += 79_000; // 89 s after the 429
  await two.outbox.drain();
  // even a pass that ignores the recording's own schedule: the route is held on its host
  await two.outbox.drain({ ignoringBackoff: true });
  assert.deepEqual(asked, [`${A}/v1/uploads`], 'nothing sent for 90 s after a restart');
  now += 2_000;
  for (let i = 0; i < 10 && (await two.outbox.items())[0].status !== 'uploaded'; i++) await two.outbox.drain({ ignoringBackoff: true });
  assert.equal((await two.outbox.items())[0].status, 'uploaded');
  assert.equal(asked.filter((x) => x === `${A}/v1/uploads`).length, 2);
  assert.ok(!asked.some((x) => x.startsWith(B)), 'another host never asked');
});

test('28.11 item 3: holds and step backs read back at start; one more than 6 h ahead (a clock that moved back) reads as ending now', () => {
  let now = 1_000_000_000;
  const ep = new Endpoints({ headMs: 200, clock: () => now });
  let kept = null;
  ep.onHolds = (l) => { kept = l; };
  ep.hold('api', '/v1/events', A, 90, 429, 'rate_limited');
  ep.hold('api', '/v1/model-key', A, 60, 503, 'lease_unavailable');
  ep.hold('api', '/v1/config', A, null, 429); // a 429 without Retry-After holds nothing here
  assert.equal(kept.length, 2);
  now += 10_000;
  const again = new Endpoints({ headMs: 200, clock: () => now });
  again.restoreHolds([...kept, { k: `api /v1/register ${A}`, until: now + 7 * 3600_000, status: 429, error: null }, { k: 'x', until: now - 1, status: 429 }, { k: 'y', until: now + 1000, status: 500 }]);
  assert.deepEqual([again.held('api', '/v1/events', A).left, again.held('api', '/v1/model-key', A).left], [80, 50]);
  assert.equal(again.held('api', '/v1/register', A), null, 'more than 6 h ahead: ending now');
  assert.equal(again.holds.size, 2);
  // a step back: its row and time kept; read back as they were, or as now past 6 h
  const store = memState();
  const keep = { get: () => store.get('sb'), set: (v) => store.set('sb', v) };
  const sb = new StepBack(() => now, keep);
  sb.slowDown();
  sb.slowDown(120);
  assert.deepEqual(store.get('sb'), { row: 2, until: now + 300_000 });
  now += 100_000;
  const sb2 = new StepBack(() => now, keep);
  assert.deepEqual([sb2.row, sb2.left()], [2, 200_000]);
  assert.equal(sb2.slowDown(), 1200, 'the doubling goes on from the kept row');
  sb2.ok();
  assert.equal(store.get('sb'), null, 'an accepted answer ends the kept row');
  store.set('sb', { row: 3, until: now + 7 * 3600_000 });
  const sb3 = new StepBack(() => now, keep);
  assert.deepEqual([sb3.row, sb3.left()], [3, 0]);
});
