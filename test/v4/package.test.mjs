// The 4.0 package as an app, a bundler and Node see it. Ported from the 3.x tests of the 3.x package (api_surface,
// import_graph and model_online 15.1): the public names of web/index.d.ts are NAMES.md's; the browser entry exports
// its classes and entry points; it is the hosted loader's thin wrapper and imports nothing (so nothing of Node reaches
// a bundler); the exports map gives the browser entry to a bundler and the Node path (sdk4/node) to Node, and no deep
// path; the classes cannot be made from parts a page supplies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from '../../web/index.js';
import { TajweedClient as LoaderClient } from '../../sdk4/loader/client.js';
import { TajweedModel as LoaderModel } from '../../sdk4/loader/model.js';
import { TajweedClient as NodeClient } from '../../sdk4/node/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const pkg = JSON.parse(read('package.json'));
const code = (c) => (e) => e && e.name === 'TajweedError' && e.code === c;

// NAMES.md, in its order: the npm entry points, the classes, the objects on the classes, the plain data types
// (TajweedErrorCode is named there too: declared in web/index.d.ts as the type of `code`, not exported)
const ENTRY = ['LOADER_URL', 'API', 'loadQuranLab'];
const CLASSES = ['TajweedClient', 'TajweedModel', 'TajweedSession', 'TajweedHeads', 'TajweedError', 'Microphone'];
const OBJECTS = ['TajweedAnalytics', 'TajweedSharing', 'TajweedTokens', 'TajweedCalibration', 'TajweedClip'];
const DATA = ['TajweedClientOptions', 'TajweedSessionOptions', 'TajweedChunk', 'TajweedEvent', 'TajweedDecoded', 'TajweedToken', 'TajweedWord',
  'TajweedFrame', 'TajweedHead', 'TajweedBackend', 'TajweedDiagnosis', 'TajweedReference', 'RecitedOutcome'];

// every module specifier of a source text: import ... from 'x', export ... from 'x', import 'x', import('x')
function specifiers(src) {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const re of [/\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of text.matchAll(re)) out.push(m[1]);
  }
  return out;
}

test('the public names of web/index.d.ts are NAMES.md\'s, exactly', () => {
  const dts = read('web/index.d.ts');
  const names = [...dts.matchAll(/^export\s+(?:declare\s+)?(?:class|interface|type|function|const|enum)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
  assert.deepEqual(names.slice().sort(), [...ENTRY, ...CLASSES, ...OBJECTS, ...DATA].sort());
  assert.equal(new Set(names).size, names.length);
  assert.ok(!/^export\s+\*|^export\s+\{/m.test(dts), 'no re-export in the type definitions');
  assert.match(dts, /^type TajweedErrorCode =/m);
  const doc = read('NAMES.md');
  for (const n of [...ENTRY, ...CLASSES, ...OBJECTS, ...DATA, 'TajweedErrorCode']) assert.ok(doc.includes(`\`${n}\``) || doc.includes(`\`${n}(`), `${n} is not in NAMES.md`);
  // the sharing elements are defined by name by the loader, never module exports (NAMES.md, "Changed from 3.x")
  for (const n of ['QuranLabConsent', 'QuranLabSharingSettings']) assert.equal(names.includes(n), false, n);
  // a model comes only from Quran Lab's server: no public declaration takes a folder, a URL, a reader or bytes
  const model = dts.slice(dts.indexOf('export declare class TajweedModel'));
  assert.equal(/static\s+open\s*\(/.test(model.slice(0, model.indexOf('\n}\n'))), false, 'TajweedModel has no static open');
  assert.equal(/dirReader|urlReader|memoryReader/.test(dts), false);
});

test('the browser entry exports every class and entry point of NAMES.md', () => {
  for (const k of CLASSES) assert.equal(typeof entry[k], 'function', k);
  assert.equal(typeof entry.loadQuranLab, 'function');
  assert.equal(entry.API, 4);
  assert.equal(entry.LOADER_URL, 'https://web.quranlab.ai/4/loader.js');
  assert.equal(entry.TajweedModel.open, undefined, 'TajweedModel.open is not there');
  assert.equal(Object.getOwnPropertyNames(entry.TajweedModel).includes('open'), false);
});

test('the browser entry exports nothing else; the fallback host\'s loader stays inside the wrapper', () => {
  assert.deepEqual(Object.keys(entry).sort(), [...ENTRY, ...CLASSES].sort());
  assert.equal('LOADER_FALLBACK_URL' in entry, false, 'not an export: the fallback host is the loader\'s own business');
  assert.equal(/LOADER_FALLBACK_URL/.test(read('web/index.d.ts')) || /LOADER_FALLBACK_URL/.test(read('NAMES.md')), false);
  // still used: loadQuranLab() tries web2.quranlab.ai when the default loader does not load
  assert.match(read('web/index.js'), /^const LOADER_FALLBACK_URL = 'https:\/\/web2\.quranlab\.ai\/4\/loader\.js';$/m);
});

test('loadQuranLab: the default loader that does not load is tried on the fallback host, web2.quranlab.ai', async () => {
  const g = globalThis, tried = [];
  const saved = { document: g.document, QuranLab: g.QuranLab };
  // a page whose web.quranlab.ai script fails and whose web2.quranlab.ai script runs the loader
  g.document = {
    head: { appendChild: (s) => { tried.push(s.src); setTimeout(() => { if (s.src.includes('//web2.')) { g.QuranLab = { api: 4, v4: { ok: true } }; s.onload(); } else s.onerror(); }, 0); } },
    createElement: () => ({ remove() {} }),
  };
  try {
    delete g.QuranLab;
    const v4 = await entry.loadQuranLab();
    assert.deepEqual(v4, { ok: true });
    assert.deepEqual(tried, ['https://web.quranlab.ai/4/loader.js', 'https://web2.quranlab.ai/4/loader.js']);
  } finally {
    if (saved.document === undefined) delete g.document; else g.document = saved.document;
    if (saved.QuranLab === undefined) delete g.QuranLab; else g.QuranLab = saved.QuranLab;
  }
});

test('the exports map: the browser entry for a bundler, the Node path for Node (also as ./node), every file there', () => {
  assert.deepEqual(Object.keys(pkg.exports), ['.', './node', './package.json']);
  assert.deepEqual(Object.keys(pkg.exports['.']), ['types', 'node', 'default'], 'types first, then node, then default');
  assert.deepEqual(pkg.exports['.'], { types: './web/index.d.ts', node: './sdk4/node/index.js', default: './web/index.js' });
  assert.deepEqual(pkg.exports['./node'], { types: './web/index.d.ts', default: './sdk4/node/index.js' });
  assert.equal('browser' in pkg && typeof pkg.browser === 'object' && pkg.browser !== null, false, 'no browser field that remaps modules');
  for (const e of Object.values(pkg.exports)) {
    for (const f of typeof e === 'string' ? [e] : Object.values(e)) assert.ok(existsSync(path.join(root, f)), `${f} exists`);
  }
});

test('the browser entry is the hosted loader\'s thin wrapper: it imports nothing, so no Node built-in and no bare module reaches a bundler', () => {
  const src = read('web/index.js');
  assert.deepEqual(specifiers(src), []);
  assert.equal(/\brequire\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false);
  assert.ok(src.includes("'https://web.quranlab.ai/4/loader.js'"), 'it loads the hosted loader');
});

test('15.1 a Node program resolves the package to the Node path, by name and as ./node; no deep path is exported', () => {
  const require = createRequire(import.meta.url);
  assert.match(require.resolve(pkg.name).replace(/\\/g, '/'), /\/sdk4\/node\/index\.js$/);
  assert.match(require.resolve(`${pkg.name}/node`).replace(/\\/g, '/'), /\/sdk4\/node\/index\.js$/);
  for (const sub of ['web/index.js', 'web/api/model.js', 'web/tajweed/manifest.js', 'web/platform/client.js', 'sdk4/frame/controller.js', 'sdk4/loader/client.js', 'sdk4/node/engine.js']) {
    assert.throws(() => require.resolve(`${pkg.name}/${sub}`), (e) => e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED', sub);
  }
});

test('15.1 the classes cannot be made from parts a page supplies: only create() and client.model() make them', () => {
  const parts = { rpc: { call: async () => ({}) }, info: { id: 'v4.0', version: '4.1.0', build: 'ab'.repeat(20), contexts: ['c16_l64'], clips: [] }, frame: {}, opts: {} };
  for (const x of [undefined, {}, parts]) {
    assert.throws(() => new LoaderClient(x), code('invalid_argument'));
    assert.throws(() => new LoaderClient(x, Symbol('TajweedClient.create')), code('invalid_argument'));
    assert.throws(() => new LoaderModel(x), code('invalid_argument'));
    assert.throws(() => new NodeClient(x), code('invalid_argument'));
  }
});
