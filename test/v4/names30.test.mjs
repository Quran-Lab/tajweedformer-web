// The shared names every TajweedFormer SDK keeps in 4.0 (NAMES.md: "Unchanged: every other name and meaning"): the
// heads, the default selection, the speech rule's constants, the decoded layer's fields and the error catalogue's
// codes and docs links, from the 3.0 vector test/vectors30/names.json, through the modules the loader runs
// (web/api/heads.js, speech.js and errors.js). Ported from the 3.x test/vectors30.test.mjs, which took TajweedError
// from the 3.x package entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TajweedError, ERROR_CODES } from '../../web/api/errors.js';
import { HEAD_NAMES, DEFAULT_HEADS, decodedOf, TajweedHeads } from '../../web/api/heads.js';
import { ACTIVE_HEADS, DEFAULT_SILENCE_MS, FRAME_MS } from '../../web/api/speech.js';
import { REMOVED_OPTIONS, refuseRemovedOptions } from '../../sdk4/shared/options.js';

const n = JSON.parse(readFileSync(new URL('../vectors30/names.json', import.meta.url), 'utf8'));

test('names.json: heads, default selection, events, error codes, option values', () => {
  const h = new TajweedHeads(Object.fromEntries(n.heads.map((x) => [x.name, new Float32Array((x.frameMs === 40 ? 2 : 4) * x.classes)])), 2, null);
  assert.deepEqual([...HEAD_NAMES], n.heads.map((x) => x.name));
  for (const x of n.heads) {
    const g = h.get(x.name);
    assert.deepEqual([g.name, g.kind, g.frameMs, g.classes], [x.name, x.kind, x.frameMs, x.classes]);
    assert.deepEqual(Object.keys(g), n.head_fields);
  }
  assert.deepEqual([...DEFAULT_HEADS], n.default_heads);
  // the catalogue (errors.json) is the source of the codes; this file lists them in catalogue order
  assert.deepEqual([...ERROR_CODES], n.error_codes);
  assert.equal(n.error_codes.length, 26);
  assert.equal(new TajweedError('cancelled').docs, n.error_docs_base + 'cancelled');
  assert.deepEqual([[...ACTIVE_HEADS], DEFAULT_SILENCE_MS, FRAME_MS, 20], [n.speech.active, n.speech.default_window_ms, n.speech.frame_ms, n.speech.timing_frame_ms]);
  const d = decodedOf({ logProbs: new Float32Array(38).fill(-5), n40: 1 });
  assert.deepEqual(Object.keys(d), n.decoded_fields);
});

// names.json `client_options` holds two options, both 3.x only: `analytics` (ANALYTICS_40 22.2) and `audience`
// (ONE_SHEET_40 26.4: "the 3.0 names.json audience option ... 3.x only, skipped by 4.0 replays"). They are not replayed
// as option values; what 4.0 does with each is checked instead: a key of that name is refused whatever its value
// (test/v4/analytics_option.test.mjs, test/v4/audience_option.test.mjs). The vector file is a byte copy and unchanged.
test('names.json client_options: 3.x only (analytics, audience), skipped as values; 4.0 refuses each of them, whatever its value', () => {
  assert.deepEqual(Object.keys(n.client_options).sort(), ['analytics', 'audience']);
  assert.deepEqual([...REMOVED_OPTIONS].sort(), Object.keys(n.client_options).sort());
  for (const [name, values] of Object.entries(n.client_options)) {
    for (const v of values) assert.throws(() => refuseRemovedOptions({ key: 'qlk_v1_k', [name]: v }), (e) => e.code === 'invalid_argument' && e.message.includes(`the ${name} option was removed in SDK 4.0`), `${name}: ${v}`);
  }
});
