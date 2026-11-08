#!/usr/bin/env bash
# The 48 kHz leg of the conformance data: every 16 kHz clip in <data dir>/audio upsampled 3:1 with
# scipy's resample_poly into <data dir>/audio48, and the native engine's decode of those clips
# (the SDK's zf_stream_check --rate 48000, which runs its own resampler back to 16 kHz) as
# <data dir>/parity35_audio48_expected.jsonl. scripts/conformance.sh then holds every WebAssembly
# build to the native engine's bits at 48 kHz.
#
#   scripts/make_48k.sh <data dir> <native tajweedformer-sdk build dir>
#
# The native build is any configuration of Quran-Lab/tajweedformer-sdk at the pinned commit or later
# (for example cmake -S vendor/zipformer-sdk -B build -DZF_RELEASE=ON -DCMAKE_BUILD_TYPE=Release).
# Needs python3 with numpy and scipy.
set -euo pipefail
DATA="$(cd "${1:?usage: scripts/make_48k.sh <data dir> <native build dir>}" && pwd)"
NATIVE="$(cd "${2:?usage: scripts/make_48k.sh <data dir> <native build dir>}" && pwd)"
mkdir -p "$DATA/audio48"
python3 - "$DATA" <<'PY'
import glob, os, sys
import numpy as np
from scipy.signal import resample_poly
data = sys.argv[1]
for f in sorted(glob.glob(os.path.join(data, "audio", "*.pcm"))):
    x = np.fromfile(f, dtype=np.float32).astype(np.float64)
    resample_poly(x, 3, 1).astype(np.float32).tofile(os.path.join(data, "audio48", os.path.basename(f)))
PY
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cd "$DATA"
ls audio48/*.pcm > "$tmp/list.txt"
"$NATIVE/bench/accel/zf_stream_check" model_engine2.onnx "$tmp/list.txt" 1 "$tmp/r.jsonl" --rate 48000 >/dev/null
# the expected-file form: {"clip": name, ...}
python3 - "$tmp/r.jsonl" > parity35_audio48_expected.jsonl <<'PY'
import json, os, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    print(json.dumps({"clip": os.path.basename(r["features"])[:-4], "chunks": r["chunks"],
                      "tokens": r["tokens"], "logp_fnv": r["logp_fnv"]}))
PY
echo "wrote $DATA/audio48 and $DATA/parity35_audio48_expected.jsonl ($(wc -l < parity35_audio48_expected.jsonl) clips)"
