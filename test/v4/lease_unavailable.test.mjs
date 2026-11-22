// 503 lease_unavailable (qlab-api, 11-18: the lease route's answer when a dependency is down and no fallback is left,
// with Retry-After: 30): the server cannot answer now, never a refusal. The frame keeps every lease it holds and the
// model's files, hands nothing to the Core (the piece in force stays), asks again after Retry-After, and the page's
// call fails with download_failed (never invalid_key or server_rejected) only when there is no valid lease to open on.
// From 4.0.2 (PROTECTED_MODEL.md 18.4.7.3, contract dd76474) every retry waits a fresh draw in [600, 1800] s, with
// Retry-After as the floor only, and the row with its next attempt is kept across page loads and restarts (28.11 item
// 3): 4.0.1 asked again every 30 s (the Retry-After replaced the step) and forgot it all at a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, retryAfterS, leaseBackoffS } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const H = 3_600_000;

// timers the test runs by hand: the refresh's waits are read, and the one asked for is run
function handTimers() {
  const list = [];
  return {
    list,
    setTimeout(f, ms) { const t = { f, ms, done: false }; list.push(t); if (ms < 1000) { setTimeout(() => { if (!t.done) { t.done = true; f(); } }, 0); } return t; },
    clearTimeout(t) { if (t) t.done = true; },
    // the pending timer of exactly `ms` (the refresh), run now
    async fire(ms) { const t = list.find((x) => !x.done && x.ms === ms); assert.ok(t, `a timer of ${ms} ms is waiting (${list.filter((x) => !x.done).map((x) => x.ms)})`); t.done = true; await t.f(); },
    // the refresh waiting now (the pending timer of 50 s or more): its wait in seconds, then it runs (`pass(ms)`: that
    // time passes first, on the controller's clock)
    async next(pass = null) {
      const t = list.filter((x) => !x.done && x.ms >= 50_000).pop();
      assert.ok(t, `a refresh is waiting (${list.filter((x) => !x.done).map((x) => x.ms)})`);
      t.done = true;
      if (pass) pass(t.ms);
      await t.f();
      return Math.round(t.ms / 1000);
    },
  };
}

async function load(srv, { kv, files, clock, timers = null, random = null }) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(random ? { random } : {}),
    clock: () => Date.now() + clock.off, coreClock: { wall: () => Date.now() + clock.off, boot: () => performance.now() }, ...(timers ? { timers } : {}) });
  await c.init();
  return c;
}

test('Retry-After: seconds or an HTTP date, kept between 1 s and 6 h; lease_unavailable without a readable header is 30 s', () => {
  assert.equal(retryAfterS('30'), 30);
  assert.equal(retryAfterS(new Date(Date.now() + 120_000).toUTCString()) >= 119, true);
  assert.equal(retryAfterS('0'), 1);
  assert.equal(retryAfterS('999999'), 21600);
  assert.equal(retryAfterS(null, 'lease_unavailable'), 30);
  assert.equal(retryAfterS(null, 'unavailable'), null);
  assert.equal(retryAfterS('soon'), null);
});

test('18.4.7.3: every wait a fresh draw in [600, 1800] s; a Retry-After only as the floor', () => {
  assert.deepEqual([leaseBackoffS(null, () => 0), leaseBackoffS(null, () => 0.999999)], [600, 1800]);
  const seen = new Set(Array.from({ length: 50 }, () => leaseBackoffS(30)));
  assert.ok(seen.size > 10 && [...seen].every((w) => w >= 600 && w <= 1800), 'drawn afresh in [600, 1800], never 30');
  assert.equal(leaseBackoffS(3000), 3000, 'a Retry-After above the draw is the wait');
  assert.equal(leaseBackoffS(900, () => 0), 900);
  assert.equal(leaseBackoffS(900, () => 0.9), 1680);
  assert.equal(leaseBackoffS(99999), 21600, 'read as at most 6 hours');
});

test('a refresh answered 503 lease_unavailable (Retry-After: 30) in a row: every wait between 600 and 1800 s, never 30, not twice the same; the model stays open on its lease, nothing is refused; the row ends at a lease', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 13 * H; // past refresh_after (12 h), the lease valid to 24 h
  srv.state.leaseUnavailable = 3;
  const timers = handTimers();
  // the platform's random source, drawn at each failure
  const draws = [0.1, 0.5, 0.9];
  const b = await load(srv, { kv, files, clock, timers, random: () => draws.shift() ?? 0.3 });
  const info = await b.openModel();
  assert.equal(info.lease.kept, true, 'the model opened on the kept lease, never waiting for the refresh');
  // the refresh (due now) ran at once and got the 503; each next one waits its step
  for (let i = 0; i < 100 && (srv.state.unavailableAnswers || 0) < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.state.unavailableAnswers, 1);
  await new Promise((r) => setTimeout(r, 20));
  const waits = [];
  for (let k = 0; k < 3; k++) { waits.push(await timers.next((ms) => { clock.off += ms; })); await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(waits.every((w) => w >= 599 && w <= 1800) && new Set(waits).size === 3, JSON.stringify(waits));
  assert.deepEqual(waits.map((w) => Math.round(w / 10) * 10), [720, 1200, 1680], 'each its own draw (0.1, 0.5, 0.9)');
  assert.equal(srv.state.unavailableAnswers, 3);
  assert.equal(srv.state.leases, 2, 'the fourth ask got its lease');
  // the next refresh is the new lease's refresh_after, never the row's time (a refresh at once would be a fifth ask)
  assert.ok(b.lastRefreshWaitS > 3600, `the next refresh waits for refresh_after (${b.lastRefreshWaitS} s)`);
  // a valid lease: the model opens again with no request during the row
  const before = srv.state.requests.length;
  b.closeModel();
  await b.openModel();
  assert.equal(srv.state.requests.filter((r, i) => i >= before && r.path === 'POST /v1/model-key').length, 0);
  assert.equal(b.leaseRow.n, 0, 'the lease ended the row');
  assert.equal(b.ql.modelRefusal, null, 'never a refusal');
  assert.equal(b.ql.stopped, null);
  assert.ok((await files.list()).some((f) => f.form === QLC.FORM_DEVICE), 'the model\'s files stay');
  // (summed over the days: the waits move the clock about an hour, across UTC midnight when the test runs near 11:00Z)
  const failed = {};
  for (const d of Object.values(b.state.get('telemetry.days'))) for (const [k, n] of Object.entries((d.v4 && d.v4.lease_failed) || {})) failed[k] = (failed[k] || 0) + n;
  assert.deepEqual(failed, { offline: 3 }, 'counted as the server not answering, never as refused');
  await b.close();
});

test('18.4.7.3: a Retry-After: 3000 after the first failure makes the wait 3000 s', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 13 * H;
  const fetch = srv.fetch;
  let asked = 0;
  const wrapped = { ...srv, fetch: async (url, init) => (new URL(url).pathname === '/v1/model-key' && ++asked === 1
    ? new Response(JSON.stringify({ error: 'lease_unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '3000' } }) : fetch(url, init)) };
  const timers = handTimers();
  const b = await load(wrapped, { kv, files, clock, timers });
  await b.openModel();
  for (let i = 0; i < 100 && asked < 1; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(Math.abs((await timers.next()) - 3000) <= 1);
  await b.close();
});

test('18.4.7.3: during the row a call with no lease asks at once and fails with the code it failed with before', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  srv.state.leaseUnavailable = 2;
  const c = await load(srv, { kv: new MemoryKV(), files: new MemoryFiles(), clock });
  const fail = (e) => e.code === 'download_failed' && e.http_status === 503 && e.error_code === 'lease_unavailable';
  await assert.rejects(c.openModel(), fail);
  assert.equal(c.leaseRow.n, 1);
  // within the answer's Retry-After (30 s) the one API host is held (28.11 item 2): the call fails at once, as before, asking it nothing
  await assert.rejects(c.openModel(), fail, 'fails at once');
  assert.equal(srv.state.unavailableAnswers, 1);
  assert.equal(c.leaseRow.n, 1, 'an answer of the hold made no request: not an attempt');
  // past it, and well before the row's next attempt (600 s or more): the call asks at once
  clock.off += 31_000;
  await assert.rejects(c.openModel(), fail, 'asked again at once, not after the row\'s wait');
  assert.equal(srv.state.unavailableAnswers, 2);
  assert.equal(c.leaseRow.n, 2, 'its failures count in the row');
  clock.off += 31_000;
  assert.equal((await c.openModel()).build, srv.build);
  assert.equal(c.leaseRow.n, 0);
  await c.close();
});

test('18.4.7.3, 28.11 item 3: a restart while a retry waits sends nothing before the kept time, then asks once', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 13 * H; // past refresh_after, the lease valid
  srv.state.leaseUnavailable = 5;
  const b = await load(srv, { kv, files, clock, timers: handTimers(), random: () => 0.5 });
  await b.openModel();
  for (let i = 0; i < 100 && (srv.state.unavailableAnswers || 0) < 1; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.state.unavailableAnswers, 1);
  const at = b.leaseRow.at;
  assert.ok(Math.abs((at - (Date.now() + clock.off)) / 1000 - 1200) <= 2, 'the row waits its draw (1200 s)');
  await b.close();
  // a new page load (or process) 10 s later, on the same storage: the model opens on its lease, no lease request
  clock.off += 10_000;
  const asked = () => srv.state.requests.filter((r) => r.path === 'POST /v1/model-key').length;
  const before = asked();
  const timers = handTimers();
  const c = await load(srv, { kv, files, clock, timers });
  assert.deepEqual([c.leaseRow.n, c.leaseRow.at], [1, at], 'the row and its next attempt were kept');
  assert.equal((await c.openModel()).lease.kept, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(asked(), before, 'nothing sent at the restart');
  assert.ok(Math.abs(c.lastRefreshWaitS - 1190) <= 2, `the refresh waits the kept time (${c.lastRefreshWaitS} s)`);
  // the kept time comes: one request
  await timers.next((ms) => { clock.off += ms; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked(), before + 1);
  await c.close();
  // a kept time more than 6 h ahead (a clock that moved back) is read as now
  const kv2 = new MemoryKV(new Map([['lease.row', { n: 2, at: Date.now() + clock.off + 30 * H }]]));
  const d = await load(srv, { kv: kv2, files: new MemoryFiles(), clock });
  assert.ok(Math.abs(d.leaseRow.at - (Date.now() + clock.off)) < 5000);
  await d.close();
});

test('no lease to open on and the route answers 503 lease_unavailable: download_failed naming it, never a refusal; the next call leases', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  srv.state.leaseUnavailable = 1;
  const c = await load(srv, { kv: new MemoryKV(), files: new MemoryFiles(), clock });
  await assert.rejects(c.openModel(), (e) => e.code === 'download_failed' && e.http_status === 503 && e.error_code === 'lease_unavailable' && e.retryAfter === 30 && e.why === 'lease_unavailable');
  assert.equal(c.ql.modelRefusal, null);
  clock.off += 31_000; // (4.0.2: the next call after the answer's Retry-After; within it the host is held, 28.11 item 2)
  const info = await c.openModel();
  assert.equal(info.build, srv.build);
  assert.equal(srv.state.leases, 1);
  await c.close();
});
