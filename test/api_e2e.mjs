// The public JS API (web/zipformer.js, or web/zipformer-mt.js with --mt) on the conformance clips:
// Zipformer.load with the model files in memory, pushAudio in 100 ms pieces and finish(), or
// pushFrames for features, then every clip's phoneme ids and log-prob fingerprint against the
// SDK's expected set. Also checks what the wrapper adds: prob2 is the runner-up posterior the
// engine's margin was taken against, and a clip decoded twice (after reset) gives the same bits.
//
//   node test/api_e2e.mjs <data dir> [--mt] [--audio]
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dataDir = args.find((a) => !a.startsWith('--'));
if (!dataDir) { console.error('usage: node test/api_e2e.mjs <data dir> [--mt] [--audio]'); process.exit(2); }
const mt = args.includes('--mt'), audio = args.includes('--audio');
const { Zipformer } = await import(mt ? '../internal/v3/zipformer-mt.js' : '../internal/v3/zipformer.js');

const modelFiles = {};
for (const f of ['model_engine2.onnx', 'model_engine2.onnx.zfg', 'model_engine2.onnx.zfg.bin', 'frontend.zfw', 'layers.zfw'])
  modelFiles[f] = readFileSync(join(dataDir, f));
const zf = await Zipformer.load({ modelFiles, modelName: 'model_engine2.onnx', threads: mt ? 4 : 1 });

const expected = readFileSync(join(dataDir, audio ? 'parity35_audio_expected.jsonl' : 'parity35_expected.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sub = audio ? 'audio' : 'feats';
let ok = 0, fails = 0, margins = 0, marginBad = 0;
function decode(data) {
  zf.reset();
  const toks = [];
  if (audio) for (let at = 0; at < data.length; at += 1600) toks.push(...zf.pushAudio(data.subarray(at, at + 1600)));
  else toks.push(...zf.pushFrames(data, data.length / 80));
  toks.push(...zf.finish());
  return toks;
}
for (const e of expected) {
  const buf = readFileSync(join(dataDir, sub, `${e.clip}.${audio ? 'pcm' : 'f32'}`));
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
  const toks = decode(data);
  const fp = zf.logProbFingerprint;
  const again = decode(data);
  const same = JSON.stringify(toks.map((t) => t.token)) === JSON.stringify(e.tokens) && fp === e.logp_fnv;
  const repeat = JSON.stringify(again) === JSON.stringify(toks) && zf.logProbFingerprint === fp;
  for (const t of toks) {
    ++margins;
    if (Math.fround(t.prob - t.prob2) !== t.margin || t.token2 < 0 || t.prob2 > t.prob) ++marginBad;
  }
  if (same && repeat) ++ok; else { ++fails; console.log(`differs: ${e.clip}${repeat ? '' : ' (and not repeatable)'}`); }
}
console.log(`${ok}/${expected.length} clips bit-identical through the ${mt ? 'threaded' : 'single-thread'} JS API (${audio ? 'audio' : 'features'}); ` +
  `prob - prob2 == margin on ${margins - marginBad}/${margins} phonemes`);
zf.free();
process.exit(fails || marginBad ? 1 : 0);
