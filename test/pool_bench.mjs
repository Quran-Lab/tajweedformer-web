// Drives pool_bench.wasm: aggregate int8 throughput and estimated chunk time / realtime factor at
// 1, 2 and 4 threads. A chunk is 480 ms of audio; RTF = chunk_ms / 480, realtime factor = 1/RTF.
import createPoolBench from '../dist/pool_bench.mjs';

const m = await createPoolBench();
const setup = m.cwrap('setup', null, ['number']);
const threadsOf = m.cwrap('pool_threads', 'number', []);
const run = m.cwrap('run', 'number', ['number', 'number', 'number', 'number']);
const chunk = m.cwrap('chunk', 'number', ['number']);
const chunkMacs = m.cwrap('chunk_macs', 'number', []);

const macs = chunkMacs();
console.log(`int8 workload per chunk: ${(macs / 1e6).toFixed(1)}M MACs (documented 369.3M)\n`);
console.log('threads | 24x512x512 | chunk int8 | RTF(int8) | realtime x');
for (const t of [1, 2, 4]) {
  setup(t);
  const got = threadsOf();
  run(24, 512, 512, 2000);                       // warm up the JIT
  const g = run(24, 512, 512, 20000);
  const ms = chunk(200);
  const rtf = ms / 480;
  console.log(`${String(got).padStart(7)} | ${g.toFixed(1).padStart(7)} G  | ${ms.toFixed(2).padStart(7)} ms | ${rtf.toFixed(4).padStart(7)}   | ${(1 / rtf).toFixed(0).padStart(5)}x`);
}
console.log('\nnote: int8 linears only (369M of a chunk\'s 464M MACs); the fp32 front end and glue add to chunk time. End-to-end RTF needs the model.');
