// The cross-SDK byte vector for shared-session audio (PLATFORM_CLIENT.md section 10.2): a fixed input
// through the web encoder and Ogg writer must give exactly the pinned bytes. Input: 3 s at 48 kHz of
// the Swift tests' noise (64-bit LCG, seed 1, top 24 bits, gain 0.3, all in Float arithmetic), pushed
// at once; serial 42; vendor "QuranLab SDK 2.0.0 libopus 1.6.1"; one file (no segments), and the same
// input cut by the segment plan scaled down ([1, 1]: 50-packet segments) to pin the cut points.
// The 48 kHz input keeps the resampler out (each SDK's resampler is its own filter).
//
// MAKE_SHARING_VECTOR=1 writes the files to the shared sharing vectors/ (web_*.ogg).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OggOpusWriter, OpusEncoder, OPUS_SETTINGS, loadOpus, sha256Hex, deletionMessage, b64url } from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const VECTORS = process.env.SHARING_VECTORS || fileURLToPath(new URL('./sharing/vectors', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';

// pinned: the bytes the web SDK writes (libopus 1.6.1 in wasm; the same packets as a native x86-64 gcc
// build of the same sources, checked when the vector was made)
const PINNED = {
  'web_noise48k_3s.ogg': '904c8177e4177f12ba917bd04c7a0ccce6677612780e09811addfced1e51fcf9',
  'web_noise48k_3s_seg50.ogg': '904c8177e4177f12ba917bd04c7a0ccce6677612780e09811addfced1e51fcf9',
};

function input() {
  const n = 48000 * 3, x = new Float32Array(n);
  let s = 1n;
  for (let i = 0; i < n; i++) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    x[i] = Math.fround(Math.fround(Number(s >> 40n) / 16777216 * 2 - 1) * Math.fround(0.3));
  }
  return x;
}

async function make(m, plan) {
  const pages = new Map();
  const w = new OggOpusWriter({ encoder: new OpusEncoder(m), inputRate: 48000, plan, serial: 42, vendor: 'QuranLab SDK 2.0.0 libopus 1.6.1',
    onPage: (n, b) => { if (!pages.has(n)) pages.set(n, []); pages.get(n).push(b); } });
  w.append(input());
  w.finish();
  const parts = [...pages.keys()].sort((a, b) => a - b).flatMap((k) => pages.get(k));
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { bytes: out, segments: pages.size };
}

test('the web encode vector: libopus in wasm, bytes pinned', { skip }, async (t) => {
  const m = await loadOpus();
  const one = await make(m, []);
  const seg = await make(m, [1, 1]);
  assert.deepEqual(one.bytes, seg.bytes, 'segmenting never changes the bytes');
  assert.equal(seg.segments, 4, '50 + 50 + 50 + 1 packets');
  const files = { 'web_noise48k_3s.ogg': one.bytes, 'web_noise48k_3s_seg50.ogg': seg.bytes };
  const hashes = {};
  for (const [k, v] of Object.entries(files)) hashes[k] = await sha256Hex(v);
  t.diagnostic(`web vector sha256: ${JSON.stringify(hashes)}`);
  if (process.env.MAKE_SHARING_VECTOR === '1') {
    mkdirSync(VECTORS, { recursive: true });
    for (const [k, v] of Object.entries(files)) writeFileSync(path.join(VECTORS, k), v);
  }
  for (const [k, h] of Object.entries(PINNED)) if (h) assert.equal(hashes[k], h, k);
});

// The cross-SDK muxer vector (the shared sharing vectors/ogg/, from quranlab-local scripts/sharing-vectors.mjs):
// deterministic non-Opus packets fed to the muxer in place of the encoder; every segment file must be
// byte for byte the expected one.
test('the cross-SDK muxer vector: every segment byte for byte', async (t) => {
  const dir = path.join(VECTORS, 'ogg');
  if (!existsSync(path.join(dir, 'expected.json'))) { t.skip(`no ${dir}/expected.json`); return; }
  const ex = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8'));
  const I = ex.input;
  const packets = Array.from({ length: I.packets }, (_, i) => Uint8Array.from({ length: 3 + ((i * 37) % 290) }, (_, j) => (i * 31 + j * 7 + 1) & 255));
  let given = 0;
  // a test seam in place of the encoder: each 20 ms of input yields the next packet
  const encoder = {
    preSkip: I.pre_skip,
    encode(x) { const n = Math.floor(x.length / 960); const out = packets.slice(given, given + n); given += n; return out; },
    flush() { const out = packets.slice(given); given = packets.length; return out; },
    finalGranulePosition: I.final_granule,
  };
  const segs = new Map(), closed = [];
  // input_rate 44100 is only the OpusHead field here: the stub takes the 48 kHz count it is given
  const w = new OggOpusWriter({ encoder, resampler: { process: (x, sink) => sink(x), flush: () => {} }, inputRate: I.input_rate,
    plan: I.plan_seconds, settings: { ...OPUS_SETTINGS, frameMs: I.frame_ms }, serial: I.serial, vendor: I.vendor,
    onPage: (n, b) => { if (!segs.has(n)) segs.set(n, []); segs.get(n).push(b); }, onSegment: (c) => closed.push(c) });
  const step = new Float32Array(960 * 7);
  while (given < I.packets - 7) w.append(step);
  w.finish();
  const bad = [];
  for (const sg of ex.segments) {
    const parts = segs.get(sg.n) || [];
    const mine = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
    let at = 0;
    for (const p of parts) { mine.set(p, at); at += p.length; }
    const want = new Uint8Array(readFileSync(path.join(dir, sg.file)));
    const h = await sha256Hex(mine);
    if (h !== sg.sha256 || Buffer.compare(Buffer.from(mine), Buffer.from(want)) !== 0) bad.push(`${sg.file}: ${mine.length} bytes vs ${want.length}`);
  }
  t.diagnostic(`${ex.segments.length - bad.length}/${ex.segments.length} segment files byte-identical; closed ${closed.map((c) => c.n).join(',')}`);
  assert.deepEqual(bad, []);
  assert.equal(segs.size, ex.segments.length);
});

// The deletion signing vector (the shared sharing vectors/signing.json): the exact message bytes, the
// contributor_key encoding, and the vector's signatures verified with WebCrypto.
test('the cross-SDK deletion signing vector: message bytes, key encoding, signatures verify', async (t) => {
  const f = path.join(VECTORS, 'signing.json');
  if (!existsSync(f)) { t.skip(`no ${f}`); return; }
  const v = JSON.parse(readFileSync(f, 'utf8'));
  const unb64 = (x) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const raw = unb64(v.public_key_uncompressed_b64url);
  assert.equal(raw.length, 65);
  assert.equal(b64url(raw), v.contributor_key);
  const pub = await crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const priv = await crypto.subtle.importKey('jwk', { ...v.private_key_jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  let n = 0;
  for (const c of v.cases) {
    const msg = deletionMessage(c.fields);
    assert.equal(new TextDecoder().decode(msg), c.message);
    assert.equal(await sha256Hex(msg), c.message_sha256);
    if (c.signature_p1363_b64url) assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(c.signature_p1363_b64url), msg));
    const mine = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg));
    assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, mine, msg));
    n++;
  }
  t.diagnostic(`${n} signing cases: message bytes equal, vector and own signatures verify`);
});
