// TajweedFormer in a plain Vite project: no vite.config.js, the package imported by its name. Vite finds the
// engine's Worker and its wasm file by itself and puts them into the build.
//
// The key comes from .env.local (VITE_QURANLAB_KEY=qlk_v1_...): for `vite dev` use the app's DEVELOPMENT web key
// with http://localhost:* among its origins; the production key is for the deployed site.
import { TajweedClient } from '@quran-lab/tajweedformer';

const $ = (q) => document.querySelector(q);
let session = null;

try {
  const client = await TajweedClient.create({ key: import.meta.env.VITE_QURANLAB_KEY });
  const model = await client.model();              // downloads the model once, then cached
  $('#status').textContent = `model ${model.version}, ready`;

  // one take: the microphone, or a sample clip of the model
  async function take(from) {
    session = await model.listen({ from, endOnSilenceMs: 1500 });   // ends when the learner stops
    $('#listen').textContent = 'Stop';
    try {
      for await (const chunk of session.chunks) $('#heard').textContent = chunk.decoded.text;
    } finally {
      session = null;
      $('#listen').textContent = 'Recite';
    }
  }
  const run = (from) => take(from).catch(show);
  // in a noisy room a take may not end on silence: the same button stops it
  $('#listen').onclick = () => (session ? session.finish().catch(show) : run());
  $('#clip').onclick = () => { if (!session) run(model.sampleClips[0]); };
  $('#listen').disabled = $('#clip').disabled = false;
} catch (e) {
  show(e);
}

// an error says what happened and, under it, what to do
function show(e) {
  $('#status').textContent = e && e.fix ? `${e.message}\n${e.fix}` : String(e);
}
