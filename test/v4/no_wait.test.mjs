// SDK 4.0.2, NO_WAIT_40.md (section 33): nothing waits for Wi-Fi. The web SDK end to end in Node: the loader's own
// classes in a stand-in page (helpers/page.mjs: window, document, the frame's iframe), the frame's real Controller
// and Core over a real MessageChannel, the fake API and CDN of the contract's test keys, and navigator.connection as
// Chrome on Android reports it (mobile data, the data saver, no network, or no Network Information API at all), every
// read of it counted. Each case of vectors/no_wait_40.json that names web is replayed, with the requests the
// stand-in servers receive.
//
// The case of Quran Lab's rule (Apple 4.0.1, other_context_metered): prefetch() installs the default context, then a
// session on c24_l256 on mobile data. The protected test build has one context (c16_l64), so c24_l256 is a stand-in:
// its four engine files are added to the frame's parsed manifest and served by the stand-in CDN (bytes made here),
// and the Core's install of them and its open of that context are the test's (the open runs the real engine on
// c16_l64). Everything else is the SDK's own: the page's session, the frame's start, its choice of what to download,
// the requests and their answers. update_metered needs a second protected build and is replayed on the 3.x path
// (test/api_delivery.test.mjs).
//
// Web 4.0.1 (4effe91) had one wait: the page's prefetch({ unmeteredOnly }) returned without a request on a connection
// the browser called metered or data-saving. Nothing else read the connection, so other_context_metered, its data
// saver case and the 4.0.1 report's test pass on 4.0.1 too. Run on the 4.0.1 sources, six of these fail: an older
// page's prefetch({ unmeteredOnly: true }) on mobile data (no file request: the wait), other_context_none and a page
// loaded offline (the take failed with engine_failed, not needs_connection), first_install_none (no cause), and
// prefetch_metered and prefetch_data_saver (bytesDone lost the bytes of the files fetched side by side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fakeServer } from './helpers/fake-api.mjs';
import { loadEngine, testBuild } from './helpers/env.mjs';
import { installPage, connectionStandIn, CONNECTIONS } from './helpers/page.mjs';
import { Controller } from '../../sdk4/frame/controller.js';
import { MemoryFiles, MemoryKV } from '../../sdk4/frame/stores.js';
import { QLC } from '../../sdk4/frame/core.js';
import { TajweedClient } from '../../sdk4/loader/client.js';

const V = JSON.parse(readFileSync(new URL('../vectors40/no_wait_40.json', import.meta.url), 'utf8'));
const WEB = V.cases.filter((c) => c.platforms.includes('web'));
const engine = await loadEngine();
const dir = testBuild();
const skip = !engine ? 'no packaged engine (python scripts/build_web4.py engine)' : !dir ? 'no protected test build (QL_TEST_BUILD)' : false;
const OTHER = V.contexts.other; // c24_l256
const hex = (b) => createHash('sha256').update(b).digest('hex');

function noise(seconds, seed = 1) {
  const out = new Float32Array(16000 * seconds);
  let x = seed;
  for (let i = 0; i < out.length; i++) { x = (x * 1103515245 + 12345) >>> 0; out[i] = ((x / 2 ** 32) - 0.5) * 0.05; }
  return out;
}

/**
 * A device (the frame's stores, kept across page loads) and the servers. `net.offline`: no answer from any server.
 * `log`: every request the stand-in API and CDN receive ({ method, path, range }).
 */
async function device() {
  const srv = await fakeServer({ cdnDir: dir });
  const def = srv.manifest.default_context;
  // the stand-in context: the default context's engine files under c24_l256, with bytes of their own
  const other = new Map();
  const entries = srv.manifest.files.filter((f) => f.context === def).map((f, i) => {
    const bytes = new Uint8Array(4096 + i).map((_, k) => (k * 31 + i * 7) & 255);
    const path = `${OTHER}/${f.path.split('/').slice(1).join('/')}`;
    other.set(path, bytes);
    return { ...f, path, size: bytes.length, sha256: hex(bytes), context: OTHER, decoded: { ...f.decoded, path: `${OTHER}/${f.decoded.path.split('/').slice(1).join('/')}` } };
  });
  const log = [], net = { offline: false };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    log.push({ method: init.method || 'GET', host: u.host, path: decodeURIComponent(u.pathname), range: h.range || null });
    if (net.offline) throw new TypeError('fetch failed');
    const m = /\/sdk\/[^/]+\/(.+)$/.exec(decodeURIComponent(u.pathname));
    if (u.host === 'cdn.test' && m && other.has(m[1])) return new Response(other.get(m[1]), { status: 200 });
    return srv.fetch(url, init);
  };
  const files = new MemoryFiles(), kv = new MemoryKV();
  const installed = [];
  // the frame's Controller of one page load, with the stand-in context
  const controller = () => {
    const ctl = new Controller({ key: srv.apiKey, site: srv.site, apiUrl: 'https://api.test', modelsUrl: 'https://cdn.test/models', fetch,
      files, kv, engine, trustedKeys: [srv.trustedKey], turnstile: srv.turnstile, autoSend: false, download: { pausesMs: [0, 0, 0, 0, 0] } });
    const init = ctl.init.bind(ctl);
    ctl.init = async (a) => {
      const r = await init(a);
      const core = ctl.core, real = { install: core.install.bind(core), openModel: core.openModel.bind(core) };
      core.install = (man, path) => {
        if (!path.startsWith(`${OTHER}/`)) return real.install(man, path);
        files.files.set(`${QLC.FORM_DEVICE}\n${path}`, Uint8Array.of(1));
        installed.push(path);
        return undefined;
      };
      core.openModel = (man, o) => real.openModel(man, o && o.context === OTHER ? { ...o, context: def } : o);
      const manifest = ctl._manifest.bind(ctl);
      ctl._manifest = async (src, base) => {
        const x = await manifest(src, base);
        if (!x.m.contexts.includes(OTHER)) { x.m.contexts.push(OTHER); x.m.files.push(...entries.map((e) => ({ ...e }))); }
        return x;
      };
      return r;
    };
    return ctl;
  };
  return { srv, def, other, log, net, controller, installed, cdn: (from = 0) => log.slice(from).filter((x) => x.host === 'cdn.test').map((x) => x.path.split('/sdk/')[1].split('/').slice(1).join('/')) };
}

// One page load on `d`: the loader's Client, then `fn(client)`, then the page is gone.
async function page(d, fn) {
  const p = installPage({ controller: () => d.controller() });
  let client = null;
  try {
    client = await TajweedClient.create({ key: d.srv.apiKey });
    return await fn(client);
  } finally {
    if (client) await client.close().catch(() => {});
    p.close();
  }
}

// the connection of a case: navigator.connection and navigator.onLine as the browser reports them, and the servers
function network(d, conn, c) {
  const off = c.connection === 'none';
  conn.set(CONNECTIONS[c.connection](c.data_saver), !off);
  d.net.offline = off;
}

const ENGINE_FILES = (d) => d.srv.manifest.files.filter((f) => f.context === d.def).map((f) => f.path);

for (const c of WEB) {
  // update_metered needs a second protected build (the 3.x path replays it: test/api_delivery.test.mjs); the upload is
  // the sharing pipeline's (test/sharing_no_wait.test.mjs)
  const why = c.call === 'update' ? 'a newer protected build is needed (replayed on the 3.x path, test/api_delivery.test.mjs)'
    : c.call === 'upload' ? 'replayed with the sharing pipeline (test/sharing_no_wait.test.mjs)' : skip;
  test(`no_wait_40.json ${c.name}: ${c.about}`, { skip: why }, async () => {
    const d = await device();
    const conn = connectionStandIn(null, true);
    try {
      // what is on the device first: the default context, installed by prefetch() on Wi-Fi
      if (c.on_device && c.on_device[d.def] === 'complete') {
        conn.set(CONNECTIONS.unmetered(false), true);
        await page(d, async (client) => { assert.equal((await client.prefetch()).complete, true); });
      }
      // a session with no network: the page opened its model on Wi-Fi, then the network went (the page holds its token)
      const later = c.call === 'session' && c.connection === 'none';
      if (!later) network(d, conn, c);
      const from = d.log.length;
      conn.reads = 0;
      await page(d, async (client) => {
        if (c.call === 'model') {
          if (c.outcome === 'opens') {
            const m = await client.model();
            assert.equal(m.defaultContext, d.def);
            for (const f of ENGINE_FILES(d)) assert.ok(d.cdn(from).some((p) => p === f || p.startsWith(f)), `${f} was asked for`);
          } else {
            const e = await client.model().then(() => null, (x) => x);
            assert.equal(e && e.code, c.code);
            assert.equal(e.errorCause && e.errorCause.needs, c.needs);
          }
        } else if (c.call === 'prefetch') {
          const r = await client.prefetch();
          assert.equal(r.complete, true);
          assert.ok(r.bytesDone > 0 && r.bytesDone === r.bytesTotal, JSON.stringify(r));
          for (const f of ENGINE_FILES(d)) assert.ok(d.cdn(from).some((p) => p === f || p.startsWith(f)), `${f} was asked for`);
        } else if (c.call === 'session') {
          const model = await client.model();
          assert.ok(model.contexts.includes(OTHER));
          if (later) network(d, conn, c);
          const mark = d.log.length;
          const s = model.session({ context: OTHER });
          if (c.outcome === 'opens') {
            s.push(noise(2));
            assert.ok(await s.finish(), 'the take ran to its end');
            // the other context's four files, each asked once, from the CDN; nothing of the default context again
            const asked = d.cdn(mark);
            assert.deepEqual([...asked].sort(), [...d.other.keys()].sort(), JSON.stringify(asked));
            assert.deepEqual(d.installed.sort(), [...d.other.keys()].map((p) => p.replace(/\.qle$/, '')).sort());
          } else {
            const e = await s.finish().then(() => null, (x) => x);
            assert.equal(e && e.code, c.code, e && `${e.code}: ${e.message}`);
            assert.deepEqual(e.errorCause, { stage: 'download', reason: 'network', needs: c.needs });
            assert.ok(Object.isFrozen(e.errorCause));
            assert.ok(d.cdn(mark).every((p) => p.startsWith(`${OTHER}/`)), 'only the other context\'s files were asked for');
          }
        } else assert.fail(`a call this test does not know: ${c.call}`);
        // the SDK never read the connection to decide anything (the page or the frame); diagnose() reports it
        assert.equal(conn.reads, 0, 'navigator.connection was never read');
        const dg = await client.diagnose();
        assert.equal(dg.connection, c.connection === 'none' ? 'none' : c.connection);
      });
      if (c.requests === true) assert.ok(d.log.length > from, 'requests were sent');
    } finally { conn.restore(); }
  });
}

test('an older page\'s prefetch({ unmeteredOnly: true }) on mobile data with the data saver on: the option is gone, the files download', { skip }, async () => {
  const d = await device();
  const conn = connectionStandIn(CONNECTIONS.metered(true), true);
  try {
    await page(d, async (client) => {
      const r = await client.prefetch({ unmeteredOnly: true });
      assert.equal(r.complete, true, JSON.stringify(r));
      assert.ok(r.bytesDone > 0 && r.bytesDone === r.bytesTotal);
      for (const f of ENGINE_FILES(d)) assert.ok(d.cdn().some((p) => p === f || p.startsWith(f)), `${f} was asked for`);
      assert.equal(conn.reads, 0, 'navigator.connection was never read');
    });
  } finally { conn.restore(); }
});

test('the 4.0.1 report on the web: default context installed, a session on c24_l256 on mobile data downloads its files, then a second take downloads nothing', { skip }, async () => {
  const d = await device();
  const conn = connectionStandIn(CONNECTIONS.unmetered(false), true);
  try {
    await page(d, async (client) => { assert.equal((await client.prefetch()).complete, true); });
    conn.set(CONNECTIONS.metered(false), true);
    conn.reads = 0;
    await page(d, async (client) => {
      const model = await client.model();
      for (let take = 0; take < 2; take++) {
        const mark = d.log.length;
        const s = model.session({ context: OTHER });
        s.push(noise(2, take + 3));
        await s.finish();
        const asked = d.cdn(mark);
        if (take === 0) assert.deepEqual(asked.sort(), [...d.other.keys()].sort());
        else assert.deepEqual(asked, [], 'installed: nothing asked again');
      }
      assert.equal(conn.reads, 0);
    });
  } finally { conn.restore(); }
});

test('another context on a page that loaded with no network: the page has no token yet, so the token request is the one with no answer; needs_connection, needs model', { skip }, async () => {
  const d = await device();
  const conn = connectionStandIn(CONNECTIONS.unmetered(false), true);
  try {
    await page(d, async (client) => { assert.equal((await client.prefetch()).complete, true); });
    conn.set(CONNECTIONS.none(), false);
    d.net.offline = true;
    await page(d, async (client) => {
      // the default context opens from the device on the kept lease, offline
      const model = await client.model();
      const s = model.session({ context: OTHER });
      const e = await s.finish().then(() => null, (x) => x);
      // 4.0.1: engine_failed (the frame answered the token request's TypeError as invalid_argument, and the page's
      // Session took any answer of the frame for its own engine's failure)
      assert.equal(e && e.code, 'needs_connection', e && `${e.code}: ${e.message}`);
      assert.deepEqual(e.errorCause, { stage: 'attest', reason: 'network', needs: 'model' });
      // the default context still takes takes, offline
      const t = model.session();
      t.push(noise(1, 9));
      assert.ok(await t.finish());
      assert.equal(conn.reads, 0);
    });
  } finally { conn.restore(); }
});
