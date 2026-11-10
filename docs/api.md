# @quran-lab/tajweedformer 2.0.3: API

Every type is in [`web/tajweed/index.d.ts`](../web/tajweed/index.d.ts),
[`web/platform/index.d.ts`](../web/platform/index.d.ts) and
[`web/consent/index.d.ts`](../web/consent/index.d.ts). The concepts and the numbers are the same in the
Android, Apple and native SDKs.

## Entry points

| Import | What |
| --- | --- |
| `@quran-lab/tajweedformer` | `TajweedFormer` with the engine (WebAssembly, single thread, SIMD128), and everything below that needs no engine |
| `@quran-lab/tajweedformer/scorer` | `TajweedFormer` with the scorer only (96 KB wasm): score heads from a server, an NPU or saved files; no streams |
| `@quran-lab/tajweedformer/tajweed` | the plain-JS parts: folders, settings, delivery, decode, words, types |
| `@quran-lab/tajweedformer/node` | `dirReader(dir)` (a folder on disk), `dirStore(dir)` (the delivery cache on disk) |
| `@quran-lab/tajweedformer/platform` | `QuranLab`: key, token, register, signed config, telemetry, issues |
| `@quran-lab/tajweedformer/consent` | `enableSharing`, the consent sheet and settings elements, the sharing state |
| `@quran-lab/tajweedformer/sharing` | the recitation upload (Ogg Opus, outbox); loaded by `consent` when needed |

## Loading a model

```js
const tf = await TajweedFormer.load({
  platform: ql,                 // or url: 'https://.../sdk/v4.0/', or cdn: { key, revision }, or files, or reader
  context: 'c16_l64',           // optional: app > portal > calibration default
  sampleRate: 48000,            // the rate you push; 8000 to 48000, resampled by the engine
  settings: { preset: 'balanced', word: { preset: 'general' } },
  debug: false,                 // a debug build may turn on checks calibration marks off
  cache: undefined,             // the Cache API by default; dirStore(dir) in Node; false for none
  onProgress: ({ path, loaded, total, cached }) => {},
  signal,                       // AbortSignal for the download
});
tf.info;        // modelId, revision, contexts, context, chunkMs (320 or 480), engine, engineVersion
tf.profile;     // the files this load needed
tf.delivery;    // requests, bytesDownloaded, filesFromCache, rangesResumed, store
tf.presets;     // [{ name, label, siteFa }] from calibration
tf.free();
```

A folder is refused when its manifest is not format 2 with `engine_format` 2 or format 3 with
`engine_format` 3, when its `min_sdk_version` is above 2.0.3, when a signature does not verify (folders
from the Quran Lab CDN must be signed), or when a file it needs does not match its size and SHA-256. A
file the manifest does not list is never read.

A format 3 manifest's `golden_tolerance` (per accelerator build, the differences from the CPU engine its
golden test may show) is part of the signed text: one line per build after the header lines, sorted by
the build key's UTF-8 bytes. A manifest signed without those lines still verifies, and its tolerance is
ignored (`folder.goldenTolerance` is null, every build exact). The web SDK runs the CPU engine only, so
the field never changes what it computes. `checkManifestSignature(m)` returns `{ valid, toleranceSigned }`.

## Raw layer: streams and heads

```js
const s = tf.createStream({
  heads: ['attr_ghunna', 'boundary'],   // added to the default (scorer heads + conf); or allHeads: true
  onChunk(chunk) {
    chunk.index; chunk.startMs; chunk.endMs;         // 320 ms chunks at c16, 480 ms at c24
    chunk.logProbs;                                 // Float32Array [8 x 38] at c16 (40 ms frames)
    chunk.attrGhunna;                               // Float32Array [16 x 5] (20 ms frames)
    chunk.frames;                                   // the decoded layer's frames of this chunk
  },
});
s.pushAudio(pcm);   // returns the chunks it completed
s.finish();         // the end of the take (a 1.05 s flush)
s.heads();          // the take's kept heads: { n40, n20, logProbs, inter1LogProbs, ... } (null when not kept)
s.reset();          // a new take
s.free();
```

`HEAD_SPECS` lists every head: `name`, `key` (the property), `width`, `rate` (40 or 20 ms), `kind`
(`log_softmax`, `softmax`, `logit`) and `classes`:

| Head | Width | Rate | Classes |
| --- | --- | --- | --- |
| `log_probs` / `inter1_log_probs` / `inter4_log_probs` | 38 | 40 ms | tokens.txt |
| `id_log_probs` / `timing_log_probs` | 38 | 20 ms | tokens.txt (timing: 0 = pause) |
| `gem` | 2 | 20 ms | single, held |
| `attr_tafkheem` | 3 | 20 ms | thin, heavy, low_heavy |
| `attr_ghunna` | 5 | 20 ms | none, plain, geminate, ikhfa, idgham |
| `attr_qalqalah` | 3 | 20 ms | none, sughra, kubra |
| `attr_face` | 4 | 20 ms | none, imala, tasheel, sakt |
| `boundary`, `conf` | 1 | 20 ms | logits: `sigmoidHead(a)` gives probabilities |

The engine computes only the heads asked for (engine API 3: a head nobody asked for is not computed,
and every computed head is the same bits whatever else is asked for); `allHeads` computes all twelve.
`stream.top2()` gives the engine's per-frame top-1 and runner-up. One stream is live at a time per model
module.

## Decoded layer

```js
const d = s.decoded();            // or tf.decode(heads) for heads from anywhere
d.frames[t];   // { top1, top1LogProb, runnerUp, runnerUpLogProb, margin } per 40 ms frame
d.tokens[i];   // { id, unit, frame0, frame1, startMs, endMs, peakFrame, logProb, runnerUp, runnerUpUnit,
               //   runnerUpLogProb, margin, confidence }
d.transcript;  // the units joined by spaces
d.ids;         // equal to the engine's greedy transcript (s.greedy())
d.words;       // tokens split at the "|" token; V4 rarely emits it, so use result.words for a known ayah
s.decoded({ k: 5 }).frames[t].ranked;   // the 5 best tokens of frame t, ranked, with log-probs and margins
s.topK('attr_ghunna', 5);               // any head with a distribution: { ids, values, margins } [frames x k], names
tf.topK(heads, 'log_probs', 38);        // the full ranked list, for heads from anywhere
```

Rules: ties go to the lower token id; a token is a run of equal non-blank top-1 frames; its numbers are
those of its peak frame; `confidence` is the mean `sigmoid(conf)` over its 20 ms frames. Times are the
model's output frame times from the start of the take.

## Tajweed layer

```js
const r = await tf.score(s.heads(), surah, ayah, { decoded: true });
r.sites[i];      // { class, check, status, pos, word, expected, expectedUnit, alternative, alternativeUnit,
                 //   llr: { final, inter1 }, fusedLlr, threshold, flagged, frameLo, frameHi }
r.madd[i];       // { word, unit, maddClass, ratio, count, displayCount, allowedLo, allowedHi, flagged, frameLo, frameHi }
r.qalqalah[i];   // { word, unit, score, threshold, flagged, frameLo, frameHi }; r.gemination the same
r.words[w];      // { word, score, threshold, flagged, best: { class, edit, expectedUnit, alternativeUnit, llr }, tokens,
                 //   startMs, endMs, issues: { sites, madd, qalqalah, gemination } }
r.path;          // { tokens, wordOfToken }: the scored path (the legal reading closest to what was heard)
r.summary;       // counts, plus words and wordsFlagged
r.settings;      // the effective settings it was scored with; r.wordLevel the word level (or null)
r.raw;           // the engine's whole result JSON: per window every class's alternative and LLRs
r.decoded;       // with { decoded: true }
```

- One entry in `sites` per scored window and class; `flagged` is true on the class the window reports.
  A threshold is a cut on the fused LLR (`a * llr.final + (1 - a) * llr.inter1`, clipped to [-30, 30]).
- `words[w]` is the engine's word level: `score` = the largest clipped fused LLR over every single edit
  inside the word (any class), `best` = that edit, `flagged` = `score >= threshold` (the word tau in force).
  `score`, `threshold` and `flagged` are null when the word check is off or the calibration has no word
  block.
- `score(heads, s, a, { backend: 'fp32' })` for heads that did not come from this engine (CoreML, an
  NPU, a server); the default is `int8` (this engine's heads).

## Settings

```js
tf.settings.setPreset('sensitive');
tf.settings.setClassPreset('cons_sub', 'very_sensitive');
tf.settings.setClassThreshold('vowel_sub', 1.25);   // -20 .. 20
tf.settings.setCheck('qalqalah', true);
tf.settings.setWord({ threshold: 5 });              // or { preset: 'beginner' }; clamped to calibration's range
tf.settings.setCheck('word', false);                // no word scores at all
tf.setRemoteConfig(configOrBlock);                  // the platform client does this for you
tf.effectiveSettings();   // { context, preset, sites: { cls: { enabled, threshold, preset, source, status } }, madd, ...,
                          //   dropped, refused }
tf.wordLevel();           // { enabled, preset, source, threshold, presets, floor, min, max } or null
```

Invalid app values throw `TajweedSettingsError` (code `invalid_app_option`); an invalid portal field is
dropped and listed in `dropped`, never the block. The context is fixed at load.

## Delivery helpers

`cachedReader({ baseUrl, headers, store, rangeSize, parallel, onProgress, signal })` is the reader
`load()` uses over HTTP; `profilePaths(manifest, { context })` the profile; `pruneCache(store,
[manifest])` removes cached files no kept manifest lists; stores: `cacheApiStore()`,
`indexedDbStore()`, `memoryStore()`, `dirStore(dir)` (Node).

## Platform

See the README's Platform section. `QuranLab.configure(options)` never throws for network trouble:
`ql.stopped` names an error-table code that stopped the network for this launch (a revoked key, a key
of the wrong type), `ql.lastError` the last failure. Recognition never depends on the network once the
model is cached.

## Recitation sharing

`enableSharing(ql, { lang, ask, idle })` returns a controller: `sessionCompleted()`,
`setSharing(on)`, `deleteShared()`, `recoveryCode()`, `impactLine()`. `ask: async (a) => ({ yes })`
lets the app show the sheet at its own time; the lines are always the SDK's (`copyFor(lang)`).
Elements: `<quranlab-consent>` (`QuranLabConsent.ask(...)`) and `<quranlab-sharing-settings>`
(`.controller = sharing`). Theme with `--ql-bg`, `--ql-fg`, `--ql-muted`, `--ql-accent`,
`--ql-accent-fg`, `--ql-radius`, `--ql-font` and `::part(sheet|title|body|primary|secondary|guardian)`.

### Takes in a row share one recording (2.0.3)

A take is one session the SDK listens to; a recording is what is shared: one Ogg Opus stream, one outbox
item, one session id. When a take ends while sharing is on, its recording stays open for the join window,
and a take that starts within it continues the same stream. Nothing changes in how an app starts and ends
its takes.

- **The join window:** the signed config's `flags.share_join_ms`, a whole number 0 to 10000 (ms); absent or
  anything else: 3000; 0: never join (`joinWindowMs(flags)`). A take joins when it starts at most that long
  after the previous take with audio ended, at the same input sample rate, with the app in the foreground,
  sharing on, and the same contributor, consent version and model as the recording. Otherwise the open
  recording closes (its last page with the end-of-stream flag) and the take starts a new one.
- **What also closes it at once:** the window passing, the page becoming hidden, sharing turned off (the queue
  is deleted, the open recording with it), 20 minutes of audio, 256 takes. With 30 s or less of room under the
  20 minutes, a joining take is held in memory until it ends: it joins when it fits, and starts a new recording
  when it does not; a recording is never cut inside a take.
- **The controller** (`enableSharing(ql)`): `closeRecording()` closes the open recording now, for an app that
  knows no take follows; `background()` and `foreground()` tell it the app left or came back (the platform
  client calls them from `ql.background()` and `ql.foreground()`, and the sharing pipeline listens to the page's
  `visibilitychange`, `pagehide` and `pageshow` itself). In Node there is no page: an open recording keeps the
  process alive until its window has passed, so call `closeRecording()` (or `background()`) before the app exits.
  `setSharing(true)` after `setSharing(false)` in the same page shares the next take again.
- **The pipeline** (`createSharing(options)` from `@quran-lab/tajweedformer/sharing`): `closeRecording()`,
  `background()`, `foreground()`, and `recorder` (`recording`: the open one or null; `takes`: its takes so far;
  `window`: the join window in force). The same three calls are on the module's `outbox`. Options:
  `clock` (wall ms), `timers` (`{ setTimeout, clearTimeout }` for the window), `lifecycle` (`{ document, window }`:
  where the page events come from), `onIssue(kind, code)` and `log(message)`.
- **A take** (`await sharing.startSession({ inputSampleRate, inputRoute, decode, startedAt })`): `push(pcm)`,
  `finish({ completed, endedAt })`, `abort()`, `id` (the recording's id: the same for every take that joined
  it) and `duration` (the take's seconds). `finish()` resolves to the take's audio in ms once it is stored; the
  recording may stay open. `completed` of the recording is that of its last take with audio, and a cancelled
  recording is shared from 2 s of audio in all.
- **Outbox items** (`outbox.items()`, `onChange`): `takes`, how many takes share the recording (1 for one
  take), and `takeList`: `null` for one take, else `'pending'`, `'sent'` or `'dropped'`.
- **The take list:** `[{ start_ms, gap_ms }]`, one entry per take in order: `start_ms` is where the take's first
  sample is in the stream (the recording's input samples before it, in ms, rounded down), `gap_ms` the wall
  time since the previous take ended, rounded to 100 ms (the first entry is `{ 0, 0 }`; a take without audio has
  no entry). It is kept in `takes.json` next to the recording's other files and sent once the recording has
  closed and every segment is uploaded: `POST /v1/uploads/{id}/takes` with the token and `x-qlab-contributor`,
  body `{"takes":[...]}`. The item is `uploaded` when its segments are, whatever becomes of the list: 2xx sent;
  404 (a server without the route, or an upload it does not know) and 410 dropped; 400 dropped, with the issue
  `takes:<code>`; 401 the token renewed and the same body sent again; anything else again later with the outbox's
  backoff, also after a page reload. A recording recovered after the page was closed keeps the takes that
  start before its last whole page.
