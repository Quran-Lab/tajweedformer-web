// Sharing in a real browser (headless Chrome through puppeteer-core): the libopus module loads lazily
// from dist/, the outbox lives in IndexedDB, a stub fetch stands in for qlab-api and R2. A finished
// session uploads whole; a session left open when the page is closed is recovered and uploaded after
// a reload (the IndexedDB outbox resumes on the next load). Since 2.0.3: two takes in a row are one
// recording with its take list, and a hidden page closes the open recording. Skipped without Chrome or
// puppeteer-core (CHROME_PATH picks the browser).
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
const skip = !existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs')) ? 'opus module not built'
  : !puppeteer ? 'no puppeteer-core' : !existsSync(CHROME) ? `no Chrome at ${CHROME}` : false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const PAGE = `<!doctype html><meta charset="utf-8"><title>sharing</title><script type="module">
import * as S from '/web/sharing/index.js';
window.S = S;
// a stub qlab-api and R2 that keeps its state in localStorage, so it survives the reload
const kv = (k, d) => JSON.parse(localStorage.getItem(k) || JSON.stringify(d));
const put = (k, v) => localStorage.setItem(k, JSON.stringify(v));
window.stubFetch = async (url, init = {}) => {
  const u = new URL(url);
  const log = kv('log', []);
  log.push([init.method || 'GET', u.pathname]);
  put('log', log);
  const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => ({ n: from + i, expires_at: Math.floor(Date.now() / 1000) + 604800,
    url: 'https://r2.test/qlab-contributions/v1/' + id + '/seg-' + String(from + i).padStart(5, '0') + '.opus?X-Amz-Signature=x' })) });
  if (u.pathname === '/v1/uploads') return new Response(JSON.stringify(urls(init.headers['x-qlab-id'], 1)), { status: 201 });
  const m = /^\\/v1\\/uploads\\/([0-9a-f]{32})\\/urls$/.exec(u.pathname);
  if (m) return new Response(JSON.stringify(urls(m[1], Number(u.searchParams.get('from')))), { status: 200 });
  if (/^\\/v1\\/uploads\\/[0-9a-f]{32}\\/takes$/.test(u.pathname)) { put('takes', kv('takes', []).concat([init.body])); return new Response(null, { status: 204 }); }
  if (u.host === 'r2.test') {
    const b = new Uint8Array(init.body);
    const objs = kv('objs', {});
    objs[u.pathname] = b.length;
    put('objs', objs);
    return new Response('', { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
window.mk = async () => S.createSharing({ api: 'https://api.test', fetch: window.stubFetch, storage: await S.indexedDbStorage('qls-test'),
  tokenProvider: async () => ({ token: 'qlt_v1.x.y', attested: false }), flags: { contributions: true, upload_trust: { web: 'capped' } },
  consentVersion: 'deck-1' });
window.noise = (n, seed) => { const x = new Float32Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; x[i] = (s / 4294967296 * 2 - 1) * 0.2; } return x; };
window.ready = true;
</script>`;

test('sharing in headless Chrome: IndexedDB outbox, lazy libopus, recovery after a reload', { skip, timeout: 300000 }, async (t) => {
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
    const ua = await page.evaluate(() => navigator.userAgent);
    // 1. a finished 25 s session at 44.1 kHz uploads whole
    const r1 = await page.evaluate(async () => {
      const sh = await window.mk();
      const t0 = performance.now();
      const s = await sh.startSession({ inputSampleRate: 44100, inputRoute: 'built_in', decode: { backend: 'exact' } });
      const loadMs = performance.now() - t0;
      const x = window.noise(44100 * 25, 7);
      const t1 = performance.now();
      for (let at = 0; at < x.length; at += 441) s.push(x.subarray(at, at + 441));
      const encodeMs = performance.now() - t1;
      const ms = await s.finish();
      // 2.0.3: the recording stays open for the next take; the app says none follows
      await sh.closeRecording();
      for (let i = 0; i < 50 && (await sh.outbox.pending()).length; i++) await sh.outbox.drain({ ignoringBackoff: true });
      const items = await sh.outbox.items();
      return { ms, loadMs, encodeMs, items, objs: JSON.parse(localStorage.getItem('objs') || '{}'), dev: S.webDevice() };
    });
    assert.equal(r1.ms, 25000);
    assert.deepEqual(r1.items.map((i) => [i.status, i.segments, i.completed]), [['uploaded', 2, true]]);
    assert.equal(Object.keys(r1.objs).length, 2);
    assert.equal(r1.dev.deviceClass, 'browser');
    t.diagnostic(`${ua.match(/Chrome\/[\d.]+/)?.[0]}: opus module ${r1.loadMs.toFixed(0)} ms to first session; 25 s at 44.1 kHz encoded in ${r1.encodeMs.toFixed(0)} ms (${(25000 / r1.encodeMs).toFixed(1)} x realtime)`);
    // 1b. 2.0.3: two takes in a row (the page's own clock and timer) are one recording with its take list; a
    // third take's recording is closed by the page becoming hidden (the pipeline listens to visibilitychange)
    const r1b = await page.evaluate(async () => {
      const sh = await window.mk();
      const take = async (seconds, seed) => {
        const s = await sh.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact' } });
        const x = window.noise(48000 * seconds, seed);
        for (let at = 0; at < x.length; at += 480) s.push(x.subarray(at, at + 480));
        await s.finish();
        return s.id;
      };
      const a = await take(6, 3);
      const b = await take(5, 4); // at once: inside the join window
      const open = !!sh.recorder.recording;
      await sh.closeRecording();
      const c = await take(3, 5);
      const openC = !!sh.recorder.recording;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      await sh.recorder.settled();
      const closedC = !sh.recorder.recording;
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      for (let i = 0; i < 50 && (await sh.outbox.pending()).length; i++) await sh.outbox.drain({ ignoringBackoff: true });
      return { a, b, c, open, openC, closedC, back: sh.recorder.backgrounded, items: (await sh.outbox.items()).filter((i) => i.id === a || i.id === c),
        takes: JSON.parse(localStorage.getItem('takes') || '[]') };
    });
    assert.equal(r1b.b, r1b.a, 'the second take joined the first take\'s recording');
    assert.notEqual(r1b.c, r1b.a);
    assert.deepEqual([r1b.open, r1b.openC, r1b.closedC, r1b.back], [true, true, true, false]);
    assert.deepEqual(r1b.items.map((i) => [i.status, i.durationMs, i.takes, i.takeList, i.completed]), [['uploaded', 11000, 2, 'sent', true], ['uploaded', 3000, 1, null, true]]);
    assert.equal(r1b.takes.length, 1, 'one take list, for the recording of two takes');
    const sent = JSON.parse(r1b.takes[0]).takes;
    assert.deepEqual([sent.length, sent[0], sent[1].start_ms], [2, { start_ms: 0, gap_ms: 0 }, 6000]);
    assert.ok(sent[1].gap_ms % 100 === 0 && sent[1].gap_ms <= 3000);
    t.diagnostic(`two takes in a row: one recording of ${r1b.items[0].durationMs} ms, take list ${r1b.takes[0]}; a hidden page closed the next one`);
    // 2. a session left open (13 s: segment 1 closed, segment 2 half written) when the page goes away
    const openId = await page.evaluate(async () => {
      const sh = await window.mk();
      window.__offline = true;
      sh.client.fetch = async () => { throw new TypeError('offline'); };
      const s = await sh.startSession({ inputSampleRate: 48000, inputRoute: 'built_in' });
      const x = window.noise(48000 * 13, 9);
      for (let at = 0; at < x.length; at += 480) s.push(x.subarray(at, at + 480));
      await s.io;
      return s.id;
    });
    await page.reload();
    await page.waitForFunction('window.ready === true');
    const r2 = await page.evaluate(async (id) => {
      const sh = await window.mk();
      await sh.outbox.resume();
      for (let i = 0; i < 50 && (await sh.outbox.pending()).length; i++) await sh.outbox.drain({ ignoringBackoff: true });
      return { item: await sh.outbox.item(id), objs: Object.keys(JSON.parse(localStorage.getItem('objs') || '{}')).filter((k) => k.includes(id)) };
    }, openId);
    assert.equal(r2.item.status, 'uploaded');
    assert.equal(r2.item.completed, false);
    assert.equal(r2.item.segments, 2);
    assert.equal(r2.objs.length, 2);
    t.diagnostic(`after a reload: the open session recovered from IndexedDB and uploaded (${r2.item.segments} segments, ${r2.item.durationMs} ms, not completed)`);
  } finally {
    await browser.close();
    server.close();
  }
});
