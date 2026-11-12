// The public surface cannot grow back unnoticed (NAMING.md section 8, SPEC section 8): the package has the two
// entry points and no other; the type definitions export exactly the listed types plus the sharing UI
// components; the runtime exports are the classes among them; and no scorer symbol is left anywhere in the
// sources the package ships.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as entry from '../web/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// NAMING.md section 8, in its order
const PUBLIC_TYPES = ['TajweedClient', 'TajweedModel', 'TajweedSession', 'TajweedHeads', 'TajweedBackend',
  'TajweedClientOptions', 'TajweedSessionOptions',
  'TajweedChunk', 'TajweedDecoded', 'TajweedToken', 'TajweedWord', 'TajweedFrame', 'TajweedHead', 'TajweedEvent',
  'TajweedTokens', 'TajweedCalibration', 'TajweedReference', 'TajweedClip',
  'TajweedSharing', 'TajweedAnalytics', 'TajweedDiagnosis',
  'TajweedError', 'Microphone'];
const UI_COMPONENTS = ['QuranLabConsent', 'QuranLabSharingSettings'];
const RUNTIME = ['TajweedClient', 'TajweedModel', 'TajweedSession', 'TajweedHeads', 'TajweedError', 'Microphone', ...UI_COMPONENTS];

test('the package has one entry point with its type definitions; there is no ./node entry (3.1.0)', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '3.1.0');
  assert.deepEqual(Object.keys(pkg.exports), ['.', './package.json']);
  // ".": the Node entry under the node condition, the browser entry for everything else (a bundler, a CDN)
  assert.deepEqual(pkg.exports['.'], { types: './web/index.d.ts', node: './web/index.node.js', default: './web/index.js' });
  // 3.1.0: the entry that gave a folder reader is gone, with its files
  for (const f of ['web/node.js', 'web/node.d.ts']) assert.equal(existsSync(new URL(`../${f}`, import.meta.url)), false, f);
  assert.ok(!pkg.files.some((f) => /scorer/.test(f)));
  assert.ok(!Object.keys(pkg.scripts).some((s) => /scorer/.test(s)));
});

test('the public type list is NAMING.md section 8 plus the sharing UI components, exactly', () => {
  const dts = read('web/index.d.ts');
  const names = [...dts.matchAll(/^export\s+(?:declare\s+)?(?:class|interface|type|function|const|enum)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  assert.deepEqual(names.slice().sort(), [...PUBLIC_TYPES, ...UI_COMPONENTS].sort());
  assert.equal(new Set(names).size, names.length);
  assert.ok(!/^export\s+\*|^export\s+\{/m.test(dts), 'no re-export in the type definitions');
  assert.equal(PUBLIC_TYPES.length, 23);
  // 3.1.0: no public declaration takes a model as a folder, a URL, a reader or bytes
  assert.equal(/static\s+open\s*\(/.test(dts.slice(dts.indexOf('export declare class TajweedModel'), dts.indexOf('export declare class TajweedModel') + 4000)), false, 'TajweedModel has no static open');
  assert.equal(/dirReader|urlReader|memoryReader/.test(dts), false);
});

test('the runtime exports are the classes of that list, and nothing else', () => {
  assert.deepEqual(Object.keys(entry).sort(), RUNTIME.slice().sort());
  for (const k of RUNTIME) assert.equal(typeof entry[k], 'function', k);
  assert.equal(entry.TajweedModel.open, undefined, 'TajweedModel.open is not there');
  assert.equal(Object.getOwnPropertyNames(entry.TajweedModel).includes('open'), false);
});

test('docs/api.md covers the surface: every public type, every public member of the classes, every error code', async () => {
  const doc = read('docs/api.md');
  for (const t of [...PUBLIC_TYPES, ...UI_COMPONENTS]) assert.ok(doc.includes(`\`${t}\``) || doc.includes(`## ${t}`), `${t} is not in docs/api.md`);
  const { ERROR_CODES } = await import('../web/api/errors.js');
  for (const c of ERROR_CODES) assert.ok(doc.includes(`\`${c}\``), `error code ${c} is not in docs/api.md`);
  const dts = read('web/index.d.ts');
  for (const k of ['TajweedClient', 'TajweedModel', 'TajweedSession', 'TajweedHeads', 'Microphone']) {
    const proto = Object.getOwnPropertyNames(entry[k].prototype).filter((n) => n !== 'constructor' && !n.startsWith('_'));
    const statics = Object.getOwnPropertyNames(entry[k]).filter((n) => !['length', 'name', 'prototype'].includes(n) && !n.startsWith('_'));
    const block = dts.slice(dts.indexOf(`export declare class ${k} `));
    const decl = block.slice(0, block.indexOf('\n}\n'));
    for (const n of [...proto, ...statics]) {
      assert.ok(new RegExp(`\\b${n}\\b`).test(doc), `${k}.${n} is not in docs/api.md`);
      assert.ok(new RegExp(`\\b${n}[(:?]`).test(decl), `${k}.${n} is not in web/index.d.ts`);
    }
    // and the other way: a member the type definitions declare exists at runtime
    for (const m of decl.matchAll(/^\s+(?:static\s+|readonly\s+)*([a-zA-Z]\w*)[(:?]/gm)) {
      if (m[1] === 'constructor' || m[1] === 'private') continue;
      const inst = ['id', 'version', 'build', 'contexts', 'tokens', 'calibration', 'reference', 'sampleClips', 'sharing', 'analytics', 'pin', 'sampleRate'];
      assert.ok(m[1] in entry[k].prototype || m[1] in entry[k] || inst.includes(m[1]), `${k}.${m[1]} is declared and missing at runtime`);
    }
  }
});

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
