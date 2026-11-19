// The appending byte stream of a shared session, on real libopus output (the model's self-test clip,
// repeated): a session is one Ogg Opus stream written page by page and cut into segments that R2
// holds as separate objects; concatenating them must give the same stream as encoding in one go.
// Checks: headers once, page sequence numbers and granule positions continuous across segments,
// CRCs, the end-of-stream flag only on the last page, bytes equal to a one-go encode, the decoded
// PCM bit-identical to the one-go encode (libopus decoder here; ffmpeg's native and libopus decoders
// and ffprobe when ffmpeg is on PATH), and crash recovery: a killed capture recovered from a torn
// page keeps the stream valid and is a prefix of the one-go decode. Tried and rejected: encoding a
// tone (would not show packet size variation near 255-byte lacing edges) and synthetic packets
// (the vector test covers the wire format; this one is about real encoder output).
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OggOpusWriter, OpusEncoder, ShareResampler, ShareCapture, MemoryStorage, recover, markers, OPUS_SETTINGS, SEGMENT_PLAN,
  loadOpus, opusVersion, decodeOggOpus, readPages, segmentName, FILES, BitrateLadder, OPUS_REQUEST,
} from '../web/sharing/index.js';
// the stream checks, shared with sharing_takes.test.mjs since 2.0.3 (moved there unchanged)
import { SERIAL, clipSeconds, concat, sameBytes, checkStream, ffmpeg, ffprobeDuration, ffmpegPcm, decodeBoth } from './sharing_stream_checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
if (!have && process.env.REQUIRE_OPUS === '1') throw new Error('dist/tajweedformer-opus.mjs is missing: npm run build:opus');
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const m = have ? await loadOpus() : null;

// a real 16 kHz recitation clip (the SDK's model self-test audio), repeated to a long session: 120 s
// crosses 4 segments of the plan (10, 20, 40, then 60 s) and most of the packet sizes real speech makes
const SEG_TEST_SECONDS = 120;

function encode(pcm, inputRate, plan) {
  const segs = new Map(), closed = [];
  const encoder = new OpusEncoder(m, { sampleRate: 48000, settings: OPUS_SETTINGS });
  const w = new OggOpusWriter({
    encoder, resampler: inputRate === 48000 ? null : new ShareResampler(inputRate), inputRate, plan, settings: OPUS_SETTINGS, serial: SERIAL,
    vendor: `QuranLab SDK 2.0.0 ${opusVersion(m)}`,
    onPage: (n, b) => { if (!segs.has(n)) segs.set(n, []); segs.get(n).push(b); },
    onSegment: (s) => closed.push(s),
  });
  // feeds in 40 ms chunks, as a microphone does
  const step = Math.round(inputRate * 0.04);
  for (let i = 0; i < pcm.length; i += step) w.append(pcm.subarray(i, Math.min(pcm.length, i + step)));
  const ms = w.finish();
  const finalGranule = encoder.finalGranulePosition;
  const preSkip = w.preSkip;
  encoder.free();
  const bytes = (n) => concat(segs.get(n) || []);
  const order = [...segs.keys()].sort((a, b) => a - b);
  return { segs: order.map((n) => ({ n, b: bytes(n), closed: closed.find((c) => c.n === n) })), closed, ms, all: concat(order.map(bytes)), preSkip, finalGranule };
}

const dumpDir = process.env.SHARE_OGG_DUMP;
function dump(name, bytes) { if (dumpDir) { mkdirSync(dumpDir, { recursive: true }); writeFileSync(path.join(dumpDir, name), bytes); } }

for (const [label, inputRate] of [['16 kHz through the resampler', 16000], ['48 kHz direct', 48000]]) {
  test(`one stream across segments equals one-go, ${label}`, { skip }, () => {
    const pcm = clipSeconds(inputRate, SEG_TEST_SECONDS);
    const oneGo = encode(pcm, inputRate, []);
    const seg = encode(pcm, inputRate, SEGMENT_PLAN);
    const nSeg = seg.segs.length;
    assert.ok(nSeg >= 4, `the 120 s session has at least 4 segments (got ${nSeg})`);
    // cut points: 10, 20, 40, 60 s of packets each, every segment boundary at a page boundary
    let granule = 0;
    for (const s of seg.segs.slice(0, 3)) {
      const pages = readPages(s.b);
      assert.ok(pages.length > 0);
      assert.equal(s.closed.last, s.n === nSeg, 'only the last segment is the last');
      granule = pages[pages.length - 1].granule;
      assert.equal(s.closed.granule, granule, 'the segment marker holds its last granule position');
    }
    assert.ok(seg.segs[0].b.length > 0);
    // segment files appended in order are exactly the one-go file
    assert.ok(sameBytes(seg.all, oneGo.all), `concatenated segments equal the one-go stream (${seg.all.length} vs ${oneGo.all.length} bytes)`);
    const st = checkStream(seg.all);
    assert.equal(st.lastGranule, oneGo.finalGranule, 'the final granule is the encoder\'s final position');
    const expectedSamples = Math.round(SEG_TEST_SECONDS * 48000);
    const dec = decodeOggOpus(m, st.pages);
    assert.equal(dec.length, expectedSamples, 'libopus decodes the exact input length');
    console.log(`# ${label}: ${seg.segs.map((s) => s.b.length).join('+')} bytes in ${nSeg} segments, ${st.pages.length} pages, ${dec.length} samples decoded`);
    if (ffmpeg) {
      const dir = mkdtempSync(path.join(tmpdir(), 'ogg-append-'));
      try {
        const fSeg = path.join(dir, `seg.ogg`), fOne = path.join(dir, 'one.ogg');
        writeFileSync(fSeg, seg.all); writeFileSync(fOne, oneGo.all);
        dump(`${inputRate}_concat.ogg`, seg.all); dump(`${inputRate}_onego.ogg`, oneGo.all);
        const p = ffprobeDuration(fSeg);
        assert.equal(p.streams[0].codec_name, 'opus');
        assert.equal(Number(p.streams[0].channels), 1);
        const dur = Number(p.format.duration);
        assert.ok(Math.abs(dur - SEG_TEST_SECONDS) < 0.02, `ffprobe duration ${dur} is ${SEG_TEST_SECONDS} s`);
        const a = decodeBoth(fSeg), b = decodeBoth(fOne);
        assert.ok(sameBytes(a.native, b.native), 'ffmpeg native decoder: segments == one-go');
        assert.ok(sameBytes(a.libopus, b.libopus), 'ffmpeg libopus decoder: segments == one-go');
        assert.equal(a.native.length / 2, expectedSamples, 'ffmpeg native: exact sample count');
        console.log(`# ffprobe ${dur.toFixed(3)} s, decoded ${a.native.length / 2} samples with both decoders, bit-identical to one-go`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
}

test('ShareCapture appends pages to storage and the result is the same stream (the outbox path)', { skip }, async () => {
  const inputRate = 16000;
  const pcm = clipSeconds(inputRate, 80);
  const storage = new MemoryStorage();
  const cap = new ShareCapture({
    storage, outbox: { drain: async () => {} }, opus: m, enabled: () => true, consentVersion: 'share-2026-11-07',
    contributor: 'a'.repeat(32), device: { deviceClass: 'node', osMajor: 22 }, day: '2026-11-09', inputSampleRate: inputRate, inputRoute: 'built_in',
    decode: {}, serial: SERIAL,
  });
  const step = Math.round(inputRate * 0.04);
  for (let i = 0; i < pcm.length; i += step) cap.push(pcm.subarray(i, Math.min(pcm.length, i + step)));
  const ms = await cap.finish({ completed: true });
  assert.ok(ms > 79000 && ms < 81000, `duration ${ms}`);
  const names = (await storage.list(cap.id)).filter((n) => n.endsWith('.opus')).sort();
  const segBytes = [];
  for (const n of names) segBytes.push(await storage.read(cap.id, n));
  const st = checkStream(concat(segBytes));
  const decoded = decodeOggOpus(m, st.pages);
  assert.equal(decoded.length, Math.round(80 * 48000));
  const end = JSON.parse(new TextDecoder().decode(await storage.read(cap.id, FILES.end)));
  assert.equal(end.completed, true);
  const meta = JSON.parse(new TextDecoder().decode(await storage.read(cap.id, segmentName(1) + '.json')));
  assert.equal(meta.bytes, segBytes[0].length, 'the marker holds the segment size');
});

test('a killed capture, recovered at a torn page: valid segments, a prefix of the one-go decode', { skip }, async () => {
  const inputRate = 16000;
  const pcm = clipSeconds(inputRate, 40);
  const oneGo = encode(pcm, inputRate, []);
  const oneGoDecoded = decodeOggOpus(m, readPages(oneGo.all));
  const seg = encode(pcm, inputRate, SEGMENT_PLAN);
  // kill points in the open 3rd segment: mid-page, about a page boundary, near the start of the segment
  for (const cutFraction of [0.53, 0.5, 0.31]) {
    const storage = new MemoryStorage();
    const id = 'c'.repeat(32);
    const te = new TextEncoder();
    await storage.write(id, FILES.session, te.encode('{}'));
    await storage.write(id, FILES.capture, te.encode(JSON.stringify({ preSkip: oneGo.preSkip })));
    for (const s of seg.segs.slice(0, 2)) {
      await storage.write(id, segmentName(s.n) + '.opus', s.b);
      const pages = readPages(s.b);
      await storage.write(id, segmentName(s.n) + '.json', te.encode(JSON.stringify({ n: s.n, bytes: s.b.length, sha256: 'x', granule: pages[pages.length - 1].granule })));
    }
    const open = seg.segs[2].b;
    const cut = Math.floor(open.length * cutFraction);
    await storage.write(id, segmentName(3) + '.opus', open.subarray(0, cut));
    assert.equal(await recover(storage, id), true, 'something to share');
    const ms = await markers(storage, id);
    assert.equal(ms.length, 3, 'the open segment was closed');
    const end = JSON.parse(new TextDecoder().decode(await storage.read(id, FILES.end)));
    assert.equal(end.completed, false, 'a recovered session is not complete');
    const seg3 = await storage.read(id, segmentName(3) + '.opus');
    assert.ok(seg3.length <= cut && seg3.length > 0, 'the torn page was cut off');
    assert.equal(ms[2].bytes, seg3.length);
    const parts = [];
    for (let n = 1; n <= 3; n++) parts.push(await storage.read(id, segmentName(n) + '.opus'));
    const whole = concat(parts);
    const pages = readPages(whole);
    pages.forEach((p, i) => assert.equal(p.sequence, i, 'sequence numbers continuous after recovery'));
    assert.equal(pages[pages.length - 1].flags & 0x04, 0, 'no end-of-stream flag on a recovered stream');
    const g = pages[pages.length - 1].granule;
    assert.equal(end.durationMs, Math.trunc(Math.max(0, g - oneGo.preSkip) / 48), 'end.json matches the last whole page');
    const dec = decodeOggOpus(m, pages);
    // the decode of the recovered prefix is bit-identical to the one-go decode up to the last whole page
    const n = Math.min(dec.length, oneGoDecoded.length);
    const a = dec.subarray(0, n), b = oneGoDecoded.subarray(0, n);
    assert.ok(n > 40000, `decoded ${n}`);
    assert.ok(sameBytes(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
      `recovered decode is a prefix of the one-go decode (${n} samples)`);
    if (ffmpeg) {
      const dir = mkdtempSync(path.join(tmpdir(), 'ogg-recover-'));
      try {
        const f = path.join(dir, 'recovered.ogg');
        writeFileSync(f, whole);
        dump(`recovered_${cutFraction}.ogg`, whole);
        const dur = Number(ffprobeDuration(f).format.duration);
        const expected = (g - oneGo.preSkip) / 48000;
        assert.ok(Math.abs(dur - expected) < 0.05, `ffprobe duration ${dur} ~ ${expected}`);
        const n2 = ffmpegPcm(f, 'libopus');
        assert.ok(n2.length / 2 >= expected * 48000 - 2000, `ffmpeg libopus decoded ${n2.length / 2} samples of ${expected * 48000}`);
        console.log(`# recovered cut ${cutFraction}: kept ${seg3.length}/${open.length} bytes of seg 3, granule ${g}, ffprobe ${dur.toFixed(3)} s, ${dec.length} samples prefix-identical`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

// SDK 2.0.1, the adaptive bitrate: the same stream checks on a session whose segments are coded at different
// rungs (the ladder driven as an outbox would: failures, then successes), 150 s so that it crosses 5 segments.
// The bitrate changes on the first packet of a segment (OPUS_SET_BITRATE between two packets of one encoder),
// so the stream keeps one set of headers and stays one valid Ogg Opus file. Optional: OPUSFILE_CHECK names a
// small libopusfile program (scripts/build_opusfile_check.sh) that opens the file with op_open_file and prints
// op_pcm_total and what op_read_float returns.
const BITRATE_SECONDS = 150;
const BITRATE_PLAN = [192000, 96000, 32000, 64000, 192000];
test('one stream across segments at different bitrates (192, 96, 32, 64, 192 kbit/s): valid, exact length, each segment at its rung', { skip }, () => {
  const inputRate = 16000;
  const pcm = clipSeconds(inputRate, BITRATE_SECONDS);
  const ladder = new BitrateLadder();
  // after segment n closes: what the outbox would have told the ladder by then
  const events = {
    1: () => ladder.uploadFailed(), // 192 -> 96
    2: () => { ladder.uploadFailed(); ladder.uploadFailed(); }, // 96 -> 64 -> 32
    3: () => { for (let i = 0; i < 3; i++) ladder.uploadOk(0); }, // 32 -> 64
    4: () => { for (let i = 0; i < 6; i++) ladder.uploadOk(0); }, // 64 -> 96 -> 192
  };
  const segs = new Map(), closed = [], opened = [];
  const encoder = new OpusEncoder(m, { sampleRate: 48000, settings: { ...OPUS_SETTINGS, bitrate: ladder.bitrate } });
  const w = new OggOpusWriter({
    encoder, resampler: new ShareResampler(inputRate), inputRate, plan: SEGMENT_PLAN, settings: OPUS_SETTINGS, serial: SERIAL,
    vendor: `QuranLab SDK 3.1.3 ${opusVersion(m)}`,
    bitrate: (n) => (n > 1 ? ladder.bitrate : null),
    // libopus's own reading of the bitrate as the segment's first packet is about to be coded
    onSegmentOpen: (s) => opened.push({ ...s, libopus: encoder.get(OPUS_REQUEST.GET_BITRATE), packets: encoder.packetCount }),
    onPage: (n, b) => { if (!segs.has(n)) segs.set(n, []); segs.get(n).push(b); },
    onSegment: (s) => { closed.push(s); if (events[s.n]) events[s.n](); },
  });
  const step = Math.round(inputRate * 0.04);
  for (let i = 0; i < pcm.length; i += step) w.append(pcm.subarray(i, Math.min(pcm.length, i + step)));
  w.finish();
  const finalGranule = encoder.finalGranulePosition;
  encoder.free();
  const order = [...segs.keys()].sort((a, b) => a - b);
  const files = order.map((n) => concat(segs.get(n)));
  assert.equal(order.length, 5, `150 s is 5 segments (10, 20, 40, 60, 20 s): got ${order.length}`);
  assert.deepEqual(closed.map((c) => c.bitrate), BITRATE_PLAN, 'each segment marker has the bitrate it was coded at');
  assert.deepEqual(opened.map((o) => o.bitrate), BITRATE_PLAN, 'each segment opened at the ladder\'s rung');
  assert.deepEqual(opened.map((o) => o.libopus), BITRATE_PLAN, 'libopus reads back the rung before the segment\'s first packet');
  assert.deepEqual(opened.map((o) => o.packets), [0, 500, 1500, 3500, 6500], 'the change lands on the segment\'s first packet');
  // the stream: headers once, sequence, serial, CRCs, granules, EOS, the final granule
  const all = concat(files);
  const st = checkStream(all);
  assert.equal(st.lastGranule, finalGranule, 'the final granule is the encoder\'s final position');
  // each segment's pages hold its packets only; segments start on their own page
  let g = 0;
  const rows = [];
  files.forEach((b, i) => {
    const pages = readPages(b);
    const audio = pages.filter((p) => !(p.packets.length === 1 && /^Opus(Head|Tags)/.test(new TextDecoder().decode(p.packets[0].subarray(0, 8)))));
    const end = pages[pages.length - 1].granule;
    const seconds = (Math.min(end, finalGranule) - g) / 48000;
    const audioBytes = audio.reduce((k, p) => k + p.packets.reduce((q, x) => q + x.length, 0), 0);
    rows.push({ n: i + 1, bitrate: BITRATE_PLAN[i], bytes: b.length, pages: pages.length, seconds, kbps: (b.length * 8) / seconds / 1000, payloadKbps: (audioBytes * 8) / seconds / 1000 });
    assert.equal(closed[i].granule, end, `segment ${i + 1}: the marker holds its last granule`);
    g = end;
  });
  const kb = (r) => r.payloadKbps;
  assert.ok(kb(rows[2]) < kb(rows[3]) && kb(rows[3]) < kb(rows[1]) && kb(rows[1]) < Math.min(kb(rows[0]), kb(rows[4])),
    `bytes per second follow the rungs: ${rows.map((r) => r.payloadKbps.toFixed(1)).join(', ')}`);
  assert.ok(kb(rows[2]) < kb(rows[4]) / 3, 'a 32 kbit/s segment is clearly smaller than a 192 kbit/s one');
  // unconstrained VBR is a target, not a cap: on this clip libopus 1.6.1 codes about 10% over at 192k and
  // about 50% over at 32k (the overshoot grows as the rung falls); the bound catches a rung that did not apply
  for (const r of rows) {
    const t = r.bitrate / 1000;
    assert.ok(r.payloadKbps > t * 0.5 && r.payloadKbps < t * 1.75, `segment ${r.n}: ${r.payloadKbps.toFixed(1)} kbit/s for a ${t} kbit/s rung`);
  }
  const expectedSamples = BITRATE_SECONDS * 48000;
  const dec = decodeOggOpus(m, st.pages);
  assert.equal(dec.length, expectedSamples, 'libopus decodes the exact input length');
  for (const r of rows) {
    console.log(`# bitrate seg ${r.n}: ${r.bitrate / 1000} kbit/s rung, ${r.bytes} bytes, ${r.pages} pages, ${r.seconds.toFixed(3)} s, ` +
      `${r.kbps.toFixed(1)} kbit/s with Ogg overhead (${r.payloadKbps.toFixed(1)} Opus payload)`);
  }
  console.log(`# bitrate stream: ${all.length} bytes, ${st.pages.length} pages, ${dec.length} samples decoded (libopus, wasm)`);
  if (ffmpeg || process.env.OPUSFILE_CHECK) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ogg-bitrate-'));
    try {
      const f = path.join(dir, 'bitrate.ogg');
      writeFileSync(f, all);
      dump('bitrate_ladder.ogg', all);
      if (ffmpeg) {
        const p = ffprobeDuration(f);
        const dur = Number(p.format.duration);
        assert.equal(p.streams[0].codec_name, 'opus');
        assert.ok(Math.abs(dur - BITRATE_SECONDS) < 0.02, `ffprobe duration ${dur} is ${BITRATE_SECONDS} s`);
        const a = decodeBoth(f);
        assert.equal(a.native.length / 2, expectedSamples, 'ffmpeg native decoder: exact sample count');
        assert.equal(a.libopus.length / 2, expectedSamples, 'ffmpeg libopus decoder: exact sample count');
        console.log(`# bitrate stream: ffprobe ${dur.toFixed(3)} s; ffmpeg native ${a.native.length / 2} and libopus ${a.libopus.length / 2} samples`);
      }
      if (process.env.OPUSFILE_CHECK) {
        const out = execFileSync(process.env.OPUSFILE_CHECK, [f], { encoding: 'utf8' });
        const r = Object.fromEntries(out.trim().split(/\s+/).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
        assert.equal(r.open, 0, `op_open_file ${r.open}`);
        assert.equal(r.links, 1, 'one link (one logical stream)');
        assert.equal(r.pcm_total, expectedSamples, 'op_pcm_total: the exact input length');
        assert.equal(r.read, expectedSamples, 'op_read_float: every sample');
        assert.equal(r.holes, 0, 'no OP_HOLE');
        assert.equal(r.errors, 0, 'no read error');
        console.log(`# bitrate stream: libopusfile ${out.trim()}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
