// SDK 3.1.3, the answers a ranged model download accepts (web/tajweed/delivery.js): a 2xx answer is the file's
// bytes only when it is what was asked for.
//
//   - 200 (the server ignored Range) is the whole file only at the manifest's size: a Content-Length, when given
//     without a content coding, must equal it; a body that runs past the size is cut off; a shorter one fails.
//   - 206 is a range only with the bytes that were asked for; its Content-Range, where it can be read, must be
//     exactly `bytes <start>-<end>/<the manifest's size>`. Where it cannot be read (a page reads it only when the
//     host names it in access-control-expose-headers; Quran Lab's CDN does), the range's exact length and the
//     file's SHA-256 decide.
//   - Any other answer is a failed attempt: the read ends with a download failure, one request was made for the
//     range (nothing is asked again inside a read), and the ranges already stored stay, so the next read goes on
//     from them. Ranges are deleted in one case only: every range is there and the file assembled from them fails
//     its size or its SHA-256, so the ranges themselves are the fault and the next read must start clean.
//
// WHERE THIS RUNS: Node, with a stand-in for the CDN as a fetch function (the answers are Response objects made
// here) and a memory store. The file has 10 bytes in ranges of 4, so three ranges: 0-3, 4-7, 8-9. Range 0-3 is
// stored before each case, as an interrupted download leaves it.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { cachedReader, memoryStore, DeliveryError } from '../web/tajweed/delivery.js';
import { sha256Hex } from '../web/tajweed/manifest.js';
import { toTajweedError } from '../web/api/errors.js';

const FILE = Uint8Array.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
const SUM = await sha256Hex(FILE);
const BASE = 'https://cdn.test/models/x/';
const manifest = new TextEncoder().encode(JSON.stringify({ files: [{ path: 'a.bin', size: FILE.length, sha256: SUM }] }));
const rangeOf = (init) => { const m = /^bytes=(\d+)-(\d+)$/.exec((init.headers && init.headers.range) || ''); return m ? [Number(m[1]), Number(m[2])] : null; };
const good = (lo, hi) => new Response(FILE.slice(lo, hi + 1), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/${FILE.length}` } });

/** A reader on a store that holds range 0-3; `answer(lo, hi, n)` is the CDN's answer to the n-th request for the file. */
async function setup(answer) {
  const store = memoryStore();
  await store.put(`part/${SUM}/0`, FILE.slice(0, 4));
  const asked = [];
  const fetch = async (url, init = {}) => {
    if (String(url).endsWith('manifest.json')) return new Response(manifest, { status: 200 });
    const r = rangeOf(init);
    asked.push(r ? `${r[0]}-${r[1]}` : 'whole');
    return answer(r ? r[0] : null, r ? r[1] : null, asked.length);
  };
  const reader = cachedReader({ baseUrl: BASE, fetch, store, rangeSize: 4, parallel: 1 });
  await reader.read('manifest.json');
  return { store, asked, reader };
}
const storedRanges = async (store) => (await store.keys(`part/${SUM}/`)).sort().map((k) => k.split('/')[2]).join(',');
// after a failed attempt: a read against a CDN that answers well goes on from the stored range
async function resumes(store) {
  const asked = [];
  const reader = cachedReader({ baseUrl: BASE, store, rangeSize: 4, parallel: 1, fetch: async (url, init = {}) => {
    if (String(url).endsWith('manifest.json')) return new Response(manifest, { status: 200 });
    const [lo, hi] = rangeOf(init);
    asked.push(`${lo}-${hi}`);
    return good(lo, hi);
  } });
  await reader.read('manifest.json');
  assert.deepEqual([...(await reader.read('a.bin'))], [...FILE], 'the next read gives the file');
  assert.deepEqual(asked, ['4-7', '8-9'], 'and asks only for the ranges that were not stored');
  assert.equal(reader.stats.rangesResumed, 1);
}
/** One failed attempt: the error, one request, the stored range kept, and the next read resumes. */
async function failedAttempt(answer, { code, app = 'download_failed', requests = ['4-7'] }) {
  const { store, asked, reader } = await setup(answer);
  const e = await reader.read('a.bin').then(() => null, (x) => x);
  assert.ok(e instanceof DeliveryError, `the read fails with a delivery error (${e ? `${e.name}: ${e.message}` : 'it gave the file'})`);
  assert.equal(e.code, code, e.message);
  assert.equal(toTajweedError(e, {}).code, app, 'what the app gets');
  assert.deepEqual(asked, requests, 'one request for the range, none again');
  assert.equal(await storedRanges(store), '0', 'the range stored before is still there, and nothing else');
  assert.deepEqual([...(await store.get(`part/${SUM}/0`))], [...FILE.slice(0, 4)]);
  assert.equal((await store.keys(`sha256/${SUM}`)).length, 0, 'no file was stored');
  await resumes(store);
}

test('a 204 is not an answer to a range request: a failed attempt, the stored range kept', async () => {
  await failedAttempt(() => new Response(null, { status: 204 }), { code: 'http' });
});

test('a 200 that is shorter than the file (with its own Content-Length, and without one): a failed attempt, the stored range kept', async () => {
  await failedAttempt(() => new Response(FILE.slice(0, 6), { status: 200, headers: { 'content-length': '6' } }), { code: 'http' });
  await failedAttempt(() => new Response(FILE.slice(0, 6), { status: 200 }), { code: 'offline' });
});

test('a 200 that is longer than the file: refused by its Content-Length without reading it, and cut off when it has none; the stored range kept', async () => {
  const long = new Uint8Array(64).fill(1);
  await failedAttempt(() => new Response(long, { status: 200, headers: { 'content-length': '64' } }), { code: 'http' });
  // a body with no length that never ends by itself: the read stops at the first byte past the manifest's size
  let pulled = 0, cancelled = false;
  const endless = () => new Response(new ReadableStream({
    pull(c) { pulled += 8; c.enqueue(new Uint8Array(8).fill(2)); if (pulled > 4096) c.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200 });
  await failedAttempt(endless, { code: 'http' });
  assert.ok(pulled <= 32, `the body was cut off just past the file's 10 bytes (${pulled} bytes were produced)`);
  assert.equal(cancelled, true, 'and the rest of it was let go');
});

test('a 200 with a JSON error body: a failed attempt, the stored range kept', async () => {
  const body = '{"error":"internal","message":"try again"}';
  await failedAttempt(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }), { code: 'http' });
  await failedAttempt(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }), { code: 'http' });
});

test('an empty 206, and a 206 with fewer or more bytes than the range: a failed attempt, the stored range kept', async () => {
  await failedAttempt((lo, hi) => new Response(new Uint8Array(0), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/10` } }), { code: 'offline' });
  await failedAttempt((lo, hi) => new Response(FILE.slice(lo, hi), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/10` } }), { code: 'offline' });
  await failedAttempt((lo, hi) => new Response(new Uint8Array(40).fill(3), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/10` } }), { code: 'http' });
});

test('a 206 whose Content-Range names another total, another start or another end, or is not a byte range: a failed attempt, the stored range kept', async () => {
  for (const range of [(lo, hi) => `bytes ${lo}-${hi}/999`, (lo, hi) => `bytes ${lo}-${hi}/*`, () => 'bytes 0-3/10', (lo) => `bytes ${lo}-9/10`, () => 'items 4-7/10', () => '']) {
    await failedAttempt((lo, hi) => new Response(FILE.slice(lo, hi + 1), { status: 206, headers: { 'content-range': range(lo, hi) } }), { code: 'http' });
  }
});

test('a 206 whose Content-Range cannot be read (a host that does not expose it to a page): the exact length of the range and the file\'s SHA-256 decide', async () => {
  // the right bytes: the file is given
  const ok = await setup((lo, hi) => new Response(FILE.slice(lo, hi + 1), { status: 206 }));
  assert.deepEqual([...(await ok.reader.read('a.bin'))], [...FILE]);
  assert.deepEqual(ok.asked, ['4-7', '8-9']);
  assert.equal(await storedRanges(ok.store), '', 'the ranges are gone once the file is stored');
  assert.equal((await ok.store.keys(`sha256/${SUM}`)).length, 1);
  // ranges of the right length with the wrong bytes: every range is there and the assembled file fails its
  // SHA-256, so the ranges themselves are the fault: they are deleted, and the next read starts clean
  const bad = await setup((lo, hi) => new Response(new Uint8Array(hi - lo + 1).fill(9), { status: 206 }));
  const e = await bad.reader.read('a.bin').then(() => null, (x) => x);
  assert.ok(e instanceof DeliveryError && e.code === 'checksum_mismatch', `checksum_mismatch (${e && e.message})`);
  assert.equal(toTajweedError(e, {}).code, 'checksum_mismatch');
  assert.deepEqual(bad.asked, ['4-7', '8-9'], 'each missing range was asked for once');
  assert.equal(await storedRanges(bad.store), '', 'the ranges that did not add up to the file are gone');
  assert.equal((await bad.store.keys(`sha256/${SUM}`)).length, 0);
});

test('a 200 of the manifest\'s size is the whole file (the server ignored Range); with the wrong bytes it is checksum_mismatch and the stored range stays', async () => {
  for (const headers of [{ 'content-length': '10' }, {}, { 'content-length': '7', 'content-encoding': 'gzip' }]) {
    const ok = await setup(() => new Response(FILE.slice(), { status: 200, headers }));
    assert.deepEqual([...(await ok.reader.read('a.bin'))], [...FILE], JSON.stringify(headers));
    assert.deepEqual(ok.asked, ['4-7'], 'one request');
    assert.equal((await ok.store.keys(`sha256/${SUM}`)).length, 1);
  }
  await failedAttempt(() => new Response(new Uint8Array(10).fill(5), { status: 200, headers: { 'content-length': '10' } }), { code: 'checksum_mismatch', app: 'checksum_mismatch' });
});

test('no answer makes a read ask again: a CDN that gives the same wrong answer to every request is asked once per read', async () => {
  const { asked, reader, store } = await setup((lo, hi) => new Response(FILE.slice(lo, hi + 1), { status: 206, headers: { 'content-range': `bytes ${lo}-${hi}/999` } }));
  for (let i = 1; i <= 5; i++) {
    await assert.rejects(reader.read('a.bin'), (e) => e instanceof DeliveryError && e.code === 'http');
    assert.equal(asked.length, i, `read ${i}: one request`);
  }
  assert.equal(await storedRanges(store), '0');
});
