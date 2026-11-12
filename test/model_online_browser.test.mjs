// SDK 3.1.0, the install record in a real browser (headless Chrome through puppeteer-core; SPEC 15.2): the
// device key is a non-extractable HMAC CryptoKey kept in IndexedDB, the records and the model files live in the
// Cache API (the SDK's default store in a browser). A record made in a page is valid after a reload; with the
// key gone no record is valid and what the cache holds is deleted; a key store that fails deletes nothing.
// SPEC 15.3: the removal a stop makes empties the model entries of the Cache API store and of an
// IndexedDB store of the SDK's name, and leaves the device key and the page's state.
// Skipped without Chrome or puppeteer-core (CHROME_PATH picks the browser): the public runner has neither, so
// this runs where a developer has Chrome. The Client's whole flow over these parts is in
// test/model_online.test.mjs (Node, memory stores).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { puppeteer = null; }
const skip = !puppeteer ? 'no puppeteer-core' : !existsSync(CHROME) ? `no Chrome at ${CHROME}` : false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const PAGE = `<!doctype html><meta charset="utf-8"><title>install</title><script type="module">
import * as I from '/web/tajweed/install.js';
import * as D from '/web/tajweed/delivery.js';
window.I = I;
window.D = D;
const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
// a tiny "build": a manifest that lists one file, stored as a real download stores them
window.fill = async (store, text) => {
  const file = enc.encode(text);
  const sum = hex(await crypto.subtle.digest('SHA-256', file));
  const manifest = enc.encode(JSON.stringify({ files: [{ path: 'a.bin', size: file.length, sha256: sum }] }));
  const build = hex(await crypto.subtle.digest('SHA-256', manifest)).slice(0, 40);
  await store.put('sha256/' + sum, file);
  await store.put('manifest/https://cdn.test/' + build + '/', manifest);
  return { build, sum };
};
// the stored device key itself, read from IndexedDB as any code of this origin could
window.storedKey = () => new Promise((res, rej) => {
  const q = indexedDB.open('quranlab-install', 1);
  q.onupgradeneeded = () => q.result.createObjectStore('keys');
  q.onerror = () => rej(q.error);
  q.onsuccess = () => { const g = q.result.transaction('keys', 'readonly').objectStore('keys').get('device'); g.onsuccess = () => { q.result.close(); res(g.result || null); }; g.onerror = () => rej(g.error); };
});
window.ready = true;
</script>`;

test('15.2 in headless Chrome: the device key is a non-extractable HMAC key in IndexedDB; a record is valid after a reload, not without the key; a failing key store deletes nothing; 15.3 the removal of a stop empties the Cache API and IndexedDB stores and nothing else', { skip, timeout: 300000 }, async (t) => {
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    const f = path.join(root, path.normalize(decodeURIComponent(p)).replace(/^([\\/])+/, ''));
    if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/');
    await page.waitForFunction('window.ready === true');
    // a first page: no key yet, so no record can be valid; the Client's download writes one (the key is made)
    const first = await page.evaluate(async () => {
      const store = window.D.defaultStore();
      const inst = new window.I.Installs({ store, deviceKey: window.I.defaultDeviceKey() });
      const b = await window.fill(store, 'the bytes of a model file');
      const before = await inst.state(b.build);
      const noKey = (await window.storedKey()) === null;
      await inst.write(b.build, 'downloading');
      const mid = await inst.state(b.build);
      await inst.write(b.build, 'installed');
      const k = await window.storedKey();
      let exported = 'exported';
      try { await crypto.subtle.exportKey('raw', k); } catch (e) { exported = e.name; }
      return { kind: store.kind, keyKind: window.I.defaultDeviceKey().kind, before, noKey, mid, after: await inst.state(b.build), build: b.build, sum: b.sum,
        key: { type: k && k.type, extractable: k && k.extractable, algorithm: k && k.algorithm.name, hash: k && k.algorithm.hash.name, usages: k && [...k.usages].sort() }, exported };
    });
    assert.deepEqual([first.kind, first.keyKind], ['cache-api', 'indexeddb']);
    assert.deepEqual([first.before, first.noKey, first.mid, first.after], [null, true, 'downloading', 'installed']);
    assert.deepEqual(first.key, { type: 'secret', extractable: false, algorithm: 'HMAC', hash: 'SHA-256', usages: ['sign', 'verify'] });
    assert.equal(first.exported, 'InvalidAccessError', 'the key cannot be exported');
    // a reload: the record is valid, and a sweep keeps the build's file
    await page.reload();
    await page.waitForFunction('window.ready === true');
    const again = await page.evaluate(async (b) => {
      const store = window.D.defaultStore();
      const inst = new window.I.Installs({ store, deviceKey: window.I.defaultDeviceKey() });
      // files carried into the cache beside it (no record)
      const stray = await window.fill(store, 'bytes that this SDK did not fetch');
      const state = await inst.state(b.build);
      const removed = await inst.sweep();
      return { state, removed, kept: (await store.keys('sha256/' + b.sum)).length, stray: (await store.keys('sha256/' + stray.sum)).length, manifests: (await store.keys('manifest/')).length };
    }, first);
    assert.deepEqual(again, { state: 'installed', removed: 2, kept: 1, stray: 0, manifests: 1 });
    // a key store that fails (IndexedDB cannot be opened): nothing is deleted
    const failing = await page.evaluate(async (b) => {
      const store = window.D.defaultStore();
      const bad = { open() { const q = {}; setTimeout(() => { q.error = new DOMException('blocked by the browser', 'UnknownError'); q.onerror && q.onerror(); }, 0); return q; } };
      const inst = new window.I.Installs({ store, deviceKey: window.I.browserDeviceKey(bad) });
      const out = { state: null, sweep: null };
      try { await inst.state(b.build); } catch (e) { out.state = e.name; }
      try { await inst.sweep(); } catch (e) { out.sweep = e.name; }
      out.kept = (await store.keys('sha256/' + b.sum)).length;
      out.record = (await store.keys('install/' + b.build)).length;
      return out;
    }, first);
    assert.deepEqual(failing, { state: 'InstallKeyError', sweep: 'InstallKeyError', kept: 1, record: 1 });
    // the key is gone (the site's IndexedDB cleared, the Cache API left): no record is valid, and the sweep deletes
    const gone = await page.evaluate(async (b) => {
      await new Promise((res, rej) => { const q = indexedDB.deleteDatabase('quranlab-install'); q.onsuccess = res; q.onerror = () => rej(q.error); q.onblocked = res; });
      const store = window.D.defaultStore();
      const inst = new window.I.Installs({ store, deviceKey: window.I.defaultDeviceKey() });
      const state = await inst.state(b.build);
      const removed = await inst.sweep();
      return { state, removed, left: (await store.keys('')).length };
    }, first);
    assert.deepEqual(gone, { state: null, removed: 3, left: 0 });
    // a stop removes the models (SPEC 15.3, contract 1.10.0): every model entry of the Cache API store and of an
    // IndexedDB store of the SDK's name (the other kind of store), and nothing else: the device key in its own
    // IndexedDB database and the page's state in localStorage stay
    const removal = await page.evaluate(async () => {
      const store = window.D.defaultStore();
      const inst = new window.I.Installs({ store, deviceKey: window.I.defaultDeviceKey() });
      const b = await window.fill(store, 'the bytes of a model file');
      await inst.write(b.build, 'installed'); // the device key is made again
      const idb = window.D.indexedDbStore();
      await idb.put('sha256/' + b.sum, new Uint8Array([1, 2, 3]));
      await idb.put('part/' + b.sum + '/0', new Uint8Array([4]));
      localStorage.setItem('quranlab.sharing.v1', '{"consent":"declined"}');
      localStorage.setItem('quranlab.model.refused', '{"reason":"key_revoked"}');
      const before = { cache: (await store.keys('')).length, idb: (await idb.keys('')).length };
      const removed = await window.I.removeAllModels(store);
      return { before, removed, cache: (await store.keys('')).length, idb: (await idb.keys('')).length,
        key: (await window.storedKey()) !== null,
        kept: [localStorage.getItem('quranlab.sharing.v1'), localStorage.getItem('quranlab.model.refused')] };
    });
    assert.deepEqual(removal, { before: { cache: 3, idb: 2 }, removed: 5, cache: 0, idb: 0, key: true,
      kept: ['{"consent":"declined"}', '{"reason":"key_revoked"}'] });
    t.diagnostic('Chrome: a non-extractable HMAC key in IndexedDB; records in the Cache API valid across a reload, not without the key; a removal empties the Cache API and IndexedDB stores and keeps the key and the state');
  } finally {
    await browser.close();
    server.close();
  }
});
