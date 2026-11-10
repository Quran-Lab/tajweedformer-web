// Types for @quran-lab/tajweedformer/platform: the Quran Lab platform client.

export declare const SDK_VERSION: '2.0.1';
export declare const API_URL: string;
export declare const CDN_URL: string;

/** Persistence for small JSON state. */
export interface StateStore { kind: string; get(key: string): any; set(key: string, value: unknown): void }
export declare function memoryState(): StateStore;
/** localStorage (per origin), falling back to memory. */
export declare function localState(prefix?: string): StateStore;
/** Node: a directory of JSON files (0600). */
export declare function dirState(dir: string): Promise<StateStore>;

export declare class PlatformError extends Error { readonly status: number; readonly code: string }

export interface SignedConfig {
  v: 1; app: string; channel: string; issued_at: number; expires_at: number;
  models: Record<string, { revision: string; source: string; model_id?: string; folder?: string }>;
  recommended: { model: string; model_id: string; folder: string; revision: string; source: string } | null;
  denylist: Record<string, string>[];
  flags: { analytics?: boolean; issues?: boolean; contributions?: boolean; upload_trust?: Record<string, 'off' | 'capped' | 'attested'>; [k: string]: unknown };
  tajweed?: unknown;
  /** where model files are served (qlab-api signs it): {base}/{model}/{revision}/{folder}/ */
  base?: string;
  /** the newest SDK for this platform (2.0.1); other unknown fields are ignored too */
  sdk_latest?: { version: string; severity: string; url: string };
}

export interface QuranLabOptions {
  /** the developer key qlk_v1_... (a web key in browsers, origin-locked; a desktop key from Node) */
  key: string;
  appVersion?: string;
  appName?: string;
  /** 'web' in browsers; in Node 'web' (with origin), 'linux' or 'windows' */
  platform?: 'web' | 'linux' | 'windows';
  /** web: the page's origin (default location.origin); desktop: the reverse-DNS or package id */
  bundleId?: string;
  /** Node with a web key: the Origin header to send */
  origin?: string;
  /** telemetry: on by default, anonymous; 'off' is the one developer opt-out (never a prompt) */
  analytics?: 'on' | 'off';
  issues?: boolean;
  /** @deprecated ignored since 2.0.1: Quran Lab decides per app whether the sharing sheet is offered (signed
   * config, flags.contributions); the SDK still asks the learner before anything is recorded for upload */
  contributions?: boolean;
  audience?: 'general' | 'children';
  state?: StateStore;
  /** pinned Ed25519 config keys (default: Quran Lab's) */
  trustedKeys?: (string | Uint8Array)[];
  apiUrl?: string;
  /** model files: default the signed config's base, else https://cdn.quranlab.ai/models */
  modelsUrl?: string;
  /** given alone (no modelsUrl): model files from the old {cdnUrl}/hf/ path */
  cdnUrl?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  /** a development build: logs "Quran Lab SDK X is available" once per launch when the signed config's sdk_latest is
   * newer (default: process.env.NODE_ENV !== 'production' where it resolves; a plain browser page stays silent) */
  debug?: boolean;
  /** telemetry deltas on the SDK's schedule (default true): every 15 minutes while visible, when hidden or left */
  autoSend?: boolean;
  /** where visibilitychange and pagehide come from (default the page's document and window) */
  lifecycle?: { document?: EventTarget & { visibilityState?: string }; window?: EventTarget | null };
}
export declare const DELTA_INTERVAL_MS: number;
/** -1, 0 or 1 for dotted numeric versions; null for a pre-release or junk */
export declare function compareVersions(a: string, b: string): -1 | 0 | 1 | null;
/** the signed config's sdk_latest when well formed, else null */
export declare function sdkLatestOf(cfg: unknown): { version: string; severity: string; url: string } | null;
export declare function isDevelopment(debug?: boolean): boolean;
export declare function noticeSdkLatest(cfg: unknown, current: string, o?: { debug?: boolean; warn?: (m: string) => void }): boolean;
export declare function resetSdkLatestNoticeForTests(): void;

export declare class QuranLab {
  constructor(o: QuranLabOptions);
  /** configure and run the launch sequence (token, register, config, pending telemetry and issues);
   * never throws for network trouble */
  static configure(o: QuranLabOptions): Promise<QuranLab>;
  readonly config: SignedConfig | null;
  readonly flags: SignedConfig['flags'];
  /** the error-table code that stopped the network for this launch, or null */
  readonly stopped: string | null;
  readonly lastError?: Error;
  readonly telemetry: Telemetry;
  token(): Promise<string>;
  launch(): Promise<void>;
  /** at most once per UTC day per install; null when this install already registered today */
  register(): Promise<{ ok: boolean; app_id: string; store_status: string } | null>;
  /** the app came back to the foreground: a launch counted, register on a new day */
  foreground(): void;
  /** the app goes to the background: the delta sealed and sent (keepalive) */
  background(): Promise<number>;
  /** a send point: seal the delta and send the reports due */
  sendTelemetry(reason?: string, o?: { keepalive?: boolean }): Promise<number>;
  stopSchedule(): void;
  refreshConfig(): Promise<SignedConfig | null>;
  /** refresh every ms (60 s) while the app is in use */
  startRefresh(ms?: number): void;
  stopRefresh(): void;
  modelSource(): Promise<{ url: string; headers: Record<string, string> }>;
  flush(o?: { keepalive?: boolean }): Promise<number>;
  reportIssue(kind: string, code: string, frames?: string[]): boolean;
  contributor(): string;
  resetContributor(): void;
  contributionSummary(): Promise<{ you: { sessions: number; minutes: number }; app: { contributors: number; minutes: number } | null;
    all: { contributors: number; minutes: number } } | null>;
  sharingAllowed(): boolean;
}

export declare function verifySignedConfig(body: Uint8Array, signatureHeader: string | null, keyId: string | null,
  trustedKeys: (string | Uint8Array)[], now?: number): Promise<SignedConfig>;
export declare function keyId(rawPublicKey: string | Uint8Array): Promise<string>;

export declare class Telemetry {
  enabled: boolean;
  /** +n on a 2.0.1 counter: launches, ayahs, words, share_asked, share_yes, share_no */
  count(field: string, n?: number): void;
  /** seal what was counted since the last send point (one report per UTC day, a fresh report_id each) */
  seal(): number;
  /** the sealed reports not yet accepted, oldest first, with the exact bytes sent */
  reports(): { report_id: string; day: string; body: string; attempts: number; next: number }[];
  /** the sealed reports as payloads (v2 with the 2.0.1 fields) */
  pending(): object[];
  clear(): void;
}
export declare const COUNTERS: readonly string[];
export declare function newReportId(): string;
export declare function bucket(kind: string, value: number): string;
export declare function utcDay(t?: number): string;
export declare function deviceInfo(): { class: string; soc?: string; os_major: number; ram_tier?: string };

export interface ContributorKey {
  contributor: string;
  /** always false: the private half never leaves WebCrypto */
  extractable: false;
  publicKeyRaw: Uint8Array;
  publicKeySpki: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export declare function contributorKey(contributor: string, opts?: { create?: boolean }): Promise<ContributorKey | null>;
export declare function forgetContributorKey(contributor: string): Promise<void>;
export declare function recoveryCodeFromBytes(bytes: Uint8Array): string;
export declare function normaliseRecoveryCode(code: string): string;
export declare function recoveryHash(code: string): Promise<string>;
export declare function newRecoveryCode(): string;
export declare function deletionMessage(m: { app: string; contributor: string; nonce: string; timestamp: number }): Uint8Array;
export declare function b64url(bytes: Uint8Array): string;
