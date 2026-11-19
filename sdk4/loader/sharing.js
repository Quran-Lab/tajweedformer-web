// Recitation sharing in SDK 4.0 for the web: the 3.x consent sheet and its whole state machine (SPEC 11, contract
// 1.15 to 1.22: at most three asks, a yes never asked again, the SDK decides when, the sheet's copy from the
// server, deletion, the recorded consent version), its recorder, outbox and uploads, unchanged (web/consent,
// web/sharing). It runs in the HOST PAGE, as in 3.x: the learner sees the sheet on the site, the recordings are made
// from the take's audio the page already has, and the upload path is 3.x's (the site's origin, a 3.x app token, the
// presigned upload URLs). The frame and its Worker hold nothing of it.
//
// What differs from 3.x is only the link object the controller is given (SharingLink): the 3.x platform client
// without register and without telemetry of its own. The sheet's counters (share_asked, share_yes, share_no) go to
// the engine Worker, which keeps the page's one daily delta.
//
// This module is the loader's sharing chunk (dist/hosted/4/app/<id>/sharing.mjs): the loader fetches it, checks
// its SHA-384 against the value compiled into the loader, and imports it from those bytes. The Opus encoder's
// WebAssembly is checked here the same way before it is instantiated.
import { QuranLab } from '../../web/platform/client.js';
import { localState } from '../../web/platform/storage.js';
import { enableSharing } from '../../web/consent/index.js';
import { QuranLabConsent, QuranLabSharingSettings } from '../../web/consent/element.js';
import { hostOpus } from '../../web/sharing/encoder.js';
import { outbox } from '../../web/sharing/index.js';
import createOpus from '../../dist/tajweedformer-opus.mjs';
import { TajweedError, toTajweedError } from '../../web/api/errors.js';
import { sha256Hex } from '../shared/bytes.js';

/* global __QL_OPUS_SHA256__ */
const OPUS_SHA256 = typeof __QL_OPUS_SHA256__ !== 'undefined' ? __QL_OPUS_SHA256__ : null;

/** The 3.x platform client as the sharing controller's link: no register, no telemetry of its own. */
export class SharingLink extends QuranLab {
  /**
   * @param {object} o  { key, rpc (the loader's port to the engine Worker), appVersion, storage, apiUrl, fetch, state,
   *   clock, trustedKeys }
   */
  constructor(o) {
    super({ key: o.key, platform: 'web', appVersion: o.appVersion, apiUrl: o.apiUrl, fetch: o.fetch,
      clock: o.clock, trustedKeys: o.trustedKeys, autoSend: false, bundleId: o.bundleId, origin: o.origin,
      state: o.state || localState(o.storage ? `quranlab.${o.storage}.` : 'quranlab.') });
    const rpc = o.rpc;
    const device = this.telemetry.device;
    // the day's delta is the Worker's: only the sheet's counts cross, as calls
    this.telemetry = {
      enabled: false, device,
      count: (field, n = 1) => { if (rpc) rpc.call('telemetryCount', { field, n }).catch(() => {}); },
      due: () => [], clear() {}, launched() {}, seal: () => 0, dropReport() {}, deferReport() {},
    };
  }

  /** The signed config (Quran Lab's global incident switch over sharing, the sheet's copy): verified here, as in 3.x. */
  async launch() { try { await this.refreshConfig(); } catch (e) { this.lastError = e; } }

  /** A send point: the queued issues only (telemetry is the Worker's). */
  sendTelemetry(reason = 'manual', o = {}) { this._lastSend = this.clock(); return this.flush(o); }
}

/** The Opus module from the bytes at `wasmUrl`, refused unless their SHA-256 is the one compiled in. */
export function hostOpusFrom(wasmUrl, fetch = globalThis.fetch.bind(globalThis)) {
  hostOpus(async () => {
    const r = await fetch(wasmUrl, { credentials: 'omit', redirect: 'error' });
    if (r.status !== 200) throw new Error(`the Opus encoder answered ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (OPUS_SHA256 && (await sha256Hex(bytes)) !== OPUS_SHA256) throw new Error('the Opus encoder is not the published bytes');
    return createOpus({ instantiateWasm(imports, done) { WebAssembly.instantiate(bytes, imports).then((x) => done(x.instance, x.module)); return {} } });
  });
}

/** Start sharing for a Client: { link, ctl, sharing (the API object of NAMING section 6), queueBytes() }. */
export async function startSharing(o) {
  const link = new SharingLink(o);
  if (o.opusUrl) hostOpusFrom(o.opusUrl, o.fetch);
  if (o.seams) link.sharingSeams = o.seams;
  if (o.sharingStorage) link.sharingStorage = o.sharingStorage;
  await link.launch();
  const ctl = enableSharing(link, o.sharingOptions || {});
  return { link, ctl, sharing: makeSharing(link, ctl), queueBytes: () => queueBytes(link) };
}

// client.sharing: the names of the four SDKs in front of the controller (as web/api/client.js in 3.x)
export function makeSharing(ql, ctl) {
  const need = () => { if (!ql.sharingAllowed()) throw new TajweedError('sharing_unavailable'); };
  return Object.freeze({
    get isAvailable() { return ql.sharingAllowed(); },
    get isOn() { return ctl.state.s.consent === 'granted'; },
    setOn(on) { if (on) need(); return Promise.resolve(ctl.setSharing(!!on)).then(() => {}); },
    async ask() { need(); return ctl.askNow(); },
    feed(samples, sampleRate) { if (typeof ctl.feed === 'function') ctl.feed(samples, sampleRate); },
    async items() { return ctl.outbox ? ctl.outbox.items() : []; },
    summary() { return ql.contributionSummary(); },
    delete() { return ctl.deleteShared(); },
    get recoveryCode() { return ctl.recoveryCode(); },
    setWording(overrides) { try { return ctl.setWording(overrides); } catch (e) { throw toTajweedError(e, { fallback: 'invalid_argument' }); } },
  });
}

async function queueBytes(ql) {
  let n = 0;
  try {
    const s = ql.sharingStorage || ((await outbox.sharing()) || {}).storage;
    if (s) for (const id of await s.sessions()) for (const name of await s.list(id)) { const b = await s.read(id, name); n += b ? b.length : 0; }
  } catch (_) { /* no queue */ }
  return n;
}

export { QuranLabConsent, QuranLabSharingSettings };
