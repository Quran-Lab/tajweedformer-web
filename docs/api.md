# @quran-lab/tajweedformer 2.0.2: API

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
`engine_format` 3, when its `min_sdk_version` is above 2.0.2, when a signature does not verify (folders
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
