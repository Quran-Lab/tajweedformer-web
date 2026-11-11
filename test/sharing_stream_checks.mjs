// What the shared-stream tests check on a stream (not a test file itself): sharing_ogg_append.test.mjs for one
// session, sharing_takes.test.mjs for a recording that takes in a row share. One set of checks for both: every
// page (capture pattern, CRC), the headers once, page sequence numbers and granule positions continuous, the
// end-of-stream flag only on the last page; and ffprobe and ffmpeg (native and libopus decoders) when on PATH.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPages } from '../web/sharing/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The serial number the stream tests write (one logical stream). */
export const SERIAL = 0x1234abcd;

/** The model's self-test clip (a real recitation at 16 kHz) repeated to `seconds` at `rate`. */
export function clipSeconds(rate, seconds) {
  const clip = new Float32Array(readFileSync(path.join(root, 'test', 'sharing', 'selftest_16k.f32')).buffer.slice(0));
  // the clip's own rate is 16 kHz: anything else plays it faster or slower, which is fine for the
  // stream tests and keeps the resampler out of the 48 kHz case
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += clip.length) out.set(clip.subarray(0, Math.min(clip.length, n - i)), i);
  return out;
}

export const concat = (parts) => { const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
export const sameBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** One finished Ogg Opus stream: throws (assert) on anything wrong. `serial`: the stream's serial number. */
export function checkStream(all, serial = SERIAL) {
  // (a number, checked first: comparing a page's serial with an object would make assert print that object whole)
  assert.equal(typeof serial, 'number', 'checkStream(bytes, serial)');
  const pages = readPages(all); // throws on a bad CRC, a missing capture pattern, or a cut page
  assert.ok(pages.length > 4, 'pages');
  assert.equal(pages[0].flags & 0x02, 0x02, 'BOS on page 0');
  assert.equal(pages[0].sequence, 0, 'first sequence number');
  const td = new TextDecoder();
  pages.forEach((p, i) => {
    assert.equal(p.sequence, i, `page sequence number is continuous at ${i}`);
    assert.equal(p.serial, serial, 'one logical stream');
    if (i > 0) assert.equal(p.flags & 0x02, 0, `BOS only on page 0 (page ${i})`);
    assert.equal(p.flags & 0x04, i === pages.length - 1 ? 0x04 : 0, `EOS only on the last page (page ${i})`);
    assert.equal(td.decode(p.packets[0].subarray(0, 8)) === 'OpusHead', i === 0, `OpusHead only on page 0 (page ${i})`);
    assert.equal(td.decode(p.packets[0].subarray(0, 8)) === 'OpusTags', i === 1, `OpusTags only on page 1 (page ${i})`);
  });
  let g = 0;
  for (const p of pages.slice(2, -1)) {
    g += p.packets.length * 960;
    assert.equal(p.granule, g, `granule position continuous at page ${p.sequence}`);
  }
  const last = pages[pages.length - 1];
  const expectedEnd = g + last.packets.length * 960;
  assert.ok(last.granule <= expectedEnd && last.granule > g, 'the last page trims the end padding');
  return { pages, audioPages: pages.length - 2, lastGranule: last.granule };
}

export const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0;
export function ffprobeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(out);
}
export function ffmpegPcm(file, decoder) {
  const out = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-c:a', decoder, '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 1 << 28 });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function decodeBoth(file) {
  return { native: ffmpegPcm(file, 'opus'), libopus: ffmpegPcm(file, 'libopus') };
}
