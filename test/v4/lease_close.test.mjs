// SDK 4.0.2: a close() (or a page closed) while a lease attempt is in flight. The lease the Core accepts is saved at
// once, before anything else waits (Controller._tookLease), and close() waits for an attempt in flight and that save,
// at most CLOSE_WAIT_MS, before it saves and destroys the Core. An attempt close() gives up on is no failed attempt:
// nothing told to the Core, no row of failures, no backoff. Before (4.0.1 and 4.0.2 up to b886f11) close() saved and
// destroyed at once: a refreshed lease answered a moment later was lost, a renewal in the grace lost could leave the next
// start offline without a lease, and the late end of the given-up attempt wrote a row of failures with its backoff.
// Through the real Core, against the fake API and CDN (test keys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller, CLOSE_WAIT_MS } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const H = 3_600_000;

async function load(srv, { kv, files, clock, attemptWaitMs = null }) {
  const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, ...(attemptWaitMs ? { attemptWaitMs } : {}),
    clock: () => Date.now() + clock.off, coreClock: { wall: () => Date.now() + clock.off, boot: () => performance.now() } });
  await c.init();
  return c;
}
const until = async (f, ms = 5000) => { for (let t = 0; t < ms && !(await f()); t += 10) await new Promise((r) => setTimeout(r, 10)); return f(); };
const leaseAsks = (srv) => srv.state.requests.filter((r) => r.path === 'POST /v1/model-key').length;

// a first page load: the model installed and its lease kept (to 24 h, refresh_after at 12 h)
async function installed() {
  const clock = { off: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  const first = a.leaseInfo.refreshAfter;
  await a.close();
  return { srv, kv, files, clock, first };
}
// the lease route's answer waits until `release()`
function hold(srv) { let release; srv.state.hold = new Promise((r) => { release = r; }); return () => { release(); }; }

test('close() during a refresh whose answer comes a moment later: the refreshed lease is kept, and opens at the next start offline', { skip }, async () => {
  const { srv, kv, files, clock, first } = await installed();
  clock.off = 13 * H; // past refresh_after: the refresh starts at the open
  const release = hold(srv);
  const asked = leaseAsks(srv);
  const b = await load(srv, { kv, files, clock });
  await b.openModel();
  assert.ok(await until(() => leaseAsks(srv) > asked), 'the refresh asked');
  const closing = b.close();
  setTimeout(release, 50);
  await closing;
  srv.state.hold = null;
  assert.equal(srv.state.leases, 2, 'the server gave the refreshed lease');
  srv.state.offline = true;
  const c = await load(srv, { kv, files, clock });
  const info = await c.openModel();
  assert.equal(info.lease.kept, true);
  assert.ok(info.lease.refreshAfter > first, 'the kept lease is the refreshed one');
  await c.close();
});

test('close() during a renewal in the grace (the lease past its exp): the new lease is kept, and the next start offline after the old one\'s grace opens on it', { skip }, async () => {
  const { srv, kv, files, clock, first } = await installed();
  clock.off = 25 * H; // past the lease's exp (24 h), in its grace
  const release = hold(srv);
  const b = await load(srv, { kv, files, clock, attemptWaitMs: 200 });
  const ib = await b.openModel(); // no answer in 200 ms: opened in the grace, the attempt goes on
  assert.ok(ib.lease.graceUntil > 0, 'opened in the grace');
  const closing = b.close();
  setTimeout(release, 50);
  await closing;
  srv.state.hold = null;
  assert.equal(srv.state.leases, 2);
  // offline 48.5 h in: the old lease's grace ended at 48 h; the renewed one (from 25 h) holds to 49 h
  clock.off = 48.5 * H;
  srv.state.offline = true;
  const c = await load(srv, { kv, files, clock });
  const info = await c.openModel();
  assert.ok(info.lease.refreshAfter > first, 'the renewed lease');
  assert.ok(!(info.lease.graceUntil > 0), 'not in a grace');
  await c.close();
});

test('a page closed (no close(), unload) right after the Core accepted the refreshed lease: what is on the device keeps it', { skip }, async () => {
  const { srv, kv, files, clock, first } = await installed();
  clock.off = 13 * H;
  const release = hold(srv);
  const b = await load(srv, { kv, files, clock });
  // the device's storage as the page leaves it: taken the moment the Core accepted the lease and its save ended,
  // before anything else of the attempt ran
  let disk = null;
  const answer = b._leaseAnswer.bind(b);
  b._leaseAnswer = async (...args) => {
    const v = await answer(...args);
    if (v && v.got && !disk) { await b._leaseSaving; disk = new Map([...kv.m].map(([k, x]) => [k, structuredClone(x)])); }
    return v;
  };
  await b.openModel();
  release();
  assert.ok(await until(() => disk !== null), 'the Core accepted the refreshed lease');
  srv.state.hold = null;
  srv.state.offline = true;
  const c = await load(srv, { kv: new MemoryKV(disk), files, clock });
  const info = await c.openModel();
  assert.ok(info.lease.refreshAfter > first, 'the refreshed lease was on the device already');
  await c.close();
  srv.state.offline = false;
  await b.close();
});

test('an attempt close() gives up on (no answer within its bound) is no failed attempt: no row of failures, no backoff; the next start asks at once', { skip, timeout: 60_000 }, async () => {
  const { srv, kv, files, clock } = await installed();
  clock.off = 13 * H;
  const release = hold(srv);
  const asked = leaseAsks(srv);
  const b = await load(srv, { kv, files, clock });
  await b.openModel();
  assert.ok(await until(() => leaseAsks(srv) > asked));
  const t0 = Date.now();
  await b.close();
  assert.ok(Date.now() - t0 < CLOSE_WAIT_MS + 1500, `close() ends within its bound (${Date.now() - t0} ms)`);
  // the answer comes after the close: the given-up attempt ends (the Core is gone), and must count as nothing
  release();
  await until(() => srv.state.leases >= 2);
  await new Promise((r) => setTimeout(r, 200));
  srv.state.hold = null;
  assert.equal(kv.m.get('lease.row') === undefined || kv.m.get('lease.row') === null, true, `no row of failures kept (${JSON.stringify(kv.m.get('lease.row'))})`);
  const before = leaseAsks(srv);
  const c = await load(srv, { kv, files, clock });
  assert.deepEqual(c.leaseRow, { n: 0, at: 0 });
  await c.openModel();
  // (asked at once: a row of failures kept would have made it wait 600 s or more)
  assert.ok(await until(() => leaseAsks(srv) > before, 3000), 'the next start asks at once (its lease is past refresh_after)');
  await c.close();
});

// ---------------------------------------------------------------- two frames of one origin (two tabs), 4.0.2
test('two tabs of one origin: an old tab\'s write of its older lease (in its grace) after the other tab renewed is refused; an offline start opens the newer lease', { skip }, async () => {
  const { srv, kv, files, clock, first } = await installed();
  clock.off = 25 * H; // the lease past its exp (24 h), in its grace
  // tab A: no network, its renewal gets no answer: it opens in the grace, on the old lease
  const offline = { ...srv, fetch: async () => { throw new TypeError('fetch failed'); } };
  const a = await load(offline, { kv, files, clock, attemptWaitMs: 200 });
  assert.ok((await a.openModel()).lease.graceUntil > 0, 'tab A in the grace');
  // tab B, same origin and storage, online, after tab A's retry wait (its row of failures is the origin's): renews (a
  // newer write after an older one: taken)
  clock.off += 1801_000;
  const b = await load(srv, { kv, files, clock });
  const ib = await b.openModel();
  assert.ok(ib.lease.refreshAfter > first, 'tab B renewed');
  assert.ok(Number.isFinite(b.leaseInfo.iat) && b.leaseInfo.iat > 0, 'the issue time read from the lease');
  assert.equal(b.store.refused, false, 'the newer lease written');
  // tab A saves again (a step of its own: the page hidden, a take): its record holds the older lease
  await a._persist();
  assert.equal(a.store.refused, true, 'tab A\'s older lease is not written over the newer one');
  // offline, after the old lease's grace (48 h), within the renewed one (to 49 h)
  clock.off = 48.5 * H;
  const c = await load(offline, { kv, files, clock });
  const ic = await c.openModel();
  assert.ok(ic.lease.refreshAfter > first, 'the offline start opens the renewed lease');
  await c.close();
  await a.close();
  await b.close();
});

test('the lease record\'s atomic write (4.0.2): never an older issue time over a newer one; a newer one, or a record of 4.0.1 without one, is written (IndexedDB in one transaction, memory)', async () => {
  const { leaseNotOlder } = await import('../../sdk4/frame/lease-store.js');
  const { IndexedDbKV, StateStore } = await import('../../sdk4/frame/stores.js');
  assert.deepEqual([leaseNotOlder(null, null), leaseNotOlder({ lease: { exp: 5 } }, { iat: 1 }), leaseNotOlder({ lease: { iat: 100 } }, { iat: 100 }),
    leaseNotOlder({ lease: { iat: 100 } }, { iat: 150 }), leaseNotOlder({ lease: { iat: 100 } }, { iat: 50 }), leaseNotOlder({ lease: { iat: 100 } }, null)],
  [true, true, true, true, false, false]);
  // IndexedDB's one readwrite transaction: get, decide, put (a stand-in database with IndexedDB's request events)
  const map = new Map([['r', { lease: { iat: 100 } }]]);
  const db = { transaction() {
    const t = {};
    t.objectStore = () => ({ get(k) { const r = {}; queueMicrotask(() => { r.result = map.get(k); r.onsuccess(); queueMicrotask(() => t.oncomplete()); }); return r; }, put(v, k) { map.set(k, v); } });
    return t;
  } };
  const idb = new IndexedDbKV(db);
  const decide = (n) => (stored) => leaseNotOlder(stored, n.lease);
  assert.equal(await idb.writeIf('r', { lease: { iat: 50 } }, decide({ lease: { iat: 50 } })), false);
  assert.equal(map.get('r').lease.iat, 100, 'the older one not written');
  assert.equal(await idb.writeIf('r', { lease: { iat: 150 } }, decide({ lease: { iat: 150 } })), true);
  assert.equal(map.get('r').lease.iat, 150);
  // through the frame's state view on memory: written only when taken, and then held by the view too
  const kv = new MemoryKV(new Map([['r', { lease: { iat: 100 } }]]));
  const st = await StateStore.open(kv);
  assert.equal(await st.writeIf('r', { lease: { iat: 90 } }, decide({ lease: { iat: 90 } })), false);
  assert.deepEqual([kv.m.get('r').lease.iat, st.get('r').lease.iat], [100, 100]);
  assert.equal(await st.writeIf('r', { lease: { iat: 120 } }, decide({ lease: { iat: 120 } })), true);
  assert.deepEqual([kv.m.get('r').lease.iat, st.get('r').lease.iat], [120, 120]);
});

// ---------------------------------------------------------------- stops and refusals are always kept (4.0.2)
test('a stop the API answers (key revoked) clears the stored lease whatever its issue time: an offline restart does not open the model', { skip }, async () => {
  const { srv, kv, files, clock } = await installed();
  const { StateStore } = await import('../../sdk4/frame/stores.js');
  const { recordName } = await import('../../sdk4/frame/lease-store.js');
  const name = await recordName(srv.site, srv.apiKey);
  assert.ok(Number.isFinite((await StateStore.open(kv)).get(name).lease.iat), 'a stored lease with its issue time');
  srv.state.stopAll = 'key_revoked';
  const b = await load(srv, { kv, files, clock });
  await assert.rejects(b.openModel(), (e) => e.code === 'invalid_key');
  await b.close(); // its own save after the stop: no lease to write, and the stop's clear stands
  const rec = (await StateStore.open(kv)).get(name);
  assert.ok(!rec || !rec.lease, 'no lease kept');
  srv.state.offline = true;
  const c = await load(srv, { kv, files, clock });
  assert.notEqual(c.kept, 'restored');
  await assert.rejects(c.openModel(), (e) => e.code === 'invalid_key' || e.code === 'needs_connection', 'the model stays stopped offline');
  await c.close();
});

test('a refused renewal (the lease past its exp, the server refuses) is kept with the same lease: an offline restart gets no grace', { skip }, async () => {
  const { srv, kv, files, clock } = await installed();
  clock.off = 25 * H;
  srv.state.plan = ['refuse'];
  const b = await load(srv, { kv, files, clock });
  await assert.rejects(b.openModel(), (e) => e.code === 'server_rejected');
  await b.close();
  srv.state.offline = true;
  clock.off = 26 * H;
  const c = await load(srv, { kv, files, clock });
  await assert.rejects(c.openModel(), (e) => ['server_rejected', 'needs_connection', 'invalid_key'].includes(e.code), 'no grace after a refusal');
  await c.close();
});

test('a save queued before a stop\'s clear never puts the lease back after it (LeaseStore: the clear waits for the saves before it)', async () => {
  const { LeaseStore } = await import('../../sdk4/frame/lease-store.js');
  const { StateStore } = await import('../../sdk4/frame/stores.js');
  const { InstallKeys } = await import('../../sdk4/frame/keys.js');
  const kv = new MemoryKV();
  const st = await StateStore.open(kv);
  const store = new LeaseStore(st, { key: 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa', site: 'https://app.example' });
  const keys = await InstallKeys.create();
  const saving = store.save({ keys, coreState: new Uint8Array(32), lease: { iat: 100, exp: 200 } }); // still sealing
  const clearing = store.clear(); // the stop, at once
  await Promise.all([saving, clearing]);
  const rec = (await StateStore.open(kv)).get(store.name);
  assert.ok(!rec, `the stop's clear is the last word (${rec ? 'a record with a lease came back' : 'none'})`);
});

test('a lease answer to a request sent before a stop (the key revoked on another route while it was in flight) is never handed to the Core: no lease stored, and an offline restart stays stopped', { skip }, async () => {
  const { srv, kv, files, clock } = await installed();
  const { StateStore } = await import('../../sdk4/frame/stores.js');
  const { recordName } = await import('../../sdk4/frame/lease-store.js');
  clock.off = 13 * H; // past refresh_after: the refresh starts at the open
  const release = hold(srv);
  const asked = leaseAsks(srv);
  const b = await load(srv, { kv, files, clock });
  await b.openModel();
  assert.ok(await until(() => leaseAsks(srv) > asked), 'the refresh is in flight');
  // the key is revoked: another route answers the stop (the config here), the model is stopped and its lease cleared
  srv.state.stopAll = 'key_revoked';
  await b.ql.refreshConfig().catch(() => {});
  assert.ok(await until(() => b.leaseInfo === null), 'the stop cleared the lease');
  const leases = srv.state.leases;
  release(); // the lease route answers the request sent before the stop: a verified lease
  assert.ok(await until(() => srv.state.leases > leases && !b._attempt, 5000), 'the answer came and the attempt ended');
  srv.state.hold = null;
  assert.equal(b.leaseInfo, null, 'not taken');
  await b.close();
  const rec = (await StateStore.open(kv)).get(await recordName(srv.site, srv.apiKey));
  assert.ok(!rec || !rec.lease, 'no lease stored');
  srv.state.offline = true;
  const c = await load(srv, { kv, files, clock });
  assert.notEqual(c.kept, 'restored');
  await assert.rejects(c.openModel(), (e) => e.code === 'invalid_key' || e.code === 'needs_connection', 'stays stopped');
  await c.close();
});
