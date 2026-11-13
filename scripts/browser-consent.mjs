// Pictures of the SDK's sharing sheet in headless Chrome, for the review of its design (3.1.1: the contract's
// sharing_copy/design). Each picture is the sheet as a page shows it: light and dark, English and Arabic (and
// the other decks), the default text size and twice it (the browser's own text size, as a learner sets it),
// the guardian variant, a re-ask, a 320 px phone, a 390 by 844 phone and a 1280 by 800 desktop, on a plain page
// and on a page whose styles try to reach the sheet (`* { font-weight: 900; font-size: 30px; line-height: 3 }`).
// Writes PNGs and metrics.json (the sizes of both buttons, clipped text, the name) to OUT (default
// test/browser/results/).
//   node scripts/browser-consent.mjs [OUT] [filter]
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = process.argv[2] || path.join(root, 'test/browser/results');
const filter = process.argv[3] ? new RegExp(process.argv[3]) : null;
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME || process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');

// the page behind the sheet: an app's screen; `hostile` adds styles that a careless page might have
const HOSTILE = '* { font-weight: 900; font-size: 30px; line-height: 3 }';
const page = (hostile) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;min-height:100vh;background:#eef0ec;font-family:system-ui;color:#223}main{padding:24px}
.card{background:#fff;border-radius:16px;padding:16px;margin:12px 0;height:80px}h1{margin:0 0 8px}
@media (prefers-color-scheme: dark){body{background:#101112;color:#ddd}.card{background:#1d1f20}}
${hostile ? HOSTILE : ''}</style></head><body><main><h1>Al-Fatihah</h1><p>Your last take</p><div class="card"></div><div class="card"></div><div class="card"></div></main>
<script type="module">
import { QuranLabConsent } from '/web/consent/element.js';
const q = new URLSearchParams(location.search);
const theme = q.get('theme') ? JSON.parse(q.get('theme')) : null;
window.__answer = QuranLabConsent.ask({ lang: q.get('lang'), variant: q.get('variant') || 'first', guardian: q.get('guardian') === '1', theme });
window.__ready = true;
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }).end(page(u.searchParams.get('hostile') === '1')); return; }
  const f = path.join(root, path.normalize(decodeURIComponent(u.pathname)).replace(/^([\\/])+/, ''));
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(f));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

// name, lang, scheme, width, height, options
const P = { w: 390, h: 844 };
const shots = [
  ['01_en_light_390x844', 'en', 'light', P.w, P.h, {}],
  ['02_en_light_390x844_scrolled_to_end', 'en', 'light', P.w, P.h, { end: true }],
  ['03_en_dark_390x844', 'en', 'dark', P.w, P.h, {}],
  ['04_ar_light_390x844', 'ar', 'light', P.w, P.h, {}],
  ['05_ar_dark_390x844_scrolled_to_end', 'ar', 'dark', P.w, P.h, { end: true }],
  ['06_en_light_390x844_text200', 'en', 'light', P.w, P.h, { text: 2 }],
  ['07_en_light_390x844_text200_scrolled_to_end', 'en', 'light', P.w, P.h, { text: 2, end: true }],
  ['08_ar_light_390x844_text200', 'ar', 'light', P.w, P.h, { text: 2 }],
  ['09_en_light_390x844_guardian_off', 'en', 'light', P.w, P.h, { guardian: true, end: true }],
  ['10_en_light_390x844_guardian_on', 'en', 'light', P.w, P.h, { guardian: true, end: true, on: true }],
  ['11_ar_dark_390x844_guardian_on', 'ar', 'dark', P.w, P.h, { guardian: true, end: true, on: true }],
  ['12_en_light_390x844_reask', 'en', 'light', P.w, P.h, { variant: 'reask' }],
  ['13_en_light_320x568', 'en', 'light', 320, 568, {}],
  ['14_ar_light_320x568', 'ar', 'light', 320, 568, {}],
  ['15_en_light_320x568_text200', 'en', 'light', 320, 568, { text: 2 }],
  ['16_en_dark_320x568_text200_scrolled_to_end', 'en', 'dark', 320, 568, { text: 2, end: true }],
  ['17_en_light_1280x800', 'en', 'light', 1280, 800, {}],
  ['18_en_dark_1280x800', 'en', 'dark', 1280, 800, {}],
  ['19_ar_light_1280x800_scrolled_to_end', 'ar', 'light', 1280, 800, { end: true }],
  ['20_en_light_1280x800_text200', 'en', 'light', 1280, 800, { text: 2 }],
  ['21_en_light_390x844_hostile_page', 'en', 'light', P.w, P.h, { hostile: true }],
  ['22_ar_dark_390x844_hostile_page', 'ar', 'dark', P.w, P.h, { hostile: true }],
  ['23_en_light_1280x800_hostile_page', 'en', 'light', 1280, 800, { hostile: true }],
  ['24_en_light_390x844_guardian_hostile_page', 'en', 'light', P.w, P.h, { guardian: true, end: true, hostile: true }],
  ['25_en_light_390x844_text200_hostile_page', 'en', 'light', P.w, P.h, { text: 2, hostile: true }],
  ['26_en_light_390x1400_whole_sheet', 'en', 'light', P.w, 1400, {}],
  ['27_ar_light_390x1400_whole_sheet', 'ar', 'light', P.w, 1400, {}],
  ['28_ur_light_390x1400_whole_sheet', 'ur', 'light', P.w, 1400, {}],
  ['29_bn_light_390x1400_whole_sheet', 'bn', 'light', P.w, 1400, {}],
  ['30_fr_dark_390x1400_whole_sheet', 'fr', 'dark', P.w, 1400, {}],
  ['31_en_light_390x844_theme_light_accent_fallback', 'en', 'light', P.w, P.h, { theme: { accent: '#9FE3D2' } }],
  ['32_en_dark_390x844_theme_app_colours', 'en', 'dark', P.w, P.h, { theme: { accent: '#E3B26A', background: '#14181F', text: '#EDEFF3', secondaryText: '#A9B0BC', cornerRadius: 12 } }],
  ['33_en_light_390x844_theme_custom_properties_page', 'en', 'light', P.w, P.h, { hostile: true, theme: { accent: '#5B3FA8', bodyFont: 'Georgia, serif', titleFont: 'Georgia, serif' } }],
  ['34_en_light_390x844_guardian_as_it_opens', 'en', 'light', P.w, P.h, { guardian: true }],
  ['35_ar_light_320x568_guardian_text200_scrolled_to_end', 'ar', 'light', 320, 568, { guardian: true, text: 2, end: true }],
  ['36_en_light_390x1600_guardian_whole_sheet', 'en', 'light', P.w, 1600, { guardian: true }],
];

const b = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--hide-scrollbars=false'] });
const metrics = {};
try {
  for (const [name, lang, scheme, width, height, o] of shots) {
    if (filter && !filter.test(name)) continue;
    const p = await b.newPage();
    await p.setViewport({ width, height, deviceScaleFactor: 2 });
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    if (o.text) {
      // the browser's own text size (Chrome's Settings, Appearance, Font size): the default size of `medium`
      const cdp = await p.createCDPSession();
      await cdp.send('Page.setFontSizes', { fontSizes: { standard: 16 * o.text, fixed: 13 * o.text } });
    }
    const q = new URLSearchParams({ lang, variant: o.variant || 'first', guardian: o.guardian ? '1' : '0', hostile: o.hostile ? '1' : '0' });
    if (o.theme) q.set('theme', JSON.stringify(o.theme));
    await p.goto(`http://127.0.0.1:${srv.address().port}/?${q}`);
    await p.waitForFunction(() => window.__ready && document.querySelector('quranlab-consent') && document.querySelector('quranlab-consent').shadowRoot);
    // the opening animation ends
    await p.evaluate(() => Promise.all(document.querySelector('quranlab-consent').shadowRoot.getAnimations().map((a) => a.finished.catch(() => {}))));
    if (o.on) await p.evaluate(() => document.querySelector('quranlab-consent').shadowRoot.querySelector('#g').click());
    if (o.end) {
      await p.evaluate(() => { const s = document.querySelector('quranlab-consent').shadowRoot.querySelector('.scroll'); s.scrollTop = s.scrollHeight; });
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 150));
    metrics[name] = await p.evaluate(() => {
      const r = document.querySelector('quranlab-consent').shadowRoot;
      const box = (el) => { const x = el.getBoundingClientRect(); return [Math.round(x.left * 10) / 10, Math.round(x.top * 10) / 10, Math.round(x.width * 10) / 10, Math.round(x.height * 10) / 10]; };
      const d = r.querySelector('dialog');
      const clipped = [...r.querySelectorAll('h2, p, li, span, button')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline').map((e) => e.id || e.className || e.tagName);
      const cs = (el) => { const s = getComputedStyle(el); return `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily.split(',')[0]} ${s.color}`; };
      return { dir: d.dir, sheet: box(d), yes: box(r.querySelector('#yes')), no: box(r.querySelector('#no')), yesDisabled: r.querySelector('#yes').disabled,
        name: r.querySelector('#n').textContent, nameBox: box(r.querySelector('#n')), title: cs(r.querySelector('h2')), body: cs(r.querySelector('#b p')),
        noLabel: getComputedStyle(r.querySelector('#no')).color, yesLabel: getComputedStyle(r.querySelector('#yes')).color, colors: document.querySelector('quranlab-consent')._colors,
        clipped, focus: r.activeElement ? r.activeElement.id : null, rootFont: getComputedStyle(document.documentElement).fontSize };
    });
    const file = path.join(out, `${name}.png`);
    await p.screenshot({ path: file });
    console.log(`${file} (dir ${metrics[name].dir}, buttons ${metrics[name].yes.slice(2)} ${metrics[name].no.slice(2)}${metrics[name].clipped.length ? `, CLIPPED ${metrics[name].clipped}` : ''})`);
    await p.close();
  }
} finally {
  await b.close();
  srv.close();
}
writeFileSync(path.join(out, filter ? `metrics_${Date.now()}.json` : 'metrics.json'), JSON.stringify(metrics, null, 1));
