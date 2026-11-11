# TajweedFormer for the web: reference for coding assistants

Everything an assistant needs to integrate this SDK correctly: use only the names, calls and settings shown here or in the installed version's sources. People: the short version is in [README.md](README.md).

## What you get

<table>
<tr>
<td width="33%" valign="top">

**Hears the recitation**<br>Streaming recognition of Quranic recitation: audio in, and what the model heard comes out as often as every 160 ms (320 ms by default, 480 ms for longer context).

</td>
<td width="33%" valign="top">

**Every output of the model**<br>The sounds it heard with confidence and timing, and every head of the network per chunk (lengthening, gemination, ghunna, qalqalah and more): yours to build on.

</td>
<td width="33%" valign="top">

**Runs where the web runs**<br>WebAssembly with SIMD128, for browsers and Node. One npm package; the model is cached after the first visit.

</td>
</tr>
<tr>
<td valign="top">

**Private by default**<br>It listens in the learner's browser, not on a server. A recording leaves it only when the learner agrees to share it.

</td>
<td valign="top">

**Nothing to host**<br>The SDK downloads the model (56.5 MB) from our CDN in six regions, verifies it and keeps it up to date.

</td>
<td valign="top">

**Data for your own judge**<br>The SDK scores nothing. The model's thresholds and the expected units of each ayah come with it as read-only data, so your app can judge a recitation its own way.

</td>
</tr>
</table>

## Why TajweedFormer

- **Made for the Quran.** Trained on Quranic recitation, with its own sound units and heads for what tajweed is about.
- **Feedback in the moment.** Output streams while the learner recites, so your app can respond on the word itself, not after the take.
- **One engine on every platform.** The same engine runs the [web](https://github.com/Quran-Lab/tajweedformer-web), [Android](https://github.com/Quran-Lab/tajweedformer-android), [iOS and macOS](https://github.com/Quran-Lab/tajweedformer-apple) and [Windows and Linux](https://github.com/Quran-Lab/tajweedformer-c) SDKs, all set from one portal.
- **Free, and it stays free.** Quran Lab is a non-profit waqf: the SDKs and models are never sold. The licence, NPL-1.2, asks three things: no paywall on model features, no results presented as rulings, and show the notice.

## Built for AI developers

Copy the setup prompt from [sdk.quranlab.ai](https://sdk.quranlab.ai) and paste it into your coding assistant. That one prompt sets everything up: the package, your key, and the first calls. [AGENTS.md](AGENTS.md), beside this README, gives the assistant the complete API, so the code it writes uses names that exist. Prefer to do it by hand? Get a key in the portal and start below.

## At a glance

- **What it is:** the npm package `@quran-lab/tajweedformer`. It runs TajweedFormer V4
  (Quran-Lab/tajweedformer-v4, served by cdn.quranlab.ai/models) on the
  [tajweedformer-engine](https://github.com/Quran-Lab/tajweedformer-engine) engine compiled to WebAssembly
  (SIMD128, no ONNX Runtime), bit for bit the same as the engine on every other platform.
- **A pure inference SDK.** Audio in, the model's output out: every head of the network per chunk, what
  the model heard (tokens with times and confidence, words, top-1 and runner-up per frame), and when the
  learner spoke. It does not judge a recitation: there is no scorer, no settings and no verdicts in 3.0
  (see [docs/migrating-to-3.md](docs/migrating-to-3.md)). The calibration and the expected units of each
  ayah ship as read-only data for your own judge.
- **Five concepts, the same in every TajweedFormer SDK:** a Client (your link to Quran Lab), a Model, a
  Session (one take), Heads (raw output) and a Backend. Call order: Client, model, listen, read.
- **Linked to [sdk.quranlab.ai](https://sdk.quranlab.ai):** a web key, the signed config (which model
  build your app gets, the response time), anonymous daily telemetry, issue reports, and opt-in
  recitation sharing with the SDK's own consent sheet.
- **Version:** 3.0.0, on npm as `@quran-lab/tajweedformer`. What has run where: the test suite on every push
  (Linux, with the engine and libopus built there), and, with a real model folder that a public runner does
  not have, the 35 conformance clips bit for bit in Node and in Chrome (`npm run proof`).

## The TajweedFormer SDKs

One model, one engine, the same bits on every platform. Each SDK compiles the same engine source
(Quran-Lab/tajweedformer-engine, pinned as a submodule), so no platform can drift from the others.

| Repository | What it is | Platforms | Install |
| - | - | - | - |
| [tajweedformer-android](https://github.com/Quran-Lab/tajweedformer-android) | Kotlin SDK (AAR) | Android 8.0+ on arm64-v8a and armeabi-v7a, desktop JVM | Maven Central `ai.quranlab:tajweedformer:3.0.0` |
| [tajweedformer-apple](https://github.com/Quran-Lab/tajweedformer-apple) | Swift SDK: Neural Engine (CoreML) with the exact CPU engine as fallback | iOS 15+, macOS 12+, Apple silicon | SwiftPM, `from: "3.0.0"`, product `TajweedFormer` |
| [tajweedformer-web](https://github.com/Quran-Lab/tajweedformer-web) | WebAssembly SDK with SIMD128 | Browsers, Node 20+ | `npm install @quran-lab/tajweedformer` |
| [tajweedformer-c](https://github.com/Quran-Lab/tajweedformer-c) | C API and server runner with x86 int8 kernels (AVX2, AVX-VNNI, AVX-512 VNNI) | Windows, Linux (x86-64) | CMake `FetchContent`, tag 3.0.0 |
| [tajweedformer-engine](https://github.com/Quran-Lab/tajweedformer-engine) | The engine: exact C runtime, inference library, conformance suite | everything above | Git submodule |

The model is Quran-Lab/tajweedformer-v4 (`sdk/v4.0`), hosted by Quran Lab and served by
`cdn.quranlab.ai/models` to app keys from [sdk.quranlab.ai](https://sdk.quranlab.ai).
SDK 2.x runs V4 only.
[sdk.quranlab.ai](https://sdk.quranlab.ai) is where you create an app, get its developer key,
choose which model revision your users get, and, for SDK 2.x scoring, set the tajweed checks (presets,
per-class thresholds) your users see, without shipping a new build.

## Install

```sh
npm install @quran-lab/tajweedformer
```

With a bundler (Vite, webpack and the like) the import in the quick start resolves as it is written. Without one, import the same module by URL: `https://cdn.jsdelivr.net/npm/@quran-lab/tajweedformer@3.0.0/web/index.js`. The package has one entry point; in Node, `@quran-lab/tajweedformer/node` adds the reader for a model folder on disk.

## Before you start

| | |
| - | - |
| **Key** | A web key from [sdk.quranlab.ai](https://sdk.quranlab.ai), locked to your site's origins. For local work (`vite dev`) use the app's development key, with `http://localhost:*` among its origins; a production key does not work on a local address. |
| **Page** | A secure context: `https`, or `http://localhost`. A browser gives the microphone and WebCrypto to nothing else, and starts audio only after a tap or a click. |
| **Browser** | WebAssembly with SIMD, AudioWorklet, and Ed25519 in WebCrypto (Chrome 137, Firefox 129, Safari 17, or later). In Node: version 20 or later. |
| **Download** | The first visit downloads the model: 56.5 MB, then the browser's cache serves it (73.5 MB stored). |
| **Takes** | A Model has one open Session (one take) at a time; the next take is a new Session. A take holds at most 20 minutes of audio. |
| **Threads** | In a browser the engine runs in a module Worker, off the page's main thread (2.x ran it on the main thread); a page whose content security policy forbids Workers runs it on the main thread. In Node it runs on the calling thread. |

## Quick start

```js
import { TajweedClient } from '@quran-lab/tajweedformer';

const client = await TajweedClient.create({ key: 'qlk_v1_...' });   // your web key from sdk.quranlab.ai
const model = await client.model();                                  // downloads the model once, then cached
async function take(from) {                                          // one take: the microphone, or a clip
  const session = await model.listen({ from, endOnSilenceMs: 1500 });   // ends when the learner stops
  for await (const chunk of session.chunks) document.querySelector('#heard').textContent = chunk.decoded.text;
}
document.querySelector('#listen').onclick = () => take();            // the microphone needs a tap
```

That is the whole path from the microphone to the output: `listen()` asks for the permission, captures at
the device's own rate (usually 48 kHz) and tells the Session that rate, so no sample rate appears in your
code. `endOnSilenceMs: 1500` ends the take by itself after 1.5 s of silence. In a noisy room a take may not
end on silence, so keep a Stop button (`session.finish()`); the 20-minute limit ends it in any case. Values
under 1000 can end a take in a breath pause between two words (at the minimum, 500, the margin on the longest
pause of the 35 conformance clips is one frame); 1500 is the default of the quick starts.

The page it comes from is [examples/quickstart.html](examples/quickstart.html): it also plays a sample clip
of the model with no microphone, and starts a new take when the learner comes back to the page. The same in a
Vite project, which builds with no line of config: [examples/vite](examples/vite/README.md). For `vite dev`,
use the app's development key with `http://localhost:*` among its origins; a production key does not work on
a local address, and the SDK says so (`server_rejected`, with what to do).

From Node, or with audio you already have, replace `listen()` with `model.session()` and
`session.push(samples)`; everything else is the same ([examples/node.mjs](examples/node.mjs)).

## The five concepts

| Concept | What it is | Made by |
| - | - | - |
| `TajweedClient` | The app's link to Quran Lab: the key, the signed config, telemetry, sharing, the model files on this device. One per page (a second one while the first is open is the error `client_exists`). | `await TajweedClient.create({ key })` |
| `TajweedModel` | One verified model build: `id`, `version`, `build`, `contexts`, `defaultContext`, `chunkMs(context)`, `tokens`, `calibration`, `reference`, `sampleClips`, `backend`. Holds the engine. | `await client.model()`, or `await TajweedModel.open(folder)` |
| `TajweedSession` | One take: audio in, `chunks` and `events` out, the take's Heads from `finish()`. One open Session per Model (`session_open`). | `await model.listen(options)` (the SDK captures) or `model.session(options)` (the app pushes) |
| `TajweedHeads` | Raw model output for a chunk or a whole take: `names`, `get(name)`, `greedy(name)`, `decoded()`. | a chunk (`chunk.heads`), `session.finish()` |
| `TajweedBackend` | What runs the model. On the web always `{ kind: 'cpu', name: 'wasm', stage: 'cpu', reason: null }`. | `model.backend`, `session.backend`, `chunk.backend` |

Session options: `context`, `sampleRate` (for pushed audio only; 16000 by default), `heads` (a list of
names or `'all'`), `backend` (`'auto'` or `'cpu'`), `topK`, `endOnSilenceMs` (off, or 100 to 60000),
`pace` (`listen({ from })` only), and `onChunk` / `onEvent`, which get what `session.chunks` and
`session.events` yield.

### What a chunk carries

Every 320 ms of audio (160 or 480 ms in the other contexts) a chunk arrives:

| Field | Meaning |
| - | - |
| `index`, `startMs`, `endMs`, `firstFrame` | Where the chunk is in the take. |
| `backend` | The Backend that ran it. |
| `speech` | True when the chunk holds speech frames. |
| `heads` | The Heads of this chunk only. |
| `decoded` | The decoded layer of the take so far, ready to show. |

The decoded layer: `text`; `tokens` (each `id`, `name`, `firstMs`, `peakMs`, `lastMs`, `confidence`);
`words` (tokens split at the word bar); `frames` (top-1 and runner-up with their log-probs and the margin,
and the `topK` best when the option is set); `settled`, the count of leading tokens that will not change
in this take (the last token can still grow while its sound goes on); and `isFinal` on the last one. A
time is the start of a 40 ms frame, so a token covers `firstMs` to `lastMs + 40`.

### Heads

Twelve heads, the same names on every platform. A Session computes `log_probs`, `inter1_log_probs`,
`timing_log_probs`, `gem`, `attr_qalqalah` and `conf` unless `heads` names others (`log_probs` is always
computed: the decoded layer and the speech events come from it).

| Head | Kind | Frame | Classes |
| - | - | - | - |
| `log_probs`, `inter1_log_probs`, `inter4_log_probs` | `ctc` (log-probs over the 38 tokens) | 40 ms | 38 |
| `id_log_probs`, `timing_log_probs` | `ctc` | 20 ms | 38 |
| `gem` | `attribute` (probabilities) | 20 ms | 2: single, held |
| `attr_tafkheem` | `attribute` | 20 ms | 3: thin, heavy, low heavy |
| `attr_ghunna` | `attribute` | 20 ms | 5: none, plain, geminate, ikhfa, idgham |
| `attr_qalqalah` | `attribute` | 20 ms | 3: none, sughra, kubra |
| `attr_face` | `attribute` | 20 ms | 4: none, imala, tasheel, sakt |
| `boundary`, `conf` | `attribute` (one logit) | 20 ms | 1 |

`heads.get(name)` gives `{ name, kind, frameMs, frames, classes, values }` (`values` a `Float32Array`,
`frames x classes`, row major), or null for a head the take did not compute. `heads.greedy(name)` gives a
CTC head's tokens (collapsed, blank removed) with `firstMs`, `peakMs` and `lastMs`.

### Events

`session.events` is one stream of what happened to the take:

| Event | When |
| - | - |
| `speechStarted` (`atMs`) | The model emitted a token after silence. |
| `speechEnded` (`atMs`, `silenceMs`) | Silence after speech: 1.5 s, or `endOnSilenceMs`. With that option the take finishes here. |
| `interrupted` (`cause`) | `listen` only. `interruption`: the system took the audio (a call, another app); nothing is read until `resumed`. `routeChange`: another input device; the microphone is opened again and the take goes on. |
| `resumed` | The interruption ended. |
| `ended` (`reason`) | The take ended without your `finish()`: `silence`, `hidden` (the page was hidden or left), `interrupted` (the input went away), `sourceEnd` (the clip ran out), `limit` (the take reached 20 minutes of audio), `error` (with a `TajweedError`). The last chunk has `isFinal`, `chunks` ends, and `finish()` gives the take's Heads. |

A take holds at most 20 minutes of audio: there it ends by itself (`ended: limit`) with everything up to the
limit decoded and its Heads kept, and a later `push` is `session_closed`. `chunks` keeps at most 256 chunks and
`events` at most 64 events waiting for a reader; when full, the oldest waiting one is dropped (the last chunk
and `ended` never are, each chunk's `decoded` is the take so far, and `finish()` returns the whole take).
`client.diagnose()` counts the dropped chunks. A microphone take whose device decodes slower than real time
ends with `engine_failed` once 30 s of audio wait for the engine.

Speech and silence come from the model's own output, by one definition for the events, `chunk.speech` and the
usage statistics: a 40 ms frame is speech when the recognition head (`log_probs`) or the timing head
(`timing_log_probs`) shows a sound on it. The recognition head shows a sound for a moment and is blank while
the sound is held; the timing head holds it for as long as it sounds. So a held vowel is speech throughout (a
madd of six counts lasts seconds), and silence is counted from the last frame with a sound: `speechEnded`
comes when the window has passed after it (1.5 s by default), within one chunk more. The SDK computes the
timing head on every Session for this, also when your `heads` leave it out; you get it only when you select
it. `endOnSilenceMs` is off (absent, `null` or 0) or a whole number from 500 to 60000.

A hidden page ends a `listen` take: the SDK never holds the microphone in the background. Start a new
take when the page is visible again (one line, in the example).

## Running without a microphone

The model folder carries a few short sample clips. `model.sampleClips` lists them (`name`, `kind`,
`durationMs`), and `listen` takes one in place of the microphone, at real-time pace or as fast as possible:

```js
const session = await model.listen({ from: model.sampleClips[0], pace: 'fast' });
for await (const chunk of session.chunks) console.log(chunk.decoded.text);
```

`listen({ from: samples, sampleRate })` does the same with a `Float32Array` you already have. The take
ends with `ended: sourceEnd` when the audio ran out. This is how the examples, CI and a coding assistant's
check show real output on a machine with no microphone. In Node `listen()` without `from` fails with
`microphone_unavailable`. Apps that only want samples use `Microphone.open()`, `mic.sampleRate`,
`mic.samples()` and `mic.close()`.

## Ready before the learner taps

```js
await client.prefetch({ unmeteredOnly: true, onProgress: ({ bytesDone, bytesTotal }) => {} });
const model = await client.model();        // opens and warms the engine; call it early
console.log(await client.storage());        // { models: [{ version, build, bytes }], sharingQueueBytes }
console.log(await client.diagnose());       // one report, safe to paste into an issue
```

- `prefetch` downloads and verifies the model ahead of use. It resumes after an interruption and does
  nothing when the model is already here. With `unmeteredOnly` it waits on a metered connection (cellular, or
  the browser's data saver) and with none, and downloads on an unmetered one. The option cannot be honoured
  where the runtime cannot tell: Safari and Firefox have no Network Information API, Chrome on a desktop gives
  no connection type, and Node has neither. There `diagnose().connection` is `unknown` and the model is
  downloaded.
- A first run with no network fails with `needs_connection`, at once. After one download every start works
  offline.
- `client.model('4.0.0')` pins a model version; without it Quran Lab's config chooses. `model.version` is
  the version, `model.build` the build id (for diagnostics only).
- `client.removeModels()` removes the model files, never the consent state or the sharing queue.
- `client.diagnose()` reports the SDK version and whether a newer one exists, whether the key was accepted,
  whether the signed config is fresh, the model's version and build, the context and backend in force, the
  microphone permission, storage, the code of the last error, the chunks dropped unread, and the connection
  (`unmetered`, `metered`, `none` or `unknown`). No audio, text or identifier is in it.

## Calibration and reference data

Two pieces of read-only data come with the model for apps that build their own judge. The SDK never
applies either one.

**`model.calibration`** is `calibration.json` exactly as shipped (null when the model folder has none):
`text` (the file), `json` (parsed, frozen), `sha256`, `format`, `contexts`, `classes`, `presets`,
`context(name)` and `threshold(context, class, preset)`. What is in it:

- `classes`: the kinds of single-unit difference a judge can test (`vowel_sub`, `vowel_del`, `vowel_ins`,
  `short_to_long`, `long_to_short`, `cons_sub`, `cons_del`, `insertion`); `presets` (`strict`, `balanced`,
  `sensitive`, `very_sensitive`), each with its target false-alarm rate.
- `contexts.<ctx>.fusion`: the heads the site thresholds apply to (`log_probs` and `inter1_log_probs`), the
  weight `a` per class (`llr = a * llr(log_probs) + (1 - a) * llr(inter1_log_probs)`), how `inter1_log_probs`
  is prepared (the word bar merged into blank) and the clip of the LLRs.
- `contexts.<ctx>.sites.<class>.thresholds.<preset>`: a threshold in nats on the fused LLR, which is
  log P(best single-unit alternative) minus log P(expected sequence) by a full-sequence CTC forward on the
  take's heads. A judge flags a site when the LLR is above the threshold. `status` says whether the class is
  `validated`, `experimental` or `off`.
- `contexts.<ctx>.madd`, `qalqalah`, `gemination`, `word`: the cuts and taus for counting a long vowel from
  `timing_log_probs`, for qalqalah from `attr_qalqalah`, for gemination from `gem`, and for a per-word score.

**`model.reference`** is the table of the expected units of each ayah (null when the model build has none).
It is not part of the model download: `await model.reference.fetch()` downloads and verifies it once
(`isDownloaded` says whether it is here), and `await model.reference.units(surah, ayah)` gives
`{ units, words, wordCount }`: the unit ids in reading order with the word bar between words, and each
unit's word. The ids are those of `model.tokens`. Before the fetch `units` fails with `reference_missing`.
The SDK never aligns the units with a take and never compares them with one.

A judge needs the heads of a take (`session.finish()`), the vocabulary (`model.tokens`), the expected units
(`model.reference`) and the thresholds (`model.calibration`); the alignment and the LLRs are yours to
compute. [docs/migrating-to-3.md](docs/migrating-to-3.md) describes them.

## Analytics your app can add

The SDK counts what it measures itself (takes, minutes, speech and silence, latency, tokens). What it can
no longer know without a judge, your app may report; nothing is sent if it does not:

```js
session.reportRecited(1, 1, 7);                       // surah, first ayah, last ayah of this take
client.analytics.reportChecks('vowel_sub', 31, 1);    // your judge: rule, times checked, times flagged
```

Both go into the day's anonymous totals (ayahs per surah; checks and flags per rule) and are marked as
reported by the app. A value out of range is the error `invalid_argument`.

## Delivery

`client.model()` fetches only what a browser needs from the signed manifest of the build Quran Lab's config
names: `tokens.txt`, `calibration.json`, the shared `layers.zfw` and `frontend.zfw`, and the context's graph
and `frames.zfw`. Never CoreML or NPU files, the ONNX graphs, the other contexts, the reference table or
the sample clips (those come when asked for). Big files travel gzip: 56.5 MB for c16_l64 (73.5 MB stored);
another context later adds 0.65 to 0.86 MB. Files come in 4 MiB ranges, resume after an interruption, are
checked against the manifest's size and SHA-256 (as stored and as decoded), and are kept by SHA-256 in the
Cache API (IndexedDB where there is none; a folder in Node, `storage` in the Client's options). A second
start reads only the manifest from the network, and none of it when offline.

The manifest is signed by Quran Lab (Ed25519) and names the model version. The SDK checks, in this order:
the build the config named, the manifest's shape, the signature, that it has a version (a build for SDK 2.x
has none: `model_incompatible`), its minimum SDK version, and the version the config named.
`TajweedModel.open(folder)` opens a folder you already have (a URL, a directory in Node, or
`dirReader(dir)` from `@quran-lab/tajweedformer/node`) with the same checks.

The response time is the model's context: `c8_l64` (160 ms chunks), `c16_l64` (320 ms, the default),
`c24_l72` and `c24_l256` (480 ms). A Session runs on the `context` option when your app sets it, else on the
one chosen for the app on sdk.quranlab.ai (the signed config's `inference.context`), else on the model's
default. Another context's files are fetched on first use.

## Client

```js
const client = await TajweedClient.create({ key, appVersion: '1.0.0', analytics: 'on', audience: 'general' });
```

- **Keys:** a web key works only from the origins you gave it on sdk.quranlab.ai. In Node use a desktop
  key and pass `appId` (your app id) and, if you like, `storage` (a folder).
- **Signed config:** Ed25519 over the exact bytes with Quran Lab's pinned key id, `expires_at` checked,
  ETag revalidation; a config that fails is ignored and the last good one stays.
- **Telemetry:** on by default, anonymous by construction: sums and histograms only (takes, minutes of
  audio, speech and silence, latency and real-time factor, load times, tokens per head, margins and
  confidence, launches, how often the sharing sheet was shown, accepted and declined, and what your app
  reports). No audio, no text, no identifiers, no time finer than the UTC day. It is sent as deltas during
  the day: every 15 minutes while the page is visible, when it is hidden or left, and at launch. Quran Lab
  can switch it off for your app; you can with `analytics: 'off'`.
- **Foreground and background:** automatic in browsers. In Node call `client.background()` and
  `client.foreground()`.
- **Newer SDK:** in development the SDK logs once per load when Quran Lab's signed config names a newer SDK.
  Production stays silent.
- What the SDK sends, when, and what your app can change: [docs/platform-client.md](docs/platform-client.md)
  (the same page in every TajweedFormer SDK).

## Errors

Every failure is a `TajweedError` with `code` (stable, the same in every TajweedFormer SDK), `message`,
`fix` (one sentence you can act on) and `docs` (`https://sdk.quranlab.ai/docs/errors#<code>`). The codes:
`invalid_argument`, `invalid_key`, `sdk_too_old`, `server_rejected`, `client_exists`, `model_unavailable`,
`needs_connection`, `network_not_permitted`, `download_failed`, `storage_full`, `storage_failed`,
`model_missing`, `model_invalid`, `signature_invalid`, `checksum_mismatch`, `model_incompatible`,
`reference_missing`, `session_open`, `session_closed`, `cancelled`, `engine_failed`, `microphone_denied`,
`microphone_unavailable`, `interrupted`, `sharing_unavailable`, `runtime_unsupported`. `model_unavailable`
means Quran Lab has no model build for this SDK version yet: nothing to change in the app.

- **A refusal says what to do.** When Quran Lab refuses the app, the error is `server_rejected` and its
  `message` and `fix` are the ones of the reason: the account has no access yet, the key is of another type
  or environment, the key belongs to another app (a key works for the first app that used it; for a page that
  is its origin), the page's origin is not on the key, or a production key is used on a local address. Show
  the message and, under it, the fix.
- **An origin that is not on the key.** A browser gives such a page no answer from Quran Lab at all, which
  looks like no network. When a request gets no answer, the SDK asks Quran Lab's origin check once per page
  load and raises the refusal it names; `needs_connection` is raised only when that check cannot be reached
  either. A page that works never calls it.
- **`runtime_unsupported`** is a browser or a Node without something the SDK needs; the message names it
  (Ed25519 in WebCrypto, for one). `network_not_permitted` belongs to the other TajweedFormer SDKs; this one
  does not raise it.

## Recitation sharing (the learner opts in)

```js
const sharing = client.sharing;
document.querySelector('quranlab-sharing-settings').client = client;   // the SDK's settings element
```

Whether sharing is offered is Quran Lab's decision, per app, in the signed config (`sharing.isAvailable`).
Where it is offered, the SDK shows its own consent sheet (`<quranlab-consent>`, right-to-left where the
language is) after a finished take in which the model heard speech, never on first launch, and at most
three times per install ("Not now" is asked again at most twice, seven sessions apart). A learner who said
"Share", or who turned sharing off, is never asked again; a yes is kept, with the consent version agreed
to, across copy decks, wording changes and SDK upgrades. Offered is never consent: nothing is recorded for
sharing before the learner answers "Share". A learner who agrees shares each whole take while the SDK
listens (Ogg Opus, uploaded in the background, resumable).

| Member | Meaning |
| - | - |
| `isAvailable` | Quran Lab's config allows sharing for this app. |
| `isOn` | The learner said yes. |
| `setOn(on)` | The settings switch. Off stops uploads at once and deletes the unsent queue. |
| `ask()` | Ask now, at your own moment, if an ask is still allowed. |
| `feed(samples, sampleRate)` | Audio your app already captures outside takes (see below). |
| `items()` | The outbox: each recording's status (a promise). |
| `summary()` | The learner's summary, for a thank-you line. |
| `delete()` | "Delete what I shared". Only this browser's non-extractable key can sign it: no app key or token can delete a learner's recordings. |
| `recoveryCode` | The code for deletion when the device is lost. |
| `setWording(overrides)` | Your own wording, `{ 'sheet.title': '...' }` with the deck's keys; `null` restores the SDK's. The learner then agrees to your text, recorded under its own consent version. |

The sheets take the CSS custom properties `--ql-accent`, `--ql-accent-fg`, `--ql-bg`, `--ql-fg`,
`--ql-muted`, `--ql-radius`, `--ql-font` and `--ql-title-font`; the words and the consent version do not
change. A call that needs sharing while it is not offered fails with `sharing_unavailable`.

**Takes in a row are one recording.** An app often stops and starts takes while the learner keeps reciting.
When a take ends, the shared recording stays open for a few seconds (3 s by default): a take that starts
in that time at the same sample rate continues the same Ogg stream. The recording closes when no take
follows in time, when the page is hidden, or when sharing is turned off. A recording never holds more than 20
minutes: where its audio reaches that, also inside a take, it closes as a whole recording and the take goes on
in a new one.

**Lead-in and tail.** A `listen` take captures only between `listen()` and the end of the take, and that is
what is shared. If your app pushes its own audio and keeps capturing between takes, hand that audio to
`sharing.feed(samples, sampleRate)`: the SDK keeps the last second of it in memory and puts it before the
next take, and adds up to half a second after a take, so a shared recording does not begin or end in the
middle of a word. Without a yes, or with sharing off, fed audio is dropped at once. The model never sees it.
After every take the recording stays open for that tail for 1.5 s, and only audio you feed goes into it: the
SDK's own microphone is closed when a `listen` take ends and is never kept or reopened for a tail.

**Bitrate on bad networks.** Opus starts at 192 kbit/s and steps down (96, 64, 32 kbit/s) when uploads fail
for network reasons or the queue backs up, and back up when they succeed again.

Web uploads run at the platform's lower trust tier (the web key's origin lock, per-key and per-learner
caps). Browsers upload straight to storage, which needs the bucket's CORS rule for your origin (a Quran Lab
launch step).

## Platform notes

- **Off the main thread.** In browsers the engine runs in a Worker (a module Worker the SDK starts
  itself): a chunk of inference never blocks your page. `session.push` posts the audio to it, and chunks and
  events come back as messages, which is why everything a streaming UI needs arrives with the chunk and
  there is no "output so far" call. In a browser without module Workers, and in Node, the engine runs in
  the calling thread.
- **Bundlers.** `vite build` works with no line of config ([examples/vite](examples/vite/README.md); `npm run
  example:build` builds it in CI). Nothing a bundler follows from the browser entry imports a Node built-in:
  Node gets its own entry through the `node` condition of the package's `exports`. The Worker and the
  WebAssembly files are referenced with `new Worker(new URL(..., import.meta.url), { type: 'module' })` and
  `new URL(..., import.meta.url)`, which Vite, webpack 5 and Parcel resolve; the microphone's AudioWorklet is
  made in the page and needs no file. Without a bundler, serve `web/` and `dist/` as they are.
- **Secure context.** `https`, or `http://localhost`: a browser gives the microphone and WebCrypto to
  nothing else, and the microphone needs a tap or a click.
- **What is collected.** Anonymous usage statistics (no audio, no text, no identifier), and, only after
  the learner's yes on the SDK's sheet, the audio of takes. The details and what your privacy notice should
  say are in [docs/platform-client.md](docs/platform-client.md).

## Exactness

The engine gives the same tokens and the same bits for every value of every head of every chunk as
the reference (ONNX Runtime's ARM int8 run of the published model), checked on the 35 conformance
clips. This package is checked through its own engine host (`npm test`, where the model files are staged):

| Check | Node 22 |
| - | - |
| c16_l64 audio, 12 outputs every chunk, vs ONNX Runtime armv7 | 35/35 |
| c8_l64 audio (160 ms), the same, vs ONNX Runtime armv7 | 35/35 |
| c24_l72 and c24_l256, vs the native engine | 35/35 each |
| The engine's top-2 and top-K vs the SDK's ranking | 35/35 and 5/5 |
| Sample clips through `listen({ from })` vs the self-test file (two contexts) | 10/10 |
| Reference lookup vs the table | 6236/6236 ayahs |
| Shared vectors (manifest, speech, settled, telemetry, context) | all cases |

`npm test` runs the Node checks; `npm run test:browser` runs the quick start page in headless Chrome with a
fake audio device, the engine in its Worker.

## Build from source

Needs the [Emscripten SDK](https://emscripten.org) 6.0.11 on `PATH` and the engine
(`git clone --recurse-submodules`, or `TAJWEEDFORMER_SDK_DIR` pointing at a checkout).

```bash
npm run build          # dist/tajweedformer.mjs + .wasm: the engine with the TajweedFormer binding
npm run build:opus     # dist/tajweedformer-opus: libopus for recitation sharing (loaded lazily)
npm test
npm run test:browser   # headless Chrome (CHROME=path)
```

## Download size

A page downloads only the CPU profile of the model folder (`sdk/v4.0`, manifest format 3), gzip on the wire
(inflated with `DecompressionStream`), resumable, every file checked against the signed manifest, and caches it
(Cache API or IndexedDB; a directory in Node). Model revision v4.0-2026-11-10, default context `c16_l64`:
**56.5 MB** (73.5 MB decoded); another context later adds 0.65 to 0.86 MB. The opt-in
sharing encoder (libopus in WebAssembly, 316 KB) loads only for the first shared session.

## Problems and wishes

Something does not work, something is missing, or you want to tell us how it went:
[open an issue](https://github.com/Quran-Lab/tajweedformer-web/issues/new/choose). There is a form for a bug, one for a
wish and one for a word of feedback. Issues are public, so leave out keys and anything that came from a learner.
A security problem does not go into an issue: use "Report a vulnerability" on the
[Security tab](https://github.com/Quran-Lab/tajweedformer-web/security). A coding assistant can file an issue for you; it
shows you the text first.

## Licence

Quran Lab is a waqf: the SDKs and the models are free to use and are never sold.

The source code in this repository and the TajweedFormer model weights are released under the
Quran-Lab No-Profit License 1.2 ([NPL-1.2](LICENSE)): use, copy, modify and build on them freely,
but never charge for them, for access to them, or for any feature they power. The weights are not
stored in this repository; Quran Lab hosts them itself and serves them to apps by
`cdn.quranlab.ai/models` under the same licence. Get access at
[sdk.quranlab.ai](https://sdk.quranlab.ai).

Third-party components keep their own licences, listed in their folders under `third_party/`.
