// Telemetry v2 (PLATFORM_CLIENT.md section 6): on by default, anonymous by construction. Only sums
// and histograms per UTC day: no audio, no text or phonemes, no identifiers, no time finer than the
// day. Since 2.0.1 it goes as deltas during the day: what was counted since the last send point is
// sealed into a report with a fresh random report_id (kept in storage before it is sent, so a retry sends
// the same bytes and the server counts it once), one report per UTC day it covers, at most 7 days kept.
// The send points (every 15 minutes while the app is in use, when it goes to the background, at launch)
// are the platform client's (client.js).
// Tried and rejected: sending the whole day again with a day-scoped id (the server would have to diff
// days); one report spanning midnight (a delta belongs to one day, as the server's points do).

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
const DAY_MS = 86_400_000;
/** The 2.0.1 counters at the top level of a report (each left out when zero). */
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
// a verdict or a check that ran: its status is not off and it is not disabled (absent settings: ran)
const ran = (x) => x === undefined || x === null || (x.status !== 'off' && x.enabled !== false);

/**
 * The day's counters, persisted in `state` under "telemetry.days" ({ day: payload-in-progress }).
 * `device` is { class, soc?, os_major, ram_tier? }, `product` the platform's (productOf), `platform` the token app's.
 */
// The telemetry product of a platform, as the server checks it (PRODUCT_OF): a desktop app running this SDK in Node
// reports as the native product of its platform, a page as web.
export const PRODUCT_OF = Object.freeze({ web: 'web', windows: 'native', linux: 'native', macos: 'apple', ios: 'apple', android: 'android' });
export const productOf = (platform) => PRODUCT_OF[platform] || 'web';

export class Telemetry {
  constructor({ state, platform = 'web', product = productOf(platform), sdkVersion = '2.0.1', appVersion = '0', device, clock = Date.now, enabled = true }) {
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

  /** A scored ayah: per class sites and flags, the session's flag %, madd counts, words, coverage; and the 2.0.1
   * counters: ayahs, surah_ayahs, words, rule_checks / rule_flags (a verdict counts only when its check ran). */
  scored(tf, r) {
    this._edit((d) => {
      d.ayahs = Math.min(CAP, (d.ayahs || 0) + 1);
      if (Number.isInteger(r.surah) && r.surah >= 1 && r.surah <= 114) {
        d.surah_ayahs = d.surah_ayahs || {};
        d.surah_ayahs[String(r.surah)] = (d.surah_ayahs[String(r.surah)] || 0) + 1;
      }
      const eff = r.settings || {};
      const rule = (key, checked, flagged) => {
        if (!checked || !RULE_KEY.test(key)) return;
        d.rule_checks = d.rule_checks || {};
        d.rule_flags = d.rule_flags || {};
        if (!(key in d.rule_checks) && Object.keys(d.rule_checks).length >= MAX_RULE_KEYS) return;
        d.rule_checks[key] = Math.min(CAP, (d.rule_checks[key] || 0) + 1);
        if (flagged) d.rule_flags[key] = Math.min(d.rule_checks[key], (d.rule_flags[key] || 0) + 1);
      };
      for (const s of r.sites || []) rule(s.class, ran(s) && ran(eff.sites && eff.sites[s.class]), s.flagged);
      for (const m of r.madd || []) rule('madd', ran(m) && ran(eff.madd), m.flagged);
      for (const q of r.qalqalah || []) rule('qalqalah', ran(q) && ran(eff.qalqalah), q.flagged);
      for (const g of r.gemination || []) rule('gemination', ran(g) && ran(eff.gemination), g.flagged);
      for (const w of r.words || []) {
        if (w.score === null || w.score === undefined) continue;
        d.words = Math.min(CAP, (d.words || 0) + 1);
        rule('word', true, w.flagged === true);
      }
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

  /** +n on a 2.0.1 counter (COUNTERS: launches, share_asked, share_yes, share_no, ...). */
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
  clear() { this.state.set('telemetry.days', null); this.state.set('telemetry.sealed', null); }

  /** Whether a report body carries anything (a delta with no count is not sent). */
  static hasContent(b) {
    return b.cohorts.length > 0 || !!b.coverage || !!b.downloads || COUNTERS.some((k) => b[k] > 0) || !!b.surah_ayahs || !!b.rule_checks;
  }

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
    if (Object.keys(p.coverage || {}).length) out.coverage = p.coverage;
    if ((p.downloads || []).length) out.downloads = p.downloads;
    // the 2.0.1 fields, each left out when zero or empty
    for (const k of COUNTERS) if (p[k] > 0) out[k] = p[k];
    if (p.surah_ayahs && Object.keys(p.surah_ayahs).length) out.surah_ayahs = p.surah_ayahs;
    if (p.rule_checks && Object.keys(p.rule_checks).length) {
      out.rule_checks = p.rule_checks;
      const flags = Object.fromEntries(Object.entries(p.rule_flags || {}).filter(([k, v]) => v > 0 && k in p.rule_checks));
      if (Object.keys(flags).length) out.rule_flags = flags;
    }
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
