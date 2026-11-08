# Changelog

## 2.0.0 (first public release)

- TajweedFormer V4: `TajweedFormer.load` opens a signed `sdk/v4.0` folder (by URL, files or a
  reader); `createStream` streams audio through the exact engine in WebAssembly and keeps every head;
  `score` returns per-site tajweed verdicts with their evidence.
- `@quran-lab/tajweedformer/scorer`: the scorer alone, for heads computed elsewhere.
- Tajweed settings in three layers (app code, the portal's block, `calibration.json`), identical in
  every TajweedFormer SDK.
- Bit-exact: the 35 conformance clips give the engine's expected outputs, every output of every
  chunk, through this SDK's own API.
