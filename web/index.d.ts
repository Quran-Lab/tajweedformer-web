// Type definitions for @quran-lab/tajweedformer 4.0.0 (web API 4): the whole public surface, and nothing else.
// The package is a thin wrapper that loads Quran Lab's hosted loader; the same names are on globalThis.QuranLab.
// Five concepts: Client, Model, Session, Heads, Backend. Call order: Client, model, listen, read.

/** The hosted loader's URL for API 4. */
export declare const LOADER_URL: string;
/** The API number of this package and of the loader it loads. */
export declare const API: 4;
/** Load the hosted loader (once): an explicit URL and its SRI hash when the site pins one. */
export declare function loadQuranLab(options?: { src?: string; integrity?: string }): Promise<unknown>;

/** Every failure the SDK raises. `code` is stable and the same in every TajweedFormer SDK. */
export declare class TajweedError extends Error {
  /** One of the catalogue's codes, for example "needs_connection" or "microphone_denied". */
  readonly code: TajweedErrorCode;
  /** One sentence a developer can act on. */
  readonly fix: string;
  /** https://sdk.quranlab.ai/docs/errors#<code> */
  readonly docs: string;
}
type TajweedErrorCode =
  | 'invalid_argument' | 'invalid_key' | 'sdk_too_old' | 'server_rejected' | 'client_exists' | 'needs_connection' | 'network_not_permitted'
  | 'download_failed' | 'storage_full' | 'storage_failed' | 'model_missing' | 'model_invalid' | 'signature_invalid'
  | 'checksum_mismatch' | 'model_incompatible' | 'model_unavailable' | 'reference_missing' | 'session_open' | 'session_closed' | 'cancelled'
  | 'engine_failed' | 'microphone_denied' | 'microphone_unavailable' | 'interrupted' | 'sharing_unavailable' | 'runtime_unsupported';

/** The options of TajweedClient.create(). There is no analytics option in 4.0: the anonymous analytics are always on, and
 * an `analytics` key, whatever its value, is refused with invalid_argument. There is no audience option either: every
 * app shows the same sharing sheet, and an `audience` key, whatever its value, is refused with invalid_argument. */
export interface TajweedClientOptions {
  /** The developer key, qlk_v1_..., from sdk.quranlab.ai (a web key in browsers, a desktop key in Node). */
  key: string;
  appVersion?: string;
  /** Node only (a desktop key): the app id you gave that key at sdk.quranlab.ai. Required in Node. */
  appId?: string;
  /** In a browser: a name that separates this client's stored state (letters, digits, dot, dash, underscore; at most 40).
   * In Node: the storage folder (default: the OS cache folder, then quranlab/tajweedformer/<appId>). */
  storage?: string;
  /** 'off' (default): one thread. 'auto': the threads engine when this page is cross-origin isolated and the device has 4 or more cores. */
  threads?: 'auto' | 'off';
}

/** The app's link to Quran Lab. One per process (per page): a second one while the first is open is client_exists. */
export declare class TajweedClient {
  private constructor();
  static create(options: TajweedClientOptions): Promise<TajweedClient>;
  /** The Model for this app: downloads on first use, verifies, opens and warms the engine. `version` pins a model version. */
  model(version?: string | { version?: string }): Promise<TajweedModel>;
  /** Download and verify the model ahead of use: resumable, a no-op when done. */
  prefetch(options?: { unmeteredOnly?: boolean; onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void; version?: string }):
    Promise<{ bytesDone: number; bytesTotal: number; complete: boolean }>;
  /** What the SDK holds on this device, in bytes. */
  storage(): Promise<{ models: { version: string; build: string; bytes: number }[]; sharingQueueBytes: number }>;
  /** Remove the model files of this site (ciphertext only is ever stored). */
  removeModels(): Promise<void>;
  /** One structured report, safe to paste into an issue. */
  diagnose(): Promise<TajweedDiagnosis>;
  readonly sharing: TajweedSharing;
  readonly analytics: TajweedAnalytics;
  /** The answer to a pinned model version the server could not serve, or null. */
  readonly pin: { version: string; status: string } | null;
  /** The app left the foreground. Automatic in browsers; a call in Node. */
  background(): Promise<void>;
  /** The app returned to the foreground. Automatic in browsers; a call in Node. */
  foreground(): void;
  close(): Promise<void>;
}

export interface TajweedAnalytics {
  /** The app's own judge checked `rule` `checked` times and flagged `flagged` of them (anonymous daily totals). */
  reportChecks(rule: string, checked: number, flagged: number): void;
}

export interface TajweedDiagnosis {
  sdk: { version: string; latest: string | null };
  /** accepted: null while no answer from Quran Lab was seen (offline). */
  key: { accepted: boolean | null; reason: 'invalid_key' | 'sdk_too_old' | 'server_rejected' | null };
  config: 'fresh' | 'stale' | 'none';
  /** The open model (verified), or the one last used on this device; null when there is none. */
  model: { version: string; build: string; verified: boolean } | null;
  context: string | null;
  backend: TajweedBackend | null;
  microphone: 'granted' | 'denied' | 'notAsked' | 'none';
  storage: { models: { version: string; build: string; bytes: number }[]; sharingQueueBytes: number };
  /** The code of the last TajweedError, or null. */
  lastError: TajweedErrorCode | null;
  /** Waiting chunks dropped because the app did not read `chunks` (at most 256 wait), since the Client was made. */
  droppedChunks: number;
  /** The connection as far as the runtime can tell; 'unknown' in Node and where the browser has no Network Information API. */
  connection: 'unmetered' | 'metered' | 'none' | 'unknown';
}

/** Recitation sharing: every learner is asked, under the SDK's rules, and the choice is theirs: "Not now", and turning
 * sharing off or deleting what they shared at any time. */
export interface TajweedSharing {
  /** Sharing can be offered now: false in Node, on a platform where it is not offered yet, and while Quran Lab has paused
   * it for everyone (its global incident switch in the signed config). Never a decision about one app. */
  readonly isAvailable: boolean;
  /** The learner said yes. */
  readonly isOn: boolean;
  /** The settings switch. Off starts no upload request from the call on, aborts the one in flight (what the
   * browser or the system had already buffered of that segment may still go out) and deletes the unsent queue. */
  /** Off: the promise resolves when the uploads in flight are aborted and the unsent queue is gone. */
  setOn(on: boolean): Promise<void>;
  /** Ask at the app's own moment: only when an ask is due by the SDK's rules (the first after 24 hours and 3
   * completed takes, a re-ask card after 14 days and 7 takes, then 30 days and 10; three at most; never again
   * after a yes), never before a completed take of this visit and never during a take. Resolves with the
   * learner's answer, or null when no ask is due (nothing is shown). */
  ask(): Promise<{ yes: boolean } | null>;
  /** Audio the app already captures outside takes: used for the lead-in and tail of shared recordings only. */
  feed(samples: Float32Array, sampleRate: number): void;
  /** The outbox: each recording's status. */
  items(): Promise<Array<{ id: string; status: string; [key: string]: unknown }>>;
  /** The learner's summary (the gratitude line), or null. */
  summary(): Promise<{ you: { sessions: number; minutes: number }; app: { contributors: number; minutes: number } | null; all: { contributors: number; minutes: number } } | null>;
  /** "Delete what I shared". */
  delete(): Promise<unknown>;
  /** The code for deletion when the device is lost; null before the first shared recording. */
  readonly recoveryCode: string | null;
  /** The app's own wording ({ deck key: text }); null goes back to the SDK's wording. */
  setWording(overrides: Record<string, string> | null): { version: string; textSha256: string | null; canonicalText: string | null };
}

/** What ran or will run the model. On the web always the CPU engine in WebAssembly. */
export interface TajweedBackend {
  kind: 'cpu' | 'accelerator';
  name: string;
  stage: 'cpu' | 'downloading' | 'compiling' | 'testing' | 'promoted' | 'demoted';
  reason: string | null;
}

/** The vocabulary of the model. */
export interface TajweedTokens {
  readonly count: number;
  readonly blank: number;
  readonly wordBar: number;
  name(id: number): string | null;
  id(name: string): number | null;
}

/** calibration.json as shipped: read-only data for a developer's own judge. The SDK never applies it. */
export interface TajweedCalibration {
  readonly format: string | null;
  readonly sha256: string;
  /** The file's exact text. */
  readonly text: string;
  /** The file parsed, frozen. */
  readonly json: Readonly<Record<string, unknown>>;
  readonly contexts: readonly string[];
  readonly classes: readonly string[];
  readonly presets: readonly string[];
  context(name: string): Readonly<Record<string, unknown>> | null;
  /** The threshold of a site class at a preset in a context (nats on the fused LLR), or null. */
  threshold(context: string, cls: string, preset: string): number | null;
}

/** The expected units of each ayah: read-only data, downloaded only when the app asks. */
export interface TajweedReference {
  readonly isDownloaded: boolean;
  /** Download and verify the table, once. */
  fetch(): Promise<void>;
  /** The unit ids of an ayah in reading order (the word bar between words included), each unit's word, the word count. */
  units(surah: number, ayah: number): Promise<{ units: number[]; words: number[]; wordCount: number }>;
}

/** A sample clip of the model (its self-test set). */
export interface TajweedClip {
  readonly name: string;
  readonly kind: string;
  readonly durationMs: number;
}

export interface TajweedSessionOptions {
  /** Default: the config's inference.context, then the manifest's default. */
  context?: string;
  /** For pushed audio only (default 16000); listen sets it from the microphone or the clip. */
  sampleRate?: number;
  /** Head names, or 'all'. Default: log_probs, inter1_log_probs, timing_log_probs, gem, attr_qalqalah, conf. */
  heads?: string[] | 'all';
  backend?: 'auto' | 'cpu';
  /** Rank this many tokens in every decoded frame (default 0). */
  topK?: number;
  /** When set, the take finishes after that much silence following speech. */
  endOnSilenceMs?: number;
  /** listen({ from }) only: 'realTime' (default) or 'fast'. */
  pace?: 'realTime' | 'fast';
  onChunk?: (chunk: TajweedChunk) => void;
  onEvent?: (event: TajweedEvent) => void;
}

/** One verified model build on this device, from `client.model()`. Holds the engine (in a Worker in browsers). */
export declare class TajweedModel {
  private constructor();
  readonly id: string;
  readonly version: string;
  /** The build id, for diagnostics only. */
  readonly build: string;
  readonly contexts: readonly string[];
  readonly defaultContext: string;
  chunkMs(context?: string): number;
  readonly tokens: TajweedTokens;
  readonly calibration: TajweedCalibration | null;
  readonly reference: TajweedReference | null;
  readonly sampleClips: readonly TajweedClip[];
  readonly backend: TajweedBackend;
  /** A Session fed by the microphone (asks for the permission), or by a clip or samples with `from`. */
  listen(options?: TajweedSessionOptions & { from?: TajweedClip | Float32Array }): Promise<TajweedSession>;
  /** A Session the app pushes audio into. */
  session(options?: TajweedSessionOptions): TajweedSession;
  close(): Promise<void>;
}

/** One take: audio in, chunks and events out, the take's Heads at the end. */
export declare class TajweedSession {
  private constructor();
  /** Mono float samples at the Session's sampleRate (only on a Session made with model.session()). */
  push(samples: Float32Array): void;
  readonly chunks: AsyncIterable<TajweedChunk>;
  readonly events: AsyncIterable<TajweedEvent>;
  /** End the take; the take's Heads. On a listen Session it also stops the microphone. */
  finish(): Promise<TajweedHeads>;
  /** End the take and keep nothing. */
  cancel(): Promise<void>;
  readonly backend: TajweedBackend;
  /**
   * Where the learner recited in this take, used only where the SDK could not measure it itself, and optionally how
   * the app judged it (anonymous daily totals; a take is never counted twice). One report per take, until the next
   * take starts.
   */
  reportRecited(surah: number, ayahFrom: number, ayahTo: number, options?: { outcome?: RecitedOutcome; perAyah?: Record<number, RecitedOutcome> }): void;
}

/** The app's own judgement of an ayah: correct, or incorrect with how many mistakes and which rule ids. */
export type RecitedOutcome = { correct: true } | { correct: false; mistakes?: number; rules?: string[] };

export interface TajweedChunk {
  index: number;
  startMs: number;
  endMs: number;
  firstFrame: number;
  backend: TajweedBackend;
  /** The chunk holds speech frames. */
  speech: boolean;
  /** The Heads of this chunk only. */
  heads: TajweedHeads;
  /** The decoded layer of the take so far. */
  readonly decoded: TajweedDecoded;
}

export type TajweedEvent =
  | { type: 'speechStarted'; atMs: number }
  | { type: 'speechEnded'; atMs: number; silenceMs: number }
  | { type: 'interrupted'; cause: 'interruption' | 'routeChange' }
  | { type: 'resumed' }
  | { type: 'backendChanged'; backend: TajweedBackend; fromChunk: number }
  | { type: 'ended'; reason: 'silence' | 'background' | 'hidden' | 'interrupted' | 'sourceEnd' | 'limit' | 'error'; error?: TajweedError };

export interface TajweedDecoded {
  text: string;
  tokens: TajweedToken[];
  words: TajweedWord[];
  frames: TajweedFrame[];
  /** The count of leading tokens that will not change in this take. */
  settled: number;
  /** True on the last decoded layer of the take. */
  isFinal: boolean;
}

export interface TajweedToken {
  id: number;
  name: string;
  firstMs: number;
  peakMs: number;
  lastMs: number;
  /** 0 to 1 from the conf head; null when the take did not compute it. */
  confidence: number | null;
}

export interface TajweedWord {
  index: number;
  text: string;
  tokens: TajweedToken[];
  firstMs: number;
  lastMs: number;
  confidence: number | null;
}

export interface TajweedFrame {
  top1: number;
  top1LogProb: number;
  runnerUp: number;
  runnerUpLogProb: number;
  margin: number;
  /** With the topK option: the best tokens of the frame, ranked. */
  topK?: Array<{ id: number; name: string; logProb: number; margin: number }>;
}

export interface TajweedHead {
  name: string;
  kind: 'ctc' | 'attribute';
  /** 40 or 20. */
  frameMs: number;
  frames: number;
  classes: number;
  /** [frames x classes], row major: log-probs for a ctc head, probabilities (or one logit) for an attribute head. */
  values: Float32Array;
}

/** Raw model output for a span of audio (a chunk or a whole take). */
export declare class TajweedHeads {
  private constructor();
  readonly names: string[];
  get(name: string): TajweedHead | null;
  /** Greedy tokens of a CTC head (collapsed, blank removed). */
  greedy(name?: string): Array<{ id: number; firstMs: number; peakMs: number; lastMs: number }>;
  /** The decoded layer of exactly these Heads. */
  decoded(): TajweedDecoded;
}

/** The SDK's optional microphone, for apps that want samples only (browsers). */
export declare class Microphone {
  private constructor();
  /** Ask for the microphone and open it: microphone_denied when refused, microphone_unavailable when there is none. */
  static open(): Promise<Microphone>;
  /** The rate of the samples: the device's. */
  readonly sampleRate: number;
  /** Mono float samples, block by block, until close(). */
  samples(): AsyncIterable<Float32Array>;
  close(): void;
}
