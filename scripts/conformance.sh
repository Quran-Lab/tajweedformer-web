#!/usr/bin/env bash
# The conformance matrix under Node: every build this package ships, on the 35 parity clips, must
# give the SDK's expected bits (every phoneme id and every chunk's log-probs), on the feature path
# and the audio path, plus the stream API's other promises on the default build.
#
#   scripts/conformance.sh <data dir> [build ...]
#
# <data dir> is laid out like the SDK's conformance data (release conformance-data-2 of
# Quran-Lab/tajweedformer-sdk): model_engine2.onnx with its .zfg, .zfg.bin, frontend.zfw and layers.zfw,
# feats/*.f32, audio/*.pcm (16 kHz float32), parity35_expected.jsonl and
# parity35_audio_expected.jsonl. With audio48/*.pcm and parity35_audio48_expected.jsonl there as
# well (scripts/make_48k.sh), 48 kHz audio through the engine's resampler is checked too. Builds
# default to every dist/*.mjs that exists of zipformer, zipformer-mt and zipformer-scalar.
#
# Evidence (the SDK's ZfEvidence, which the phoneme engine reads), against the native C stream's
# (zf_stream_check --evidence, the SDK's conformance/*_evidence_expected.jsonl), every value of every
# chunk bit for bit: with <data dir>/tapped holding the model's graph with the taps (the SDK's
# tools/zftaps.py, then tools/zfg_export.py, beside the same .zfw files), the 35 clips' audio on
# every build; with ZF_B8_DATA naming b8's engine files (taps, MODEL.c160 / .c320 graphs and their
# overlays) and its own clips in audio/ and feats/, b8 at 480, 320 and 160 ms on the default build
# (and its features at 480 and 160 ms against ONNX Runtime's outputs). The model at 320 and 160 ms
# where the data directory has those graphs (MODEL.c320.onnx, MODEL.c160.onnx and their overlays).
# The SDK's evidence, 320 ms and 160 ms expected files are still v3.1's (zipformer-sdk
# conformance/README.md), so those rows need v3.1's data (release conformance-data-1) for now.
# Rows whose data is not there are listed as not run at the end.
# Exits nonzero if any run falls short of every clip.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$(cd "${1:?usage: scripts/conformance.sh <data dir> [build ...]}" && pwd)"; shift
BUILDS=("$@")
if [ ${#BUILDS[@]} -eq 0 ]; then
  for b in zipformer zipformer-mt zipformer-scalar; do [ -f "$here/dist/$b.mjs" ] && BUILDS+=("$here/dist/$b.mjs"); done
fi
FE=$DATA/parity35_expected.jsonl AE=$DATA/parity35_audio_expected.jsonl A48=$DATA/parity35_audio48_expected.jsonl
SDKC="${TAJWEEDFORMER_SDK_DIR:-${ZIPFORMER_SDK_DIR:-$here/vendor/zipformer-sdk}}/conformance"
EV=$SDKC/parity35_audio_evidence_expected.jsonl B8=${ZF_B8_DATA:-}
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
(cd "$DATA" && ls feats/*.f32) > "$OUT/feats.txt"
(cd "$DATA" && ls audio/*.pcm) > "$OUT/audio.txt"
[ -f "$A48" ] && (cd "$DATA" && ls audio48/*.pcm) > "$OUT/audio48.txt"
[ -n "$B8" ] && { ls "$DATA"/audio/*.pcm; ls "$(cd "$B8" && pwd)"/audio/*.pcm; } > "$OUT/b8.txt"
fails=0
run() { # name build threads expected list [args]
  local name=$1 b=$2 t=$3 exp=$4 list=$5; shift 5
  local timing r rc
  timing=$(node "$here/test/conformance.mjs" "$b" "$DATA" "$list" "$t" "$OUT/r.jsonl" "$@" 2>&1 | tail -1)
  r=$(node "$here/test/conformance_check.mjs" "$OUT/r.jsonl" "$exp" 2>&1 | tail -1); rc=$?
  printf '%-18s %-30s %s\n' "$(basename "$b" .mjs)" "$name" "$r"
  printf '%-18s %-30s   %s\n' "" "" "$timing"
  [ $rc -eq 0 ] || fails=$((fails + 1))
}
for b in "${BUILDS[@]}"; do
  threads=1
  case $(basename "$b") in zipformer-mt*) threads=4 ;; esac
  run "features, $threads thread(s)" "$b" "$threads" "$FE" "$OUT/feats.txt"
  run "audio, $threads thread(s)" "$b" "$threads" "$AE" "$OUT/audio.txt"
  [ -f "$A48" ] && run "48 kHz audio, $threads thread(s)" "$b" "$threads" "$A48" "$OUT/audio48.txt" --rate 48000
  case $(basename "$b") in
    zipformer.mjs)
      run "audio at 16 kHz declared" "$b" 1 "$AE" "$OUT/audio.txt" --rate 16000
      run "one-frame pushes" "$b" 1 "$FE" "$OUT/feats.txt" --piece 1
      run "a new stream per clip" "$b" 1 "$FE" "$OUT/feats.txt" --recreate
      run "room for one phoneme" "$b" 1 "$FE" "$OUT/feats.txt" --max-out 1 --complete-runs
      run "prefetch lead 0" "$b" 1 "$FE" "$OUT/feats.txt" --lead 0
      # the shorter steps, where the data directory has their graphs and overlays
      for ms in 320 160; do
        [ -f "$DATA/model_engine2.c$ms.onnx.zfg" ] &&
          run "features, $ms ms" "$b" 1 "$SDKC/parity35_c${ms}_expected.jsonl" "$OUT/feats.txt" --chunk-ms $ms
      done ;;
    zipformer-mt.mjs)
      run "features, 2 threads" "$b" 2 "$FE" "$OUT/feats.txt" ;;
  esac
  [ -f "$DATA/tapped/model_engine2.onnx.zfg" ] && [ -f "$EV" ] &&
    run "evidence, audio, $threads thread(s)" "$b" "$threads" "$EV" "$OUT/audio.txt" --evidence --model-dir "$DATA/tapped"
  if [ -n "$B8" ] && [ "$(basename "$b")" = zipformer.mjs ]; then
    { ls "$DATA"/feats/*.f32; ls "$(cd "$B8" && pwd)"/feats/*.f32; } > "$OUT/b8feats.txt"
    run "b8 features, 480 ms" "$b" 1 "$SDKC/b8_parity_expected.jsonl" "$OUT/b8feats.txt" --model-dir "$B8"
    run "b8 features, 160 ms" "$b" 1 "$SDKC/b8_parity_c160_expected.jsonl" "$OUT/b8feats.txt" --chunk-ms 160 --model-dir "$B8"
    for ms in 480 320 160; do
      exp=$SDKC/b8_evidence_expected.jsonl
      [ $ms = 480 ] || exp=$SDKC/b8_evidence_c${ms}_expected.jsonl
      run "b8 evidence, audio, $ms ms" "$b" 1 "$exp" "$OUT/b8.txt" --evidence --chunk-ms $ms --model-dir "$B8"
    done
  fi
done
[ -f "$A48" ] || echo "not run: 48 kHz audio (no $(basename "$A48") in the data directory; scripts/make_48k.sh)"
{ [ -f "$DATA/tapped/model_engine2.onnx.zfg" ] && [ -f "$EV" ]; } || echo "not run: evidence (no tapped graph in the data directory)"
for ms in 320 160; do [ -f "$DATA/model_engine2.c$ms.onnx.zfg" ] || echo "not run: $ms ms (no MODEL.c$ms graph in the data directory)"; done
echo "$fails failing"
exit $((fails > 0))
