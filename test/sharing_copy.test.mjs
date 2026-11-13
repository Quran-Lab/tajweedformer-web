// SDK 3.1.2, the copy deck of contract 1.15.0 (SPEC 11.8): deck 2026-11-13.1, consent share-2026-11-09. Every
// string is the string of deck 2026-11-09.1; the sentence that deck 2026-11-12.1 added to `sheet.who` and
// `what.detail` is not in it.
//
//   - the bundled decks are the contract's: each file's SHA-256 is the one sharing_copy/READY gives, and with the
//     contract's folder at hand (SHARING_COPY_DIR=<contract>/sharing_copy) every bundled field is the file's;
//   - the sheet the SDK shows, in each of the eight languages, holds the deck's `sheet.who` whole as one of its
//     lines (the sheet and its guardian variant), and the settings' "What is shared" holds `what.detail` whole:
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
// sharing_copy/READY of contract 1.15.0 (main 336b4de)
const READY = {
  en: '3bac94a18f4691e7fb51021e9aa4f241d409a6dc4f8f89ec22a82761ebd75051',
  ar: '03fc6aa2eed9134b5b5780ba2abcc5590c043024d0c6daf829c876742519f599',
  id: 'f0621036f69d8f3754a0dfffea58b6c99e13a22c8356ba4cece0b20c3ba9abd0',
  ms: '2c15cf8515885ef1bebe59117c61926dfd93ce406100fe2434e4b10d6c8e3e9d',
  tr: '227783a34b2fdf6870ebd5d32eafb9e3ebcf496bed44797de87b571744200099',
  fr: '9895b3eaf3e67afa250629b9ea3d93613d0298168d068fb6aba2e00450dda7ca',
  ur: '755e2b9873180336b7e06bb44c0a9910441d8ee59dced42142c8f420ae77875a',
  bn: 'e6b0a844386437838adcd0c3693ae39f93d40e5c3dba3b614c7f71574028a6b6',
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

test('the bundled decks are the contract\'s 2026-11-13.1 (consent share-2026-11-09), by the SHA-256 of each file', () => {
  assert.deepEqual(Object.keys(DECKS).sort(), LANGS);
  for (const l of LANGS) {
    assert.deepEqual(DECK_SOURCES[l], { file: `${l}.json`, sha256: READY[l] }, l);
    assert.deepEqual([DECKS[l].version, DECKS[l].consent_version], ['2026-11-13.1', 'share-2026-11-09'], l);
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
  assert.match(ready, /version 2026-11-13\.1 consent_version share-2026-11-09/);
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

test('the sheet in each of the eight languages shows the deck\'s sheet.who whole, also the guardian variant; "What is shared" shows what.detail whole; neither holds the sentence that deck 2026-11-12.1 added (a stand-in for the DOM)', async () => {
  const found = [];
  for (const l of LANGS) {
    const s = DECKS[l].strings;
    for (const guardian of [false, true]) {
      const el = new QuranLabConsent();
      const { shadow, fire } = standIn(el);
      const answer = el.show({ lang: l, guardian });
      const items = itemsOf(shadow.innerHTML, 'li');
      assert.ok(items.includes(s['sheet.who']), `${l}${guardian ? ' guardian' : ''}: sheet.who whole`);
      assert.ok(items.includes(s['sheet.what']) && items.includes(s['sheet.control']), `${l}: the other disclosure lines`);
      // everything the element wrote (its whole markup, as text)
      if (findFragments(l, unescape(shadow.innerHTML)).length) found.push(`${l}${guardian ? ' guardian' : ''} sheet`);
      fire('#no click');
      assert.deepEqual(await answer, { yes: false, guardianConfirmed: false });
    }
    const settings = new QuranLabSharingSettings();
    const { shadow } = standIn(settings, { lang: l });
    settings.controller = { state: { sharing: true, guardianVariant: false }, recoveryCode: () => null, lang: l, wording: null, theme: null };
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
window.read = async (lang, guardian) => {
  const p = QuranLabConsent.ask({ lang, guardian });
  const el = document.querySelector('quranlab-consent');
  const out = { items: [...el.shadowRoot.querySelectorAll('li')].map((x) => x.textContent), dir: el.shadowRoot.querySelector('dialog').dir,
    sheetText: el.shadowRoot.querySelector('dialog').innerText + ' | ' + el.shadowRoot.textContent };
  el.shadowRoot.querySelector('#no').click();
  out.answer = await p;
  const s = document.createElement('quranlab-sharing-settings');
  s.setAttribute('lang', lang);
  document.body.appendChild(s);
  s.controller = { state: { sharing: true, guardianVariant: false }, recoveryCode: () => null, lang, wording: null, theme: null };
  out.detail = s.shadowRoot.querySelector('details p').textContent;
  out.settingsText = s.shadowRoot.textContent;
  s.remove();
  return out;
};
window.ready = true;
</script>`;

test('in headless Chrome: the sheet in each of the eight languages shows the deck\'s sheet.who whole (sheet and guardian variant), "What is shared" shows what.detail whole; neither holds the sentence that deck 2026-11-12.1 added', { skip: skipBrowser, timeout: 300000 }, async (t) => {
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
      for (const guardian of [false, true]) {
        const r = await page.evaluate((lang, g) => window.read(lang, g), l, guardian);
        assert.ok(r.items.includes(s['sheet.who']), `${l}${guardian ? ' guardian' : ''}: sheet.who whole`);
        assert.equal(r.dir, DECKS[l].dir, l);
        assert.deepEqual(r.answer, { yes: false, guardianConfirmed: false });
        assert.equal(r.detail, s['what.detail'], `${l}: what.detail whole`);
        // all the text of the open sheet (as laid out, and every text node) and of the settings element
        if (findFragments(l, r.sheetText).length) found.push(`${l}${guardian ? ' guardian' : ''} sheet`);
        if (findFragments(l, r.settingsText).length) found.push(`${l}${guardian ? ' guardian' : ''} "What is shared"`);
      }
    }
    assert.deepEqual(found, [], 'what is shown that holds the sentence deck 2026-11-12.1 added');
    t.diagnostic('Chrome: the sheet (and its guardian variant) and "What is shared" in ar, bn, en, fr, id, ms, tr, ur');
  } finally {
    await browser.close();
    server.close();
  }
});
