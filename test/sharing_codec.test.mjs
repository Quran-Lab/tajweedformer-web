// The sharing codec (web/sharing: libopus 1.6.1 in wasm, the Ogg writer, the resampler), ported
// from the Swift SDK's SharingCodecTests and the codec half of SharingTests: the same settings,
// RFC 7845 framing, page packing, segment boundaries, non-finite input, torn-page recovery, flat
// memory, and the decoded length. Needs dist/tajweedformer-opus.mjs (npm run build:opus); skipped
// without it (REQUIRE_OPUS=1 makes that an error).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OggOpusWriter, OpusEncoder, ShareResampler, OPUS_SETTINGS, OPUS_REQUEST, SEGMENT_PLAN, loadOpus, opusVersion, decodeOggOpus,
  readPages, wholePages, oggCrc, requestCounts, segmentSeconds,
} from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const m = have ? await loadOpus() : null;

// Swift SharingCodecTests.noise: a 64-bit LCG, the top 24 bits of the state
function noise(n, seed = 1n, gain = 0.3) {
  let s = BigInt(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    out[i] = Math.fround((Number(s >> 40n) / 16777216 * 2 - 1) * Math.fround(gain)); // Float arithmetic, as Swift
  }
  return out;
}
const tone = (n, rate, hz = 440, from = 0) => Float32Array.from({ length: n }, (_, i) => Math.fround(Math.sin((from + i) * 2 * Math.PI * hz / rate) * 0.3));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const concat = (parts) => { const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

/** A writer whose segments are kept in memory: { w, segs: Map<n, Uint8Array[]>, closed: [] }. */
function writer(inputRate, { plan = [], settings = OPUS_SETTINGS, serial } = {}) {
  const segs = new Map(), closed = [];
  const encoder = new OpusEncoder(m, { sampleRate: 48000, settings });
  const w = new OggOpusWriter({
    encoder, resampler: inputRate === 48000 ? null : new ShareResampler(inputRate), inputRate, plan, settings, serial,
    vendor: `QuranLab SDK 2.0.0 ${opusVersion(m)}`,
    onPage: (n, b) => { if (!segs.has(n)) segs.set(n, []); segs.get(n).push(b); },
    onSegment: (s) => closed.push(s),
  });
  const bytes = (n) => concat(segs.get(n) || []);
  const all = () => concat([...segs.keys()].sort((a, b) => a - b).map(bytes));
  return { w, encoder, segs, closed, bytes, all };
}

test('encoder settings: the measured defaults, read back from libopus', { skip }, () => {
  const s = OPUS_SETTINGS;
  assert.deepEqual([s.application, s.bitrate, s.complexity, s.vbr, s.constrainedVbr, s.bandwidth, s.signal, s.frameMs],
    [2049, 192000, 10, true, false, 1105, -1000, 20]);
  assert.equal(opusVersion(m), 'libopus 1.6.1');
  const e = new OpusEncoder(m);
  const packets = e.encode(noise(48000));
  assert.equal(packets.length, 50);
  const R = OPUS_REQUEST;
  assert.equal(e.get(R.GET_APPLICATION), 2049);
  assert.equal(e.get(R.GET_BITRATE), 192000);
  assert.equal(e.get(R.GET_COMPLEXITY), 10);
  assert.equal(e.get(R.GET_VBR), 1);
  assert.equal(e.get(R.GET_VBR_CONSTRAINT), 0);
  assert.equal(e.get(R.GET_BANDWIDTH), 1105);
  assert.equal(e.get(R.GET_SIGNAL), -1000);
  assert.equal(e.get(R.GET_SAMPLE_RATE), 48000);
  assert.equal(e.get(R.GET_LSB_DEPTH), 24);
  assert.equal(e.get(R.GET_DTX), 0);
  assert.equal(e.get(R.GET_INBAND_FEC), 0);
  assert.equal(e.get(R.GET_LOOKAHEAD), 312);
  assert.equal(e.preSkip, 312);
  for (const p of packets) assert.equal(p[0], 31 << 3, 'CELT-only, fullband, 20 ms, one frame, mono');
  assert.ok(packets.reduce((k, p) => k + p.length, 0) * 8 > 150000, 'VBR spends about the target on noise');
  e.free();
});

test('Ogg Opus follows RFC 7845 at 16, 44.1 and 48 kHz', { skip }, () => {
  for (const rate of [16000, 44100, 48000]) {
    const { w, all } = writer(rate);
    const n = Math.round(rate * 3.37);
    let at = 0;
    while (at < n) { const k = Math.min(randInt(1, 5000), n - at); w.append(tone(k, rate, 440, at)); at += k; }
    assert.equal(w.finish(), 3370);
    const pages = readPages(all());
    assert.deepEqual(pages.map((p) => p.sequence), pages.map((_, i) => i));
    assert.equal(pages[0].flags, 0x02);
    const head = pages[0].packets[0];
    assert.equal(new TextDecoder().decode(head.subarray(0, 8)), 'OpusHead');
    assert.equal(head[9], 1, 'mono');
    const preSkip = head[10] | (head[11] << 8);
    assert.equal(preSkip, 312);
    assert.equal(new DataView(head.buffer, head.byteOffset).getUint32(12, true), rate, 'OpusHead: the true input rate');
    assert.equal(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8)), 'OpusTags');
    assert.equal(pages[pages.length - 1].flags, 0x04);
    let packets = 0, last = 0;
    for (const p of pages.slice(2)) {
      packets += p.packets.length;
      assert.ok(p.granule >= last);
      last = p.granule;
      if (p.flags !== 0x04) { assert.equal(p.granule, packets * 960); assert.equal(p.packets.length, 50, 'a page is a second of packets'); }
    }
    assert.equal(decodeOggOpus(m, pages).length, Math.round(3.37 * 48000), `${rate}: decoded length`);
    assert.equal(pages[pages.length - 1].granule - preSkip, Math.round(3.37 * 48000), 'the last granule trims to the input length');
    assert.ok(packets * 960 >= preSkip + 3.37 * 48000);
  }
});

test('page packing and segment boundaries (20 ms at 192 kbps, 10 ms at 510 kbps)', { skip }, () => {
  for (const [bitrate, frameMs] of [[192000, 20], [510000, 10]]) {
    const settings = { ...OPUS_SETTINGS, bitrate, frameMs };
    const perSecond = 1000 / frameMs;
    const { w, closed, bytes, all } = writer(48000, { plan: [3, 5], settings });
    const x = noise(48000 * 14, 1n, 0.9);
    let at = 0;
    while (at < x.length) { const k = Math.min(480 * randInt(1, 9), x.length - at); w.append(x.subarray(at, at + k)); at += k; }
    w.finish();
    assert.deepEqual(closed.map((c) => c.n), [1, 2, 3, 4]);
    const pf = 48 * frameMs;
    const total = Math.floor((14 * 48000 + 312 + pf - 1) / pf);
    const audio = closed.map((c, i) => { const p = readPages(bytes(c.n)); return i === 0 ? p.slice(2) : p; });
    assert.deepEqual(audio.map((p) => p.reduce((k, x) => k + x.packets.length, 0)), [3 * perSecond, 5 * perSecond, 5 * perSecond, total - 13 * perSecond]);
    const perPage = audio.flatMap((seg) => seg.slice(0, -1).map((p) => p.packets.length));
    for (const c of closed) {
      const b = bytes(c.n);
      for (let o = 0; o < b.length;) { const n = b[o + 26]; assert.ok(n <= 255); o += 27 + n + b.subarray(o + 27, o + 27 + n).reduce((k, v) => k + v, 0); }
    }
    if (frameMs === 20) assert.deepEqual([...new Set(perPage)], [50], 'one-second pages');
    else { assert.ok(perPage.every((k) => k >= 60 && k <= 100), String(perPage)); assert.ok(perPage.some((k) => k < 100), 'the lacing limit cut pages short'); }
    assert.equal(decodeOggOpus(m, readPages(all())).length, 48000 * 14);
  }
});

test('44.1, 16 and 22.05 kHz input is resampled to 48 kHz, aligned, the input\'s length', { skip }, () => {
  for (const rate of [44100, 16000, 22050]) {
    const { w, all } = writer(rate);
    const n = rate * 4;
    let at = 0;
    while (at < n) { const k = Math.min(Math.trunc(rate / 100) * randInt(1, 4), n - at); w.append(tone(k, rate, 440, at)); at += k; }
    assert.equal(w.finish(), 4000);
    const y = decodeOggOpus(m, readPages(all()));
    assert.equal(y.length, 4 * 48000, `${rate}`);
    const ref = tone(y.length, 48000);
    let sig = 0, err = 0;
    for (let i = 4800; i < y.length - 4800; i++) { sig += ref[i] * ref[i]; err += (y[i] - ref[i]) ** 2; }
    const snr = 10 * Math.log10(sig / err);
    assert.ok(snr > 30, `${rate} Hz: ${snr.toFixed(1)} dB`);
  }
});

test('the resampler alone: length, alignment and a clean tone (no codec)', () => {
  for (const rate of [44100, 16000, 22050, 8000, 96000]) {
    const r = new ShareResampler(rate);
    const n = rate * 2;
    const x = tone(n, rate, 440);
    const parts = [];
    for (let at = 0; at < n; at += 1000) r.process(x.subarray(at, Math.min(n, at + 1000)), (y) => parts.push(Float32Array.from(y)));
    r.flush((y) => parts.push(Float32Array.from(y)));
    const y = Float32Array.from(parts.flatMap((p) => [...p]));
    assert.equal(y.length, Math.ceil(n * 48000 / rate), `${rate}`);
    const ref = tone(y.length, 48000);
    let sig = 0, err = 0;
    for (let i = 2400; i < y.length - 2400; i++) { sig += ref[i] * ref[i]; err += (y[i] - ref[i]) ** 2; }
    assert.ok(10 * Math.log10(sig / err) > 60, `${rate}: ${(10 * Math.log10(sig / err)).toFixed(1)} dB`);
  }
});

test('non-finite input is coded as silence, byte for byte (48 and 44.1 kHz)', { skip }, () => {
  for (const rate of [48000, 44100]) {
    const bad = noise(rate * 3), good = bad.slice();
    for (let i = 17; i < bad.length; i += 997) { bad[i] = [NaN, Infinity, -Infinity][i % 3]; good[i] = 0; }
    const a = writer(rate, { serial: 7 }), b = writer(rate, { serial: 7 });
    for (let c = 0; c < bad.length; c += 4410) { a.w.append(bad.subarray(c, c + 4410)); b.w.append(good.subarray(c, c + 4410)); }
    a.w.finish(); b.w.finish();
    assert.equal(a.w.nonFiniteSamples, Math.trunc((bad.length - 17 + 996) / 997));
    assert.deepEqual(a.all(), b.all());
    assert.ok(decodeOggOpus(m, readPages(a.all())).every(Number.isFinite));
  }
});

test('a crash loses at most about a second; recovery keeps exactly the whole pages', { skip }, () => {
  const rate = 44100;
  const { w, all } = writer(rate);
  const x = noise(rate * 9);
  let at = 0;
  while (at < x.length) {
    const k = Math.min(441 * randInt(1, 20), x.length - at);
    w.append(x.subarray(at, at + k));
    at += k;
    assert.ok(at * 48000 / rate - Math.max(0, w.lastGranule) <= 1.1 * 48000, `at ${at}`);
  }
  const d = all();
  const pages = readPages(d);
  const ends = [];
  for (let o = 0; o < d.length;) { const n = d[o + 26]; o += 27 + n + d.subarray(o + 27, o + 27 + n).reduce((k, v) => k + v, 0); ends.push(o); }
  const cuts = [];
  for (let c = 1; c < d.length; c += 997) cuts.push(c);
  for (const e of ends) cuts.push(e - 1);
  for (const cut of cuts) {
    const { keep, granule } = wholePages(d.subarray(0, cut));
    const whole = ends.filter((e) => e <= cut);
    assert.equal(keep, whole.length ? whole[whole.length - 1] : 0, `cut at ${cut}`);
    assert.equal(granule, whole.length ? pages[whole.length - 1].granule : 0);
  }
  w.abandon();
});

test('segments concatenate to the one-file encode, byte for byte (157.3 s at 16 kHz)', { skip, timeout: 600000 }, () => {
  const rate = 16000;
  const input = Float32Array.from({ length: Math.round(rate * 157.3) }, (_, i) => Math.fround(Math.fround(Math.sin(i * 0.013)) * 0.4 + ((i * 7919) % 97) / 970 - 0.05));
  const a = writer(rate, { serial: 42 }), b = writer(rate, { serial: 42, plan: SEGMENT_PLAN });
  let at = 0;
  while (at < input.length) { const k = Math.min(randInt(100, 4000), input.length - at); a.w.append(input.subarray(at, at + k)); b.w.append(input.subarray(at, at + k)); at += k; }
  assert.equal(a.w.finish(), b.w.finish());
  assert.deepEqual(b.closed.map((c) => c.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(b.closed.map((c) => c.last), [false, false, false, false, true]);
  const parts = b.closed.map((c) => b.bytes(c.n));
  assert.deepEqual(concat(parts), a.all(), 'the segments are the one file, byte for byte');
  const pages = parts.map((p) => readPages(p));
  const isHeader = (p) => { const x = p.packets[0]; return x && x[0] === 0x4f && x[1] === 0x70 && x[2] === 0x75 && x[3] === 0x73; };
  const audio = pages.map((ps) => ps.filter((p) => !isHeader(p)));
  assert.deepEqual(audio.map((ps) => ps.reduce((k, p) => k + p.packets.length, 0)), [500, 1000, 2000, 3000, 1366]);
  assert.deepEqual(audio.map((ps) => ps.length), [10, 20, 40, 60, 28], 'one-second pages');
  assert.equal(pages[pages.length - 1].at(-1).flags, 0x04);
  assert.equal(b.closed.at(-1).granule, 312 + Math.round(157.3 * 48000));
});

test('memory is flat over a long session (10 minutes at 44.1 kHz; ZF_LONG=1: 2 hours)', { skip, timeout: 1800000 }, () => {
  const minutes = process.env.ZF_LONG === '1' ? 120 : 10;
  let bytes = 0;
  const encoder = new OpusEncoder(m);
  const w = new OggOpusWriter({ encoder, resampler: new ShareResampler(44100), inputRate: 44100, plan: [],
    onPage: (_, b) => { bytes += b.length; } });
  const chunk = noise(441);
  const marks = [];
  const t0 = performance.now();
  for (let i = 0; i < minutes; i++) {
    for (let k = 0; k < 6000; k++) w.append(chunk);
    if (i === 1 || i === minutes - 1) { globalThis.gc?.(); marks.push(process.memoryUsage().rss); }
  }
  w.finish();
  const secs = (performance.now() - t0) / 1000;
  const growth = marks[1] - marks[0];
  console.log(`# sharing memory: ${minutes} min, rss ${(marks[0] / 1e6).toFixed(1)} MB after minute 2, growth ${(growth / 1e6).toFixed(2)} MB; ` +
    `encode ${(minutes * 60 / secs).toFixed(1)} x realtime (44.1 kHz in, resampled, complexity 10); ${(bytes * 8 / (minutes * 60) / 1000).toFixed(1)} kbit/s`);
  assert.ok(growth < 8e6, `rss grew ${growth}`);
  encoder.free();
});

test('Ogg CRC against a bitwise reference, and request counts by session length', () => {
  const bitwise = (b) => { let c = 0; for (const x of b) { c ^= x << 24; for (let k = 0; k < 8; k++) c = (c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1) >>> 0; } return c >>> 0; };
  const data = Uint8Array.from({ length: 5000 }, (_, i) => (i * 2654435761) >>> 24);
  assert.equal(oggCrc(data), bitwise(data));
  assert.equal(segmentSeconds(1), 10); assert.equal(segmentSeconds(4), 60); assert.equal(segmentSeconds(9), 60);
  assert.deepEqual(requestCounts(20), { segments: 2, workerCalls: 1 });
  assert.deepEqual(requestCounts(300), { segments: 7, workerCalls: 1 });
  assert.deepEqual(requestCounts(7200), { segments: 122, workerCalls: 7 });
});

test('an independent decoder (ffmpeg, when installed) reads the stream at the right length', { skip }, (t) => {
  let ff = null;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ff = 'ffmpeg'; } catch (_) { t.skip('no ffmpeg'); return; }
  const { w, all } = writer(44100);
  w.append(tone(Math.round(44100 * 3.37), 44100));
  w.finish();
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-ogg-'));
  try {
    const f = path.join(dir, 'a.opus');
    writeFileSync(f, all());
    const out = execFileSync(ff, ['-v', 'error', '-i', f, '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 64 << 20 });
    assert.ok(Math.abs(out.length / 4 / 48000 - 3.37) <= 0.001, `ffmpeg: ${out.length / 4 / 48000} s`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
