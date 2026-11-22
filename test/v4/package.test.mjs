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
import { ROLES, LOADER_SWITCH_MS } from '../../sdk4/shared/endpoints.js';
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
  'TajweedFrame', 'TajweedHead', 'TajweedBackend', 'TajweedDiagnosis', 'TajweedReference', 'RecitedOutcome',
  // 4.0.2 (ERRORS_40.md 24.13): the cause on a TajweedError
  'TajweedErrorCause'];

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

test('the browser entry exports nothing else; the other hosts\' loader URLs stay inside the wrapper', () => {
  assert.deepEqual(Object.keys(entry).sort(), [...ENTRY, ...CLASSES].sort());
  for (const name of ['LOADER_FALLBACK_URL', 'LOADER_URLS']) {
    assert.equal(name in entry, false, 'not an export: the other hosts are the loader\'s own business');
    assert.equal(new RegExp(name).test(read('web/index.d.ts')) || new RegExp(name).test(read('NAMES.md')), false);
  }
});

// a page whose scripts do what `act(src)` says: 'load' runs the loader, 'fail' errors, 'hang' never ends; a fresh
// copy of the wrapper each time (it loads the loader once per page)
let runs = 0;
async function wrapperRun(act, o = {}) {
  const wrapper = await import(`../../web/index.js?run=${++runs}`);
  const g = globalThis, tried = [];
  const saved = { document: g.document, QuranLab: g.QuranLab };
  g.document = {
    head: { appendChild: (s) => {
      tried.push(s.src);
      const a = act(s.src);
      setTimeout(() => { if (a === 'load') { g.QuranLab = { api: 4, v4: { ok: true, from: s.src } }; s.onload(); } else if (a === 'fail') s.onerror(); }, 0);
    } },
    createElement: () => ({ remove() {} }),
  };
  try {
    delete g.QuranLab;
    let v4 = null, err = null;
    try { v4 = await wrapper.loadQuranLab(o); } catch (e) { err = e; }
    return { v4, err, tried };
  } finally {
    if (saved.document === undefined) delete g.document; else g.document = saved.document;
    if (saved.QuranLab === undefined) delete g.QuranLab; else g.QuranLab = saved.QuranLab;
  }
}
const LOADERS = ROLES.web_frame.map((h) => `https://${h}/4/loader.js`);

test('the wrapper\'s written-out hosts are the web_frame role of endpoints.js, in order', () => {
  const m = /const LOADER_URLS = \[([^\]]*)\]/.exec(read('web/index.js'));
  assert.ok(m, 'the list is written out in web/index.js');
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')), [...ROLES.web_frame]);
  assert.equal(/LOADER_SWITCH_MS = 4_000;/.test(read('web/index.js')), LOADER_SWITCH_MS === 4000);
});

test('loadQuranLab: the web_frame hosts in order (28.6): a host that fails is followed at once, the first that loads is the page\'s', async () => {
  // web fails, web2 loads: as 4.0.0
  let r = await wrapperRun((src) => (src.includes('//web2.') ? 'load' : 'fail'));
  assert.deepEqual(r.v4, { ok: true, from: LOADERS[1] });
  assert.deepEqual(r.tried, LOADERS.slice(0, 2));
  // the first two fail: the third host's loader
  r = await wrapperRun((src) => (src === LOADERS[2] ? 'load' : 'fail'));
  assert.equal(r.v4.from, LOADERS[2]);
  assert.deepEqual(r.tried, LOADERS.slice(0, 3));
  // every host fails: needs_connection, after all five were tried
  r = await wrapperRun(() => 'fail');
  assert.equal(r.err && r.err.code, 'needs_connection');
  assert.deepEqual(r.tried, LOADERS);
  // 4.0.2 (24.13): the wrapper's own error has the cause an app reads on every error, frozen
  assert.deepEqual(r.err.errorCause, { stage: 'runtime', reason: 'loader', needs: 'model' });
  assert.ok(Object.isFrozen(r.err.errorCause));
});

test('loadQuranLab: a host that has not loaded within the switch time is left in the page and the next is tried; a src given is the only one', async () => {
  // web and web2 never answer: web-b after two switch times, and it loads
  const t0 = Date.now();
  let r = await wrapperRun((src) => (src === LOADERS[2] ? 'load' : 'hang'), { switchMs: 40 });
  assert.equal(r.v4.from, LOADERS[2]);
  assert.deepEqual(r.tried, LOADERS.slice(0, 3));
  assert.ok(Date.now() - t0 >= 75, 'the third host after two switch times');
  // a pinned src: that one only
  r = await wrapperRun(() => 'fail', { src: 'https://web.quranlab.ai/4/loader@0123456789ab.js' });
  assert.equal(r.err && r.err.code, 'needs_connection');
  assert.deepEqual(r.tried, ['https://web.quranlab.ai/4/loader@0123456789ab.js']);
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
