# TajweedFormer for the web: reference for coding assistants

Everything an assistant needs to integrate this SDK correctly: use only the names, calls and settings shown here or in the installed version's sources. People: the short version is in [README.md](README.md).

## What you get

<table>
<tr>
<td width="33%" valign="top">

**Hears every word**<br>Streaming recognition of Quranic recitation while the learner recites. Results arrive as often as every 160 ms (320 ms by default, 480 ms for longer context).

</td>
<td width="33%" valign="top">

**Points to the word to fix**<br>Wrong letters and vowels, madd held too short or too long, and a score for every word. Qalqalah checks are experimental.

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

**Nothing to host**<br>The SDK downloads the model (about 57 MB) from our CDN in six regions, verifies it and keeps it up to date.

</td>
<td valign="top">

**Tuned in the portal**<br>Four presets and three word levels. Change them at any time; your app picks them up without a new build.

</td>
</tr>
</table>

### Strict or gentle: you choose

**Strict** almost never flags a correct recitation. **Balanced** is the default. **Sensitive** catches more, and **Very sensitive** catches the most, for a teacher who reviews every flag first. The word level follows your learners: **strict** for huffaz and advanced students, **general** for most apps, **beginner** for children and classes.

## Why TajweedFormer

- **Made for the Quran.** Your app names the ayah; TajweedFormer checks the recitation against it, sound by sound, and gives every word its own verdict.
- **Feedback in the moment.** Results stream while the learner recites, so your app can respond on the word itself, not after the take.
- **One engine on every platform.** The same engine runs the [web](https://github.com/Quran-Lab/tajweedformer-web), [iOS and macOS](https://github.com/Quran-Lab/tajweedformer-apple), [Android](https://github.com/Quran-Lab/tajweedformer-android) and [Windows and Linux](https://github.com/Quran-Lab/tajweedformer-c) SDKs, all set from one portal.
- **Free, and it stays free.** Quran Lab is a non-profit waqf: the SDKs and models are never sold. The licence, NPL-1.2, asks three things: no paywall on model features, no results presented as rulings, and show the notice.

## Built for AI developers

Copy the setup prompt from [portal.quranlab.ai](https://portal.quranlab.ai) and paste it into your coding assistant. That one prompt sets everything up: the package, your key, and the settings for the learners your app is for. [AGENTS.md](AGENTS.md), beside this README, gives the assistant the complete API, so the code it writes uses names that exist. Prefer to do it by hand? Get a key in the portal and start below.

## At a glance

- **What it is:** the npm package `@quran-lab/tajweedformer` 2.0.1. It runs
  TajweedFormer V4 (Quran-Lab/tajweedformer-v4, served by cdn.quranlab.ai/models) on the
  [tajweedformer-engine](https://github.com/Quran-Lab/tajweedformer-engine) engine compiled to WebAssembly
  (SIMD128, no ONNX Runtime), bit for bit the same as the engine on every other platform.
- **What you get:** audio in; per chunk every head the network has (raw layer); what the model heard
  with top-1 and runner-up tokens, margins, confidence and timings (decoded layer); and for a known
  ayah per-site verdicts, madd counts, qalqalah and gemination evidence and a score per word, with the
  calibrated thresholds (tajweed layer). Defaults are safe; nothing is hidden.
- **Linked to [portal.quranlab.ai](https://portal.quranlab.ai):** a web key, the signed config (the
  model and the tajweed settings your app gets from the portal), anonymous daily telemetry, issue
  reports, and opt-in recitation sharing with the SDK's own consent sheet.
- **V4 only.** SDK 2.0.0 hosts TajweedFormer V4 (`sdk/v4.0`). Apps on the previous model (v3.2) stay on
  the 1.x packages.
- **Status:** preview, not yet on npm.

## The TajweedFormer SDKs

One model, one engine, the same bits on every platform. Each SDK compiles the same engine source
(Quran-Lab/tajweedformer-engine, pinned as a submodule), so no platform can drift from the others.

| Repository | What it is | Platforms | Install |
| - | - | - | - |
| [tajweedformer-android](https://github.com/Quran-Lab/tajweedformer-android) | Kotlin SDK (AAR) | Android 8.0+, desktop JVM | Maven `ai.quranlab:tajweedformer:2.0.1` |
| [tajweedformer-apple](https://github.com/Quran-Lab/tajweedformer-apple) | Swift SDK: Neural Engine (CoreML) with the exact CPU engine as fallback | iOS 15+, macOS 12+ | SwiftPM, product `TajweedFormer` |
| [tajweedformer-web](https://github.com/Quran-Lab/tajweedformer-web) | WebAssembly SDK with SIMD128 | Browsers, Node | npm `@quran-lab/tajweedformer` |
| [tajweedformer-c](https://github.com/Quran-Lab/tajweedformer-c) | C API and server runner with x86 int8 kernels (AVX2, AVX-VNNI, AVX-512 VNNI) | Windows, Linux (x86-64) | CMake (`add_subdirectory`) |
| [tajweedformer-engine](https://github.com/Quran-Lab/tajweedformer-engine) | The engine: exact C runtime, tajweed scorer, conformance suite | everything above | Git submodule |

The model is Quran-Lab/tajweedformer-v4 (`sdk/v4.0`), hosted by Quran Lab and served by
`cdn.quranlab.ai/models` to approved app keys (request access at
[portal.quranlab.ai/access](https://portal.quranlab.ai/access)). SDK 2.0.0 runs V4 only.
Every release's binaries (the AAR and POM, the XCFramework zips, the npm package, the native archives) are
also on `https://cdn.quranlab.ai/sdk/<product>/<version>/`, with a `SHA256SUMS` file, served from six regions.
[portal.quranlab.ai](https://portal.quranlab.ai) is where you create an app, get its developer key,
choose which model revision your users get, and set the tajweed checks (presets, per-class
thresholds) your users see, without shipping a new build.

## Quick start

```bash
npm install @quran-lab/tajweedformer
```

```js
import { TajweedFormer } from '@quran-lab/tajweedformer';
import { QuranLab } from '@quran-lab/tajweedformer/platform';

// 1. your web key from portal.quranlab.ai (locked to your site's origin)
const ql = await QuranLab.configure({ key: 'qlk_v1_...', appVersion: '1.0.0' });

// 2. the model the portal recommends: only this context's files are downloaded (about 75 MB once,
//    then from the browser's cache), every file checked against the signed manifest
const tf = await TajweedFormer.load({ platform: ql, sampleRate: 48000, onProgress: (p) => show(p) });

// 3. listen
const stream = tf.createStream({ onChunk: (chunk) => live(chunk.frames) });
stream.pushAudio(pcm);              // Float32Array, mono, at 48 kHz here; as often as you like
stream.finish();

// 4. what the model heard, and the tajweed of a known ayah
const heard = stream.decoded();     // tokens with confidence, runner-up, timings
const result = await tf.score(stream.heads(), 1, 2);
for (const w of result.words) if (w.flagged) markWord(w.word, w.best);   // the edit that most likely happened
for (const s of result.sites) if (s.flagged) console.log(s.class, s.expectedUnit, '->', s.alternativeUnit);
```

A runnable page is in [`examples/browser.html`](examples/browser.html) and a Node script in
[`examples/node.mjs`](examples/node.mjs). The full API, with every field, is in
[`docs/api.md`](docs/api.md).

## The three layers

| Layer | Call | What you get |
| - | - | - |
| Raw | `createStream({ heads, allHeads, onChunk })`, `stream.heads()` | Per chunk every head as `Float32Array`s with its rate: `log_probs`, `inter1_log_probs`, `inter4_log_probs` (40 ms, 38 tokens); `id_log_probs`, `timing_log_probs` (20 ms, 38); `gem` (2), `attr_tafkheem` (3), `attr_ghunna` (5), `attr_qalqalah` (3), `attr_face` (4); `boundary`, `conf` (logits). Class names in `HEAD_SPECS`. Default: the scorer's heads plus `conf`; `allHeads: true` keeps all twelve; only the selected heads are computed. |
| Decoded | `stream.decoded()`, `tf.decode(heads)`, `chunk.frames` | Per 40 ms frame the top-1 and runner-up token with log-probs and margin; the greedy transcript with per-token peak log-prob, runner-up, margin, confidence (the `conf` head) and start/end in ms. |
| Tajweed | `tf.score(heads, surah, ayah)` | Per site: class, expected unit, best alternative, LLR per head, fused LLR, threshold, flagged, frames. Madd counts with ratios and allowed range, qalqalah and gemination scores. Per word (the engine's word level): score (the largest fused LLR of any single edit inside the word), the edit that gave it, the word threshold in force and the flag (at or above it), timing, and its flagged items. `raw` holds the engine's whole JSON. |

The same layers, with the same names in each language, exist in the Android, Apple and native SDKs
(the numbers are pinned by shared vectors).

## Settings

Three layers, highest first: **your code**, the **portal** (the `tajweed` block of the signed config),
then the model's **calibration**. Presets `strict`, `balanced` (default), `sensitive`,
`very_sensitive`; per-class overrides by preset or raw threshold; checks `letters`, `vowels`,
`length`, `madd`, `gemination`, `qalqalah`, `lazim`; the context (`c16_l64`, 320 ms chunks, by
default); and the word level: `word: { preset: 'strict' | 'general' | 'beginner' }` (general by default) or
`word: { threshold }` (clamped to the calibrated range, 2 to 12), with the check `word`.

```js
const tf = await TajweedFormer.load({ platform: ql, settings: {
  preset: 'balanced', overrides: { cons_sub: { preset: 'sensitive' }, vowel_sub: { threshold: 1.25 } },
  checks: { qalqalah: true } } });
tf.effectiveSettings();   // every value with where it came from, and what was dropped or refused
```

A check that calibration marks `off` is never turned on by the portal, and by your code only in a
debug build (`debug: true`); its numbers stay reachable through `result.raw` and the raw heads.

## Delivery

`load()` over HTTP fetches only the web download profile of the signed manifest: `tokens.txt`,
`calibration.json`, `expected_tj3.zfx`, the shared `layers.zfw` and `frontend.zfw`, and the chosen
context's graph and `frames.zfw` (folder layout 3, manifest format 3; layout 1 folders, one engine
folder per context, load too). Never CoreML, NPU files, the ONNX graphs or the other contexts. Big files
travel gzip: 56.5 MB for c16_l64 (73.5 MB on disk); another context later adds 0.85 MB. Files come
in 4 MiB ranges, resume after an interruption, are checked against the manifest's size and SHA-256
(stored and decoded), and are kept decoded by SHA-256 in the Cache API (IndexedDB where there is
none; in Node pass `cache: dirStore(dir)` from `@quran-lab/tajweedformer/node`). A second load reads
only the manifest from the network.

Measured in headless Chrome 156 on the development PC (`npm run test:browser`), V4 at c16_l64:

| | |
| - | - |
| Package JS at first paint (web/index.js graph + engine glue) | 177 KB raw, 55 KB gzip |
| Engine WebAssembly (fetched by the first `load()`) | 722 KB raw, 385 KB gzip |
| Model download, c16_l64 profile | layout 3: 56.5 MB (Node test over HTTP); layout 1 (measured in Chrome): 74.8 MB of a 144 MB two-context folder |
| Import / cold load (local server) / warm load (Cache API) | 23 ms / 785 ms / 234 ms |
| Chunk of 320 ms audio | 38.5 ms median, 42.9 ms p95, real-time factor 0.17, one thread |

## Platform

```js
import { QuranLab } from '@quran-lab/tajweedformer/platform';
const ql = await QuranLab.configure({ key, appVersion: '1.0.0' });
ql.startRefresh();        // the portal's changes arrive within a minute while the app is in use
```

- **Keys:** a web key works only from the origins you gave it on the portal. From Node use a desktop
  key (`platform: 'linux'` or `'windows'`, `bundleId` your app id) or a web key with `origin`.
- **Signed config:** Ed25519 over the exact bytes with Quran Lab's pinned key id, `expires_at` checked,
  ETag revalidation; a config that fails is ignored and the last good one stays.
- **Telemetry:** on by default, anonymous by construction: sums and histograms only (sessions,
  minutes, latency and real-time factor, load times, presets in force, flag rates, margins and
  confidence, surah coverage; since 2.0.1 also launches, ayahs and words scored, ayahs per surah, how
  often each tajweed rule was checked and flagged, and how often the sharing sheet was shown, accepted
  and declined). No audio, no text, no identifiers, no time finer than the UTC day. Since 2.0.1 it is
  sent as deltas during the day: every 15 minutes while the page is visible, when it is hidden or left
  (keepalive requests), and at launch; each delta has a random `report_id`, so a retry is counted once.
  The portal can switch it off for your app (`flags.analytics`); you can with `analytics: 'off'`.
  With `autoSend: false` the SDK sets no timer or page listener: call `ql.foreground()`,
  `ql.background()` and `ql.sendTelemetry()` yourself.
- **Register:** once per UTC day per install (the first launch or return to the page of the day), so
  the portal counts daily active installs.
- **Issues:** kind and code only, never free text; one per kind and code per day.
- **Newer SDK:** in development (`debug: true`, or `NODE_ENV` not `production`) the SDK logs once per load
  when Quran Lab's signed config names a newer SDK: `Quran Lab SDK X is available (severity), you have Y: URL`.
  Production stays silent.
- What the SDK sends, when, and what your app can change: [docs/platform-client.md](docs/platform-client.md)
  (the same page in every TajweedFormer SDK).

## Recitation sharing (the learner opts in)

```js
import { enableSharing } from '@quran-lab/tajweedformer/consent';
const ql = await QuranLab.configure({ key });
const sharing = enableSharing(ql);   // optional: the SDK wires itself when the model attaches
document.querySelector('quranlab-sharing-settings').controller = sharing;
```

Whether the sheet is offered is Quran Lab's decision, per app, in the signed config
(`flags.contributions`); since 2.0.1 the `contributions` option is ignored. Where it is offered, the
SDK shows its own consent sheet (`<quranlab-consent>`, right-to-left where the language is) after a
session in which the learner saw feedback, never on first launch, and at most three times per install
("Not now" is asked again at most twice, seven sessions apart; the count carries over from 2.0.0). A
learner who said "Share", or who turned sharing off, is never asked again; a yes is kept, with the
consent version agreed to, across copy decks, wording changes and SDK upgrades (also from 2.0.0).
Offered is never consent: nothing is recorded for sharing before the learner answers "Share". A learner who agrees shares each whole session while the SDK listens (Ogg
Opus, uploaded in the background, resumable). The settings element gives the switch, what is shared,
the recovery code, and "Delete what I shared", which only this browser's non-extractable key can sign:
no app key or token can delete a learner's recordings. Web uploads run at the platform's lower trust
tier (the web key's origin lock, per-key and per-learner caps; sessions are marked unattested so
training can weight them); the portal's upload-trust setting can turn them off. Browsers upload
straight to storage, which needs the bucket's CORS rule for your origin (a Quran Lab launch step).

Four ways to present it (details in [docs/platform-client.md](docs/platform-client.md)):

1. **Default:** nothing to do; the SDK's sheet in the copy deck's words (deck `2026-11-09.1`, consent
   version `share-2026-11-09`, eight languages).
2. **Themed:** `enableSharing(ql, { theme: { accent, accentText, background, text, secondaryText,
   cornerRadius, titleFont, bodyFont } })` or `sharing.setTheme(...)` (CSS values), or the CSS custom
   properties `--ql-accent`, `--ql-accent-fg`, `--ql-bg`, `--ql-fg`, `--ql-muted`, `--ql-radius`,
   `--ql-font`, `--ql-title-font`. The same theme applies to the consent, guardian, thanks and settings
   sheets; the words and the consent version do not change.
3. **Your own UI:** `enableSharing(ql, { ask: async (a) => ... })`. The SDK calls it when an ask is due
   (`a.variant` first or reask; `a.guardian`; `a.copy.t(key)` the localized strings). Show your
   UI and resolve with `{ yes, guardianConfirmed }`, or resolve with nothing and call
   `sharing.answer(yes)` from the learner's tap. Asks and answers are counted and re-asked exactly as
   with the default sheet.
4. **Your own wording:** `enableSharing(ql, { wording: { 'sheet.title': '...', ... } })` or
   `sharing.setWording({...})` (`null` restores the deck). Keys are the deck's (plural lines as
   `impact.minutes.one`, ...); an unknown key or an empty text throws a `TypeError`. The learner then
   agrees to your text: the grant is recorded under `custom-<24 hex>` and every shared session sends
   `consent_text_sha256`. A later change of wording applies to learners who agree after it; a learner who
   already agreed keeps the version recorded then and is not asked again. `sharing.consent` gives the version, the hash
   and the canonical text, to send to Quran Lab for review. Keep it honest: what is sent, to whom, why,
   how to stop and delete.

**Bitrate on bad networks.** Opus starts at 192 kbit/s. Upload failures for network reasons (no
connection, timeouts, HTTP 408 or 5xx) and a backed-up queue (120 s or more of closed audio waiting)
step it down, 192, 96, 64, 32 kbit/s; three successful segment uploads with at most 30 s waiting step it
back up. A change applies from the next segment, so the stream stays one valid Ogg Opus file; each
segment's bitrate is in the outbox item's `segmentBitrates`. A new page starts at 192 kbit/s.
`sharingBitrate` (or `bitrate`) still fixes one bitrate instead, for tests.

## Exactness

The engine gives the same tokens and the same bits for every value of every head of every chunk as
the reference (ONNX Runtime's ARM int8 run of the published model), checked on the 35 conformance
clips. This package is checked through its own API:

| Check | Node 22 | Chrome 156 |
| - | - | - |
| V4 c16_l64 audio, 12 outputs every chunk, vs ONNX Runtime armv7 | 35/35 | 35/35 |
| V4 c8_l64 audio (160 ms), the same, vs ONNX Runtime armv7 | 35/35 | |
| V4 c24_l72 and c24_l256, vs the native engine | 35/35 each | |
| Calibration vectors (48 recordings x 2 presets), flags identical, LLRs within 1e-3 | 96/96 (scorer and full module) | 96/96 |
| Decoded layer vs `layers_ref.py`; word scores and flags vs the reference's READY4 (`word_scores`) | 48/48; 760/760 words | 48/48; 96/96 vectors |
| Word settings: the SDK's resolution equals the engine's (11 cases: presets, clamping, the check, invalid values) | 11/11 | |
| Settings vectors through the engine's config | 39/39 | |

`npm test` runs the Node checks (the conformance ones where the gated model files are staged);
`npm run test:browser` the browser ones.

## Build from source

Needs the [Emscripten SDK](https://emscripten.org) 6.0.11 on `PATH` and the engine
(`git clone --recurse-submodules`, or `TAJWEEDFORMER_SDK_DIR` pointing at a checkout).

```bash
npm run build          # dist/tajweedformer.mjs + .wasm: the engine with the V4 binding
npm run build:scorer   # dist/tajweedformer-scorer: the scorer alone (heads from any source)
npm run build:opus     # dist/tajweedformer-opus: libopus for recitation sharing (loaded lazily)
npm test
npm run test:browser   # headless Chrome (CHROME=path) on the staged V4 files
```

## Download size

A page downloads only the CPU profile of the model folder (`sdk/v4.0`, manifest format 3), gzip on the wire
(inflated with `DecompressionStream`), resumable, every file checked against the signed manifest, and caches it
(Cache API or IndexedDB; a directory in Node). Default context `c16_l64`: **56.5 MB** (73.5 MB decoded); another
context later adds about 0.85 MB. The opt-in sharing encoder (libopus in WebAssembly, 316 KB) loads only for the
first shared session.

## Licence

Quran Lab is a waqf: the SDKs and the models are free to use and are never sold.

The source code in this repository and the TajweedFormer model weights are released under the
Quran-Lab No-Profit License 1.2 ([NPL-1.2](LICENSE)): use, copy, modify and build on them freely,
but never charge for them, for access to them, or for any feature they power. The weights are not
stored in this repository; Quran Lab hosts them itself and serves them to apps by
`cdn.quranlab.ai/models` under the same licence. Request access at
[portal.quranlab.ai/access](https://portal.quranlab.ai/access).

Third-party components keep their own licences, listed in their folders under `third_party/`.
