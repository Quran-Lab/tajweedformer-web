// SDK 4.0.2, NO_WAIT_40.md (section 33): a finished shared recording uploads on mobile data with the data saver on
// (vectors40/no_wait_40.json sharing_upload_metered). The web's sharing pipeline (createSharing: the recorder, the
// capture, the outbox and its uploads) with real libopus and a stand-in API and R2, navigator.connection reporting
// cellular with the data saver on, every read of it counted: the start, the segment PUTs and the end go out, and the
// pipeline never reads the connection. (No upload option of the web SDK ever waited; this holds it so.)
import test from 'node:test';
import '../web/index.node.js'; // Node's parts of the SDK (a test imports its modules by path)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharing, MemoryStorage, loadOpus, segmentName } from '../web/sharing/index.js';
import { clipSeconds } from './sharing_stream_checks.mjs';
import { connectionStandIn, CONNECTIONS } from './v4/helpers/page.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const V = JSON.parse(readFileSync(path.join(root, 'test', 'vectors40', 'no_wait_40.json'), 'utf8'));
const have = existsSync(path.join(root, 'dist', 'tajweedformer-opus.mjs'));
const skip = have ? false : 'dist/tajweedformer-opus.mjs is not built (npm run build:opus)';
const opus = have ? await loadOpus() : null;

test('no_wait_40.json sharing_upload_metered: a finished shared recording uploads on mobile data with the data saver on', { skip }, async () => {
  const c = V.cases.find((x) => x.name === 'sharing_upload_metered');
  assert.ok(c && c.platforms.includes('web') && c.connection === 'metered' && c.outcome === 'uploaded');
  const conn = connectionStandIn(CONNECTIONS.metered(true), true);
  const seen = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
    const res = (status, obj) => new Response(status === 204 ? null : JSON.stringify(obj), { status });
    const urls = (id, from) => ({ id, urls: Array.from({ length: 20 }, (_, i) => from + i).map((n) => ({ n, expires_at: Math.floor(Date.now() / 1000) + 604800, url: `https://r2.test/v1/${id}/${segmentName(n)}.opus` })) });
    if (u.pathname === '/v1/uploads') return res(201, urls(init.headers['x-qlab-id'], 1));
    const m = /^\/v1\/uploads\/([0-9a-f]{32})\/urls$/.exec(u.pathname);
    if (m) return res(200, urls(m[1], Number(u.searchParams.get('from'))));
    if (u.host === 'r2.test' && init.method === 'PUT') return new Response('', { status: 200 });
    return res(404, { error: 'not_found' });
  };
  try {
    const sharing = await createSharing({ api: 'https://api.test', fetch, tokenProvider: async () => ({ token: 't', attested: false }), storage: new MemoryStorage(),
      consentVersion: 'deck-1', contributor: 'c'.repeat(32), enabled: () => true, flags: () => ({ contributions: true, upload_trust: { web: 'capped' } }),
      opus: async () => opus, device: { deviceClass: 'browser', osMajor: 14 }, locks: null, lifecycle: { document: null, window: null }, log: () => {} });
    const t = await sharing.startSession({ inputSampleRate: 48000, inputRoute: 'built_in', decode: { backend: 'exact', modelRevision: '4.1.0' } });
    const pcm = clipSeconds(48000, 12), step = 960;
    for (let i = 0; i < pcm.length; i += step) t.push(pcm.subarray(i, Math.min(pcm.length, i + step)));
    assert.equal(await t.finish({ completed: true }), 12000);
    await sharing.closeRecording();
    let items = [];
    for (let i = 0; i < 50 && !(items.length && items.every((x) => x.status === 'uploaded')); i++) {
      await sharing.outbox.drain({ ignoringBackoff: true });
      items = await sharing.outbox.items();
    }
    assert.deepEqual(items.map((x) => [x.status, x.segments, x.completed]), [['uploaded', 2, true]]);
    assert.equal(seen.filter((x) => x === 'POST api.test/v1/uploads').length, 1, seen.join(' | '));
    assert.equal(seen.filter((x) => x.startsWith('PUT r2.test/')).length, 2, seen.join(' | '));
    assert.equal(conn.reads, 0, 'navigator.connection was never read');
  } finally { conn.restore(); }
});
