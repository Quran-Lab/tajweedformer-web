#!/usr/bin/env bash
# The int8 linear kernel, checked and timed in Node: every form this build can take computes the
# exact integer sums (test/gemm_check.c, 1,215 shapes against a plain triple loop), and each form's
# throughput on the model's widest linear. The int8 linears are 369M of a chunk's 464M
# multiply-adds; see the README for what that is end to end.
#
#   SIMD128       the shipped kernel (patches/0001, i16x8 products, pairwise into int32)
#   SIMD128 dot   the same kernel with i32x4.dot_i16x8_s (-DZF_WASM_INT8_FORM=1)
#   emulated NEON the engine's own NEON loop through zf/neon_emu.h on SIMD128 (-DZF_WASM_SIMD_INT8=0)
#   scalar        the emulated NEON loop without SIMD128 (what the scalar build runs)
#
# Also builds dist/pool_bench.mjs for `npm run bench:rt` (the kernel across the pthreads pool).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${TAJWEEDFORMER_SDK_DIR:-${ZIPFORMER_SDK_DIR:-$here/vendor/zipformer-sdk}}"
bash "$here/scripts/build.sh" --out "$(mktemp -d)" >/dev/null   # applies the engine patch if needed
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
F=(-O3 -ffp-contract=off -DZF_RELEASE=1 -DZF_QUANT_DIVIDE=1 -I"$SDK/engine/include")
SRC=("$SDK/engine/src/kernels.c" "$SDK/engine/src/zf_libm.c" "$here/test/gemm_check.c")
q() { grep -v "gcc-install-dir\|future releases" || true; }

emcc "${F[@]}" -msimd128 "${SRC[@]}" -w -o "$tmp/simd.js" 2>&1 | q
emcc "${F[@]}" -msimd128 -DZF_WASM_INT8_FORM=1 "${SRC[@]}" -w -o "$tmp/dot.js" 2>&1 | q
emcc "${F[@]}" -msimd128 -DZF_WASM_SIMD_INT8=0 "${SRC[@]}" -w -o "$tmp/emu.js" 2>&1 | q
emcc "${F[@]}" "${SRC[@]}" -w -o "$tmp/scalar.js" 2>&1 | q
echo "== int8 linear kernel =="
echo -n "  SIMD128        "; node "$tmp/simd.js"
echo -n "  SIMD128 dot    "; node "$tmp/dot.js"
echo -n "  emulated NEON  "; node "$tmp/emu.js"
echo -n "  scalar         "; node "$tmp/scalar.js"

mkdir -p "$here/dist"
emcc "${F[@]}" -msimd128 -pthread -I"$SDK/accel/include" "$SDK/engine/src/kernels.c" "$SDK/engine/src/zf_libm.c" \
  "$SDK/engine/src/pool.c" "$here/test/pool_bench.c" -w -o "$here/dist/pool_bench.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPoolBench -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=64MB -sPTHREAD_POOL_SIZE=4 -sEXPORTED_RUNTIME_METHODS=cwrap -Wno-pthreads-mem-growth 2>&1 | q
echo "built dist/pool_bench.mjs (npm run bench:rt)"
