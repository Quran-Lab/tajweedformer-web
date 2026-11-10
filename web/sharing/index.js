// Recitation sharing for the web SDK (PLATFORM_CLIENT.md sections 9 and 10): with the
// learner's consent, EVERY session the SDK listens to is shared whole, continuously while it listens,
// as one Ogg Opus stream cut into segments that go straight to R2 on presigned URLs. The same wire
// format, segment schedule and batch logic as the Swift reference client and every SDK 2.0.0.
//
//   import { createSharing } from '@quran-lab/tajweedformer/sharing';
//   const sharing = await createSharing({ api: 'https://api.quranlab.ai', tokenProvider, flags: () => config.flags,
//                                         enabled: () => consent === 'granted', consentVersion: 'deck-1' });
//   sharing.outbox.resume();                       // at load: sessions a closed page left go up now
//   const s = await sharing.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode });
//   s.push(pcm);  ...  await s.finish();           // or s.abort() for a cancelled session
//
// Since 2.0.3 a session (a take) and the shared recording are two things: takes in a row share one recording,
// one Ogg stream, when the next take starts within the join window (takes.js, recorder.js). The page becoming
// hidden closes the open recording (`sharing.background()`), and `sharing.closeRecording()` does when the app
// knows no take follows.
//
// The libopus module (dist/tajweedformer-opus, about 316 KB) is loaded on the first session only.

import { OggOpusWriter, SEGMENT_PLAN, OPUS_SETTINGS, segmentName, CODED_RATE } from './oggopus.js';
import { OpusEncoder, loadOpus, opusVersion } from './encoder.js';
import { ShareResampler } from './resampler.js';
import { ContributionClient, sessionJson, utcDay, b64url, SDK_VERSION } from './uploader.js';
import { Outbox, FILES, defaultStorage, writeJson, mark, recover, activeCaptures } from './outbox.js';
import { BitrateLadder } from './bitrate.js';
import { ShareRecorder } from './recorder.js';
import { takesBody } from './takes.js';

export * from './oggopus.js';
export { OpusEncoder, loadOpus, opusVersion, decodeOggOpus, OPUS_REQUEST } from './encoder.js';
export { ShareResampler } from './resampler.js';
export { ContributionClient, SharingError, sessionJson, parseUrls, requestCounts, utcDay, b64url, deletionMessage, INPUT_ROUTES, SDK_VERSION } from './uploader.js';
export { Outbox, MemoryStorage, dirStorage, indexedDbStorage, defaultStorage, recover, markers, markerSeconds, activeCaptures, sha256Hex, MAX_AGE_MS, FILES } from './outbox.js';
export { BitrateLadder, BITRATE_RUNGS, UP_STREAK, UP_MAX_BACKLOG_S, DOWN_BACKLOG_S, isNetworkFailure } from './bitrate.js';
export { joinWindowMs, takeStartMs, roundGap, takeList, takesBody, DEFAULT_JOIN_MS, MAX_JOIN_MS, RECORDING_CAP_MS, MAX_TAKES, HOLD_MS } from './takes.js';
export { ShareRecorder, ShareTake } from './recorder.js';

/** A failed or cancelled session is shared only from this long (seconds): of the recording's whole audio. */
export const MINIMUM_PARTIAL_S = 2;

const randomHex = (bytes = 16) => {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/** The web defaults for the session JSON's device fields (PLATFORM_CLIENT 5): device class
 * `browser`, os_major the browser's major version / 10 (at least 1); in Node `node` and Node's. */
export function webDevice() {
  const nav = globalThis.navigator;
  if (globalThis.process?.versions?.node && !globalThis.window) {
    return { deviceClass: 'node', osMajor: Math.max(1, Math.min(99, Math.trunc(Number(globalThis.process.versions.node.split('.')[0]) / 10))) };
  }
  const ua = (nav && nav.userAgent) || '';
  const m = /(?:Chrome|Firefox|Version)\/(\d+)/.exec(ua);
  return { deviceClass: 'browser', osMajor: Math.max(1, Math.min(99, Math.trunc((m ? Number(m[1]) : 10) / 10))) };
}

/**
 * The sharing pipeline of one app: its outbox, the contributor id, and sessions.
 * @param {object} o
 * @param {string} o.api  the API origin (https://api.quranlab.ai)
 * @param {(() => Promise<{token: string, attested?: boolean}>) & {invalidate?: () => Promise<void>}} o.tokenProvider
 * @param {(() => object|null) | object | null} [o.flags]  the signed config's flags (or a getter)
 * @param {() => boolean} [o.enabled]  the app's `contributions` option AND the learner's consent
 * @param {string|null} [o.consentVersion]  the copy deck version the learner agreed to (custom-... for an app's own wording)
 * @param {string|null} [o.consentTextSha256]  with an app's own wording: the hash of the text the learner agreed to
 * @param {string} [o.contributor]  the contributor id (32 hex) the app's controller keeps; default: one
 *        kept in this storage
 * @param {Uint8Array} [o.contributorKeyRaw]  the device key's public half, the 65-byte uncompressed point
 * @param {string} [o.recoveryHash]  SHA-256 hex of the normalised recovery code (PLATFORM_CLIENT 9.1)
 * @param {object} [o.headers]  extra headers for the Worker calls (never sent to R2)
 * @param {object} [o.storage]  MemoryStorage, dirStorage(), indexedDbStorage() (default per runtime)
 * @param {Function} [o.fetch]
 * @param {() => Promise<string|null>} [o.turnstile]
 * @param {string} [o.platform]  'web'
 * @param {{deviceClass: string, osMajor: number}} [o.device]
 * @param {(e: SharingError) => void} [o.onError]  contributor_revoked / contributor_key_mismatch (rotate
 *        the contributor, key and code), volume_limit, capped_limit
 * @param {() => Promise<object>} [o.opus]  a libopus module factory (default: the bundled module)
 * @param {number} [o.bitrate]  a fixed Opus bit/s, 6000 to 510000, in place of the adaptive ladder (192, 96, 64,
 *        32 kbit/s by how uploads go; bitrate.js). For tests and special cases; leave it out in apps.
 * @param {() => number} [o.clock]  wall ms (the outbox's retries, the session day, the join window)
 * @param {{setTimeout: Function, clearTimeout: Function}} [o.timers]  the join window's timer (tests; default the
 *        global setTimeout and clearTimeout)
 * @param {{document?: EventTarget & {visibilityState?: string}, window?: EventTarget}} [o.lifecycle]  where the
 *        page's visibilitychange, pagehide and pageshow come from (default the page's own): a hidden page closes
 *        the open recording
 * @param {(kind: string, code: string) => void} [o.onIssue]  an issue for the platform client's issue reports (a
 *        take list the server refused as a bad request: 'other', 'takes:<code>')
 * @param {(message: string) => void} [o.log]  one line for the developer (default console.warn)
 */
export async function createSharing(o) {
  const storage = o.storage || await defaultStorage();
  const client = new ContributionClient({ api: o.api, fetch: o.fetch, headers: o.headers || {} });
  const opts = { ...o };
  // one ladder per pipeline (page or process), in memory, from the top rung
  const ladder = new BitrateLadder();
  const enabled = () => (opts.enabled ? !!opts.enabled() : true);
  const flags = () => (typeof opts.flags === 'function' ? opts.flags() : opts.flags || null);
  const clock = o.clock || (() => Date.now());
  const device = () => opts.device || webDevice();
  const contributor = async () => {
    if (opts.contributor) return opts.contributor;
    let c = await storage.getGlobal('contributor');
    if (typeof c !== 'string' || !/^[0-9a-f]{32}$/.test(c)) { c = randomHex(); await storage.setGlobal('contributor', c); }
    return c;
  };
  const tokenProvider = (...a) => opts.tokenProvider(...a);
  tokenProvider.invalidate = async () => { if (opts.tokenProvider.invalidate) await opts.tokenProvider.invalidate(); };
  // the recordings of this pipeline: takes in a row join the open one (takes.js)
  const recorder = new ShareRecorder({ make: (c) => new ShareCapture(c), flags, clock, timers: o.timers });
  const outbox = new Outbox({ storage, client, tokenProvider, flags, enabled,
    turnstile: async () => (opts.turnstile ? opts.turnstile() : null), platform: o.platform || 'web', contributor, clock: o.clock,
    onChange: (x) => opts.onChange && opts.onChange(x), onError: (e) => opts.onError && opts.onError(e), random: o.random, ladder,
    onIssue: (kind, code) => opts.onIssue && opts.onIssue(kind, code), log: (m) => (opts.log ? opts.log(m) : console.warn(m)),
    // sharing went off: the recording being captured ends at once (its files go with the queue)
    onStop: () => recorder.stop() });
  let opus = null;
  const opusModule = async () => { opus = opus || await loadOpus(o.opus); return opus; };
  // a hidden page is the app in the background: the open recording closes
  const life = o.lifecycle || { document: globalThis.document, window: typeof globalThis.window !== 'undefined' ? globalThis.window : null };
  const doc = life.document, win = life.window;
  if (doc && doc.visibilityState === 'hidden') recorder.backgrounded = true;
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') recorder.background(); else recorder.foreground(); });
  }
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('pagehide', () => { recorder.background(); });
    win.addEventListener('pageshow', () => { if (!(doc && doc.visibilityState === 'hidden')) recorder.foreground(); });
  }

  return {
    storage,
    outbox,
    client,
    /** The adaptive bitrate: `ladder.bitrate` is the bit rate the next segment opens at. */
    ladder,
    /** The recordings: `recorder.recording` is the open one (between takes too; null when none). */
    recorder,
    /** The app went to the background (the page is hidden): the open recording closes now; with a take
     * running, when the take ends. Called by the pipeline's own page listeners; call it yourself elsewhere. */
    background: () => recorder.background(),
    /** The app is in the foreground again: takes in a row may share a recording again. */
    foreground: () => recorder.foreground(),
    /** No take follows: the open recording closes now instead of at the end of its join window. */
    closeRecording: () => recorder.closeRecording(),
    /** Replace options later (the controller's new contributor and key, a new config, consent). */
    update(next) { Object.assign(opts, next); },
    /** The contributor id of this install (32 hex). */
    contributorId: contributor,
    /** A new contributor id kept in this storage (when the app does not manage it). */
    async resetContributor() { await storage.setGlobal('contributor', null); return contributor(); },
    /** "Delete what I shared" with the device key (PLATFORM_CLIENT 9.1): `sign(bytes)` signs with it.
     * The unsent queue goes too; the controller then deletes the key, id and code. */
    async deleteShared({ app, sign }) {
      const r = await client.deleteShared({ app, contributor: await contributor(), sign });
      await outbox.stop();
      outbox.stopped = false;
      return r;
    },
    /** Real aggregate numbers for the gratitude line, or null when the call fails. */
    async summary() {
      try {
        const t = await opts.tokenProvider();
        const r = await client.summary({ contributor: await contributor(), token: t.token });
        return r.status === 200 ? r.body : null;
      } catch (_) { return null; }
    },
    /** Sharing went off: uploads stop at once, the unsent queue is deleted. */
    stop: () => outbox.stop(),
    /**
     * A shared session (a take): nothing is written until the first push; when sharing is off (enabled() or
     * the config) the session records nothing. Its audio continues the open recording when it starts within
     * the join window at the same input rate (same contributor, consent and model), else it starts a new
     * recording (takes.js). `startedAt`: the wall ms the take began, when that was before this call.
     * @param {{inputSampleRate: number, inputRoute?: string, decode?: {modelRevision?: string|null,
     *          backend?: string, weightsSha256?: string|null, sdkVersion?: string}, serial?: number, startedAt?: number}} s
     */
    async startSession(s) {
      const startedAt = Number.isFinite(s.startedAt) ? s.startedAt : clock();
      const m = await opusModule();
      if (opts.contributorKeyRaw && opts.contributorKeyRaw.length !== 65) throw new TypeError('contributorKeyRaw: the 65-byte uncompressed P-256 point');
      const key = opts.contributorKeyRaw ? b64url(opts.contributorKeyRaw) : null;
      const fixed = Number.isInteger(opts.bitrate) && opts.bitrate >= 6000 && opts.bitrate <= 510000 ? opts.bitrate : null;
      return recorder.take({ storage, outbox, opus: m, enabled: () => enabled() && outbox.uploadAllowed().ok,
        settings: { ...OPUS_SETTINGS, bitrate: fixed || ladder.bitrate }, ladder: fixed ? null : ladder,
        consentVersion: opts.consentVersion ?? null, consentTextSha256: opts.consentTextSha256 ?? null, contributor: await contributor(), contributorKey: key,
        recoveryHash: opts.recoveryHash || null, device: device(), day: utcDay(clock()), ...s, startedAt });
    },
  };
}

let shared = null;
let live = null; // the pipeline once it is made (resetSharingForTests reaches its recorder)
/**
 * The page's sharing pipeline, made by the first createSharingSession and updated by later ones:
 * `outbox.resume()` at load (sessions a closed page left go up), `outbox.stop()` when the learner
 * turns sharing off (uploads stop at once, the queue is deleted, the open recording with it).
 */
export const outbox = {
  async resume() { if (shared) await (await shared).outbox.resume(); },
  async stop() { if (shared) await (await shared).outbox.stop(); },
  /** The app went to the background: the open recording closes now (with a take running, when it ends). */
  async background() { if (shared) await (await shared).background(); },
  /** The app is in the foreground again. */
  async foreground() { if (shared) (await shared).foreground(); },
  /** No take follows: the open recording closes now instead of at the end of its join window. */
  async closeRecording() { if (shared) await (await shared).closeRecording(); },
  async pending() { return shared ? (await shared).outbox.pending() : []; },
  async items() { return shared ? (await shared).outbox.items() : []; },
  /** Make the page's pipeline now (at load, to resume what a closed page left) with createSharing's options. */
  async configure(o) {
    if (!shared) { const p = createSharing(o); shared = p; p.then((s) => { if (shared === p) live = s; }, () => {}); }
    const s = await shared;
    s.update(o);
    return s;
  },
  /** The pipeline itself (createSharing's result), or null before the first session. */
  async sharing() { return shared ? shared : null; },
};

/**
 * One shared session, the controller's one-call form:
 *   createSharingSession({ api, fetch, tokenProvider, headers, contributor, contributorKeyRaw, recoveryHash,
 *                          inputSampleRate, inputRoute, decodeInfo, consentVersion, device, flags, storage })
 *   -> { push(Float32Array), finish(): Promise<ms>, abort(): Promise }
 * The page keeps one pipeline (one outbox); each call updates its options.
 */
export async function createSharingSession(o) {
  const sharing = await outbox.configure(o);
  const s = await sharing.startSession({ inputSampleRate: o.inputSampleRate, inputRoute: o.inputRoute, decode: o.decodeInfo || {} });
  return Object.assign(s, { outbox: sharing.outbox, sharing });
}

/** Forget the page's pipeline (tests): a recording it left open is dropped as a closed page drops it. */
export function resetSharingForTests() {
  if (live) live.recorder.kill();
  shared = null;
  live = null;
}

/** One recording being shared: Ogg Opus segments written as it runs, each closed segment handed to the
 * outbox at once (the Swift ShareCapture). Before 2.0.3 a recording was one session; now the recorder
 * (recorder.js) keeps it open across takes in a row, and its writer, encoder and resampler with it. push() is
 * synchronous (it encodes at once); storage writes are queued in order and awaited by finish() and abort().
 * With a `ladder`, each segment is coded at the ladder's bitrate when it opens (segment 1: when the capture
 * starts), recorded in capture.json as it opens (for recovery) and in the segment's marker. */
export class ShareCapture {
  constructor({ storage, outbox, opus, enabled, consentVersion, consentTextSha256 = null, contributor, contributorKey = null, recoveryHash = null, device, day, inputSampleRate,
    inputRoute = 'unknown',
    decode = {}, serial, plan = SEGMENT_PLAN, settings = OPUS_SETTINGS, ladder = null }) {
    Object.assign(this, { storage, outbox, opus, enabled, plan, settings, serial, ladder });
    // segment 1 opens at the rung in force when the capture starts
    if (ladder) this.settings = { ...settings, bitrate: ladder.bitrate };
    /** segment number -> bit/s, as each segment opened */
    this.bitrates = {};
    this._closedGranule = 0;
    this.id = randomHex();
    this.inputRate = Math.round(inputSampleRate);
    this.session = sessionJson({ modelRevision: decode.modelRevision ?? null, backend: decode.backend || 'exact',
      weightsSha256: decode.weightsSha256 ?? null, sdkVersion: decode.sdkVersion || SDK_VERSION, consentVersion, consentTextSha256, contributor,
      day, deviceClass: device.deviceClass, osMajor: device.osMajor, inputSampleRate: this.inputRate, inputRoute,
      contributorKey, recoveryHash });
    this.writer = null;
    this.encoder = null;
    this.segments = 0;
    this.failed = false;
    this.io = Promise.resolve();
    this.error = null;
    /** The recording's takes once a second one joined ([{start_ms, gap_ms}]); null for one take. */
    this.takes = null;
    activeCaptures.add(this.id);
  }

  _queue(fn) { this.io = this.io.then(fn).catch((e) => { this.error = this.error || e; this.failed = true; }); }

  /** Audio seconds captured so far. */
  get duration() { return this.writer ? this.writer.duration : 0; }

  /** A take joined: the recording's takes so far (2 or more), kept in takes.json (the exact body of the take
   * list call), rewritten whole each time, so recovery has them. Queued before the take's first page. */
  setTakes(takes) {
    this.takes = takes.map((t) => ({ start_ms: t.start_ms, gap_ms: t.gap_ms }));
    if (this.failed || !this.writer) return;
    const body = new TextEncoder().encode(takesBody(this.takes));
    this._queue(() => this.storage.write(this.id, FILES.takes, body));
  }

  /** Mono float samples at the session's input rate. */
  push(pcm) {
    if (this.failed) return;
    if (!this.enabled()) { this.abort(); return; }
    if (!this.writer) {
      this.encoder = new OpusEncoder(this.opus, { sampleRate: CODED_RATE, settings: this.settings });
      const id = this.id, s = this.storage;
      const ladder = this.ladder;
      this.writer = new OggOpusWriter({
        encoder: this.encoder, resampler: this.inputRate === CODED_RATE ? null : new ShareResampler(this.inputRate),
        inputRate: this.inputRate, plan: this.plan, settings: this.settings, serial: this.serial,
        vendor: `QuranLab SDK ${SDK_VERSION} ${opusVersion(this.opus)}`,
        // segment 1 keeps the bitrate the encoder was made with; later ones take the ladder's as they open
        bitrate: (n) => (ladder && n > 1 ? ladder.bitrate : null),
        onSegmentOpen: ({ n, bitrate }) => {
          this.bitrates[n] = bitrate;
          const bitrates = { ...this.bitrates };
          this._queue(() => writeJson(s, id, FILES.capture, { preSkip: this.writer.preSkip, bitrates }));
        },
        onPage: (n, bytes) => this._queue(() => s.append(id, segmentName(n) + '.opus', bytes)),
        onSegment: (seg) => {
          this.segments = seg.n;
          // the backlog and the ladder at once, before the next segment opens
          const seconds = Math.max(0, seg.granule - this._closedGranule) / 48000;
          this._closedGranule = seg.granule;
          if (typeof this.outbox.segmentClosed === 'function') this.outbox.segmentClosed(id, seg.n, seconds);
          this._queue(async () => { await mark(s, id, seg.n, seg.granule, seg.bitrate); this.outbox.drain().catch(() => {}); });
        },
      });
      const preSkip = this.writer.preSkip;
      // the session JSON and capture.json before the first page lands
      this.io = this.io.then(() => Promise.all([s.write(id, FILES.session, new TextEncoder().encode(this.session)),
        writeJson(s, id, FILES.capture, { preSkip, bitrates: {} })]));
    }
    this.writer.append(pcm instanceof Float32Array ? pcm : Float32Array.from(pcm));
  }

  /** The end of the recording: the last segment and end.json; nothing kept when sharing went off, or a
   * cancelled one (completed false: its last take's) shorter than 2 s in all with no segment gone. Returns the
   * duration in ms, or 0 when nothing is shared. */
  async finish({ completed = true } = {}) {
    const w = this.writer;
    if (!w || this.failed || !this.enabled() || w.duration <= 0 || !(completed || w.duration >= MINIMUM_PARTIAL_S || this.segments > 0)) {
      await this.abort();
      return 0;
    }
    let ms = 0;
    try { ms = w.finish(); } catch (e) { this.error = e; await this.abort(); return 0; }
    const end = { durationMs: ms, completed };
    if (this.takes && this.takes.length > 1) end.takes = this.takes.length;
    this._queue(() => writeJson(this.storage, this.id, FILES.end, end));
    await this.io;
    this._release();
    if (this.failed) return 0;
    this.outbox.drain().catch(() => {});
    return ms;
  }

  /** A cancelled or failed recording: segments already closed stay with the outbox while sharing is on (the
   * stream ends at its last whole page, and the take list with it). */
  async abort() {
    if (this.writer) this.writer.abandon();
    this.failed = true;
    await this.io.catch(() => {});
    if (this.segments === 0 || !this.enabled()) await this.storage.removeSession(this.id);
    else await recover(this.storage, this.id);
    this._release();
    if (this.encoder) { this.encoder.free(); this.encoder = null; }
    this.outbox.drain().catch(() => {});
  }

  /** Sharing went off: the recording ends here and everything it wrote is deleted. */
  async discard() {
    if (this.writer) this.writer.abandon();
    this.failed = true;
    await this.io.catch(() => {});
    await this.storage.removeSession(this.id);
    this._release();
    if (this.encoder) { this.encoder.free(); this.encoder = null; }
  }

  /** Tests: the page is gone mid-recording (storage stays as it is, nothing more is written). */
  kill() {
    if (this.writer) this.writer.abandon();
    this.failed = true;
    this._release();
    if (this.encoder) { this.encoder.free(); this.encoder = null; }
  }

  _release() {
    activeCaptures.delete(this.id);
    if (this.encoder && this.writer && this.writer.ended) { this.encoder.free(); this.encoder = null; }
  }
}
