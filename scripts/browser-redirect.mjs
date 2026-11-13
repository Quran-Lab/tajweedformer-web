// The token request answered with a redirect, in a real browser (SPEC 15.4: no request of the SDK follows a
// redirect). Headless Chrome loads the SDK's platform client from this checkout and makes the one API call that
// carries the developer key in a header, POST /v1/attest, against a stand-in API that answers it with a redirect to
// another origin.
//
//   node scripts/browser-redirect.mjs [<folder that holds the web/ of another version of the SDK>]
//   CHROME=<path to chrome>
//
// Three servers on this machine's loopback names:
//   the page   http://127.0.0.1:<p>   this checkout's web/ (and the other version's, when a folder is given)
//   the API    http://127.0.0.1:<a>   another origin for the page, so the call is a CORS request with a preflight;
//                                     it answers POST /v1/attest with 307 and a Location on the third server
//   elsewhere  http://localhost:<b>   "another host": it answers the preflight and the request as a server that
//                                     wants the redirect to complete would, and writes down what it is asked
//                                     (the method, the path and the NAMES of the headers, never a value)
// For each version it prints what the call gave and what "elsewhere" was asked. Exits 1 when this checkout's code
// let "elsewhere" be asked. With another version's folder it shows what that version does in the same browser.
// Needs puppeteer-core (a dev dependency). The browser it starts is the only one it closes.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const other = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (other && !existsSync(path.join(other, 'web', 'platform', 'client.js'))) { console.error(`${other} holds no web/platform/client.js`); process.exit(2); }
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const WATCHED = ['x-qlab-key', 'authorization', 'origin', 'content-type'];
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-qlab-key, authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const listen = (server, host) => new Promise((r) => (host ? server.listen(0, host, r) : server.listen(0, r)));

const elsewhereAsked = [];
const elsewhere = createServer((req, res) => {
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    elsewhereAsked.push(`${req.method} ${req.url}; headers: ${WATCHED.filter((h) => req.headers[h] !== undefined).join(', ') || 'none of the watched ones'}; body ${n} bytes`);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"token":"a token from elsewhere","expires_in":86400,"attested":false}');
  });
});
await listen(elsewhere);
const apiAsked = [];
const api = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    apiAsked.push(`${req.method} ${req.url.split('?')[0]}`);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (req.url.startsWith('/v1/attest')) { res.writeHead(307, { ...cors, location: `http://localhost:${elsewhere.address().port}/v1/attest` }); res.end(); return; }
    // the web's origin check, asked after a call without an answer: this origin is allowed
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end('{"allowed":true}');
  });
});
await listen(api, '127.0.0.1');
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript' };
const page = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><title>redirect</title>'); return; }
  const m = /^\/(this|other)\/(web\/[\w./-]+)$/.exec(p);
  const base = m && (m[1] === 'this' ? root : other);
  const f = base && !m[2].includes('..') ? path.join(base, m[2]) : null;
  if (!f || !existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
});
await listen(page, '127.0.0.1');

const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
let failed = null;
try {
  const tab = await browser.newPage();
  await tab.goto(`http://127.0.0.1:${page.address().port}/`);
  console.log(`${await browser.version()}; the page http://127.0.0.1:${page.address().port}, the API http://127.0.0.1:${api.address().port}, elsewhere http://localhost:${elsewhere.address().port}`);
  for (const which of other ? ['other', 'this'] : ['this']) {
    elsewhereAsked.length = 0;
    apiAsked.length = 0;
    const out = await tab.evaluate(async (which, apiUrl) => {
      const { QuranLab, SDK_VERSION } = await import(`/${which}/web/platform/client.js`);
      const { memoryState } = await import(`/${which}/web/platform/storage.js`);
      const ql = new QuranLab({ key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa', apiUrl, state: memoryState(), autoSend: false });
      try { const token = await ql.token(); return { version: SDK_VERSION, result: `resolved with ${token === 'a token from elsewhere' ? 'the token that ELSEWHERE gave' : 'a token'}` }; } catch (e) { return { version: SDK_VERSION, result: `failed: ${e.name}: ${e.message}` }; }
    }, which, `http://127.0.0.1:${api.address().port}`);
    console.log(`\n${which === 'this' ? 'this checkout' : `the other version (${other})`}: SDK ${out.version}`);
    console.log(`  the token request ${out.result}`);
    console.log(`  the API was asked: ${apiAsked.join(' | ')}`);
    console.log(`  elsewhere was asked: ${elsewhereAsked.length ? elsewhereAsked.join(' | ') : 'nothing'}`);
    if (which === 'this' && elsewhereAsked.length) failed = 'this checkout\'s code let the other host be asked';
    if (which === 'this' && !out.result.startsWith('failed')) failed = failed || 'this checkout\'s token request did not fail on the redirect';
  }
} finally {
  await browser.close();
  page.close(); api.close(); elsewhere.close();
}
if (failed) { console.error(`\nFAILED: ${failed}`); process.exit(1); }
console.log('\nOK: in this browser the token request answered with a redirect fails, and the other host is asked nothing');
