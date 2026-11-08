// Screenshots of the SDK's sharing sheet in headless Chrome (English, Arabic right to left, the guardian
// variant, dark mode), for a visual check before anything ships. Writes PNGs to OUT (default
// test/browser/results/).
//   node scripts/browser-consent.mjs [OUT]
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] || path.join(root, 'test/browser/results');
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;background:#e9e6dd;font-family:system-ui}</style></head><body>
<script type="module">
import { QuranLabConsent } from '/web/consent/element.js';
const q = new URLSearchParams(location.search);
QuranLabConsent.ask({ lang: q.get('lang'), variant: q.get('variant') || 'first', guardian: q.get('guardian') === '1' });
window.__ready = true;
</script></body></html>`;
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(page); return; }
  const f = path.join(root, p);
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const b = await puppeteer.launch({ executablePath: exe, headless: true });
const shots = [['en', 'first', 0, 'light', 390], ['ar', 'first', 0, 'light', 390], ['en', 'reask', 1, 'dark', 390], ['ur', 'first', 1, 'light', 1024]];
for (const [lang, variant, guardian, scheme, width] of shots) {
  const p = await b.newPage();
  await p.setViewport({ width, height: 900 });
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await p.goto(`http://127.0.0.1:${srv.address().port}/?lang=${lang}&variant=${variant}&guardian=${guardian}`);
  await p.waitForFunction(() => window.__ready && document.querySelector('quranlab-consent'));
  await new Promise((r) => setTimeout(r, 300));
  const dir = await p.evaluate(() => document.querySelector('quranlab-consent').shadowRoot.querySelector('dialog').getAttribute('dir'));
  const file = path.join(out, `consent_${lang}_${variant}${guardian ? '_guardian' : ''}_${scheme}_${width}.png`);
  await p.screenshot({ path: file });
  console.log(`${file} (dir ${dir})`);
  await p.close();
}
await b.close();
srv.close();
