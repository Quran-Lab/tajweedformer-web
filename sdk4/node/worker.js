// The Node path's engine thread (a worker_threads Worker of sdk4/node/index.js): the same Controller as the web frame's
// engine Worker (sdk4/frame/controller.js), served over the same port protocol (serve.js), as a desktop app: the
// desktop key's app id and platform, no site, no Turnstile, the folder's stores (files.js), its install keys and lease
// (store.js) and the signed engine (engine.js). Takes run here, so they never hold up the app's event loop.
import { parentPort } from 'node:worker_threads';
import { Controller } from '../frame/controller.js';
import { serve } from '../frame/serve.js';
import { DirFiles, FileKV } from './files.js';
import { NodeLeaseStore } from './store.js';
import { loadNodeEngine, BUILTIN_ENGINE } from './engine.js';
import { Endpoints } from '../shared/endpoints.js';
import { QURANLAB_PUBLIC_KEY_HEX } from '../../web/tajweed/manifest.js';

/** The close's last send (the day's totals and the reports queued): at most this long. What is not sent by then stays
 * queued in the folder and goes at the next run, as the native SDKs keep it; an app's exit never waits for the api
 * order (28.3: 10 s for each silent host, about 20 s for the totals and an issue with the first host silent). */
const CLOSE_SEND_MS = 2_000;

/** The refusal a start ended on (15.3: a stop or a refusal of the key at this start, or a stop kept from an earlier
 * run), as the error the Client's call gets; null when there is none. */
function startRefusal(ql) {
  if (!ql) return null;
  if (ql.stopped) return ql.stoppedError || { code: ql.stopped, message: 'Quran Lab does not accept this key.' };
  return ql.modelRefusal || null;
}

parentPort.once('message', (d) => {
  if (!d || d.ql !== 'start' || !d.port || !d.options) return;
  const o = d.options;
  // the test seams (index.js passes them only with QL_NODE_TEST=1): a local API, the contract's test key, a machine id
  const t = o.test || {};
  const pins = Array.isArray(t.pins) && t.pins.length ? t.pins : [QURANLAB_PUBLIC_KEY_HEX];
  // one endpoint set for the process (28.6): the api and models orders of the Controller, and the web_frame order the
  // engine files come from; a test's seams replace a role's hosts
  const endpoints = Endpoints.fromSeams({ apiUrl: t.apiUrl || null, modelsUrl: t.modelsUrl || null, frameBases: t.engineBase ? [new URL(t.engineBase).origin] : null });
  const ctl = new Controller({
    key: o.key, desktop: { platform: o.platform, appId: o.appId }, apiUrl: t.apiUrl || undefined, modelsUrl: t.modelsUrl || undefined,
    trustedKeys: pins, appVersion: o.appVersion, appBuild: o.appBuild, endpoints,
    files: new DirFiles(o.dir), kv: new FileKV(o.dir),
    leaseStore: new NodeLeaseStore(o.dir, { key: o.key, appId: o.appId, ...(t.machineId ? { read: () => ({ id: t.machineId, byCommand: false }) } : {}) }),
    // a key Quran Lab refused or stopped gets no engine: nothing is fetched for it (before, the engine came first: 20 s
    // more when the first two web_frame hosts were silent). The start ends with that refusal, which index.js keeps:
    // create() resolves as in 4.0.0 and the Client's model() and prefetch() reject with it at once
    loadEngine: (config) => {
      const refusal = startRefusal(ctl.ql);
      if (refusal) return Promise.reject(ctl._stopError(refusal));
      return loadNodeEngine({ dir: o.dir, config, pinned: pins, endpoints, base: t.engineBase || null, builtIn: t.builtIn || BUILTIN_ENGINE });
    },
  });
  // a start that ended on a refusal has no engine and no Core: what the Client still asks of this thread (diagnose,
  // storage, removeModels, close) is answered without them
  const diagnose = ctl.diagnose.bind(ctl);
  ctl.diagnose = () => {
    if (ctl.core) return diagnose();
    const ql = ctl.ql;
    return { key: { accepted: ql && ql.stopped ? false : ql && ql.keyAccepted ? true : null, stopped: (ql && ql.stopped) || null },
      config: ql && ql.config ? 'fresh' : 'none', model: null, context: null, lease: { valid: false, refreshDue: false, kept: ctl.kept || 'off' },
      engine: null, storage: ctl.o.files.kind, endpoints: ctl.ep.diagnose(ctl.ep.roles.web_frame.p) };
  };
  // the close's last send is bounded (CLOSE_SEND_MS); the Controller's close goes on with the folder's state, which
  // keeps whatever was not sent, and index.js ends this thread after it
  const close = ctl.close.bind(ctl);
  ctl.close = async () => {
    const ql = ctl.ql;
    if (ql && typeof ql.sendTelemetry === 'function') {
      const send = ql.sendTelemetry.bind(ql);
      ql.sendTelemetry = (reason, opts) => {
        const p = send(reason, opts);
        if (reason !== 'close') return p;
        p.catch(() => {});
        return Promise.race([p, new Promise((r) => setTimeout(() => r(false), CLOSE_SEND_MS))]);
      };
    }
    if (ctl.core) return close();
    // no Core (the start ended on a refusal): the send point and the folder's state only
    if (ql) {
      try { ql.telemetry.closeSession(); } catch (_) { /* none open */ }
      try { await ql.sendTelemetry('close', { keepalive: true }); } catch (_) { /* kept */ }
      try { ql.stopSchedule(); ql.stopRefresh(); } catch (_) { /* stopped */ }
    }
    if (ctl.state) await ctl.state.flush().catch(() => {});
    return {};
  };
  serve(d.port, ctl, { onClose: () => setTimeout(() => { d.port.close(); parentPort.close(); }, 0) });
  // the Core's background timer (18.6.3 checks, the journal of the units fed, the day's audio): never on a take's path
  const timer = setInterval(() => { if (ctl.core && !ctl.take) { try { ctl.tick(); } catch (_) { /* next time */ } } }, 10_000);
  timer.unref();
});
