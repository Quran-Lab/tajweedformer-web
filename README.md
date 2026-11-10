<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/quranlab-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/quranlab-mark-light.svg">
    <img alt="Quran Lab" src=".github/assets/quranlab-mark-light.svg" width="51" height="48">
  </picture>
</p>

<h1 align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.svg"><img alt="TajweedFormer for the web" src="docs/banner-light.svg" width="100%"></picture></h1>

<p align="center">TajweedFormer V4 for the web: recitation audio in, the model's output out while the learner recites. In the browser, on the learner's device, and free.</p>

<p align="center">
  <img alt="platform: browsers, Node" src="https://img.shields.io/badge/platform-browsers%20%7C%20Node-1c1b19?style=flat-square">
  <img alt="bit-exact: 35 of 35 conformance clips" src="https://img.shields.io/badge/bit--exact-35%2F35%20clips-2a3b8f?style=flat-square">
  <img alt="status: preview" src="https://img.shields.io/badge/status-preview-2a3b8f?style=flat-square">
  <img alt="model licence: NPL-1.2" src="https://img.shields.io/badge/model%20licence-NPL--1.2-1c1b19?style=flat-square">
</p>

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

**Tajweed scoring in SDK 2.x**<br>For a known ayah, SDK 2.x also scores the take: letters and vowels, madd held too short or too long, a score for every word. Qalqalah checks are experimental.

</td>
</tr>
</table>

### Tajweed scoring in SDK 2.x

Scoring has four presets. **Strict** almost never flags a correct recitation. **Balanced** is the default. **Sensitive** catches more, and **Very sensitive** catches the most, for a teacher who reviews every flag first. The word level follows your learners: **strict** for huffaz and advanced students, **general** for most apps, **beginner** for children and classes. You set them in the portal and your app picks them up without a new build. Scoring is part of SDK 2.x; SDK 3.0 is inference only, so build new judging on the model's output.

## Why TajweedFormer

- **Made for the Quran.** Trained on Quranic recitation, with its own sound units and heads for what tajweed is about.
- **Feedback in the moment.** Output streams while the learner recites, so your app can respond on the word itself, not after the take.
- **One engine on every platform.** The same engine runs the [web](https://github.com/Quran-Lab/tajweedformer-web), [Android](https://github.com/Quran-Lab/tajweedformer-android), [iOS and macOS](https://github.com/Quran-Lab/tajweedformer-apple) and [Windows and Linux](https://github.com/Quran-Lab/tajweedformer-c) SDKs, all set from one portal.
- **Free, and it stays free.** Quran Lab is a non-profit waqf: the SDKs and models are never sold. The licence, NPL-1.2, asks three things: no paywall on model features, no results presented as rulings, and show the notice.

## Built for AI developers

Copy the setup prompt from [portal.quranlab.ai](https://portal.quranlab.ai) and paste it into your coding assistant. That one prompt sets everything up: the package, your key, and the settings for the learners your app is for. [AGENTS.md](AGENTS.md), beside this README, gives the assistant the complete API, so the code it writes uses names that exist. Prefer to do it by hand? Get a key in the portal and start below.

## Install

```sh
npm install @quran-lab/tajweedformer
```

With a bundler (Vite, webpack and the like) the imports in the quick start resolve as they are written. Without one, import the same two modules by URL: `https://cdn.jsdelivr.net/npm/@quran-lab/tajweedformer@2.0.2/web/index.js` and `https://cdn.jsdelivr.net/npm/@quran-lab/tajweedformer@2.0.2/web/platform/index.js`.

## Before you start

| | |
| - | - |
| **Key** | A web key from [portal.quranlab.ai](https://portal.quranlab.ai), locked to your site's origins. Add `http://localhost:<port>` there for development. |
| **Page** | A secure context: `https`, or `http://localhost`. A browser gives the microphone and WebCrypto to nothing else, and starts audio only after a tap or a click. |
| **Browser** | WebAssembly with SIMD, AudioWorklet, and Ed25519 in WebCrypto (Chrome 137, Firefox 129, Safari 17, or later). In Node: version 20 or later. |
| **Download** | The first visit downloads the model: 56.5 MB, then the browser's cache serves it (73.5 MB stored). |
| **Streams** | One live stream per page at a time. |

## Quick start

From your key to what the model hears from the microphone, on a page with `<button id="listen">` and
`<pre id="heard">`:

```js
import { TajweedFormer } from '@quran-lab/tajweedformer';
import { QuranLab } from '@quran-lab/tajweedformer/platform';

document.querySelector('#listen').onclick = async () => {   // the microphone needs a tap
  const ql = await QuranLab.configure({ key: 'qlk_v1_...' });   // your web key from portal.quranlab.ai
  const audio = new AudioContext({ sampleRate: 48000 });
  const tf = await TajweedFormer.load({ platform: ql, sampleRate: 48000 });   // downloads the model once, then cached
  const stream = tf.createStream({ onChunk: () => {             // every 320 ms: what the model heard so far
    document.querySelector('#heard').textContent = stream.decoded().tokens.map((t) => t.unit).join(' ');
  } });

  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const worklet = `registerProcessor('mic', class extends AudioWorkletProcessor {
    process(inputs) { if (inputs[0][0]) this.port.postMessage(inputs[0][0].slice()); return true; } });`;
  await audio.audioWorklet.addModule(URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' })));
  const node = new AudioWorkletNode(audio, 'mic', { numberOfOutputs: 0 });
  node.port.onmessage = (e) => stream.pushAudio(e.data);        // Float32Array, mono, 48 kHz
  audio.createMediaStreamSource(mic).connect(node);
};
```

This is [`examples/quickstart.html`](examples/quickstart.html), a whole page you can open; the tests keep the two
equal and run it. `stream.decoded()` is what the model heard so far: each token with its confidence, runner-up and
times. `onChunk` also gets the chunk itself, with every head of the network you selected. To end the take, stop
feeding audio and call `stream.finish()`, then `stream.free()` before the next `createStream()`.

In SDK 2.x a finished take of a known ayah can also be scored: `await tf.score(stream.heads(), surah, ayah)` gives
verdicts per site and per word ("The three layers" below).

A longer page with scoring and sharing is [`examples/browser.html`](examples/browser.html), a Node script is
[`examples/node.mjs`](examples/node.mjs), and the full API, with every field, is in [`docs/api.md`](docs/api.md).

## More

The full reference (every layer of the API, backends, what a device downloads, platform settings, recording sharing, building and testing) is in [AGENTS.md](AGENTS.md), written for coding assistants and just as readable for you. Guides: [portal.quranlab.ai/docs](https://portal.quranlab.ai/docs).

## Licence

Quran Lab is a waqf: the SDKs and the models are free to use and are never sold.

The source code in this repository and the TajweedFormer model weights are released under the
Quran-Lab No-Profit License 1.2 ([NPL-1.2](LICENSE)): use, copy, modify and build on them freely,
but never charge for them, for access to them, or for any feature they power. The weights are not
stored in this repository; Quran Lab hosts them itself and serves them to apps by
`cdn.quranlab.ai/models` under the same licence. Get access at
[portal.quranlab.ai](https://portal.quranlab.ai).

Third-party components keep their own licences, listed in their folders under `third_party/`.
