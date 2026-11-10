#!/usr/bin/env bash
# libopus 1.6.1 for the web sharing pipeline, as its own small WebAssembly module:
#   dist/tajweedformer-opus.mjs + .wasm, loaded only when recitation sharing is on (web/sharing/encoder.js).
#
#   scripts/build_opus.sh            # fetch (pinned sha256), compile with emcc, link
#   OPUS_TARBALL=path scripts/build_opus.sh   # use a tarball already on disk (still checked)
#
# The same release and checksum as the Swift SDK's Opus.xcframework (tajweedformer-sdk-swift
# scripts/opus/build_opus_xcframework.sh), the same build choices: float (no FIXED_POINT), no DNN
# features (DEEP_PLC, DRED, OSCE off), no QEXT. The sources are compiled file by file from the
# release's own source lists (opus_sources.mk, celt_sources.mk, silk_sources.mk): no configure or
# CMake from the tarball runs. The tarball and the extracted tree live in third_party/opus/download
# (git-ignored); the object files in a temporary directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=1.6.1
SHA256=6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1
URL="https://downloads.xiph.org/releases/opus/opus-$VERSION.tar.gz"
DL="$here/third_party/opus/download"
OUTDIR="${OUTDIR:-$here/dist}"
command -v emcc >/dev/null || { echo "emcc not on PATH; run: source <emsdk>/emsdk_env.sh" >&2; exit 1; }

mkdir -p "$DL"
TAR="${OPUS_TARBALL:-$DL/opus-$VERSION.tar.gz}"
# downloads.xiph.org intermittently refuses TLS connections: retry, then the OSU Open Source Lab's mirror of it
# (the same file: the checksum below decides)
MIRROR="https://ftp.osuosl.org/pub/xiph/releases/opus/opus-$VERSION.tar.gz"
[ -f "$TAR" ] || curl -sfL --retry 3 --retry-all-errors --retry-delay 5 -o "$TAR" "$URL" \
  || curl -sfL --retry 3 --retry-all-errors --retry-delay 5 -o "$TAR" "$MIRROR"
got=$(sha256sum "$TAR" | cut -d' ' -f1)
[ "$got" = "$SHA256" ] || { echo "checksum mismatch for $TAR: $got" >&2; exit 1; }
SRC="$DL/opus-$VERSION"
[ -f "$SRC/include/opus.h" ] || tar -xzf "$TAR" -C "$DL"

# a make variable's file list from one of the release's .mk files
list() { # file variable
  tr -d '\r' < "$SRC/$1" | awk -v v="$2" '
    $1 == v && $2 == "=" { on = 1; next }
    on { line = $0; cont = sub(/\\$/, "", line); n = split(line, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") print a[i]; if (!cont) on = 0 }
  '
}
files=()
while read -r f; do files+=("$f"); done < <(list celt_sources.mk CELT_SOURCES; list silk_sources.mk SILK_SOURCES;
  list silk_sources.mk SILK_SOURCES_FLOAT; list opus_sources.mk OPUS_SOURCES; list opus_sources.mk OPUS_SOURCES_FLOAT)
[ "${#files[@]}" -gt 100 ] || { echo "only ${#files[@]} sources found in the .mk lists" >&2; exit 1; }

FLAGS=( -O3 -DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINT -DHAVE_LRINTF "-DPACKAGE_VERSION=\"$VERSION\""
  -I"$SRC/include" -I"$SRC/celt" -I"$SRC/silk" -I"$SRC/silk/float" -I"$SRC/src" -I"$SRC"
  -ffile-prefix-map="$SRC"=opus-$VERSION -w )
obj="$(mktemp -d)"; trap 'rm -rf "$obj"' EXIT
objs=()
i=0
for f in "${files[@]}"; do
  i=$((i + 1))
  o="$obj/$i.o"
  emcc -c "${FLAGS[@]}" "$SRC/$f" -o "$o"
  objs+=("$o")
done
emcc -c -O3 -I"$SRC/include" -Wall -Wextra -Werror "$here/src/opus_api.c" -o "$obj/opus_api.o"
objs+=("$obj/opus_api.o")

EXPORTS=_malloc,_free,_ow_enc_create,_ow_enc_get,_ow_enc_set,_ow_enc_encode,_ow_enc_destroy,_ow_dec_create,_ow_dec_decode,_ow_dec_destroy,_ow_version
mkdir -p "$OUTDIR"
OUT="$OUTDIR/tajweedformer-opus.mjs"
emcc -O3 "${objs[@]}" -o "$OUT" --closure=0 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createTajweedFormerOpus -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB -sSTACK_SIZE=512KB \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,HEAP32,UTF8ToString -sEXPORTED_FUNCTIONS="$EXPORTS"
echo "libopus $VERSION (sha256 $SHA256), ${#files[@]} sources -> $OUT"
ls -la "$OUT" "${OUT%.mjs}.wasm"
