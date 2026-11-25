// The engine Worker's side of the loader's port: one call at a time, in order (the Core is single-threaded and a
// take's audio must reach it in order), each answered with plain data. Errors cross as { code, message, reason, cause }
// with the code of the SDK's catalogue (web/api/errors-catalogue.js); the loader makes the TajweedError. `cause` (4.0.2,
// ERRORS_40.md 24.13) is made here, where the failure is reported, from the same reading as its report.
import { transferables, OPS } from '../shared/protocol.js';
import { toTajweedError } from '../../web/api/errors.js';
import { classify, publicCause } from '../../web/platform/error-reports.js';
import { SdkError } from './controller.js';
import { ReportError } from '../shared/recited.js';

export function errorOf(e) {
  if (e instanceof SdkError) return { code: e.code, message: e.message, reason: e.reason || null };
  if (e instanceof ReportError) return { code: 'invalid_argument', message: e.message, reason: null };
  const t = toTajweedError(e, { fallback: 'engine_failed', sdk: '4.0.3' });
  return { code: t.code, message: (e && e.message) || t.message, reason: (e && e.reason) || null };
}

/** Serve `ctl` (a Controller) on `port`; `post` sends one-way events (progress, the endpoint state). */
export function serve(port, ctl, { onClose = null } = {}) {
  let q = Promise.resolve();
  const ev = (d) => port.postMessage(d);
  // the controller's own events (its api and models P moved: the page's other endpoint set is told)
  ctl.emit = ev;
  const handlers = {
    init: (a) => ctl.init(a),
    model: (a) => ctl.openModel(a),
    prefetch: (a) => ctl.prefetch(a, (p) => ev({ ev: 'progress', id: a.progressId, ...p })),
    storage: () => ctl.storage(),
    removeModels: () => ctl.removeModels(),
    diagnose: () => ctl.diagnose(),
    warm: (a) => ctl.warm(a),
    start: (a) => ctl.start(a),
    push: (a) => ctl.push(a.samples),
    finish: () => ctl.finish(),
    cancel: () => ctl.cancel(),
    reportRecited: (a) => ctl.reportRecited(a),
    reportChecks: (a) => ctl.reportChecks(a),
    telemetryCount: (a) => ctl.telemetryCount(a),
    takeReport: (a) => ctl.takeReport(a),
    clip: (a) => ctl.clipSamples(a.name),
    reference: (a) => ctl.reference(a),
    background: (a) => ctl.background(a),
    foreground: () => ctl.foreground(),
    closeModel: () => { ctl.closeModel(); return {}; },
    close: async () => { const r = await ctl.close(); if (onClose) onClose(); return r; },
  };
  port.onmessage = (e) => {
    const { id, op, args } = e.data || {};
    if (!OPS.includes(op)) { port.postMessage({ id, ok: false, error: { code: 'invalid_argument', message: `unknown call ${op}` } }); return; }
    // the page's endpoint state: taken at once, never behind a call in flight (a model open can take a while)
    if (op === 'endpoints') { let ok = false; try { ok = ctl.adoptEndpoints(args || {}); } catch (_) { ok = false; } port.postMessage({ id, ok: true, value: { adopted: !!ok } }); return; }
    q = q.then(async () => {
      try {
        const value = await handlers[op](args || {});
        port.postMessage({ id, ok: true, value }, transferables(value));
      } catch (err) {
        const out = errorOf(err);
        // ERRORS_40.md section 24: the code the app gets, and where it came from (never in the way of the answer)
        try { if (typeof ctl.reportFailure === 'function') ctl.reportFailure(err, out.code); } catch (_) { /* never in the way */ }
        // 24.13: the same cause on the app's error; `needs` from what the call needs on the device
        try {
          const needs = out.code === 'needs_connection' && typeof ctl.needsOf === 'function' ? await ctl.needsOf(err, op, args || {}) : null;
          const cause = publicCause(classify(err), out.code, needs);
          if (cause) out.cause = { ...cause };
        } catch (_) { /* never in the way */ }
        port.postMessage({ id, ok: false, error: out });
      }
    });
  };
  if (typeof port.start === 'function') port.start();
}
