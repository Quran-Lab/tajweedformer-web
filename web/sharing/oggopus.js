// Ogg Opus for shared sessions (RFC 7845), the same wire format as the Swift SDK's OggOpusWriter
// (tajweedformer-sdk-swift Sharing/OggOpus.swift) and every other SDK 2.0.0 (PLATFORM_CLIENT.md
// section 10): mono, coded at 48 kHz, OpusHead with the true input rate, OpusTags, pages of about a
// second of packets (50 at 20 ms, fewer when 255 lacing values would not hold them), cut into
// segments at page boundaries (10, 20, 40, then 60 s), the last page of a finished session with the
// end-of-stream flag and the encoder's final granule position. Plain JS, no dependencies.

/** The sharing bitrate (bit/s): the reference's 192 kbit/s (about 86 MB an hour) until Quran Lab decides;
 * the one constant of this SDK. Apps may pass another (createSharingSession({ bitrate })). */
export const SHARING_BITRATE_DEFAULT = 192000;

/** The Opus settings sessions are shared with (Swift OpusSettings.shared, the opus-bench choice). */
export const OPUS_SETTINGS = Object.freeze({
  application: 2049, // OPUS_APPLICATION_AUDIO
  bitrate: SHARING_BITRATE_DEFAULT,
  complexity: 10,
  vbr: true,
  constrainedVbr: false,
  bandwidth: 1105, // OPUS_BANDWIDTH_FULLBAND
  signal: -1000, // OPUS_AUTO
  frameMs: 20,
});

/** The rate Opus codes at; the sharing path always encodes at it. */
export const CODED_RATE = 48000;

/** Samples per packet at 48 kHz, and packets on a full page (about one second). */
export const packetFrames = (s = OPUS_SETTINGS) => Math.trunc(48 * s.frameMs);
export const pagePackets = (s = OPUS_SETTINGS) => Math.max(1, Math.round(1000 / s.frameMs));

/** Seconds per segment: the first ones short, then a minute each; the last entry repeats. */
export const SEGMENT_PLAN = Object.freeze([10, 20, 40, 60]);
export const segmentSeconds = (n, plan = SEGMENT_PLAN) => plan[Math.min(n, plan.length) - 1];

/** "seg-00001" for segment 1 (the R2 key and the local name, without ".opus"). */
export const segmentName = (n) => `seg-${String(n).padStart(5, '0')}`;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

/** The Ogg CRC-32: polynomial 0x04c11db7, no reflection, initial value 0. */
export function oggCrc(bytes) {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  return c >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);
function concat(parts) {
  const n = parts.reduce((k, p) => k + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** RFC 7845 identification header; inputRate is the capture rate (informational). */
export function opusHead(preSkip, inputRate) {
  const d = new Uint8Array(19);
  d.set(utf8('OpusHead'), 0);
  d[8] = 1; d[9] = 1;
  const v = new DataView(d.buffer);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setUint16(16, 0, true);
  d[18] = 0;
  return d;
}

/** RFC 7845 comment header with the vendor string and no comments. */
export function opusTags(vendor) {
  const vb = utf8(vendor);
  const d = new Uint8Array(8 + 4 + vb.length + 4);
  d.set(utf8('OpusTags'), 0);
  const v = new DataView(d.buffer);
  v.setUint32(8, vb.length, true);
  d.set(vb, 12);
  v.setUint32(12 + vb.length, 0, true);
  return d;
}

/** One Ogg page holding whole packets. */
export function oggPage(packets, { granule, serial, sequence, flags }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new RangeError('an Ogg page holds at most 255 segments');
  const head = new Uint8Array(27 + lacing.length);
  head.set(utf8('OggS'), 0);
  head[4] = 0;
  head[5] = flags;
  const v = new DataView(head.buffer);
  v.setBigUint64(6, BigInt.asUintN(64, BigInt(granule)), true);
  v.setUint32(14, serial >>> 0, true);
  v.setUint32(18, sequence >>> 0, true);
  v.setUint32(22, 0, true);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const page = concat([head, ...packets]);
  new DataView(page.buffer).setUint32(22, oggCrc(page), true);
  return page;
}

/**
 * Every page of an Ogg stream, each checked (capture pattern, CRC); throws on a bad page.
 * @returns {{flags: number, granule: number, serial: number, sequence: number, packets: Uint8Array[]}[]}
 */
export function readPages(bytes) {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    if (!(bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53)) throw new Error(`no OggS at ${at}`);
    const n = bytes[at + 26];
    const lacing = bytes.subarray(at + 27, at + 27 + n);
    const len = 27 + n + lacing.reduce((k, x) => k + x, 0);
    if (at + len > bytes.length) throw new Error(`page at ${at} is cut`);
    const page = bytes.slice(at, at + len);
    const v = new DataView(page.buffer);
    const crc = v.getUint32(22, true);
    v.setUint32(22, 0, true);
    if (oggCrc(page) !== crc) throw new Error(`page CRC at ${at}`);
    const packets = [];
    let parts = [], o = at + 27 + n;
    for (const l of lacing) {
      parts.push(bytes.subarray(o, o + l));
      o += l;
      if (l < 255) { packets.push(concat(parts)); parts = []; }
    }
    out.push({ flags: bytes[at + 5], granule: Number(v.getBigInt64(6, true)), serial: v.getUint32(14, true), sequence: v.getUint32(18, true), packets });
    at += len;
  }
  return out;
}

/** The length of the whole pages at the start of `bytes` (each with a valid CRC) and the last one's
 * granule position (Swift ShareFiles.wholePages): what survives a torn write. */
export function wholePages(bytes) {
  let at = 0, granule = 0;
  while (at + 27 <= bytes.length && bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53) {
    const n = bytes[at + 26];
    if (at + 27 + n > bytes.length) break;
    let len = 0;
    for (let i = 0; i < n; i++) len += bytes[at + 27 + i];
    const end = at + 27 + n + len;
    if (end > bytes.length) break;
    const page = bytes.slice(at, end);
    const v = new DataView(page.buffer);
    const crc = v.getUint32(22, true);
    v.setUint32(22, 0, true);
    if (oggCrc(page) !== crc) break;
    granule = Number(v.getBigInt64(6, true));
    at = end;
  }
  return { keep: at, granule };
}

/**
 * Writes one session's audio as Ogg Opus pages while the session runs (Swift OggOpusWriter).
 * Synchronous: each finished page goes to `onPage(n, bytes)` (n = its segment), each closed segment
 * to `onSegment({ n, granule, last })`; the caller persists them. `plan` empty: one segment.
 *
 * @param {object} o
 * @param {{ preSkip: number, encode(x: Float32Array): Uint8Array[], flush(): Uint8Array[], finalGranulePosition: number }} o.encoder
 *        an encoder taking 48 kHz input (encoder.js)
 * @param {{ process(x: Float32Array, sink: Function): void, flush(sink: Function): void } | null} o.resampler
 *        input rate to 48 kHz (resampler.js), null when the input is 48 kHz
 * @param {number} o.inputRate  the capture rate (8000 to 384000, whole Hz)
 * @param {(n: number) => number|null} [o.bitrate]  the bit rate of segment n, asked when the segment opens
 *        (just before its first packet is coded; the previous segment is closed by then); null keeps the
 *        current one. Needs an encoder with setBitrate and beforeFrame (encoder.js).
 * @param {(s: {n: number, bitrate: number|null}) => void} [o.onSegmentOpen]  a segment opened (its first packet)
 */
export class OggOpusWriter {
  constructor({ encoder, resampler = null, inputRate, plan = SEGMENT_PLAN, settings = OPUS_SETTINGS, serial, vendor, onPage, onSegment = () => {},
    bitrate = null, onSegmentOpen = () => {} }) {
    if (!(inputRate >= 8000 && inputRate <= 384000 && Number.isInteger(inputRate))) throw new RangeError(`unsupported input rate ${inputRate} Hz`);
    if (inputRate !== CODED_RATE && !resampler) throw new TypeError('a resampler is needed for input that is not 48 kHz');
    this.encoder = encoder;
    this.resampler = inputRate === CODED_RATE ? null : resampler;
    this.inputRate = inputRate;
    this.plan = plan;
    this.settings = settings;
    this.serial = serial === undefined ? (Math.random() * 0x100000000) >>> 0 : serial >>> 0;
    this.onPage = onPage;
    this.onSegment = onSegment;
    this.packetFrames = packetFrames(settings);
    this.pagePackets = pagePackets(settings);
    this.segment = 0;
    this.open = false;
    this.segmentPackets = 0;
    this.sequence = 0;
    this.inputFrames = 0;
    this.nonFiniteSamples = 0;
    this.ended = false;
    this.packets = [];
    this.paged = 0;
    this.lastGranule = 0;
    this._clean = new Float32Array(0);
    this.bitrateFor = bitrate;
    this.onSegmentOpen = onSegmentOpen;
    /** segment number -> the bit rate its packets were coded at */
    this.segmentBitrates = new Map();
    this._openN = 1; // the next segment to open
    this._openAt = 0; // the index of its first packet
    // packets reach the writer one by one as they are coded, so a segment can be closed and the next one's
    // bitrate set between two packets (an encoder seam without the hook hands them over per call)
    this._push = (p) => { this.packets.push(p); };
    this._sink = (x) => { const r = this.encoder.encode(x, this._push); if (r) for (const p of r) this.packets.push(p); };
    if (encoder && 'beforeFrame' in encoder) encoder.beforeFrame = () => this._beforePacket(this.paged + this.packets.length);
    this._page([opusHead(encoder.preSkip, inputRate)], 0, 0x02, false);
    this._page([opusTags(vendor || 'QuranLab SDK')], 0, 0, false);
  }

  get preSkip() { return this.encoder.preSkip; }
  /** Seconds of audio written so far (at the input rate). */
  get duration() { return this.inputFrames / this.inputRate; }

  /** Mono samples at the input rate; non-finite samples are written as silence. */
  append(samples) {
    if (!samples.length || this.ended) return;
    this.inputFrames += samples.length;
    if (this._clean.length < samples.length) this._clean = new Float32Array(samples.length);
    const c = this._clean.subarray(0, samples.length);
    let bad = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i];
      if (Number.isFinite(v)) c[i] = v; else { c[i] = 0; bad++; }
    }
    this.nonFiniteSamples += bad;
    if (this.resampler) this.resampler.process(c, this._sink); else this._sink(c);
    this._writePages(false);
  }

  /** Flushes the resampler and the encoder, writes the last pages, closes the last segment. Returns
   * the duration in ms. */
  finish() {
    if (!this.ended) {
      this.ended = true;
      if (this.resampler) this.resampler.flush(this._sink);
      const r = this.encoder.flush(this._push);
      if (r) for (const p of r) this.packets.push(p);
      this._writePages(true);
      this._close(true);
    }
    return Math.round(this.duration * 1000);
  }

  /** Stops without finishing (the caller removes what was written). */
  abandon() { this.ended = true; this.open = false; }

  // Before packet k is coded: at the first packet of a segment, close the previous one (all its packets are
  // coded, so its last page can be written now) and set the new segment's bitrate.
  _beforePacket(k) {
    if (k !== this._openAt) return;
    const n = this._openN;
    if (n > 1) this._writePages(false);
    const want = this.bitrateFor ? this.bitrateFor(n) : null;
    if (want && typeof this.encoder.setBitrate === 'function') this.encoder.setBitrate(want);
    const used = this.encoder.bitrate ?? this.settings.bitrate ?? null;
    this.segmentBitrates.set(n, used);
    this._openN = n + 1;
    this._openAt += this._segmentLimit(n);
    this.onSegmentOpen({ n, bitrate: used });
  }

  _segmentLimit(n) {
    return this.plan.length ? Math.round(segmentSeconds(n, this.plan) * 1000 / this.settings.frameMs) : Infinity;
  }

  _writePages(final) {
    while (this.packets.length) {
      const next = this.open ? this.segment : this.segment + 1;
      const used = this.open ? this.segmentPackets : 0;
      const room = this._segmentLimit(next) - used;
      const want = Math.min(this.pagePackets, room);
      let take = 0, lacing = 0;
      while (take < Math.min(want, this.packets.length)) {
        const l = Math.floor(this.packets[take].length / 255) + 1;
        if (lacing + l > 255) break;
        lacing += l;
        take++;
      }
      const full = take === want || take < this.packets.length;
      if (!(full || final)) return;
      const last = final && take === this.packets.length;
      const chunk = this.packets.splice(0, take);
      let granule = (this.paged + take) * this.packetFrames;
      if (last) granule = Math.max(Math.min(this.encoder.finalGranulePosition, granule), this.paged * this.packetFrames);
      this._page(chunk, granule, last ? 0x04 : 0, true);
    }
  }

  _close(last) {
    if (!this.open) return;
    this.open = false;
    this.onSegment({ n: this.segment, granule: this.lastGranule, last, bitrate: this.segmentBitrates.get(this.segment) ?? null });
  }

  _page(packets, granule, flags, audio) {
    const bytes = oggPage(packets, { granule, serial: this.serial, sequence: this.sequence, flags });
    if (!this.open) {
      this.segment += 1;
      this.segmentPackets = 0;
      this.open = true;
    }
    this.onPage(this.segment, bytes);
    this.sequence += 1;
    this.lastGranule = granule;
    if (audio) {
      this.paged += packets.length;
      this.segmentPackets += packets.length;
      if (!(flags & 0x04) && this.segmentPackets >= this._segmentLimit(this.segment)) this._close(false);
    }
  }
}
