// 503 lease_unavailable (qlab-api, 11-18: the lease route's answer when a dependency is down and no fallback is left,
// with Retry-After: 30): the server cannot answer now, never a refusal. The frame keeps every lease it holds and the
// model's files, hands nothing to the Core (the piece in force stays), asks again after Retry-After, and the page's
// call fails with download_failed (never invalid_key or server_rejected) only when there is no valid lease to open on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, retryAfterS } from '../../sdk4/frame/controller.js';
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
  };
}

async function load(srv, { kv, files, clock, timers = null }) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false,
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

test('a refresh answered 503 lease_unavailable: the model stays open on its lease, nothing is refused, the refresh asks again after 30 s', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 13 * H; // past refresh_after (12 h), the lease valid to 24 h
  srv.state.leaseUnavailable = 2;
  const timers = handTimers();
  const b = await load(srv, { kv, files, clock, timers });
  const info = await b.openModel();
  assert.equal(info.lease.kept, true, 'the model opened on the kept lease, never waiting for the refresh');
  // the refresh (due now) ran at once and got the 503: the next one waits Retry-After
  for (let i = 0; i < 100 && (srv.state.unavailableAnswers || 0) < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.state.unavailableAnswers, 1);
  await new Promise((r) => setTimeout(r, 20));
  await timers.fire(30_000);
  assert.equal(srv.state.unavailableAnswers, 2, 'asked again after 30 s');
  await new Promise((r) => setTimeout(r, 20));
  await timers.fire(30_000);
  assert.equal(srv.state.leases, 2, 'the third ask got its lease');
  assert.equal(b.ql.modelRefusal, null, 'never a refusal');
  assert.equal(b.ql.stopped, null);
  assert.ok((await files.list()).some((f) => f.form === QLC.FORM_DEVICE), 'the model\'s files stay');
  const d = Object.values(b.state.get('telemetry.days'))[0];
  assert.deepEqual(d.v4.lease_failed, { offline: 2 }, 'counted as the server not answering, never as refused');
  // a take still runs on the open model
  await b.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] });
  await b.push(new Float32Array(16000));
  await b.finish();
  await b.close();
});

test('no lease to open on and the route answers 503 lease_unavailable: download_failed naming it, never a refusal; the next call leases', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  srv.state.leaseUnavailable = 1;
  const c = await load(srv, { kv: new MemoryKV(), files: new MemoryFiles(), clock: { off: 0 } });
  await assert.rejects(c.openModel(), (e) => e.code === 'download_failed' && e.http_status === 503 && e.error_code === 'lease_unavailable' && e.retryAfter === 30 && e.why === 'lease_unavailable');
  assert.equal(c.ql.modelRefusal, null);
  const info = await c.openModel();
  assert.equal(info.build, srv.build);
  assert.equal(srv.state.leases, 1);
  await c.close();
});
