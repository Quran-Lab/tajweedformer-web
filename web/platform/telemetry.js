// Telemetry v2 (PLATFORM_CLIENT.md section 6): on by default, anonymous by construction. Only sums
// and histograms per UTC day: no audio, no text or phonemes, no identifiers, no time finer than the
// day. Since 2.0.1 it goes as deltas during the day: what was counted since the last send point is
// sealed into a report with a fresh random report_id (kept in storage before it is sent, so a retry sends
// the same bytes and the server counts it once), one report per UTC day it covers, at most 7 days kept.
// The send points (every 15 minutes while the app is in use, when it goes to the background, at launch)
// are the platform client's (client.js).
// Tried and rejected: sending the whole day again with a day-scoped id (the server would have to diff
// days); one report spanning midnight (a delta belongs to one day, as the server's points do).

const B = {
  latency_ms: [['le_5', 5], ['le_10', 10], ['le_20', 20], ['le_40', 40], ['le_80', 80], ['le_160', 160], ['le_320', 320], ['gt_320', Infinity]],
  rtf: [['le_0_1', 0.1], ['le_0_25', 0.25], ['le_0_5', 0.5], ['le_1', 1], ['gt_1', Infinity]],
  ms: [['le_250', 250], ['le_500', 500], ['le_1000', 1000], ['le_2000', 2000], ['le_4000', 4000], ['gt_4000', Infinity]],
  pct: [['le_1', 1], ['le_2', 2], ['le_5', 5], ['le_10', 10], ['le_20', 20], ['gt_20', Infinity]],
  margin: [['le_0_5', 0.5], ['le_1', 1], ['le_2', 2], ['le_4', 4], ['le_8', 8], ['gt_8', Infinity]],
  confidence: [['le_0_5', 0.5], ['le_0_7', 0.7], ['le_0_8', 0.8], ['le_0_9', 0.9], ['le_0_95', 0.95], ['gt_0_95', Infinity]],
  word: [['le_3', 3], ['le_4', 4], ['le_5', 5], ['le_6', 6], ['le_7', 7], ['gt_7', Infinity]],
};
/** The bucket a value falls in ("le_x" is <= x). */
export function bucket(kind, v) { for (const [k, hi] of B[kind]) if (v <= hi) return k; return B[kind][B[kind].length - 1][0]; }
const bump = (h, kind, v, n = 1) => { const k = bucket(kind, v); h[k] = (h[k] || 0) + n; };

/** UTC day "YYYY-MM-DD". */
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const FALLBACKS = ['non_finite', 'deadline', 'ane_unavailable', 'npu_unavailable', 'model_load', 'thermal', 'memory', 'other'];
const CAP = 10_000_000;
const DAY_MS = 86_400_000;
/** The fields an app can report (SPEC 6.3), in the order of the wire body's `reported` list. */
export const REPORTED = Object.freeze(['ayahs', 'surah_ayahs', 'coverage', 'words', 'rule_checks', 'rule_flags']);
/** The counters at the top level of a report (each left out when zero); ayahs and words are app-reported in 3.0. */
export const COUNTERS = Object.freeze(['launches', 'ayahs', 'words', 'share_asked', 'share_yes', 'share_no']);
/** At most this many rule keys per report (the server's limit). */
export const MAX_RULE_KEYS = 32;
const RULE_KEY = /^[a-z][a-z0-9_]{0,23}$/;
/** A fresh report id: 16 random bytes, 32 lower-case hex. */
export function newReportId() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
/**
 * The day's counters, persisted in `state` under "telemetry.days" ({ day: payload-in-progress }).
 * `device` is { class, soc?, os_major, ram_tier? }, `product` the platform's (productOf), `platform` the token app's.
 */
// The telemetry product of a platform, as the server checks it (PRODUCT_OF): a desktop app running this SDK in Node
// reports as the native product of its platform, a page as web.
export const PRODUCT_OF = Object.freeze({ web: 'web', windows: 'native', linux: 'native', macos: 'apple', ios: 'apple', android: 'android' });
export const productOf = (platform) => PRODUCT_OF[platform] || 'web';

export class Telemetry {
  constructor({ state, platform = 'web', product = productOf(platform), sdkVersion = '3.0.2', appVersion = '0', device, clock = Date.now, enabled = true }) {
    Object.assign(this, { state, product, platform, sdkVersion, appVersion, device, clock });
    this.enabled = enabled;
    this.coldStartDone = false;
  }

  _days() { return this.state.get('telemetry.days') || {}; }
  _save(d) { this.state.set('telemetry.days', d); }
  _today() {
    const days = this._days();
    const day = utcDay(this.clock());
    if (!days[day]) {
      days[day] = { v: 2, day, product: this.product, platform: this.platform, sdk_version: this.sdkVersion, app_version: this.appVersion,
        device: this.device, cohorts: [], coverage: {}, downloads: [] };
    }
    return { days, d: days[day] };
  }
  _edit(fn) {
    if (!this.enabled) return;
    const { days, d } = this._today();
    fn(d);
    // keep at most 7 days
    const keys = Object.keys(days).sort();
    while (keys.length > 7) delete days[keys.shift()];
    this._save(days);
  }

  // one cohort per model version, build, context and backend
  _cohort(d, key) {
    let c = d.cohorts.find((x) => ['revision', 'build', 'context', 'backend'].every((k) => x[k] === key[k]));
    if (!c) {
      c = { revision: key.revision, build: key.build, context: key.context, backend: key.backend, sessions: 0, minutes: 0, chunks: 0, aborted: 0,
        fallbacks: {}, self_test: { pass: 0, fail: 0 }, latency_ms: {}, rtf: {}, cold_start_ms: {}, model_load_ms: {},
        thermal: { transitions: 0, throttled_sessions: 0 }, margin: {}, confidence: {},
        // the 6.2 counters, kept as whole numbers until the wire body (audio, speech and silence in ms, compute in microseconds)
        takes: 0, audio_ms: 0, speech_ms: 0, silence_ms: 0, tokens: {}, compute_us: 0 };
      d.cohorts.push(c);
    }
    return c;
  }

  /** A model was opened: `cohort` is { revision (the model version), build, context, backend }. */
  modelLoaded(cohort, ms) { this._edit((d) => bump(this._cohort(d, cohort).model_load_ms, 'ms', ms)); }

  /**
   * A take ended (SPEC 6.1 and 6.2), everything measured by the SDK from inference: the input samples and
   * their rate, the compute time of each chunk (whole microseconds) and the chunk length, whether the take was
   * cancelled or failed (`aborted`), the first audio's delay when it was the launch's first take, margin and
   * confidence per emitted token, greedy tokens per selected CTC head, speech and silence frames (40 ms each).
   * `sessions` counts every take, `aborted` those cancelled or failed; only a take that ended with its Heads
   * adds to `takes`, `audio_s`, `speech_s`, `silence_s`, `tokens` and `compute_s`.
   */
  take(cohort, { samples = 0, sampleRate = 16000, chunkUs = [], chunkLenMs = 320, aborted = false, firstMs = null, margins = [], confidences = [],
    tokens = {}, speechFrames = 0, silenceFrames = 0 }) {
    this._edit((d) => {
      const c = this._cohort(d, cohort);
      c.sessions++;
      if (aborted) c.aborted++;
      c.minutes = Math.round((c.minutes + samples / sampleRate / 60) * 1000) / 1000;
      c.chunks = Math.min(CAP, c.chunks + chunkUs.length);
      for (const us of chunkUs) { bump(c.latency_ms, 'latency_ms', us / 1000); bump(c.rtf, 'rtf', us / 1000 / chunkLenMs); }
      if (!this.coldStartDone && firstMs !== null) { bump(c.cold_start_ms, 'ms', firstMs); this.coldStartDone = true; }
      for (const m of margins) bump(c.margin, 'margin', m);
      for (const x of confidences) bump(c.confidence, 'confidence', x);
      if (aborted) return;
      c.takes++;
      c.audio_ms += Math.floor((1000 * samples) / sampleRate);
      c.speech_ms += 40 * speechFrames;
      c.silence_ms += 40 * silenceFrames;
      for (const us of chunkUs) c.compute_us += us;
      for (const [head, n] of Object.entries(tokens)) if (n > 0) c.tokens[head] = Math.min(CAP, (c.tokens[head] || 0) + n);
    });
  }

  /** App-reported (SPEC 6.3): the learner recited `ayahs` ayahs of `surah` (negative to take a replaced report back). */
  recited(surah, ayahs) {
    this._edit((d) => {
      const k = String(surah);
      d.ayahs = Math.max(0, Math.min(CAP, (d.ayahs || 0) + ayahs));
      for (const f of ['surah_ayahs', 'coverage']) {
        d[f] = d[f] || {};
        d[f][k] = Math.max(0, (d[f][k] || 0) + ayahs);
        if (!d[f][k]) delete d[f][k];
      }
    });
  }

  /**
   * App-reported (SPEC 6.3): the app's own judge checked `rule` `checked` times and flagged `flagged` of them.
   * The caller validated the input. At most 32 distinct rules a day: a later one is dropped (false).
   */
  checks(rule, checked, flagged) {
    if (!checked) return true; // valid, counts nothing, takes no place among the day's rules
    let kept = this.enabled;
    this._edit((d) => {
      d.rule_checks = d.rule_checks || {};
      d.rule_flags = d.rule_flags || {};
      // 32 distinct rules a UTC day, over all of the day's deltas: the names seen today are kept beside the counts
      const day = utcDay(this.clock());
      let seen = this.state.get('telemetry.rules');
      if (!seen || seen.day !== day) seen = { day, names: [] };
      if (!seen.names.includes(rule)) {
        if (seen.names.length >= MAX_RULE_KEYS) { kept = false; return; }
        seen.names.push(rule);
        this.state.set('telemetry.rules', seen);
      }
      d.rule_checks[rule] = Math.min(CAP, (d.rule_checks[rule] || 0) + checked);
      if (flagged) d.rule_flags[rule] = Math.min(d.rule_checks[rule], (d.rule_flags[rule] || 0) + flagged);
      if (rule === 'word') d.words = Math.min(CAP, (d.words || 0) + checked);
    });
    return kept;
  }

  fallback(cohort, reason) {
    const k = FALLBACKS.includes(reason) ? reason : 'other';
    this._edit((d) => { const c = this._cohort(d, cohort); c.fallbacks[k] = (c.fallbacks[k] || 0) + 1; });
  }

  /** A model download: `revision` is the model version, `build` the build id (40 hex) when known. */
  download({ revision, build = null, profile, bytes, success, resumed }) {
    this._edit((d) => {
      let x = d.downloads.find((y) => y.revision === revision && (y.build || null) === build && y.profile === profile);
      if (!x) { x = { revision, ...(build ? { build } : {}), profile, bytes: 0, success: 0, failed: 0, resumed: 0 }; d.downloads.push(x); }
      x.bytes += bytes; if (success) x.success++; else x.failed++; if (resumed) x.resumed++;
    });
  }

  /** +n on a top-level counter (launches, share_asked, share_yes, share_no). */
  count(field, n = 1) {
    if (!COUNTERS.includes(field)) throw new RangeError(`telemetry counter ${field}`);
    this._edit((d) => { d[field] = Math.min(CAP, (d[field] || 0) + n); });
  }

  /**
   * A send point: what was counted since the last one is sealed, one report per UTC day it covers, each with a
   * fresh report_id and its exact body, stored before anything is sent. Reports older than 7 days are deleted.
   * Returns the number of reports sealed.
   */
  seal() {
    const days = this._days();
    const sealed = this._sealed();
    let n = 0;
    for (const day of Object.keys(days).sort()) {
      const body = Telemetry.wire(days[day]);
      delete days[day];
      if (!Telemetry.hasContent(body)) continue;
      const reportId = newReportId();
      sealed.push({ report_id: reportId, day, body: JSON.stringify({ ...body, report_id: reportId }), attempts: 0, next: 0 });
      n++;
    }
    this._putSealed(this._fresh(sealed));
    this._save(days);
    return n;
  }

  _sealed() { return this.state.get('telemetry.sealed') || []; }
  _putSealed(s) { this.state.set('telemetry.sealed', s.length ? s : null); }
  _fresh(s) {
    const oldest = utcDay(this.clock() - 7 * DAY_MS);
    return s.filter((r) => r.day >= oldest).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  /** Sealed reports not yet accepted, oldest first: { report_id, day, body (the exact JSON sent), attempts, next }. */
  reports() { return this._fresh(this._sealed()); }
  /** The sealed reports as payloads (what is sent), oldest first. */
  pending() { return this.reports().map((r) => JSON.parse(r.body)); }
  /** A report was accepted (202) or refused for good (400, 413): deleted. */
  dropReport(id) { this._putSealed(this._sealed().filter((r) => r.report_id !== id)); }
  /** A report to retry later with the same bytes: 1 min, then 10 min, then the next launch. */
  deferReport(id) {
    const s = this._sealed();
    const r = s.find((x) => x.report_id === id);
    if (!r) return;
    r.attempts += 1;
    r.next = r.attempts === 1 ? this.clock() + 60_000 : r.attempts === 2 ? this.clock() + 600_000 : -1; // -1: the next launch
    this._putSealed(s);
  }
  /** At launch: reports waiting for the next launch are due again. */
  launched() {
    const s = this._sealed();
    for (const r of s) if (r.next === -1) r.next = 0;
    this._putSealed(s);
  }
  /** Reports due now. */
  due() { const now = this.clock(); return this.reports().filter((r) => r.next !== -1 && r.next <= now); }

  /** Drop a day's open counts (kept for 2.0.0 callers). */
  drop(day) { const d = this._days(); delete d[day]; this._save(d); }
  /** Drop everything, open counts and sealed reports (flags.analytics false). */
  clear() { this.state.set('telemetry.days', null); this.state.set('telemetry.sealed', null); this.state.set('telemetry.rules', null); }

  /** Whether a report body carries anything (a delta with no count is not sent). */
  static hasContent(b) {
    return b.cohorts.length > 0 || !!b.coverage || !!b.downloads || COUNTERS.some((k) => b[k] > 0) || !!b.surah_ayahs || !!b.rule_checks;
  }

  /** The closed v2 body: empty optional parts removed, cohorts beyond 16 merged into the largest. */
  static wire(p) {
    // the 6.2 fields of a cohort are left out when zero
    const lean = (c) => {
      const { takes, audio_ms: audio, speech_ms: speech, silence_ms: silence, compute_us: compute, tokens, ...o } = c;
      if (takes > 0) o.takes = takes;
      if (audio > 0) o.audio_s = audio / 1000;
      if (speech > 0) o.speech_s = speech / 1000;
      if (silence > 0) o.silence_s = silence / 1000;
      if (tokens && Object.keys(tokens).length) o.tokens = tokens;
      // compute seconds to the millisecond, rounded half up from the microseconds
      const ms = Math.floor(((compute || 0) + 500) / 1000);
      if (ms > 0) o.compute_s = ms / 1000;
      return o;
    };
    let cohorts = p.cohorts.slice().sort((a, b) => b.sessions - a.sessions);
    if (cohorts.length > 16) {
      const keep = cohorts.slice(0, 16), rest = cohorts.slice(16);
      for (const r of rest) { keep[0].sessions += r.sessions; keep[0].minutes += r.minutes; keep[0].chunks += r.chunks; keep[0].aborted += r.aborted; }
      cohorts = keep;
    }
    const out = { v: 2, day: p.day, product: p.product, platform: p.platform, sdk_version: p.sdk_version, app_version: p.app_version,
      device: p.device, cohorts: cohorts.map(lean) };
    if (Object.keys(p.coverage || {}).length) out.coverage = p.coverage;
    if ((p.downloads || []).length) out.downloads = p.downloads;
    // the top-level counters, each left out when zero or empty
    for (const k of COUNTERS) if (p[k] > 0) out[k] = p[k];
    if (p.surah_ayahs && Object.keys(p.surah_ayahs).length) out.surah_ayahs = p.surah_ayahs;
    if (p.rule_checks && Object.keys(p.rule_checks).length) {
      out.rule_checks = p.rule_checks;
      const flags = Object.fromEntries(Object.entries(p.rule_flags || {}).filter(([k, v]) => v > 0 && k in p.rule_checks));
      if (Object.keys(flags).length) out.rule_flags = flags;
    }
    // which of the fields present the app reported (SPEC 6.3), so the portal labels them without guessing
    const reported = REPORTED.filter((k) => out[k] !== undefined);
    if (reported.length) out.reported = reported;
    return out;
  }
}

/** The device fields the spec allows, from what a browser or Node can tell without an identifier. */
export function deviceInfo() {
  const nav = globalThis.navigator;
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node && !globalThis.window;
  const ramGb = nav && typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const tier = (g) => (g === null ? undefined : g < 2 ? 'lt2' : g < 4 ? '2_4' : g < 8 ? '4_8' : g < 16 ? '8_16' : 'ge16');
  if (isNode) {
    const major = Number(process.versions.node.split('.')[0]) || 1;
    return { class: 'node', soc: 'wasm', os_major: Math.max(1, Math.min(99, major)) };
  }
  const ua = (nav && nav.userAgent) || '';
  const m = /(?:Chrome|Firefox|Version)\/(\d+)/.exec(ua);
  const d = { class: 'browser', soc: 'wasm', os_major: Math.max(1, Math.min(99, Math.floor((m ? Number(m[1]) : 10) / 10))) };
  if (ramGb !== null) d.ram_tier = tier(ramGb);
  return d;
}
