// What the model heard in a recording, from Node, with a model folder on disk.
//
//   node examples/node.mjs <model folder> <audio.f32le, mono 16 kHz>
//   ffmpeg -i take.wav -f f32le -ac 1 -ar 16000 take.f32   (one way to get the raw samples)
//
// Prints each token with its confidence and times, the words, and where the model heard speech.
import { readFileSync } from 'node:fs';
import { TajweedModel } from '@quran-lab/tajweedformer';
import { dirReader } from '@quran-lab/tajweedformer/node';

const [dir, audio] = process.argv.slice(2);
if (!dir || !audio) { console.error('usage: node examples/node.mjs <model folder> <audio.f32>'); process.exit(2); }

const model = await TajweedModel.open(dirReader(dir));
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
