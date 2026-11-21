// The loader's two hosts (sdk4/loader/link.js; plan of 11-18: "the loader switches after 5 s, not 20"): the frame on
// web.quranlab.ai first; no hello in 4 s and the same frame on the fallback host is opened beside it; the first frame to
// say hello is the page's and the other is removed; a hello counts only from a frame this loader opened, stamped with
// that frame's own origin; no hello from either in 20 s and the origin check says why. A window and a document stand in
// for the browser's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openFrame, SWITCH_MS, TIMEOUT_MS } from '../../sdk4/loader/link.js';
import { FRAME_BASES } from '../../sdk4/loader/client.js';
import { ROLES } from '../../sdk4/shared/endpoints.js';
import { HELLO, ACK, API } from '../../sdk4/shared/protocol.js';

const A = 'https://web.test', B = 'https://web2.test';

function browser() {
  const listeners = new Set(), frames = [];
  const doc = {
    createElement: () => {
      const f = { style: {}, setAttribute() {}, removed: false, posted: [], remove() { f.removed = true; } };
      f.contentWindow = { postMessage: (msg, origin, ports) => f.posted.push({ msg, origin, ports }) };
      return f;
    },
    body: { appendChild: (f) => frames.push(f) },
  };
  const win = { location: { origin: 'https://site.example' }, document: doc, MessageChannel,
    addEventListener: (t, fn) => listeners.add(fn), removeEventListener: (t, fn) => listeners.delete(fn) };
  // a message as the browser delivers it: from a window, stamped with its origin
  const say = (frame, origin, data = { ql: HELLO, api: API, nonce: 'n1' }) => { for (const fn of [...listeners]) fn({ source: frame.contentWindow, origin, data }); };
  return { win, doc, frames, say, listening: () => listeners.size };
}
// the ports handed to a frame, closed (the channel's other end then lets the test end)
const closePorts = (b) => { for (const f of b.frames) for (const x of f.posted) for (const pt of x.ports || []) pt.close(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const originCheck = (allowed) => async () => new Response(JSON.stringify({ allowed, why: allowed ? 'listed' : 'not_listed' }), { status: 200 });

test('the defaults: each next host after 4 s (the second has taken over within 5 s), the origin check at 24 s (28.6)', () => {
  assert.equal(SWITCH_MS, 4000);
  assert.equal(TIMEOUT_MS, 24000);
  // the frame's hosts of a released loader: the web_frame role, in order (the five of contract 564c144)
  assert.deepEqual([...FRAME_BASES], ROLES.web_frame.map((h) => `https://${h}`));
  assert.equal(TIMEOUT_MS, (ROLES.web_frame.length - 1) * SWITCH_MS + 8000, 'the origin check 8 s after the last host starts');
});

test('five hosts: each next frame after each switch time without a hello; the third answers when the first two never do', async () => {
  const b = browser();
  const H = ['https://w1.test', 'https://w2.test', 'https://w3.test', 'https://w4.test', 'https://w5.test'];
  const p = openFrame({ key: 'qlk_v1_k', frameBases: H, apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 40, timeoutMs: 2000 });
  assert.equal(b.frames.length, 1);
  await wait(55);
  assert.equal(b.frames.length, 2);
  await wait(40);
  assert.equal(b.frames.length, 3);
  assert.equal(b.frames[2].src, `${H[2]}/4/frame/qlk_v1_k`);
  b.say(b.frames[2], H[2]);
  const link = await p;
  assert.equal(link.base, H[2]);
  assert.equal(link.fallback, true);
  assert.deepEqual(b.frames.map((f) => f.removed), [true, true, false]);
  await wait(100);
  assert.equal(b.frames.length, 3, 'no host opened after a hello');
  closePorts(b);
});

test('no hello from any of five hosts: all five opened in order, then the origin check through the api order', async () => {
  const b = browser();
  const H = ['https://w1.test', 'https://w2.test', 'https://w3.test', 'https://w4.test', 'https://w5.test'];
  // the api order: the first api host does not answer, the second says the origin is not on the key
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).host);
    if (new URL(url).host === 'api.quranlab.ai') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ allowed: false, why: 'not_listed' }), { status: 200 });
  };
  const p = openFrame({ key: 'qlk_v1_k', frameBases: H, apiUrl: 'https://api.quranlab.ai', win: b.win, doc: b.doc, switchMs: 10, timeoutMs: 120, fetch });
  await assert.rejects(p, (e) => e.code === 'invalid_key');
  assert.deepEqual(b.frames.map((f) => new URL(f.src).origin), H);
  assert.ok(b.frames.every((f) => f.removed));
  assert.deepEqual(asked, ['api.quranlab.ai', 'api-b.tajweedformer.com']);
});

test('the first host answers: no second frame, the first is the page\'s', async () => {
  const b = browser();
  const p = openFrame({ key: 'qlk_v1_k', frameBases: [A, B], apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 100, timeoutMs: 1000 });
  assert.equal(b.frames.length, 1);
  assert.equal(b.frames[0].src, `${A}/4/frame/qlk_v1_k`);
  b.say(b.frames[0], A);
  const link = await p;
  assert.equal(link.base, A);
  assert.equal(link.fallback, false);
  await wait(150);
  assert.equal(b.frames.length, 1, 'no fallback frame once one answered');
  const ack = b.frames[0].posted[0];
  assert.equal(ack.msg.ql, ACK);
  assert.equal(ack.origin, A, 'the ack is addressed to the frame\'s origin only');
  assert.equal(b.listening(), 0);
  closePorts(b);
});

test('the first host is silent: the fallback frame opens at the switch time, answers, and the first frame is removed', async () => {
  const b = browser();
  const p = openFrame({ key: 'qlk_v1_k', frameBases: [A, B], apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 50, timeoutMs: 2000, storage: 'one' });
  await wait(20);
  assert.equal(b.frames.length, 1);
  await wait(60);
  assert.equal(b.frames.length, 2);
  assert.equal(b.frames[1].src, `${B}/4/frame/qlk_v1_k#s=one`);
  // a hello from the fallback's window that is not stamped with its origin, and one from a window this loader did not
  // open, are not the frame's
  b.say(b.frames[1], A);
  b.say({ contentWindow: {} }, B);
  b.say(b.frames[1], B);
  const link = await p;
  assert.equal(link.base, B);
  assert.equal(link.fallback, true);
  assert.equal(b.frames[0].removed, true);
  assert.equal(b.frames[1].removed, false);
  assert.equal(b.frames[1].posted[0].origin, B);
  closePorts(b);
});

test('both open: the first host answering late still wins when it is first; the other frame goes', async () => {
  const b = browser();
  const p = openFrame({ key: 'qlk_v1_k', frameBases: [A, B], apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 30, timeoutMs: 2000 });
  await wait(60);
  assert.equal(b.frames.length, 2);
  b.say(b.frames[0], A);
  b.say(b.frames[1], B);
  const link = await p;
  assert.equal(link.base, A);
  assert.equal(b.frames[1].removed, true);
  assert.equal(b.frames[1].posted.length, 0, 'the frame that lost gets no port');
  closePorts(b);
});

test('no hello from either host: the origin check says why, and both frames are removed', async () => {
  for (const allowed of [false, true]) {
    const b = browser();
    const p = openFrame({ key: 'qlk_v1_k', frameBases: [A, B], apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 20, timeoutMs: 80, fetch: originCheck(allowed) });
    await assert.rejects(p, (e) => e.code === (allowed ? 'needs_connection' : 'invalid_key'));
    assert.equal(b.frames.length, 2);
    assert.ok(b.frames.every((f) => f.removed));
  }
});

test('one host only (frameBase): as before, no fallback', async () => {
  const b = browser();
  const p = openFrame({ key: 'qlk_v1_k', frameBase: A, apiUrl: 'https://api.test', win: b.win, doc: b.doc, switchMs: 10, timeoutMs: 60, fetch: originCheck(true) });
  await assert.rejects(p, (e) => e.code === 'needs_connection');
  assert.equal(b.frames.length, 1);
});
