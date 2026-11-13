# @quran-lab/tajweedformer 3.1.1: API

The whole public surface. Every type is in [`web/index.d.ts`](../web/index.d.ts); a test keeps this page, the
type definitions and the package's exports in step. The names and the call order are the same in the Android,
Apple and C SDKs.

## Entry points

| Import | What |
| --- | --- |
| `@quran-lab/tajweedformer` | everything below |

## Call order

```js
import { TajweedClient } from '@quran-lab/tajweedformer';
const client = await TajweedClient.create({ key: 'qlk_v1_...' });
const model = await client.model();
const session = await model.listen({ endOnSilenceMs: 1500 });
for await (const chunk of session.chunks) console.log(chunk.decoded.text);
```

An app that owns its audio replaces `listen` with `const session = model.session({ sampleRate })` and
`session.push(samples)`.

## TajweedClient

One per page (per process in Node): `create` while another Client is open fails with `client_exists`.

| Member | |
| --- | --- |
| `TajweedClient.create(options)` | Promise of the Client. `options` is a `TajweedClientOptions`. Network trouble does not make it fail. |
| `client.model(version?)` | Promise of the `TajweedModel` for this app: downloads on first use, verifies, opens and warms the engine. `version` ("4.0.0") pins a model version. |
| `client.prefetch({ unmeteredOnly, onProgress, version })` | Download and verify ahead of use. `onProgress({ bytesDone, bytesTotal })`. Resolves with `{ bytesDone, bytesTotal, complete }`. With `unmeteredOnly` it waits on a `metered` connection and with `none`, and downloads on `unmetered` and `unknown` (see `connection` below). |
| `client.storage()` | Promise of `{ models: [{ version, build, bytes }], sharingQueueBytes }`. |
| `client.removeModels()` | Remove the model files (never the consent state or the sharing queue). |
| `client.diagnose()` | Promise of a `TajweedDiagnosis`. |
| `client.sharing` | A `TajweedSharing`. |
| `client.analytics` | A `TajweedAnalytics`: `reportChecks(rule, checked, flagged)`. |
| `client.pin` | `{ version, status }` when the server could not serve a pinned version, else null. |
| `client.background()`, `client.foreground()` | The app left or returned to the foreground. Automatic in browsers. |
| `client.close()` | Close the Client and its Model. |

`TajweedClientOptions`: `key` (required), `appId` (Node: the app id of a desktop key), `appVersion`, `storage`
(Node: a folder; browsers: a name for this client's stored state), `analytics` (`'on'` or `'off'`), `audience`
(`'general'` or `'children'`).

`TajweedDiagnosis`: `sdk` (`version`, `latest`), `key` (`accepted`: true, false or null while no answer was seen;
`reason`), `config` (`'fresh'`, `'stale'`, `'none'`), `model` (null, or `version`, `build`, `verified`),
`context` and `backend` (what a Session of the default context would run on now, with or without an open Model;
null when no model is on the device), `microphone` (`'granted'`, `'denied'`, `'notAsked'`, `'none'`),
`storage`, `lastError` (a code or null), `droppedChunks` (waiting chunks dropped because the app did not read
`chunks`, since the Client was made), `connection` (`'unmetered'`, `'metered'`, `'none'`, or `'unknown'` where the
runtime cannot tell: Node, a browser without the Network Information API such as Safari and Firefox, and a
browser that gives no connection type).

## TajweedModel

A Model comes from `client.model()`, and only from there (3.1.0): no call takes a model as a folder, a URL, a
reader or bytes, and the Client opens only a build it downloaded itself on this device. When an answer of
Quran Lab refuses the key or the app with one of the reasons `key_revoked`, `key_unknown`, `app_not_allowed`,
`origin_not_allowed`, `key_type_mismatch`, `app_blocked` or `developer_not_approved`, `client.model()` and
`client.prefetch()` fail with that refusal's error (`invalid_key` for a revoked or unknown key, else
`server_rejected`), also with the model on the device and at a later start without a network, until Quran Lab
accepts the key again. With the refusal the SDK removes the downloaded model from the browser (what
`removeModels()` removes); once the key is accepted again the model is downloaded again. An answer without one
of these reasons never does this. A Model that is already open when the refusal arrives keeps running until the
app closes it.

| Member | |
| --- | --- |
| `id`, `version`, `build` | `"v4.0"`, `"4.0.0"`, the build id (diagnostics only). |
| `contexts`, `defaultContext`, `chunkMs(context?)` | The context names, the one a Session uses by default, a context's chunk length in ms. |
| `tokens` | A `TajweedTokens`: `count`, `blank`, `wordBar`, `name(id)`, `id(name)`. |
| `calibration` | A `TajweedCalibration` or null: `format`, `sha256`, `text`, `json`, `contexts`, `classes`, `presets`, `context(name)`, `threshold(context, class, preset)`. Read-only data; never applied. |
| `reference` | A `TajweedReference` or null: `isDownloaded`, `fetch()`, `units(surah, ayah)` giving `{ units, words, wordCount }`. |
| `sampleClips` | A list of `TajweedClip`: `name`, `kind`, `durationMs`. |
| `backend` | The `TajweedBackend` the next Session will use. |
| `listen(options?)` | Promise of a `TajweedSession` fed by the microphone; with `from` (a clip, or a `Float32Array` with `sampleRate`) fed by that audio. |
| `session(options?)` | A `TajweedSession` the app pushes audio into. |
| `close()` | Release the engine. |

`TajweedSessionOptions`: `context`, `sampleRate` (pushed audio and `from` samples; default 16000), `heads` (names,
or `'all'`), `backend` (`'auto'` or `'cpu'`), `topK` (0 to 38), `endOnSilenceMs` (off: 0 or null; else 100 to
60000), `pace` (`'realTime'` or `'fast'`, with `from` only), `onChunk`, `onEvent`.

## TajweedSession

| Member | |
| --- | --- |
| `push(samples)` | Mono float samples at the Session's `sampleRate` (a Session made with `session()` only). |
| `chunks` | Async iterable of `TajweedChunk`; ends when the take ends. |
| `events` | Async iterable of `TajweedEvent`. |
| `finish()` | End the take. Promise of the take's `TajweedHeads`. Stops the microphone of a `listen` Session. |
| `cancel()` | End the take and keep nothing. |
| `backend` | The `TajweedBackend` in force. |
| `reportRecited(surah, ayahFrom, ayahTo)` | Where the learner recited (anonymous daily totals). |

`TajweedChunk`: `index`, `startMs`, `endMs`, `firstFrame`, `backend`, `speech`, `heads` (this chunk's
`TajweedHeads`), `decoded` (the `TajweedDecoded` of the take so far).

`TajweedDecoded`: `text`, `tokens` (`TajweedToken`: `id`, `name`, `firstMs`, `peakMs`, `lastMs`, `confidence`),
`words` (`TajweedWord`: `index`, `text`, `tokens`, `firstMs`, `lastMs`, `confidence`), `frames` (`TajweedFrame`:
`top1`, `top1LogProb`, `runnerUp`, `runnerUpLogProb`, `margin`, and `topK` when asked), `settled`, `isFinal`.

`TajweedEvent`, by `type`: `speechStarted` (`atMs`), `speechEnded` (`atMs`, `silenceMs`), `interrupted` (`cause`:
`'interruption'` or `'routeChange'`), `resumed`, `backendChanged` (`backend`, `fromChunk`; never raised on the
web), `ended` (`reason`: `'silence'`, `'background'`, `'hidden'`, `'interrupted'`, `'sourceEnd'`, `'limit'` (the take reached 20 minutes of audio), `'error'`; with
`error` for `'error'`).

## TajweedHeads

| Member | |
| --- | --- |
| `names` | The heads it holds. |
| `get(name)` | A `TajweedHead` (`name`, `kind`, `frameMs`, `frames`, `classes`, `values`) or null. |
| `greedy(name = 'log_probs')` | A CTC head's tokens: `id`, `firstMs`, `peakMs`, `lastMs`. |
| `decoded()` | The `TajweedDecoded` of exactly these Heads. |

Head names: `log_probs`, `inter1_log_probs`, `inter4_log_probs`, `id_log_probs`, `timing_log_probs`, `gem`,
`attr_tafkheem`, `attr_ghunna`, `attr_qalqalah`, `attr_face`, `boundary`, `conf`.

## TajweedBackend

`kind` (`'cpu'` or `'accelerator'`), `name`, `stage`, `reason`. On the web always
`{ kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null }`.

## TajweedSharing

`isAvailable`, `isOn`, `setOn(on)` (a promise: off resolves when every upload in flight is aborted and the
unsent queue is gone, within 3 s; a recording that waited then is never uploaded later), `ask()`, `feed(samples, sampleRate)`, `items()` (a promise), `summary()`,
`delete()` (a promise: accepted by Quran Lab it also turns sharing off; not taken, it rejects and nothing
changed; `isOn` does not change while Quran Lab is asked), `recoveryCode`, `setWording(overrides)`. The elements `QuranLabConsent` (`<quranlab-consent>`) and
`QuranLabSharingSettings` (`<quranlab-sharing-settings>`, set its `client`) are the SDK's sheets. The consent
sheet is a bottom sheet under 600 px wide and a centred card up to 480 px wide above that, with the same design
as on Apple and Android. The sheets take these CSS custom properties, on the element, on an ancestor or through
`theme`: `--ql-accent` (the share button, "Not now" and the icons; the tints are made from it), `--ql-accent-fg`
(the share button's label; by default white when white has 3 to 1 against the accent, else near-black), `--ql-bg`,
`--ql-fg`, `--ql-muted` (the hadith's reference), `--ql-radius` (the sheet's corners, 28px by default; the cards,
buttons and emblem follow it), `--ql-font` and `--ql-title-font` (font families). An accent under 3 to 1 against its tint gives "Not now" and the emblem's glyph the text colour, and under 3 to 1 against the card the icons too; under `prefers-contrast: more` that bar is 4.5 to 1. Light and dark follow
`prefers-color-scheme`. The page's other styles do not reach the sheets' type, and their sizes follow the
browser's text size. A theme never changes the words, hides a line or changes the consent version.

The learner's answer is stored per origin. When the device refuses to store it (a full quota), the page goes
by the answer in force and stores it with the next write. With two pages of one origin open: an off one page
holds unsaved stays in force there when the other page writes the stored answer, and is stored next; an on
held unsaved gives way to what is stored.

## TajweedAnalytics

`reportChecks(rule, checked, flagged)`: `rule` is lower-case letters, digits and underscores (at most 24, a
letter first); `0 <= flagged <= checked <= 100000`.

## Microphone

`Microphone.open()` (a promise), `sampleRate`, `samples()` (async iterable of `Float32Array` blocks), `close()`.

## TajweedError

`code`, `message`, `fix`, `docs`. Codes: `invalid_argument`, `invalid_key`, `sdk_too_old`, `server_rejected`,
`client_exists`, `model_unavailable`, `needs_connection`, `network_not_permitted`, `download_failed`,
`storage_full`, `storage_failed`, `model_missing`, `model_invalid`, `signature_invalid`, `checksum_mismatch`,
`model_incompatible`, `reference_missing`, `session_open`, `session_closed`, `cancelled`, `engine_failed`,
`microphone_denied`, `microphone_unavailable`, `interrupted`, `sharing_unavailable`, `runtime_unsupported`.

A refusal of the server is `server_rejected`, and its `message` and `fix` say what to do for the server's reason
(the account has no access yet, the key is of another type or environment, the key belongs to another app, the
page's origin is not on the key, a production key on a local address, the app is blocked or paused, a model
request this install may not make). A page whose origin is not on its key
gets no answer from the API at all; the SDK then asks Quran Lab's origin check once per page load and raises
that refusal instead of `needs_connection`. `runtime_unsupported` is a browser or a Node without something the
SDK needs (its `message` names it). `network_not_permitted` is in the shared catalogue for the other SDKs; the
web SDK does not raise it.
