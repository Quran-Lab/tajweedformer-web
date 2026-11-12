# Changelog

## 3.0.1

A fix for recitation sharing, and one change of behaviour that comes with it.

- **Fixed: sharing turned off while a recording was being uploaded.** Since 2.0.0, when a learner turned sharing
  off, or deleted what they shared, while a recording was on its way up, the SDK did not abort a request to
  Quran Lab that was in flight (the start of an upload, a batch of upload URLs, a take list). The off call waited
  for the answer, and with the answer the SDK wrote the recording's state and sent the next segment of that
  recording, after the learner had turned sharing off. An upload pass that ran while the queue was being deleted
  could also leave a file of the recording on the device and make the off call fail. A new test that holds each
  kind of request in flight and then turns sharing off, or deletes, found it: on 3.0.0 it passed 56 of 240 runs,
  and in 85 runs a segment of audio was sent after the call. Now every request is aborted, the SDK starts no
  request and writes nothing once the call is made, the call returns within 3 s whatever was in flight, nothing
  unsent is left on the device (also after the request that was in flight has come back), and turning sharing on
  again works at once: 240 of 240 runs, with 0 bytes arriving at the test's stub after the call. What that
  cannot promise: bytes of the segment in flight that the browser or the system had already buffered for the
  connection may still go out after the abort, and that can be the whole segment. Measured on a phone with the
  Android SDK (Android 11), the system's buffer held 2,220,032 bytes when the request was ended, which is more
  than one segment; a browser's buffer is not measured. Nothing after that segment is sent. One more case of it, found while testing the fix: a write to the device's storage that
  took longer than the off call waits (3 s) could bring the state file of a deleted recording back afterwards
  (its ids and counts; no audio). Such a write is now deleted again when it comes back. In production the
  sharing sheet has so far been offered on iOS and macOS only, so no learner could share from a web app yet.
- **Changed: `sharing.setOn(on)` returns a promise.** Off resolves when the uploads in flight are aborted and
  the unsent queue is gone. An app that ignored the call's return value is unaffected; one that counted on the
  queue being gone as soon as the call was made must await it.
- **Changed: an accepted "delete what I shared" turns sharing off** (`sharing.delete()`; `isOn` is false
  afterwards), on every platform from 3.0.1. The learner turns it on again with the switch, is not asked again,
  and shares under a new contributor from then on. In 3.0.0 `isOn` stayed true after a delete although that page
  uploaded nothing more until it was loaded again. A delete Quran Lab does not take (an error, or no answer)
  changes nothing: the promise rejects, sharing is still on, nothing on the device was deleted and the queue goes
  on. Uploads stand still while Quran Lab is asked.
- **Fixed: `client.diagnose()` with no Model open** reports the `context` and the `backend` a Session would run
  on, from the model on the device and the signed config (both were null).
- **Known, fixed in 3.0.2: recordings that were waiting when sharing was turned off can stay on the device
  and be uploaded later.** Turning sharing off deletes the unsent queue only in a page that has already
  recorded a take: the queue is loaded by the first take. When sharing is turned off in a later page before any
  take, when the page or process ends between the off and the deletion of the queue (a closed tab, a kill),
  or when the device's storage refuses to delete a recording, the waiting recordings stay on the device.
  They are not deleted at the next start, and they are uploaded when the learner turns sharing on again: in a
  test with nine such recordings all nine went up. While the storage refuses to delete, the off call can
  also take longer than its 3 s. This is as old as the queue itself (2.0.1). In production the sharing
  sheet has so far been offered on iOS and macOS only, so no learner could have such a queue from a web app.
- **Known, fixed in 3.0.2: an off the device refuses to store.** When the device refuses to store the
  learner's answer at the moment sharing is turned off (a full storage quota in a browser, a disk that
  cannot be written under Node), a browser page reads sharing as on again, and under Node the error leaves
  `sharing.setOn(false)` before the uploads are stopped; the write is not tried again. This has been so since
  2.0.0. In production the sharing sheet has so far been offered on iOS and macOS only, so sharing is not on
  for web apps.

## 3.0.0

A breaking release: the SDK is a pure inference SDK with a new, smaller API. How to move an app from 2.x is in
[docs/migrating-to-3.md](docs/migrating-to-3.md).

- **No scorer.** `tf.score()`, the verdict types, the tajweed settings and presets, the expected-ayah calls, the
  scoring-only build (`./scorer`, `dist/tajweedformer-scorer.*`) and the handling of the signed config's tajweed
  block are removed. The SDK gives the model's output; a judge is the app's own. The calibration
  (`model.calibration`) and the expected units of each ayah (`model.reference`) ship as read-only data for it; the
  SDK applies neither.
- **Five concepts, the same names in every TajweedFormer SDK:** `TajweedClient`, `TajweedModel`,
  `TajweedSession`, `TajweedHeads`, `TajweedBackend`. Call order: Client, model, listen, read. The package has one
  entry point (and `./node` for the folder reader); `./platform`, `./consent` and `./sharing` are folded into it,
  `./scorer` and `./tajweed` are gone, and everything else is internal. `TajweedFormer`, `TajweedStream` and
  `QuranLab` are no longer exported.
- **One call from the microphone to the output.** `await model.listen()` asks for the permission, captures at
  the device's rate with an AudioWorklet and carries that rate to the Session. A refused permission is the error
  `microphone_denied`; an interruption pauses the take (`interrupted`, `resumed`); a device change reopens the
  microphone and the take goes on; a hidden or left page ends the take (`ended: hidden`). `Microphone` is public
  for apps that want samples only.
- **Without a microphone.** `model.sampleClips` lists the model's sample clips, and `listen({ from })` takes a
  clip or samples in place of the microphone, at real-time pace or as fast as possible.
- **Speech started, speech ended.** Each chunk says whether it holds speech; `session.events` raises
  `speechStarted` and `speechEnded` from the model's own output, and the `endOnSilenceMs` option ends the take
  when the learner stops.
- **Settled output.** Each chunk carries the decoded layer of the take so far, with `settled` (the count of
  leading tokens that will not change) and `isFinal` on the last one.
- **Off the main thread.** In browsers the engine runs in a Worker (2.x ran it on the page's main thread).
  `push` posts the audio; chunks, events and the take's Heads come back as messages. Node runs it in the calling
  thread.
- **Models by version and build.** A model has a version (`model.version`, "4.0.0") and each upload of it is a
  build (`model.build`). The SDK downloads by the build's URL, checks the signed version, refuses a manifest
  without one, and reports the version and the build in telemetry. `client.model('4.0.0')` pins a version.
- **Ready before the learner taps.** `client.prefetch()` (progress in bytes, resumable, unmetered only on
  request), `client.model()` opens and warms the engine, `await client.storage()`, `client.removeModels()`. A first
  run with no network fails at once with `needs_connection`.
- **`client.diagnose()`**: one report (SDK version, key, config, model, context, backend, microphone, storage,
  last error) with no audio, text or identifier in it.
- **Bounds.** A take holds at most 20 minutes of audio: there it ends by itself (`ended: limit`) with its
  Heads kept. `chunks` keeps at most 256 chunks and `events` 64 events waiting for a reader, the oldest
  dropped first; `client.diagnose()` counts the dropped chunks. A microphone take whose device decodes slower
  than real time ends with `engine_failed` once 30 s of audio wait.
- **`npm run proof`**: with a 3.0 model folder, the 35 conformance clips bit for bit and every sample clip
  through the public API, in Node and in headless Chrome with the engine in a Worker.
- **One definition of speech.** A frame is speech when the recognition head or the timing head shows a sound
  on it, so a held vowel does not end a take; `speechEnded` comes when the window has passed after the last
  such frame. `endOnSilenceMs` is off or 500 to 60000. The same frames give the speech and silence seconds
  of the usage statistics.
- **`vite build` with no line of config.** Nothing a bundler follows from the browser entry imports a Node
  built-in (Node has its own entry under the `node` condition of `exports`), and the Worker is written in
  the form bundlers find. `examples/vite` is a plain Vite project; `npm run example:build` builds it.
- **A refusal says what to do.** `server_rejected` carries the message and the fix of the server's reason.
  A page whose origin is not on its key (which gets no answer from the API) is told so, through Quran Lab's
  origin check, asked once per page load and only when a request got no answer.
- **`runtime_unsupported`** for a browser or a Node without something the SDK needs (it was
  `model_incompatible` for a runtime without Ed25519).
- **`diagnose()`** has `droppedChunks` and `connection`; `prefetch({ unmeteredOnly })` waits on a metered
  connection and with none, and downloads where the runtime cannot tell.
- **`npm run check:package`**: what `npm publish` would ship holds the README, AGENTS.md, the CHANGELOG, the
  type declarations and every file the `exports` map names.
- **Errors.** One type, `TajweedError`, with `code`, `message`, `fix` and `docs`; 24 codes shared by the four
  SDKs.
- **One Client per page.** A second one while the first is open is the error `client_exists`.
- **Telemetry.** The cohort is the model version, its build, the context and the backend; the fields that came
  from scoring are gone. New, measured by the SDK: takes, seconds of audio, speech and silence, tokens per head,
  compute seconds. New, reported by the app if it wants them: `session.reportRecited(surah, ayahFrom, ayahTo)`
  and `client.analytics.reportChecks(rule, checked, flagged)`.
- **Recitation sharing** is reached through `client.sharing` (`isAvailable`, `isOn`, `setOn`, `ask`, `feed`,
  `items()`, `summary`, `delete`, `recoveryCode`, `setWording`); the settings element takes the Client. Its rules
  are unchanged: Quran Lab decides whether it is offered, at most three asks, a yes is never asked again.
  New: `sharing.feed(samples, sampleRate)` gives shared recordings a lead-in of up to 1 s and a tail of up to
  0.5 s from audio the app captures outside takes; the session record carries a per-install count of recordings
  and the gap since the previous one; a take list the server refuses as a bad request stays queued and is
  retried instead of being dropped.
- Takes in a row share one recording: when a take ends, the shared recording stays open for a join window (3 s, or
  the signed config's `flags.share_join_ms`), and a take that starts in it at the same sample rate continues the
  same Ogg stream. The take boundaries are sent after the last segment. A recording never holds more than 20
  minutes: where its audio reaches that, also inside a take, it closes as a whole recording and the take goes
  on in a new one.
- After every take a shared recording stays open 1.5 s for a tail from `sharing.feed`; only fed audio is
  recorded in that time.
- The developer site is sdk.quranlab.ai.

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
