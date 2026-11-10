#!/usr/bin/env bash
# A native libopusfile reader for the sharing stream tests (optional): scripts/opusfile_check.c linked with
# opusfile 0.12, libogg 1.3.5 and libopus 1.6.1, all from xiph.org with the sha256 xiph.org publishes, compiled
# with the host C compiler (gcc or clang, plain C). Nothing from the tarballs' build systems runs.
#
#   scripts/build_opusfile_check.sh                 # -> third_party/opus/download/opusfile_check(.exe)
#   OPUSFILE_CHECK=<that file> npm test             # the append test then reads its streams with libopusfile too
#
# Why: libopus decoding (wasm) and ffmpeg already check the streams; libopusfile is the reference Ogg Opus
# reader (seeking index, link and gap detection), so it also catches what a decoder that only plays packets
# forgives (a granule or sequence gap is reported as OP_HOLE).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DL="$here/third_party/opus/download"
CC="${CC:-gcc}"
mkdir -p "$DL"
fetch() { # name sha256 url mirror
  local f="$DL/$1"
  [ -f "$f" ] || curl -sfL --retry 3 --retry-all-errors --retry-delay 5 -o "$f" "$3" || curl -sfL --retry 3 -o "$f" "$4"
  local got
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$got" = "$2" ] || { echo "checksum mismatch for $f: $got" >&2; exit 1; }
  tar -xzf "$f" -C "$DL"
}
fetch libogg-1.3.5.tar.gz 0eb4b4b9420a0f51db142ba3f9c64b333f826532dc0f48c6410ae51f4799b664 \
  https://downloads.xiph.org/releases/ogg/libogg-1.3.5.tar.gz https://ftp.osuosl.org/pub/xiph/releases/ogg/libogg-1.3.5.tar.gz
fetch opusfile-0.12.tar.gz 118d8601c12dd6a44f52423e68ca9083cc9f2bfe72da7a8c1acb22a80ae3550b \
  https://downloads.xiph.org/releases/opus/opusfile-0.12.tar.gz https://ftp.osuosl.org/pub/xiph/releases/opus/opusfile-0.12.tar.gz
fetch opus-1.6.1.tar.gz 6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1 \
  https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz https://ftp.osuosl.org/pub/xiph/releases/opus/opus-1.6.1.tar.gz
OGG="$DL/libogg-1.3.5" OF="$DL/opusfile-0.12" OPUS="$DL/opus-1.6.1"

# libogg's configure writes config_types.h; the fixed-width types are all it holds
cat > "$OGG/include/ogg/config_types.h" <<'H'
#ifndef __CONFIG_TYPES_H__
#define __CONFIG_TYPES_H__
#include <stdint.h>
typedef int16_t ogg_int16_t;
typedef uint16_t ogg_uint16_t;
typedef int32_t ogg_int32_t;
typedef uint32_t ogg_uint32_t;
typedef int64_t ogg_int64_t;
typedef uint64_t ogg_uint64_t;
#endif
H

list() { # file variable: a make variable's file list from one of the opus release's .mk files
  tr -d '\r' < "$OPUS/$1" | awk -v v="$2" '
    $1 == v && $2 == "=" { on = 1; next }
    on { line = $0; cont = sub(/\\$/, "", line); n = split(line, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") print a[i]; if (!cont) on = 0 }
  '
}
srcs=()
while read -r f; do srcs+=("$OPUS/$f"); done < <(list celt_sources.mk CELT_SOURCES; list silk_sources.mk SILK_SOURCES;
  list silk_sources.mk SILK_SOURCES_FLOAT; list opus_sources.mk OPUS_SOURCES; list opus_sources.mk OPUS_SOURCES_FLOAT)
[ "${#srcs[@]}" -gt 100 ] || { echo "only ${#srcs[@]} opus sources found" >&2; exit 1; }

obj="$(mktemp -d)"; trap 'rm -rf "$obj"' EXIT
objs=()
i=0
cc() { i=$((i + 1)); "$CC" -c -O2 -w "$@" -o "$obj/$i.o"; objs+=("$obj/$i.o"); }
for f in "${srcs[@]}"; do
  cc -DOPUS_BUILD -DUSE_ALLOCA -DHAVE_LRINT -DHAVE_LRINTF '-DPACKAGE_VERSION="1.6.1"' \
    -I"$OPUS/include" -I"$OPUS/celt" -I"$OPUS/silk" -I"$OPUS/silk/float" -I"$OPUS/src" -I"$OPUS" "$f"
done
for f in bitwise framing; do cc -I"$OGG/include" "$OGG/src/$f.c"; done
for f in info internal opusfile stream; do cc -I"$OF/include" -I"$OGG/include" -I"$OPUS/include" "$OF/src/$f.c"; done
cc -I"$OF/include" -I"$OGG/include" -I"$OPUS/include" "$here/scripts/opusfile_check.c"
OUT="${OUT:-$DL/opusfile_check}"
"$CC" -O2 "${objs[@]}" -o "$OUT" -lm
echo "opusfile 0.12, libogg 1.3.5, libopus 1.6.1 ($CC) -> $OUT"
