// ONE_SHEET_40 26.1 on the web (owner, 11-19: every app is a normal app): 4.0 has no audience option. A page or desktop
// app that still passes `audience`, whatever its value (undefined as an own key too), is refused at once with
// invalid_argument; the message names the option, says it was removed because every app shows the same sharing sheet,
// and points to docs/migrating-to-4.md. Every entry that takes client options: the loader's create() (it stops before it
// opens anything, and at runtime_unsupported without the key, as Node has no page), the Node create() (before its
// Worker starts) and the 3.x Client this repository keeps for its 3.x tests (web/api/client.js), so nothing reaches a
// network. The frame passes none to its Worker (test/v4/units.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/index.node.js'; // Node's parts of the SDK, for the 3.x Client
import { AUDIENCE_REMOVED, ANALYTICS_REMOVED, REMOVED_OPTIONS, refuseRemovedOptions } from '../../sdk4/shared/options.js';
import { TajweedClient as PageClient } from '../../sdk4/loader/client.js';
import { TajweedClient as NodeClient } from '../../sdk4/node/index.js';
import { createClient } from '../../web/api/client.js';

const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const VALUES = ['children', 'general', undefined, null, '', false, 0, {}];
const refused = (e) => e.code === 'invalid_argument' && e.message.includes(AUDIENCE_REMOVED);

test('the message names the option, says why it was removed, and points to the migration guide', () => {
  assert.match(AUDIENCE_REMOVED, /^the audience option was removed in SDK 4\.0 because every app shows the same sharing sheet/);
  assert.match(AUDIENCE_REMOVED, /docs\/migrating-to-4\.md/);
  assert.equal([0x2013, 0x2014].some((c) => AUDIENCE_REMOVED.includes(String.fromCharCode(c))), false, 'no en or em dashes');
  assert.deepEqual([...REMOVED_OPTIONS], ['analytics', 'audience']);
  for (const audience of VALUES) assert.throws(() => refuseRemovedOptions({ key: KEY, audience }), refused, String(audience));
  // an own key holding undefined, and a key the options inherit, are keys all the same
  assert.throws(() => refuseRemovedOptions(JSON.parse('{"key":"k","audience":"children"}')), refused);
  assert.throws(() => refuseRemovedOptions(Object.assign(Object.create({ audience: 'general' }), { key: KEY })), refused);
  // the analytics refusal is unchanged; only the names asked for are checked
  assert.throws(() => refuseRemovedOptions({ key: KEY, analytics: 'off' }), (e) => e.code === 'invalid_argument' && e.message.includes(ANALYTICS_REMOVED));
  assert.doesNotThrow(() => refuseRemovedOptions({ key: KEY, analytics: 'off' }, ['audience']));
  for (const o of [{ key: KEY }, { key: KEY, threads: 'off', storage: 'a' }, {}, undefined, null]) assert.doesNotThrow(() => refuseRemovedOptions(o));
});

test('the page loader: create({ audience }) is invalid_argument, whatever its value, and nothing is opened', async () => {
  for (const audience of VALUES) await assert.rejects(PageClient.create({ key: KEY, audience }), refused, String(audience));
  // without the option the same call goes on to the page check (Node has no page): the refusal was the option's
  await assert.rejects(PageClient.create({ key: KEY }), (e) => e.code === 'runtime_unsupported');
});

test('the Node path: create({ audience }) is invalid_argument, whatever its value, before any Worker starts', async () => {
  for (const audience of VALUES) {
    await assert.rejects(NodeClient.create({ key: KEY, appId: 'org.example.live', audience }), refused, String(audience));
  }
});

test('the 3.x Client kept in this repository refuses an audience key too, before it reads any state', async () => {
  for (const audience of VALUES) {
    await assert.rejects(createClient({ key: KEY, appId: 'org.example.live', audience }, { fetch: () => { throw new Error('no request'); } }), refused, String(audience));
  }
});
