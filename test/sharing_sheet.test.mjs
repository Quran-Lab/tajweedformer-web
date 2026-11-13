// SDK 3.1.1, the sharing sheet's design (the contract's sharing_copy/design/README.md, 1.12.1): the same sheet on
// Apple, Android and the web. No word, no deck, no consent version and no consent rule changes with it (the
// deck lines of every language are whole on the sheet: test/sharing_copy.test.mjs, unchanged).
//
//   - with a stand-in for the page's DOM (runs everywhere): the header carries the name Quran Lab in every
//     language, before the title, left to right, out of every part a page can style; the blocks in the design's
//     order (the disclosure before the hadith, the re-ask line between the title and the body, the guardian's
//     confirmation after the hadith and no mistakes line in the guardian variant); the direction and the type
//     rules from the deck; the hadith only when the deck says where it was verified;
//   - in headless Chrome (where a developer has it; the public runner has no browser): both buttons the same
//     size in every language, viewport and text size; the share button disabled until the guardian's switch is
//     on; the direction from the deck, not from the page; a low-contrast accent takes the fallback and on-accent
//     follows the accent; a page's styles and custom properties change nothing of the sheet's type and never
//     remove the name; the browser's text size scales it; Escape is "Not now" and a click beside the sheet does
//     nothing (as in 3.1.0); focus moves in and stays in; the fades; reduced motion.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECKS } from '../web/consent/decks.js';
import { registerDeck } from '../web/consent/copy.js';
import { QuranLabConsent, SHEET_NAME, contrastRatio } from '../web/consent/element.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const LANGS = ['ar', 'bn', 'en', 'fr', 'id', 'ms', 'tr', 'ur'];

// ---- with a stand-in for the page's DOM: what the element writes into its shadow root
function standIn(el) {
  const listeners = {};
  const node = (id) => ({ id, disabled: false, checked: false, open: false, textContent: '',
    addEventListener(type, f) { (listeners[`${id} ${type}`] = listeners[`${id} ${type}`] || []).push(f); },
    focus() { focused.push(id); }, close() {}, showModal() {}, setAttribute() {} });
  const focused = [];
  const shadow = { innerHTML: '', querySelector: (sel) => (sel === '#g' ? null : node(sel)) };
  el.attachShadow = () => shadow;
  el.style = { setProperty() {} };
  el.getAttribute = () => null;
  return { shadow, focused, fire: (key) => (listeners[key] || []).forEach((f) => f({ target: { checked: false } })) };
}
async function sheetHtml(o) {
  const el = new QuranLabConsent();
  const s = standIn(el);
  const answer = el.show(o);
  const html = s.shadow.innerHTML;
  s.fire('#no click');
  assert.deepEqual(await answer, { yes: false, guardianConfirmed: false });
  return { html, focused: s.focused };
}
const unescape = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const at = (html, text) => { const i = html.indexOf(`>${esc(text)}<`); assert.ok(i >= 0, `not on the sheet: ${text.slice(0, 40)}`); return i; };

test('the header carries the name Quran Lab in every language (sheet, guardian, re-ask): a constant, left to right, before the title, in no part a page can style', async () => {
  assert.equal(SHEET_NAME, 'Quran Lab');
  for (const lang of LANGS) {
    for (const [guardian, variant] of [[false, 'first'], [true, 'first'], [false, 'reask'], [true, 'reask']]) {
      const { html, focused } = await sheetHtml({ lang, guardian, variant });
      const tag = '<span class="name" id="n" dir="ltr" tabindex="-1">Quran Lab</span>';
      assert.equal(html.split(tag).length, 2, `${lang}: the name once, as a left to right text`);
      const head = html.slice(html.indexOf('<div class="head">'), html.indexOf('</div>', html.indexOf('<div class="head">')));
      assert.match(head, /^<div class="head"><span class="emblem" aria-hidden="true"><svg /, `${lang}: the emblem first, hidden from screen readers`);
      assert.ok(!/part=/.test(head), `${lang}: no part in the header`);
      assert.ok(html.indexOf(tag) < html.indexOf('<h2 id="t"'), `${lang}: the name before the title`);
      // the name is not a deck string: the same in every language, whatever the wording
      assert.deepEqual(focused, ['#n'], `${lang}: focus on the name, the first thing of the sheet, not a button`);
    }
    const own = await sheetHtml({ lang, wording: { 'sheet.title': 'Help the next learner' } });
    assert.ok(own.html.includes('>Quran Lab</span>') && own.html.includes('>Help the next learner</h2>'));
  }
});

test('the blocks in the design\'s order: header, title, re-ask, body, the disclosure card, the hadith, mistakes; the guardian variant with its confirmation and no mistakes line; the bar last', async () => {
  for (const lang of LANGS) {
    const s = DECKS[lang].strings;
    let { html } = await sheetHtml({ lang, variant: 'reask' });
    const order = [at(html, 'Quran Lab'), at(html, s['sheet.title']), at(html, s.reask), at(html, s['sheet.body']), at(html, s['sheet.what']),
      at(html, s['sheet.who']), at(html, s['sheet.control']), at(html, s['sheet.hadith']), at(html, s['sheet.hadith_ref']), at(html, s['sheet.mistakes']),
      at(html, s['sheet.share']), at(html, s['sheet.not_now'])];
    assert.deepEqual(order, order.slice().sort((a, b) => a - b), `${lang}: order`);
    assert.ok(!html.includes(esc(s['sheet.guardian.confirm'])), `${lang}: no guardian line on the sheet`);
    ({ html } = await sheetHtml({ lang }));
    assert.ok(!html.includes(`>${esc(s.reask)}<`), `${lang}: the re-ask line only on a re-ask`);
    ({ html } = await sheetHtml({ lang, guardian: true }));
    const g = [at(html, 'Quran Lab'), at(html, s['sheet.guardian.title']), at(html, s['sheet.guardian.body']), at(html, s['sheet.what']), at(html, s['sheet.who']),
      at(html, s['sheet.control']), at(html, s['sheet.hadith']), at(html, s['sheet.guardian.confirm']), at(html, s['sheet.guardian.share']), at(html, s['sheet.not_now'])];
    assert.deepEqual(g, g.slice().sort((a, b) => a - b), `${lang} guardian: order`);
    assert.ok(!html.includes(esc(s['sheet.mistakes'])) && !html.includes(`>${esc(s['sheet.body'])}<`), `${lang} guardian: no mistakes line, the guardian's body`);
    assert.match(html, /<input type="checkbox" role="switch" class="switch" id="g">/, `${lang}: the guardian's switch, off`);
    assert.match(html, /<button type="button" class="primary" part="primary" id="yes" disabled>/, `${lang}: share disabled until the switch is on`);
    // real buttons, the two parts of 3.1.0 and the rest of its parts
    for (const p of ['sheet', 'title', 'body', 'primary', 'secondary', 'guardian']) assert.ok(html.includes(`part="${p}"`), `${lang}: part ${p}`);
    assert.equal((html.match(/<button type="button"/g) || []).length, 2);
  }
});

test('the direction and the type rules come from the deck: right to left for Arabic and Urdu, Latin tracking only for Latin scripts', async () => {
  const script = { ar: 'arabic', ur: 'arabic', bn: 'other', en: 'latin', fr: 'latin', id: 'latin', ms: 'latin', tr: 'latin' };
  for (const lang of LANGS) {
    const { html } = await sheetHtml({ lang });
    assert.ok(html.includes(`<dialog part="sheet" lang="${lang}" dir="${DECKS[lang].dir}" data-script="${script[lang]}"`), lang);
    // a regional tag takes its language's deck and direction
    const regional = await sheetHtml({ lang: `${lang}-XX` });
    assert.ok(regional.html.includes(`dir="${DECKS[lang].dir}"`), `${lang}-XX`);
  }
});

test('the hadith is shown only when the deck says where it was verified', async () => {
  const base = JSON.parse(JSON.stringify(DECKS.en));
  delete base.hadith_source;
  registerDeck('xa', { ...base, lang: 'xa' });
  assert.ok(!(await sheetHtml({ lang: 'xa' })).html.includes('class="hadith"'));
  registerDeck('xb', { ...base, lang: 'xb', hadith_source: { ...DECKS.en.hadith_source } });
  assert.ok((await sheetHtml({ lang: 'xb' })).html.includes(`<p class="hq">${esc(DECKS.en.strings['sheet.hadith'])}</p>`));
  for (const lang of LANGS) assert.ok((await sheetHtml({ lang })).html.includes('class="hadith"'), `${lang}: verified, shown`);
});

test('contrast as WCAG defines it (the fallback rule\'s measure)', () => {
  assert.equal(Math.round(contrastRatio([255, 255, 255], [0, 0, 0]) * 100) / 100, 21);
  assert.ok(contrastRatio([14, 107, 88], [255, 255, 255]) > 4.5); // the default accent on white
  assert.ok(contrastRatio([159, 227, 210], [255, 255, 255]) < 4.5);
});

// ---- in a real browser
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { puppeteer = null; }
const skipBrowser = !puppeteer ? 'no puppeteer-core' : !existsSync(CHROME) ? `no Chrome at ${CHROME}` : false;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const HOSTILE = '* { font-weight: 900; font-size: 30px; line-height: 3 }';
// a page's custom properties and part rules: they theme, they never change the type or remove the name
const THEMED = `:root { --ql-font: "Comic Sans MS", cursive; --ql-title-font: Georgia, serif; --ql-fg: #102030; }
quranlab-consent { font-size: 50px; line-height: 9; font-weight: 100; visibility: hidden; display: none; letter-spacing: 4px; }
quranlab-consent::part(sheet) { font-size: 40px; line-height: 5; font-weight: 900; }`;
const PAGE = (css, dir) => `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sheet</title>
<style>body{margin:0}${css}</style></head><body><button id="page">a page button</button><script type="module">
import { QuranLabConsent } from '/web/consent/element.js';
window.Q = QuranLabConsent;
window.openSheet = (o) => { window.answer = QuranLabConsent.ask(o); window.answer.then((a) => { window.answered = a; }); window.answered = null; return true; };
window.R = () => document.querySelector('quranlab-consent').shadowRoot;
window.box = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
window.sig = () => [...R().querySelectorAll('*')].filter((e) => e.tagName !== 'STYLE').map((e) => {
  const s = getComputedStyle(e), b = e.getBoundingClientRect();
  return [e.tagName, e.id, e.getAttribute('class') || '', s.fontSize, s.fontWeight, s.lineHeight, s.fontFamily, s.letterSpacing, s.color,
    s.backgroundColor, s.visibility, s.display, Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)].join(' | ');
});
window.close1 = () => R().querySelector('#no').click();
window.ready = true;
</script></body></html>`;

test('in headless Chrome: the sheet\'s design', { skip: skipBrowser, timeout: 600000 }, async (t) => {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const pages = { '/': PAGE('', 'ltr'), '/rtl': PAGE('', 'rtl'), '/hostile': PAGE(HOSTILE, 'ltr'), '/themed': PAGE(HOSTILE + THEMED, 'ltr') };
    if (pages[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[u.pathname]); return; }
    const f = path.join(root, path.normalize(decodeURIComponent(u.pathname)).replace(/^([\\/])+/, ''));
    if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const b = await readFile(f); res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(b); } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const open = async (where = '/', { width = 390, height = 844, scheme = 'light', text = 1, motion = 'reduce' } = {}) => {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }]);
    const cdp = await page.createCDPSession();
    const textSize = (k) => cdp.send('Page.setFontSizes', { fontSizes: { standard: 16 * k, fixed: 13 * k } });
    await textSize(text);
    await page.goto(base + where);
    await page.waitForFunction('window.ready === true');
    return Object.assign(page, { textSize });
  };
  try {
    await t.test('both buttons are the same size (width and height, at least 52 high) in every language, at 320, 390 and 1280 wide, at the default text size and twice it, also in the guardian variant', async () => {
      const page = await open();
      let n = 0;
      for (const [width, height] of [[320, 568], [390, 844], [1280, 800]]) {
        await page.setViewport({ width, height });
        for (const k of [1, 2]) {
          await page.textSize(k);
          for (const lang of LANGS) {
            for (const guardian of [false, true]) {
              const r = await page.evaluate((lang, guardian) => { openSheet({ lang, guardian }); const out = { yes: box(R().querySelector('#yes')), no: box(R().querySelector('#no')), bar: box(R().querySelector('.bar')) }; close1(); return out; }, lang, guardian);
              const what = `${lang}${guardian ? ' guardian' : ''} ${width}x${height} text x${k}`;
              assert.ok(Math.abs(r.yes.w - r.no.w) < 0.5 && Math.abs(r.yes.h - r.no.h) < 0.5, `${what}: ${JSON.stringify(r)}`);
              assert.ok(r.yes.h >= 51.5, `${what}: ${r.yes.h} high`);
              assert.ok(r.yes.x >= r.bar.x && r.yes.x + r.yes.w <= r.bar.x + r.bar.w + 0.5, `${what}: inside the bar`);
              n++;
            }
          }
        }
      }
      t.diagnostic(`${n} sheets measured`);
      await page.close();
    });

    await t.test('the share button is disabled until the guardian\'s switch is on; "Not now" always works; the switch is a real switch', async () => {
      const page = await open();
      const r = await page.evaluate(async () => {
        openSheet({ lang: 'en', guardian: true });
        const yes = R().querySelector('#yes'), no = R().querySelector('#no'), g = R().querySelector('#g');
        const out = { role: g.getAttribute('role'), start: [yes.disabled, no.disabled, g.checked] };
        yes.click(); await new Promise((r) => setTimeout(r, 50));
        out.afterDisabledClick = window.answered;
        g.click(); out.on = [yes.disabled, g.checked];
        g.click(); out.off = [yes.disabled, g.checked];
        // the label is part of the switch: a tap on its text turns it on
        R().querySelector('label.guardian span').click(); out.byLabel = [yes.disabled, g.checked];
        yes.click(); out.answer = await window.answer;
        return out;
      });
      assert.deepEqual(r, { role: 'switch', start: [true, false, false], afterDisabledClick: null, on: [false, true], off: [true, false], byLabel: [false, true], answer: { yes: true, guardianConfirmed: true } });
      // the keyboard: Space on the focused switch
      const k = await page.evaluate(() => { openSheet({ lang: 'ar', guardian: true }); R().querySelector('#g').focus(); return true; });
      assert.ok(k);
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => R().querySelector('#yes').disabled), false);
      await page.evaluate(() => close1());
      assert.deepEqual(await page.evaluate(() => window.answer), { yes: false, guardianConfirmed: true });
      await page.close();
    });

    await t.test('the direction follows the deck, not the page: the layout mirrors for Arabic and Urdu on a left to right page, and not for the others on a right to left page', async () => {
      for (const where of ['/', '/rtl']) {
        const page = await open(where);
        for (const lang of LANGS) {
          const r = await page.evaluate((lang) => {
            openSheet({ lang });
            const d = R().querySelector('dialog'), li = R().querySelector('li'), emblem = R().querySelector('.emblem'), name = R().querySelector('#n');
            const out = { dir: d.dir, direction: getComputedStyle(li).direction, padL: getComputedStyle(li).paddingLeft, padR: getComputedStyle(li).paddingRight,
              emblemRight: box(emblem).x > box(name).x, nameDir: getComputedStyle(name).direction };
            close1();
            return out;
          }, lang);
          const rtl = DECKS[lang].dir === 'rtl';
          assert.deepEqual(r, { dir: DECKS[lang].dir, direction: DECKS[lang].dir, padL: rtl ? '0px' : '34px', padR: rtl ? '34px' : '0px', emblemRight: rtl, nameDir: 'ltr' }, `${lang} on ${where}`);
        }
        await page.close();
      }
    });

    await t.test('colours: the default accent labels "Not now" and the icons; a low-contrast accent takes the text colour there; on-accent follows the accent unless the app sets it; the tints without color-mix', async () => {
      const read = (page, theme) => page.evaluate((theme) => {
        openSheet({ lang: 'en', theme });
        const r = R(), cs = (el, pseudo) => getComputedStyle(el, pseudo || null);
        const out = { no: cs(r.querySelector('#no')).color, yes: cs(r.querySelector('#yes')).color, emblem: cs(r.querySelector('.emblem')).color,
          icon: cs(r.querySelector('li'), '::before').backgroundColor, text: cs(r.querySelector('h2')).color, tint: cs(r.querySelector('#no')).backgroundColor,
          colors: document.querySelector('quranlab-consent')._colors };
        close1();
        return out;
      }, theme);
      let page = await open();
      let c = await read(page, null);
      assert.deepEqual([c.no, c.emblem, c.icon, c.yes, c.text], ['rgb(14, 107, 88)', 'rgb(14, 107, 88)', 'rgb(14, 107, 88)', 'rgb(255, 255, 255)', 'rgb(23, 23, 26)'], JSON.stringify(c));
      assert.equal(c.colors.fallback, false);
      c = await read(page, { accent: '#9FE3D2' });
      assert.equal(c.colors.fallback, true, JSON.stringify(c.colors));
      assert.deepEqual([c.no, c.emblem, c.icon, c.yes], ['rgb(23, 23, 26)', 'rgb(23, 23, 26)', 'rgb(23, 23, 26)', 'rgb(11, 11, 12)'], 'the text colour; near-black on a light accent');
      assert.notEqual(c.tint, 'rgb(255, 255, 255)', 'the fill stays the tint');
      c = await read(page, { accent: '#9FE3D2', accentText: '#123456' });
      assert.equal(c.yes, 'rgb(18, 52, 86)', 'the app\'s own on-accent');
      // without color-mix() (a browser older than the SDK supports), the tints are computed in script
      const mixed = await read(page, { accent: '#5B3FA8' });
      await page.evaluate(() => { const real = CSS.supports.bind(CSS); CSS.supports = (a, b) => (/color-mix/.test(String(b === undefined ? a : b)) ? false : real(a, b)); });
      const fallback = await read(page, { accent: '#5B3FA8' });
      // a computed color-mix() reads as color(srgb r g b) with channels from 0 to 1
      const rgb = (s) => (s.startsWith('color(') ? s.match(/[\d.]+/g).slice(0, 3).map((v) => +v * 255) : s.match(/[\d.]+/g).slice(0, 3).map(Number));
      assert.ok(rgb(mixed.tint).every((v, i) => Math.abs(v - rgb(fallback.tint)[i]) <= 1), `${mixed.tint} ${fallback.tint}`);
      await page.close();
      page = await open('/', { scheme: 'dark' });
      c = await read(page, null);
      assert.deepEqual([c.no, c.yes, c.text], ['rgb(98, 210, 182)', 'rgb(11, 11, 12)', 'rgb(244, 244, 246)'], 'dark: the dark accent and near-black on it');
      c = await read(page, { accent: '#0E6B58' });
      assert.equal(c.colors.fallback, true, 'a dark accent on the dark tint');
      assert.deepEqual([c.no, c.yes], ['rgb(244, 244, 246)', 'rgb(255, 255, 255)']);
      await page.close();
    });

    await t.test('a page\'s styles change nothing inside the sheet (`* { font-weight: 900; font-size: 30px; line-height: 3 }`, light and dark, English and Arabic, the guardian variant, twice the text size), and its custom properties and part rules never remove the name', async () => {
      for (const [scheme, text] of [['light', 1], ['dark', 1], ['light', 2]]) {
        const clean = await open('/', { scheme, text }), hostile = await open('/hostile', { scheme, text });
        for (const lang of ['en', 'ar']) {
          for (const guardian of [false, true]) {
            const sig = (p) => p.evaluate((lang, guardian) => { openSheet({ lang, guardian }); const s = sig(); close1(); return s; }, lang, guardian);
            const a = await sig(clean), b = await sig(hostile);
            assert.ok(a.length > 20);
            assert.deepEqual(b, a, `${lang}${guardian ? ' guardian' : ''} ${scheme} text x${text}`);
          }
        }
        // what the page does reach: its own root's size (rem), never the sheet's
        assert.equal(await hostile.evaluate(() => getComputedStyle(document.documentElement).fontSize), '30px');
        await clean.close(); await hostile.close();
      }
      const page = await open('/themed');
      for (const lang of LANGS) {
        const r = await page.evaluate((lang) => {
          openSheet({ lang });
          const n = R().querySelector('#n'), s = getComputedStyle(n);
          const out = { text: n.textContent, family: s.fontFamily.split(',')[0].trim(), size: s.fontSize, weight: s.fontWeight, visible: s.visibility, w: box(n).w,
            title: getComputedStyle(R().querySelector('h2')).fontSize, titleFamily: getComputedStyle(R().querySelector('h2')).fontFamily.split(',')[0].trim(),
            body: getComputedStyle(R().querySelector('.body')).fontFamily.split(',')[0].trim(), sheetShown: box(R().querySelector('dialog')).h > 200 };
          close1();
          return out;
        }, lang);
        assert.deepEqual(r, { text: 'Quran Lab', family: 'system-ui', size: '15px', weight: '600', visible: 'visible', w: r.w, title: '26px', titleFamily: 'Georgia', body: '"Comic Sans MS"', sheetShown: true }, lang);
        assert.ok(r.w > 40, `${lang}: the name is there to see`);
      }
      await page.close();
    });

    await t.test('the browser\'s text size scales the sheet (the page\'s root size does not): twice the text size gives twice the type', async () => {
      const page = await open('/hostile', { text: 2 });
      const r = await page.evaluate(() => {
        openSheet({ lang: 'en' });
        const f = (sel) => getComputedStyle(R().querySelector(sel)).fontSize;
        const lh = (sel) => String(Math.round(parseFloat(getComputedStyle(R().querySelector(sel)).lineHeight) * 100) / 100);
        const out = [f('h2'), f('.body'), f('li'), f('#n'), f('#yes'), f('.ref'), lh('h2'), lh('.body'), lh('li'), lh('#yes')];
        close1();
        return out;
      });
      assert.deepEqual(r, ['52px', '31px', '29px', '30px', '32px', '24px', '62', '48', '44', '40']);
      await page.close();
    });

    await t.test('as in 3.1.0: Escape answers "Not now"; a click beside the sheet does nothing; focus moves to the name and stays in the sheet', async () => {
      for (const [width, height, x, y] of [[390, 844, 195, 10], [1280, 800, 20, 20]]) {
        const page = await open('/', { width, height });
        await page.evaluate(() => openSheet({ lang: 'en' }));
        assert.equal(await page.evaluate(() => R().activeElement && R().activeElement.id), 'n');
        const seen = [];
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          seen.push(await page.evaluate(() => (document.activeElement === document.querySelector('quranlab-consent') ? (R().activeElement || {}).id : document.activeElement.id || document.activeElement.tagName)));
        }
        // never the page's own button (the page behind a modal sheet is inert); past the last button the browser may
        // pass through its own UI (the document) or the scrolling column before the sheet again
        assert.ok(!seen.includes('page'), `${width}: Tab stays in the sheet: ${seen}`);
        assert.deepEqual(seen.slice(0, 2), ['yes', 'no']);
        await page.mouse.click(x, y);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(await page.evaluate(() => R().querySelector('dialog').open && window.answered === null), true, `${width}: a click beside the sheet`);
        await page.keyboard.press('Escape');
        await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(await page.evaluate(() => window.answered), { yes: false, guardianConfirmed: false });
        assert.equal(await page.evaluate(() => document.querySelector('quranlab-consent')), null, 'the element is gone');
        await page.close();
      }
    });

    await t.test('the layout: a bottom sheet with the grabber under 600 px, a centred card at most 480 px wide above; the column scrolls under the bar with a fade at the edge that has more; nothing of the column is ever drawn in the grabber band', async () => {
      for (const [lang, text] of [['en', 1], ['ar', 1], ['ar', 2]]) {
        const page = await open('/', { width: 390, height: 844, scheme: lang === 'ar' ? 'dark' : 'light', text });
        const r = await page.evaluate(async (lang) => {
          openSheet({ lang });
          const d = R().querySelector('dialog'), sc = R().querySelector('.scroll'), band = R().querySelector('.band');
          const fades = () => [getComputedStyle(R().querySelector('.fade.t')).opacity, getComputedStyle(R().querySelector('.fade.b')).opacity];
          // every point of the band, across its width and height, belongs to the band (or its grabber)
          const inBand = () => {
            const b = box(band), seen = new Set();
            for (let y = Math.ceil(b.y); y < b.y + b.h; y++) for (let x = 1; x < b.w; x += 12) { const e = R().elementFromPoint(x, y); seen.add(e ? e.className || e.tagName : 'none'); }
            return [...seen].sort();
          };
          const out = { sheet: box(d), band: box(band), bandShown: getComputedStyle(band).display, scroll: box(sc), header: box(R().querySelector('.head')),
            scrolls: sc.scrollHeight > sc.clientHeight, open: fades(), openHits: inBand() };
          sc.scrollTop = sc.scrollHeight;
          await new Promise((r) => setTimeout(r, 100));
          Object.assign(out, { end: fades(), endHits: inBand(), endScroll: box(sc), fadeTop: box(R().querySelector('.fade.t')) });
          close1();
          return out;
        }, lang);
        const what = `${lang} text x${text}: ${JSON.stringify(r)}`;
        assert.deepEqual([r.sheet.x, r.sheet.w, Math.round(r.sheet.y + r.sheet.h), r.bandShown, r.scrolls], [0, 390, 844, 'block', true], what);
        assert.equal(Math.round(r.band.y), Math.round(r.sheet.y), what);
        assert.equal(Math.round(r.band.h), 21, `the band: 8, the grabber's 5, 8: ${what}`);
        assert.equal(Math.round(r.header.y - r.sheet.y), 33, `the header 20 below the grabber, as drawn: ${what}`);
        assert.ok(r.scroll.y >= r.band.y + r.band.h - 0.5 && r.endScroll.y >= r.band.y + r.band.h - 0.5, `the viewport begins below the band: ${what}`);
        assert.ok(r.fadeTop.y >= r.band.y + r.band.h - 0.5, `the top fade is inside the viewport: ${what}`);
        // the band, its grabber, or (outside the sheet's rounded top corners) the dialog itself: never the column
        for (const hits of [r.openHits, r.endHits]) {
          assert.ok(hits.includes('band') && hits.includes('grab') && hits.every((h) => ['band', 'grab', 'DIALOG'].includes(h)), `only the band in its band, opened and scrolled to the end: ${what}`);
        }
        assert.deepEqual([r.open, r.end], [['0', '1'], ['1', '0']], `a fade where there is more to read: ${what}`);
        await page.close();
      }
      const page = await open('/', { width: 1280, height: 800 });
      const r = await page.evaluate(() => { openSheet({ lang: 'en' }); const out = { sheet: box(R().querySelector('dialog')), band: getComputedStyle(R().querySelector('.band')).display, radius: getComputedStyle(R().querySelector('dialog')).borderBottomLeftRadius }; close1(); return out; });
      assert.deepEqual([r.sheet.w, Math.round(r.sheet.x + r.sheet.w / 2), r.band, r.radius], [480, 640, 'none', '28px'], JSON.stringify(r));
      assert.ok(r.sheet.y >= 23 && r.sheet.y + r.sheet.h <= 777, JSON.stringify(r.sheet));
      await page.close();
    });

    await t.test('reduced motion: no animation; without it the sheet slides in', async () => {
      for (const [motion, some] of [['reduce', false], ['no-preference', true]]) {
        const page = await open('/', { motion });
        const n = await page.evaluate(() => { openSheet({ lang: 'en' }); const n = R().getAnimations().length; close1(); return n; });
        assert.equal(n > 0, some, `${motion}: ${n} animations`);
        await page.close();
      }
    });

    await t.test('the thank-you takes the same tokens, and a page\'s styles do not change its type', async () => {
      const page = await open('/hostile');
      const r = await page.evaluate(() => {
        const el = Q.thank({ lang: 'ar', ms: 60000 });
        const s = getComputedStyle(el);
        return [el.getAttribute('role'), el.dir, s.fontSize, s.fontWeight, s.lineHeight, s.backgroundColor, s.color];
      });
      assert.deepEqual(r, ['status', 'rtl', '16px', '400', '24px', 'rgb(14, 107, 88)', 'rgb(255, 255, 255)']);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});
