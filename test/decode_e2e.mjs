// End-to-end decode of one clip through the WASM module in Node: stage the engine's model files
// into MEMFS, decode, and print the phoneme ids and the FNV-1a of every chunk's log-probs, which
// equal the native engine's (the SDK's zf_stream_check prints the same fingerprint).
//
//   node test/decode_e2e.mjs <model-dir> <clip> [model-name]
// <model-dir> holds <model-name> (default model_engine2.onnx) with its .zfg and .zfg.bin, plus
// layers.zfw and frontend.zfw. A clip ending in .pcm is 16 kHz float32 audio; anything else is
// [n, 80] float32 fbank features.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import createZipformer from '../dist/zipformer.mjs';

const [dir, clip, name = 'model_engine2.onnx'] = process.argv.slice(2);
if (!dir || !clip) { console.error('usage: node test/decode_e2e.mjs <model-dir> <clip> [model-name]'); process.exit(2); }

const m = await createZipformer();
m.FS.mkdir('/model');
for (const f of [name, name + '.zfg', name + '.zfg.bin', 'layers.zfw', 'frontend.zfw'])
  m.FS.writeFile('/model/' + f, new Uint8Array(readFileSync(dir + '/' + f)));

const h = m.ccall('zfw_create', 'number', ['string', 'number', 'number', 'number', 'number'], ['/model/' + name, 1, 1, 0, 0]);
if (!h) throw new Error('zfw_create failed: ' + m.UTF8ToString(m._zfw_error()));
const tb = m._zfw_token_bytes();

const buf = readFileSync(clip);
const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
const inPtr = m._malloc(data.byteLength);
m.HEAPF32.set(data, inPtr >> 2);
const MAXTOK = 4096;
const outPtr = m._malloc(MAXTOK * tb);

const audio = clip.endsWith('.pcm');
const t0 = performance.now();
let n = audio ? m._zfw_push_audio(h, inPtr, data.length, outPtr, MAXTOK)
              : m._zfw_push_frames(h, inPtr, data.length / 80, outPtr, MAXTOK);
n += audio ? m._zfw_finish_audio(h, outPtr + n * tb, MAXTOK - n) : m._zfw_finish_frames(h, outPtr + n * tb, MAXTOK - n);
const ms = performance.now() - t0;

const ids = [];
for (let t = 0; t < n; ++t) ids.push(m.HEAP32[(outPtr + t * tb) >> 2]);
const chunks = m._zfw_chunks(h);
const audioMs = audio ? data.length / 16 : (data.length / 80) * 10;
console.log(`WASM decode: ${basename(clip)}  ${audioMs.toFixed(0)} ms, ${chunks} chunks, ${n} phonemes, ${ms.toFixed(1)} ms (${(audioMs / ms).toFixed(0)}x realtime)`);
console.log(`tokens   = [${ids.join(', ')}]`);
console.log(`logp_fnv = ${m.UTF8ToString(m._zfw_logp_fnv(h))}   (compare to the native engine's)`);
m._zfw_destroy(h);
