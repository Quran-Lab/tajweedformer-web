#!/usr/bin/env bash
# Build the TajweedFormer scorer to WebAssembly without the streaming engine: the engine's tajweed
# library (calibration, the expected table, the layered config and the scorer, portable C11) with
# its engine_stub.c, and src/zft_api.c. It scores heads from any source (the Neural Engine, an NPU, a
# server, saved heads); streams need the full build (scripts/build.sh with the engine's tajweed/).
#
#   scripts/build_scorer.sh              # dist/tajweedformer-scorer.mjs + .wasm
#   scripts/build_scorer.sh --out DIR
#   scripts/build_scorer.sh --debug      # -O1 with assertions and safe heap
#
# Env: TAJWEED_SRC is the engine's tajweed/ folder (default: the copy in third_party/tajweedformer-sdk,
# whose SOURCE.txt names the engine commit; or the submodule's when it has one).
# Compiled as the engine compiles it: C11, -O2, -ffp-contract=off (no multiply-add fused anywhere:
# the scorer's bits must not depend on FMA), -Wall -Wextra -Werror.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${TAJWEED_SRC:-}"
if [ -z "$SRC" ]; then
  if [ -f "$here/vendor/zipformer-sdk/tajweed/include/zf_tajweed.h" ]; then SRC="$here/vendor/zipformer-sdk/tajweed"
  else SRC="$here/third_party/tajweedformer-sdk/tajweed"; fi
fi
[ -f "$SRC/include/zf_tajweed.h" ] || { echo "no zf_tajweed.h under $SRC" >&2; exit 1; }
command -v emcc >/dev/null || { echo "emcc not on PATH; run: source <emsdk>/emsdk_env.sh" >&2; exit 1; }

OPT="-O2"; DEBUG=0; OUTDIR="$here/dist"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUTDIR="$2"; shift 2 ;;
    --debug) DEBUG=1; OPT="-O1"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

# the engine's ZF_TAJWEED_CORE (tajweed/CMakeLists.txt) and the glue without streams
CORE=(names tj_json calib expected model config tj_ctc score tj_libm tj_sha256 engine_stub)
FLAGS=( -std=c11 "$OPT" -ffp-contract=off -I"$SRC/include" -I"$SRC/src" -Wall -Wextra -Werror )

obj="$(mktemp -d)"; trap 'rm -rf "$obj"' EXIT
objs=()
for f in "${CORE[@]}"; do
  emcc -c "${FLAGS[@]}" "$SRC/src/$f.c" -o "$obj/$f.o"
  objs+=("$obj/$f.o")
done
emcc -c "${FLAGS[@]}" "$here/src/zft_api.c" -o "$obj/zft_api.o"
objs+=("$obj/zft_api.o")

EXPORTS="_malloc,_free,$(grep -oE 'ZFT_EXPORT [^(]*zft_[a-z0-9_]+\(' "$here/src/zft_api.c" | sed -E 's/.*(zft_[a-z0-9_]+)\($/_\1/' | paste -sd, -)"
LDFLAGS=(
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTajweedScorer
  -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=2GB -sSTACK_SIZE=1MB
  -sEXPORTED_RUNTIME_METHODS=FS,HEAPF32,HEAPF64,HEAP32,HEAPU8,UTF8ToString,stringToNewUTF8
  -sEXPORTED_FUNCTIONS="$EXPORTS"
)
if [ "$DEBUG" = "1" ]; then LDFLAGS+=( -sASSERTIONS=2 -sSAFE_HEAP=1 -g ); else LDFLAGS+=( --closure=0 ); fi

mkdir -p "$OUTDIR"
OUT="$OUTDIR/tajweedformer-scorer.mjs"
echo "building -> $OUT  (tajweed sources: $SRC, opt=$OPT)"
emcc "${FLAGS[@]}" "${objs[@]}" "${LDFLAGS[@]}" -o "$OUT"
ls -la "$OUT" "${OUT%.mjs}.wasm"
