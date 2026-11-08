// @quran-lab/tajweedformer: TajweedFormer V4 for browsers and Node. The exact engine in WebAssembly
// (single thread, SIMD128; works everywhere with no special headers), the model delivery (shared
// cache, resumable, hashed), the decoded and tajweed layers, and the Quran Lab platform client.
//   import { TajweedFormer } from '@quran-lab/tajweedformer';
import createTajweedFormer from '../dist/tajweedformer.mjs';
import { bindTajweed } from './tajweed/tajweedformer.js';
export * from './tajweed/index.js';

export const TajweedFormer = bindTajweed(createTajweedFormer);
export default TajweedFormer;
