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

**Runs where the web runs**<br>One script tag, or the npm package that wraps it, which also runs in Node for desktop apps. In the browser the engine runs with WebAssembly SIMD in Quran Lab's frame on your page and keeps itself current.

</td>
</tr>
<tr>
<td valign="top">

**Private by default**<br>It listens in the learner's browser, not on a server. A recording leaves it only when the learner agrees to share it.

</td>
<td valign="top">

**Nothing to host**<br>The SDK downloads the model (55.5 MB) from Quran Lab's servers, verifies it and keeps it up to date.

</td>
<td valign="top">

**Data for your own judge**<br>The SDK scores nothing. The model's thresholds come with it as read-only data, and the expected units of each ayah where the served build carries them, so your app can judge a recitation its own way.

</td>
</tr>
</table>

## Why TajweedFormer

- **Made for the Quran.** Trained on Quranic recitation, with its own sound units and heads for what tajweed is about.
- **Feedback in the moment.** Output streams while the learner recites, so your app can respond on the word itself, not after the take.
- **One engine on every platform.** The same engine runs the [web](https://github.com/Quran-Lab/tajweedformer-web), [Android](https://github.com/Quran-Lab/tajweedformer-android), [iOS and macOS](https://github.com/Quran-Lab/tajweedformer-apple) and [Windows and Linux](https://github.com/Quran-Lab/tajweedformer-c) SDKs, all set from one portal.
- **Free, and it stays free.** Quran Lab is a non-profit waqf: the SDKs and models are never sold. The licence, NPL-1.3, and Quran Lab's access terms ask three things: no paywall on model features, no output presented as an authoritative religious ruling, and no training of other models on the model or its outputs. A line telling learners that automatic feedback can be wrong is encouraged, not required.

## Built for AI developers

Copy the setup prompt from [sdk.quranlab.ai](https://sdk.quranlab.ai) and paste it into your coding assistant. That one prompt sets everything up: the package, your key, and the first calls. [AGENTS.md](AGENTS.md), beside this README, gives the assistant the complete API, so the code it writes uses names that exist. Prefer to do it by hand? Get a key in the portal and start below.

## At a glance

- **One script.** A site includes the loader; it opens a small hidden frame of Quran Lab's on the page. The model,
  its key and its files live in that frame's Worker, on Quran Lab's origin: the site's own scripts, other
  third-party scripts and extensions limited to the site cannot read them.
- **Evergreen.** The loader picks the engine build Quran Lab's signed config names for your site (automatic, or
  pinned in the portal for a while), and runs it only after checking Quran Lab's Ed25519 signature and every
  file's SHA-256 (with WebCrypto's Ed25519 where the browser has it, else the vendored @noble/ed25519 2.3.0, MIT, so
  Chrome before 137 and Safari before 17 work too). The public API has a number, 4; engine updates never change it.
- **A wrong device clock changes nothing.** The SDK judges its signed config and the model's lease by Quran Lab's
  time, not by the device's clock.
- **Your origins only.** The frame is shown only on the origins your key lists (the browser enforces it), it checks
  its parent's origin itself, and the server checks that origin again for every request.
- **The same API as 3.x** (Client, Model, Session, Heads, Backend), the same names as the Android, Apple and C SDKs.
  `NAMES.md` lists every public name.
- **Any network.** Downloads and uploads go out on whatever network the device has: the SDK never waits for Wi-Fi
  (from 4.0.2 `prefetch()` has no network option). `diagnose().connection` reports the network and holds nothing back.
- **Microphone in your page.** Capture stays in your page (one permission prompt, yours); the samples are passed in.

## Install

One script tag. The loader is hosted by Quran Lab and keeps itself current; it opens Quran Lab's frame on your page,
and the engine and the model run there.

```html
<script src="https://web.quranlab.ai/4/loader.js" crossorigin="anonymous"></script>
```

Or from npm, a thin wrapper that loads the same hosted loader and hands out the same classes (the model never comes
through the package):

```sh
npm install @quran-lab/tajweedformer
```

```js
import { TajweedClient } from '@quran-lab/tajweedformer';
```

## Before you start

| | |
| - | - |
| **Key** | A web key from [sdk.quranlab.ai](https://sdk.quranlab.ai), locked to your site's origins: Quran Lab's frame is shown only on the origins your key lists. For local work use the app's development key, with `http://localhost:*` among its origins. |
| **Page** | A secure context: `https`, or `http://localhost`. If your site sends a Content-Security-Policy, add the lines of "The Content-Security-Policy lines your site needs" (after the quick start). Audio starts only after a tap or a click. |
| **Browser** | WebAssembly with SIMD and AudioWorklet, in a current Chrome, Edge, Firefox or Safari. Node 20 or later runs the same API for a desktop app, with a desktop key and its app id (see "Node"). |
| **Hosts** | Quran Lab's frame comes from Quran Lab's servers. Your Content-Security-Policy names them all (see "The Content-Security-Policy lines your site needs"). |
| **Check** | The first model open of a page session passes an invisible bot check inside Quran Lab's frame: a learner never sees a check or a box. When the check gives no clear answer, the learner is never refused. |
| **Download** | The first visit downloads the model, encrypted, into Quran Lab's frame: 55.5 MB, once (68.4 MB stored); later visits read it from the frame's storage. A browser that blocks the site's storage keeps nothing: there the model is downloaded at every visit. |
| **Offline** | The first visit needs a connection; after that the model opens with no connection, and while online the SDK keeps itself up to date in the background. A Model that is open keeps running. |
| **Model** | The engine, the model and its lease live in the Worker of Quran Lab's frame: your page's scripts never see the model's files. When Quran Lab refuses the key or the app, the model is removed from the browser. |
| **Analytics** | Anonymous counts and durations (never audio, text, names or device identifiers) and reports of the failures your learners hit are always sent; you find them at sdk.quranlab.ai under your app, Problems included. |
| **Takes** | A Model has one open Session (one take) at a time; the next take is a new Session. A take holds at most 20 minutes of audio. |

## Quick start

```js
const client = await QuranLab.TajweedClient.create({ key: 'qlk_v1_...' });   // your web key from sdk.quranlab.ai
const model = await client.model();                 // the first visit downloads the model once for your site
async function take(from) {                         // one take: the microphone, or a sample clip
  const session = await model.listen({ from, endOnSilenceMs: 1500 });   // ends when the learner stops
  for await (const chunk of session.chunks) document.querySelector('#heard').textContent = chunk.decoded.text;
}
document.querySelector('#listen').onclick = () => take();                // the microphone needs a tap
```

The same as a page you can run: [examples/quickstart.html](examples/quickstart.html). Audio you already have:
`model.session()` and `session.push(float32Samples)`, or `model.listen({ from: samples })`. When your app judges a
take, `session.reportRecited(surah, from, to, { outcome })` (see "Recited ayat").

## Errors

Every failure is a `TajweedError` with a `code` from the shared catalogue, a `message` and a `fix`. From 4.0.2 it also
has `errorCause`: short tokens that say where it failed and why, the same ones as Quran Lab's error report. An app can
log them, choose its words by them, and send them in a support request.

```js
try {
  await client.model();
} catch (e) {
  // e.code === 'needs_connection', e.errorCause: { stage: 'download', reason: 'network', needs: 'model' }
  if (e.code === 'needs_connection') show(e.errorCause?.needs === 'lease' ? 'Connect to continue' : 'Connect to download the model');
}
```

- `stage` and `reason`: where and why (`download` and `network`: a model file got no answer at all).
- `httpStatus`, `errorName`, `errorCode`: the HTTP status, the error's class and its code, when there are any.
- `needs`, on `needs_connection` only: `model` when the model files are not on the device yet (connect to download),
  `lease` when the model is on the device and needs Quran Lab's answer to open.

`errorCause` is never a message, a URL or an identifier. The codes that only say the API was used wrongly
(`invalid_argument`, `client_exists`, `session_open`, `session_closed`, `cancelled`) have none, and the platform's own
`cause` keeps the underlying error.

## The Content-Security-Policy lines your site needs

If your site sends a Content-Security-Policy, add the lines below. They name every Quran Lab host the SDK may use,
so it keeps working when one of them is unreachable.

```
script-src  https://web.quranlab.ai https://web2.quranlab.ai https://web-b.tajweedformer.com https://web-g.tajweedformer.com https://web-a.tajweedformer.com blob:
frame-src   https://web.quranlab.ai https://web2.quranlab.ai https://web-b.tajweedformer.com https://web-g.tajweedformer.com https://web-a.tajweedformer.com
connect-src https://web.quranlab.ai https://web2.quranlab.ai https://web-b.tajweedformer.com https://web-g.tajweedformer.com https://web-a.tajweedformer.com https://api.quranlab.ai https://api-b.tajweedformer.com https://api-g.tajweedformer.com https://api-a.tajweedformer.com https://*.r2.cloudflarestorage.com
```

- `script-src`: the loader (from any of its hosts), and `blob:` for what it runs from bytes it checked: the sharing
  chunk and the microphone's AudioWorklet.
- `frame-src`: Quran Lab's frame on any of its hosts. Without it the browser blocks the frame and `create()` fails
  with `needs_connection`.
- `connect-src`: the frame's hosts for the sharing chunk and its encoder, Quran Lab's API hosts for the sharing
  sheet's requests and the origin check, and the storage host for the shared recordings' uploads (as in 3.x).
- SDK 4.0.0 uses only the `quranlab.ai` hosts of each line.
- If your page sets `Permissions-Policy`, keep `microphone=(self)` for `listen()`.

Nothing else of yours needs to change: the engine, the model download and the requests to Quran Lab run inside the
frame, under Quran Lab's own headers.

## How it works

1. `create()` adds a hidden iframe, Quran Lab's frame `https://web.quranlab.ai/4/frame/<your key>`. Quran Lab's server
   answers it with `Content-Security-Policy: frame-ancestors <your key's origins>`, so it loads nowhere else. When a
   Quran Lab server is unreachable, the SDK keeps working through another.
2. The frame runs only inside a page (never top-level, never in a window opened with `window.open`), and learns your
   origin from the browser alone: the origin the browser stamps on your page's answer to its hello, checked against
   the browser's own ancestor list where it has one. Then it starts its Worker and hands it a direct channel to the
   loader. From then on your page and the Worker exchange audio and results only.
3. The Worker makes the install keys (WebCrypto, not extractable), registers, reads the signed config, loads and
   verifies the engine build named for your site, and asks for a lease, the permission to open the model here: it
   passes an invisible bot check on Quran Lab's hostname. A learner never sees a check or a box, and is never refused
   when the check gives no clear answer; only a check made for another site is refused.
4. **The first visit needs a connection; after that it works offline.** The lease is kept across page loads in the
   frame's storage for your site: the keys as non-extractable WebCrypto keys, the Core's state sealed under another
   non-extractable key. A reload opens the model with no request to Quran Lab, also offline, and while the device is
   online the SDK keeps itself up to date in the background. Another site, or a refusal from Quran Lab, makes it ask
   again.
5. The model's files arrive encrypted, are checked against the signed manifest, and the Core converts each once
   into its device form; only ciphertext is stored (the origin private file system of the frame, partitioned by
   your site: each site downloads the model once). A download that stalls or breaks goes on from the bytes it has,
   and a later call goes on from the blocks kept.
6. Each open decrypts into the engine's memory; each chunk runs the same engine as 3.x, at the same speed.

## Measured (dev PC, Intel i9-14900KF, one thread)

| | SDK 4.0 | current web SDK (3.1.3 engine) |
|-|-|-|
| Loader | 54.2 KB, 18.9 KB gzip | |
| Sharing chunk (loaded by the page) | 245.4 KB, 72.6 KB gzip, plus the Opus encoder 0.32 MB | |
| Frame page, frame script, Worker | 0.9 KB + 3.5 KB + 115.7 KB (39.5 KB gzip; the Ed25519 fallback is 6.0 KB of it) | |
| Engine | 2.32 MB WebAssembly (1.92 MB gzip) + 15 KB glue; threads build 2.34 MB | 0.67 MB |
| Model open (files on the device), Node 22 | 136 to 162 ms | 30 to 39 ms |
| New page session to a ready model (keys, attest, config, lease, open), Node, API in memory | 168 to 191 ms | |
| First visit of a site: install of 57 MB ciphertext (Core) | 1.19 to 1.29 s | |
| Per 320 ms chunk, mean over a 20 s clip, Node | 30.8 to 38.1 ms | 32.8 to 37.0 ms |
| Chrome (headless), first visit, local servers: create to a ready model | 2.26 s | |

The open is about 110 ms longer than today's because the device form is decrypted (ChaCha20-Poly1305 in
WebAssembly) into the engine's memory; per chunk nothing changes. Runs on a shared machine: the
ranges are three interleaved runs each.

## Recited ayat and your app's judgement

The SDK works out which ayat a take recited by itself (in the Core) and counts them into your anonymous daily
totals. `session.reportRecited(surah, ayahFrom, ayahTo)` is the fallback: it is used only for a take the SDK could
not count, and a take is never counted twice. If your app judges a recitation, pass the result with the same call:

```js
session.reportRecited(2, 255, 257, {
  outcome: { correct: false, mistakes: 2, rules: ['madd', 'qalqalah'] },   // the whole range
  perAyah: { 255: { correct: true } },                                     // overrides per ayah
});
```

These numbers are your app's own judgement; Quran Lab's SDK does not judge a recitation. A take's record is kept in
the frame's IndexedDB so that a closed tab or a crash loses at most a few seconds of a take, and the take is counted
once at the next visit.

The SDK keeps anonymous daily totals for your statistics at sdk.quranlab.ai: sessions and takes, seconds of audio and
of recitation, the ayat recited per surah and per juz, the hour of the day in the learner's own time, how long takes
and sessions are (a session is one page visit), how many installs were active and came back, and how the model ran on
the device. Nothing is kept per learner: no audio, no text, no ayah numbers, no identifier, no location beyond the
country the request came from. The device keeps its own list of the days it was used, in the frame's storage, to
work out those totals, and that list never leaves the device.

These anonymous totals are always kept: SDK 4.0 has no option to turn them off, because they are daily counts and
durations only, never audio, text, names or device identifiers. Only Quran Lab can switch them off, from its signed
config. (3.x had `analytics: 'off'`; in 4.0 an `analytics` passed to `create()` is refused with `invalid_argument`,
whose message points to [docs/migrating-to-4.md](docs/migrating-to-4.md): delete it.)

## Recitation sharing

Every learner is asked, on the SDK's sheet in your page (`<quranlab-consent>`), under the rules below, and the choice
is theirs: they can say "Not now", and they can turn sharing off or delete what they shared at any time
(`<quranlab-sharing-settings>`, `client.sharing`). A learner who says yes is never asked again. No app is exempt and
no option of yours changes this. The sheet's wording comes from Quran Lab's server and the version the learner agreed
to is recorded with every shared recording. The code runs in your page, loaded by the loader as a separate chunk it
checks by hash, and Quran Lab's frame holds nothing of it. Quran Lab's signed config keeps one switch over sharing,
`flags.contributions`: a global incident switch that pauses sharing for every app at once.

When the SDK asks is gentler in 4.0. The first ask is the full sheet, never right after the install,
never before the learner's 3rd completed session, and only at the end of a good session (a take that ended normally,
with at least a minute recited in this visit), once the moment has settled (3 seconds with no new take). After
"Not now" a re-ask is a small card at the bottom of the page, "Your recitation today could help another learner
tomorrow.", with "See how it helps" (the full sheet, where consent is given) and "Not now"; it blocks nothing and
takes no focus, and it goes when a take starts or the page is hidden. The card comes only after a good while and
several completed sessions since the last ask, the next one after longer still. Three asks at most,
ever (the sheet and two cards). `client.sharing.ask()` asks at your app's own moment only when an ask is due by these
rules (without the minute), never before a completed take of the visit and never during a take; otherwise it
resolves with null and shows nothing. Quran Lab's signed config can make asking rarer, never more frequent.

Each `storage` name of a site keeps its own queue of shared recordings (4.0.2): the default name in the IndexedDB
database `quranlab-sharing`, another name in `quranlab-sharing.<name>`. A learner's answer under one name never deletes
or sends the recordings of another. Recordings that a named client queued in the one shared database of 4.0.0 and
4.0.1 move to that name's database the next time a page with that name starts; until then the default name leaves
them where they are.

Every app shows the same sheet, under the same rules; no option selects another. (3.x had an `audience` option; in
4.0 an `audience` passed to `create()`, whatever its value, is refused with `invalid_argument`, whose message points to
[docs/migrating-to-4.md](docs/migrating-to-4.md): delete it.) A learner who already said yes in 3.x keeps that yes
and is never asked again.

## Threads

One thread by default. For the threads engine your page must be cross-origin isolated (serve it with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`, and
every resource it loads with CORS or `Cross-Origin-Resource-Policy`), and ask for it:
`TajweedClient.create({ key, threads: 'auto' })`. The loader then gives the frame `allow="cross-origin-isolated"`
and asks Quran Lab for the isolated frame; on a device with 4 or more cores the frame runs the threads build.

## Node

A desktop app (for example a tool that listens to a live stream) runs the same API in Node 20 or later, with a
**desktop key** and the app id you gave it at sdk.quranlab.ai:

```js
import { TajweedClient } from '@quran-lab/tajweedformer';   // the package's `node` condition (or '.../node')

const client = await TajweedClient.create({ key: 'qlk_v1_...', appId: 'org.example.live' });
const model = await client.model();
const session = model.session();          // push Float32Array samples at 16 kHz (or say sampleRate)
session.push(samples);
const heads = await session.finish();
await client.close();
```

- **No frame, no page.** The Core, its lease and the model's ciphertext live in a worker thread of your process, so a
  take never holds up your event loop. Audio comes in as samples (`session.push`, or `model.listen({ from })`).
- **The same signed engine** as the web frame: fetched from Quran Lab, its Ed25519-signed index and every file's
  SHA-256 checked, kept in the storage folder and checked again at every start.
- **Where files live:** `storage` (a folder), by default your OS's cache folder, then `quranlab/tajweedformer/<appId>`
  (`%LOCALAPPDATA%` on Windows, `~/Library/Caches` on a Mac, `$XDG_CACHE_HOME` or `~/.cache` on Linux). It holds
  ciphertext only, the signed engine, the SDK's small state, and the install keys, sealed under a key made from this
  machine's id and the user's id (mode 0600): a folder copied to another machine does not open there, and the app
  starts as a new install. One Client per folder in a process.
- **Offline:** as on the web, the first run needs a connection; after that it works offline. The lease is kept
  across runs, so a run starts with no request to Quran Lab, and with no network at all when the model is already in
  the folder; while online the SDK keeps itself up to date in the background.
- **The honest limit:** a desktop key file is protected by software only (`hw 0` in its certificate). On a machine the
  developer controls, the protection is the Core's: the model is never written in plaintext, and the lease opens it
  only in this folder on this machine.
- No recitation sharing in Node (it needs the consent sheet in a page): `client.sharing.isAvailable` is false.

## What 4.0.0 does not do yet

- **Expected units per ayah** (`model.reference`): read by the Core from the build's reference data, downloaded with the
  model; null only for a build that has none.

## The honest limit

A model that runs on a device can be taken by someone who controls that device and has the skill and the time. The
goal of 4.0 is that a key, an AI agent, a copied folder or a script gets nothing usable, and that taking the model
needs an expert, weeks, and a new effort for every release.

## Build and test

```sh
npm install
python scripts/build_web4.py engine --core <quranlab-core at f006676 (Core 4.0.0-c3)> --emsdk <emsdk> --work <scratch> --test-key
python scripts/build_web4.py hosted            # dist/hosted/4: loader, frame, Worker, build.json (SRI)
QL_CONTRACT=<quranlab-contract at 564c144>/sdk_4.0.0 QL_TEST_BUILD=<protected test build sdk/v4.0> npm test && npm run test:3x
python scripts/build_web4.py hosted --test && QL_TEST_BUILD=... node scripts/browser-web4.mjs
QL_TEST_BUILD=... node scripts/bench-web4.mjs <clip.f32>
```

The tests use the contract's test keys (a default build of the Core is its test release, 4.0.0-c1) and a local
stand-in for Quran Lab's API and CDN; they never call a production endpoint. CI runs them on Quran Lab's own runner
(`.github/workflows/ci.yml`). `docs/server-for-web-4.md` is what Quran Lab's servers do for this SDK;
`docs/core-requests.md` lists what this SDK asks of the Core.

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
Quran-Lab No-Profit License 1.3 ([NPL-1.3](LICENSE)): use, copy, modify and build apps on them freely,
but never charge for them, for access to them, or for any feature they power. Neither they nor their outputs may be used to train other models. The weights are not
stored in this repository; Quran Lab hosts them itself and serves them to apps by
`cdn.quranlab.ai/models` under the same licence. Get access at
[sdk.quranlab.ai](https://sdk.quranlab.ai).

Third-party components keep their own licences, listed in their folders under `third_party/`.
