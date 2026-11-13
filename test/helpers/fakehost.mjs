// The fake engine host of the tests and the audio that drives it, in a module with no Node import, so that a page
// of a real browser can load it too (test/install_blocked_browser.test.mjs). test/helpers/model3.mjs re-exports both.
// None of this is the engine: the engine's numbers are checked by the conformance tests.
import { contextChunkMs, HEAD_SPECS } from '../../web/tajweed/heads.js';

/** Samples whose 40 ms frames decode, through the fake host, to the given token ids (0 = blank). A negative id is
 * a held sound: log_probs is blank on that frame and the timing head holds the id. */
export function audioFor(ids, sampleRate = 16000) {
  const per = Math.round(sampleRate * 0.04);
  const a = new Float32Array(ids.length * per);
  ids.forEach((id, i) => a.fill(id / 100, i * per, (i + 1) * per));
  return a;
}

/**
 * A fake engine host (the EngineHost surface): each 40 ms frame's token is round(100 x the frame's mean
 * sample), 0 for silence; log_probs has that token at -0.1, the next id at -3 and the rest at -10; the other
 * heads are constants of the right shape. finish() pads a partial chunk with silence. `calls` logs every call.
 */
export function fakeHost() {
  const calls = [];
  let staged = new Map(), cur = null;
  const emit = (final) => {
    const out = [];
    const per = Math.round(cur.sampleRate * 0.04), n40 = cur.frames;
    while (cur.buf.length >= per * n40 || (final && cur.buf.length > 0)) {
      const take = cur.buf.splice(0, per * n40);
      while (take.length < per * n40) take.push(0);
      const heads = {};
      for (const s of HEAD_SPECS) {
        if (!cur.heads.includes(s.name)) continue;
        const rows = s.rate === 40 ? n40 : 2 * n40;
        const a = new Float32Array(rows * s.width);
        if (s.name === 'log_probs') {
          for (let f = 0; f < n40; f++) {
            let sum = 0;
            for (let i = 0; i < per; i++) sum += take[f * per + i];
            const id = Math.max(0, Math.min(37, Math.round((sum / per) * 100)));
            a.fill(-10, f * 38, (f + 1) * 38);
            a[f * 38 + id] = -0.1;
            a[f * 38 + ((id + 1) % 38)] = -3;
          }
        } else if (s.name === 'timing_log_probs') {
          // the timing head holds a sound for as long as it sounds: the frame's token on both of its 20 ms
          // frames, also for a frame of NEGATIVE samples (a held sound that log_probs shows as blank)
          for (let f = 0; f < n40; f++) {
            let sum = 0;
            for (let i = 0; i < per; i++) sum += take[f * per + i];
            const id = Math.min(37, Math.round(Math.abs(sum / per) * 100));
            for (const r of [2 * f, 2 * f + 1]) { a.fill(-10, r * 38, (r + 1) * 38); a[r * 38 + id] = -0.1; }
          }
        } else if (s.kind === 'log_softmax') a.fill(-Math.log(38));
        else if (s.kind === 'softmax') a.fill(1 / s.width);
        else a.fill(s.name === 'conf' ? 2 : -2);
        heads[s.name] = a;
      }
      out.push({ index: cur.index++, firstFrame: cur.frame, n40, heads });
      cur.frame += n40;
    }
    return out;
  };
  const host = {
    kind: 'local', calls, staged: () => staged,
    async init() { calls.push(['init']); return { engineVersion: 'fake', apiVersion: 3 }; },
    async stage(files) { calls.push(['stage', files.map((f) => f.path)]); for (const f of files) staged.set(f.path, f.bytes); return { files: staged.size }; },
    async warm(o) { calls.push(['warm', o]); return { chunkMs: contextChunkMs(o.context) }; },
    async start(o) {
      calls.push(['start', o]);
      if (host.failStart) throw new Error(host.failStart);
      cur = { ...o, frames: contextChunkMs(o.context) / 40, buf: [], index: 0, frame: 0 };
      return { chunkMs: contextChunkMs(o.context) };
    },
    async push(samples) {
      if (!cur) throw new Error('no take is open');
      if (host.failPush) throw new Error(host.failPush);
      calls.push(['push', samples.length]);
      for (const x of samples) cur.buf.push(x);
      return { chunks: emit(false), computeMs: 1 };
    },
    async finish() { if (!cur) throw new Error('no take is open'); calls.push(['finish']); const chunks = emit(true); cur = null; return { chunks, computeMs: 1 }; },
    async cancel() { calls.push(['cancel']); cur = null; return {}; },
    async loadReference(bytes) { calls.push(['loadReference', bytes.length]); host.table = JSON.parse(new TextDecoder().decode(bytes)); return { tokensSha256: host.referenceTokens || null }; },
    async reference({ surah, ayah }) {
      calls.push(['reference', surah, ayah]);
      const t = host.table;
      const r = t[`${surah}:${ayah}`];
      return r ? { units: Int32Array.from(r.units), words: Int32Array.from(r.words), nWords: r.nWords } : null;
    },
    async close() { calls.push(['close']); staged = new Map(); cur = null; return {}; },
  };
  return host;
}
