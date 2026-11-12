// SDK 3.1.0, the copy deck of contract 1.9.0 (SPEC 11.8): deck 2026-11-12.1, consent share-2026-11-12, whose
// `sheet.who` and `what.detail` say in every language that no human ever listens to the recordings.
//
//   - the bundled decks are the contract's: each file's SHA-256 is the one sharing_copy/READY gives, and with the
//     contract's folder at hand (SHARING_COPY_DIR=<contract>/sharing_copy) every bundled field is the file's;
//   - the sheet the SDK shows, in each of the eight languages, holds the deck's `sheet.who` whole as one of its
//     lines (the sheet and its guardian variant), and the settings' "What is shared" holds `what.detail` whole:
//     with a stand-in for the page's DOM (runs everywhere) and in headless Chrome (where a developer has it;
//     the public runner has no browser).
// That a learner who agreed to an earlier version keeps that yes is in test/sharing_consent_persist.test.mjs.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECKS, DECK_SOURCES } from '../web/consent/decks.js';
import { QuranLabConsent, QuranLabSharingSettings } from '../web/consent/element.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGS = ['ar', 'bn', 'en', 'fr', 'id', 'ms', 'tr', 'ur'];
// sharing_copy/READY of contract 1.9.0 (main 4e5bb18)
const READY = {
  en: '1600ab0625db9dab1483d1a2bfd0f0ec9e0e636880909a2d47df2eb7fefd52c0',
  ar: 'b8a3402a262ac0f295af5e485ae99804fcbab0dde44f403dc9f38e1bc18be5f0',
  id: '8d32f968b66b6b9176a3e2c152c69903a96fa20601d53f47d23cf3d20edba4f5',
  ms: '78bd9055b9c3f1ffa05efee1a15778897ee27f7d15aa1887142682d80f21848c',
  tr: '258a04a68c4e4d44739ca73da170a052cdb2a2f41914e5067314982190e0b9d9',
  fr: 'aba381efd20462db4864e8328b9a2f231597ffbffac7f42096b89e59e0950be2',
  ur: '6d50705ea642f30711207b7093337a15cb7afba5d12b5c4d80bf0fe7e192c1d1',
  bn: '56225ba6ebe642793b288d13b82874f9ada8184df8e83ea679aac3ca28a01acb',
};
const DIR = process.env.SHARING_COPY_DIR || '';

test('the bundled decks are the contract\'s 2026-11-12.1 (consent share-2026-11-12), by the SHA-256 of each file', () => {
  assert.deepEqual(Object.keys(DECKS).sort(), LANGS);
  for (const l of LANGS) {
    assert.deepEqual(DECK_SOURCES[l], { file: `${l}.json`, sha256: READY[l] }, l);
    assert.deepEqual([DECKS[l].version, DECKS[l].consent_version], ['2026-11-12.1', 'share-2026-11-12'], l);
  }
  assert.match(DECKS.en.strings['sheet.who'], /No human ever listens to your recordings: only software learns from them\.$/);
  assert.match(DECKS.en.strings['what.detail'], /No human ever listens to your recordings: only software learns from them\./);
});

test('with the contract\'s folder: READY names these hashes, and every bundled field is the file\'s', { skip: DIR && existsSync(path.join(DIR, 'READY')) ? false : 'SHARING_COPY_DIR is not set (the contract\'s sharing_copy folder)' }, () => {
  const ready = readFileSync(path.join(DIR, 'READY'), 'utf8');
  assert.match(ready, /version 2026-11-12\.1 consent_version share-2026-11-12/);
  for (const l of LANGS) {
    const bytes = readFileSync(path.join(DIR, `${l}.json`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), READY[l], `${l}.json`);
    assert.ok(ready.includes(`${READY[l]} *${l}.json`), `READY lists ${l}.json`);
    const d = JSON.parse(bytes.toString('utf8'));
    for (const k of ['format', 'version', 'lang', 'dir', 'consent_version', 'delete_days', 'delete_timing', 'strings', 'hadith_source']) {
      assert.deepEqual(DECKS[l][k], d[k], `${l}: ${k}`);
    }
  }
});

// ---- the sheet, with a stand-in for the page's DOM: what the element writes into its shadow root
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const itemsOf = (html, tag) => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unescape(m[1]));

function standIn(el, attrs = {}) {
  const listeners = {};
  const node = (id) => ({ id, disabled: false, checked: false, open: false, textContent: '',
    addEventListener(type, f) { (listeners[`${id} ${type}`] = listeners[`${id} ${type}`] || []).push(f); },
    focus() {}, close() {}, showModal() {}, setAttribute() {} });
  const shadow = { innerHTML: '', querySelector: (sel) => (sel === '#rc' || sel === '#g' ? null : node(sel)) };
  el.attachShadow = () => shadow;
  el.style = { setProperty() {} };
  el.getAttribute = (k) => attrs[k] ?? null;
  return { shadow, fire: (key) => (listeners[key] || []).forEach((f) => f({ target: { checked: false } })) };
}

test('the sheet in each of the eight languages shows the deck\'s sheet.who whole, also the guardian variant; "What is shared" shows what.detail whole (a stand-in for the DOM)', async () => {
  for (const l of LANGS) {
    const s = DECKS[l].strings;
    for (const guardian of [false, true]) {
      const el = new QuranLabConsent();
      const { shadow, fire } = standIn(el);
      const answer = el.show({ lang: l, guardian });
      const items = itemsOf(shadow.innerHTML, 'li');
      assert.ok(items.includes(s['sheet.who']), `${l}${guardian ? ' guardian' : ''}: sheet.who whole`);
      assert.ok(items.includes(s['sheet.what']) && items.includes(s['sheet.control']), `${l}: the other disclosure lines`);
      fire('#no click');
      assert.deepEqual(await answer, { yes: false, guardianConfirmed: false });
    }
    const settings = new QuranLabSharingSettings();
    const { shadow } = standIn(settings, { lang: l });
    settings.controller = { state: { sharing: true, guardianVariant: false }, recoveryCode: () => null, lang: l, wording: null, theme: null };
    const details = itemsOf(shadow.innerHTML, 'p');
    assert.ok(details.includes(s['what.detail']), `${l}: what.detail whole`);
  }
});

// ---- the same in a real browser
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { puppeteer = null; }
const skipBrowser = !puppeteer ? 'no puppeteer-core' : !existsSync(CHROME) ? `no Chrome at ${CHROME}` : false;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const PAGE = `<!doctype html><meta charset="utf-8"><title>sheet</title><script type="module">
import { QuranLabConsent } from '/web/consent/element.js';
import { DECKS } from '/web/consent/decks.js';
window.DECKS = DECKS;
window.read = async (lang, guardian) => {
  const p = QuranLabConsent.ask({ lang, guardian });
  const el = document.querySelector('quranlab-consent');
  const out = { items: [...el.shadowRoot.querySelectorAll('li')].map((x) => x.textContent), dir: el.shadowRoot.querySelector('dialog').dir };
  el.shadowRoot.querySelector('#no').click();
  out.answer = await p;
  const s = document.createElement('quranlab-sharing-settings');
  s.setAttribute('lang', lang);
  document.body.appendChild(s);
  s.controller = { state: { sharing: true, guardianVariant: false }, recoveryCode: () => null, lang, wording: null, theme: null };
  out.detail = s.shadowRoot.querySelector('details p').textContent;
  s.remove();
  return out;
};
window.ready = true;
</script>`;

test('in headless Chrome: the sheet in each of the eight languages shows the deck\'s sheet.who whole (sheet and guardian variant), "What is shared" shows what.detail whole', { skip: skipBrowser, timeout: 300000 }, async (t) => {
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    const f = path.join(root, path.normalize(decodeURIComponent(p)).replace(/^([\\/])+/, ''));
    if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction('window.ready === true');
    for (const l of LANGS) {
      const s = DECKS[l].strings;
      for (const guardian of [false, true]) {
        const r = await page.evaluate((lang, g) => window.read(lang, g), l, guardian);
        assert.ok(r.items.includes(s['sheet.who']), `${l}${guardian ? ' guardian' : ''}: sheet.who whole`);
        assert.equal(r.dir, DECKS[l].dir, l);
        assert.deepEqual(r.answer, { yes: false, guardianConfirmed: false });
        assert.equal(r.detail, s['what.detail'], `${l}: what.detail whole`);
      }
    }
    t.diagnostic('Chrome: the sheet (and its guardian variant) and "What is shared" in ar, bn, en, fr, id, ms, tr, ur');
  } finally {
    await browser.close();
    server.close();
  }
});
