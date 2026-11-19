// What the model heard in a recording, from Node (SDK 4.0, a desktop app).
//
//   QURANLAB_KEY=qlk_v1_... node examples/node.mjs <app id> <audio.f32le, mono 16 kHz>
//   ffmpeg -i take.wav -f f32le -ac 1 -ar 16000 take.f32   (one way to get the raw samples)
//
// The key is your app's desktop key from sdk.quranlab.ai, the app id the one you gave that app. The first run takes a
// lease (24 hours), downloads the model's ciphertext and the signed engine into the storage folder (by default under
// your OS's cache folder) and checks both; a later run within the lease opens from there, also without a network.
// The engine runs in a worker thread, so the app's own event loop is never held up by a take.
// Prints each token with its confidence and times, the words, and where the model heard speech.
import { readFileSync } from 'node:fs';
import { TajweedClient } from '@quran-lab/tajweedformer';

const [appId, audio] = process.argv.slice(2);
const key = process.env.QURANLAB_KEY;
if (!key || !appId || !audio) { console.error('usage: QURANLAB_KEY=qlk_v1_... node examples/node.mjs <app id> <audio.f32>'); process.exit(2); }

const client = await TajweedClient.create({ key, appId });
try {
  const model = await client.model();
  console.log(`model ${model.id} ${model.version} (build ${model.build.slice(0, 8)}), context ${model.defaultContext}, ${model.chunkMs()} ms chunks`);

  const buf = readFileSync(audio);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  const session = await model.listen({ from: samples, sampleRate: 16000, pace: 'fast', heads: 'all',
    onEvent: (e) => { if (e.type === 'speechStarted' || e.type === 'speechEnded') console.log(`${e.type} at ${e.atMs} ms`); } });
  for await (const chunk of session.chunks) if (chunk.decoded.isFinal) console.log('heard:', chunk.decoded.text);

  const heads = await session.finish();
  for (const t of heads.decoded().tokens) {
    console.log(`${t.name}\t${t.firstMs} to ${t.lastMs} ms\tconfidence ${t.confidence === null ? '?' : t.confidence.toFixed(2)}`);
  }
  for (const w of heads.decoded().words) console.log(`word ${w.index}: ${w.text} (${w.firstMs} to ${w.lastMs} ms)`);
  console.log('heads:', heads.names.join(', '));
  await model.close();
} finally {
  await client.close(); // the day's totals are sent, the lease kept for the next run, the engine thread ended
}
