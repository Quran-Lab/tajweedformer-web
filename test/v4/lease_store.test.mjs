// The web lease across page loads (lease-store.js; owner, 11-18): a reload within the lease's 24 hours opens the model
// with no lease request, no challenge and no Turnstile; offline or with the server failing it opens from the kept
// lease and the files on the device; a refusal is never covered; the lease ends at its time and a set-back clock does
// not lengthen it; another site never reads the record; the keys stay non-extractable and no private key's bytes,
// lease or plaintext is stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fakeServer, parseCert } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, StateStore } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';
import { LeaseStore, recordName, certField, CLOCK_BACK_S } from '../../sdk4/frame/lease-store.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';

const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const H = 3_600_000;

/** One page load of the frame: a new Controller on the site's storage (kv, files), with the device clock `off` ms off. */
function page(srv, { kv, files, clock = { off: 0 }, site = srv.site, fetch = srv.fetch, timers = null } = {}) {
  return new Controller({ key: srv.apiKey, site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch, files, kv, engine,
    trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false,
    clock: () => Date.now() + clock.off, coreClock: { wall: () => Date.now() + clock.off, boot: () => performance.now() }, ...(timers ? { timers } : {}) });
}
async function load(srv, o) { const c = page(srv, o); await c.init(); return c; }
const sinceIndex = (srv, i, what) => srv.state.calls.slice(i).filter((x) => x === what).length;
const installKeysSeen = (srv) => new Set(srv.state.requests.filter((r) => r.path === 'POST /v1/model-key').map((r) => r.body.install_key));
// a server whose time follows the test's clock
const timed = (clock, extra = {}) => fakeServer({ cdnDir: dir, now: () => Math.floor((Date.now() + clock.off) / 1000), ...extra });

test('a reload within the lease\'s 24 hours: the model opens from the kept lease, with no lease request, challenge or Turnstile', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files });
  const ia = await a.openModel();
  assert.equal(ia.lease.kept, false);
  assert.equal(srv.state.leases, 1);
  assert.equal(srv.state.turnstilePasses, 1);
  await a.close();
  const mark = srv.state.calls.length;
  const b = await load(srv, { kv, files });
  assert.equal(b.kept, 'restored');
  const ib = await b.openModel();
  assert.equal(ib.lease.kept, true);
  assert.equal(ib.build, ia.build);
  assert.equal(ib.lease.exp, ia.lease.exp, 'the same lease');
  assert.equal(srv.state.leases, 1, 'no new lease');
  assert.equal(sinceIndex(srv, mark, 'POST /v1/model-key') + sinceIndex(srv, mark, 'GET /v1/attest/challenge'), 0);
  assert.equal(srv.state.turnstilePasses, 1, 'no new Turnstile pass');
  assert.equal(ib.bytesDownloaded, 0, 'the files are on the device');
  // a take runs on it
  const { takeId } = await b.start({ context: 'c16_l64', sampleRate: 16000, heads: ['log_probs'] });
  assert.ok(takeId > 0);
  const out = await b.push(new Float32Array(16000));
  const f = await b.finish();
  assert.ok(out.chunks.length + f.chunks.length >= 3);
  await b.close();
});

test('offline, or the server failing (503, 429): a reload opens from the kept lease and the files on the device; the stored config may have expired', { skip }, async () => {
  for (const fault of ['offline', 503, 429]) {
    const clock = { off: 0 };
    // a config that lives 2 minutes, so the reload's stored config has expired and only the kept lease names the build
    const srv = await timed(clock, { configPatch: (cfg) => ({ ...cfg, expires_at: Math.floor((Date.now() + clock.off) / 1000) + 120 }) });
    const kv = new MemoryKV(), files = new MemoryFiles();
    const a = await load(srv, { kv, files, clock });
    const ia = await a.openModel();
    await a.close();
    clock.off = 10 * 60_000;
    if (fault === 'offline') srv.state.offline = true; else srv.state.status5xx = fault;
    const b = await load(srv, { kv, files, clock });
    assert.equal(b.ql.config, null, `${fault}: no config`);
    const ib = await b.openModel();
    assert.equal(ib.build, ia.build, `${fault}: the kept lease's build`);
    assert.equal(ib.lease.kept, true);
    assert.equal(srv.state.leases, 1);
    await b.close();
  }
});

test('a refusal is never covered: a stop the API answers removes the files and the kept lease, for this page and the next', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files });
  await a.openModel();
  await a.close();
  srv.state.stopAll = 'key_revoked';
  const b = await load(srv, { kv, files });
  await assert.rejects(b.openModel(), (e) => e.code === 'invalid_key' && e.reason === 'key_revoked');
  await b.close();
  assert.equal((await files.list()).filter((x) => x.form === QLC.FORM_DEVICE).length, 0, 'the device forms are gone');
  const st = await StateStore.open(kv);
  const rec = st.get(await recordName(srv.site, srv.apiKey));
  assert.ok(!rec || !rec.lease, 'no lease kept');
  const c = await load(srv, { kv, files });
  assert.notEqual(c.kept, 'restored');
  await assert.rejects(c.openModel(), (e) => e.code === 'invalid_key');
  await c.close();
});

test('the lease ends at its time: a reload 25 hours later asks for a new lease, on the same install keys, with a new Turnstile pass', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await timed(clock);
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 25 * H;
  const b = await load(srv, { kv, files, clock });
  const ib = await b.openModel();
  assert.equal(ib.lease.kept, false, 'the kept lease had ended');
  assert.equal(srv.state.leases, 2);
  assert.equal(srv.state.turnstilePasses, 2, 'the certificate of the first pass had ended too');
  assert.equal(installKeysSeen(srv).size, 1, 'the install keys are kept');
  await b.close();
});

test('refresh_after: a reload after it opens at once from the kept lease and refreshes it in the background on the kept certificate', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await timed(clock);
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = 13 * H; // refresh_after is 12 hours after the lease
  const b = await load(srv, { kv, files, clock });
  const ib = await b.openModel();
  assert.equal(ib.lease.kept, true, 'the model opened on the kept lease, never waiting for the refresh');
  for (let i = 0; i < 1000 && srv.state.leases < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.state.leases, 2, 'refreshed in the background');
  assert.equal(srv.state.turnstilePasses, 1, 'no new Turnstile pass');
  assert.deepEqual(srv.state.leaseCerts, ['none', 'turnstile'], 'the refresh rode on the kept certificate of the first pass');
  await b.close();
  // the refreshed lease is the one kept now
  const c = await load(srv, { kv, files, clock });
  const ic = await c.openModel();
  assert.equal(ic.lease.kept, true);
  assert.ok(ic.lease.refreshAfter > ib.lease.refreshAfter);
  await c.close();
});

test('a device clock set back: by up to an hour the kept lease is used; by more it is asked for again, on the same keys and certificate', { skip }, async () => {
  const clock = { off: 0 };
  const srv = await timed(clock);
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files, clock });
  await a.openModel();
  await a.close();
  clock.off = -30 * 60_000;
  const b = await load(srv, { kv, files, clock });
  assert.equal(b.kept, 'restored');
  await b.openModel();
  await b.close();
  assert.equal(srv.state.leases, 1);
  clock.off = -(CLOCK_BACK_S * 1000 + 30 * 60_000);
  const c = await load(srv, { kv, files, clock });
  assert.equal(c.kept, 'clock');
  const ic = await c.openModel();
  assert.equal(ic.lease.kept, false);
  assert.equal(srv.state.leases, 2);
  assert.equal(srv.state.turnstilePasses, 1, 'the kept certificate still held');
  assert.equal(installKeysSeen(srv).size, 1);
  await c.close();
});

test('a clock set back to the same time before every page load gains at most an hour: the offset is the lease\'s own', { skip }, async () => {
  // the device clock frozen at T0 for every page; each page stays open 40 minutes (the Core's boot clock)
  const T0 = Date.now();
  const clk = { boot: 0 };
  const srv = await fakeServer({ cdnDir: dir, now: () => Math.floor(T0 / 1000) });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const frozen = async () => {
    clk.boot = 0;
    const c = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch: srv.fetch, files, kv, engine,
      trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, clock: () => T0, coreClock: { wall: () => T0, boot: () => performance.now() + clk.boot } });
    await c.init();
    return c;
  };
  const a = await frozen();
  await a.openModel();
  clk.boot = 40 * 60_000;
  await a.close();
  const b = await frozen();
  assert.equal(b.kept, 'restored', '40 minutes uncounted: within the hour');
  await b.openModel();
  clk.boot = 40 * 60_000;
  await b.close();
  const c = await frozen();
  assert.equal(c.kept, 'clock', '80 minutes uncounted: the kept lease is not used');
  await c.close();
});

test('the record is this site\'s and this key\'s only; a record moved to another site, or damaged, does not open', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files });
  await a.openModel();
  await a.close();
  const st = await StateStore.open(kv);
  const nameA = await recordName(srv.site, srv.apiKey);
  const rec = st.get(nameA);
  assert.ok(rec && rec.blob && rec.lease);
  // another site of the same storage (a browser without storage partitioning): a record of its own name, none here
  const other = 'https://other.example';
  const nameB = await recordName(other, srv.apiKey);
  assert.notEqual(nameA, nameB);
  const sb = new LeaseStore(st, { key: srv.apiKey, site: other });
  assert.equal((await sb.load()).why, 'none');
  // the record copied under the other site's name, its site field rewritten: the seal's associated data refuses it
  st.set(nameB, { ...rec, site: other });
  await st.flush();
  const moved = await sb.load();
  assert.equal(moved.why, 'sealed');
  assert.equal(moved.coreState, null);
  // a damaged blob: keys and certificate kept, no Core state, a new lease
  const bad = new Uint8Array(rec.blob); bad[bad.length - 1] ^= 1;
  st.set(nameA, { ...rec, blob: bad });
  await st.flush();
  const b = await load(srv, { kv, files });
  assert.equal(b.kept, 'sealed');
  await b.openModel();
  assert.equal(srv.state.leases, 2);
  assert.equal(installKeysSeen(srv).size, 1);
  await b.close();
});

test('what is stored: non-extractable keys, the Core state sealed, no private key bytes, no lease and no plaintext', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files });
  await a.openModel();
  const coreState = a.core.state;
  await a.close();
  const st = await StateStore.open(kv);
  const rec = st.get(await recordName(srv.site, srv.apiKey));
  for (const k of [rec.keys.agree, rec.keys.sign, rec.seal]) {
    assert.equal(k.extractable, false);
    await assert.rejects(webcrypto.subtle.exportKey(k.type === 'secret' ? 'raw' : 'pkcs8', k));
  }
  // the blob is the Core's state sealed again: not its bytes, and no lease magic (QLL1) in any stored value
  assert.notDeepEqual(new Uint8Array(rec.blob).subarray(0, 32), coreState.subarray(0, 32));
  const QLL1 = Buffer.from('514c4c31', 'hex');
  for (const [k, v] of kv.m) {
    const s = Buffer.from(JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('hex') : x)));
    assert.equal(s.indexOf(QLL1.toString('hex')), -1, `${k} holds no lease`);
  }
  assert.equal(parseCert(rec.cert).att, 'turnstile', 'the certificate of the pass is kept');
  assert.equal(certField(rec.cert, 'att'), 'turnstile');
  assert.equal(rec.lease.eph.length, 65);
});

test('two tabs of one site: both open on the kept lease; the record stays usable', { skip }, async () => {
  const srv = await fakeServer({ cdnDir: dir });
  const kv = new MemoryKV(), files = new MemoryFiles();
  const a = await load(srv, { kv, files });
  await a.openModel();
  await a.close();
  const [b, c] = await Promise.all([load(srv, { kv, files }), load(srv, { kv, files })]);
  const [ib, ic] = await Promise.all([b.openModel(), c.openModel()]);
  assert.ok(ib.lease.kept && ic.lease.kept);
  await Promise.all([b.close(), c.close()]);
  const d = await load(srv, { kv, files });
  assert.equal(d.kept, 'restored');
  await d.close();
  assert.equal(srv.state.leases, 1);
});

test('keys: restore refuses extractable keys and keys that are not the stored public ones', async () => {
  const k = await InstallKeys.create();
  const s = k.stored();
  assert.ok(await InstallKeys.restore(s));
  const other = await InstallKeys.create();
  assert.equal(await InstallKeys.restore({ ...s, spki: other.spki }), null, 'another agreement key');
  assert.equal(await InstallKeys.restore({ ...s, signSpki: other.signSpki }), null, 'another signing key');
  const ext = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  assert.equal(await InstallKeys.restore({ ...s, agree: ext.privateKey }), null, 'an extractable key');
});

test('keys older than 30 days start a new install', async () => {
  const st = await StateStore.open(new MemoryKV());
  let now = Date.now();
  const s = new LeaseStore(st, { key: 'qlk_v1_x', site: 'https://a.example', clock: () => now });
  const k = await InstallKeys.create();
  await s.save({ keys: k });
  const s2 = new LeaseStore(st, { key: 'qlk_v1_x', site: 'https://a.example', clock: () => now });
  assert.equal((await s2.load()).why, 'restored');
  now += 31 * 86_400_000;
  const s3 = new LeaseStore(st, { key: 'qlk_v1_x', site: 'https://a.example', clock: () => now });
  assert.equal((await s3.load()).why, 'old');
  assert.equal(st.get(await recordName('https://a.example', 'qlk_v1_x')), null);
});
