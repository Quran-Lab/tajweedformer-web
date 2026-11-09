// The TajweedFormer API without the WebAssembly module: model folders, settings, heads, verdict
// types. Runs in browsers and Node with no build step. TajweedFormer here has no engine bound, so
// load it with { loadEngine: false }; the package's main entry binds the engine.
//   import { TajweedFormer, resolveSettings } from '@quran-lab/tajweedformer/tajweed';
export * from './settings.js';
export * from './manifest.js';
export * from './delivery.js';
export {
  TajweedFormer, bindTajweed, EngineNotAvailableError, HEAD_SPECS, SCORER_HEADS, VOCAB, BLANK, MADD_CLASSES,
  contextChunkMs, checkHeads, joinHeads, checkOf, cdnFolderUrl, modelFolderUrl, MODELS_URL, DEFAULT_STREAM_HEADS,
  decode, decodeFrames, wordResults, sigmoidHead, WORD_BOUNDARY, CTC_FRAME_MS, HEAD_FRAME_MS, topK, topKOf, RANKED_HEADS,
} from './tajweedformer.js';
