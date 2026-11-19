// docs/api.md is generated from web/index.d.ts (scripts/make_api_doc.mjs): the page is what the generator writes now,
// and it names every declaration and member of the public surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, parse } from '../../scripts/make_api_doc.mjs';

const read = (f) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('docs/api.md is the page the generator writes from web/index.d.ts', () => {
  assert.equal(read('docs/api.md'), render(JSON.parse(read('package.json')), read('web/index.d.ts')),
    'run node scripts/make_api_doc.mjs');
});

test('every declaration and member of web/index.d.ts is on the page', () => {
  const page = read('docs/api.md');
  const { decls } = parse(read('web/index.d.ts'));
  assert.ok(decls.length >= 25, `${decls.length} declarations`);
  for (const d of decls) {
    assert.ok(page.includes(`## ${d.name}\n`), d.name);
    for (const m of d.members) assert.ok(page.includes(`\`${m.sig}\``), `${d.name}: ${m.sig}`);
  }
  for (const name of ['TajweedClient', 'TajweedModel', 'TajweedSession', 'TajweedHeads', 'TajweedBackend', 'TajweedError']) {
    assert.ok(decls.some((d) => d.name === name), name);
  }
  assert.ok(decls.find((d) => d.name === 'TajweedClient').members.some((m) => m.sig.startsWith('prefetch(') && m.sig.includes('Promise<')),
    'a signature on two lines is read whole');
});
