# Changelog

## 2.0.3

Takes in a row share one recording. An app often stops and starts its takes while the learner is still reciting,
so shared recordings began or ended in the middle of speech. The session (`startSession`, `push`, `finish`), your code and what a learner is asked do not
change.

- The join window. When a take ends while the learner shares, the shared recording (its Ogg stream, its item in the
  outbox, its upload) stays open for a few seconds: `flags.share_join_ms` of Quran Lab's signed config, a whole number
  from 0 to 10000 ms; 3000 when the flag is absent; 0 never joins, which is 2.0.2's behaviour. A take that starts
  within the window at the same input sample rate, with the same contributor, consent and model, continues the same
  stream: no new headers, the encoder and the resampler keep their state, segments are cut by the same plan counted
  across the takes, the bitrate ladder applies as before. The pause between the takes gets no audio. The bytes are
  those of one continuous encode of the same audio.
- Otherwise the recording closes as a session ended in 2.0.2 and the take starts a new one. It also closes at once
  when the window passes, when the page is hidden (`visibilitychange` and `pagehide`; `background()` does it too),
  when sharing is turned off (the queue is deleted, the open recording with it), and at 20 minutes of audio or 256
  takes. `completed` is the last take's; the 2 s minimum of a cancelled session counts the whole recording.
- The 20 minute cap never cuts a take. With 30 s or less of room, a joining take is held in memory until it ends: it
  joins when it fits, else the recording closes without it and the take starts a new one with all its audio.
- Take boundaries. A recording of two or more takes keeps where each take starts in the stream and the pause before
  it (rounded to 100 ms), and sends them once after its last segment: `POST /v1/uploads/{id}/takes`. The recording is
  uploaded when its segments are, whatever becomes of that list: a server without the route (404) or a deleted
  upload (410) drops it, a refused list (400) drops it with an issue report, 401 renews the token, and 429, 5xx or
  no answer keep it for a retry with the same body, also after the page loads again. A recording of one take sends nothing.
- A page closed between takes or inside one: the recording is closed at its last whole page, as before, and its take list keeps the takes that
  start inside what was recovered.
- Outbox items have `takes` (the count) and `takeList` (`pending`, `sent`, `dropped` or null). New calls:
  `closeRecording()` (no take follows: close now), `background()` and `foreground()` on the sharing controller,
  the pipeline of `createSharing` and the sharing module's `outbox`. `startSession()` resolves to a take whose
  `id` is the recording's, the same for every take that joined it. The full list is in `docs/api.md`.
- Fixed: a learner who turned sharing off and on again in the same page shared nothing until the next page
  load.
- Unchanged: consent (a yes is never asked again, at most three asks; the ask after a finished take leaves the
  recording open), one upload at a time and in order, the bitrate ladder, stopping and deleting. Telemetry counts a
  session per take.
- `docs/platform-client.md`: the 2.0.3 text.

## 2.0.2

- Fixed: model manifests with a `golden_tolerance` field did not verify. `verifyManifestSignature` (and `ModelFolder.open`, `TajweedFormer.load`) built the signed text without the
  `golden_tolerance` lines that the signature covers, so the current V4 build (4.0.0, the build with the CoreML
  programs and deltas) was refused as unsigned; manifests without the field were not affected. The signed text now
  has one `golden_tolerance <build> <tokens> <sites> <words>` line per build, sorted by the build key's bytes, after
  the header lines, exactly as Quran Lab signs it. A manifest whose signature does not cover a tolerance still
  verifies without it, and the tolerance is then ignored.
- Tests on the two real signed V4 manifests (both builds): each verifies with the pinned key, and one changed byte
  in a header value, a tolerance value or a file line is refused. The same cross-check runs in every
  TajweedFormer SDK.
- `docs/platform-client.md`: the 2.0.2 text (the accelerator failover rules of the Android and Apple SDKs; nothing
  changes for this SDK, which has no accelerator).

## 2.0.1

- Recitation sharing is offered where Quran Lab decides, per app, in the signed config; the `contributions`
  option is ignored, and without a signed config nothing is offered. Nothing is recorded or sent before the
  learner answers "Share".
- Fixed: web sessions were never uploaded in 2.0.0 (the consent controller passed the wrong device, token and
  decode fields to the uploader).
- Asking: the sheet is shown at most three times per install, ever (the count carries over from 2.0.0);
  "Not now" may lead to a later ask within those three, a yes ends asking forever, and so does turning
  sharing off after a yes (the app's settings can still turn it on). A yes persists across copy decks, app
  wording and the upgrade from 2.0.0 (no sheet, no pause), and each session carries the version the learner
  agreed to. Stopping and deleting work whatever the learner agreed to.
- The consent sheet, default or yours: `theme` (or CSS custom properties) for the SDK's sheets; your own UI
  with `ask: fn`, the SDK's localized strings and `sharing.answer(yes)`; your own wording with `setWording`,
  recorded as consent version `custom-<24 hex>` with its SHA-256 sent with each session for Quran Lab to review.
- Copy deck 2026-11-09.1 (consent `share-2026-11-09`) in eight languages: no longer says the recited ayah is
  sent (it is not), and deletion from Quran Lab's servers is immediate.
- Adaptive Opus bitrate on bad networks: 192, 96, 64 or 32 kbit/s, lowered when uploads fail or back up and
  raised again when they succeed, changed between segments of the same Ogg stream; each segment's bitrate is
  in the outbox items (`segmentBitrates`).
- Telemetry: deltas during the day (every 15 minutes while the page is visible and when it is hidden), each
  with a random `report_id`; new aggregate counters (launches, ayahs, ayahs per surah, words, tajweed rule
  checks and flags, sharing sheet outcomes). Register once per UTC day per install.
- Outside production (the new `debug` option, or `NODE_ENV` not `production`), one warning per load when
  Quran Lab's signed config names a newer SDK: "Quran Lab SDK X is available (severity), you have Y: URL".
- `docs/platform-client.md`: what the SDK sends to Quran Lab, when, and what an app can change.

## 2.0.0 (first public release)

- TajweedFormer V4: `TajweedFormer.load` opens a signed `sdk/v4.0` folder (by URL, files or a
  reader); `createStream` streams audio through the exact engine in WebAssembly and keeps every head;
  `score` returns per-site tajweed verdicts with their evidence.
- `@quran-lab/tajweedformer/scorer`: the scorer alone, for heads computed elsewhere.
- Tajweed settings in three layers (app code, the portal's block, `calibration.json`), identical in
  every TajweedFormer SDK.
- Bit-exact: the 35 conformance clips give the engine's expected outputs, every output of every
  chunk, through this SDK's own API.
