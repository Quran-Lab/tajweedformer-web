#!/usr/bin/env bash
# Build the zipformer streaming engine to WebAssembly.
#
#   scripts/build.sh                 # SIMD, single thread (works everywhere, no special headers)
#   scripts/build.sh --threads N     # SIMD + pthreads, a pool of N workers (needs cross-origin isolation)
#   scripts/build.sh --no-simd       # scalar build: no SIMD128 anywhere, the same bits
#   scripts/build.sh --no-int8-simd  # SIMD128 build with the emulated NEON int8 loop instead of the
#                                    # native SIMD128 kernel, for A/B (same bits, slower)
#   scripts/build.sh --out DIR       # write DIR/<name>.mjs instead of dist/
#   scripts/build.sh --debug         # -O1 with assertions and safe heap
#   scripts/build.sh --with-1x       # INTERNAL: also the 1.x phoneme stream API (zfw_*, v3.2), named
#                                    # zipformer*.mjs, for the 1.x conformance harnesses in internal/v3
#
# The 2.0.0 package ships dist/tajweedformer.mjs: the engine with the V4 TajweedFormer binding only
# (src/zft_api.c over zf_tajweed.h). V4 only: no 1.x model API in the public module.
#
# Every variant is the SDK's release configuration (ZF_RELEASE: the exact engine, the environment
# ignored; ZF_QUANT_DIVIDE; no contraction) and runs the engine's NEON source through its ARMv7 NEON
# emulation (zf/neon_emu.h), so every float operation is the one the reference device performs,
# flush to zero and VRECPE/VRECPS included. The int8 linear kernel is this repo's SIMD128 form
# (patches/0001), integer arithmetic that gives the same int32 sums.
#
# Env: TAJWEEDFORMER_SDK_DIR (or the 1.x name ZIPFORMER_SDK_DIR) points at a checkout of
# Quran-Lab/tajweedformer-sdk (default: the submodule vendor/zipformer-sdk).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${TAJWEEDFORMER_SDK_DIR:-${ZIPFORMER_SDK_DIR:-$here/vendor/zipformer-sdk}}"
if [ ! -f "$SDK/engine/include/zf/neon_emu.h" ]; then
  if [ "$SDK" = "$here/vendor/zipformer-sdk" ]; then
    echo "initialising the tajweedformer-sdk submodule (vendor/zipformer-sdk)..." >&2
    git -C "$here" submodule update --init --recursive >&2 || { echo "submodule init failed" >&2; exit 1; }
  fi
  [ -f "$SDK/engine/include/zf/neon_emu.h" ] || { echo "no NEON emulation under $SDK; the SDK must be at 1461261 or later" >&2; exit 1; }
fi
grep -q ZF_STREAM_HAS_EVIDENCE "$SDK/accel/include/zf/stream.h" ||
  { echo "no evidence API in $SDK/accel/include/zf/stream.h; the SDK must be at ac5ce4d or later" >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not on PATH; run: source <emsdk>/emsdk_env.sh" >&2; exit 1; }

# Apply the engine patch (the SIMD128 int8 kernel) idempotently: only if it is not already in the
# tree. A patch that no longer applies is fatal, so a drift from the pinned SDK is caught here.
for p in "$here"/patches/*.patch; do
  [ -e "$p" ] || continue
  if git -C "$SDK" apply --reverse --check "$p" >/dev/null 2>&1; then continue; fi   # already applied
  if git -C "$SDK" apply --check "$p" >/dev/null 2>&1; then
    git -C "$SDK" apply "$p" && echo "applied $(basename "$p")" >&2
  else
    echo "patch $(basename "$p") does not apply to $SDK; is the submodule at the pinned commit?" >&2
    exit 1
  fi
done

SIMD=1; INT8SIMD=1; THREADS=0; OPT="-O3"; DEBUG=0; OUTDIR="$here/dist"; WITH1X=0
while [ $# -gt 0 ]; do
  case "$1" in
    --threads) THREADS="$2"; shift 2 ;;
    --no-simd) SIMD=0; shift ;;
    --no-int8-simd) INT8SIMD=0; shift ;;
    --out) OUTDIR="$2"; shift 2 ;;
    --debug) DEBUG=1; OPT="-O1"; shift ;;
    --with-1x) WITH1X=1; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

FLAGS=( "$OPT" -ffp-contract=off -DZF_RELEASE=1 -DZF_QUANT_DIVIDE=1
  -I"$SDK/engine/include" -I"$SDK/accel/include" -I"$SDK/third_party/kissfft"
  -I"$here/third_party/onnxruntime/include" )
[ "$SIMD" = "1" ] && FLAGS+=( -msimd128 )
[ "$INT8SIMD" = "0" ] && FLAGS+=( -DZF_WASM_SIMD_INT8=0 )
[ "$THREADS" != "0" ] && FLAGS+=( -pthread )

obj="$(mktemp -d)"; trap 'rm -rf "$obj"' EXIT
objs=()
cc() { # source, object name, extra flags...
  local src=$1 name=$2; shift 2
  emcc -c "${FLAGS[@]}" "$@" "$src" -o "$obj/$name.o"
  objs+=("$obj/$name.o")
}
# The engine, compiled as the SDK's own wasm/build.sh compiles it.
for f in pool kernels dot conv layout block zfw frontend layer decode zf_libm fbank resample vfs sha256 zfs; do
  case $f in
    zf_libm) cc "$SDK/engine/src/$f.c" "$f" -w ;;
    # plain IEEE scalar arithmetic, as on every other target (see the SDK's engine/CMakeLists.txt)
    fbank|resample) cc "$SDK/engine/src/$f.c" "$f" -Wall -Wextra -Werror -fno-vectorize -fno-slp-vectorize ;;
    *) cc "$SDK/engine/src/$f.c" "$f" -Wall -Wextra -Werror ;;
  esac
done
for f in kiss_fft kiss_fftr; do cc "$SDK/third_party/kissfft/$f.c" "$f" -w -fno-vectorize -fno-slp-vectorize; done
for f in ort_ops zf_rt stream; do cc "$SDK/accel/src/$f.c" "$f" -O2 -Wall -Wextra -Werror; done
ZFW_EXPORTS=""
if [ "$WITH1X" = "1" ]; then
  cc "$here/src/zfw_api.c" zfw_api -Wall -Wextra -Werror
  ZFW_EXPORTS=",_zfw_create,_zfw_destroy,_zfw_reset,_zfw_window,_zfw_advance,_zfw_chunks,_zfw_token_bytes,_zfw_push_audio,_zfw_push_frames,_zfw_finish_audio,_zfw_finish_frames,_zfw_read,_zfw_pending,_zfw_last_log_probs,_zfw_logp_fnv,_zfw_logp_fnv_lo,_zfw_logp_fnv_hi,_zfw_file_put,_zfw_files_drop,_zfw_error,_zfw_create2,_zfw_model_info,_zfw_evidence_count,_zfw_evidence_records,_zfw_evidence_data,_zfw_evidence_record_bytes,_zfw_evidence_failed,_zfw_evidence_clear,_zfw_evidence_fnv,_zfw_evidence_bad"
fi

# The TajweedFormer V4 engine (the SDK's tajweed/: zf_tajweed.h and its sources) and the JS surface
# over it (src/zft_api.c, which web/tajweed/engine.js calls). ZF_WASM_TAJWEED=auto (the default)
# builds them when the SDK has them, 1 requires them, 0 leaves them out. Without them the module is
# the 1.x engine and TajweedFormer's engine calls throw EngineNotAvailableError.
# UNTESTED with the real engine sources: written against zf_tajweed.h API version 1 before they existed.
TAJWEED="${ZF_WASM_TAJWEED:-auto}"; [ "$WITH1X" = "0" ] && TAJWEED=1   # the 2.0.0 module is the V4 binding
TJ_EXPORTS=""
if [ "$TAJWEED" != "0" ] && [ -f "$SDK/tajweed/include/zf_tajweed.h" ] && ls "$SDK"/tajweed/src/*.c >/dev/null 2>&1; then
  for src in "$SDK"/tajweed/src/*.c; do
    # engine_stub.c stands in for engine.c in builds without the engine; this build has the engine
    [ "$(basename "$src")" = engine_stub.c ] && [ -f "$SDK/tajweed/src/engine.c" ] && continue
    cc "$src" "tj_$(basename "$src" .c)" -I"$SDK/tajweed/include" -I"$SDK/tajweed/src" -Wall -Wextra -Werror
  done
  cc "$here/src/zft_api.c" zft_api -I"$SDK/tajweed/include" -Wall -Wextra -Werror
  TJ_EXPORTS=",$(grep -oE 'ZFT_EXPORT [^(]*zft_[a-z0-9_]+\(' "$here/src/zft_api.c" | sed -E 's/.*(zft_[a-z0-9_]+)\($/_\1/' | paste -sd, -)"
  echo "with the TajweedFormer engine ($SDK/tajweed)" >&2
elif [ "$TAJWEED" = "1" ]; then
  echo "ZF_WASM_TAJWEED=1 but $SDK/tajweed has no zf_tajweed.h and sources" >&2
  exit 1
fi

LDFLAGS=(
  ${ZF_WASM_LDFLAGS:-} -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTajweedFormer
  -sENVIRONMENT=web,worker -sFORCE_FILESYSTEM=1
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=1MB
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,HEAPF32,HEAPF64,HEAP32,HEAPU8,getValue,setValue,UTF8ToString,stringToNewUTF8
  -sEXPORTED_FUNCTIONS=_malloc,_free${ZFW_EXPORTS}${TJ_EXPORTS}
)
if [ "$DEBUG" = "1" ]; then LDFLAGS+=( -sASSERTIONS=2 -sSAFE_HEAP=1 -gsource-map ); else LDFLAGS+=( --closure=0 ); fi
if [ "$THREADS" != "0" ]; then
  # A library, so no PROXY_TO_PTHREAD (that wants a main()); pre-spawn the workers so the engine's
  # pool can start its threads from the main thread.
  LDFLAGS+=( -pthread -sPTHREAD_POOL_SIZE="$THREADS" -sPTHREAD_POOL_SIZE_STRICT=0 -sDEFAULT_PTHREAD_STACK_SIZE=1MB
             -Wno-pthreads-mem-growth )
fi

mkdir -p "$OUTDIR"
# Threaded and scalar builds get their own names so they can sit beside the default artifact.
BASE="tajweedformer"; [ "$WITH1X" = "1" ] && BASE="zipformer"
[ "$THREADS" != "0" ] && BASE="${BASE}-mt"
[ "$SIMD" = "0" ] && BASE="${BASE}-scalar"
[ "$INT8SIMD" = "0" ] && [ "$SIMD" = "1" ] && BASE="${BASE}-emu-int8"
OUT="$OUTDIR/$BASE.mjs"
echo "building -> $OUT  (simd128=$SIMD native-int8-kernel=$([ "$SIMD$INT8SIMD" = 11 ] && echo 1 || echo 0) threads=$THREADS opt=$OPT)"
emcc "${FLAGS[@]}" "${objs[@]}" "${LDFLAGS[@]}" -o "$OUT"
ls -la "$OUT" "${OUT%.mjs}.wasm"
