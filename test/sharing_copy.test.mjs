// SDK 3.1.2, the copy deck of contract 1.15.0 (SPEC 11.8): deck 2026-11-13.1, consent share-2026-11-09. Every
// string is the string of deck 2026-11-09.1; the sentence that deck 2026-11-12.1 added to `sheet.who` and
// `what.detail` is not in it. SDK 4.0 bundles deck 2026-11-19.1: those strings and the three of the re-ask card
// (SHARE_ASK_40 20.7: `card.line`, `card.open`, `card.not_now`), without the four `sheet.guardian.*` strings
// (ONE_SHEET_40 26.1: one sheet for every app), under the same consent version.
//
//   - the bundled decks are the contract's: each file's SHA-256 is the one sharing_copy/READY gives, and with the
//     contract's folder at hand (SHARING_COPY_DIR=<contract>/sharing_copy) every bundled field is the file's;
//   - the sheet the SDK shows, in each of the eight languages, holds the deck's `sheet.who` whole as one of its
//     lines (the first ask and the re-ask), and the settings' "What is shared" holds `what.detail` whole:
//     with a stand-in for the page's DOM (runs everywhere) and in headless Chrome (where a developer has it;
//     the public runner has no browser);
//   - nothing the SDK shows or hands to an app holds the sentence that deck 2026-11-12.1 added, in any of the
//     eight languages. The sentence is not in this repository: test/sharing/deck_fragments.json has its length
//     in UTF-8 bytes and its SHA-256 per language (made from the contract's archive by
//     test/sharing/deck_fragments.mjs), and the test hashes every window of that length of what is shown.
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
import { copyFor } from '../web/consent/copy.js';
import { QuranLabConsent, QuranLabSharingSettings } from '../web/consent/element.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGS = ['ar', 'bn', 'en', 'fr', 'id', 'ms', 'tr', 'ur'];
// sharing_copy/READY of deck 2026-11-19.1
const READY = {
  en: '4011ed13cb1683348cc2d26c8b5a6adf96ebeb4bc5143cb77eb72104d5992d21',
  ar: '1159dff6482b974798d46686855c0ff0b90293f4ee7bc9890b17c76596cfc474',
  id: 'ddd02973988f286e007a9fc5e0a979b16766c43cb6d276a64ea7b59c7f17483f',
  ms: '502835016af3430f898b669cb986ac87cbec4aa89fc10849ea33fe1226d93bcb',
  tr: 'faabab1693a40f2f9c12a94808e0d7840e66094c3cf32db1bf1695fee48008f0',
  fr: '03b2026cef95cc4707a841d53e08596fa18af343c9e33ee57feffd373b8411f7',
  ur: '9dec0fd78c867a08aac9a641849ab628b441f2dae88102392b1855f9931aee05',
  bn: 'ef6ebcac7798a5e3f2c6c6bc930518e1d7290b2a29821dc83865e7c3249ef949',
};
const DIR = process.env.SHARING_COPY_DIR || '';

// The sentence that deck 2026-11-12.1 added, by length and hash only (test/sharing/deck_fragments.json).
const FRAGMENTS = JSON.parse(readFileSync(new URL('./sharing/deck_fragments.json', import.meta.url), 'utf8'));
/** The byte offsets where `text` holds one of the fragments ({ bytes, sha256 }): every window of a fragment's
 * length over the text's UTF-8 bytes is hashed. An empty list: the text holds none. */
function windowsWith(fragments, text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const found = [];
  for (const f of fragments) {
    for (let i = 0; i + f.bytes <= bytes.length; i++) {
      if (createHash('sha256').update(bytes.subarray(i, i + f.bytes)).digest('hex') === f.sha256) found.push(i);
    }
  }
  return found;
}
const findFragments = (lang, text) => windowsWith(FRAGMENTS.languages[lang], text);
/** Every string of a deck's `strings` (a plural line is several). */
const stringsOf = (strings) => Object.values(strings).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)));

test('the bundled decks are the contract\'s 2026-11-19.1 (consent share-2026-11-09), by the SHA-256 of each file', () => {
  assert.deepEqual(Object.keys(DECKS).sort(), LANGS);
  for (const l of LANGS) {
    assert.deepEqual(DECK_SOURCES[l], { file: `${l}.json`, sha256: READY[l] }, l);
    assert.deepEqual([DECKS[l].version, DECKS[l].consent_version], ['2026-11-19.1', 'share-2026-11-09'], l);
  }
});

test('deck 2026-11-19.1 has no sheet.guardian.* string in any language (ONE_SHEET_40 26.1, SCHEMA.md Removed keys), and the SDK gives none', () => {
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(DECKS[l].strings).filter((k) => /guardian/.test(k)), [], l);
    for (const k of ['sheet.guardian.title', 'sheet.guardian.body', 'sheet.guardian.confirm', 'sheet.guardian.share']) {
      assert.equal(copyFor(l).has(k), false, `${l} ${k}`);
      assert.equal(copyFor(l).t(k), undefined, `${l} ${k}: no English fallback either`);
    }
  }
});

test('every deck has the re-ask card\'s three strings: its "Not now" is the sheet\'s word for word, its button no longer than the sheet\'s share button, no dash', () => {
  assert.deepEqual([DECKS.en.strings['card.line'], DECKS.en.strings['card.open'], DECKS.en.strings['card.not_now']],
    ['Your recitation today could help another learner tomorrow.', 'See how it helps', 'Not now'], 'the English source (SHARE_ASK_40 20.7)');
  for (const l of LANGS) {
    const s = DECKS[l].strings, c = copyFor(l);
    for (const k of ['card.line', 'card.open', 'card.not_now']) {
      assert.ok(typeof s[k] === 'string' && s[k].trim() === s[k] && s[k].length > 0, `${l} ${k}`);
      assert.doesNotMatch(s[k], /[–—]/, `${l} ${k}: an en or em dash`);
      assert.equal(c.t(k), s[k], `${l} ${k}: as the SDK gives it`);
    }
    assert.equal(s['card.not_now'], s['sheet.not_now'], `${l}: the card's Not now is the sheet's`);
    assert.ok(s['card.open'].length <= s['sheet.share'].length, `${l}: card.open is no longer than sheet.share`);
  }
});

test('the fragment file is for the bundled deck, with one length and one SHA-256 for each of the eight languages', () => {
  assert.deepEqual([FRAGMENTS.format, FRAGMENTS.archived, FRAGMENTS.bundled], ['quranlab.deck-fragments/1', '2026-11-12.1', DECKS.en.version]);
  assert.deepEqual(Object.keys(FRAGMENTS.languages).sort(), LANGS);
  for (const l of LANGS) {
    assert.ok(FRAGMENTS.languages[l].length >= 1, l);
    for (const f of FRAGMENTS.languages[l]) {
      assert.ok(Number.isInteger(f.bytes) && f.bytes >= 40, `${l}: a length`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${l}: a hash`);
    }
  }
  // the search itself, shown on a text that is in the deck: found at the start, in the middle and at the very end
  // of what is searched, in a script of several bytes a letter too, and not found when one byte differs
  for (const l of ['en', 'ar', 'bn']) {
    const part = Buffer.from(DECKS[l].strings['sheet.what'], 'utf8');
    const mark = [{ bytes: part.length, sha256: createHash('sha256').update(part).digest('hex') }];
    const text = DECKS[l].strings['sheet.what'];
    assert.deepEqual(windowsWith(mark, `${text}<li>${text}</li>abc${text}`), [0, part.length + 4, 2 * part.length + 12], l);
    assert.deepEqual(windowsWith(mark, text.slice(1) + text.slice(0, -1)), [], `${l}: not found when it is not whole`);
  }
});

test('what an app is handed to show holds none of the sentence that deck 2026-11-12.1 added: every string of the eight decks, and sheet.who and what.detail as the SDK gives them', () => {
  const found = [];
  for (const l of LANGS) {
    const copy = copyFor(l);
    assert.equal(copy.t('sheet.who'), DECKS[l].strings['sheet.who'], `${l}: sheet.who as the SDK gives it is the deck's, whole`);
    assert.equal(copy.t('what.detail'), DECKS[l].strings['what.detail'], `${l}: what.detail`);
    for (const key of ['sheet.who', 'what.detail']) if (findFragments(l, copy.t(key)).length) found.push(`${l} ${key}`);
    if (stringsOf(DECKS[l].strings).some((v) => findFragments(l, v).length)) found.push(`${l} (a string of the deck)`);
  }
  assert.deepEqual(found, [], 'the strings that hold the sentence deck 2026-11-12.1 added');
});

test('with the contract\'s folder: READY names these hashes, and every bundled field is the file\'s', { skip: DIR && existsSync(path.join(DIR, 'READY')) ? false : 'SHARING_COPY_DIR is not set (the contract\'s sharing_copy folder)' }, () => {
  const ready = readFileSync(path.join(DIR, 'READY'), 'utf8');
  assert.match(ready, /version 2026-11-19\.1 consent_version share-2026-11-09/);
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

test('the sheet in each of the eight languages shows the deck\'s sheet.who whole; "What is shared" shows what.detail whole; neither holds the sentence that deck 2026-11-12.1 added (a stand-in for the DOM)', async () => {
  const found = [];
  for (const l of LANGS) {
    const s = DECKS[l].strings;
    for (const variant of ['first', 'reask']) {
      const el = new QuranLabConsent();
      const { shadow, fire } = standIn(el);
      const answer = el.show({ lang: l, variant });
      const items = itemsOf(shadow.innerHTML, 'li');
      assert.ok(items.includes(s['sheet.who']), `${l} ${variant}: sheet.who whole`);
      assert.ok(items.includes(s['sheet.what']) && items.includes(s['sheet.control']), `${l}: the other disclosure lines`);
      // everything the element wrote (its whole markup, as text)
      if (findFragments(l, unescape(shadow.innerHTML)).length) found.push(`${l} ${variant} sheet`);
      fire('#no click');
      assert.deepEqual(await answer, { yes: false });
    }
    const settings = new QuranLabSharingSettings();
    const { shadow } = standIn(settings, { lang: l });
    settings.controller = { state: { sharing: true }, recoveryCode: () => null, lang: l, wording: null, theme: null };
    const details = itemsOf(shadow.innerHTML, 'p');
    assert.ok(details.includes(s['what.detail']), `${l}: what.detail whole`);
    if (findFragments(l, unescape(shadow.innerHTML)).length) found.push(`${l} "What is shared"`);
  }
  assert.deepEqual(found, [], 'what is shown that holds the sentence deck 2026-11-12.1 added');
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
window.read = async (lang, variant) => {
  const p = QuranLabConsent.ask({ lang, variant });
  const el = document.querySelector('quranlab-consent');
  const out = { items: [...el.shadowRoot.querySelectorAll('li')].map((x) => x.textContent), dir: el.shadowRoot.querySelector('dialog').dir,
    sheetText: el.shadowRoot.querySelector('dialog').innerText + ' | ' + el.shadowRoot.textContent };
  el.shadowRoot.querySelector('#no').click();
  out.answer = await p;
  const s = document.createElement('quranlab-sharing-settings');
  s.setAttribute('lang', lang);
  document.body.appendChild(s);
  s.controller = { state: { sharing: true }, recoveryCode: () => null, lang, wording: null, theme: null };
  out.detail = s.shadowRoot.querySelector('details p').textContent;
  out.settingsText = s.shadowRoot.textContent;
  s.remove();
  return out;
};
window.ready = true;
</script>`;

test('in headless Chrome: the sheet in each of the eight languages shows the deck\'s sheet.who whole (first ask and re-ask), "What is shared" shows what.detail whole; neither holds the sentence that deck 2026-11-12.1 added', { skip: skipBrowser, timeout: 300000 }, async (t) => {
  const found = [];
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
      for (const variant of ['first', 'reask']) {
        const r = await page.evaluate((lang, v) => window.read(lang, v), l, variant);
        assert.ok(r.items.includes(s['sheet.who']), `${l} ${variant}: sheet.who whole`);
        assert.equal(r.dir, DECKS[l].dir, l);
        assert.deepEqual(r.answer, { yes: false });
        assert.equal(r.detail, s['what.detail'], `${l}: what.detail whole`);
        // all the text of the open sheet (as laid out, and every text node) and of the settings element
        if (findFragments(l, r.sheetText).length) found.push(`${l} ${variant} sheet`);
        if (findFragments(l, r.settingsText).length) found.push(`${l} ${variant} "What is shared"`);
      }
    }
    assert.deepEqual(found, [], 'what is shown that holds the sentence deck 2026-11-12.1 added');
    t.diagnostic('Chrome: the sheet (first ask and re-ask) and "What is shared" in ar, bn, en, fr, id, ms, tr, ur');
  } finally {
    await browser.close();
    server.close();
  }
});
