// The README's quick start (examples/quickstart.html), as SDK 4.0 writes it: the page loads Quran Lab's hosted loader
// (API 4) with a script tag, and the README shows exactly the example's script: ten lines or fewer of Client, model,
// listen, read, with no sample rate and no audio plumbing. Ported from the 3.x test/quickstart.test.mjs; its run of the
// script through the 3.x Client is deleted (the 4.0 script needs the hosted loader and Quran Lab's frame, which
// scripts/browser-web4.mjs runs in a browser on its own page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOADER_URL } from '../../web/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
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

test('quick start: the hosted loader, then Client, model, listen, read in ten lines or fewer; no sample rate', () => {
  assert.ok(html.includes(`<script src="${LOADER_URL}" crossorigin="anonymous"></script>`), 'the page loads the hosted loader of API 4');
  assert.equal(/\bimport\b/.test(script), false, 'no import: the loader sets globalThis.QuranLab');
  assert.match(script, /QuranLab\.TajweedClient\.create\(/);
  assert.match(script, /key: 'qlk_v1_\.\.\.'/, 'the key placeholder is the documented one');
  const lines = script.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  for (const step of ['TajweedClient.create(', 'client.model()', 'model.listen(', 'session.chunks', 'chunk.decoded.text', 'endOnSilenceMs']) assert.ok(script.includes(step), step);
  assert.ok(!/sampleRate|48000|16000|AudioContext|getUserMedia/.test(script), 'no sample rate and no audio plumbing in the quick start');
  assert.match(script, /sdk\.quranlab\.ai/);
  // the example also runs from a sample clip, through the same path
  assert.match(rest, /model\.sampleClips\[0\]/);
});
