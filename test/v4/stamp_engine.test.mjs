// scripts/stamp-engine.mjs: the publish workflow sets the Node entry's built-in engine (sdk4/node/engine.js
// BUILTIN_ENGINE) only to a build Quran Lab serves, verified as the Node path verifies it. A stand-in host with the
// contract's test key; nothing reaches Quran Lab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { stampSource, verifyServedEngine, ENGINE_FILE } from '../../scripts/stamp-engine.mjs';
import { engineIndexText } from '../../sdk4/shared/engine-index.js';
import { hex } from '../../sdk4/shared/bytes.js';
import { edSignBytes, signerPub, b64u } from './helpers/fake-api.mjs';

const ID = '20261118.0123456789ab';
const PUB = signerPub();
const utf8 = (s) => new TextEncoder().encode(s);
const FILES = [{ name: 'qlcore.wasm', sha256: 'ab'.repeat(32), size: 3 }, { name: 'qlcore.mjs', sha256: 'cd'.repeat(32), size: 2 }];

async function host(indexFor) {
  const kid = hex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', PUB))).slice(0, 16);
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const m = /\/4\/engine\/([^/]+)\/index\.json$/.exec(url);
    const text = m && indexFor(m[1]);
    if (!text) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ text, kid, sig: b64u(edSignBytes(utf8(text))) }), { status: 200 });
  };
  return { fetch, asked, opts: { base: 'https://engine.test/4/engine/', pinned: [hex(PUB)], fetch } };
}

test('the source tree has one BUILTIN_ENGINE line, null; stamping rewrites that line only', () => {
  const src = readFileSync(ENGINE_FILE, 'utf8');
  assert.match(src, /^export const BUILTIN_ENGINE = null;$/m);
  const out = stampSource(src, ID);
  assert.match(out, new RegExp(`^export const BUILTIN_ENGINE = '${ID.replace('.', '\\.')}';$`, 'm'));
  const a = src.split('\n'), b = out.split('\n');
  assert.equal(a.length, b.length);
  assert.equal(a.filter((l, i) => l !== b[i]).length, 1);
  assert.equal(stampSource(out, '20261119.ba9876543210').includes("'20261119.ba9876543210'"), true, 'a stamped tree can be stamped again');
  for (const bad of ['', 'latest', '2026111.0123456789ab', '20261118.0123456789AB', "20261118.0123456789ab'; evil()"]) {
    assert.throws(() => stampSource(src, bad), /not an engine id/, bad);
  }
  assert.throws(() => stampSource(src + '\nexport const BUILTIN_ENGINE = null;\n', ID), /2 BUILTIN_ENGINE lines/);
});

test('only a served build signed with the pinned key, naming the same id, with the one-thread variant, is stamped', async () => {
  const good = await host((id) => engineIndexText({ engine: id, core: { release: '4.0.0-c1', commit: '932f419' }, files: FILES }));
  const idx = await verifyServedEngine(ID, good.opts);
  assert.equal(idx.engine, ID);
  assert.deepEqual(good.asked, [`https://engine.test/4/engine/${ID}/index.json`]);
  // not served
  const none = await host(() => null);
  await assert.rejects(verifyServedEngine(ID, none.opts), /answered 404/);
  // the index of another build at this id's address
  const other = await host(() => engineIndexText({ engine: '20261117.ffffffffffff', core: { release: '4.0.0-c1', commit: '932f419' }, files: FILES }));
  await assert.rejects(verifyServedEngine(ID, other.opts), /not of 20261118/);
  // threads only: nothing the Node path can run
  const mt = await host((id) => engineIndexText({ engine: id, core: { release: '4.0.0-c1', commit: '932f419' },
    files: [{ name: 'qlcore-mt.wasm', sha256: 'ab'.repeat(32), size: 3 }, { name: 'qlcore-mt.mjs', sha256: 'cd'.repeat(32), size: 2 }] }));
  await assert.rejects(verifyServedEngine(ID, mt.opts), /one-thread variant/);
  // signed with a key that is not pinned
  await assert.rejects(verifyServedEngine(ID, { ...good.opts, pinned: ['11'.repeat(32)] }), { code: 'key' });
  await assert.rejects(verifyServedEngine('latest', good.opts), /not an engine id/);
});
