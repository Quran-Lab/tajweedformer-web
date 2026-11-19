// The Node path's engine thread (a worker_threads Worker of sdk4/node/index.js): the same Controller as the web frame's
// engine Worker (sdk4/frame/controller.js), served over the same port protocol (serve.js), as a desktop app: the
// desktop key's app id and platform, no site, no Turnstile, the folder's stores (files.js), its install keys and lease
// (store.js) and the signed engine (engine.js). Takes run here, so they never hold up the app's event loop.
import { parentPort } from 'node:worker_threads';
import { Controller } from '../frame/controller.js';
import { serve } from '../frame/serve.js';
import { DirFiles, FileKV } from './files.js';
import { NodeLeaseStore } from './store.js';
import { loadNodeEngine, ENGINE_BASE, BUILTIN_ENGINE } from './engine.js';
import { QURANLAB_PUBLIC_KEY_HEX } from '../../web/tajweed/manifest.js';

parentPort.once('message', (d) => {
  if (!d || d.ql !== 'start' || !d.port || !d.options) return;
  const o = d.options;
  // the test seams (index.js passes them only with QL_NODE_TEST=1): a local API, the contract's test key, a machine id
  const t = o.test || {};
  const pins = Array.isArray(t.pins) && t.pins.length ? t.pins : [QURANLAB_PUBLIC_KEY_HEX];
  const ctl = new Controller({
    key: o.key, desktop: { platform: o.platform, appId: o.appId }, apiUrl: t.apiUrl || undefined, modelsUrl: t.modelsUrl || undefined,
    trustedKeys: pins, appVersion: o.appVersion,
    files: new DirFiles(o.dir), kv: new FileKV(o.dir),
    leaseStore: new NodeLeaseStore(o.dir, { key: o.key, appId: o.appId, ...(t.machineId ? { read: () => ({ id: t.machineId, byCommand: false }) } : {}) }),
    loadEngine: (config) => loadNodeEngine({ dir: o.dir, config, pinned: pins, base: t.engineBase || ENGINE_BASE, builtIn: t.builtIn || BUILTIN_ENGINE }),
  });
  serve(d.port, ctl, { onClose: () => setTimeout(() => { d.port.close(); parentPort.close(); }, 0) });
  // the Core's background timer (18.6.3 checks, the journal of the units fed, the day's audio): never on a take's path
  const timer = setInterval(() => { if (ctl.core && !ctl.take) { try { ctl.tick(); } catch (_) { /* next time */ } } }, 10_000);
  timer.unref();
});
