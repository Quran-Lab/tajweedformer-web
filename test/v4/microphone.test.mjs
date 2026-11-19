// Microphone (NAMES.md: `static open()`, `sampleRate`, `samples()`, `close()`): the class the loader exports
// (sdk4/loader/index.js takes it from web/api/microphone.js), against the stand-in browser objects of
// test/helpers/fakemic.mjs. Ported from the 3.x tests api_listen ("samples only") and bounds (the reader that stops
// reading), which reached it through the 3.x package entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Microphone, MIC_QUEUE_BLOCKS } from '../../web/api/microphone.js';
import { TajweedError } from '../../web/api/errors.js';
import { fakeMicrophone } from '../helpers/fakemic.mjs';

const code = (c) => (e) => e instanceof TajweedError && e.code === c;
const settle = () => new Promise((r) => setTimeout(r, 5));

test('Microphone: samples only, for apps that own the rest', async () => {
  const fake = fakeMicrophone({ sampleRate: 44100 });
  const mic = await Microphone.open(fake.seams);
  assert.equal(mic.sampleRate, 44100);
  const got = [];
  const reader = (async () => { for await (const block of mic.samples()) got.push(block.length); })();
  fake.play(new Float32Array(2000));
  await settle();
  mic.close();
  await reader;
  assert.deepEqual(got, [960, 960, 80]);
  assert.equal(fake.track.stopped, true);
  assert.equal(fake.mediaDevices.listeners('devicechange'), 0);
  fake.deny = 'NotAllowedError';
  await assert.rejects(Microphone.open(fake.seams), code('microphone_denied'));
});

test('Microphone.samples(): a reader that stops reading keeps the newest blocks only', async () => {
  const fm = fakeMicrophone({ sampleRate: 48000 });
  const mic = await Microphone.open(fm.seams);
  const it = mic.samples()[Symbol.asyncIterator]();
  fm.play(new Float32Array(960 * (MIC_QUEUE_BLOCKS + 200)));
  assert.equal(mic._queue.length, MIC_QUEUE_BLOCKS);
  assert.equal((await it.next()).value.length, 960);
  mic.close();
});
