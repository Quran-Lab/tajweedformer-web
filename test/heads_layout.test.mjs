// The heads of the network as the internal modules lay them out (web/tajweed/heads.js): the twelve names in the
// engine's order, checkHeads and joinHeads, the chunk length of a context.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { HEAD_SPECS, checkHeads, joinHeads, contextChunkMs } from '../web/tajweed/heads.js';

function fakeHeads(n40, drop = []) {
  const h = { n40, n20: 2 * n40, vocab: 38 };
  for (const s of HEAD_SPECS) {
    const n = (s.rate === 40 ? n40 : 2 * n40) * s.width;
    h[s.key] = drop.includes(s.name) ? null : Float32Array.from({ length: n }, (_, i) => i + n40 * 1000);
  }
  return h;
}

test('heads: the README_heads layout, checkHeads and joinHeads', () => {
  assert.deepEqual(HEAD_SPECS.map((s) => s.name), ['log_probs', 'inter1_log_probs', 'inter4_log_probs', 'id_log_probs',
    'timing_log_probs', 'gem', 'attr_tafkheem', 'attr_ghunna', 'attr_qalqalah', 'attr_face', 'boundary', 'conf']);
  const a = fakeHeads(8), b = fakeHeads(12, ['conf']);
  checkHeads(a);
  const j = joinHeads([a, b]);
  assert.equal(j.n40, 20);
  assert.equal(j.n20, 40);
  assert.equal(j.logProbs.length, 20 * 38);
  assert.equal(j.gem.length, 40 * 2);
  assert.equal(j.boundary.length, 40);
  assert.equal(j.conf, null);
  assert.equal(j.logProbs[8 * 38], b.logProbs[0]);
  checkHeads(j);
  assert.throws(() => checkHeads({ ...a, gem: new Float32Array(3) }), /gem/);
  assert.throws(() => checkHeads({ ...a, n20: 15 }), /n20/);
  assert.throws(() => checkHeads({ ...a, logProbs: Array.from(a.logProbs) }), /Float32Array/);
  assert.equal(contextChunkMs('c16_l64'), 320);
  assert.equal(contextChunkMs('c24_l72'), 480);
  assert.equal(contextChunkMs('x'), 0);
});
