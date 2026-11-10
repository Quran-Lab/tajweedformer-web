// Types for '@quran-lab/tajweedformer/sharing': whole-session recitation sharing (PLATFORM_CLIENT.md
// sections 9 and 10). See web/sharing/index.js.

export interface OpusSettings {
  application: number; bitrate: number; complexity: number; vbr: boolean; constrainedVbr: boolean;
  bandwidth: number; signal: number; frameMs: number;
}
export const OPUS_SETTINGS: Readonly<OpusSettings>;
export const CODED_RATE: 48000;
export const SEGMENT_PLAN: readonly number[];
export function segmentSeconds(n: number, plan?: readonly number[]): number;
export function segmentName(n: number): string;
export function packetFrames(s?: OpusSettings): number;
export function pagePackets(s?: OpusSettings): number;
export function oggCrc(bytes: Uint8Array): number;
export function opusHead(preSkip: number, inputRate: number): Uint8Array;
export function opusTags(vendor: string): Uint8Array;
export function oggPage(packets: Uint8Array[], o: { granule: number; serial: number; sequence: number; flags: number }): Uint8Array;
export interface OggPageInfo { flags: number; granule: number; serial: number; sequence: number; packets: Uint8Array[] }
export function readPages(bytes: Uint8Array): OggPageInfo[];
export function wholePages(bytes: Uint8Array): { keep: number; granule: number };

export interface OpusEncoding {
  readonly preSkip: number;
  readonly finalGranulePosition: number;
  /** packets coded so far; or each handed to onPacket as it is coded */
  encode(pcm: Float32Array, onPacket?: (p: Uint8Array) => void): Uint8Array[];
  flush(onPacket?: (p: Uint8Array) => void): Uint8Array[];
  /** the bit rate of the packets coded from now on (encoders that support it) */
  setBitrate?(bps: number): void;
  readonly bitrate?: number;
  /** called before each packet is coded, with its index (encoders that support it) */
  beforeFrame?: ((index: number) => void) | null;
}
export interface Resampling {
  process(x: Float32Array, sink: (y: Float32Array) => void): void;
  flush(sink: (y: Float32Array) => void): void;
}
export class OggOpusWriter {
  constructor(o: {
    encoder: OpusEncoding; resampler?: Resampling | null; inputRate: number; plan?: readonly number[];
    settings?: OpusSettings; serial?: number; vendor?: string;
    onPage: (segment: number, bytes: Uint8Array) => void;
    onSegment?: (s: { n: number; granule: number; last: boolean; bitrate: number | null }) => void;
    /** the bit rate of segment n, asked as it opens (its first packet); null keeps the current one */
    bitrate?: ((n: number) => number | null) | null;
    onSegmentOpen?: (s: { n: number; bitrate: number | null }) => void;
  });
  /** segment number -> the bit rate its packets were coded at */
  readonly segmentBitrates: Map<number, number | null>;
  readonly preSkip: number;
  readonly duration: number;
  readonly inputFrames: number;
  readonly nonFiniteSamples: number;
  readonly lastGranule: number;
  append(samples: Float32Array): void;
  finish(): number;
  abandon(): void;
}

export interface OpusModule { [k: string]: any }
export function loadOpus(factory?: () => Promise<OpusModule>): Promise<OpusModule>;
export function opusVersion(m: OpusModule): string;
export const OPUS_REQUEST: Readonly<Record<string, number>>;
export class OpusEncoder implements OpusEncoding {
  constructor(m: OpusModule, o?: { sampleRate?: number; channels?: number; settings?: OpusSettings });
  readonly preSkip: number;
  readonly finalGranulePosition: number;
  get(request: number): number | null;
  readonly bitrate: number;
  readonly packetCount: number;
  beforeFrame: ((index: number) => void) | null;
  setBitrate(bps: number): void;
  encode(pcm: Float32Array, onPacket?: (p: Uint8Array) => void): Uint8Array[];
  flush(onPacket?: (p: Uint8Array) => void): Uint8Array[];
  free(): void;
}
export function decodeOggOpus(m: OpusModule, pages: OggPageInfo[]): Float32Array;
export class ShareResampler implements Resampling {
  constructor(inputRate: number);
  process(x: Float32Array, sink: (y: Float32Array) => void): void;
  flush(sink: (y: Float32Array) => void): void;
}

export type InputRoute = 'built_in' | 'wired' | 'usb' | 'bluetooth' | 'car' | 'continuity' | 'other' | 'unknown';
export const INPUT_ROUTES: readonly InputRoute[];
export const SDK_VERSION: string;
export function utcDay(ms?: number): string;
export function b64url(bytes: Uint8Array): string;
export function deletionMessage(f: { app: string; contributor: string; nonce: string; timestamp: number }): Uint8Array;
export function sessionJson(o: {
  modelRevision?: string | null; backend?: 'neuralEngine' | 'exact' | 'mock'; weightsSha256?: string | null; sdkVersion?: string;
  consentVersion?: string | null; consentTextSha256?: string | null; contributor: string; day: string; deviceClass: string; osMajor: number;
  inputSampleRate?: number; inputRoute?: InputRoute; contributorKey?: string | null; recoveryHash?: string | null;
}): string;
export interface SegmentUrl { n: number; url: string; expiresAt: number }
export function parseUrls(body: unknown, id: string): SegmentUrl[] | null;
export function requestCounts(seconds: number, plan?: readonly number[]): { segments: number; workerCalls: number };

/** contributor_revoked / contributor_key_mismatch: make a new contributor, key and recovery code;
 * volume_limit / capped_limit: retried after the next UTC midnight; segment_cap. */
export class SharingError extends Error {
  readonly code: string;
  readonly status: number;
}

export interface ApiReply { status: number; body: any; text: string; error?: string }
export class ContributionClient {
  constructor(o: { api: string; fetch?: typeof fetch; headers?: Record<string, string> });
  start(o: { id: string; session: string; token: string; turnstile?: string | null; signal?: AbortSignal }): Promise<ApiReply>;
  urls(o: { id: string; from: number; contributor: string; token: string; signal?: AbortSignal }): Promise<ApiReply>;
  put(o: { url: string; bytes: Uint8Array; signal?: AbortSignal }): Promise<ApiReply>;
  /** 2.0.3: POST /v1/uploads/{id}/takes, the take list of an uploaded recording (body: takesBody(...)) */
  takes(o: { id: string; body: string; contributor: string; token: string; signal?: AbortSignal }): Promise<ApiReply>;
  deleteShared(o: { app: string; contributor: string; sign: (message: Uint8Array) => Promise<Uint8Array | ArrayBuffer> }): Promise<any>;
  summary(o: { contributor: string; token: string }): Promise<ApiReply>;
}

export interface SharingStorage {
  sessions(): Promise<string[]>;
  list(id: string): Promise<string[]>;
  read(id: string, name: string): Promise<Uint8Array | null>;
  write(id: string, name: string, bytes: Uint8Array): Promise<void>;
  append(id: string, name: string, bytes: Uint8Array): Promise<void>;
  truncate(id: string, name: string, length: number): Promise<void>;
  remove(id: string, name: string): Promise<void>;
  removeSession(id: string): Promise<void>;
  getGlobal(key: string): Promise<any>;
  setGlobal(key: string, value: any): Promise<void>;
}
export class MemoryStorage implements SharingStorage {
  constructor();
  snapshot(): MemoryStorage;
  sessions(): Promise<string[]>; list(id: string): Promise<string[]>; read(id: string, name: string): Promise<Uint8Array | null>;
  write(id: string, name: string, bytes: Uint8Array): Promise<void>; append(id: string, name: string, bytes: Uint8Array): Promise<void>;
  truncate(id: string, name: string, length: number): Promise<void>; remove(id: string, name: string): Promise<void>;
  removeSession(id: string): Promise<void>; getGlobal(key: string): Promise<any>; setGlobal(key: string, value: any): Promise<void>;
}
export function dirStorage(root: string): Promise<SharingStorage>;
export function indexedDbStorage(dbName?: string, idb?: IDBFactory): Promise<SharingStorage>;
export function defaultStorage(): Promise<SharingStorage>;
export function recover(storage: SharingStorage, id: string): Promise<boolean>;
/** A closed segment's record (seg-NNNNN.json); bitrate is absent for segments recorded before 2.0.1. */
export interface SegmentMarker { n: number; bytes: number; sha256: string; granule: number; bitrate?: number }
export function markers(storage: SharingStorage, id: string): Promise<SegmentMarker[]>;
export function markerSeconds(markers: SegmentMarker[]): number[];
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export const MAX_AGE_MS: number;
export const FILES: Readonly<{ session: string; capture: string; end: string; item: string; takes: string }>;
export const activeCaptures: Set<string>;

export interface ContributionItem {
  id: string; segments: number; bytes: number; durationMs: number; day: string; completed: boolean | null;
  /** the bit rate each segment was coded at, in segment order (null for a segment recorded before 2.0.1) */
  segmentBitrates: (number | null)[];
  status: 'queued' | 'uploaded' | 'failed'; capped: boolean; failCode: string | null; failMessage: string | null;
  attempts: number; lastError: string | null;
  /** 2.0.3: how many takes share this recording (1: one take) */
  takes: number;
  /** 2.0.3: the take list of a recording of 2 or more takes: waiting to be sent after the last segment
   * ('pending'), sent, or dropped (a server without the route, a deleted upload, sharing turned off); null for
   * one take. The item is `uploaded` when its segments are, whatever becomes of the list. */
  takeList: 'pending' | 'sent' | 'dropped' | null;
}

/** 2.0.3: one take of a recording: where its first sample is in the stream (ms: floor(1000 * the recording's
 * input samples before it / the input rate)) and the wall gap since the previous take ended, rounded to 100 ms. */
export interface Take { start_ms: number; gap_ms: number }
export const DEFAULT_JOIN_MS: 3000;
export const MAX_JOIN_MS: 10000;
export const RECORDING_CAP_MS: 1200000;
export const MAX_TAKES: 256;
export const HOLD_MS: 30000;
/** The join window of the signed config's flags: `share_join_ms`, a whole number 0 to 10000 (0: never join);
 * anything else is 3000. */
export function joinWindowMs(flags: unknown): number;
export function takeStartMs(samples: number, rate: number): number;
export function roundGap(ms: number): number;
/** A take list as the server takes it (2 to 256 entries), or null; with durationMs, without the takes that
 * start at or after it. */
export function takeList(takes: unknown, durationMs?: number): Take[] | null;
/** The exact body of the take list call (and what takes.json holds). */
export function takesBody(takes: Take[]): string;
export interface Token { token: string; attested?: boolean }
export type TokenProvider = (() => Promise<Token>) & { invalidate?: () => Promise<void> };
export interface SharingFlags {
  contributions?: boolean;
  upload_trust?: Record<string, 'off' | 'capped' | 'attested'>;
  capped_limits?: { turnstile_web?: boolean; [k: string]: unknown };
}
export class Outbox {
  items(): Promise<ContributionItem[]>;
  item(id: string): Promise<ContributionItem | null>;
  pending(): Promise<ContributionItem[]>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  cancel(id: string): Promise<void>;
  drain(o?: { ignoringBackoff?: boolean }): Promise<void>;
  uploadAllowed(): { ok: boolean; why?: string; tier?: string };
  /** seconds of audio in closed segments not yet uploaded, every session */
  backlogSeconds(): number;
}

/** The adaptive Opus bitrate (SDK 2.0.1): 192, 96, 64, 32 kbit/s; one per pipeline, from the top. */
export const BITRATE_RUNGS: readonly number[];
export const UP_STREAK: 3;
export const UP_MAX_BACKLOG_S: 30;
export const DOWN_BACKLOG_S: 120;
export class BitrateLadder {
  constructor();
  /** the bit rate the next segment opens at */
  readonly bitrate: number;
  readonly rung: number;
  readonly streak: number;
  uploadFailed(): void;
  uploadOk(backlogS: number): void;
  segmentClosed(backlogS: number): void;
  onChange(f: (bitrate: number) => void): () => void;
}
export function isNetworkFailure(status: number): boolean;

export interface SharingOptions {
  api: string;
  tokenProvider: TokenProvider;
  flags?: SharingFlags | (() => SharingFlags | null) | null;
  enabled?: () => boolean;
  consentVersion?: string | null;
  /** with an app's own wording: the hash of the text the learner agreed to (sent as consent_text_sha256) */
  consentTextSha256?: string | null;
  contributor?: string;
  contributorKeyRaw?: Uint8Array;
  recoveryHash?: string;
  headers?: Record<string, string>;
  storage?: SharingStorage;
  fetch?: typeof fetch;
  turnstile?: () => Promise<string | null>;
  platform?: string;
  device?: { deviceClass: string; osMajor: number };
  onChange?: (item: ContributionItem | { id: string; status: 'dropped'; failCode: string }) => void;
  onError?: (e: SharingError) => void;
  opus?: () => Promise<OpusModule>;
  clock?: () => number;
  /** a fixed Opus bit/s in place of the adaptive ladder (tests and special cases) */
  bitrate?: number;
  /** 2.0.3: the join window's timer (tests; default the global setTimeout and clearTimeout) */
  timers?: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  /** 2.0.3: where visibilitychange, pagehide and pageshow come from (default the page's document and window):
   * a hidden page closes the open recording */
  lifecycle?: { document?: (EventTarget & { visibilityState?: string }) | null; window?: EventTarget | null };
  /** 2.0.3: an issue for the platform client's reports (a take list refused as a bad request: 'other', 'takes:<code>') */
  onIssue?: (kind: string, code: string) => void;
  /** 2.0.3: one line for the developer (default console.warn): a server that does not take take lists */
  log?: (message: string) => void;
}
export interface DecodeInfo { modelRevision?: string | null; backend?: 'neuralEngine' | 'exact' | 'mock'; weightsSha256?: string | null; sdkVersion?: string }
/** A shared session: one take. Since 2.0.3 its audio goes into a recording that takes in a row share. */
export interface SharedSession {
  /** the recording's id (the outbox item's): the same for every take that joined it */
  readonly id: string | null;
  /** seconds of this take's audio so far */
  readonly duration: number;
  /** Mono float samples at the session's input rate (synchronous: encodes at once). */
  push(pcm: Float32Array): void;
  /** The end of the take; resolves to its audio in ms that went into the recording (0 when nothing is shared).
   * The recording stays open for the join window (flags.share_join_ms). endedAt: the wall ms the take ended,
   * when that was before this call. */
  finish(o?: { completed?: boolean; endedAt?: number }): Promise<number>;
  /** A failed take: its recording ends here as a failed capture. */
  abort(): Promise<void>;
}
/** 2.0.3: one take being shared (what startSession returns). */
export class ShareTake implements SharedSession {
  readonly id: string | null; readonly duration: number; readonly io: Promise<unknown>; readonly settings: OpusSettings;
  readonly segments: number; failed: boolean;
  push(pcm: Float32Array): void; finish(o?: { completed?: boolean; endedAt?: number }): Promise<number>; abort(): Promise<void>;
}
/** 2.0.3: what the recorder tells of a recording that closed. */
export interface ClosedRecording { id: string; rate: number; samples: number; audioMs: number; takes: Take[] | null; completed: boolean; sharedMs: number }
/** 2.0.3: what holds the shared recording between takes: takes in a row join the open one (see web/sharing/takes.js). */
export class ShareRecorder {
  constructor(o: { make: (options: any) => any; flags?: () => unknown; clock?: () => number;
    timers?: SharingOptions['timers'] | null; onClosed?: ((r: ClosedRecording) => void) | null });
  /** the open recording (between takes too), or null */
  readonly recording: { cap: any; rate: number; samples: number; takes: Take[]; completed: boolean } | null;
  /** the open recording's takes so far */
  readonly takes: Take[];
  /** the join window in force (ms) */
  readonly window: number;
  backgrounded: boolean;
  onClosed: ((r: ClosedRecording) => void) | null;
  take(options: any): ShareTake;
  /** the window's end: closes the waiting recording once the clock says the window has passed */
  checkWindow(): boolean;
  background(): Promise<void>;
  foreground(): void;
  closeRecording(): Promise<void>;
  stop(): Promise<void>;
  settled(): Promise<void>;
}
export interface Sharing {
  storage: SharingStorage;
  outbox: Outbox;
  client: ContributionClient;
  /** the adaptive bitrate of this pipeline */
  ladder: BitrateLadder;
  /** 2.0.3: the recordings of this pipeline */
  recorder: ShareRecorder;
  /** 2.0.3: the app went to the background (the page is hidden): the open recording closes now; with a take
   * running, when the take ends. The pipeline's own page listeners call it. */
  background(): Promise<void>;
  /** 2.0.3: the app is in the foreground again */
  foreground(): void;
  /** 2.0.3: no take follows: the open recording closes now instead of at the end of its join window */
  closeRecording(): Promise<void>;
  update(next: Partial<SharingOptions>): void;
  contributorId(): Promise<string>;
  resetContributor(): Promise<string>;
  deleteShared(o: { app: string; sign: (message: Uint8Array) => Promise<Uint8Array | ArrayBuffer> }): Promise<any>;
  summary(): Promise<any | null>;
  stop(): Promise<void>;
  /** A take: it joins the open recording when it starts within the join window at the same input rate, else it
   * starts a new one. startedAt: the wall ms the take began, when that was before this call. */
  startSession(o: { inputSampleRate: number; inputRoute?: InputRoute; decode?: DecodeInfo; serial?: number; startedAt?: number }): Promise<ShareTake>;
}
export function createSharing(o: SharingOptions): Promise<Sharing>;
export function createSharingSession(o: SharingOptions & { inputSampleRate: number; inputRoute?: InputRoute; decodeInfo?: DecodeInfo }):
  Promise<ShareTake & { outbox: Outbox; sharing: Sharing }>;
/** The page's pipeline (made by the first createSharingSession or configure()). */
export const outbox: {
  resume(): Promise<void>;
  stop(): Promise<void>;
  /** 2.0.3: the app went to the background: the open recording closes now */
  background(): Promise<void>;
  /** 2.0.3: the app is in the foreground again */
  foreground(): Promise<void>;
  /** 2.0.3: no take follows: the open recording closes now */
  closeRecording(): Promise<void>;
  pending(): Promise<ContributionItem[]>;
  items(): Promise<ContributionItem[]>;
  configure(o: SharingOptions): Promise<Sharing>;
  sharing(): Promise<Promise<Sharing> | null>;
};
export function resetSharingForTests(): void;
export function webDevice(): { deviceClass: string; osMajor: number };
export const MINIMUM_PARTIAL_S: number;
/** One recording being shared: one Ogg stream, one outbox item. Before 2.0.3 it was one session; the recorder
 * now keeps it open across takes in a row. */
export class ShareCapture {
  constructor(o: any);
  readonly id: string; readonly duration: number; readonly io: Promise<unknown>; readonly segments: number; failed: boolean;
  /** the recording's takes once a second one joined; null for one take */
  readonly takes: Take[] | null;
  push(pcm: Float32Array): void; finish(o?: { completed?: boolean }): Promise<number>; abort(): Promise<void>;
  /** 2.0.3: a take joined: the takes so far (2 or more), kept in takes.json */
  setTakes(takes: Take[]): void;
  /** 2.0.3: sharing went off: the recording ends here and everything it wrote is deleted */
  discard(): Promise<void>;
}
