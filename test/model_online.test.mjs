// SDK 3.1.0 (SPEC section 15): a model comes only from Quran Lab's server, through the Client.
//
//   15.1  no public way to hand the SDK a model (the surface is in test/api_surface.test.mjs; here: what the
//         package's exports map lets a Node program import);
//   15.2  the install record: the Client opens only a build it downloaded itself;
//   15.3  a Client the server has refused does not run the model: every case of the shared vector
//         test/vectors30/model_gate.json, with a model from a real download on the device and without one; a
//         refusal of a model request is not ended by the API; the web's origin check; a token not renewed;
//   15.4  a model request carries the install's token and the key: the exact headers, the renewal.
//
// A "device" is three things a test keeps together: the state store, the delivery cache and the device key
// store. A relaunch is a new Client on the same three; another device has another key store. The server is the
// stub of test/helpers/model3.mjs (Quran Lab's API and CDN as one fetch); the engine is the fake host.
//
// Each test here fails on the released 3.0.2 code (run there from a scratch copy; the helpers load without the
// modules 3.1.0 added).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { TajweedError, TajweedClient, TajweedModel } from '../web/index.js';
import * as errorsModule from '../web/api/errors.js';
import { createClient, resetClientForTests } from '../web/api/client.js';
import { memoryState } from '../web/platform/storage.js';
import { memoryStore } from '../web/tajweed/delivery.js';
import { MemoryStorage } from '../web/sharing/outbox.js';
import { SDK_VERSION } from '../web/platform/client.js';
import { build3, stubPlatform, seamsFor, KEY, ORIGIN } from './helpers/model3.mjs';

// the modules 3.1.0 added (absent on the released code, where every test below must fail by its own assertion)
const install = await import('../web/tajweed/install.js').catch(() => null);
const platform = await import('../web/platform/client.js');
const memoryDeviceKey = install ? install.memoryDeviceKey : () => undefined;
const INSTALL_PREFIX = install ? install.INSTALL_PREFIX : 'install/';

const gate = JSON.parse(readFileSync(new URL('./vectors30/model_gate.json', import.meta.url), 'utf8'));
const build = await build3();
const TOKEN = 'qlt_v1.test.sig';
const code = (c) => (e) => e instanceof TajweedError && e.code === c;
const dec = new TextDecoder();

// a device: state, cache, key store, sharing queue; `events` is what the cache was asked to do, in order with the
// CDN requests
function device() {
  const events = [];
  const inner = memoryStore();
  const store = {
    kind: 'memory', inner,
    get: (k) => inner.get(k),
    async put(k, v) { events.push(`put ${k}`); return inner.put(k, v); },
    async delete(k) { events.push(`delete ${k}`); return inner.delete(k); },
    keys: (p) => inner.keys(p),
  };
  return { state: memoryState(), store, installKey: memoryDeviceKey(), sharing: new MemoryStorage(), events };
}

// every entry of the device's model cache (files, ranges, stored manifests, install records)
const modelKeys = async (dev) => (await dev.store.inner.keys('')).filter((k) => /^(sha256|part|manifest|install)\//.test(k)).sort();
// what a stop must not remove: a sharing state and an unsent recording (with the remembered refusal and the device key)
const QUEUED = ['f'.repeat(32), 'seg-00001.opus'];
function plantSharing(dev) {
  dev.state.set('sharing.v1', { v: 1, consent: 'declined', asks: 1, lastAskSession: 1, sessions: 2, thanked: false, decidedAt: '2026-11-12', consentVersion: null, guardian: false });
  return dev.sharing.write(...QUEUED, new Uint8Array([79, 103, 103, 83]));
}
async function keptBesideTheStop(dev) {
  assert.ok(dev.state.get(platform.MODEL_REFUSED_KEY), 'the remembered refusal');
  assert.ok(await dev.installKey.key({ create: false }), 'the device key');
  assert.deepEqual([dev.state.get('sharing.v1').consent, dev.state.get('sharing.v1').asks], ['declined', 1], 'the sharing state');
  assert.ok(await dev.sharing.read(...QUEUED), 'the unsent recording');
}

// a launch of the app on a device against a server; the fetch notes every CDN request among the device's events
async function launch(dev, api, extra = {}) {
  resetClientForTests();
  const fetch = async (url, init = {}) => {
    if (new URL(url).host === 'cdn.test') dev.events.push(`cdn ${decodeURIComponent(new URL(url).pathname.split('/sdk/v4.0/')[1] || '')}`);
    if (dev.traceFetch) dev.events.push(`fetch ${new URL(url).host} ${new URL(url).pathname}`);
    return (extra.fetch || api.fetch)(url, init);
  };
  return createClient({ key: KEY, appVersion: '1.0' }, seamsFor(api, { state: dev.state, store: dev.store, installKey: dev.installKey, sharingStorage: dev.sharing, ...extra, fetch }));
}

const cdn = (api) => api.log.filter((x) => x.host === 'cdn');
const cdnFiles = (api) => cdn(api).map((x) => x.path).filter((p) => p !== 'manifest.json');
const record = async (dev, b = build) => { const raw = await dev.store.inner.get(INSTALL_PREFIX + b.build); return raw ? JSON.parse(dec.decode(raw)) : null; };

// a real download on a device, the app closed afterwards
async function realDownload(dev, api) {
  const client = await launch(dev, api);
  const model = await client.model();
  assert.equal(model.build, api.state.build.build);
  await client.close();
}

// the cache of one device copied into another's, as files carried in an app or from another device: every entry
// a real download left (the files, the stored manifest), with or without the install records
async function copyCache(from, to, { records = false } = {}) {
  let n = 0;
  for (const k of await from.store.inner.keys('')) {
    if (!records && k.startsWith(INSTALL_PREFIX)) continue;
    await to.store.inner.put(k, (await from.store.inner.get(k)).slice());
    n++;
  }
  // what the Client remembers of its last start (where the model is), as a copied app folder would carry it
  for (const k of ['model.last', 'config']) to.state.set(k, from.state.get(k));
  return n;
}

// the files of the download profile a first start asks the CDN for (everything but the manifest)
async function profileFiles() {
  const api = await stubPlatform({ build });
  await realDownload(device(), api);
  return [...new Set(cdnFiles(api))].sort();
}
const PROFILE = await profileFiles();

// ---------------------------------------------------------------------------------------------- 15.2

test('15.2 a real download writes the record before the first request, then `installed`; a relaunch opens with no request for a file', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  assert.ok(PROFILE.length >= 4, 'the profile has files');
  // the record is written before the first byte of the first file is asked for (before the manifest too)
  const firstPut = dev.events.findIndex((e) => e === `put ${INSTALL_PREFIX}${build.build}`);
  const firstCdn = dev.events.findIndex((e) => e.startsWith('cdn '));
  assert.ok(firstPut >= 0 && firstPut < firstCdn, `the record's write (${firstPut}) comes before the first model request (${firstCdn})`);
  const rec = await record(dev);
  assert.deepEqual([rec.v, rec.build, rec.state, /^[0-9a-f]{64}$/.test(rec.mac)], [1, build.build, 'installed', true]);
  assert.equal(dev.events.filter((e) => e === `put ${INSTALL_PREFIX}${build.build}`).length, 2, 'downloading, then installed');
  // the record is never a file the manifest lists
  assert.equal(build.manifest.files.some((f) => f.path.startsWith(INSTALL_PREFIX)), false);
  // a relaunch on the same device: the model opens with no request for a file
  api.log.length = 0;
  const client = await launch(dev, api);
  const model = await client.model();
  assert.equal(model.build, build.build);
  assert.deepEqual(cdnFiles(api), [], 'no file is asked for');
  // and offline after a real download keeps working
  await client.close();
  api.state.offline = true;
  const off = await launch(dev, api);
  assert.equal((await off.model()).build, build.build);
  await off.close();
});

test('15.2 a storage filled in advance, exactly as a real download leaves it, is not opened: it is deleted and the build is downloaded', async () => {
  const src = device(), api = await stubPlatform({ build });
  await realDownload(src, api);
  // another device whose storage was filled before the Client ran (an app that carries the model)
  const dev = device();
  const copied = await copyCache(src, dev);
  assert.ok(copied >= PROFILE.length);
  const carried = (await dev.store.inner.keys('sha256/')).length;
  api.log.length = 0;
  const client = await launch(dev, api);
  const model = await client.model();
  assert.equal(model.build, build.build);
  assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE, 'every file of the profile was downloaded again');
  assert.equal(dev.events.filter((e) => e.startsWith('delete sha256/')).length, carried, 'every carried file was deleted');
  assert.ok(dev.events.findIndex((e) => e.startsWith('delete sha256/')) < dev.events.findIndex((e) => e.startsWith('cdn ')), 'deleted before anything was asked for');
  assert.equal((await record(dev)).state, 'installed');
  await client.close();
});

test('15.2 the update from 3.0.x: a model without a record is downloaded once more; without a connection at that launch the call is needs_connection', async () => {
  const old = device(), api = await stubPlatform({ build });
  await realDownload(old, api);
  // what 3.0.2 left on a device: the files, the stored manifest, the state; no record
  const dev = device();
  dev.installKey = old.installKey; // the same device: only the record is missing
  await copyCache(old, dev);
  api.state.offline = true;
  let client = await launch(dev, api);
  await assert.rejects(client.model(), code('needs_connection'));
  await client.close();
  api.state.offline = false;
  api.log.length = 0;
  client = await launch(dev, api);
  assert.equal((await client.model()).build, build.build);
  assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE, 'downloaded once more');
  await client.close();
  // and only once: the next launch asks for no file
  api.log.length = 0;
  client = await launch(dev, api);
  await client.model();
  assert.deepEqual(cdnFiles(api), []);
  await client.close();
});

test('15.2 a record made with another device key, and a record of another build, are not valid', async () => {
  const src = device(), api = await stubPlatform({ build });
  await realDownload(src, api);
  // the whole cache of another device, its record included
  const dev = device();
  await copyCache(src, dev, { records: true });
  assert.equal((await record(dev)).state, 'installed', 'the copied record says installed');
  api.log.length = 0;
  let client = await launch(dev, api);
  assert.equal((await client.model()).build, build.build);
  assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE, 'another device\'s record: downloaded');
  await client.close();

  // this device's own valid record of ANOTHER build, written under this build's name
  // (another build of the model: the same engine files, and without the sample clips this build has)
  const other = await build3({ version: '4.0.1', selftest: false });
  const dev2 = device(), api2 = await stubPlatform({ build: other });
  await realDownload(dev2, api2);
  const theirs = await dev2.store.inner.get(INSTALL_PREFIX + other.build);
  await copyCache(src, dev2); // this build's files, carried in
  await dev2.store.inner.put(INSTALL_PREFIX + build.build, theirs.slice());
  api2.state.build = build;
  api2.log.length = 0;
  dev2.state.set('config', null); // the config now names this build
  client = await launch(dev2, api2);
  assert.equal((await client.model()).build, build.build);
  const asked = new Set(cdnFiles(api2));
  // the files this build shares with the other one (same bytes) were this Client's own download: they are reused;
  // every file that only this build has was asked for
  const shared = new Set(other.manifest.files.map((f) => f.sha256));
  const own = build.manifest.files.filter((f) => !shared.has(f.sha256)).map((f) => f.path);
  for (const p of PROFILE) assert.equal(asked.has(p), own.includes(p), `${p}: ${own.includes(p) ? 'downloaded' : 'reused from this Client\'s other build'}`);
  assert.ok(own.some((p) => PROFILE.includes(p)), 'the builds differ in at least one file of the profile');
  await client.close();
});

test('15.2 an interrupted download resumes: the record says `downloading`, what was fetched is kept, the rest is asked for', async () => {
  const dev = device(), api = await stubPlatform({ build });
  api.state.cutAfter = 3; // the network goes away after three model requests
  let client = await launch(dev, api);
  await assert.rejects(client.model());
  assert.equal((await record(dev)).state, 'downloading');
  const kept = (await dev.store.inner.keys('sha256/')).length + (await dev.store.inner.keys('part/')).length;
  assert.ok(kept >= 1, 'something of the download is on the device');
  await client.close();
  api.state.cutAfter = null;
  api.state.cdnRequests = 0;
  api.log.length = 0;
  dev.events.length = 0;
  client = await launch(dev, api);
  assert.equal((await client.model()).build, build.build);
  assert.equal(dev.events.some((e) => e.startsWith('delete sha256/')), false, 'nothing that was fetched is deleted');
  assert.ok(new Set(cdnFiles(api)).size < PROFILE.length, 'what was fetched before the cut is not asked for again');
  assert.equal((await record(dev)).state, 'installed');
  await client.close();
});

test('15.2 the key store has no key: no record is valid; delete, make a key, download', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  dev.installKey = memoryDeviceKey(); // the key is gone (site data cleared in part, a restored backup)
  api.log.length = 0;
  dev.events.length = 0;
  const client = await launch(dev, api);
  assert.equal((await client.model()).build, build.build);
  assert.ok(dev.events.some((e) => e.startsWith('delete sha256/')), 'what was there is deleted');
  assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE);
  assert.equal((await record(dev)).state, 'installed');
  await client.close();
});

test('15.2 the key store fails: nothing is opened, deleted or downloaded; the call is storage_failed and the next call tries again', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  const good = dev.installKey;
  let broken = true;
  dev.installKey = { kind: 'test', async key(o) { if (broken) throw Object.assign(new Error('the key store is locked'), { name: 'InstallKeyError', code: 'key_store_failed' }); return good.key(o); } };
  const before = (await dev.store.inner.keys('')).sort().join(' ');
  api.log.length = 0;
  dev.events.length = 0;
  const client = await launch(dev, api);
  await assert.rejects(client.model(), (e) => code('storage_failed')(e) && /key store/.test(e.message));
  await assert.rejects(client.prefetch(), code('storage_failed'));
  assert.deepEqual(cdn(api), [], 'nothing was asked of the CDN');
  assert.deepEqual(dev.events, [], 'nothing was written or deleted');
  assert.equal((await dev.store.inner.keys('')).sort().join(' '), before);
  // the key store answers again: the same Client opens the model, with no request for a file
  broken = false;
  assert.equal((await client.model()).build, build.build);
  assert.deepEqual(cdnFiles(api), []);
  await client.close();
});

test('15.2 prefetch() writes the record too, and removeModels() forgets it', async () => {
  const dev = device(), api = await stubPlatform({ build });
  const client = await launch(dev, api);
  const r = await client.prefetch();
  assert.equal(r.complete, true);
  assert.equal((await record(dev)).state, 'installed');
  await client.removeModels();
  assert.equal(await record(dev), null);
  assert.deepEqual(await dev.store.inner.keys(''), []);
  await client.close();
});

test('15.2 the device key of Node is derived from the machine and the user; the page-load key of a runtime with no key store counts nothing from before', async () => {
  assert.ok(install, 'web/tajweed/install.js');
  const { Installs, derivedDeviceKey, installText } = install;
  assert.equal(installText('a'.repeat(40), 'installed'), `quranlab-model-install 1\n${'a'.repeat(40)}\ninstalled\n`);
  const parts = (machine, uid) => ({ fs: { readFileSync: () => machine }, os: { hostname: () => 'h', userInfo: () => ({ uid, username: 'u' }) }, execFileSync: null });
  const store = memoryStore();
  const a = new Installs({ store, deviceKey: derivedDeviceKey(parts('machine-1', 1000)) });
  await a.write('b'.repeat(40), 'installed');
  // the same machine and user: valid, in a new process too
  assert.equal(await new Installs({ store, deviceKey: derivedDeviceKey(parts('machine-1', 1000)) }).state('b'.repeat(40)), 'installed');
  // another machine, or another user: not valid
  assert.equal(await new Installs({ store, deviceKey: derivedDeviceKey(parts('machine-2', 1000)) }).state('b'.repeat(40)), null);
  assert.equal(await new Installs({ store, deviceKey: derivedDeviceKey(parts('machine-1', 1001)) }).state('b'.repeat(40)), null);
  // the MAC is the contract's: HMAC-SHA256 over the record's text with SHA-256("quranlab-model-install-key 1\n" + machine + "\n" + user + "\n")
  const { createHash, createHmac } = await import('node:crypto');
  const key = createHash('sha256').update('quranlab-model-install-key 1\nmachine-1\n1000\n').digest();
  const want = createHmac('sha256', key).update(installText('b'.repeat(40), 'installed')).digest('hex');
  assert.equal(JSON.parse(dec.decode(await store.get(INSTALL_PREFIX + 'b'.repeat(40)))).mac, want);
  // a record whose state was edited, and one that is not JSON
  const rec = JSON.parse(dec.decode(await store.get(INSTALL_PREFIX + 'b'.repeat(40))));
  await store.put(INSTALL_PREFIX + 'c'.repeat(40), new TextEncoder().encode(JSON.stringify({ ...rec, build: 'c'.repeat(40) })));
  await store.put(INSTALL_PREFIX + 'd'.repeat(40), new TextEncoder().encode('{'));
  assert.equal(await a.state('c'.repeat(40)), null);
  assert.equal(await a.state('d'.repeat(40)), null);
  // a key for the page load only: a new load has a new key, so nothing kept from before counts
  const s2 = memoryStore();
  await new Installs({ store: s2, deviceKey: memoryDeviceKey() }).write('e'.repeat(40), 'installed');
  assert.equal(await new Installs({ store: s2, deviceKey: memoryDeviceKey() }).state('e'.repeat(40)), null);
});

// ---------------------------------------------------------------------------------------------- 15.4

test('15.4 the exact headers of the manifest request and of a file request (every file is asked for by Range); no redirect is followed', async () => {
  const dev = device(), api = await stubPlatform({ build });
  const client = await launch(dev, api);
  await client.model();
  const reqs = cdn(api);
  const manifest = reqs.find((x) => x.path === 'manifest.json');
  // in Node the Client sends the page's origin itself (a browser adds it): three headers, no other
  assert.deepEqual(manifest.headers, { authorization: `Bearer ${TOKEN}`, 'x-qlab-key': KEY, origin: ORIGIN });
  const files = reqs.filter((x) => x.path !== 'manifest.json');
  assert.ok(files.length >= PROFILE.length);
  for (const f of files) {
    assert.deepEqual(Object.keys(f.headers).sort(), ['authorization', 'origin', 'range', 'x-qlab-key'], f.path);
    assert.deepEqual([f.headers.authorization, f.headers['x-qlab-key'], f.headers.origin], [`Bearer ${TOKEN}`, KEY, ORIGIN], f.path);
    assert.match(f.headers.range, /^bytes=\d+-\d+$/, f.path);
  }
  for (const r of reqs) assert.equal(r.redirect, 'error', `${r.path}: a redirect is an error, never followed`);
  // the token was there before the first model request
  const firstCdn = api.log.findIndex((x) => x.host === 'cdn');
  assert.ok(api.log.slice(0, firstCdn).some((x) => x.path === '/v1/attest'), 'a token before the first model request');
  await client.close();
  // the one place that makes them
  assert.equal(typeof platform.QuranLab.prototype.modelHeaders, 'function');
});

test('15.4 401 invalid_token on a model request: the token is renewed once and that request repeated once', async () => {
  const dev = device(), api = await stubPlatform({ build });
  const client = await launch(dev, api);
  // the token in the SDK's hands is no longer good (it ran out at the server); the API gives a new one
  api.state.token = 'qlt_v1.second.sig';
  // (the API's own calls would renew it too; none is made between the launch and the model request)
  api.log.length = 0;
  const model = await client.model();
  assert.equal(model.build, build.build);
  const attests = api.log.filter((x) => x.path === '/v1/attest');
  assert.equal(attests.length, 1, 'renewed once');
  const m = cdn(api).filter((x) => x.path === 'manifest.json');
  assert.deepEqual(m.map((x) => x.headers.authorization), [`Bearer ${TOKEN}`, 'Bearer qlt_v1.second.sig'], 'the manifest request was repeated once, with the new token');
  assert.ok(cdnFiles(api).length >= PROFILE.length);
  for (const f of cdn(api).filter((x) => x.path !== 'manifest.json')) assert.equal(f.headers.authorization, 'Bearer qlt_v1.second.sig');
  await client.close();

  // the CDN keeps refusing the token: one renewal, one repeat, then the download fails as a download does
  const dev2 = device(), api2 = await stubPlatform({ build });
  const c2 = await launch(dev2, api2);
  api2.state.cdnAnswer = { status: 401, body: { error: 'invalid_token', message: 'Renew the token.' } };
  api2.log.length = 0;
  await assert.rejects(c2.model(), code('download_failed'));
  assert.equal(api2.log.filter((x) => x.path === '/v1/attest').length, 1);
  assert.equal(cdn(api2).length, 2, 'the request and its one repeat');
  await c2.close();
});

test('15.4 the token is renewed before a model request when under one hour of it is left', async () => {
  const dev = device(), api = await stubPlatform({ build });
  let now = Date.now();
  const client = await launch(dev, api, { clock: () => now });
  now += 23.5 * 3600_000; // 30 minutes of the token are left; the stored config has not run out
  api.log.length = 0;
  await client.model();
  const firstCdn = api.log.findIndex((x) => x.host === 'cdn');
  assert.ok(firstCdn > 0 && api.log.slice(0, firstCdn).some((x) => x.path === '/v1/attest'), 'a new token before the first model request');
  await client.close();
});

// ---------------------------------------------------------------------------------------------- 15.3

test('15.3 the list of refusals that stop a model is the vector\'s, in one constant', () => {
  assert.deepEqual(platform.MODEL_STOP_REASONS, gate.stop_reasons);
  // one constant: the platform client's name is the same object as the one the errors are made by
  assert.equal(platform.MODEL_STOP_REASONS, errorsModule.MODEL_STOP_REASONS);
  assert.deepEqual(errorsModule.MODEL_KEY_REASONS, gate.key_reasons);
  assert.equal(gate.format, 'quranlab.sdk-model-gate-vectors/3');
  for (const c of gate.cases) assert.equal(c.expect.removes_models, c.expect.stops_model, c.name);
  assert.equal(gate.cases.length, 32);
  assert.equal(gate.cases.filter((c) => c.expect.stops_model).length, 13);
  // the vector's own rule, checked on its cases: a stop exactly when the body carries a reason of the list
  for (const c of gate.cases) assert.equal(c.expect.stops_model, !!(c.body && gate.stop_reasons.includes(c.body.reason)), c.name);
});

// the stub server gives one answer of the vector: the API on every path, or the CDN on every model request
function answering(api, c) {
  if (c.from === 'cdn') { api.state.cdnAnswer = { status: c.status, body: c.body }; return api.fetch; }
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'cdn.test') return api.fetch(url, init);
    api.log.push({ method: init.method || 'GET', host: 'api', path: u.pathname, forced: true });
    if (c.status === null) throw new TypeError('fetch failed');
    if (c.status === 200) {
      // a config whose signature does not verify (every other path: as the server answers)
      if (u.pathname !== '/v1/config') return api.fetch(url, init);
      const r = await api.fetch(url, init);
      if (r.status !== 200) return r;
      return new Response(JSON.stringify(c.body), { status: 200, headers: { 'x-qlab-signature': r.headers.get('x-qlab-signature'), 'x-qlab-key-id': r.headers.get('x-qlab-key-id'), etag: '"other"' } });
    }
    return new Response(JSON.stringify(c.body), { status: c.status, headers: { 'content-type': 'application/json' } });
  };
}

// the error the vector expects, with this app's origin and this SDK's version in it
const expected = (c) => {
  const e = c.expect.error;
  const fill = (s) => s.split(gate.app).join(ORIGIN).split(`this is ${gate.sdk}`).join(`this is ${SDK_VERSION}`);
  return e ? { code: e.code, message: fill(e.message), fix: fill(e.fix) } : null;
};
const is = (want) => (e) => {
  assert.ok(e instanceof TajweedError, `a TajweedError, got ${e && e.name}: ${e && e.message}`);
  assert.deepEqual({ code: e.code, message: e.message, fix: e.fix }, want);
  return true;
};

for (const c of gate.cases) {
  test(`15.3 model_gate.json: ${c.name}: ${c.expect.stops_model ? 'stops the model on the device' : 'a model on the device keeps running'}`, async () => {
    const want = expected(c);
    // ---- with a model from a real download on the device
    const dev = device(), api = await stubPlatform({ build });
    await realDownload(dev, api);
    await plantSharing(dev);
    const held = await modelKeys(dev);
    assert.ok(held.some((k) => k.startsWith('sha256/')) && held.some((k) => k.startsWith('install/')));
    assert.equal(c.expect.removes_models, c.expect.stops_model, 'format 3: a stop removes the models');
    let client = await launch(dev, api, { fetch: answering(api, c) });
    if (c.expect.stops_model) {
      await assert.rejects(client.model(), is(want));
      // when the call rejected (a stop the launch received: when create() returned), no model file and no install
      // record is left, and nothing else was removed
      assert.deepEqual(await modelKeys(dev), [], 'the models are removed');
      await keptBesideTheStop(dev);
      await assert.rejects(client.prefetch(), is(want));
      const d = await client.diagnose();
      assert.deepEqual([d.key.accepted, d.key.reason], [false, want.code === 'invalid_key' ? 'invalid_key' : 'server_rejected']);
      // remembered on the device, with where it came from
      assert.deepEqual([dev.state.get(platform.MODEL_REFUSED_KEY).reason, dev.state.get(platform.MODEL_REFUSED_KEY).from], [c.body.reason, c.from]);
      await client.close();
      // a relaunch without a network: the refusal is remembered, the model does not run
      api.state.cdnAnswer = null;
      api.state.offline = true;
      client = await launch(dev, api);
      await assert.rejects(client.model(), is(want));
      await assert.rejects(client.prefetch(), is(want));
      await client.close();
      // a later answer of the server accepts the key: the stop ends, and the model is downloaded again, every file
      // of it, as on a first visit
      api.state.offline = false;
      api.log.length = 0;
      client = await launch(dev, api);
      assert.equal((await client.model()).build, build.build);
      assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE, 'every file is requested again');
      assert.equal((await client.diagnose()).key.accepted, true);
      assert.equal(dev.state.get(platform.MODEL_REFUSED_KEY), null, 'the stop is cleared on the device');
      await client.close();
    } else {
      // not a stop: the model a real download left keeps running, and nothing is removed
      const model = await client.model();
      assert.equal(model.build, build.build);
      assert.deepEqual(await modelKeys(dev), held, 'nothing is removed');
      await client.close();
      // and nothing was remembered: a relaunch without a network runs it too
      api.state.cdnAnswer = null;
      api.state.offline = true;
      client = await launch(dev, api);
      assert.equal((await client.model()).build, build.build);
      await client.close();
    }

    // ---- without a model on the device: the call cannot give one
    const fresh = device(), api2 = await stubPlatform({ build });
    const c2 = await launch(fresh, api2, { fetch: answering(api2, c) });
    if (want) {
      await assert.rejects(c2.model(), is(want));
      await assert.rejects(c2.prefetch(), is(want));
    } else {
      // no error of its own: the call fails as a start without the server does, never as a refusal
      for (const call of [() => c2.model(), () => c2.prefetch()]) {
        await assert.rejects(call(), (e) => e instanceof TajweedError && ['needs_connection', 'download_failed'].includes(e.code));
      }
    }
    assert.equal((await fresh.store.inner.keys('sha256/')).length, 0, 'no file of a model is on the device');
    await c2.close();
  });
}

test('15.3 a Model that is already open when the refusal arrives keeps running until the app closes it', async () => {
  const dev = device(), api = await stubPlatform({ build });
  const client = await launch(dev, api);
  const model = await client.model();
  // the server refuses the app from now on; the Client hears it at its next call (a config refresh)
  api.state.status['/v1/config'] = { status: 403, error: 'app_blocked', reason: 'app_blocked' };
  await client._ql.refreshConfig().catch(() => {});
  // the stored files go at once; the open Model has what it needs in memory
  await client._purgeChain;
  assert.deepEqual(await modelKeys(dev), [], 'the stored files are removed at once');
  const s = model.session();
  s.push(new Float32Array(16000));
  await s.finish();
  assert.equal(await client.model(), model, 'the open Model is still the app\'s');
  await model.close();
  await assert.rejects(client.model(), (e) => code('server_rejected')(e) && /app_blocked/.test(e.message));
  await client.close();
});

test('15.3 a refusal that came from a model request is not ended by an answer of the API: it holds without a network, and the CDN, asked again once the API has accepted the key, decides', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  const refusal = { status: 401, body: { error: 'missing or invalid x-qlab-key', reason: 'app_not_allowed' } };
  const want = (e) => code('server_rejected')(e) && /app_not_allowed/.test(e.message);
  const stored = () => dev.state.get(platform.MODEL_REFUSED_KEY);
  // the CDN refuses this app's model request
  api.state.cdnAnswer = refusal;
  let client = await launch(dev, api);
  await assert.rejects(client.model(), want);
  assert.deepEqual([stored().reason, stored().from], ['app_not_allowed', 'cdn']);
  // in the same launch the API accepts the key again (a config that verifies): the stop holds, and the next
  // model call asks the CDN again, which still refuses
  api.state.configVersion++;
  await client._ql.refreshConfig();
  api.log.length = 0;
  await assert.rejects(client.model(), want);
  assert.deepEqual(cdn(api).map((x) => x.path), ['manifest.json'], 'the CDN was asked again');
  assert.equal(stored().from, 'cdn');
  await client.close();
  // a relaunch where the API answers and accepts the key (token, register, config) but the CDN is not reached:
  // the stop holds, also on the device
  api.state.cdnAnswer = null;
  const noCdn = async (url, init) => { if (new URL(url).host === 'cdn.test') throw new TypeError('fetch failed'); return api.fetch(url, init); };
  dev.state.set('register.day', null); // a register answer too
  api.log.length = 0;
  client = await launch(dev, api, { fetch: noCdn });
  assert.ok(api.log.some((x) => x.path === '/v1/register') && api.log.some((x) => x.path === '/v1/config'), 'the API answered');
  assert.equal((await client.diagnose()).key.accepted, false);
  await assert.rejects(client.model(), want);
  await assert.rejects(client.prefetch(), want);
  assert.deepEqual([stored().reason, stored().from], ['app_not_allowed', 'cdn'], 'not ended by the API');
  await client.close();
  // a relaunch without any network: stopped
  api.state.offline = true;
  client = await launch(dev, api);
  await assert.rejects(client.model(), want);
  await client.close();
  // a relaunch with the network: the API accepts, the CDN is asked again and serves: the model is downloaded
  // again (every file: the stop removed it) and opens, and the stop is gone
  api.state.offline = false;
  api.log.length = 0;
  client = await launch(dev, api);
  assert.equal((await client.model()).build, build.build);
  assert.deepEqual([...new Set(cdnFiles(api))].sort(), PROFILE);
  assert.equal(stored(), null);
  assert.equal((await client.diagnose()).key.accepted, true);
  await client.close();
});

test('15.3 a removal that fails is never an error of its own: the app gets the refusal\'s error, and the removal is tried again at the next start before the Client does anything else', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  // the device's cache refuses to delete (a storage error) until told otherwise
  let broken = true;
  const inner = dev.store.delete;
  dev.store.delete = async (k) => { if (broken) throw new Error('the store is locked'); return inner(k); };
  api.state.cdnAnswer = { status: 401, body: { error: 'missing or invalid x-qlab-key', reason: 'key_revoked' } };
  let client = await launch(dev, api);
  await assert.rejects(client.model(), code('invalid_key'), 'the refusal\'s error, not storage_failed');
  await assert.rejects(client.prefetch(), code('invalid_key'));
  assert.ok((await modelKeys(dev)).length > 0, 'nothing could be removed');
  assert.equal(dev.state.get('model.purge'), true, 'the removal is owed');
  await client.close();
  // the next start, the store still failing, without a network: the refusal's error again
  api.state.cdnAnswer = null;
  api.state.offline = true;
  client = await launch(dev, api);
  await assert.rejects(client.model(), code('invalid_key'));
  await client.close();
  // the store works again: the next start removes the models first, before any request
  broken = false;
  api.state.offline = false;
  dev.events.length = 0;
  dev.traceFetch = true;
  client = await launch(dev, api);
  const firstDelete = dev.events.findIndex((e) => e.startsWith('delete '));
  const firstFetch = dev.events.findIndex((e) => e.startsWith('fetch '));
  assert.ok(firstDelete >= 0 && firstDelete < firstFetch, `removed (${firstDelete}) before the first request (${firstFetch})`);
  assert.deepEqual(await modelKeys(dev), []);
  assert.equal(dev.state.get('model.purge'), null, 'nothing is owed');
  await client.close();
});

test('15.3 a page load without a network that finds a remembered stop and model files put back by hand removes them first and fails with the refusal\'s error', async () => {
  const src = device(), api = await stubPlatform({ build });
  await realDownload(src, api);
  const dev = device();
  await realDownload(dev, api);
  api.state.cdnAnswer = { status: 401, body: { error: 'missing or invalid x-qlab-key', reason: 'origin_not_allowed' } };
  let client = await launch(dev, api);
  await assert.rejects(client.model(), code('server_rejected'));
  await client.close();
  assert.deepEqual(await modelKeys(dev), []);
  // the files of a download, its record included, put back into the cache by hand
  await copyCache(src, dev, { records: true });
  assert.ok((await modelKeys(dev)).length > 0);
  api.state.cdnAnswer = null;
  api.state.offline = true;
  client = await launch(dev, api);
  assert.deepEqual(await modelKeys(dev), [], 'removed when the Client was made, before any call');
  await assert.rejects(client.model(), (e) => code('server_rejected')(e) && /origin_not_allowed/.test(e.message));
  await assert.rejects(client.prefetch(), code('server_rejected'));
  await client.close();
});

test('15.3 another page of the same origin: one with a Model open keeps it running from memory when this one receives the stop; once it closes it, its next model() finds the remembered refusal', async () => {
  const dev = device(), api = await stubPlatform({ build });
  await realDownload(dev, api);
  // page B opens the model; page A (same state and stores: one origin) is made afterwards
  const b = await launch(dev, api);
  const model = await b.model();
  const a = await launch(dev, api);
  api.state.cdnAnswer = { status: 401, body: { error: 'missing or invalid x-qlab-key', reason: 'app_not_allowed' } };
  await assert.rejects(a.model(), code('server_rejected'));
  assert.deepEqual(await modelKeys(dev), [], 'the stored files are gone for both pages');
  // page B's open Model keeps running from memory
  const s = model.session();
  s.push(new Float32Array(16000));
  await s.finish();
  assert.equal(await b.model(), model, 'the open Model is still page B\'s');
  await model.close();
  await assert.rejects(b.model(), (e) => code('server_rejected')(e) && /app_not_allowed/.test(e.message));
  await a.close();
  await b.close();
});

test('15.3 a 401 invalid_token that carries a reason of the list is a stop, never renewed: from the API and from the CDN', async () => {
  // the API: the key was revoked after the token was issued
  for (const [reason, stops] of [['key_revoked', true], [null, false]]) {
    const dev = device(), api = await stubPlatform({ build });
    await realDownload(dev, api);
    dev.state.set('register.day', null);
    api.state.status['/v1/register'] = { status: 401, error: 'invalid_token', ...(reason ? { reason } : {}) };
    api.log.length = 0;
    const client = await launch(dev, api);
    const attests = api.log.filter((x) => x.path === '/v1/attest').length;
    const registers = api.log.filter((x) => x.path === '/v1/register').length;
    if (stops) {
      assert.deepEqual([attests, registers], [0, 1], 'API: no new token, no repeat');
      await assert.rejects(client.model(), code('invalid_key'));
      assert.deepEqual((await client.diagnose()).key, { accepted: false, reason: 'invalid_key' });
    } else {
      assert.deepEqual([attests, registers], [1, 2], 'API without a reason: renewed once, repeated once');
      assert.equal((await client.model()).build, build.build);
    }
    await client.close();
  }
  // the CDN, on a model request
  for (const [reason, stops] of [['key_unknown', true], [null, false]]) {
    const dev = device(), api = await stubPlatform({ build });
    const client = await launch(dev, api);
    api.state.cdnAnswer = { status: 401, body: { error: 'invalid_token', message: 'Renew the token.', ...(reason ? { reason } : {}) } };
    api.log.length = 0;
    await assert.rejects(client.model(), code(stops ? 'invalid_key' : 'download_failed'));
    assert.equal(api.log.filter((x) => x.path === '/v1/attest').length, stops ? 0 : 1, stops ? 'CDN: no new token' : 'CDN without a reason: renewed once');
    assert.equal(cdn(api).length, stops ? 1 : 2);
    assert.equal(!!dev.state.get(platform.MODEL_REFUSED_KEY), stops);
    await client.close();
  }
});

test('15.3 the web\'s origin check: a page refused by its origin, its key or its key type reads the reason there, and it stops the model; a production key on a local address does not', async () => {
  // a page whose origin is not on the key gets no CORS answer from the API: every request fails as with no
  // network, and the origin check (readable from any origin) says why
  for (const [why, want, stops] of [
    ['key_revoked', { code: 'invalid_key' }, true],
    ['key_unknown', { code: 'invalid_key' }, true],
    ['not_listed', { code: 'server_rejected', reason: /origin_not_allowed/ }, true],
    ['key_not_approved', { code: 'server_rejected', reason: /developer_not_approved/ }, true],
    ['not_a_web_key', { code: 'server_rejected', reason: /key_type_mismatch/ }, true],
    ['local_needs_development_key', { code: 'server_rejected', reason: /local_needs_development_key/ }, false],
    ['a_why_from_later', { code: 'server_rejected', reason: /a_why_from_later/ }, false],
  ]) {
    const dev = device(), api = await stubPlatform({ build });
    await realDownload(dev, api);
    dev.state.set('register.day', null);
    dev.state.set('token', null);
    const corsRefused = async (url, init = {}) => {
      const u = new URL(url);
      if (u.pathname === '/v1/origin-check') return new Response(JSON.stringify({ origin: ORIGIN, allowed: false, why, environment: 'production' }), { status: 200 });
      if (u.host === 'cdn.test') return api.fetch(url, init);
      throw new TypeError('Failed to fetch');
    };
    const client = await launch(dev, api, { fetch: corsRefused });
    const matches = (e) => code(want.code)(e) && (!want.reason || want.reason.test(e.message));
    if (stops) {
      await assert.rejects(client.model(), matches, why);
      assert.equal(dev.state.get(platform.MODEL_REFUSED_KEY).from, 'api', why);
    } else {
      assert.equal((await client.model()).build, build.build, `${why}: the model on the device runs`);
      assert.equal(dev.state.get(platform.MODEL_REFUSED_KEY), null, why);
    }
    await client.close();
  }
});

// ---------------------------------------------------------------------------------------------- 15.1

test('15.1 the classes of the package cannot be made from parts a page supplies: the constructors take only what the SDK itself hands them', async () => {
  const dev = device(), api = await stubPlatform({ build });
  const client = await launch(dev, api);
  const model = await client.model();
  // a Client from a transport, a store, a trusted key and a record checker of the page's own
  const parts = { ql: client._ql, state: dev.state, store: dev.store, installs: { state: async () => 'installed' }, modelKeys: ['00'.repeat(32)], seams: {}, fetch: api.fetch };
  for (const x of [undefined, {}, parts, { ...client._i }]) assert.throws(() => new TajweedClient(x), code('invalid_argument'));
  // a Model from a folder (a reader) and an engine of the page's own
  for (const x of [undefined, {}, { folder: { manifest: build.manifest, read: async () => null }, host: {}, contexts: [], names: [] }]) {
    assert.throws(() => new TajweedModel(x), code('invalid_argument'));
  }
  await client.close();
});

test('15.1 the package\'s exports map gives a Node program the one entry: "./node" and every deep path are not exported', () => {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(pkg.exports), ['.', './package.json']);
  // the package resolved by its own name (as an app's import resolves it)
  assert.match(require.resolve(pkg.name).replace(/\\/g, '/'), /\/web\/index\.node\.js$/);
  for (const sub of ['node', 'web/api/model.js', 'web/tajweed/manifest.js', 'web/tajweed/delivery.js', 'web/index.js']) {
    assert.throws(() => require.resolve(`${pkg.name}/${sub}`), (e) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', sub);
  }
});
