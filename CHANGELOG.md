# Changelog

## 3.1.2

- **Changed: the sharing sheet and "What is shared" have the text of copy deck `2026-11-09.1` again.** Copy
  deck `2026-11-13.1` (consent `share-2026-11-09`), in eight languages. A learner who already agreed is not
  asked again, and their recordings keep the version they agreed to.
- Tests: the bundled decks are the published ones, by the SHA-256 of each file; the sheet and its guardian
  variant show `sheet.who` whole, and "What is shared" shows `what.detail` whole, in each of the eight
  languages (in Node with a stand-in for the page, and in headless Chrome where a developer has it; the
  public runner has no browser); a yes stored under `share-2026-11-12` (3.1.0 and 3.1.1) or under
  `share-2026-11-09` is kept with its version and without an ask, at the start, after many sessions and
  after a restart.

## 3.1.1

The sharing sheet has a new design. No word, no consent rule and no call changed.

- **Changed: how the sharing sheet looks.** `<quranlab-consent>` was the deck's lines stacked in one style
  with two outlined buttons; it now has the design the Apple and Android SDKs share. What a learner sees, top
  to bottom: the emblem with the name Quran Lab beside it, the title, the body, one card with what is shared,
  who receives it and how to stop (each line whole, with an icon), the hadith with its reference in a soft
  card, and the line on mistakes. At the bottom a bar stays in view while the text scrolls under it, with two
  buttons of the same size and shape: "Share my recitations" filled with the accent, "Not now" in a tint of
  the accent. On a viewport under 600 px wide the sheet rises from the bottom; on a wider one it is a card in
  the middle, at most 480 px wide. The disclosure card now comes before the hadith (3.1.0 had the hadith
  first), so that what is shared, who receives it and how to stop are on the first screen of a phone. Dark
  mode follows `prefers-color-scheme`. Arabic and Urdu are laid out right to left from the deck, whatever the
  page's direction, with their own line heights. The children's variant asks the guardian with a switch, and
  its share button stays disabled until the switch is on.
- **Changed: the page's styles no longer reach the sheet's type.** Sizes, weights and line heights are set
  inside the element, so a rule such as `* { font-size: 30px }` changes nothing in it. The sizes follow the
  browser's own text size (the learner's setting), not the page's root size. Before, its sizes were in rem,
  so a page that changed its root font size changed the sheet.
- What themes it is what themed it in 3.1.0, set on the element, on an ancestor or through `theme`: `--ql-accent`
  (the share button, "Not now", the icons; the two tints are made from it), `--ql-accent-fg` (the share button's
  label; when you do not set it, white when white has a contrast of at least 3 to 1 with your accent, else
  near-black), `--ql-bg`, `--ql-fg`, `--ql-muted` (the hadith's reference), `--ql-font` and `--ql-title-font`
  (font families), and `--ql-radius`, which is still the sheet's corner radius: 28 px by default now (16 px in
  3.1.0), and the cards, the buttons and the emblem follow it (18, 14 and 12 px at 28). When your accent does not
  reach 3 to 1 against its tint, "Not now" and the emblem's glyph take the text colour, and the icons do when it
  does not reach 3 to 1 against the card; when the browser asks for more contrast (`prefers-contrast: more`) the
  bar is 4.5 to 1, for these and for the white label. A theme changes no word, no line and no consent version.
  The parts of 3.1.0 (`sheet`, `title`, `body`, `primary`, `secondary`, `guardian`) are still there; the name
  Quran Lab is in none of them.
- **Changed: two defaults a themed page may notice.** `--ql-radius`, when the page does not set it, is now 28 px
  (16 px in 3.1.0), and a radius you set gives the sheet's corners with the cards, buttons and emblem following
  it (in 3.1.0 the buttons took 0.6 of it). `--ql-accent-fg`, when the page does not set it, is now white when
  white has at least 3 to 1 against the accent (4.5 to 1 under `prefers-contrast: more`), else near-black (in
  3.1.0 always white): with a light accent of yours, a yellow for one, the share button's label turns near-black
  unless you set `--ql-accent-fg`; a blue like the system's keeps a white label.
- Unchanged: the words (the eight decks of 3.1.0, `2026-11-12.1`, consent `share-2026-11-12`), when the sheet
  is shown and how often, what `QuranLabConsent.ask()` resolves with, Escape as "Not now", a click beside the
  sheet doing nothing, and the focus kept in the sheet (it now starts on the name, first on the sheet, never
  on a button). The thank-you note and `<quranlab-sharing-settings>` take the same colours, corners and type;
  their structure is unchanged.
- Tests: the name and the order of the sheet's parts in all eight languages, and in headless Chrome (run
  where Chrome is installed; the public runner has none): both buttons the same size in every language at
  320, 390 and 1280 px wide and at twice the text size, the share button disabled until the guardian's switch
  is on, the direction from the deck, the colour fallback of a light accent, a page with hostile styles that
  changes nothing in the sheet, Escape, a click beside the sheet, and focus. The test that every deck line is
  on the sheet whole, in all eight languages, is the one of 3.1.0, unchanged.

## 3.1.0

A model comes only from Quran Lab's server, through the Client.

- **Removed: opening a model folder the app supplies.** `TajweedModel.open(folder)` is gone, and with it the
  package's `@quran-lab/tajweedformer/node` entry and its `dirReader`. A model comes from Quran Lab's server
  through the Client: `const model = await client.model()`, and `client.prefetch()` to download it ahead of
  use. Why: the model is Quran Lab's to deliver, verify and update, and an app that carries its own copy cannot
  be told of a newer or a withdrawn build. A Node program uses the Client as a page does
  (`TajweedClient.create({ key, appId })` with the app's desktop key; [examples/node.mjs](examples/node.mjs)).
  If your code called `TajweedModel.open(...)`, replace that call with `await client.model()`; nothing else of
  the Model changes. The constructors of `TajweedClient` and `TajweedModel`, never part of the API, now refuse
  to be called (`invalid_argument`).
- **Changed: the Client opens only a model it downloaded itself on this device.** It keeps a record of each
  download, bound to the device: in a browser with a key that cannot be exported, kept in IndexedDB; in Node,
  which has no such store, with a key derived from the machine and the user. Model files that are in the
  Client's storage without a valid record are not opened: they are deleted and the model is downloaded. So an
  install that updates from an earlier version downloads the model once more; without a connection at that
  first start `client.model()` fails with `needs_connection`. After that download a learner without a
  connection keeps working, as before. In a browser with no IndexedDB at all the record lasts for the page
  load, so every load downloads the model; where IndexedDB is there and fails, the call fails with
  `storage_failed`, nothing is deleted, and the next call tries again.
- **Changed: model files are requested with the install's token.** Every request for a model file carries
  `authorization: Bearer <token>`, the token the SDK already uses for its other calls, and the key as before.
  A token that has run out is renewed once and the request repeated once. A redirect is never followed.
- **Changed: an app Quran Lab has refused does not run the model.** When an answer of Quran Lab refuses the
  key or the app with one of the reasons `key_revoked`, `key_unknown`, `app_not_allowed`, `origin_not_allowed`,
  `key_type_mismatch`, `app_blocked` or `developer_not_approved`, `client.model()` and `client.prefetch()` fail
  with that refusal's error (`invalid_key` for a revoked or unknown key, else `server_rejected` with the
  reason), also at a later start without a network. It ends when Quran Lab accepts the key again; a refusal
  of a model request ends only when a later model request is served. In a page, a refusal that the browser
  hides (Quran Lab answers CORS only for a key's own origins) is read from the origin check and counts the
  same. A Model that is already open keeps running until your app closes it. An answer without one of these
  reasons never stops a model on the device: no connection, a failure or a limit of the server, a network the
  server does not serve, `sdk_too_old`, `invalid_key` without a reason.
- **Changed: a refused app's model is removed.** When Quran Lab refuses the key or the app (a revoked key, a
  paused or blocked app), the SDK stops running the model and removes the downloaded model from the browser.
  Once the key is accepted again the model is downloaded again. The removal takes what `removeModels()` takes
  (every model build in the SDK's stores, its records and partial downloads) and nothing else: the sharing
  state and unsent recordings stay. A removal that cannot be done at once is done at the next start, before
  anything else.
- **Changed: a model on the device keeps running when a model request fails at a start.** When the CDN
  answers the request for the model's manifest with an error that is not one of those refusals (a limit, a
  failure, a network it does not serve, a refusal of this install's request such as
  `model_attestation_required` or `model_not_allowed`), the model a download left opens from the device.
  Before, such an answer made `client.model()` fail.
- `server_rejected` has two new reasons for a refused model request, `model_attestation_required` and
  `model_not_allowed`. The daily limit of model downloads is `download_failed` with its own sentence. The
  message and fix of `app_blocked` say that the app is blocked by Quran Lab or paused by its developer. The fix
  sentence of `model_missing` no longer names a folder.
- **Changed: the sharing sheet's text.** The sharing sheet and "What is shared" now say that no human ever
  listens to your recordings: only software learns from them. A learner who already agreed is not asked
  again, and their recordings keep carrying the consent version they agreed to; a learner asked from now on
  agrees to `share-2026-11-12` (copy deck `2026-11-12.1`, eight languages).

## 3.0.2

A fix for recitation sharing: a recording that was waiting when the learner turned sharing off is never
uploaded later.
No change of the API.

- **Fixed: recordings that were waiting when sharing was turned off could stay on the device and be uploaded
  when sharing was turned on again** (the first "Known" point of 3.0.1). A queue of recordings exists through the
  Client since 2.0.1, so each of these begins with that version unless it says otherwise:
  - Nothing on the device said under which consent a recording was made. Whatever was left in the queue was
    uploaded once sharing was on again.
  - Turning sharing off in a page that had not recorded a take deleted nothing: the queue is loaded by the
    first take, and the off only stopped a queue that was loaded.
  - Nothing deleted leftover recordings when the page started with sharing off. The console line of 3.0.1 that
    said such a recording "is deleted at the next start" was not true.
  - When the device's storage refused to delete a recording (a file in use), the off call of 3.0.1 tried again
    recording by recording and took 21 s for nine recordings where it promises 3 s. Before 3.0.1 the off call
    failed at the first such recording and left the others.
  - In the same page, a recording the off call could not delete was read back from storage and uploaded when
    sharing came on again. This form is 3.0.1's own; before it the failed off call left the whole queue.
  - "Delete what I shared" stopped the queue late: in 3.0.1 after it had looked up the contributor key, so an
    upload pass that ran in that moment still sent a waiting recording; before 3.0.1 only after Quran Lab had
    answered.
  - The off of an accepted "delete what I shared" was stored after Quran Lab's answer (3.0.1), so a page that
    was closed in between started again with sharing on.
  - A write of the learner's answer that the device refused (localStorage over its quota) was neither reported
    nor tried again, and the page went on reading the old answer: an off that could not be stored read as on
    in the same page. In Node the failed write was thrown out of `sharing.setOn(false)` before the uploads
    were stopped. Since 2.0.0 (the second "Known" point of 3.0.1).

  The shared test for this (nine waiting recordings whose deletion fails; the page ends where the case says
  so) fails on 3.0.1 in every run of each of its five cases, and where sharing comes on again all nine
  recordings are uploaded (317,344 bytes of audio in the test). On 3.0.2 every case passes 20 of 20 runs and
  the test's server receives no request for a recording of an earlier consent.
  Where this ran: the queue's part (a recording with another count is never loaded for upload and is deleted
  by the next page) ran in a real browser, headless Chrome on IndexedDB, on a developer's PC and not on the
  public runner. The rest (the count stored in localStorage, the deletion at a page's start, the order of
  "Delete what I shared") ran in Node with a stand-in for the browser's store, not in a browser.
- **The rule now.** The SDK keeps a count of the learner's changes of mind (sharing turned off, an accepted
  deletion, sharing coming on) and stores it in the same write as the learner's answer. Every recording carries
  the count it was begun under, on the device only: it is not part of what is uploaded. A recording whose count
  is not the one in force is never loaded for upload and is deleted when the page starts, before every upload
  pass and when sharing is turned off, also in a page that has not recorded a take. Quran Lab's own pause of
  sharing (the signed config) is not the learner's no and keeps the queue. A queue left by an earlier version
  carries no count: it is uploaded as before while sharing stayed on, and deleted at the first start when it
  did not.
- **"Delete what I shared", the order.** Before anything else, and before any wait, the call stops the uploads
  and stores the learner's answer as off. A page that starts after this one was closed there finds sharing off
  and deletes the waiting recordings. So does a second page of the same site that loads while the deletion is
  being asked: if Quran Lab then does not take the deletion, sharing is on as before and those recordings are
  gone, not uploaded. What your app sees does not change while Quran Lab is asked: `isOn` stays what it was;
  accepted, it turns false once; not taken, the earlier answer is stored again and nothing changed. When the
  device cannot store the off (a full quota), Quran Lab is asked all the same, and the off is stored as soon
  as the device can: once more when the queue is deleted, and with every later write of the answer. One case
  remains and is accepted: the off was stored, Quran Lab does not take the deletion, the write that puts the
  earlier answer back fails, and the page ends before a retry succeeds. Sharing is then off at the next
  start, never an upload; the learner turns it on again with the switch and is not asked again.
- **When the device cannot store the learner's answer**, the page goes by the answer in force, not by the
  stored one: an off holds at once, a recording made after sharing came on again is uploaded, and the answer is
  stored with the next write. A page that starts meanwhile has only what is stored.
- The off call keeps its 3 s when the device refuses to delete: it tries again for at most 1.5 s. What is left
  is never uploaded and is deleted at the next pass or start, with one console line per recording.
- In production the sharing sheet has so far been offered on iOS and macOS only.

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
