// The engine Worker (a dedicated module Worker of the frame, on Quran Lab's origin). It holds the page session's
// install keys, the platform client, the engine and the Core with its lease, and the model's ciphertext in the
// origin private file system. The frame starts it after the handshake and hands it the loader's port.
import { Controller, frameAppOf } from './controller.js';
import { serve } from './serve.js';
import { openFiles, openKV } from './stores.js';
import { loadEngine } from './engine-loader.js';
import { QURANLAB_PUBLIC_KEY_HEX } from '../../web/tajweed/manifest.js';

/* global __QL_PINS__, __QL_API__, __QL_ENGINE_BASE__, __QL_ENGINE_BUILTIN__, __QL_MODELS__ */
const PINS = typeof __QL_PINS__ !== 'undefined' ? __QL_PINS__ : [QURANLAB_PUBLIC_KEY_HEX];
const API_URL = typeof __QL_API__ !== 'undefined' ? __QL_API__ : 'https://api.quranlab.ai';
// the engine from the frame's own host (web.quranlab.ai, or the fallback host web2.quranlab.ai: the frame's
// connect-src is 'self' and Quran Lab's API and CDN, so an engine is only ever fetched from the host that served it)
const ENGINE_BASE = typeof __QL_ENGINE_BASE__ !== 'undefined' ? __QL_ENGINE_BASE__ : `${self.location.origin}/4/engine/`;
const ENGINE_BUILTIN = typeof __QL_ENGINE_BUILTIN__ !== 'undefined' ? __QL_ENGINE_BUILTIN__ : null;

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.ql !== 'start' || !d.port || !d.frame) return;
  self.onmessage = null;
  const frame = d.frame; // the frame's own port: Turnstile tokens, show and hide
  let tsSeq = 0;
  const tsWaiting = new Map();
  frame.onmessage = (m) => {
    const x = m.data || {};
    if (x.show !== undefined) return; // the frame is never shown for Turnstile (invisible, 18.4.9)
    const w = tsWaiting.get(x.id);
    if (w) { tsWaiting.delete(x.id); w(x.token === false ? false : x.token || null); }
  };
  const turnstile = (q) => new Promise((resolve) => {
    const id = ++tsSeq;
    tsWaiting.set(id, resolve);
    const sitekey = ctl.ql && ctl.ql.config && ctl.ql.config.web && typeof ctl.ql.config.web.turnstile_sitekey === 'string' ? ctl.ql.config.web.turnstile_sitekey : null;
    frame.postMessage({ id, turnstile: { ...q, sitekey } });
    // the frame gives up within its own bound (frame.js TS_WITHIN_MS); this one only covers a frame that never answers:
    // false, and the lease is asked without a token (18.4.9)
    setTimeout(() => { if (tsWaiting.delete(id)) resolve(false); }, 25_000);
  });
  // 4.0.1: the frame loads Turnstile's script ahead of the first token (a page with no kept lease, Controller.init)
  const turnstilePrepare = () => frame.postMessage({ prepare: true });
  const name = `quranlab-sdk4${d.storage ? '.' + d.storage : ''}`;
  const ctl = new Controller({
    key: d.key, site: d.site, apiUrl: API_URL, modelsUrl: typeof __QL_MODELS__ !== 'undefined' ? __QL_MODELS__ : undefined, trustedKeys: PINS, appVersion: d.appVersion, appBuild: d.appBuild,
    files: await openFiles(name), kv: await openKV(name), turnstile, turnstilePrepare,
    // R402-4 (c): the app this Worker was served from (/4/app/<id>/worker.js), on every report it makes
    frameApp: frameAppOf(self.location && self.location.pathname),
    loadEngine: (config) => loadEngine({ base: ENGINE_BASE, config, pinned: PINS, builtIn: ENGINE_BUILTIN, threads: d.threads === 'auto' ? 'auto' : 'off' }),
  });
  serve(d.port, ctl, { onClose: () => setTimeout(() => self.close(), 0) });
  // the Core's background timer (18.6.3 checks, the journal of fed units): never on a take's path
  setInterval(() => { if (ctl.core && !ctl.take) { try { ctl.tick(); } catch (_) { /* next time */ } } }, 10_000);
};
