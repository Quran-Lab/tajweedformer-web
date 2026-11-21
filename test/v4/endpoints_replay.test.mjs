// ENDPOINTS_40.md (section 28) on the code that makes the requests: vectors/endpoints_40.json's `answers` through the
// platform client's own routes (the config, register, the challenge; each answer is the first host's, a second host
// answers well, and the class is read from what the client did: taken on the first host, a refusal or a slow down
// there, or the second host asked), the lease route through the endpoint set with the Core's verdict standing in, the
// model files through the frame's download code (sdk4/frame/controller.js _get); `bases` and `downloads` through _get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QuranLab } from '../../web/platform/client.js';
import { QuranLab4 } from '../../sdk4/frame/api4.js';
import { Controller, SdkError } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV, StateStore } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';
import { Endpoints, ROLES } from '../../sdk4/shared/endpoints.js';
import { respond, signedConfig, TRUSTED } from './helpers/vector-answers.mjs';

const V = JSON.parse(readFileSync(new URL('../vectors40/endpoints_40.json', import.meta.url), 'utf8'));
const [A, AB] = ROLES.api;
const [C, CB] = ROLES.models;
const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const memState = (init = {}) => { const m = new Map(Object.entries(init)); return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { if (v === null || v === undefined) m.delete(k); else m.set(k, v); }, flush: async () => {} }; };

// the first host answers `a`; the second answers the route well; `asked`: the hosts in order
function twoHosts(a, route) {
  const asked = [];
  const fetch = (url, init = {}) => {
    const host = new URL(url).host;
    asked.push(host);
    if (host === A) return respond(a, route, { signal: init.signal });
    return respond({ status: 200, body: 'json' }, route === 'register' ? 'register' : route);
  };
  return { fetch, asked };
}

// the platform client's route for `route`, on a client whose first host answers `a`: the class it read
async function apiClass(route, a) {
  const t = twoHosts(a, route);
  const nowS = Math.floor(Date.now() / 1000);
  const saved = signedConfig(nowS);
  // a stored config and its ETag (a 304 needs If-None-Match), and a token: the route alone is asked
  const state = memState({ bucket: 7, token: { token: 'tok', exp: nowS + 86400 }, config: { cfg: JSON.parse(new TextDecoder().decode(saved.body)), pin: null, etag: '"e0"' } });
  const o = { key: KEY, bundleId: 'https://app.example', fetch: t.fetch, state, trustedKeys: TRUSTED, autoSend: false, issues: false, endpoints: new Endpoints({ headMs: 40 }) };
  let ql;
  if (route === 'challenge') {
    ql = new QuranLab4({ ...o, site: 'https://app.example', keys: { spki: new Uint8Array(1), signSpki: new Uint8Array(1), installHex: '00' } });
    ql._token = { token: 'tok', exp: nowS + 86400 };
    ql.installCert = 'cert';
  } else ql = new QuranLab(o);
  let out = 'taken', err = null;
  try {
    if (route === 'config') await ql.refreshConfig();
    else if (route === 'register') await ql._call('POST', '/v1/register', { body: {} });
    else await ql.challenge();
  } catch (e) { err = e; }
  if (t.asked.includes(AB)) out = 'unreachable';
  else if (err) out = err.status === 429 ? 'slow_down' : err.status >= 400 && err.status < 500 ? 'refused' : `error ${err.code}`;
  return { cls: out, asked: t.asked };
}

for (const [i, c] of V.answers.entries()) {
  test(`answers ${i}: ${c.route} ${JSON.stringify(c.answer)} is ${c.class}`, async () => {
    if (['config', 'register', 'challenge'].includes(c.route)) {
      const got = await apiClass(c.route, c.answer);
      assert.equal(got.cls, c.class, JSON.stringify(got.asked));
    } else if (c.route === 'model-key') {
      // the lease route's own check is the Core's (Controller._leaseAnswer); the vector's verdict stands in for it
      const ep = new Endpoints({ headMs: 40 });
      const t = twoHosts(c.answer, 'model-key');
      const accept = async (res) => { try { const j = await res.json(); return j.core === 'accepted' ? j : null; } catch (_) { return null; } };
      let cls;
      try { cls = (await ep.request('api', '/v1/model-key', {}, { fetch: t.fetch, accept })).cls; } catch (_) { cls = 'unreachable'; }
      assert.equal(t.asked.includes(AB) ? 'unreachable' : cls, c.class);
    } else {
      // a model file: the frame's download code, with half the file held (a range request)
      const got = await fileClass(c.answer);
      assert.equal(got, c.class);
    }
  });
}

// ---- the frame's download code (Controller._get) on a stand-in CDN ----

const SIZE = 1000;
const FILE = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7) & 255);

/** A Controller with only what _get needs: the endpoint set, a token-free model header, the stores, fast pauses. */
async function downloader({ fetch, p = null, pauses = [1, 2, 4, 8, 16] } = {}) {
  const kv = new MemoryKV(), files = new MemoryFiles();
  const waits = [];
  const timers = { setTimeout: (f, ms) => { if (ms <= 16) waits.push(ms); return setTimeout(f, ms); }, clearTimeout: (t) => clearTimeout(t) };
  const c = new Controller({ key: KEY, site: 'https://app.example', files, kv, timers, download: { pausesMs: pauses, stallMs: 60, blockBytes: 500 }, endpoints: { headMs: 60 } });
  c.state = await StateStore.open(kv);
  c.ql = { modelHeaders: async () => ({}), rawFetch: fetch, noteModelServed() {}, noteModelRefusal() {}, _token: null };
  // P a backup host since now (a time of 0 would be 30 minutes past on the real clock: the probe back)
  if (p) { c.ep.roles.models.p = p; c.ep.roles.models.since = c.clock(); }
  return { c, waits, files };
}

/** A bytes answer of the downloads vector: `deliver` bytes from the Range's start, then complete, a stall or a reset. */
function bytesAnswer(a, from, etag) {
  const start = a.status === 206 ? from : 0;
  const part = FILE.slice(start, start + a.deliver);
  let sent = false;
  const body = new ReadableStream({ pull(ctl) {
    if (!sent) { sent = true; ctl.enqueue(part); return undefined; }
    if (a.end === 'complete') { ctl.close(); return undefined; }
    if (a.end === 'reset') { ctl.error(new TypeError('terminated')); return undefined; }
    return new Promise(() => {});
  } });
  const headers = { etag };
  if (a.status === 206) headers['content-range'] = `bytes ${start}-${SIZE - 1}/${SIZE}`;
  return new Response(body, { status: a.status, headers });
}

/** A stand-in CDN that answers the n-th request with seq[n]; `seen`: { host, range, ifRange } of each; `urls`: each URL. */
function cdn(seq, etags = {}) {
  const seen = [], urls = [];
  const fetch = (url, init = {}) => {
    urls.push(String(url));
    const host = new URL(url).host, h = init.headers || {};
    const range = h.range || null;
    seen.push({ host, range, ifRange: h['if-range'] || null });
    const a = seq[seen.length - 1];
    if (a && a.deliver !== undefined) return Promise.resolve(bytesAnswer(a, range ? Number(/^bytes=(\d+)-$/.exec(range)[1]) : 0, etags[host] || '"x"'));
    return respond(a, 'file', { signal: init.signal });
  };
  return { fetch, seen, urls };
}

// one model file's answer `a` on the first CDN, half the file held (a range request); the second CDN answers well
async function fileClass(a) {
  const seq = [a, { status: 206, body: 'bytes', deliver: 500, end: 'complete' }];
  const s = cdn(seq);
  const { c, files } = await downloader({ fetch: (url, init) => {
    // the vector's 206 answers bytes 500- of the file here (its range form)
    if (s.seen.length === 0 && a.status === 206) {
      s.seen.push({ host: new URL(url).host });
      return Promise.resolve(new Response(FILE.slice(500), { status: 206, headers: { 'content-range': `bytes 500-999/${a.body === 'invalid' ? 999 : SIZE}` } }));
    }
    return s.fetch(url, init);
  } });
  await files.put(QLC.FORM_CDN, 'f.part.0', FILE.slice(0, 500));
  c.state.set('part:f', { size: SIZE, block: 500, n: 1, validator: null });
  let err = null;
  try { await c._get(`https://${C}/models/x/f`, { size: SIZE, keep: 'f' }); } catch (e) { err = e; }
  if (s.seen.length > 1) return 'unreachable';
  if (!err) return 'taken';
  return err.why === 'rate_limited' ? 'slow_down' : err.why === 'refused' || (err.http_status >= 400 && err.http_status < 500) ? 'refused' : `error ${err.why}`;
}

test('bases: the hosts the build\'s first model request asks, in order (28.4), through the download code', async () => {
  for (const b of V.bases.filter((x) => x.accepted)) {
    for (const [key, p] of [['asks_with_p_first', null], ['asks_with_p_standby', CB]]) {
      const s = cdn(Array(6).fill({ answer: 'none' }));
      const { c } = await downloader({ fetch: s.fetch, p, pauses: [0, 0, 0, 0, 0] });
      await assert.rejects(c._get(`${b.base}manifest.json`, { stage: 'manifest' }), (e) => e instanceof SdkError && e.code === 'download_failed');
      const want = b[key];
      // the order, then again from its start (16.2's five resumes cycle through the hosts, 28.4)
      assert.deepEqual(s.seen.map((x) => x.host), [...want, ...want].slice(0, 6), `${b.name}: ${key}`);
    }
  }
});

for (const d of V.downloads) {
  test(`downloads: ${d.name}`, async () => {
    const s = cdn(d.answers, d.etags);
    const { c, waits } = await downloader({ fetch: s.fetch, p: d.p_before !== C ? d.p_before : null });
    let got = null, err = null;
    try { got = await c._get(`https://${C}/models/x/file.bin`, { size: d.size }); } catch (e) { err = e; }
    assert.deepEqual(s.seen.map((x) => x.host), d.requests.map((x) => x.host), 'the hosts');
    assert.deepEqual(s.seen.map((x) => x.range), d.requests.map((x) => x.range), 'the Range of each');
    // never an If-Range: an ETag is one store's (28.4); the web sends none to any host (the vector allows it only to
    // the host that gave the validator)
    assert.ok(s.seen.every((x) => x.ifRange === null), 'no If-Range');
    assert.deepEqual(waits, d.requests.slice(1).map((x) => x.pause_before), 'the pauses of 16.2');
    const end = got ? 'installed' : err.why === 'rate_limited' ? 'rate_limited' : err.why === 'refused' ? 'refused' : 'download_failed';
    assert.equal(end, d.end, err ? err.message : '');
    if (got) assert.deepEqual(got, FILE.slice(0, d.size));
    assert.equal(c.ep.roles.models.p, d.p_after, 'P after');
  });
}

// downloads_if_range (28.4): an SDK may send no If-Range where a case gives one, and never one where it gives null.
// The web keeps a range map and sends none on any host, which the rule allows for every request of every case.
test('downloads_if_range: no If-Range on any request of any download case, which the rule allows everywhere', async () => {
  assert.equal(typeof V.downloads_if_range, 'string');
  let withValue = 0;
  for (const d of V.downloads) {
    const s = cdn(d.answers, d.etags);
    const { c } = await downloader({ fetch: s.fetch, p: d.p_before !== C ? d.p_before : null });
    try { await c._get(`https://${C}/models/x/file.bin`, { size: d.size }); } catch (_) { /* the case's end is checked above */ }
    assert.equal(s.seen.length, d.requests.length, d.name);
    s.seen.forEach((x, i) => {
      const allowed = d.requests[i].if_range;
      if (allowed !== null) withValue++;
      // null is allowed where null is given and where a value is given
      assert.equal(x.ifRange, null, `${d.name}: request ${i}`);
    });
  }
  assert.ok(withValue > 0, 'some cases give a value an SDK may send (to the host that gave it)');
});

// first_manifest (28.4): a build's manifest before the install holds a lease for it comes from the folder qlab-api
// names (the early fetch's folder, Controller._predictedBase: /models, the config's model, the build, its folder);
// with a lease held, from that lease's folder. Both through the models order (a base host that is not one of the
// role's first); the hosts asked, with P the first host and with P a backup host.
for (const f of V.first_manifest) {
  test(`first_manifest: ${f.name}`, async () => {
    for (const [key, p] of [['asks_with_p_first', null], ['asks_with_p_standby', CB]]) {
      const want = f[key];
      const s = cdn(Array(want.length).fill({ answer: 'none' }));
      const { c } = await downloader({ fetch: s.fetch, p, pauses: Array(want.length - 1).fill(0) });
      // no lease yet: the folder the early fetch reads, from the signed config's recommended build
      c.ql.config = { recommended: f.recommended };
      const folder = f.lease_base || c._predictedBase({ build: f.recommended.revision });
      assert.ok(folder, `${f.name}: a folder`);
      await assert.rejects(c._get(`${folder}manifest.json`, { stage: 'manifest' }), (e) => e instanceof SdkError && e.code === 'download_failed');
      assert.deepEqual(s.seen.map((x) => x.host), want, `${f.name}: ${key}`);
      // the path is the lease's folder on every host
      assert.ok(s.urls.every((u) => new URL(u).pathname === f.path), `${f.name}: ${s.urls.join(' ')}`);
    }
  });
}

// 16.1 and 28.4: a whole file (200) in answer to a range request is read beside the bytes held and takes their place
// only once complete; one that breaks off leaves the bytes held, and the next resume asks from them
test('a 200 to a range request that breaks off: the bytes held stay, the next resume asks from them', async () => {
  const seq = [{ status: 200, deliver: 400, end: 'reset' }, { status: 200, deliver: 300, end: 'reset' }, { status: 206, deliver: 600, end: 'complete' }];
  const s = cdn(seq);
  const { c } = await downloader({ fetch: s.fetch, pauses: [0, 0, 0, 0, 0] });
  const got = await c._get(`https://${C}/models/x/file.bin`, { size: SIZE });
  assert.deepEqual(s.seen.map((x) => x.range), [null, 'bytes=400-', 'bytes=400-']);
  assert.deepEqual(got, FILE);
});
