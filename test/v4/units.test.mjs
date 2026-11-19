// Unit tests of SDK 4.0's pure pieces: Ed25519 (WebCrypto and the BigInt fallback), the signed engine index and
// the engine choice, the packaged engine's own index, the frame's handshake with stand-in windows, the recited
// report's checks and counts, and the 4.0 telemetry body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { verify, verifyFallback } from '../../sdk4/shared/ed25519.js';
import { engineIndexText, verifyEngineIndex, parseEngineIndex, chooseEngine, checkEngineFile, variantFiles } from '../../sdk4/shared/engine-index.js';
import { handshake, parseFrameUrl, notFramed, startFrame } from '../../sdk4/frame/frame.js';
import { checkReport, takeCounts, ReportError } from '../../sdk4/shared/recited.js';
import { Telemetry4 } from '../../sdk4/frame/telemetry4.js';
import { StateStore, MemoryKV } from '../../sdk4/frame/stores.js';
import { b64u, utf8, hex } from '../../sdk4/shared/bytes.js';
import { edSignBytes, signerPub, stream } from './helpers/fake-api.mjs';
import { engineDir } from './helpers/env.mjs';

const PUB = signerPub();

test('Ed25519: RFC 8032 test 1, and the fallback agrees with WebCrypto', async () => {
  const pub = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
  const sig = Buffer.from('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b', 'hex');
  for (const f of [verify, verifyFallback]) {
    assert.equal(await f(new Uint8Array(pub), new Uint8Array(0), new Uint8Array(sig)), true);
    const bad = new Uint8Array(sig); bad[5] ^= 1;
    assert.equal(await f(new Uint8Array(pub), new Uint8Array(0), bad), false);
  }
  for (let i = 0; i < 4; i++) {
    const msg = stream('m' + i, 37 * i);
    const s = edSignBytes(msg);
    assert.equal(await verifyFallback(PUB, msg, s), true);
    assert.equal(await verify(PUB, msg, s), true);
    assert.equal(await verifyFallback(PUB, stream('x' + i, 5), s), false);
  }
});

test('the engine index: signed, parsed, refused when changed; files held to their hashes', async () => {
  const files = [{ name: 'qlcore.wasm', sha256: 'ab'.repeat(32), size: 3 }, { name: 'qlcore.mjs', sha256: 'cd'.repeat(32), size: 2 }];
  const text = engineIndexText({ engine: '20261114.0123456789ab', core: { release: '4.0.0-c1', commit: '932f419' }, files });
  const kid = hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', PUB))).slice(0, 16);
  const good = { text, kid, sig: b64u(edSignBytes(utf8(text))) };
  const idx = await verifyEngineIndex(good, [hex(PUB)]);
  assert.equal(idx.engine, '20261114.0123456789ab');
  assert.deepEqual(variantFiles(idx, 'st').wasm.name, 'qlcore.wasm');
  assert.equal(variantFiles(idx, 'mt'), null);
  await assert.rejects(verifyEngineIndex({ ...good, text: text.replace('size', 'size') + '' .padEnd(0) + 'file ' + 'ef'.repeat(32) + ' 1 qlcore-mt.mjs\n' }, [hex(PUB)]), { code: 'signature' });
  await assert.rejects(verifyEngineIndex({ ...good, kid: '00'.repeat(8) }, [hex(PUB)]), { code: 'key' });
  const other = engineIndexText({ engine: '20261114.0123456789ab', api: 5, core: { release: 'x', commit: 'abcdef0' }, files });
  await assert.rejects(verifyEngineIndex({ text: other, kid, sig: b64u(edSignBytes(utf8(other))) }, [hex(PUB)]), { code: 'api' });
  assert.throws(() => parseEngineIndex(text.replace('api 4', 'api four')), { code: 'format' });
  assert.throws(() => parseEngineIndex(text + 'file ' + 'ab'.repeat(32) + ' 1 ../evil.js\n'), { code: 'format' });
  await assert.rejects(checkEngineFile(files[1], new Uint8Array(3)), { code: 'size' });
  await assert.rejects(checkEngineFile(files[1], new Uint8Array(2)), { code: 'sha256' });
});

test('the engine choice: a pin in force, else current; threads only when isolated with 4 cores', () => {
  const web = { engine: { current: '20261114.aaaaaaaaaaaa', pinned: '20261101.bbbbbbbbbbbb', pinned_until: 2000, previous: '20261107.cccccccccccc' } };
  assert.deepEqual(chooseEngine(web, { now: 1000 }), { id: '20261101.bbbbbbbbbbbb', why: 'pinned', previous: '20261107.cccccccccccc', variant: 'st' });
  assert.equal(chooseEngine(web, { now: 2000 }).id, '20261114.aaaaaaaaaaaa');
  assert.equal(chooseEngine(web, { now: 2000, isolated: true, cores: 8 }).variant, 'mt');
  assert.equal(chooseEngine(web, { now: 2000, isolated: true, cores: 8, threads: 'off' }).variant, 'st');
  assert.equal(chooseEngine(web, { now: 2000, isolated: false, cores: 8 }).variant, 'st');
  assert.deepEqual(chooseEngine({ engine: { current: '../x' } }, { fallback: '20261114.dddddddddddd' }).why, 'built-in');
  assert.equal(chooseEngine(null, {}).id, null);
});

const ed = engineDir();
test('the packaged engine: its index verifies with the test key and every file is the signed bytes', { skip: ed && existsSync(join(ed, 'index.json')) ? false : 'no packaged engine' }, async () => {
  const idx = await verifyEngineIndex(JSON.parse(readFileSync(join(ed, 'index.json'), 'utf8')), [hex(PUB)]);
  assert.equal(idx.files.length, 4);
  for (const f of idx.files) await checkEngineFile(f, new Uint8Array(readFileSync(join(ed, f.name))));
  assert.match(readFileSync(join(ed, 'qlcore-mt.mjs'), 'utf8'), /globalThis\.__qlPthreadUrl/);
});

// stand-in windows: postMessage delivers only to the target origin ('*': any), and stamps the sender's real origin
function windows({ parentOrigin, hash = '', ancestor = undefined, ackBody = {}, otherSender = null }) {
  const mk = (origin) => ({ origin, ls: [], addEventListener(t, f) { this.ls.push(f); }, removeEventListener(t, f) { this.ls = this.ls.filter((x) => x !== f); } });
  const parent = mk(parentOrigin), frame = mk('https://web.quranlab.ai');
  parent.postMessage = (data, target) => { if (target !== '*' && target !== parent.origin) return; for (const f of parent.ls.slice()) f({ data, origin: frame.origin, source: frame, ports: [] }); };
  frame.parent = parent;
  frame.top = parent;
  frame.opener = null;
  frame.location = { pathname: '/4/frame/qlk_v1_apps-one_aaaa', hash, ancestorOrigins: ancestor };
  // the loader's side: answer a hello with an ack and a port, from the parent (or, for a test, from another window)
  parent.addEventListener('message', (e) => {
    if (!e.data || e.data.ql !== 'hello') return;
    const from = otherSender || parent;
    for (const f of frame.ls.slice()) f({ data: { ql: 'ack', api: 4, nonce: e.data.nonce, ...ackBody }, origin: from.origin, source: from, ports: [{ port: 1 }] });
  });
  return frame;
}

test('the handshake: the site is the origin the browser stamps on the parent\'s ack, never a claim', async () => {
  const ok = await handshake(windows({ parentOrigin: 'https://app.example' }), { timeoutMs: 200 });
  assert.equal(ok.site, 'https://app.example');
  assert.equal(ok.key, 'qlk_v1_apps-one_aaaa');
  // a URL that claims another origin (an older loader's `o`), an ack body that names a site: ignored
  const claimed = await handshake(windows({ parentOrigin: 'https://app.example', hash: '#o=https%3A%2F%2Fevil.example&s=one', ackBody: { site: 'https://evil.example', opts: { site: 'https://evil.example' } } }), { timeoutMs: 200 });
  assert.equal(claimed.site, 'https://app.example');
  assert.equal(claimed.storage, 'one');
  assert.equal(parseFrameUrl({ pathname: '/4/frame/qlk_v1_k', hash: '#o=https://evil.example' }).site, undefined, 'the URL never gives a site');
  // ancestorOrigins names another parent than the one that answered
  await assert.rejects(handshake(windows({ parentOrigin: 'https://app.example', ancestor: ['https://evil.example'] }), { timeoutMs: 200 }), /ancestor/);
  // an ack from a window that is not the parent is never taken
  const other = { origin: 'https://app.example' };
  await assert.rejects(handshake(windows({ parentOrigin: 'https://app.example', otherSender: other }), { timeoutMs: 200 }), /timeout/);
  assert.equal(parseFrameUrl({ pathname: '/4/frame/notakey', hash: '' }), null);
});

test('the frame refuses to run top-level and when opened by window.open (frame-ancestors does not cover either)', async () => {
  const top = windows({ parentOrigin: 'https://app.example' });
  top.parent = top; top.top = top;
  await assert.rejects(handshake(top, { timeoutMs: 200 }), /top_level/);
  assert.equal(notFramed(top), 'top_level');
  const opened = windows({ parentOrigin: 'https://app.example' });
  opened.parent = opened; opened.top = opened; opened.opener = { origin: 'https://evil.example' };
  await assert.rejects(handshake(opened, { timeoutMs: 200 }), /opened/);
  const noParent = windows({ parentOrigin: 'https://app.example' });
  noParent.parent = null; noParent.top = noParent;
  assert.equal(notFramed(noParent), 'top_level');
  const framed = windows({ parentOrigin: 'https://app.example' });
  assert.equal(notFramed(framed), null);
});

test('no analytics or audience option in 4.0: the frame passes neither to its Worker, whatever the page puts in its opts', async () => {
  for (const opts of [{ analytics: 'off' }, { analytics: 'on', appVersion: '2.1', audience: 'children' }, { audience: 'general' }, { audience: undefined }, {}]) {
    const win = windows({ parentOrigin: 'https://app.example', ackBody: { opts } });
    const posted = [];
    win.Worker = class { constructor() {} postMessage(m) { posted.push(m); } };
    win.MessageChannel = MessageChannel;
    win.document = { body: { dataset: {} } };
    const r = await startFrame(win);
    assert.equal(r.site, 'https://app.example');
    assert.equal(posted.length, 1);
    assert.equal('analytics' in posted[0], false, JSON.stringify(Object.keys(posted[0])));
    assert.equal('audience' in posted[0], false, JSON.stringify(Object.keys(posted[0])));
    if (opts.appVersion) assert.equal(posted[0].appVersion, '2.1');
    for (const p of [posted[0].frame]) p.close();
  }
});

test('reportRecited: argument errors (17.9), never sent', () => {
  assert.deepEqual(checkReport(2, 255, 257, { outcome: { correct: false, mistakes: 2, rules: ['madd'] }, perAyah: { 255: { correct: true } } }),
    { surah: 2, from: 255, to: 257, outcome: { correct: false, mistakes: 2, rules: ['madd'] }, perAyah: { 255: { correct: true } } });
  for (const bad of [[0, 1, 1], [2, 5, 4], [1, 1, 8], [2, 1, 2, { outcome: { correct: true, mistakes: 1 } }], [2, 1, 2, { outcome: { correct: false, mistakes: 0 } }],
    [2, 1, 2, { outcome: { correct: false, rules: ['Madd'] } }], [2, 1, 2, { outcome: { correct: false, rules: Array(9).fill('a') } }],
    [2, 1, 2, { perAyah: { 3: { correct: true } } }], [2, 1, 2, { outcome: { correct: 'yes' } }], [2, 1, 2, { other: 1 }]]) {
    assert.throws(() => checkReport(...bad), ReportError, JSON.stringify(bad));
  }
});

test('one source per take: measured first, the app only where nothing was measured; judgement pairs with the counted ayahs', () => {
  const report = checkReport(2, 255, 257, { outcome: { correct: false, mistakes: 1, rules: ['madd'] }, perAyah: { 255: { correct: true }, 257: { correct: true } } });
  const seen = new Set();
  const m = takeCounts({ found: true, surah: 2, first: 256, last: 258 }, report, seen);
  assert.equal(m.source, 'measured');
  assert.deepEqual(m.measured, { surah: 2, ayahs: 3 });
  assert.equal(m.app, null);
  // 256 and 258 get the whole-range outcome (incorrect), 257 its own (correct); 255 is outside the measured range
  assert.equal(m.judged.ayahs, 3); assert.equal(m.judged.correct, 1); assert.equal(m.judged.unpaired, 1); assert.equal(m.judged.measured, 3);
  assert.deepEqual(m.judged.rules, { madd: 2 });
  const again = takeCounts({ found: true, surah: 2, first: 256, last: 256 }, report, seen);
  assert.equal(again.judged.repeat, 1);
  const app = takeCounts({ found: false }, report, new Set());
  assert.equal(app.source, 'app'); assert.deepEqual(app.app, { surah: 2, ayahs: 3 }); assert.equal(app.judged.measured, 0);
  assert.equal(takeCounts(null, null).source, 'none');
});

test('the 4.0 body: measured ayahs never in reported, the app counts and the judgement always', async () => {
  const state = await StateStore.open(new MemoryKV());
  const t = new Telemetry4({ state, platform: 'web', sdkVersion: '4.0.0', clock: () => Date.UTC(2026, 10, 14) });
  const m = takeCounts({ found: true, surah: 1, first: 1, last: 7 }, null);
  m.range = { surah: 1, first: 1, last: 7 };
  t.countTake(m, { detectorRan: true });
  t.countTake(takeCounts({ found: false }, checkReport(2, 1, 3, { outcome: { correct: true } })), { detectorRan: true });
  t.seal();
  const body = JSON.parse(state.get('telemetry.sealed')[0].body);
  assert.equal(body.ayahs, 7); assert.deepEqual(body.surah_ayahs, { 1: 7 });
  assert.equal(body.app_ayahs, 3); assert.deepEqual(body.app_surah_ayahs, { 2: 3 });
  assert.deepEqual(body.reported, ['app_ayahs', 'app_surah_ayahs', 'judged', 'judged_surah_ayahs', 'correct_surah_ayahs', 'judged_tenure']);
  assert.equal(body.sdk_version, '4.0.0');
  assert.equal(body.coverage, undefined);
});
