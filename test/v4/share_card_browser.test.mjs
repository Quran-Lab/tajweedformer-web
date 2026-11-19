// SDK 4.0's re-ask card in headless Chrome (puppeteer-core; CHROME_PATH picks the browser), drawn by the SDK
//: it appears only after the settle, is not a dialog and takes no focus (nothing behind it blocked),
// sits at the bottom at most 480 px wide with two buttons of the same size, is announced once (a polite live
// region with the deck's card.line), goes with a take start ("Not now"), opens into the full sheet without the
// re-ask line (one ask), shows the 3.x re-ask sheet for a deck without the card strings, and has no animation
// under reduced motion. A fake platform client and fake timers in the page; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch (_) { puppeteer = null; }
const skip = !puppeteer ? 'no puppeteer-core' : !existsSync(CHROME) ? `no Chrome at ${CHROME}` : false;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>card</title>
<body><button id="app">the app's own button</button><script type="module">
import * as C from '/web/consent/index.js';
const DAY = 86400000, T0 = Date.parse('2027-01-15T08:00:00Z');
window.C = C;
// a platform client's few parts, and an install whose next ask is a card (the sheet said "Not now" 15 days ago)
window.make = (o = {}) => {
  const kv = new Map();
  kv.set('sharing.v1', JSON.stringify(o.stored || { v: 1, consent: 'declined', asks: 1, sessions: 10, lastAskSession: 2,
    installedAt: T0 - 20 * DAY, lastAskAt: T0 - 15 * DAY, lastAskDay: Math.floor((T0 - 15 * DAY) / DAY) }));
  const ql = { now: T0, counts: [], state: { get: (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), set: (k, v) => kv.set(k, JSON.stringify(v)) },
    clock() { return ql.now; }, sharingAllowed: () => true, config: { v: 1, flags: { contributions: true } },
    telemetry: { count: (f) => ql.counts.push(f) }, reportIssue() {}, contributor: () => 'c'.repeat(32), flags: {} };
  const due = [];
  const timers = { setTimeout: (f, ms) => { due.push({ f, ms }); return due.length; }, clearTimeout() {} };
  const ctl = C.enableSharing(ql, { lang: o.lang || 'en', timers });
  return { ql, ctl, run: () => { const x = due.splice(0); x.forEach((d) => d.f()); return x.map((d) => d.ms); },
    stored: () => JSON.parse(kv.get('sharing.v1')) };
};
window.until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 20)); } return true; };
window.el = () => document.querySelector('quranlab-consent');
window.sr = () => (window.el() ? window.el().shadowRoot : null);
window.ready = true;
</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

test('the re-ask card in headless Chrome: after the settle, not modal, the deck\'s line announced, gone with a take, opened into the sheet; the deck fallback', { skip, timeout: 180000 }, async () => {
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
    await page.setViewport({ width: 1024, height: 768 });
    const external = [];
    page.on('request', (q) => { if (!q.url().startsWith(origin) && !q.url().startsWith('data:')) external.push(q.url()); });
    await page.goto(origin + '/');
    await page.waitForFunction('window.ready === true');

    // 1. the card: only after the settle; a region, not a dialog; no focus taken; two equal buttons; the line
    const one = await page.evaluate(async () => {
      document.getElementById('app').focus();
      const w = window.make();
      w.ctl.takeEnded({ end: 'normal', speechMs: 90000 });
      await new Promise((r) => setTimeout(r, 50));
      const before = !!window.el();
      const settle = w.run();
      await window.until(() => window.sr() && window.sr().querySelector('#l') && window.sr().querySelector('#l').textContent);
      const sr = window.sr();
      const sec = sr.querySelector('section');
      await Promise.all(sec.getAnimations().map((x) => x.finished)); // measured where it rests, not while it rises
      const [a, b] = [...sr.querySelectorAll('button')].map((x) => x.getBoundingClientRect());
      const box = sec.getBoundingClientRect();
      const out = { before, settle, dialog: !!sr.querySelector('dialog'), role: sec.getAttribute('role'), live: sr.querySelector('#l').getAttribute('aria-live'),
        line: sr.querySelector('#l').textContent, open: sr.querySelector('#open').textContent, no: sr.querySelector('#no').textContent,
        focus: document.activeElement && document.activeElement.id, position: getComputedStyle(sec).position,
        width: box.width, bottomGap: innerHeight - box.bottom, buttons: [a.width, a.height, b.width, b.height],
        counts: [...w.ql.counts], asks: w.stored().asks };
      // 2. a take starts: the card goes, "Not now"
      w.ctl.takeStarted();
      await window.until(() => !window.el());
      out.afterTake = { gone: !window.el(), consent: w.stored().consent, counts: [...w.ql.counts] };
      return out;
    });
    assert.equal(one.before, false, 'nothing before the settle');
    assert.deepEqual(one.settle, [3000]);
    assert.equal(one.dialog, false, 'not a dialog, not modal');
    assert.equal(one.role, 'region');
    assert.equal(one.live, 'polite');
    assert.equal(one.line, 'Your recitation today could help another learner tomorrow.');
    assert.deepEqual([one.open, one.no], ['See how it helps', 'Not now']);
    assert.equal(one.focus, 'app', 'the page keeps its focus');
    assert.equal(one.position, 'fixed');
    assert.ok(one.width <= 480 && one.width > 300, `at most 480 wide (${one.width})`);
    assert.ok(one.bottomGap >= 15 && one.bottomGap < 40, `at the bottom (${one.bottomGap} px above it)`);
    assert.ok(Math.abs(one.buttons[0] - one.buttons[2]) < 1 && Math.abs(one.buttons[1] - one.buttons[3]) < 1, `two equal buttons ${one.buttons}`);
    assert.ok(one.buttons[1] >= 44, 'touch targets of 44 or more');
    assert.deepEqual([one.counts, one.asks], [['share_asked'], 2], 'one of the three once on screen');
    assert.deepEqual(one.afterTake, { gone: true, consent: 'declined', counts: ['share_asked', 'share_no'] });

    // 3. "See how it helps": the full sheet at once, without the re-ask line; a yes there is the answer to the same ask
    const two = await page.evaluate(async () => {
      const w = window.make();
      w.ctl.takeEnded({ end: 'normal', speechMs: 90000 });
      const done = (async () => { await new Promise((r) => setTimeout(r, 0)); w.run(); })();
      await done;
      await window.until(() => window.sr() && window.sr().querySelector('#open'));
      window.sr().querySelector('#open').click();
      await window.until(() => window.sr() && window.sr().querySelector('dialog'));
      const sr = window.sr();
      const reask = window.C.copyFor('en').t('reask');
      const text = sr.querySelector('dialog').textContent;
      const out = { dialog: !!sr.querySelector('dialog[open]'), hasReask: text.includes(reask), title: sr.querySelector('h2').textContent, asksOnSheet: w.stored().asks };
      sr.querySelector('#yes').click();
      await window.until(() => w.stored().consent === 'granted');
      out.consent = w.stored().consent; out.counts = [...w.ql.counts]; out.asks = w.stored().asks;
      return out;
    });
    assert.equal(two.dialog, true, 'the full sheet');
    assert.equal(two.hasReask, false, 'without the re-ask line');
    assert.deepEqual([two.consent, two.asks], ['granted', 2]);
    assert.deepEqual(two.counts, ['share_asked', 'share_yes'], 'one ask, one yes');

    // 4. a deck without the card's strings: the re-ask sheet in the card's place, the same ask
    const three = await page.evaluate(async () => {
      const EN = window.C.EN;
      window.C.registerDeck('zq', { ...EN, version: '2026-11-13.1', strings: Object.fromEntries(Object.entries(EN.strings).filter(([k]) => !k.startsWith('card.'))) });
      const w = window.make({ lang: 'zq' });
      w.ctl.takeEnded({ end: 'normal', speechMs: 90000 });
      await new Promise((r) => setTimeout(r, 0));
      w.run();
      await window.until(() => window.sr() && window.sr().querySelector('dialog'));
      const sr = window.sr();
      const out = { dialog: !!sr.querySelector('dialog[open]'), section: !!sr.querySelector('section'), hasReask: sr.querySelector('dialog').textContent.includes(window.C.copyFor('zq').t('reask')) };
      sr.querySelector('#no').click();
      await window.until(() => !window.el());
      out.consent = w.stored().consent; out.asks = w.stored().asks; out.counts = [...w.ql.counts];
      return out;
    });
    assert.deepEqual(three, { dialog: true, section: false, hasReask: true, consent: 'declined', asks: 2, counts: ['share_asked', 'share_no'] });

    // 5. reduced motion: the card does not move
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const four = await page.evaluate(async () => {
      const w = window.make();
      w.ctl.takeEnded({ end: 'normal', speechMs: 90000 });
      await new Promise((r) => setTimeout(r, 0));
      w.run();
      await window.until(() => window.sr() && window.sr().querySelector('section'));
      const name = getComputedStyle(window.sr().querySelector('section')).animationName;
      // the page hidden takes it back: "Not now"
      await w.ctl.background();
      await window.until(() => !window.el());
      return { name, gone: !window.el(), consent: w.stored().consent };
    });
    assert.deepEqual(four, { name: 'none', gone: true, consent: 'declined' });
    assert.deepEqual(external, [], 'nothing left the page\'s own server');
  } finally {
    await browser.close();
    server.close();
  }
});
