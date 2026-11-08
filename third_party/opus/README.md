# libopus for the web sharing pipeline

`scripts/build_opus.sh` downloads libopus 1.6.1 from
`https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz`, checks its SHA-256
(`6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1`, the same pin as the Swift SDK's
Opus.xcframework), extracts it into `download/` (git-ignored) and compiles the release's own source
lists (`celt_sources.mk`, `silk_sources.mk` float, `opus_sources.mk` float) with emcc, together with
`src/opus_api.c`, into `dist/tajweedformer-opus.mjs` + `.wasm`. No configure, CMake or other script
from the tarball runs. Float build, no DNN features (DEEP_PLC, DRED, OSCE), no QEXT.

libopus is BSD-3-Clause (its `COPYING`, shipped with the module's notice).
