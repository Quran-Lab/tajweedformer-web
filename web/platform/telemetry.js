// Telemetry v2 (PLATFORM_CLIENT.md section 6): on by default, anonymous by construction. Only sums
// and histograms per UTC day: no audio, no text or phonemes, no identifiers, no time finer than the
// day. One payload per completed day, at most 7 days kept, sent at the next launch.

import { CLASSES, CHECKS } from '../tajweed/settings.js';

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

/**
 * The day's counters, persisted in `state` under "telemetry.days" ({ day: payload-in-progress }).
 * `device` is { class, soc?, os_major, ram_tier? }, `product` 'web', `platform` the token app's.
 */
export class Telemetry {
  constructor({ state, product = 'web', platform = 'web', sdkVersion = '2.0.0', appVersion = '0', device, clock = Date.now, enabled = true }) {
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

  /** The cohort of a model's settings: revision, context, backend, preset (custom when any raw site
   * threshold is set), word level. */
  static cohortKey(tf) {
    const e = tf.settings.effective();
    const app = tf.settings.app || {};
    const ov = { ...((tf.settings.remote && tf.settings.remote.overrides) || {}), ...(app.overrides || {}) };
    const custom = Object.values(ov).some((o) => o && Object.prototype.hasOwnProperty.call(o, 'threshold'));
    const wl = tf.settings.wordLevel ? tf.settings.wordLevel() : null;
    let word = 'off', wordBucket = '';
    if (wl && wl.enabled) {
      if (wl.preset) word = wl.preset; else { word = 'custom'; wordBucket = bucket('word', wl.threshold); }
    }
    return {
      revision: String((tf.folder && tf.folder.manifest && (tf.folder.manifest.model_id + '+' + tf.folder.manifest.revision)) || 'unknown').slice(0, 64),
      context: tf.context, backend: 'cpu', preset: custom ? 'custom' : e.preset, word_level: word, word_bucket: wordBucket,
      site_overrides: Math.min(8, Object.keys(ov).filter((k) => CLASSES.includes(k)).length),
    };
  }

  _cohort(d, key) {
    let c = d.cohorts.find((x) => ['revision', 'context', 'backend', 'preset', 'word_level', 'word_bucket'].every((k) => x[k] === key[k]));
    if (!c) {
      c = { ...key, sessions: 0, minutes: 0, chunks: 0, aborted: 0, fallbacks: {}, self_test: { pass: 0, fail: 0 }, latency_ms: {}, rtf: {},
        cold_start_ms: {}, model_load_ms: {}, thermal: { transitions: 0, throttled_sessions: 0 }, checks_on: {}, classes: {},
        session_flag_pct: {}, margin: {}, confidence: {}, madd: { c2: 0, c4: 0, c6: 0, flagged: 0 }, words: { scored: 0, flagged: 0 } };
      d.cohorts.push(c);
    }
    c.site_overrides = key.site_overrides;
    return c;
  }

  modelLoaded(tf, ms) { this._edit((d) => bump(this._cohort(d, Telemetry.cohortKey(tf)).model_load_ms, 'ms', ms)); }

  /** A take ended: audio seconds, chunk timings (ms each), whether it was the launch's first. */
  session(tf, { seconds, chunkMs = [], aborted = false, firstMs = null }) {
    const chunk = tf.info.chunkMs || 320;
    this._edit((d) => {
      const c = this._cohort(d, Telemetry.cohortKey(tf));
      if (aborted) c.aborted++; else c.sessions++;
      c.minutes = Math.round((c.minutes + seconds / 60) * 1000) / 1000;
      c.chunks = Math.min(CAP, c.chunks + chunkMs.length);
      for (const ms of chunkMs) { bump(c.latency_ms, 'latency_ms', ms); bump(c.rtf, 'rtf', ms / chunk); }
      if (!this.coldStartDone && firstMs !== null) { bump(c.cold_start_ms, 'ms', firstMs); this.coldStartDone = true; }
      const eff = tf.settings.effective();
      const on = { letters: false, vowels: false, length: false, madd: eff.madd.enabled, gemination: eff.gemination.enabled,
        qalqalah: eff.qalqalah.enabled, lazim: eff.lazim.enabled };
      for (const [cls, s] of Object.entries(eff.sites)) {
        const k = { vowel_sub: 'vowels', vowel_del: 'vowels', vowel_ins: 'vowels', short_to_long: 'length', long_to_short: 'length' }[cls] || 'letters';
        if (s.enabled) on[k] = true;
      }
      for (const k of CHECKS) if (on[k]) c.checks_on[k] = (c.checks_on[k] || 0) + 1;
    });
  }

  /** The decoded layer of a take: margin and confidence per emitted token. */
  decoded(tf, decoded) {
    this._edit((d) => {
      const c = this._cohort(d, Telemetry.cohortKey(tf));
      for (const t of decoded.tokens) {
        bump(c.margin, 'margin', t.margin);
        if (t.confidence !== null) bump(c.confidence, 'confidence', t.confidence);
      }
    });
  }

  /** A scored ayah: per class sites and flags, the session's flag %, madd counts, words, coverage. */
  scored(tf, r) {
    this._edit((d) => {
      const c = this._cohort(d, Telemetry.cohortKey(tf));
      for (const s of r.sites) {
        const k = (c.classes[s.class] = c.classes[s.class] || { sites: 0, flagged: 0 });
        k.sites++;
        if (s.flagged) k.flagged++;
      }
      const n = r.summary.sites || 0;
      bump(c.session_flag_pct, 'pct', n ? (100 * r.summary.flagged) / n : 0);
      for (const m of r.madd) {
        if (m.count === 2) c.madd.c2++; else if (m.count === 4) c.madd.c4++; else if (m.count === 6) c.madd.c6++;
        if (m.flagged) c.madd.flagged++;
      }
      c.words.scored += r.words.filter((w) => w.score !== null).length;
      c.words.flagged += r.words.filter((w) => w.flagged).length;
      d.coverage[String(r.surah)] = (d.coverage[String(r.surah)] || 0) + 1;
    });
  }

  fallback(tf, reason) {
    const k = FALLBACKS.includes(reason) ? reason : 'other';
    this._edit((d) => { const c = this._cohort(d, Telemetry.cohortKey(tf)); c.fallbacks[k] = (c.fallbacks[k] || 0) + 1; });
  }

  download({ revision, profile, bytes, success, resumed }) {
    this._edit((d) => {
      let x = d.downloads.find((y) => y.revision === revision && y.profile === profile);
      if (!x) { x = { revision, profile, bytes: 0, success: 0, failed: 0, resumed: 0 }; d.downloads.push(x); }
      x.bytes += bytes; if (success) x.success++; else x.failed++; if (resumed) x.resumed++;
    });
  }

  /** Completed days (before today), oldest first, as wire payloads (16 cohorts at most). */
  pending() {
    const today = utcDay(this.clock());
    return Object.entries(this._days()).filter(([day]) => day < today).sort().map(([, p]) => Telemetry.wire(p));
  }

  /** Drop a day (sent, or refused with 400). */
  drop(day) { const d = this._days(); delete d[day]; this._save(d); }
  /** Drop everything (flags.analytics false). */
  clear() { this.state.set('telemetry.days', null); }

  /** The closed v2 body: empty optional parts removed, cohorts beyond 16 merged into the largest. */
  static wire(p) {
    let cohorts = p.cohorts.slice().sort((a, b) => b.sessions - a.sessions);
    if (cohorts.length > 16) {
      const keep = cohorts.slice(0, 16), rest = cohorts.slice(16);
      for (const r of rest) { keep[0].sessions += r.sessions; keep[0].minutes += r.minutes; keep[0].chunks += r.chunks; keep[0].aborted += r.aborted; }
      cohorts = keep;
    }
    const out = { v: 2, day: p.day, product: p.product, platform: p.platform, sdk_version: p.sdk_version, app_version: p.app_version,
      device: p.device, cohorts };
    if (Object.keys(p.coverage).length) out.coverage = p.coverage;
    if (p.downloads.length) out.downloads = p.downloads;
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
