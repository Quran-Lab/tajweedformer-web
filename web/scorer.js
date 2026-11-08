// @quran-lab/tajweedformer/scorer: the TajweedFormer scorer without the streaming engine
// (dist/tajweedformer-scorer, scripts/build_scorer.sh). Scores heads from any source: the Neural
// Engine, an NPU, a server, saved heads. Models load for scoring only; streams throw.
//   import { TajweedFormer } from '@quran-lab/tajweedformer/scorer';
import createTajweedScorer from '../dist/tajweedformer-scorer.mjs';
import { bindTajweed } from './tajweed/tajweedformer.js';
export * from './tajweed/index.js';

export const TajweedFormer = bindTajweed(createTajweedScorer, { scoreOnly: true });
export default TajweedFormer;
