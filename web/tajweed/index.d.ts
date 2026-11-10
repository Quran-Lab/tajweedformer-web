// Type definitions for the TajweedFormer V4 API (@quran-lab/tajweedformer 2.0.3).

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export type Preset = 'strict' | 'balanced' | 'sensitive' | 'very_sensitive';
/** The eight site classes of calibration.json, scored by CTC forward LLR. */
export type SiteClass = 'vowel_sub' | 'vowel_del' | 'vowel_ins' | 'short_to_long' | 'long_to_short'
  | 'cons_sub' | 'cons_del' | 'insertion';
/** The switches an app or the portal turns on and off. letters = cons_sub, cons_del, insertion;
 * vowels = vowel_sub, vowel_del, vowel_ins; length = short_to_long, long_to_short. */
export type Check = 'letters' | 'vowels' | 'length' | 'madd' | 'gemination' | 'qalqalah' | 'lazim';
/** calibration.json's status: validated is on by default, experimental off unless turned on, off is
 * never reported unless the app turns it on in a debug build. */
export type Status = 'off' | 'experimental' | 'validated';
/** Where an effective setting came from. Precedence: app > remote > calibration. */
export type Source = 'app' | 'remote' | 'calibration';
export type MaddClass = 'fixed2' | 'muttasil' | 'free' | 'lazim';
/** Features that take a per-feature preset override (never a threshold). */
export type Feature = 'madd' | 'qalqalah' | 'gemination';
/** Whose thresholds: int8 = the exact engine (default), fp32 = heads from CoreML, an NPU or a server. */
export type Backend = 'int8' | 'fp32';
/** A shipped context: "c16_l64" (320 ms chunks, left 64, the default), "c8_l64" (160 ms, CPU engine), "c24_l72" or "c24_l256" (480 ms). */
export type ContextName = string;

export declare const PRESETS: readonly Preset[];
export declare const CLASSES: readonly SiteClass[];
export declare const CHECKS: readonly Check[];
export declare const FEATURES: readonly Feature[];
export declare const BACKENDS: readonly Backend[];
export declare const ITEM_CHECK: Readonly<Record<SiteClass | 'madd' | 'lazim' | 'gemination' | 'qalqalah', Check>>;
export declare const CALIBRATION_FORMAT: 'quranlab.tajweed-calibration/1';
export declare const REMOTE_VERSION: 1;
export declare const MADD_CLASSES: readonly ['none', 'fixed2', 'muttasil', 'free', 'lazim'];
export declare const VOCAB: 38;
export declare const BLANK: 0;
/** The check a site class or verdict item belongs to ("cons_sub" -> "letters"), or null. */
export declare function checkOf(item: string): Check | null;

// ---------------------------------------------------------------------------------------------
// Settings: calibration.json < portal (remote) < app code
// ---------------------------------------------------------------------------------------------

/** A per-class override: exactly one of preset or threshold (a fused-LLR cut, -20..20). */
export type ClassOverride = { preset: Preset; threshold?: never } | { threshold: number; preset?: never };

/** What app code sets. Invalid values throw TajweedSettingsError ('invalid_app_option'). A per-class
 * (or per-feature) override, app then remote, beats a global preset, app then remote. */
export interface TajweedAppOptions {
  preset?: Preset;
  overrides?: Partial<Record<SiteClass, ClassOverride>> & Partial<Record<Feature, { preset: Preset }>>;
  checks?: Partial<Record<Check | 'word', boolean>>;
  context?: ContextName;
  /** the word level: a preset or a custom threshold (clamped to calibration's custom range) */
  word?: WordOption;
}

/** The portal's block in the signed /v1/config. Parsed leniently: an invalid field
 * is dropped, never the config; a block whose v is not 1 is ignored whole. */
export interface TajweedRemoteBlock extends TajweedAppOptions {
  v: 1;
}

export interface EffectiveSite {
  status: Status;
  /** scored and can flag */
  enabled: boolean;
  /** the fused-LLR cut in force: flag when fused LLR(best alternative) > threshold; null when
   * calibration has none for the preset (the class is then disabled) */
  threshold: number | null;
  /** the preset the threshold comes from, or null for a threshold override */
  preset: Preset | null;
  source: Source;
}

export interface EffectiveFeature {
  status: Status;
  enabled: boolean;
  preset: Preset;
  source: Source;
  /** preset_tau[preset], else tau; null when calibration has neither */
  tau: number | null;
}

export interface EffectiveSettings {
  context: ContextName;
  backend: Backend;
  preset: Preset;
  sites: Record<SiteClass, EffectiveSite>;
  /** preset picks calibration's madd.preset_cuts */
  madd: { status: Status; enabled: boolean; preset: Preset; source: Source };
  /** madd lazim: enabled only with madd */
  lazim: { status: Status; enabled: boolean };
  gemination: EffectiveFeature;
  qalqalah: EffectiveFeature;
  /** the word level, when the context's calibration has a word block (engine API 3) */
  word?: EffectiveWord;
  /** remote fields dropped as invalid: "remote", "remote.v", "remote.preset", "remote.overrides.cons_sub", ... */
  dropped: string[];
  /** "off" items a layer tried to turn on and could not: "remote:lazim", "app:insertion" (release build) */
  refused: string[];
}

/** One context of calibration.json. */
export interface CalibrationContext {
  fusion: { heads: string[]; a: Record<string, number> };
  /** a class absent is "off"; a preset absent from thresholds disables the class at that preset */
  sites: Partial<Record<SiteClass, { status?: Status; thresholds?: Partial<Record<Preset, number | null>>; evidence?: unknown }>>;
  /** per backend: thresholds that replace a class's whole set */
  backend_overrides?: Partial<Record<Backend, { sites?: Partial<Record<SiteClass, { thresholds?: Partial<Record<Preset, number | null>> }>> }>>;
  madd?: { status?: Status; unit?: string; min_short_vowels?: number; cuts?: Record<string, unknown>;
    preset_cuts?: Partial<Record<Preset, unknown>>; source?: string };
  qalqalah?: { status?: Status; tau?: number; preset_tau?: Partial<Record<Preset, number>>; source?: string };
  gemination?: { status?: Status; tau?: number; preset_tau?: Partial<Record<Preset, number>>; [k: string]: unknown };
  ghunna?: { status: Status };
  tafkheem?: { status: Status };
  [k: string]: unknown;
}

/** calibration.json (quranlab.tajweed-calibration/1), shipped and signed in sdk/v4.0. */
export interface Calibration {
  format: 'quranlab.tajweed-calibration/1';
  model_id: string;
  checkpoint_sha256?: string;
  tokens_sha256?: string;
  default_context: ContextName;
  default_preset: Preset;
  presets: Record<Preset, { site_fa: number; label: string }>;
  classes: SiteClass[];
  contexts: Record<ContextName, CalibrationContext>;
}

export declare class TajweedSettingsError extends Error {
  readonly code: 'invalid_app_option' | 'invalid_calibration';
  /** the option or calibration field at fault, e.g. "overrides.cons_sub" */
  readonly field: string;
}

/** Parse the remote block. Never throws. */
export declare function parseRemote(raw: unknown): { block: Partial<TajweedAppOptions> | null; dropped: string[] };
/** The tajweed block of a whole /v1/config document, or the argument when it is a block already. */
export declare function remoteBlockOf(doc: unknown): unknown;
/** Throws TajweedSettingsError('invalid_app_option') on any invalid value. */
export declare function validateAppOptions(app: TajweedAppOptions | null | undefined, calibration: Calibration): TajweedAppOptions;
/** Throws TajweedSettingsError('invalid_calibration'). */
export declare function validateCalibration(cal: unknown): Calibration;
/** app > remote > calibration. `debug` (default false): the app is a debug build, so app code (never
 * the portal) may turn on an "off" check. `backend` (default 'int8'): whose thresholds. Throws only on
 * invalid app options or an unknown backend. */
export declare function resolveSettings(calibration: Calibration, remoteRaw: unknown, app?: TajweedAppOptions | null,
  debug?: boolean | { debug?: boolean }, backend?: Backend): EffectiveSettings;

/** The three layers as an app holds them. Setters validate and throw; setRemote never throws.
 * Passing null to a setter removes the app's setting so the lower layers show through. */
export declare class TajweedSettings {
  constructor(calibration: Calibration, opts?: { debug?: boolean; backend?: Backend; app?: TajweedAppOptions; remote?: unknown });
  readonly calibration: Calibration;
  /** a debug build: only then can app code turn on an "off" check. Default false. */
  debug: boolean;
  /** whose thresholds; default 'int8' (the exact engine) */
  backend: Backend;
  readonly app: TajweedAppOptions;
  readonly remote: unknown;
  /** The block, or a /v1/config document holding it, parsed or as JSON text; null clears it.
   * Returns the dropped fields. */
  setRemote(raw: unknown): string[];
  setApp(app: TajweedAppOptions): this;
  setPreset(preset: Preset | null): this;
  setClassPreset(cls: SiteClass | Feature, preset: Preset | null): this;
  setClassThreshold(cls: SiteClass, threshold: number): this;
  clearClass(cls: SiteClass | Feature): this;
  setCheck(check: Check, on: boolean | null): this;
  setContext(context: ContextName | null): this;
  clearApp(): this;
  effective(): EffectiveSettings;
  /** the app's word level ({ preset } or { threshold }); null removes it */
  setWord(word: WordOption | null): this;
  wordLevel(): WordLevel | null;
}

// ---------------------------------------------------------------------------------------------
// Model folders and the signed manifest
// ---------------------------------------------------------------------------------------------

export declare const SDK_VERSION: '2.0.3';
export declare const SUPPORTED_MANIFEST_FORMATS: readonly number[];
export declare const SUPPORTED_ENGINE_FORMATS: readonly number[];
export declare const ENGINE_FORMAT_TAJWEEDFORMER: 2;
/** Quran Lab's manifest signing key, raw Ed25519, hex (key id 660a07197c4808da). */
export declare const QURANLAB_PUBLIC_KEY_HEX: string;
/** Files a V4 folder must list: calibration.json and the expected table. */
export declare const V4_REQUIRED_FILES: readonly string[];

export interface ManifestFile { path: string; size: number; sha256: string }

/** manifest.json, format 2 (format 1 has `model` for model_id and none of the compatibility fields). */
export interface Manifest {
  format: 1 | 2;
  model_id: string;
  model?: string;
  family: string;
  revision: string;
  min_sdk_version: string;
  /** 1 = v3 zipformer, 2 = V4 TajweedFormer */
  engine_format: number;
  coreml_format: number;
  tokens_sha256: string;
  /** "-" when the folder ships none */
  coreml: string;
  sidecar: string;
  keeps: string;
  tokens: string;
  files: ManifestFile[];
  /** base64 Ed25519 over signedText(manifest) */
  signature?: string;
}

export type ModelFolderErrorCode = 'manifest_missing' | 'manifest_invalid' | 'signature_invalid' | 'signature_required'
  | 'signature_unsupported' | 'sdk_too_old' | 'format_unsupported' | 'engine_format_unsupported' | 'not_listed'
  | 'file_missing' | 'checksum_mismatch' | 'calibration_invalid' | 'tokens_invalid';

export declare class ModelFolderError extends Error {
  readonly code: ModelFolderErrorCode;
  readonly file?: string;
}

/** Where a folder's bytes come from; null = no such file. */
export interface FolderReader { read(path: string): Promise<Uint8Array | null> }

export declare function memoryReader(files: Record<string, Uint8Array | ArrayBuffer | ArrayBufferView>): FolderReader;
export declare function urlReader(baseUrl: string, fetchImpl?: typeof fetch): FolderReader;

/** The exact signed text (make_manifest.py / make_manifest3.py signed_text). Format 3 with a golden_tolerance field:
 * its lines after the header lines unless `tolerance` is false. */
export declare function signedText(m: Manifest | Record<string, unknown>, o?: { tolerance?: boolean }): string;
export declare function verifyManifestSignature(m: Manifest | Record<string, unknown>, trustedKeys?: (string | Uint8Array)[]): Promise<boolean>;
/** The signature check and whether it covers golden_tolerance (verified with its lines; a manifest that verifies
 * only without them is valid and its tolerance is ignored). */
export declare function checkManifestSignature(m: Manifest | Record<string, unknown>, trustedKeys?: (string | Uint8Array)[]):
  Promise<{ valid: boolean; toleranceSigned: boolean }>;
/** A golden_tolerance entry: the differences from the CPU engine an accelerator build's golden test may show. */
export interface GoldenTolerance { token_diffs: number; site_flag_diffs: number; word_flag_diffs: number }
export declare const GOLDEN_TOLERANCE_KEYS: readonly ['token_diffs', 'site_flag_diffs', 'word_flag_diffs'];
/** golden_tolerance read leniently: well-formed entries only (counts 0 to 1000000); null when absent. */
export declare function parseGoldenTolerance(gt: unknown): Record<string, GoldenTolerance> | null;
export declare function checkManifestShape(m: unknown): Manifest;
export declare function versionAtLeast(version: string, minimum: string): boolean;
export declare function isSafePath(p: string): boolean;
export declare function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string>;
export declare function hexToBytes(hex: string): Uint8Array;
export declare function bytesToHex(bytes: Uint8Array): string;
export declare function parseTokens(text: string): string[];

export interface ModelFolderOptions {
  /** Ed25519 public keys (hex or raw bytes); default Quran Lab's */
  trustedKeys?: (string | Uint8Array)[];
  /** refuse an unsigned manifest (default false); a signature that is present must always verify */
  requireSignature?: boolean;
  /** check every listed file at open ('all', the default) or each when read */
  verify?: 'all' | 'on-read';
  /** compared with min_sdk_version; default SDK_VERSION */
  sdkVersion?: string;
  engineFormats?: number[];
  /** keep the bytes of files read */
  cache?: boolean;
}

export declare class ModelFolder {
  static open(reader: FolderReader, opts?: ModelFolderOptions): Promise<ModelFolder>;
  readonly manifest: Manifest;
  readonly modelId: string;
  readonly engineFormat: number;
  /** golden_tolerance per build when the signature covers it; null when absent or unsigned (every build exact) */
  readonly goldenTolerance: Record<string, GoldenTolerance> | null;
  /** a build's tolerance (`coreml`, `npu:<soc>:<context>`, ...), zeros when not signed or not listed */
  toleranceFor(build: string): GoldenTolerance;
  readonly paths: string[];
  has(path: string): boolean;
  under(prefix: string): string[];
  /** a listed file, size and SHA-256 checked */
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  verifyAll(): Promise<void>;
}

export declare function openTajweedFolder(reader: FolderReader, opts?: ModelFolderOptions):
  Promise<{ folder: ModelFolder; calibration: Calibration; tokens: string[]; contexts: ContextName[] }>;

// ---------------------------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------------------------

export interface HeadSpec {
  name: 'log_probs' | 'inter1_log_probs' | 'inter4_log_probs' | 'id_log_probs' | 'timing_log_probs' | 'gem'
    | 'attr_tafkheem' | 'attr_ghunna' | 'attr_qalqalah' | 'attr_face' | 'boundary' | 'conf';
  key: keyof Omit<TajweedHeads, 'n40' | 'n20' | 'vocab'>;
  width: number;
  /** frame rate in ms: 40 (CTC heads) or 20 */
  rate: 20 | 40;
  kind: 'log_softmax' | 'softmax' | 'logit';
  classes?: string[];
  what?: string;
}
export declare const HEAD_SPECS: readonly HeadSpec[];
/** The heads the scorer reads; checks whose head is missing are skipped. */
export declare const SCORER_HEADS: readonly string[];

/**
 * Every output of the network (README_heads.txt), row-major, frames first: n40 frames at 40 ms,
 * n20 = 2 x n40 at 20 ms (20 ms frames 2k and 2k + 1 lie in 40 ms frame k). null = not provided.
 * Per chunk: n40 = 8, n20 = 16 at c16; 12 and 24 at c24.
 */
export interface TajweedHeads {
  n40: number;
  n20: number;
  vocab: 38;
  /** [n40, 38] final CTC, log-softmax */
  logProbs: Float32Array;
  /** [n40, 38] stack-1 InterCTC, log-softmax */
  inter1LogProbs: Float32Array | null;
  /** [n40, 38] stack-4 InterCTC, log-softmax (diagnostic) */
  inter4LogProbs: Float32Array | null;
  /** [n20, 38] identity CTC, log-softmax */
  idLogProbs: Float32Array | null;
  /** [n20, 38] H-time chain, log-softmax; 0 = pause */
  timingLogProbs: Float32Array | null;
  /** [n20, 2] softmax: single, held */
  gem: Float32Array | null;
  /** [n20, 3] softmax: thin, heavy, low heavy */
  attrTafkheem: Float32Array | null;
  /** [n20, 5] softmax: none, plain, geminate, ikhfa, idgham */
  attrGhunna: Float32Array | null;
  /** [n20, 3] softmax: none, sughra, kubra */
  attrQalqalah: Float32Array | null;
  /** [n20, 4] softmax: none, imala, tasheel, sakt */
  attrFace: Float32Array | null;
  /** [n20] logit: a unit starts here */
  boundary: Float32Array | null;
  /** [n20] logit: the frame's label is truthful */
  conf: Float32Array | null;
}

export declare function checkHeads<T extends Partial<TajweedHeads> & { n40: number }>(heads: T): T;
export declare function joinHeads(chunks: TajweedHeads[]): TajweedHeads;
/** Audio per engine chunk in ms for a context name ("c16_l64" -> 320), 0 if not a context name. */
export declare function contextChunkMs(context: string): number;

// ---------------------------------------------------------------------------------------------
// Verdicts (the engine's ZfTajweedResult; JSON layout of the reference scorer)
// ---------------------------------------------------------------------------------------------

/** One scored site: the expected unit and the best single-unit alternative of its class. */
export interface TajweedSiteVerdict {
  class: SiteClass;
  check: Check;
  status: Status;
  /** index into the expected tokens; an insertion: the unit it follows, -1 at the start */
  pos: number;
  /** 0-based word of the ayah */
  word: number;
  /** tj3 id expected at pos; -1 for an insertion */
  expected: number;
  expectedUnit: string | null;
  /** tj3 id of the best alternative; -1 for a deletion */
  alternative: number;
  alternativeUnit: string | null;
  /** log P(alternative) - log P(expected), full-sequence CTC forward, per head */
  llr: { final: number; inter1: number };
  /** a * llr.final + (1 - a) * llr.inter1, `a` from calibration's fusion */
  fusedLlr: number;
  threshold: number;
  /** enabled and fusedLlr > threshold */
  flagged: boolean;
  /** 40 ms frames the expected unit holds on the best path; -1 unknown */
  frameLo: number;
  frameHi: number;
}

/** One madd long vowel, counted from the timing head. */
export interface TajweedMaddVerdict {
  pos: number;
  word: number;
  token: number;
  unit: string | null;
  maddClass: MaddClass;
  status: Status;
  /** held frames / the take's median short-vowel frames */
  ratio: number;
  /** the verdict count, 2, 4 or 6, from calibration's cuts */
  count: number;
  /** a smooth count for display, never for verdicts */
  displayCount: number;
  allowedLo: number;
  allowedHi: number;
  /** count outside [allowedLo, allowedHi] and the check enabled */
  flagged: boolean;
  /** 20 ms frames */
  frameLo: number;
  frameHi: number;
}

/** A letter feature: qalqalah (mean P(burst) after the letter) or gemination (mean P(held) over it).
 * flagged = the feature is missing (score below threshold) and the check enabled. */
export interface TajweedLetterVerdict {
  pos: number;
  word: number;
  token: number;
  unit: string | null;
  status: Status;
  score: number;
  threshold: number;
  flagged: boolean;
  frameLo: number;
  frameHi: number;
}

export interface TajweedSummary {
  sites: number; flagged: number;
  madd: number; maddFlagged: number;
  qalqalah: number; qalqalahFlagged: number;
  gemination: number; geminationFlagged: number;
  /** the madd unit: median short-vowel frames, 0 when too few */
  shortVowelFrames: number;
  /** enough short vowels for madd counts (calibration's min_short_vowels) */
  maddUnitOk: boolean;
}

export interface TajweedResult {
  surah: number;
  ayah: number;
  context: ContextName;
  /** the SDK's resolution of the settings the take was scored with */
  settings: EffectiveSettings;
  /** one class per site, as the engine's ZfTajweedSite */
  sites: TajweedSiteVerdict[];
  madd: TajweedMaddVerdict[];
  qalqalah: TajweedLetterVerdict[];
  gemination: TajweedLetterVerdict[];
  summary: TajweedSummary & { words: number; wordsFlagged: number };
  /** per word of the scored path (API_LAYERS.md section 3) */
  words: TajweedWordResult[];
  /** the word level in force, or null while the model's calibration has no word block */
  wordLevel: WordLevel | null;
  /** the scored path (the legal reading closest to the greedy decode) and each token's word */
  path: { tokens: Int32Array; wordOfToken: Int32Array } | null;
  /** the decoded layer of the same heads, when score() was called with { decoded: true } */
  decoded?: DecodedTake;
  /** the engine's zf_tajweed_result_json, parsed (null if it was not JSON), and as text */
  raw: unknown;
  rawText: string;
  /** whether the engine resolved the settings as the SDK did (see TajweedFormer.engineSettings) */
  settingsCheck: { agree: boolean; differences: string[] };
}

/** The engine's resolved settings (ZfTajweedEffective) with names spelled out. */
export interface EngineEffectiveSettings {
  preset: Preset | null;
  presetSource: Source | null;
  classes: Record<SiteClass, { enabled: boolean; status: Status | null; threshold: number; source: Source | null }>;
  checks: Record<Check, { enabled: boolean; status: Status | null; source: Source | null }>;
  context: ContextName;
  contextSource: Source | null;
}

// ---------------------------------------------------------------------------------------------
// The model and its streams
// ---------------------------------------------------------------------------------------------

/** Thrown by everything that needs the V4 engine when the module does not carry it (a build without
 * the engine's V4 sources, the pure-JS entry, or after free()). */
export declare class EngineNotAvailableError extends Error {
  readonly code: 'engine_not_available';
}

export interface TajweedFormerLoadOptions extends Omit<ModelFolderOptions, 'cache'> {
  /** the folder: a reader, or its files in memory by manifest path, or its base URL (sdk/v4.0/), or the
   * Quran Lab CDN, or the platform client's recommended model. Over HTTP only the download profile
   * (root files + this context) is fetched, in resumable ranges, SHA-256 checked, cached. */
  reader?: FolderReader;
  files?: Record<string, Uint8Array | ArrayBuffer | ArrayBufferView>;
  url?: string;
  /** extra request headers for `url` (e.g. x-qlab-key) */
  headers?: Record<string, string>;
  /** the Quran Lab CDN (a signed manifest is then required) */
  cdn?: CdnSource;
  /** a configured platform client (@quran-lab/tajweedformer/platform): the recommended model, the
   * portal's settings, telemetry */
  platform?: { modelSource(): Promise<{ url: string; headers: Record<string, string> }>; attach(tf: TajweedFormer): void };
  /** the delivery cache (default: the Cache API, else IndexedDB, else memory; Node: pass dirStore()); false: none */
  cache?: DeliveryStore | false;
  onProgress?: (p: DeliveryProgress) => void;
  signal?: AbortSignal;
  parallelDownloads?: number;
  fetch?: typeof fetch;
  /** the context the engine runs, fixed at load; default: remote, then calibration's default */
  context?: ContextName;
  /** app code's tajweed settings (throws on invalid values); `word` is the word level */
  settings?: TajweedAppOptions;
  /** the portal's /v1/config or its tajweed block, if already at hand */
  remote?: unknown;
  /** a debug build of the app (default false): only then can app code turn on "off" checks */
  debug?: boolean;
  /** whose thresholds: 'int8' for the exact engine's heads, 'fp32' for heads from CoreML, an NPU or a
   * server. Default: 'fp32' for a scoring-only model (it scores heads from elsewhere), else 'int8',
   * as the engine defaults. score() can override it per call. */
  backend?: Backend;
  /** load the exact engine (default true). false: folder, settings and types only. */
  loadEngine?: boolean;
  /** open the model for scoring only, without the streaming engine (default: true for the
   * '@quran-lab/tajweedformer/scorer' entry, false otherwise): score() and expected() work, streams do not */
  scoreOnly?: boolean;
  /** the rate pushed audio comes at: 16000 (default), or 8000 to 48000 through the engine's resampler */
  sampleRate?: number;
  threads?: number;
}

export interface TajweedFormerInfo {
  modelId: string;
  family: string;
  revision: string;
  engineFormat: number;
  minSdkVersion: string;
  signed: boolean;
  contexts: ContextName[];
  defaultContext: ContextName;
  context: ContextName;
  chunkMs: number;
  vocab: 38;
  blank: 0;
  /** 'exact-cpu': the streaming engine and the scorer; 'scorer': the scorer only; 'none' */
  engine: 'exact-cpu' | 'scorer' | 'none';
  /** zf_tajweed_version of the engine, null without it */
  engineVersion: string | null;
  /** the rate pushed audio comes at */
  sampleRate: number;
}

/** One engine chunk as onChunk hands it over: the selected heads (others null) plus where it sits. */
export interface TajweedChunk extends TajweedHeads {
  /** 0, 1, 2, ... within the take */
  index: number;
  /** its first 40 ms frame within the take */
  frame0: number;
  startMs: number;
  endMs: number;
  /** top-1 and runner-up of each of its 40 ms frames (null when log_probs is not selected) */
  frames: DecodedFrame[] | null;
}

/** A stream over the exact engine: audio in, heads out per chunk. One live stream at a time. */
export interface TajweedStream {
  /** mono float PCM in [-1, 1] at the stream's sampleRate; returns the engine chunks run */
  pushAudio(samples: Float32Array): number;
  /** the end of the take (the 1.05 s flush); returns the chunks run */
  finish(): number;
  /** the kept heads of the take so far (copies): the selection, always with the scorer's heads */
  heads(): TajweedHeads;
  /** the decoded layer of the take so far; with k, every frame also carries its k best tokens (ranked) */
  decoded(opts?: { k?: number }): DecodedTake;
  /** top-K of a kept head over the take (the engine's zf_tajweed_stream_topk when the module has it) */
  topK(head?: RankedHead, k?: number): TopK | null;
  /** the engine's per-frame top-1 and runner-up of the take so far (zf_tajweed_stream_top2), or a range of it */
  top2(from?: number, to?: number | null): DecodedFrame[] | null;
  /** the engine's greedy transcript (token ids); decoded().ids is the same */
  greedy(): number[];
  /** a new take */
  reset(): void;
  free(): void;
}

export interface TajweedStreamOptions {
  sampleRate?: number;
  /** heads handed over and kept besides the default (the scorer's heads and conf) */
  heads?: string[];
  /** keep all twelve heads */
  allHeads?: boolean;
  /** each engine chunk, as copies, in order */
  onChunk?: (chunk: TajweedChunk) => void;
}

// ---------------------------------------------------------------------------------------------
// The decoded layer
// ---------------------------------------------------------------------------------------------

export interface DecodedFrame { top1: number; top1LogProb: number; runnerUp: number; runnerUpLogProb: number; margin: number;
  /** with decode({ k }): the k best tokens, ranked */
  ranked?: { id: number; unit: string; logProb: number; margin: number }[] }
export interface DecodedToken {
  id: number; unit: string; frame0: number; frame1: number; startMs: number; endMs: number; peakFrame: number;
  /** top-1 log-prob at the peak frame */
  logProb: number;
  runnerUp: number; runnerUpUnit: string; runnerUpLogProb: number;
  /** logProb - runnerUpLogProb at the peak frame */
  margin: number;
  /** mean sigmoid(conf) over the token's 20 ms frames; null without the conf head */
  confidence: number | null;
}
export interface DecodedWord { index: number; tokens: number[]; units: string[]; startMs: number; endMs: number; confidence: number | null; margin: number }
export interface DecodedTake {
  frames: DecodedFrame[];
  tokens: DecodedToken[];
  /** tokens split at the word boundary token (V4 rarely emits it: use TajweedResult.words for a known ayah) */
  words: DecodedWord[];
  transcript: string;
  ids: number[];
}
export declare const DEFAULT_STREAM_HEADS: readonly string[];
export declare const WORD_BOUNDARY: 1;
export declare const CTC_FRAME_MS: 40;
export declare const HEAD_FRAME_MS: 20;
export declare function decode(heads: Partial<TajweedHeads> & { n40: number; logProbs: Float32Array }, opts?: { tokens?: string[] }): DecodedTake;
export declare function decodeFrames(logProbs: Float32Array, n40: number, from?: number, to?: number): DecodedFrame[];
export declare function sigmoidHead(a: Float32Array): Float32Array;
/** Top-K (P2.16) */
export type RankedHead = 'log_probs' | 'inter1_log_probs' | 'inter4_log_probs' | 'id_log_probs' | 'timing_log_probs' | 'gem'
  | 'attr_tafkheem' | 'attr_ghunna' | 'attr_qalqalah' | 'attr_face';
export interface TopK {
  head: RankedHead; rate: 20 | 40; names: readonly string[] | null; frames: number; cols: number; k: number;
  /** [frames x k] row major: the ranked ids, their values, margin to the next rank (double) */
  ids: Int32Array; values: Float32Array; margins: Float64Array;
}
export declare const RANKED_HEADS: Readonly<Record<RankedHead, number>>;
export declare function topKOf(values: Float32Array, frames: number, cols: number, k: number): Omit<TopK, 'head' | 'rate' | 'names'>;
export declare function topK(heads: Partial<TajweedHeads>, head?: RankedHead, k?: number, names?: string[] | null): TopK | null;

// ---------------------------------------------------------------------------------------------
// Words (API_LAYERS.md section 3) and the word level (P2.6)
// ---------------------------------------------------------------------------------------------

export type WordPreset = 'strict' | 'general' | 'beginner';
export type WordOption = { preset: WordPreset; threshold?: never } | { threshold: number; preset?: never };
export declare const WORD_PRESETS: readonly WordPreset[];
export declare const WORD_CHECK: 'word';
/** effective().word: the engine's resolution (zf_tajweed_config_word) */
export interface EffectiveWord { status: Status; enabled: boolean; preset: WordPreset | 'custom'; source: Source; tau: number | null }
export interface WordLevel extends EffectiveWord {
  threshold: number | null; presets: Partial<Record<WordPreset, number>>; floor: number; min: number; max: number;
}
export interface TajweedWordResult {
  word: number;
  /** the engine's word score: the largest clipped fused LLR over every single edit inside the word; null
   * when the word was not scored (the word check off, or no word block in calibration) */
  score: number | null;
  /** the word tau in force (null when not scored) */
  threshold: number | null;
  /** score >= threshold (null when not scored) */
  flagged: boolean | null;
  /** the edit that gave the score */
  best: { class: SiteClass | null; edit: 'sub' | 'del' | 'ins' | null; pos: number; expected: number; expectedUnit: string | null;
    alternative: number; alternativeUnit: string | null; llr: { final: number | null; inter1: number | null } } | null;
  /** [first, end) token indexes on the scored path (result.path) */
  tokens: [number, number] | null;
  startMs: number | null;
  endMs: number | null;
  /** indexes of the word's flagged items */
  issues: { sites: number[]; madd: number[]; qalqalah: number[]; gemination: number[] };
}
export declare function wordResults(r: { sites: TajweedSiteVerdict[]; madd?: TajweedMaddVerdict[]; qalqalah?: TajweedLetterVerdict[];
  gemination?: TajweedLetterVerdict[]; engineWords?: object[] }, nWords: number): TajweedWordResult[];
export interface WordCalibration { status: Status; tau: Partial<Record<WordPreset, number>>; defaultPreset: WordPreset; floor: number; customLo: number; customHi: number }
export declare function wordCalibration(calibration: Calibration, context: ContextName): WordCalibration | null;

// ---------------------------------------------------------------------------------------------
// Delivery (web/tajweed/delivery.js)
// ---------------------------------------------------------------------------------------------

export interface DeliveryStore {
  kind: string;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
}
export interface DeliveryProgress { path: string; loaded: number; total: number; cached: boolean }
export interface DeliveryStats { requests: number; bytesDownloaded: number; filesFromCache: number; filesDownloaded: number; rangesResumed: number }
export interface CdnSource { key: string; revision: string; repo?: string; folder?: string; url?: string }
export declare const CACHE_NAME: string;
export declare const DEFAULT_RANGE_SIZE: number;
export declare class DeliveryError extends Error { readonly code: 'http' | 'checksum_mismatch' | 'aborted' | 'offline'; readonly status?: number }
export declare function memoryStore(): DeliveryStore;
export declare function cacheApiStore(name?: string): DeliveryStore;
export declare function indexedDbStore(name?: string): DeliveryStore;
export declare function defaultStore(): DeliveryStore;
/** The files a profile needs: format 3 by its tags (need required, platforms, context), as logical (decoded) paths;
 * format 2 by path (root files and the context folder). */
export declare function profilePaths(manifest: Manifest, profile: { context: ContextName; platform?: 'web' | 'native' | 'android' | 'apple'; optional?: boolean }): string[];
/** A format 3 file's decoded path, the path otherwise. */
export declare function logicalPath(f: ManifestFile & { encoding?: string; decoded?: { path: string } }): string;
/** gzip bytes inflated with DecompressionStream. */
export declare function gunzip(bytes: Uint8Array): Promise<Uint8Array>;
export declare const ENGINE_FORMATS_TAJWEEDFORMER: readonly number[];
export declare const V3_PLATFORMS: readonly ['android', 'apple', 'web', 'native'];
export declare function cachedReader(o: { baseUrl: string; headers?: Record<string, string>; fetch?: typeof fetch; store?: DeliveryStore | false;
  rangeSize?: number; parallel?: number; onProgress?: (p: DeliveryProgress) => void; signal?: AbortSignal }):
  FolderReader & { prefetch(paths: string[]): Promise<void>; stats: DeliveryStats; store: DeliveryStore | null };
export declare function pruneCache(store: DeliveryStore, keepManifests: Manifest[]): Promise<number>;
export declare function cdnFolderUrl(src: CdnSource): { url: string; headers: Record<string, string> };
/** https://cdn.quranlab.ai/models */
export declare const MODELS_URL: string;
/** {base}/{repo}/{revision}/{folder}/ (a bare cdn.quranlab.ai base: the old /hf/ path) */
export declare function modelFolderUrl(base: string | null | undefined, repo: string, revision: string, folder: string): string;

export declare class TajweedFormer {
  static load(opts: TajweedFormerLoadOptions): Promise<TajweedFormer>;
  readonly folder: ModelFolder;
  readonly calibration: Calibration;
  readonly tokens: string[];
  readonly settings: TajweedSettings;
  /** the context the engine runs */
  readonly context: ContextName;
  readonly info: TajweedFormerInfo;
  readonly presets: { name: Preset; label: string; siteFa: number | null }[];
  /** the files this load needed (the download profile) */
  readonly profile: string[];
  /** what the delivery did (null for a reader without stats) */
  readonly delivery: (DeliveryStats & { store: string | null }) | null;
  /** load time in ms (download, verification, engine) */
  readonly loadMs: number;
  /** the decoded layer of any heads (no engine needed) */
  decode(heads: Partial<TajweedHeads> & { n40: number; logProbs: Float32Array }, opts?: { k?: number }): DecodedTake;
  /** top-K of any rankable head (P2.16) */
  topK(heads: Partial<TajweedHeads>, head?: RankedHead, k?: number): TopK | null;
  /** the word level in force, or null while the calibration has no word block */
  wordLevel(): WordLevel | null;
  /** never throws; returns the dropped fields */
  setRemoteConfig(doc: unknown): string[];
  effectiveSettings(): EffectiveSettings;
  tokenName(id: number): string | null;
  /** ENGINE (every ENGINE method throws EngineNotAvailableError without it) */
  ayahCount(surah: number): number;
  /** ENGINE: the expected tj3 sequence (continuing form) and each token's word */
  expected(surah: number, ayah: number): { tokens: Int32Array; wordOfToken: Int32Array; words: number };
  /** ENGINE */
  createStream(opts?: TajweedStreamOptions): TajweedStream;
  /** ENGINE: score a take of surah:ayah with the settings in force. `backend` for this call only:
   * 'int8' for the exact engine's heads, 'fp32' for heads from the Neural Engine, an NPU or a server.
   * In a debug build (load's `debug`) a disagreement between the engine's and the SDK's settings
   * resolution throws (code 'settings_mismatch'); otherwise it is in result.settingsCheck. */
  score(heads: TajweedHeads, surah: number, ayah: number, opts?: { backend?: Backend; decoded?: boolean }): Promise<TajweedResult>;
  /** ENGINE: the SDK's settings put into the engine's config, the engine's resolution of them (the
   * struct, and with an API 2 engine its JSON in TAJWEED_SETTINGS.md rev 2's layout), and every way it
   * differs from effectiveSettings() (including app settings the engine has no setter for) */
  engineSettings(): { engine: EngineEffectiveSettings; engineJson: unknown; differences: string[] };
  /** the rate the stream takes audio at (load's sampleRate) */
  readonly sampleRate: number;
  free(): void;
}

/** Bind the API to an Emscripten module factory (the entry files do this). */
export declare function bindTajweed(factory: (() => Promise<unknown>) | null, defaults?: { scoreOnly?: boolean }): typeof TajweedFormer;
