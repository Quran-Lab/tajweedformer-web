// The README's quick start (examples/quickstart.html): the README shows exactly the example's script, the script
// is ten lines or fewer of Client, model, listen, read with no sample rate in it, and it runs in Node from the
// "microphone" to what the model heard, and from a sample clip with no microphone.
//
// The run uses stand-ins for the browser objects the page touches (the buttons and the output element, the
// microphone objects of test/helpers/fakemic.mjs) and the page's script unchanged except for its import line,
// which points at a module that makes the Client with the SDK's test seams (a stub of Quran Lab's API and CDN).
// The run uses the synthetic model build and the fake engine host. A real browser with a fake audio device and
// a real model folder runs scripts/browser-quickstart.mjs.
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resetClientForTests } from '../web/api/client.js';
import { build3, stubPlatform, seamsFor, audioFor } from './helpers/model3.mjs';
import { fakeMicrophone, fakePage } from './helpers/fakemic.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(path.join(root, 'examples/quickstart.html'), 'utf8').replace(/\r\n/g, '\n');
const script = html.split('// README:begin\n')[1].split('// README:end')[0];
const rest = html.split('// README:end\n')[1].split('</script>')[0];

test('quick start: the README shows the example\'s script, character for character', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const section = readme.split('\n## Quick start\n');
  assert.equal(section.length, 2, 'README.md has one "## Quick start" section');
  const shown = section[1].split('```js\n')[1].split('```')[0];
  assert.equal(shown, script);
});

test('quick start: Client, model, listen, read in ten lines or fewer; only the package\'s entry; no sample rate', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const imports = [...script.matchAll(/from '([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, [pkg.name], 'one import: the package');
  assert.ok(html.includes(`"${pkg.name}": "../web/index.js"`), 'the import map covers the import');
  assert.match(script, /key: 'qlk_v1_\.\.\.'/, 'the key placeholder is the documented one');
  const lines = script.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  for (const step of ['TajweedClient.create(', 'client.model()', 'model.listen(', 'session.chunks', 'chunk.decoded.text', 'endOnSilenceMs']) assert.ok(script.includes(step), step);
  assert.ok(!/sampleRate|48000|16000|AudioContext|getUserMedia/.test(script), 'no sample rate and no audio plumbing in the quick start');
  assert.match(script, /sdk\.quranlab\.ai/);
  // the example also runs from a sample clip, and starts a new take when the page comes back
  assert.match(rest, /model\.sampleClips\[0\]/);
  assert.match(rest, /visibilitychange/);
});

// run the page's script with stand-in browser objects; `seams` are the Client's test seams
async function runPage(seams, { mic, page }) {
  const els = { '#listen': {}, '#clip': {}, '#again': { checked: true }, '#heard': { textContent: '' } };
  const document = Object.assign(page.document, { querySelector: (q) => els[q] || null });
  Object.defineProperty(document, 'hidden', { configurable: true, get() { return document.visibilityState === 'hidden'; } });
  const saved = { document: globalThis.document };
  globalThis.document = document;
  globalThis.__quickstart = seams;
  const shim = path.join(root, 'test', `.quickstart-client-${process.pid}.mjs`);
  const file = path.join(root, 'test', `.quickstart-run-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(shim, "import { createClient } from '../web/api/client.js';\n"
    + "export const TajweedClient = { create: (o) => createClient({ ...o, key: 'qlk_v1_test_aaaaaaaaaaaaaaaaaaaaaa' }, globalThis.__quickstart) };\n");
  const importLine = "import { TajweedClient } from '@quran-lab/tajweedformer';";
  assert.ok(script.includes(importLine), 'the script has the import line this test replaces');
  writeFileSync(file, (script + rest).replace(importLine, `import { TajweedClient } from './${path.basename(shim)}';`));
  const done = () => {
    rmSync(file, { force: true }); rmSync(shim, { force: true });
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    delete globalThis.__quickstart;
  };
  try { await import(pathToFileURL(file).href); } catch (e) { done(); throw e; }
  return { els, done, mic, page };
}

test('quick start: runs from the microphone to what the model heard, from a sample clip, and again after the page was hidden', async () => {
  resetClientForTests();
  const api = await stubPlatform({ build: await build3() });
  const mic = fakeMicrophone({ sampleRate: 48000 });
  const page = fakePage();
  const seams = seamsFor(api, { microphone: mic.seams, lifecycle: page });
  const { els, done } = await runPage(seams, { mic, page });
  try {
    assert.equal(typeof els['#listen'].onclick, 'function', 'the script waits for the tap');
    assert.equal(mic.opened, 0, 'no microphone before the tap');
    // the tap: the microphone at 48 kHz, a recitation, then silence long enough for endOnSilenceMs to end the take
    let take = els['#listen'].onclick();
    while (!mic.node) await new Promise((r) => setTimeout(r, 2));
    mic.play(audioFor([0, 0, 3, 3, 0, 5, 5, 5, 1, 7, 0, 0, 9, 9, ...new Array(80).fill(0)], 48000));
    await take;
    assert.equal(els['#heard'].textContent, 't3 t5 | t7 t9');
    assert.equal(mic.track.stopped, true, 'the take ended on the silence and released the microphone');
    assert.ok(api.log.some((x) => x.path === '/v1/config'), 'the key was used: the signed config was fetched');
    assert.ok(api.log.some((x) => x.host === 'cdn' && x.path === 'manifest.json'), 'the model came from the config');
    // the sample clip: no microphone
    const opened = mic.opened;
    await els['#clip'].onclick();
    assert.equal(els['#heard'].textContent, 't3 t5 | t7 t9');
    assert.equal(mic.opened, opened);
    // a take is listening, the page is hidden (the take ends), the page comes back: a new take starts
    take = els['#listen'].onclick();
    await new Promise((r) => setTimeout(r, 10));
    page.hide();
    await take;
    assert.equal(mic.track.stopped, true);
    const before = mic.opened;
    page.show();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(mic.opened, before + 1, 'back on the page: listening again');
    page.hide();
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    done();
    resetClientForTests();
  }
});
