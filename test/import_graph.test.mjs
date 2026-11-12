// Nothing a browser bundler follows from the package's browser entry may import a Node built-in: a plain
// `vite build` of an app that imports @quran-lab/tajweedformer stopped on "Module "node:path" has been externalized
// for browser compatibility" once. This walks the import graph (static imports, re-exports and dynamic imports
// with a literal) from the browser entry and from the engine's Worker, and fails on a `node:` specifier, a bare
// name of a Node built-in, or any bare specifier at all (the package has no dependencies). The Node entry is the
// only place that may import them. `npm run example:build` is the same check with a real bundler.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const rel = (f) => path.relative(root, f).replace(/\\/g, '/');

// every module specifier of a source text: import ... from 'x', export ... from 'x', import 'x', import('x')
function specifiers(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const re of [/\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of code.matchAll(re)) out.push(m[1]);
  }
  return out;
}

// the files reached from `entry`, and every specifier that is not a relative path
function walk(entry) {
  const seen = new Set(), bare = [];
  const todo = [path.join(root, entry)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    // the Emscripten glue is one built file; it is checked for Node modules below, and is absent before a build
    if (rel(f).startsWith('dist/')) continue;
    for (const s of specifiers(readFileSync(f, 'utf8'))) {
      if (s.startsWith('.')) todo.push(path.resolve(path.dirname(f), s));
      else bare.push(`${rel(f)}: ${s}`);
    }
  }
  return { files: [...seen].map(rel).sort(), bare };
}

test('the specifier scan sees static imports, re-exports, side-effect imports and dynamic imports', () => {
  const src = "import a from './a.js';\nimport { b,\n  c } from \"./b.js\";\nexport * from './c.js';\nexport { d } from './d.js';\nimport './e.js';\n"
    + "const f = await import('node:fs');\n// import x from './comment.js';\n/* import('./block.js') */\nconst g = import( './g.js' );\n";
  assert.deepEqual(specifiers(src), ['./a.js', './b.js', './c.js', './d.js', './e.js', 'node:fs', './g.js']);
});

test('the package resolves to the browser entry for a bundler and to the Node entry in Node', () => {
  assert.deepEqual(Object.keys(pkg.exports['.']), ['types', 'node', 'default'], 'types first, then node, then default');
  assert.equal(pkg.exports['.'].default, './web/index.js');
  assert.equal(pkg.exports['.'].node, './web/index.node.js');
  assert.equal('browser' in pkg && typeof pkg.browser === 'object', false, 'no browser field that remaps modules');
  for (const e of Object.values(pkg.exports)) {
    for (const f of typeof e === 'string' ? [e] : Object.values(e)) assert.ok(existsSync(path.join(root, f)), `${f} exists`);
  }
});

for (const [name, entry] of [['the browser entry (web/index.js)', 'web/index.js'], ['the engine\'s Worker (web/api/worker.js)', 'web/api/worker.js']]) {
  test(`nothing reached from ${name} imports a Node built-in or any bare module`, () => {
    const g = walk(entry);
    assert.ok(g.files.length >= 3, `${g.files.length} files reached`);
    const node = g.bare.filter((s) => { const m = s.split(': ')[1]; return m.startsWith('node:') || builtinModules.includes(m.split('/')[0]); });
    assert.deepEqual(node, [], 'a Node built-in is reachable from the browser entry');
    assert.deepEqual(g.bare, [], 'the package has no dependencies: every import is a relative path');
    assert.equal(g.files.includes('web/index.node.js') || g.files.includes('web/tajweed/node.js'), false, 'the Node-only files are not reached');
  });
}

test('the Node entry is where the Node built-ins are imported, and it re-exports the browser entry', () => {
  const src = readFileSync(path.join(root, 'web/index.node.js'), 'utf8');
  const s = specifiers(src);
  assert.ok(s.includes('./index.js') && /export \* from '\.\/index\.js'/.test(src));
  assert.ok(s.some((x) => x.startsWith('node:')));
  // the hook itself imports nothing
  assert.deepEqual(specifiers(readFileSync(path.join(root, 'web/platform/node-hook.js'), 'utf8')), []);
});

test('the built engine and libopus glue name no Node module (built for web and worker)', { skip: existsSync(path.join(root, 'dist/tajweedformer.mjs')) ? false : 'dist/ is not built (npm run build:all)' }, () => {
  for (const f of ['dist/tajweedformer.mjs', 'dist/tajweedformer-opus.mjs']) {
    if (!existsSync(path.join(root, f))) continue;
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.equal(/(?:import|require)\s*\(\s*["']node:/.test(src), false, `${f} imports a Node module`);
    assert.equal(/createRequire/.test(src), false, `${f} was built with the Node environment`);
  }
});

test('the build scripts make the glue for web and worker only', () => {
  for (const f of ['scripts/build.sh', 'scripts/build_opus.sh']) {
    const src = readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /-sENVIRONMENT=web,worker(?![,\w])/, f);
  }
});
