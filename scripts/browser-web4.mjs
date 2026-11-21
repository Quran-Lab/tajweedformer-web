// SDK 4.0 in a real browser (Playwright's Chromium, already installed on this machine; nothing is installed here):
// three local origins stand in for a site, Quran Lab's frame host and Quran Lab's API and CDN (test keys only).
//
//   http://127.0.0.1:8790   the site (allowed for the key), and http://localhost:8790 (not allowed)
//   http://127.0.0.1:8792   the frame host: /4/loader.js, /4/frame/<key> (with the per-key frame-ancestors CSP of
//                           docs/server-for-web-4.md), /4/app/<id>/..., /4/engine/<id>/... (the signed engine)
//   http://127.0.0.1:8791   the fake API and CDN (test/v4/helpers/fake-api.mjs) with CORS for the frame's origin
//
// Checks: (1) on the allowed origin the handshake completes, the frame verifies and loads the signed engine in its
// Worker, attests, leases, downloads the test build's ciphertext into the origin private file system, installs and
// opens it, and a take of pushed audio gives chunks; (2) on an origin the key does not list, the browser refuses the
// frame (frame-ancestors) and the loader reports invalid_key from the origin check; (3) a frame told to claim
// another allowed origin than its parent's sends a hello the browser never delivers; (4) model.reference.units()
// reads the build's reference data through the Core from the origin private file system (Gate C, 11-20: 4.0.0 called
// the Core with the frame's file handles closed, so it failed reference_missing in every browser with OPFS); (5) the
// first units() waits while another page of the site holds the reference file, instead of failing for good (4.0.1).
//
//   QL_TEST_BUILD=<test build sdk/v4.0> PLAYWRIGHT_CORE=<a playwright-core folder> node scripts/browser-web4.mjs
//   ED25519=absent   the frame's Worker (where the config, the engine index and the Core are) has no Ed25519 in
//                    WebCrypto, as Chrome before 137 and Safari before 17: the served worker.js starts with a few lines
//                    that make importKey, generateKey and verify answer NotSupportedError for it, and ask
//                    /probe/ed25519-refused of the frame host the first time; check (1) must pass all the same
//   CLOCK=+2d | -2d  the Worker's clock (Date.now, also the Core's wall clock) two days off the API's: check (1) must pass
//   EXPOSE_DATE=0    the stand-in API does not expose Date (as qlab-api before it lists `date` in
//                    Access-Control-Expose-Headers): with CLOCK=+2d check (1) then fails with the config expired
// Every request goes to these three local servers; nothing reaches Quran Lab.
// Needs `python scripts/build_web4.py engine ... --test-key` and `python scripts/build_web4.py hosted --test`.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
import { fakeServer } from '../test/v4/helpers/fake-api.mjs';
import { ROOT, testBuild } from '../test/v4/helpers/env.mjs';

// playwright-core: PLAYWRIGHT_CORE, else this repository's node_modules (CI installs it there), else this machine's copy
const PW = process.env.PLAYWRIGHT_CORE || (() => {
  try { return join(createRequire(import.meta.url).resolve('playwright-core/package.json'), '..'); } catch (_) { return ''; }
})();
const HOSTED = join(ROOT, 'dist', 'hosted-test', '4');
const ENGINES = join(ROOT, 'dist', 'engine');
// QL_PORT_BASE (default 8790): the five ports from it, for a machine where 8790 to 8799 are taken (the CI runner); the
// test bundle must be built for the same ports (build_web4.py hosted --test --api, --frame-base, --frame-fallback)
const PB = Number(process.env.QL_PORT_BASE) || 8790;
const SITE = `http://127.0.0.1:${PB}`, OTHER = `http://localhost:${PB}`, FRAME = `http://127.0.0.1:${PB + 2}`, API = `http://127.0.0.1:${PB + 1}`;
// the fallback host (web2.quranlab.ai in production): the same frame on another origin; DOWN: a first host that never answers
const FRAME2 = `http://127.0.0.1:${PB + 3}`, DOWN = `http://127.0.0.1:${PB + 9}`;
// a second host that never answers (4.0.1, 28.8 check 9: the frame on the third host when the first two never answer)
const DOWN2 = `http://127.0.0.1:${PB + 8}`;
const dir = testBuild();
if (!dir || !existsSync(join(HOSTED, 'loader.js')) || !existsSync(PW)) {
  console.log('skipped: needs QL_TEST_BUILD, dist/hosted-test (build_web4.py hosted --test) and playwright-core');
  process.exit(0);
}
const { chromium } = createRequire(import.meta.url)(PW);
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' };
const ENGINE_ID = readFileSync(join(ENGINES, 'LATEST'), 'utf8').trim();
const srv = await fakeServer({ cdnDir: dir, site: SITE, turnstile: 'off', cdnBase: `${API}/models`, allowed: [SITE], engineId: ENGINE_ID, contributions: true });
const allowedByKey = { [srv.apiKey]: [SITE] };

const NO_ED25519 = process.env.ED25519 === 'absent';
const CLOCK_MS = ({ '+2d': 2 * 86400000, '-2d': -2 * 86400000 })[process.env.CLOCK || ''] || 0;
const EXPOSE = process.env.EXPOSE_DATE === '0' ? 'x-qlab-signature, x-qlab-key-id, etag' : 'x-qlab-signature, x-qlab-key-id, etag, date';
// the lines worker.js starts with for ED25519=absent and CLOCK (the bundle has no import statements, so they run first)
const workerPrelude = () => (NO_ED25519 ? `(()=>{const s=crypto.subtle;let told=false;for(const [f,i] of [['importKey',2],['generateKey',0],['verify',0]]){const r=s[f].bind(s);`
  + `s[f]=(...a)=>{const x=a[i];if(x==='Ed25519'||(x&&x.name==='Ed25519')){if(!told){told=true;fetch('/probe/ed25519-refused').catch(()=>{});}`
  + `return Promise.reject(new DOMException('Unrecognized name','NotSupportedError'));}return r(...a);};}})();
` : '')
  + (CLOCK_MS ? `(()=>{const n=Date.now.bind(Date);Date.now=()=>n()+(${CLOCK_MS});})();
` : '');
const probes = [];

const servers = [];
const listen = (port, handler) => new Promise((r) => { const s = createServer(handler); s.listen(port, () => r(s)); servers.push(s); });
const file = (res, p, headers = {}) => {
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream', ...headers });
  res.end(readFileSync(p));
};

// the frame hosts (the first and the fallback): the per-key CSP of docs/server-for-web-4.md, test origins
const frameHost = (HOST) => (req, res) => {
  const u = new URL(req.url, HOST);
  const cors = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
  const m = /^\/4\/frame\/(qlk_v1_[A-Za-z0-9_-]+)$/.exec(u.pathname);
  if (m) {
    const origins = allowedByKey[m[1]] || [];
    const csp = [`frame-ancestors ${origins.length ? origins.join(' ') : "'none'"}`, "default-src 'none'", "script-src 'self' blob: 'wasm-unsafe-eval' https://challenges.cloudflare.com",
      "worker-src 'self' blob:", `connect-src 'self' ${API}`, 'frame-src https://challenges.cloudflare.com', "style-src 'self'", "base-uri 'none'", "form-action 'none'"].join('; ');
    return file(res, join(HOSTED, 'frame.html'), { 'content-security-policy': csp, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
  }
  if (u.pathname === '/4/loader.js') return file(res, join(HOSTED, 'loader.js'), cors);
  // the app files: the frame's scripts, and the sharing chunk and Opus encoder the PAGE fetches (CORS)
  if (u.pathname.startsWith('/probe/')) { probes.push(u.pathname); res.writeHead(204); res.end(); return; }
  if (u.pathname.startsWith('/4/app/') && u.pathname.endsWith('/worker.js') && workerPrelude()) {
    const p = join(HOSTED, 'app', ...u.pathname.slice(7).split('/'));
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript', ...cors });
    res.end(workerPrelude() + readFileSync(p, 'utf8'));
    return;
  }
  if (u.pathname.startsWith('/4/app/')) return file(res, join(HOSTED, 'app', ...u.pathname.slice(7).split('/')), cors);
  if (u.pathname.startsWith('/4/engine/')) return file(res, join(ENGINES, ...u.pathname.slice(10).split('/')));
  res.writeHead(404); res.end();
};
await listen(PB + 2, frameHost(FRAME));
await listen(PB + 3, frameHost(FRAME2));

// the fake API and CDN, with CORS for the frame's origin and the sites' origin check
await listen(PB + 1, async (req, res) => {
  const origin = req.headers.origin || '';
  const cors = { 'access-control-allow-origin': origin || '*', 'access-control-allow-headers': 'authorization, content-type, x-qlab-key, x-qlab-site, if-none-match',
    'access-control-allow-methods': 'GET, POST', 'access-control-expose-headers': EXPOSE };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await srv.fetch(`${API}${req.url}`, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
  const h = { ...cors };
  r.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(r.status, h);
  res.end(Buffer.from(await r.arrayBuffer()));
});

// the site: one page that runs the SDK, and one that embeds a frame claiming another origin
const page = (body) => `<!doctype html><meta charset="utf-8"><title>site</title><body><script src="${FRAME}/4/loader.js"></script><script>${body}</script></body>`;
const RUN = `(async () => {
  const out = window.__result = { steps: [] };
  try {
    const t0 = performance.now();
    // ?primary=<base>: the first host the loader tries (DOWN: one that never answers, so the fallback's frame is used);
    // ?bases=<a,b,c>: the frame's hosts in order (4.0.1: each next one after the switch time without a hello)
    const q = new URLSearchParams(location.search);
    const primary = q.get('primary') || ${JSON.stringify(FRAME)};
    const hosts = q.get('bases') ? { _frameBases: q.get('bases').split(',') } : { _frameBase: primary, _frameFallback: ${JSON.stringify(FRAME2)} };
    // the app's version and build (27.1): the frame's config requests carry them
    const client = await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, appVersion: '2.4.0', appBuild: '412', ...hosts, _switchMs: 1500, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 8000 });
    out.steps.push('client ' + Math.round(performance.now() - t0));
    out.frameOrigin = new URL(document.querySelector('iframe').src).origin;
    const t1 = performance.now();
    const model = await client.model();
    out.openMs = Math.round(performance.now() - t1);
    out.model = { version: model.version, build: model.build, tokens: model.tokens.count, calibration: !!model.calibration };
    const s = model.session({ heads: ['log_probs', 'conf'] });
    const pcm = new Float32Array(16000 * 2); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 7) * 0.02;
    for (let i = 0; i < pcm.length; i += 1600) s.push(pcm.subarray(i, i + 1600));
    let n = 0; const reader = (async () => { for await (const c of s.chunks) n++; })();
    const heads = await s.finish(); await reader;
    out.chunks = n; out.frames = heads.get('log_probs').frames;
    s.reportRecited(112, 1, 4, { outcome: { correct: true } });
    out.sharing = { available: client.sharing.isAvailable, on: client.sharing.isOn,
      elements: !!customElements.get('quranlab-consent') && !!customElements.get('quranlab-sharing-settings') };
    out.storage = await client.storage();
    out.diagnose = await client.diagnose();
    await client.close();
    out.ok = true;
  } catch (e) { out.error = { code: e.code, message: String(e.message) }; }
  out.done = true;
})();`;
// A page that claims another site: in the frame's URL (`#o=`) and in its ack's body. It does the handshake itself,
// as a loader would, and starts the Worker; the site the frame then names to the API must be this page's real origin.
const SPOOF = `(() => {
  const out = window.__result = { hellos: [] };
  const f = document.createElement('iframe');
  f.src = ${JSON.stringify(FRAME)} + '/4/frame/' + ${JSON.stringify(srv.apiKey)} + '#o=' + encodeURIComponent(${JSON.stringify(OTHER)});
  window.addEventListener('message', (e) => {
    if (e.source !== f.contentWindow || !e.data || e.data.ql !== 'hello') return;
    out.hellos.push(e.origin);
    const ch = new MessageChannel();
    f.contentWindow.postMessage({ ql: 'ack', api: 4, nonce: e.data.nonce, site: ${JSON.stringify(OTHER)}, opts: { site: ${JSON.stringify(OTHER)} } }, e.origin, [ch.port2]);
    ch.port1.onmessage = (m) => { if (m.data && m.data.id === 1) { out.init = m.data.ok; out.done = true; } };
    ch.port1.postMessage({ id: 1, op: 'init', args: {} });
  });
  document.body.appendChild(f);
  setTimeout(() => { out.done = true; }, 20000);
})();`;
// no analytics option in 4.0: create() refuses it before anything starts
const NOANALYTICS = `(async () => {
  const out = window.__result = {};
  try { await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, analytics: 'off', _frameBase: ${JSON.stringify(FRAME)}, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 6000 }); out.created = true; }
  catch (e) { out.error = { code: e.code, message: String(e.message) }; }
  out.frames = document.querySelectorAll('iframe').length;
  out.done = true;
})();`;
// no audience option in 4.0 (ONE_SHEET_40 26.1): create() refuses it, whatever its value, before anything starts
const NOAUDIENCE = `(async () => {
  const out = window.__result = { errors: [] };
  for (const audience of ['children', 'general', undefined]) {
    try { await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, audience, _frameBase: ${JSON.stringify(FRAME)}, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 6000 }); out.created = true; }
    catch (e) { out.errors.push({ code: e.code, message: String(e.message) }); }
  }
  out.frames = document.querySelectorAll('iframe').length;
  out.done = true;
})();`;
// window.open of the frame (frame-ancestors does not cover it): the opened window must start nothing
const OPEN = `(() => {
  window.__result = { opened: !!window.open(${JSON.stringify(FRAME)} + '/4/frame/' + ${JSON.stringify(srv.apiKey)}, '_blank'), done: true };
})();`;
// Timing (QL_TIMING): the first open of a site (download and install), then three model opens from the installed
// files, and the engine's compute per chunk over 20 s of audio, three takes; the Worker's own time per chunk.
const TIMING = `(async () => {
  const out = window.__result = {};
  try {
    const now = () => performance.now();
    let t = now();
    const client = await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, _frameBase: ${JSON.stringify(FRAME)}, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 6000 });
    out.clientMs = Math.round(now() - t);
    t = now();
    let model = await client.model();
    out.firstOpenMs = Math.round(now() - t);
    out.engine = (await client.diagnose()).sdk;
    out.reopenMs = [];
    for (let i = 0; i < 3; i++) { await model.close(); t = now(); model = await client.model(); out.reopenMs.push(Math.round(now() - t)); }
    const pcm = new Float32Array(16000 * 20);
    let x = 7;
    for (let i = 0; i < pcm.length; i++) { x = (x * 1103515245 + 12345) >>> 0; pcm[i] = ((x / 4294967296) - 0.5) * 0.05 + 0.02 * Math.sin(i / 9); }
    out.chunkMs = [];
    for (let r = 0; r < 3; r++) {
      const s = model.session({ heads: ['log_probs', 'timing_log_probs', 'conf'] });
      for (let i = 0; i < pcm.length; i += 1600) s.push(pcm.subarray(i, i + 1600));
      await s.finish();
      out.chunkMs.push(Math.round(s._chunkUs.reduce((a, b) => a + b, 0) / s._chunkUs.length / 10) / 100);
    }
    await client.close();
  } catch (e) { out.error = { code: e.code, message: String(e.message) }; }
  out.done = true;
})();`;
// The reference data (R3, SPEC 13.7) from the browser's own storage: the Core reads the build's reference file (device
// form, in the origin private file system) at the first units() after each open of its model. One ayah, six more, one
// the table does not have, then the first again after a take at 48 kHz (the Core's model is opened again for that rate,
// and its table with it). The client stays open: the harness reads the frame's storage, then closes it.
const REFERENCE = `(async () => {
  const out = window.__result = {};
  try {
    const client = window.__client = await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, _frameBase: ${JSON.stringify(FRAME)}, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 8000 });
    const model = await client.model();
    out.available = !!model.reference;
    let t = performance.now();
    const u = await model.reference.units(1, 1);
    out.first = { ms: Math.round(performance.now() - t), units: u.units.length, words: u.words.length, wordCount: u.wordCount, wordBar: u.units.includes(1) };
    t = performance.now();
    for (let a = 2; a <= 7; a++) await model.reference.units(1, a);
    out.sixMoreMs = Math.round(performance.now() - t);
    try { await model.reference.units(1, 99); out.ayah99 = 'answered'; } catch (e) { out.ayah99 = e.code; }
    const s = model.session({ sampleRate: 48000, heads: ['conf'] });
    const reader = (async () => { for await (const c of s.chunks) { /* drained */ } })();
    s.push(new Float32Array(48000));
    await s.finish(); await reader;
    t = performance.now();
    out.afterReopen = JSON.stringify(await model.reference.units(1, 1)) === JSON.stringify(u);
    out.afterReopenMs = Math.round(performance.now() - t);
    out.ok = true;
  } catch (e) { out.error = { code: e.code, message: String(e.message) }; }
  out.done = true;
})();`;
// Another page of the same site holding the reference file (4.0.1): the model opens, then waits for the harness, which
// takes the file's sync access handle from another Worker on the frame's origin for 1.5 s; the first units() then
// waits for the file instead of handing the Core a read that fails for the life of the model.
const REFERENCE_BUSY = `(async () => {
  const out = window.__result = {};
  try {
    const client = window.__client = await QuranLab.TajweedClient.create({ key: ${JSON.stringify(srv.apiKey)}, _frameBase: ${JSON.stringify(FRAME)}, _apiUrl: ${JSON.stringify(API)}, _timeoutMs: 8000 });
    const model = await client.model();
    out.opened = true;
    await new Promise((r) => { window.__go = r; });
    const t = performance.now();
    const u = await model.reference.units(1, 1);
    out.ms = Math.round(performance.now() - t);
    out.units = u.units.length;
    out.wordCount = u.wordCount;
    out.ok = true;
  } catch (e) { out.error = { code: e.code, message: String(e.message) }; }
  out.done = true;
})();`;
await listen(PB, (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page(req.url.startsWith('/spoof') ? SPOOF : req.url.startsWith('/open') ? OPEN : req.url.startsWith('/timing') ? TIMING : req.url.startsWith('/noanalytics') ? NOANALYTICS : req.url.startsWith('/noaudience') ? NOAUDIENCE : req.url.startsWith('/reference-busy') ? REFERENCE_BUSY : req.url.startsWith('/reference') ? REFERENCE : RUN));
});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + JSON.stringify(detail) : ''}`); };
// CHROME_PATH: a system Chromium (the CI runner's /usr/bin/chromium) instead of Playwright's own download
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {}) });
try {
  // one page in a fresh profile, or (kept) in the profile given, which keeps its storage for the next page
  const run = async (url, kept = null) => {
    const ctx = kept || await browser.newContext();
    const p = await ctx.newPage();
    const logs = [];
    p.on('console', (m) => logs.push(m.text()));
    await p.goto(url);
    await p.waitForFunction(() => window.__result && window.__result.done, null, { timeout: 120_000 });
    const r = await p.evaluate(() => window.__result);
    if (kept) await p.close(); else await ctx.close();
    return { r, logs };
  };
  const a = await run(`${SITE}/`);
  const configs = srv.state.requests.filter((r) => r.path === 'GET /v1/config');
  check('allowed origin: handshake, signed engine, lease, OPFS install, open, a take', a.r.ok === true && a.r.chunks > 0 && a.r.model.tokens === 38,
    a.r.ok ? { openMs: a.r.openMs, steps: a.r.steps, chunks: a.r.chunks, frames: a.r.frames, storage: a.r.diagnose.storage, store: a.r.storage.models[0] && a.r.storage.models[0].bytes, lease: a.r.diagnose.lease } : { error: a.r.error, logs: a.logs.slice(-5) });
  if (NO_ED25519) check('the Worker had no Ed25519 in WebCrypto (its first refusal was seen)', probes.includes('/probe/ed25519-refused'), probes);
  if (CLOCK_MS) check(`the Worker's clock ${process.env.CLOCK}: the config accepted by the server's Date, the lease by the Core's clock`, a.r.ok === true, a.r.ok ? a.r.diagnose.lease : a.r.error);
  check('the frame\'s config requests carry the app\'s version and build after the parameters of before (27.1), and diagnose names the frame\'s host (28.7)',
    configs.length > 0 && configs.every((r) => /^\?bucket=\d+&sdk=[^&]+&app_version=2\.4\.0&app_build=412$/.test(r.search)) && a.r.ok === true
      && a.r.diagnose.endpoints && a.r.diagnose.endpoints.webFrame === new URL(FRAME).host,
    { queries: [...new Set(configs.map((r) => r.search.replace(/bucket=\d+/, 'bucket=n')))], endpoints: a.r.ok ? a.r.diagnose.endpoints : a.r.error });
  check('every API call named the verified site', [...srv.state.sawSite].every((o) => o === SITE) && srv.state.sawSite.size === 1, [...srv.state.sawSite]);
  check('sharing in the page: the checked chunk loaded, the sheet elements defined, offered by the config, not on before a yes',
    !!a.r.sharing && a.r.sharing.available === true && a.r.sharing.on === false && a.r.sharing.elements === true && srv.state.pageAttests >= 1, a.r.sharing);
  const b = await run(`${OTHER}/`);
  check('an origin the key does not list: the frame is refused, invalid_key', !b.r.ok && b.r.error && b.r.error.code === 'invalid_key', b.r.error);
  const before = srv.state.requests.length;
  const c = await run(`${SITE}/spoof`);
  const sites = srv.state.requests.slice(before).map((r) => r.headers['x-qlab-site']).filter(Boolean);
  check('a site claimed in the URL and in the ack body is ignored: the frame names the parent\'s real origin',
    c.r.init === true && c.r.hellos.length === 1 && sites.length > 0 && sites.every((x) => x === SITE), { init: c.r.init, sites: [...new Set(sites)] });
  // the lease across page loads, in one profile: the second page load opens on the kept lease (the keys as
  // non-extractable CryptoKeys in the frame's IndexedDB), with no new lease
  const prof = await browser.newContext();
  const l0 = srv.state.leases;
  const k1 = await run(`${SITE}/`, prof);
  const l1 = srv.state.leases;
  const k2 = await run(`${SITE}/`, prof);
  await prof.close();
  check('a reload within the lease: the model opens on the kept lease, no new lease', k1.r.ok === true && k2.r.ok === true && l1 === l0 + 1 && srv.state.leases === l1
    && k2.r.diagnose.lease.kept === 'restored', { first: k1.r.ok ? k1.r.diagnose.lease : k1.r.error, second: k2.r.ok ? k2.r.diagnose.lease : k2.r.error, leases: srv.state.leases - l0 });
  // the first host down: the same frame on the fallback host answers after the switch time (1.5 s here, 5 s in production)
  const fb = await run(`${SITE}/?primary=${encodeURIComponent(DOWN)}`);
  check('the first host down: the fallback host\'s frame answers, leases, installs, opens, a take', fb.r.ok === true && fb.r.frameOrigin === FRAME2 && fb.r.chunks > 0,
    fb.r.ok ? { steps: fb.r.steps, frame: fb.r.frameOrigin, openMs: fb.r.openMs } : { error: fb.r.error, logs: fb.logs.slice(-5) });
  // 28.8 check 9: the first two hosts never answer; the third host\'s frame (at two switch times) is the page\'s
  const third = await run(`${SITE}/?bases=${encodeURIComponent([DOWN, DOWN2, FRAME2].join(','))}`);
  check('the first two frame hosts down: the third host\'s frame answers, leases, installs, opens, a take; diagnose names it',
    third.r.ok === true && third.r.frameOrigin === FRAME2 && third.r.chunks > 0 && third.r.diagnose.endpoints.webFrame === new URL(FRAME2).host,
    third.r.ok ? { steps: third.r.steps, frame: third.r.frameOrigin, openMs: third.r.openMs, webFrame: third.r.diagnose.endpoints.webFrame } : { error: third.r.error, logs: third.logs.slice(-5) });
  const fbo = await run(`${OTHER}/?primary=${encodeURIComponent(DOWN)}`);
  check('an origin the key does not list, with the first host down: the fallback host refuses the frame too, invalid_key', !fbo.r.ok && fbo.r.error && fbo.r.error.code === 'invalid_key', fbo.r.error);
  const na = await run(`${SITE}/noanalytics`);
  check('no analytics option in 4.0: create({ analytics }) is invalid_argument, and no frame is opened', !na.r.created && na.r.error && na.r.error.code === 'invalid_argument' && /migrating-to-4\.md/.test(na.r.error.message) && na.r.frames === 0, na.r);
  const nu = await run(`${SITE}/noaudience`);
  check('no audience option in 4.0: create({ audience }) is invalid_argument for children, general and undefined, and no frame is opened',
    !nu.r.created && nu.r.errors.length === 3 && nu.r.errors.every((e) => e.code === 'invalid_argument' && /audience option was removed/.test(e.message) && /migrating-to-4\.md/.test(e.message)) && nu.r.frames === 0, nu.r);
  // the reference data from the frame's origin private file system, in a fresh profile; the frame's storage is read
  // in the frame itself (the partition its Worker uses), so a memory fallback cannot pass
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${SITE}/reference`);
    await p.waitForFunction(() => window.__result && window.__result.done, null, { timeout: 120_000 });
    const r = await p.evaluate(() => window.__result);
    const fr = p.frames().find((f) => f.url().startsWith(`${FRAME}/4/frame/`));
    const opfs = fr ? await fr.evaluate(async () => {
      try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('quranlab-sdk4'); const n = []; for await (const k of d.keys()) n.push(k); return n.sort(); } catch (e) { return String(e); }
    }) : 'no frame';
    await p.evaluate(() => window.__client && window.__client.close()).catch(() => {});
    await ctx.close();
    const ref = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).files.find((f) => f.role === 'reference');
    const device = `2_${encodeURIComponent(ref.decoded.path)}`; // QLC_FORM_DEVICE, as stores.js names it
    check('the reference data from the browser\'s own storage (OPFS): units() of an ayah, six more, one the table does not have, again after the Core\'s model opened again at 48 kHz',
      r.ok === true && r.available === true && r.first.units > 4 && r.first.wordCount >= 4 && r.first.words === r.first.units && r.first.wordBar && r.ayah99 === 'invalid_argument'
        && r.afterReopen === true && Array.isArray(opfs) && opfs.includes(device),
      r.ok ? { first: r.first, sixMoreMs: r.sixMoreMs, ayah99: r.ayah99, afterReopen: r.afterReopen, afterReopenMs: r.afterReopenMs, opfs: Array.isArray(opfs) ? opfs.includes(device) : opfs } : { error: r.error, opfs: Array.isArray(opfs) ? opfs.includes(device) : opfs });
  }
  // the reference file held by another page of the site while the first units() asks for it: the call waits for it
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${SITE}/reference-busy`);
    await p.waitForFunction(() => window.__result && (window.__result.opened || window.__result.done), null, { timeout: 120_000 });
    const fr = p.frames().find((f) => f.url().startsWith(`${FRAME}/4/frame/`));
    const ref = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).files.find((f) => f.role === 'reference');
    const held = fr ? await fr.evaluate((name) => new Promise((res) => {
      const src = 'onmessage = async (e) => { try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("quranlab-sdk4");'
        + ' const h = await (await d.getFileHandle(e.data)).createSyncAccessHandle(); postMessage("held");'
        + ' setTimeout(() => { h.close(); postMessage("released"); }, 1500); } catch (x) { postMessage("error " + x.name); } };';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (m) => { if (m.data !== 'released') res(m.data); };
      w.postMessage(name);
    }), `2_${encodeURIComponent(ref.decoded.path)}`) : 'no frame';
    await p.evaluate(() => window.__go && window.__go());
    await p.waitForFunction(() => window.__result && window.__result.done, null, { timeout: 60_000 });
    const r = await p.evaluate(() => window.__result);
    await p.evaluate(() => window.__client && window.__client.close()).catch(() => {});
    await ctx.close();
    check('the reference file held by another page of the site (1.5 s): the first units() waits for it and reads the table',
      held === 'held' && r.ok === true && r.units > 4 && r.wordCount >= 4 && r.ms >= 1000, { held, ...(r.ok ? { ms: r.ms, units: r.units } : { error: r.error }) });
  }
  // window.open from an allowed site, and the frame's URL opened top-level: both refuse before any request
  const ctx = await browser.newContext();
  const opener = await ctx.newPage();
  const n0 = srv.state.requests.length;
  await opener.goto(`${SITE}/open`);
  const popup = await ctx.waitForEvent('page', { timeout: 20_000 });
  await popup.waitForFunction(() => document.body && document.body.dataset.refused, null, { timeout: 20_000 });
  const openedWhy = await popup.evaluate(() => document.body.dataset.refused);
  const top = await ctx.newPage();
  await top.goto(`${FRAME}/4/frame/${srv.apiKey}`);
  await top.waitForFunction(() => document.body && document.body.dataset.refused, null, { timeout: 20_000 });
  const topWhy = await top.evaluate(() => document.body.dataset.refused);
  await new Promise((r) => setTimeout(r, 1500));
  await ctx.close();
  check('window.open of the frame and the frame top-level: refused, no request made', openedWhy === 'opened' && topWhy === 'top_level' && srv.state.requests.length === n0,
    { opened: openedWhy, top: topWhy, requests: srv.state.requests.length - n0 });
  // QL_TIMING='[{"name","id","lease"}...]': each engine build in a fresh profile (an empty site storage)
  if (process.env.QL_TIMING) {
    for (const e of JSON.parse(process.env.QL_TIMING)) {
      srv.state.engineId = e.id;
      srv.state.leaseVersion = e.lease;
      const t = await run(`${SITE}/timing`);
      console.log(`TIMING ${e.name} ${JSON.stringify(t.r)}`);
    }
    srv.state.engineId = null;
    srv.state.leaseVersion = null;
  }
} finally {
  await browser.close();
  for (const s of servers) s.close();
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
