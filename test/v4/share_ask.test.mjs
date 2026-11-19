// SHARE_ASK_40.md through web/consent/ask40.js: every config case of vectors/share_ask.json
// (copied from quranlab-contract sdk-4.0.0-protected a046e93) through resolveConfig, and every case replayed step
// by step through decide, each step's action, why and whole new state as the reference gives them; then the same
// cases through SharingState (the stored names of 20.4, the app session's part in memory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveConfig, decide } from '../../web/consent/ask40.js';
import { SharingState, SHARING_STATE_KEY } from '../../web/consent/state.js';

const V = JSON.parse(readFileSync(new URL('../vectors40/share_ask.json', import.meta.url), 'utf8'));

test('20.3: every config case resolves as the reference does', () => {
  assert.equal(V.config_cases.length, 21);
  for (const c of V.config_cases) assert.deepEqual(resolveConfig(c.raw), c.resolved, c.name);
});

test('20.5: every case, every step: action, why and the whole new state', () => {
  let steps = 0;
  assert.equal(V.cases.length, 40);
  for (const c of V.cases) {
    let s = JSON.parse(JSON.stringify(c.state));
    c.steps.forEach((step, i) => {
      if (step.set) s = { ...s, ...step.set };
      const r = decide(s, step.event, c.config, step.now);
      const at = `${c.name}, step ${i + 1} (${step.event.type})`;
      assert.equal(r.action, step.action, at);
      assert.equal(r.why, step.why, at);
      assert.deepEqual(r.new_state, step.state, at);
      s = r.new_state;
      steps++;
    });
  }
  assert.equal(steps, 338);
});

// the stored names of 20.4 (and the 3.x object's own fields, which pass through)
const STORED = { last_ask_session: 'lastAskSession', installed_at: 'installedAt', last_ask_at: 'lastAskAt', last_ask_day: 'lastAskDay' };
const toStored = (ref) => { const o = {}; for (const [k, v] of Object.entries(ref)) if (k !== 'app') o[STORED[k] || k] = v; return o; };

test('20.4: the same cases through SharingState: the stored object under its stored names, the app part in memory', () => {
  for (const c of V.cases) {
    const kv = new Map();
    const store = { get: (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), set: (k, v) => kv.set(k, JSON.stringify(v)) };
    if (Object.keys(c.state).length) store.set(SHARING_STATE_KEY, { v: 1, ...toStored(c.state) });
    let now = null;
    const st = new SharingState(store, { enabled: () => true, clock: () => now.ms, tzMin: () => now.tz_min, shareAsk: () => c.config });
    c.steps.forEach((step, i) => {
      now = step.now;
      if (step.set) store.set(SHARING_STATE_KEY, { ...store.get(SHARING_STATE_KEY), ...toStored(step.set) });
      const r = st.decide(step.event);
      const at = `${c.name}, step ${i + 1} (${step.event.type})`;
      assert.equal(r.action, step.action, at);
      assert.equal(r.why, step.why, at);
      const want = toStored(step.state);
      const got = store.get(SHARING_STATE_KEY) || {};
      // (a field never written reads as null: absent and null are the same in 20.4)
      for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k] ?? null, v, `${at}: stored ${k}`);
      assert.deepEqual(st.app, step.state.app, `${at}: the app session's part`);
    });
  }
});
