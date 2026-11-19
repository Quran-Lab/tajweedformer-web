// No scorer symbol is left anywhere in the sources the package ships (SPEC section 3). The 4.0 package's public
// surface (NAMES.md, the exports map, the browser entry) is checked in test/v4/package.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

test('no scorer symbol is left in the shipped sources', () => {
  // SPEC section 3: the names of the removed scoring calls, result types, settings and scorer builds
  const GONE = ['finishAndScore', 'TajweedScorer', 'EngineTajweedScorer', 'TajweedScoring', 'TajweedResult', 'SiteVerdict', 'MaddVerdict', 'LetterVerdict',
    'WordVerdict', 'TajweedSummary', 'WordScores', 'TfResult', 'TfWordScore', 'TajweedSettings', 'TajweedOptions', 'RemoteTajweed', 'ResolvedTajweedSettings',
    'EffectiveTajweed', 'setRemoteConfig', 'effectiveSettings', 'engineSettings', 'expectedTokens', 'expectedWords', 'ayahCount(surah)', 'tajweedUnavailable',
    'CalibrationInvalid', 'TajweedSettingsError', 'resolveSettings', 'validateCalibration', 'wordResults', 'zft_score', 'zft_config', 'zft_expected', 'zft_result',
    'zf_tajweed_score', 'zf_tajweed_config', 'zf_tajweed_result', 'zf_tajweed_expected', 'zf_tajweed_ayah_count', 'tajweedformer-scorer', 'build_scorer',
    'SCORER_HEADS', 'tajweed/settings'];
  // the 2.x entry points: gone from everything a developer copies (the migration guide names them on purpose)
  const OLD_ENTRY = ['TajweedFormer.load', 'createStream', 'pushAudio', 'QuranLab.configure', 'bindTajweed', 'enableSharing', 'tajweedformer/platform',
    'tajweedformer/consent', 'tajweedformer/sharing', 'tajweedformer/scorer', 'tajweedformer/tajweed', 'portal.quranlab.ai'];
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(path.join(root, d))) {
      const p = `${d}/${e}`;
      if (e === 'node_modules' || (e === 'dist' && d.startsWith('examples'))) continue; // an example's own install and build
      if (statSync(path.join(root, p)).isDirectory()) walk(p); else if (/\.(js|mjs|ts|c|h|sh|html|json)$/.test(e)) files.push(p);
    }
  };
  for (const d of ['web', 'src', 'scripts', 'examples']) if (existsSync(path.join(root, d))) walk(d);
  files.push('package.json');
  const hits = [];
  for (const f of files) {
    const text = read(f);
    for (const g of GONE) if (text.includes(g)) hits.push(`${f}: ${g}`);
  }
  for (const f of ['README.md', 'docs/api.md', 'examples/quickstart.html', 'examples/node.mjs', 'web/index.js', 'web/index.d.ts']) {
    if (!existsSync(path.join(root, f))) continue;
    const text = read(f);
    for (const g of OLD_ENTRY) if (text.includes(g)) hits.push(`${f}: ${g}`);
  }
  assert.deepEqual(hits, []);
  // the engine binding calls nothing but the model, the stream and the reference table
  const calls = new Set([...read('web/tajweed/engine.js').matchAll(/_zft_([a-z0-9_]+)/g)].map((m) => m[1]));
  for (const c of calls) assert.match(c, /^(api_version|version|layout|layout_count|error|model_|stream_|reference_|top2|topk)/, c);
  assert.ok(!existsSync(path.join(root, 'web/scorer.js')) && !existsSync(path.join(root, 'web/tajweed/settings.js')) && !existsSync(path.join(root, 'third_party/tajweedformer-sdk')));
});
