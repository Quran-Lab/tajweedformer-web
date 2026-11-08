// Score a recitation from Node with every layer, from a V4 folder on disk.
//
//   node examples/node.mjs <sdk/v4.0 folder> <audio.f32le, mono 16 kHz> <surah> <ayah>
//   ffmpeg -i take.wav -f f32le -ac 1 -ar 16000 take.f32   (one way to get the raw samples)
//
// Prints the decoded layer (what the model heard, with confidence), every flagged site and the words.
import { readFileSync } from 'node:fs';
import { TajweedFormer } from '@quran-lab/tajweedformer';
import { dirReader } from '@quran-lab/tajweedformer/node';

const [dir, audio, surah = '1', ayah = '1'] = process.argv.slice(2);
if (!dir || !audio) { console.error('usage: node examples/node.mjs <folder> <audio.f32> <surah> <ayah>'); process.exit(2); }

const tf = await TajweedFormer.load({ reader: dirReader(dir), settings: { preset: 'balanced' } });
console.log(`model ${tf.info.modelId} ${tf.info.revision}, context ${tf.context} (${tf.info.chunkMs} ms chunks)`);

const buf = readFileSync(audio);
const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
const stream = tf.createStream({ allHeads: true });
for (let at = 0; at < pcm.length; at += 1600) stream.pushAudio(pcm.subarray(at, at + 1600)); // 100 ms at a time
stream.finish();

const heard = stream.decoded();
console.log('heard:', heard.tokens.map((t) => `${t.unit}(${t.confidence === null ? '?' : t.confidence.toFixed(2)})`).join(' '));
const unsure = heard.tokens.filter((t) => t.margin < 1);
if (unsure.length) console.log('close calls:', unsure.map((t) => `${t.unit} or ${t.runnerUpUnit} at ${t.startMs} ms`).join(', '));

const r = await tf.score(stream.heads(), Number(surah), Number(ayah));
for (const s of r.sites.filter((x) => x.flagged)) {
  console.log(`word ${s.word}: ${s.class} ${s.expectedUnit} -> ${s.alternativeUnit ?? '(dropped)'} fused ${s.fusedLlr.toFixed(2)} > ${s.threshold}`);
}
for (const m of r.madd.filter((x) => x.flagged)) console.log(`word ${m.word}: madd ${m.maddClass} held ${m.count}, allowed ${m.allowedLo} to ${m.allowedHi}`);
for (const w of r.words) {
  console.log(`word ${w.word}: score ${w.score === null ? '-' : w.score.toFixed(2)}${w.flagged ? ' FLAGGED' : ''} (${w.startMs} to ${w.endMs} ms)`);
}
stream.free();
tf.free();
