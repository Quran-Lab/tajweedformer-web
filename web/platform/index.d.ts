// Types for @quran-lab/tajweedformer/platform: the Quran Lab platform client.

export declare const SDK_VERSION: '2.0.0';
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
  /** recitation sharing (the SDK asks the learner first; see @quran-lab/tajweedformer/consent) */
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
}

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
  register(): Promise<{ ok: boolean; app_id: string; store_status: string }>;
  refreshConfig(): Promise<SignedConfig | null>;
  /** refresh every ms (60 s) while the app is in use */
  startRefresh(ms?: number): void;
  stopRefresh(): void;
  modelSource(): Promise<{ url: string; headers: Record<string, string> }>;
  flush(): Promise<number>;
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
  /** completed days as wire payloads (v2) */
  pending(): object[];
  clear(): void;
}
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
