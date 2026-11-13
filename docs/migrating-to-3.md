# Migrating from 2.x to 3.0

SDK 3.0 is a pure inference SDK. It turns audio into the model's output and no longer judges a recitation:
there is no scorer, no tajweed settings and no verdicts. It is also a new, smaller API with the same five
concepts in every TajweedFormer SDK. This page says what changed, what an app that used verdicts now builds
itself, and what data the SDK gives it for that.

## Staying on 2.x

SDK 2.0.2 keeps working until Quran Lab retires SDK 2.x, which happens when 3.0 is released or shortly after;
there is no long overlap, so plan the move to 3.0 now.

A 3.0 SDK only loads model builds made for 3.0, and a 2.x SDK only those made for 2.x.

## The API: old name, new name

| 2.x | 3.0 |
| --- | --- |
| `QuranLab.configure({ key })` from `@quran-lab/tajweedformer/platform` | `await TajweedClient.create({ key })` from `@quran-lab/tajweedformer` |
| `TajweedFormer.load({ platform: ql })` | `await client.model()` |
| `TajweedFormer.load({ url })`, `{ files }`, `{ reader }` | none since 3.1.0: `await client.model()`. A model comes from Quran Lab's server through the Client (3.0.x had `TajweedModel.open(folder)`) |
| `TajweedFormer.load({ cdn: { revision } })`, pinning a revision | `await client.model('4.0.0')`: pin a model version |
| `tf.createStream({ sampleRate, onChunk })` | `model.session({ sampleRate, onChunk })`, or `await model.listen()` |
| `stream.pushAudio(pcm)` | `session.push(samples)` |
| `stream.finish()` then `stream.heads()` | `const heads = await session.finish()` |
| `stream.decoded()`, `stream.topK()`, `stream.greedy()` while streaming | `chunk.decoded`, `chunk.heads`; after the take `heads.decoded()`, `heads.greedy()`; top-K with the `topK` option |
| `stream.reset()` for the next take | a new Session: `model.session()` |
| `stream.free()`, `tf.free()` | `session.cancel()`, `model.close()` |
| `heads.logProbs`, `heads.attrQalqalah`, ... | `heads.get('log_probs').values`, `heads.get('attr_qalqalah').values`, ... |
| `tf.info`, `tf.tokens`, `tf.tokenName(id)`, `tf.calibration` | `model.id`, `model.version`, `model.contexts`, `model.tokens.name(id)`, `model.calibration` |
| `allHeads: true`, `heads: [...]` | `heads: 'all'`, `heads: [...]` |
| `enableSharing(ql)` from `@quran-lab/tajweedformer/consent` | `client.sharing` (nothing to call) |
| `sharing.setSharing(on)`, `sharing.deleteShared()`, `sharing.recoveryCode()` | `sharing.setOn(on)`, `sharing.delete()`, `sharing.recoveryCode` |
| the `ask` option of `enableSharing`, `sharing.answer(yes)` (your own consent UI) | none in this version: the sheet is the SDK's. `client.sharing.ask()` chooses the moment, `setWording` the words, `theme` the look; `setOn` is the settings switch only |
| `settings.controller = sharing` on `<quranlab-sharing-settings>` | `settings.client = client` |
| `ql.background()`, `ql.foreground()` | `client.background()`, `client.foreground()` (automatic in browsers) |
| `ModelFolderError`, `PlatformError`, `DeliveryError`, `EngineNotAvailableError` | `TajweedError` with a `code` |
| `dirReader(dir)` from `@quran-lab/tajweedformer/node` | none since 3.1.0: the entry is removed. A Node program makes a Client (`TajweedClient.create({ key, appId })`) and calls `client.model()` |

Gone with no replacement: `tf.score()`, `tf.expected()`, `tf.ayahCount()`, `tf.settings`, `setRemoteConfig`,
`effectiveSettings`, `presets`, `wordLevel`, the `settings` and `backend: 'fp32'` load options, the entry
points `./scorer`, `./tajweed`, `./platform`, `./consent` and `./sharing`, and
`dist/tajweedformer-scorer.*`. Everything the package exports is now in its one entry point.

From 3.0 to 3.1: if your code called `TajweedModel.open(...)` or imported `@quran-lab/tajweedformer/node`,
replace the call with `await client.model()` on a Client made with your app's key; the Model you get is the
same. The first start after the update downloads the model once more.

Other changes you will notice:

- Token times: a token has `firstMs`, `peakMs` and `lastMs`, each the start of a 40 ms frame. 2.x `endMs`
  was `lastMs + 40`.
- In browsers the engine runs in a Worker, so `push` returns at once and chunks arrive asynchronously
  (`session.chunks`, or `onChunk`). `finish()` returns a promise.
- One Client per page, and one open Session per Model.
- The response time (the context) set for your app on sdk.quranlab.ai still reaches the SDK; the tajweed
  settings set there do not.

## What your app builds itself if it showed verdicts

The SDK gives you, for each take: the heads (`await session.finish()`), the vocabulary (`model.tokens`), the
thresholds (`model.calibration`) and the expected units of the ayah (`model.reference`). The rest is yours.

1. **The expected units of the ayah.** `await model.reference.fetch()` once (it is a separate download of
   about 1 MB), then `await model.reference.units(surah, ayah)` gives the unit ids in reading order, with the
   word bar between words, and the word of each unit. The ids are those of `model.tokens`. This replaces
   `tf.expected()`; you do not need to run a phonemizer yourself.
2. **Alignment and the evidence at each site.** For each position of the expected sequence and each
   single-unit alternative of a class (a substituted, deleted or inserted unit), compute the full-sequence
   CTC forward log-probability of the expected sequence and of the alternative on `log_probs`, and again on
   `inter1_log_probs` prepared as `calibration.json.contexts.<ctx>.fusion.inter1_prep` says (the word bar
   merged into blank). The LLR of a head is log P(best alternative) minus log P(expected). Fuse the two with
   the class's weight, `a * llr(log_probs) + (1 - a) * llr(inter1_log_probs)`, clip to `fusion.clip`, and
   flag the site when the result is above `model.calibration.threshold(context, class, preset)`.
3. **Madd, qalqalah, gemination, words.** Madd counts come from `timing_log_probs` (the span a long vowel is
   held against the median short-vowel span, with the cuts in `contexts.<ctx>.madd`); qalqalah from the mean
   of `attr_qalqalah` classes 1 and 2 over the frames after the letter, against its `tau`; gemination from
   the mean of `gem` class 1 over the letter's span, against its `tau`; a score per word as
   `contexts.<ctx>.word` describes.
4. **Presets and overrides.** The four presets and their thresholds are in the calibration; which one a
   learner uses, and any per-class change, is your app's setting now.
5. **Statuses.** Each class in the calibration has a `status`: `validated`, `experimental` or `off`. 2.x did
   not flag `off` classes in release builds.

The calibration belongs to one vocabulary and one model: `model.calibration.json.tokens_sha256` and
`model_id` say which.

## Analytics after the change

The SDK still counts what it measures (takes, minutes, speech and silence, latency, tokens). The numbers
that came from the scorer (ayahs recited, checks and flags per rule) are now reported by your app, in two
lines after each take, and only if you want them on your dashboard:

```js
session.reportRecited(1, 2, 2);                        // surah, first ayah, last ayah
client.analytics.reportChecks('vowel_sub', 31, 1);     // rule, times checked, times flagged
```

Use the calibration's class names for the rules where they apply (`vowel_sub`, ..., `insertion`, `madd`,
`qalqalah`, `gemination`, `word`). Nothing identifying is sent: totals per day only.

## Sharing

Nothing to migrate for learners: a learner who agreed in 2.x is still sharing and is not asked again; a
learner who declined keeps the same count of asks. The sheet now appears after a finished take in which the
model heard speech (2.x asked after a scored take). If your app captures audio between takes, pass it to
`client.sharing.feed(samples, sampleRate)` so shared recordings do not start or end inside a word.
