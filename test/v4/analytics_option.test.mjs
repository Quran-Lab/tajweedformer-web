// ANALYTICS_40 22.2 on the web: 4.0 has no analytics option. A page or desktop app that still passes `analytics`,
// whatever its value, is refused at once with invalid_argument; the message names the option, says it was removed
// because the analytics are always on, and points to docs/migrating-to-4.md. Runs with no input: the loader's
// create() stops before it opens anything (and at runtime_unsupported without the key, as Node has no page), the Node
// create() before it starts its Worker, so nothing reaches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTICS_REMOVED, refuseRemovedOptions } from '../../sdk4/shared/options.js';
import { TajweedClient as PageClient } from '../../sdk4/loader/client.js';
import { TajweedClient as NodeClient } from '../../sdk4/node/index.js';

const KEY = 'qlk_v1_apps-one_aaaaaaaaaaaaaaaaaaaaaa';
const VALUES = ['off', 'on', false, true, undefined, null, 0, {}];
const refused = (e) => e.code === 'invalid_argument' && e.message.includes(ANALYTICS_REMOVED);

test('the message names the option, says why it was removed, and points to the migration guide', () => {
  assert.match(ANALYTICS_REMOVED, /^the analytics option was removed in SDK 4\.0/);
  assert.match(ANALYTICS_REMOVED, /always on/);
  assert.match(ANALYTICS_REMOVED, /docs\/migrating-to-4\.md/);
  assert.equal([0x2013, 0x2014].some((c) => ANALYTICS_REMOVED.includes(String.fromCharCode(c))), false, 'no en or em dashes');
  for (const analytics of VALUES) assert.throws(() => refuseRemovedOptions({ key: KEY, analytics }), refused, String(analytics));
  for (const o of [{ key: KEY }, {}, undefined, null]) assert.doesNotThrow(() => refuseRemovedOptions(o));
});

test('the page loader: create({ analytics }) is invalid_argument, whatever its value, and nothing is opened', async () => {
  for (const analytics of VALUES) await assert.rejects(PageClient.create({ key: KEY, analytics }), refused, String(analytics));
  // without the option the same call goes on to the page check (Node has no page): the refusal was the option's
  await assert.rejects(PageClient.create({ key: KEY }), (e) => e.code === 'runtime_unsupported');
});

test('the Node path: create({ analytics }) is invalid_argument, whatever its value, before any Worker starts', async () => {
  for (const analytics of VALUES) {
    await assert.rejects(NodeClient.create({ key: KEY, appId: 'org.example.live', analytics }), refused, String(analytics));
  }
});
