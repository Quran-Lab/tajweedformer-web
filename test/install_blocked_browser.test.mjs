// SDK 3.1.2 (SPEC 15.2 as of contract 1.14.0), in a REAL browser: a browser whose storage is there and blocked
// runs the model and downloads it at every page load; a browser whose storage works keeps its model; a key store
// that opened and then fails on a read is still an error that opens, deletes and downloads nothing.
//
// WHERE THIS RUNS: headless Chrome through puppeteer-core, with a throwaway profile in the system's temp folder.
// "Blocked" is the browser's own setting, not a stand-in: the profile's cookie setting is "block" (Chrome's
// "Block all cookies and site data", the content setting profile.default_content_setting_values.cookies = 2).
// In that profile the page itself reads, before the SDK runs, what the browser answers, and the test fails when
// the storage is not blocked (so it cannot pass by not testing). What Chrome 157 and Edge 157 answer there:
// indexedDB.open fails on its request with UnknownError, every call of CacheStorage rejects with SecurityError,
// and the localStorage getter throws SecurityError.
//   CHROME_PATH        picks the browser (Chrome, or Edge: the same engine and the same setting)
//   TAJWEED_BROWSER=firefox with FIREFOX_PATH: Firefox, with network.cookie.cookieBehavior = 2 (all cookies
//                      blocked), where indexedDB.open THROWS SecurityError. Only the blocked test runs there.
// What is real: the browser, its storage and its refusals, the SDK's modules as a page loads them (web/), the
// Client with its default state, store and key store. What is a stand-in: Quran Lab's API and CDN (the stub of
// test/helpers/model3.mjs behind this test's HTTP server), the model (the synthetic signed build) and the engine
// (the fake host of test/helpers/fakehost.mjs: a take's frames decode to the tokens the audio was made from).
// The real engine and a real model in a browser with blocked storage: STORAGE=blocked npm run test:browser.
// Skipped without the browser or puppeteer-core: the public runner has neither.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build3, stubPlatform, KEY, testKeyHex, CLIP_TOKENS } from './helpers/model3.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FIREFOX = process.env.TAJWEED_BROWSER === 'firefox';
const BINARY = FIREFOX ? (process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe')
  : (process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { puppeteer = null; }
const skip = !puppeteer ? 'no puppeteer-core' : !existsSync(BINARY) ? `no browser at ${BINARY}` : false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const PAGE = `<!doctype html><meta charset="utf-8"><title>blocked storage</title><script type="module">
import { createClient } from '/web/api/client.js';
import { fakeHost, audioFor } from '/test/helpers/fakehost.mjs';
// what this browser's storage answers, read without the SDK
window.storageState = async () => {
  const out = {};
  try { localStorage.getItem('probe'); out.localStorage = 'works'; } catch (e) { out.localStorage = 'thrown ' + e.name; }
  try { await caches.has('probe'); out.cacheStorage = 'works'; } catch (e) { out.cacheStorage = 'rejected ' + e.name; }
  out.indexedDB = await new Promise((res) => {
    let q;
    try { q = indexedDB.open('probe', 1); } catch (e) { res('thrown ' + e.name); return; }
    q.onerror = (ev) => { ev.preventDefault(); res('request ' + q.error.name); };
    q.onsuccess = () => { q.result.close(); res('works'); };
  });
  return out;
};
window.errors = [];
addEventListener('error', (e) => window.errors.push('error: ' + e.message));
addEventListener('unhandledrejection', (e) => window.errors.push('unhandled rejection: ' + ((e.reason && e.reason.message) || e.reason)));
let client = null;
const fail = (e) => ({ failed: (e && e.code) || (e && e.name) || 'error', message: String((e && e.message) || e) });
// the app's start: a Client, the model, one take
window.start = async (cfg) => {
  try {
    const seams = { apiUrl: location.origin, modelsUrl: location.origin + '/models', modelKeys: [cfg.modelKey],
      trustedKeys: [Uint8Array.from(atob(cfg.pub), (c) => c.charCodeAt(0))], host: fakeHost() };
    client = await createClient({ key: cfg.key, appVersion: '1.0' }, seams);
    const model = await client.model();
    const session = model.session();
    const tokens = [];
    const reading = (async () => {
      for await (const c of session.chunks) {
        const lp = c.heads.get('log_probs');
        if (!lp) continue; // the chunk that closes the take carries no frames
        for (let f = 0; f < lp.frames; f++) { let best = 0; for (let k = 1; k < lp.classes; k++) if (lp.values[f * lp.classes + k] > lp.values[f * lp.classes + best]) best = k; tokens.push(best); }
      }
    })();
    session.push(audioFor(cfg.clip));
    await session.finish();
    await reading;
    return { build: model.build, tokens };
  } catch (e) { return fail(e); }
};
// the other calls an app makes around the model
window.around = async () => {
  try {
    const storage = await client.storage();
    const diagnose = await client.diagnose();
    await client.removeModels();
    const again = (await client.model()).build;
    await client.close();
    return { models: storage.models.length, lastError: diagnose.lastError, again };
  } catch (e) { return fail(e); }
};
window.model = async () => { try { return { build: (await client.model()).build }; } catch (e) { return fail(e); } };
window.close = async () => { await client.close(); };
// the key store's database, made again WITHOUT its object store: it opens, and every read on it fails
window.breakKeyStore = () => new Promise((res, rej) => {
  const d = indexedDB.deleteDatabase('quranlab-install');
  d.onerror = () => rej(d.error);
  d.onsuccess = () => { const q = indexedDB.open('quranlab-install', 1); q.onerror = () => rej(q.error); q.onsuccess = () => { q.result.close(); res(true); }; };
});
window.cacheEntries = async () => (await (await caches.open('quranlab-tajweedformer-v1')).keys()).length;
window.ready = true;
</script>`;

// this test's HTTP server: the page and the SDK's modules as files, and Quran Lab's API and CDN (the stub) behind
// the same origin
async function serve(api) {
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(PAGE); return; }
      if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (u.pathname.startsWith('/v1/') || u.pathname.startsWith('/models/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (['authorization', 'x-qlab-key', 'range', 'if-none-match', 'content-type', 'x-qlab-id'].includes(k)) headers[k] = v;
        const r = await api.fetch(`https://${u.pathname.startsWith('/v1/') ? 'api' : 'cdn'}.test${u.pathname}${u.search}`,
          { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks).toString('utf8') } : {}) });
        const out = { 'cache-control': 'no-store' };
        r.headers.forEach((v, k) => { out[k] = v; });
        res.writeHead(r.status, out);
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const f = path.join(root, path.normalize(decodeURIComponent(u.pathname)).replace(/^([\\/])+/, ''));
      if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
      const b = await readFile(f);
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(b);
    } catch (_) { if (!res.headersSent) res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// a browser with a throwaway profile; `blocked`: the profile's cookie setting is "block"
async function launch({ blocked }) {
  const profile = mkdtempSync(path.join(tmpdir(), 'tf-blocked-'));
  let browser;
  if (FIREFOX) {
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: BINARY, headless: true, userDataDir: profile,
      extraPrefsFirefox: blocked ? { 'network.cookie.cookieBehavior': 2 } : {} });
  } else {
    if (blocked) {
      mkdirSync(path.join(profile, 'Default'), { recursive: true });
      writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { cookies: 2 } } }));
    }
    browser = await puppeteer.launch({ executablePath: BINARY, headless: true, userDataDir: profile, args: ['--no-sandbox', '--no-first-run'] });
  }
  const close = async () => {
    await browser.close().catch(() => {});
    for (let i = 0; i < 20; i++) { try { rmSync(profile, { recursive: true, force: true }); break; } catch (_) { await new Promise((r) => setTimeout(r, 250)); } }
  };
  return { browser, close, version: await browser.version() };
}

const build = await build3();
const cfgOf = (api) => ({ key: KEY, modelKey: testKeyHex, pub: Buffer.from(api.pub).toString('base64'), clip: CLIP_TOKENS });
const files = (api) => api.log.filter((x) => x.host === 'cdn' && x.path !== 'manifest.json').map((x) => x.path);
async function open(browser, origin) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(origin + '/');
  await page.waitForFunction('window.ready === true');
  return { page, errors };
}

test('15.2 in a real browser with its storage blocked (the cookie setting "block"): the Client gets the model and runs a take, the next page load downloads again, and nothing throws', { skip, timeout: 240000 }, async (t) => {
  const api = await stubPlatform({ build });
  const { server, origin } = await serve(api);
  const b = await launch({ blocked: true });
  try {
    const { page, errors } = await open(b.browser, origin);
    // the browser itself, before the SDK: its storage is there and blocked
    const state = await page.evaluate(() => window.storageState());
    t.diagnostic(`${b.version}, the cookie setting "block": localStorage ${state.localStorage}; CacheStorage ${state.cacheStorage}; indexedDB.open ${state.indexedDB}`);
    assert.notEqual(state.indexedDB, 'works', 'the profile blocks storage (if this fails the browser no longer takes the setting from the profile, and the test would test nothing)');
    assert.equal(state.cacheStorage, 'rejected SecurityError');
    assert.equal(state.localStorage, 'thrown SecurityError');
    assert.equal(state.indexedDB, FIREFOX ? 'thrown SecurityError' : 'request UnknownError', 'what this browser answers to indexedDB.open when blocked');
    // the first page load: the model is downloaded, verified and opened, and a take runs
    const first = await page.evaluate((cfg) => window.start(cfg), cfgOf(api));
    assert.equal(first.failed, undefined, `the first load: ${first.failed}: ${first.message}`);
    assert.equal(first.build, build.build);
    assert.deepEqual(first.tokens, CLIP_TOKENS, 'the take\'s frames');
    const asked = [...new Set(files(api))].sort();
    assert.ok(asked.length >= 4, `the files of the profile were downloaded (${asked.length})`);
    // the calls around the model work too (what is held, the report, the removal, the model again)
    api.log.length = 0;
    const around = await page.evaluate(() => window.around());
    assert.equal(around.failed, undefined, `storage(), diagnose(), removeModels(), model(): ${around.failed}: ${around.message}`);
    assert.deepEqual([around.models, around.lastError, around.again], [1, null, build.build]);
    assert.deepEqual([...new Set(files(api))].sort(), asked, 'after removeModels() the model is downloaded again');
    // the next visit: nothing was kept, the model is downloaded again, and it runs
    api.log.length = 0;
    await page.reload();
    await page.waitForFunction('window.ready === true');
    const second = await page.evaluate((cfg) => window.start(cfg), cfgOf(api));
    assert.equal(second.failed, undefined, `the second load: ${second.failed}: ${second.message}`);
    assert.deepEqual([second.build, second.tokens], [build.build, CLIP_TOKENS]);
    assert.deepEqual([...new Set(files(api))].sort(), asked, 'the second load asks for every file again');
    await page.evaluate(() => window.close());
    assert.deepEqual([...errors, ...(await page.evaluate(() => window.errors))], [], 'no error and no unhandled rejection in the page');
    t.diagnostic(`a real ${FIREFOX ? 'Firefox' : 'Chromium'} with blocked storage: model and take on both page loads, ${asked.length} files downloaded at each; the API, the CDN, the model and the engine are stand-ins`);
  } finally {
    await b.close();
    server.close();
  }
});

test('15.2 in a real browser whose storage works: the model is kept across page loads as before; a key store that opened and then fails on a read is storage_failed and nothing is deleted or downloaded', { skip: skip || (FIREFOX ? 'the Chromium run covers this' : false), timeout: 240000 }, async (t) => {
  const api = await stubPlatform({ build });
  const { server, origin } = await serve(api);
  const b = await launch({ blocked: false });
  try {
    const { page, errors } = await open(b.browser, origin);
    assert.deepEqual(await page.evaluate(() => window.storageState()), { localStorage: 'works', cacheStorage: 'works', indexedDB: 'works' });
    const first = await page.evaluate((cfg) => window.start(cfg), cfgOf(api));
    assert.equal(first.failed, undefined, `the first load: ${first.failed}: ${first.message}`);
    assert.deepEqual(first.tokens, CLIP_TOKENS);
    const asked = [...new Set(files(api))].sort();
    assert.ok(asked.length >= 4);
    await page.evaluate(() => window.close());
    // the next visit: no file is asked for (the store that works is not taken for a blocked one)
    api.log.length = 0;
    await page.reload();
    await page.waitForFunction('window.ready === true');
    const second = await page.evaluate((cfg) => window.start(cfg), cfgOf(api));
    assert.equal(second.failed, undefined, `the second load: ${second.failed}: ${second.message}`);
    assert.deepEqual(files(api), [], 'the second load asks for no file');
    await page.evaluate(() => window.close());
    // the key store opens and then fails on every read (its database has no object store): the store failed
    api.log.length = 0;
    await page.reload();
    await page.waitForFunction('window.ready === true');
    await page.evaluate(() => window.breakKeyStore());
    const entries = await page.evaluate(() => window.cacheEntries());
    assert.ok(entries >= asked.length, `the cache holds the model (${entries} entries)`);
    const broken = await page.evaluate((cfg) => window.start(cfg), cfgOf(api));
    assert.equal(broken.failed, 'storage_failed', `a failing key store: ${JSON.stringify(broken)}`);
    assert.deepEqual(api.log.filter((x) => x.host === 'cdn'), [], 'nothing was asked of the CDN');
    assert.equal(await page.evaluate(() => window.cacheEntries()), entries, 'nothing was deleted');
    // and the next call tries again, with the same answer while the store still fails
    assert.equal((await page.evaluate(() => window.model())).failed, 'storage_failed');
    assert.equal(await page.evaluate(() => window.cacheEntries()), entries);
    await page.evaluate(() => window.close());
    assert.deepEqual(errors, [], 'no page error');
    t.diagnostic(`${b.version}, storage working: the model is kept across a reload; a key store that opens and fails on a read is storage_failed, with ${entries} cache entries untouched`);
  } finally {
    await b.close();
    server.close();
  }
});
