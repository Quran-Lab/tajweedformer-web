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
  encode(pcm: Float32Array): Uint8Array[];
  flush(): Uint8Array[];
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
    onSegment?: (s: { n: number; granule: number; last: boolean }) => void;
  });
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
  encode(pcm: Float32Array): Uint8Array[];
  flush(): Uint8Array[];
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
  consentVersion?: string | null; contributor: string; day: string; deviceClass: string; osMajor: number;
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
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export const MAX_AGE_MS: number;
export const FILES: Readonly<{ session: string; capture: string; end: string; item: string }>;
export const activeCaptures: Set<string>;

export interface ContributionItem {
  id: string; segments: number; bytes: number; durationMs: number; day: string; completed: boolean | null;
  status: 'queued' | 'uploaded' | 'failed'; capped: boolean; failCode: string | null; failMessage: string | null;
  attempts: number; lastError: string | null;
}
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
}

export interface SharingOptions {
  api: string;
  tokenProvider: TokenProvider;
  flags?: SharingFlags | (() => SharingFlags | null) | null;
  enabled?: () => boolean;
  consentVersion?: string | null;
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
}
export interface DecodeInfo { modelRevision?: string | null; backend?: 'neuralEngine' | 'exact' | 'mock'; weightsSha256?: string | null; sdkVersion?: string }
export interface SharedSession {
  readonly id: string;
  readonly duration: number;
  /** Mono float samples at the session's input rate (synchronous: encodes at once). */
  push(pcm: Float32Array): void;
  /** The end of the session; resolves to the shared duration in ms (0 when nothing is shared). */
  finish(o?: { completed?: boolean }): Promise<number>;
  /** A cancelled or failed session. */
  abort(): Promise<void>;
}
export interface Sharing {
  storage: SharingStorage;
  outbox: Outbox;
  client: ContributionClient;
  update(next: Partial<SharingOptions>): void;
  contributorId(): Promise<string>;
  resetContributor(): Promise<string>;
  deleteShared(o: { app: string; sign: (message: Uint8Array) => Promise<Uint8Array | ArrayBuffer> }): Promise<any>;
  summary(): Promise<any | null>;
  stop(): Promise<void>;
  startSession(o: { inputSampleRate: number; inputRoute?: InputRoute; decode?: DecodeInfo; serial?: number }): Promise<SharedSession>;
}
export function createSharing(o: SharingOptions): Promise<Sharing>;
export function createSharingSession(o: SharingOptions & { inputSampleRate: number; inputRoute?: InputRoute; decodeInfo?: DecodeInfo }):
  Promise<SharedSession & { outbox: Outbox; sharing: Sharing }>;
/** The page's pipeline (made by the first createSharingSession or configure()). */
export const outbox: {
  resume(): Promise<void>;
  stop(): Promise<void>;
  pending(): Promise<ContributionItem[]>;
  items(): Promise<ContributionItem[]>;
  configure(o: SharingOptions): Promise<Sharing>;
  sharing(): Promise<Promise<Sharing> | null>;
};
export function resetSharingForTests(): void;
export function webDevice(): { deviceClass: string; osMajor: number };
export const MINIMUM_PARTIAL_S: number;
export class ShareCapture implements SharedSession {
  readonly id: string; readonly duration: number;
  push(pcm: Float32Array): void; finish(o?: { completed?: boolean }): Promise<number>; abort(): Promise<void>;
}
