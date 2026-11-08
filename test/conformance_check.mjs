// Compare a conformance run (test/conformance.mjs) with an expected set, bit for bit: the same
// phoneme ids and the same FNV-1a of every chunk's log-probs, clip by clip. The expected lines are
// the SDK's parity35_expected.jsonl / parity35_audio_expected.jsonl ({"clip": ...}) or another run
// ({"features": ...}). Where an expected line has ev_fnv (the SDK's *_evidence_expected.jsonl, from
// zf_stream_check --evidence), the run's must equal it and its ev_bad be 0: every evidence value of
// every chunk, bit for bit. Exits 1 unless every expected clip matches.
//
//   node test/conformance_check.mjs <run.jsonl> <expected.jsonl>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [runPath, expPath] = process.argv.slice(2);
const read = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const key = (r) => r.clip ?? basename(r.features).replace(/\.[^.]+$/, '');
const got = new Map(read(runPath).map((r) => [key(r), r]));
const exp = read(expPath);
const bad = [];
for (const e of exp) {
  const g = got.get(key(e));
  if (!g || g.logp_fnv !== e.logp_fnv || JSON.stringify(g.tokens) !== JSON.stringify(e.tokens) ||
      ('ev_fnv' in e && (g.ev_fnv !== e.ev_fnv || g.ev_bad !== 0))) bad.push(key(e));
}
const what = exp.some((e) => 'ev_fnv' in e) ? 'tokens, every log-prob, every evidence value' : 'tokens, every log-prob';
console.log(`${exp.length - bad.length}/${exp.length} clips bit-identical (${what})` +
  (bad.length ? `; differ: ${bad.join(', ')}` : ''));
process.exit(bad.length || exp.length === 0 ? 1 : 0);
