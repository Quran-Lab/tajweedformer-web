# @quran-lab/tajweedformer 4.0.2: API

Every public name of the package, generated from [`web/index.d.ts`](../web/index.d.ts) by
`scripts/make_api_doc.mjs`: do not edit this page by hand. In a browser the hosted loader
(`https://web.quranlab.ai/4/loader.js`) puts the same names on `globalThis.QuranLab`; the npm package hands out the
same classes, and in Node its `node` entry runs them with a desktop key and its app id. The names and the call order
are the same in the Android, Apple and C SDKs.

> Type definitions for @quran-lab/tajweedformer 4.0.2 (web API 4): the whole public surface, and nothing else. The package is a thin wrapper that loads Quran Lab's hosted loader; the same names are on globalThis.QuranLab. Five concepts: Client, Model, Session, Heads, Backend. Call order: Client, model, listen, read.

## Call order

```js
const client = await QuranLab.TajweedClient.create({ key: 'qlk_v1_...' });   // or import { TajweedClient } from '@quran-lab/tajweedformer'
const model = await client.model();
const session = await model.listen({ endOnSilenceMs: 1500 });
for await (const chunk of session.chunks) console.log(chunk.decoded.text);
```

An app that owns its audio replaces `listen` with `model.session({ sampleRate })` and `session.push(samples)`.
There is no `analytics` option in 4.0: the anonymous analytics are always on, and `create()` refuses an `analytics`
key, whatever its value, with `invalid_argument` (see [migrating-to-4.md](migrating-to-4.md)). There is no `audience`
option either: every app shows the same sharing sheet, and `create()` refuses an `audience` key the same way.

## Contents

- [`LOADER_URL`](#loader_url) (constant)
- [`API`](#api) (constant)
- [`loadQuranLab`](#loadquranlab) (function)
- [`TajweedError`](#tajweederror) (class)
- [`TajweedErrorCause`](#tajweederrorcause) (interface)
- [`TajweedErrorCode`](#tajweederrorcode) (type)
- [`TajweedClientOptions`](#tajweedclientoptions) (interface)
- [`TajweedClient`](#tajweedclient) (class)
- [`TajweedAnalytics`](#tajweedanalytics) (interface)
- [`TajweedDiagnosis`](#tajweeddiagnosis) (interface)
- [`TajweedSharing`](#tajweedsharing) (interface)
- [`TajweedBackend`](#tajweedbackend) (interface)
- [`TajweedTokens`](#tajweedtokens) (interface)
- [`TajweedCalibration`](#tajweedcalibration) (interface)
- [`TajweedReference`](#tajweedreference) (interface)
- [`TajweedClip`](#tajweedclip) (interface)
- [`TajweedSessionOptions`](#tajweedsessionoptions) (interface)
- [`TajweedModel`](#tajweedmodel) (class)
- [`TajweedSession`](#tajweedsession) (class)
- [`RecitedOutcome`](#recitedoutcome) (type)
- [`TajweedChunk`](#tajweedchunk) (interface)
- [`TajweedEvent`](#tajweedevent) (type)
- [`TajweedDecoded`](#tajweeddecoded) (interface)
- [`TajweedToken`](#tajweedtoken) (interface)
- [`TajweedWord`](#tajweedword) (interface)
- [`TajweedFrame`](#tajweedframe) (interface)
- [`TajweedHead`](#tajweedhead) (interface)
- [`TajweedHeads`](#tajweedheads) (class)
- [`Microphone`](#microphone) (class)

## LOADER_URL

The hosted loader's URL for API 4.

```ts
export declare const LOADER_URL: string
```

## API

The API number of this package and of the loader it loads.

```ts
export declare const API: 4
```

## loadQuranLab

Load the hosted loader (once): an explicit URL and its SRI hash when the site pins one.

```ts
export declare function loadQuranLab(options?: { src?: string; integrity?: string }): Promise<unknown>
```

## TajweedError

Every failure the SDK raises. `code` is stable and the same in every TajweedFormer SDK.

```ts
export declare class TajweedError extends Error
```

- `readonly code: TajweedErrorCode`: One of the catalogue's codes, for example "needs_connection" or "microphone_denied".
- `readonly fix: string`: One sentence a developer can act on.
- `readonly docs: string`: https://sdk.quranlab.ai/docs/errors#<code>
- `readonly errorCause?: TajweedErrorCause`: 4.0.2: where the failure was and why, in short tokens an app can log, match on and send in a support request (never a message, a URL or an identifier). A frozen object, or undefined for the codes that only say the app used the API wrongly (invalid_argument, client_exists, session_open, session_closed, cancelled). The platform's own `cause` keeps the underlying error.

## TajweedErrorCause

4.0.2: the cause on a TajweedError (`error.errorCause`). Every field is a token; the optional ones are there when known.

```ts
export interface TajweedErrorCause
```

- `readonly stage: 'config' | 'register' | 'attest' | 'lease' | 'manifest' | 'download' | 'verify' | 'storage' | 'runtime' | 'model_open' | 'accelerator' | 'audio' | 'session' | 'sharing' | 'events'`: Where the failure was.
- `readonly reason: string`: Why, for that stage: for example 'network' (no answer at all), 'http', 'rate_limited', 'refused', 'quota', 'permission_denied', 'wasm_compile', 'memory'; 'other' when none fits. New reasons may be added.
- `readonly httpStatus?: number`: The HTTP status of the answer that failed, when there was one.
- `readonly errorName?: string`: The platform error's class, for example 'QuotaExceededError', 'NotAllowedError' or 'CompileError'.
- `readonly errorCode?: string`: The error's code, for example the server's error token ('model_limit', 'app_blocked').
- `readonly needs?: 'model' | 'lease'`: On needs_connection only: 'model' when the model files are not on the device yet (connect to download), 'lease' when the model is on the device and needs Quran Lab's answer to open (connect to continue).

## TajweedErrorCode

```ts
type TajweedErrorCode =
  | 'invalid_argument' | 'invalid_key' | 'sdk_too_old' | 'server_rejected' | 'client_exists' | 'needs_connection' | 'network_not_permitted'
  | 'download_failed' | 'storage_full' | 'storage_failed' | 'model_missing' | 'model_invalid' | 'signature_invalid'
  | 'checksum_mismatch' | 'model_incompatible' | 'model_unavailable' | 'reference_missing' | 'session_open' | 'session_closed' | 'cancelled'
  | 'engine_failed' | 'microphone_denied' | 'microphone_unavailable' | 'interrupted' | 'sharing_unavailable' | 'runtime_unsupported'
```

## TajweedClientOptions

The options of TajweedClient.create(). There is no analytics option in 4.0: the anonymous analytics are always on, and an `analytics` key, whatever its value, is refused with invalid_argument. There is no audience option either: every app shows the same sharing sheet, and an `audience` key, whatever its value, is refused with invalid_argument.

```ts
export interface TajweedClientOptions
```

- `key: string`: The developer key, qlk_v1_..., from sdk.quranlab.ai (a web key in browsers, a desktop key in Node).
- `appVersion?: string`: The app's version (from 4.0.1 the config request carries it, cleaned: ASCII letters, digits, dots, plus and minus, at most 32).
- `appBuild?: string`: The app's build number, a string (4.0.1): the config request carries it, cleaned as appVersion; anything but a string is invalid_argument.
- `appId?: string`: Node only (a desktop key): the app id you gave that key at sdk.quranlab.ai. Required in Node.
- `storage?: string`: In a browser: a name that separates this client's stored state (letters, digits, dot, dash, underscore; at most 40). In Node: the storage folder (default: the OS cache folder, then quranlab/tajweedformer/<appId>).
- `threads?: 'auto' | 'off'`: 'off' (default): one thread. 'auto': the threads engine when this page is cross-origin isolated and the device has 4 or more cores.

## TajweedClient

The app's link to Quran Lab. One per process (per page): a second one while the first is open is client_exists.

```ts
export declare class TajweedClient
```

- `static create(options: TajweedClientOptions): Promise<TajweedClient>`
- `model(version?: string | { version?: string }): Promise<TajweedModel>`: The Model for this app: downloads on first use, verifies, opens and warms the engine. `version` pins a model version.
- `prefetch(options?: { onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void; version?: string }): Promise<{ bytesDone: number; bytesTotal: number; complete: boolean }>`: Download and verify the model ahead of use: resumable, a no-op when done. It downloads on whatever network the device has; there is no option to wait for Wi-Fi (4.0.2). Each model file is one request for the whole file; a cut download goes on from its last byte with one more request (4.0.2).
- `storage(): Promise<{ models: { version: string; build: string; bytes: number }[]; sharingQueueBytes: number }>`: What the SDK holds on this device, in bytes.
- `removeModels(): Promise<void>`: Remove the model files of this site (ciphertext only is ever stored).
- `diagnose(): Promise<TajweedDiagnosis>`: One structured report, safe to paste into an issue.
- `readonly sharing: TajweedSharing`
- `readonly analytics: TajweedAnalytics`
- `readonly pin: { version: string; status: string } | null`: The answer to a pinned model version the server could not serve, or null.
- `background(): Promise<void>`: The app left the foreground. Automatic in browsers; a call in Node.
- `foreground(): void`: The app returned to the foreground. Automatic in browsers; a call in Node.
- `close(): Promise<void>`

## TajweedAnalytics

```ts
export interface TajweedAnalytics
```

- `reportChecks(rule: string, checked: number, flagged: number): void`: The app's own judge checked `rule` `checked` times and flagged `flagged` of them (anonymous daily totals).

## TajweedDiagnosis

```ts
export interface TajweedDiagnosis
```

- `sdk: { version: string; latest: string | null }`
- `key: { accepted: boolean | null; reason: 'invalid_key' | 'sdk_too_old' | 'server_rejected' | null }`: accepted: null while no answer from Quran Lab was seen (offline).
- `config: 'fresh' | 'stale' | 'none'`
- `model: { version: string; build: string; verified: boolean } | null`: The open model (verified), or the one last used on this device; null when there is none.
- `context: string | null`
- `backend: TajweedBackend | null`
- `microphone: 'granted' | 'denied' | 'notAsked' | 'none'`
- `storage: { models: { version: string; build: string; bytes: number }[]; sharingQueueBytes: number }`
- `lastError: TajweedErrorCode | null`: The code of the last TajweedError, or null.
- `droppedChunks: number`: Waiting chunks dropped because the app did not read `chunks` (at most 256 wait), since the Client was made.
- `connection: 'unmetered' | 'metered' | 'none' | 'unknown'`: The connection as far as the runtime can tell; 'unknown' in Node and where the browser has no Network Information API. Reported only: no download or upload waits for, or is held by, the kind of network.
- `endpoints?: { api: string; models: string; webFrame?: string; lastFailover: { role: 'api' | 'models' | 'web_frame'; from: string; to: string | null; reason: string; status: number | null; at: number } | null; }`: 4.0.1: the servers in use: the API and model servers asked first, the frame's server (the engine's in Node), and the last request whose first server could not be reached, or null.

## TajweedSharing

Recitation sharing: every learner is asked, under the SDK's rules, and the choice is theirs: "Not now", and turning sharing off or deleting what they shared at any time.

```ts
export interface TajweedSharing
```

- `readonly isAvailable: boolean`: Sharing can be offered now: false in Node, on a platform where it is not offered yet, and while Quran Lab has paused it for everyone (its global incident switch in the signed config). Never a decision about one app.
- `readonly isOn: boolean`: The learner said yes.
- `setOn(on: boolean): Promise<void>`: The settings switch. Off starts no upload request from the call on, aborts the one in flight (what the browser or the system had already buffered of that segment may still go out) and deletes the unsent queue. Off: the promise resolves when the uploads in flight are aborted and the unsent queue is gone.
- `ask(): Promise<{ yes: boolean } | null>`: Ask at the app's own moment: only when an ask is due by the SDK's rules (the first not right after the install and after a few completed takes, a re-ask card only much later; three at most; never again after a yes), never before a completed take of this visit and never during a take. Resolves with the learner's answer, or null when no ask is due (nothing is shown).
- `feed(samples: Float32Array, sampleRate: number): void`: Audio the app already captures outside takes: used for the lead-in and tail of shared recordings only.
- `items(): Promise<Array<{ id: string; status: string; [key: string]: unknown }>>`: The outbox: each recording's status.
- `summary(): Promise<{ you: { sessions: number; minutes: number }; app: { contributors: number; minutes: number } | null; all: { contributors: number; minutes: number } } | null>`: The learner's summary (the gratitude line), or null.
- `delete(): Promise<unknown>`: "Delete what I shared".
- `readonly recoveryCode: string | null`: The code for deletion when the device is lost; null before the first shared recording.
- `setWording(overrides: Record<string, string> | null): { version: string; textSha256: string | null; canonicalText: string | null }`: The app's own wording ({ deck key: text }); null goes back to the SDK's wording.

## TajweedBackend

What ran or will run the model. On the web always the CPU engine in WebAssembly.

```ts
export interface TajweedBackend
```

- `kind: 'cpu' | 'accelerator'`
- `name: string`
- `stage: 'cpu' | 'downloading' | 'compiling' | 'testing' | 'promoted' | 'demoted'`
- `reason: string | null`

## TajweedTokens

The vocabulary of the model.

```ts
export interface TajweedTokens
```

- `readonly count: number`
- `readonly blank: number`
- `readonly wordBar: number`
- `name(id: number): string | null`
- `id(name: string): number | null`

## TajweedCalibration

calibration.json as shipped: read-only data for a developer's own judge. The SDK never applies it.

```ts
export interface TajweedCalibration
```

- `readonly format: string | null`
- `readonly sha256: string`
- `readonly text: string`: The file's exact text.
- `readonly json: Readonly<Record<string, unknown>>`: The file parsed, frozen.
- `readonly contexts: readonly string[]`
- `readonly classes: readonly string[]`
- `readonly presets: readonly string[]`
- `context(name: string): Readonly<Record<string, unknown>> | null`
- `threshold(context: string, cls: string, preset: string): number | null`: The threshold of a site class at a preset in a context (nats on the fused LLR), or null.

## TajweedReference

The expected units of each ayah: read-only data, downloaded only when the app asks.

```ts
export interface TajweedReference
```

- `readonly isDownloaded: boolean`
- `fetch(): Promise<void>`: Download and verify the table, once.
- `units(surah: number, ayah: number): Promise<{ units: number[]; words: number[]; wordCount: number }>`: The unit ids of an ayah in reading order (the word bar between words included), each unit's word, the word count.

## TajweedClip

A sample clip of the model (its self-test set).

```ts
export interface TajweedClip
```

- `readonly name: string`
- `readonly kind: string`
- `readonly durationMs: number`

## TajweedSessionOptions

```ts
export interface TajweedSessionOptions
```

- `context?: string`: Default: the config's inference.context, then the manifest's default.
- `sampleRate?: number`: For pushed audio only (default 16000); listen sets it from the microphone or the clip.
- `heads?: string[] | 'all'`: Head names, or 'all'. Default: log_probs, inter1_log_probs, timing_log_probs, gem, attr_qalqalah, conf.
- `backend?: 'auto' | 'cpu'`
- `topK?: number`: Rank this many tokens in every decoded frame (default 0).
- `endOnSilenceMs?: number`: When set, the take finishes after that much silence following speech.
- `pace?: 'realTime' | 'fast'`: listen({ from }) only: 'realTime' (default) or 'fast'.
- `onChunk?: (chunk: TajweedChunk) => void`
- `onEvent?: (event: TajweedEvent) => void`

## TajweedModel

One verified model build on this device, from `client.model()`. Holds the engine (in a Worker in browsers).

```ts
export declare class TajweedModel
```

- `readonly id: string`
- `readonly version: string`
- `readonly build: string`: The build id, for diagnostics only.
- `readonly contexts: readonly string[]`
- `readonly defaultContext: string`
- `chunkMs(context?: string): number`
- `readonly tokens: TajweedTokens`
- `readonly calibration: TajweedCalibration | null`
- `readonly reference: TajweedReference | null`
- `readonly sampleClips: readonly TajweedClip[]`
- `readonly backend: TajweedBackend`
- `listen(options?: TajweedSessionOptions & { from?: TajweedClip | Float32Array }): Promise<TajweedSession>`: A Session fed by the microphone (asks for the permission), or by a clip or samples with `from`.
- `session(options?: TajweedSessionOptions): TajweedSession`: A Session the app pushes audio into.
- `close(): Promise<void>`

## TajweedSession

One take: audio in, chunks and events out, the take's Heads at the end.

```ts
export declare class TajweedSession
```

- `push(samples: Float32Array): void`: Mono float samples at the Session's sampleRate (only on a Session made with model.session()).
- `readonly chunks: AsyncIterable<TajweedChunk>`
- `readonly events: AsyncIterable<TajweedEvent>`
- `finish(): Promise<TajweedHeads>`: End the take; the take's Heads. On a listen Session it also stops the microphone.
- `cancel(): Promise<void>`: End the take and keep nothing.
- `readonly backend: TajweedBackend`
- `reportRecited(surah: number, ayahFrom: number, ayahTo: number, options?: { outcome?: RecitedOutcome; perAyah?: Record<number, RecitedOutcome> }): void`: Where the learner recited in this take, used only where the SDK could not measure it itself, and optionally how the app judged it (anonymous daily totals; a take is never counted twice). One report per take, until the next take starts.

## RecitedOutcome

The app's own judgement of an ayah: correct, or incorrect with how many mistakes and which rule ids.

```ts
export type RecitedOutcome = { correct: true } | { correct: false; mistakes?: number; rules?: string[] }
```

## TajweedChunk

```ts
export interface TajweedChunk
```

- `index: number`
- `startMs: number`
- `endMs: number`
- `firstFrame: number`
- `backend: TajweedBackend`
- `speech: boolean`: The chunk holds speech frames.
- `heads: TajweedHeads`: The Heads of this chunk only.
- `readonly decoded: TajweedDecoded`: The decoded layer of the take so far.

## TajweedEvent

```ts
export type TajweedEvent =
  | { type: 'speechStarted'; atMs: number }
  | { type: 'speechEnded'; atMs: number; silenceMs: number }
  | { type: 'interrupted'; cause: 'interruption' | 'routeChange' }
  | { type: 'resumed' }
  | { type: 'backendChanged'; backend: TajweedBackend; fromChunk: number }
  | { type: 'ended'; reason: 'silence' | 'background' | 'hidden' | 'interrupted' | 'sourceEnd' | 'limit' | 'error'; error?: TajweedError }
```

## TajweedDecoded

```ts
export interface TajweedDecoded
```

- `text: string`
- `tokens: TajweedToken[]`
- `words: TajweedWord[]`
- `frames: TajweedFrame[]`
- `settled: number`: The count of leading tokens that will not change in this take.
- `isFinal: boolean`: True on the last decoded layer of the take.

## TajweedToken

```ts
export interface TajweedToken
```

- `id: number`
- `name: string`
- `firstMs: number`
- `peakMs: number`
- `lastMs: number`
- `confidence: number | null`: 0 to 1 from the conf head; null when the take did not compute it.

## TajweedWord

```ts
export interface TajweedWord
```

- `index: number`
- `text: string`
- `tokens: TajweedToken[]`
- `firstMs: number`
- `lastMs: number`
- `confidence: number | null`

## TajweedFrame

```ts
export interface TajweedFrame
```

- `top1: number`
- `top1LogProb: number`
- `runnerUp: number`
- `runnerUpLogProb: number`
- `margin: number`
- `topK?: Array<{ id: number; name: string; logProb: number; margin: number }>`: With the topK option: the best tokens of the frame, ranked.

## TajweedHead

```ts
export interface TajweedHead
```

- `name: string`
- `kind: 'ctc' | 'attribute'`
- `frameMs: number`: 40 or 20.
- `frames: number`
- `classes: number`
- `values: Float32Array`: [frames x classes], row major: log-probs for a ctc head, probabilities (or one logit) for an attribute head.

## TajweedHeads

Raw model output for a span of audio (a chunk or a whole take).

```ts
export declare class TajweedHeads
```

- `readonly names: string[]`
- `get(name: string): TajweedHead | null`
- `greedy(name?: string): Array<{ id: number; firstMs: number; peakMs: number; lastMs: number }>`: Greedy tokens of a CTC head (collapsed, blank removed).
- `decoded(): TajweedDecoded`: The decoded layer of exactly these Heads.

## Microphone

The SDK's optional microphone, for apps that want samples only (browsers).

```ts
export declare class Microphone
```

- `static open(): Promise<Microphone>`: Ask for the microphone and open it: microphone_denied when refused, microphone_unavailable when there is none.
- `readonly sampleRate: number`: The rate of the samples: the device's.
- `samples(): AsyncIterable<Float32Array>`: Mono float samples, block by block, until close().
- `close(): void`
