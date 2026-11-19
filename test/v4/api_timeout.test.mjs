// A request to Quran Lab's API that gets no answer is cut after the frame's bound and read as no answer (ERRORS_40.md
// 24.3 network); a request with its own signal (a model file under SPEC 16's stall rule) is left to it. Stage B, staging,
// 11-18: a hanging config route made create() wait 82 s before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuranLab4, boundedFetch, API_TIMEOUT_MS } from '../../sdk4/frame/api4.js';
import { InstallKeys } from '../../sdk4/frame/keys.js';
import { StateStore, MemoryKV } from '../../sdk4/frame/stores.js';

// a server that never answers: the promise ends only when the request is aborted
const hanging = () => {
  const seen = [];
  const fetch = (url, init = {}) => {
    seen.push({ url, signal: !!init.signal });
    return new Promise((_, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  return { fetch, seen };
};

test('the bound is 30 s, as the C SDK\'s API requests', () => {
  assert.equal(API_TIMEOUT_MS, 30_000);
});

test('an API request with no answer is cut at the bound and is a network failure of its stage', async () => {
  const s = hanging();
  const ql = new QuranLab4({ key: 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa', site: 'https://app.example', apiUrl: 'https://api.test', fetch: s.fetch,
    state: await StateStore.open(new MemoryKV()), keys: await InstallKeys.create(), autoSend: false, apiTimeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(ql._call('GET', '/v1/config', { auth: 'key' }), (e) => e.qlReport && e.qlReport.stage === 'config' && e.qlReport.reason === 'network');
  const took = Date.now() - t0;
  // the config request, then the origin check that a request with no answer asks once: each cut at 150 ms
  assert.ok(took < 2000, `took ${took} ms`);
  assert.ok(s.seen.length >= 1 && s.seen.every((r) => r.signal));
});

test('a request that brings its own signal is left to it (a model file and its stall rule)', async () => {
  let got = null;
  const f = boundedFetch((url, init) => { got = init.signal; return Promise.resolve({ status: 200 }); }, 100);
  const own = new AbortController();
  await f('https://cdn.test/models/x', { signal: own.signal });
  assert.equal(got, own.signal);
  await f('https://api.test/v1/config', {});
  assert.ok(got && got !== own.signal);
});
