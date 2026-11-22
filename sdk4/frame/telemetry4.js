// The day's anonymous totals of SDK 4.0 for the web: the 3.x delta (web/platform/telemetry.js) with contract draft
// 17.1, 17.8 and 17.9, the same fields and rules as the Apple SDK (Cloud/RecitedAnalytics.swift):
//
//   17.1  ayahs / surah_ayahs (measured, never in `reported`), app_ayahs / app_surah_ayahs (the app's, always in it)
//   17.8  juz_ayahs, hour_speech_s, take_s, session_s, learner, learner_gap, streak, repeat_ayahs, recited_takes, lease
//   17.9  judged, judged_surah_ayahs, correct_surah_ayahs, judged_tenure, trend (all the app's: in `reported`)
//
// The install's own days (learner.js) live in the same state as the counters they feed, under `learner`; the open
// analytics session under `analytics.session`. Every method changes the state synchronously, so the caller's next
// flush writes the counters and the days in ONE IndexedDB transaction. `flags.metrics` switches groups off (absent or
// true: on); a group that is off sends nothing and seals no facts.
import { Telemetry, utcDay } from '../../web/platform/telemetry.js';
import { LearnerJournal, DayMath, juzOf } from './learner.js';
import { hostAllowed, asciiLower } from '../shared/endpoints.js';

const CAP = 10_000_000;
const clip = (n) => Math.max(0, Math.min(CAP, Math.round(n)));
const add = (o, k, n) => { o[k] = clip((o[k] || 0) + n); };
const baseWire = Telemetry.wire, baseHas = Telemetry.hasContent;

export const TAKE_BUCKETS = [['le_5', 'le_15', 'le_30', 'le_60', 'le_120', 'le_300', 'le_600', 'gt_600'], [5, 15, 30, 60, 120, 300, 600]];
export const SESSION_BUCKETS = [['le_60', 'le_300', 'le_600', 'le_1200', 'le_1800', 'le_3600', 'gt_3600'], [60, 300, 600, 1200, 1800, 3600]];
export const LEASE_CAUSES = ['offline', 'refused', 'expired', 'clock', 'attestation', 'other'];
export const RECITED_KEYS = ['measured', 'context', 'none', 'app', 'recovered', 'dropped'];
export const JUDGED_KEYS = Object.freeze(['ayahs', 'correct', 'incorrect', 'mistakes', 'first', 'first_correct', 'repeat',
  'repeat_correct', 'measured', 'unpaired']);
export const TENURE_KEYS = ['w1', 'w2_4', 'm2_3', 'later'];
/** The groups flags.metrics switches, and their fields (17.8, 17.9). */
export const METRIC_GROUPS = Object.freeze({
  juz: ['juz_ayahs'], hours: ['hour_speech_s'], lengths: ['take_s', 'session_s'], learner: ['learner', 'learner_gap', 'streak'],
  repeats: ['repeat_ayahs'], health: ['recited_takes', 'lease'],
  judged: ['judged', 'judged_surah_ayahs', 'correct_surah_ayahs', 'judged_tenure', 'trend'],
});
/** Always in `reported` when present: the app's counts and its judgement. */
export const REPORTED_4 = Object.freeze(['app_ayahs', 'app_surah_ayahs', 'words', 'rule_checks', 'rule_flags', 'judged',
  'judged_surah_ayahs', 'correct_surah_ayahs', 'judged_tenure', 'trend']);
const bucket = (v, edges) => { const i = edges.findIndex((e) => v <= e); return i < 0 ? edges.length : i; };
const under = (v, edges) => { const i = edges.findIndex((e) => v < e); return i < 0 ? edges.length : i; };

/**
 * STEERING_40.md 34.6 (SDK 4.0.2): per models host per UTC day, the download counts the host order is made from. A
 * request's time from sent to status in 9 buckets (under 100, 250, 500, 1000, 1500, 3000, 6000, 10000 ms, and over);
 * each transfer of at least 256 KiB, its average rate over its body in 10 buckets of kB/s (1000 bytes: under 32, 64,
 * 128, 256, 512, 1024, 2048, 4096, 8192, and over); at most 8 hosts a day, hosts of the allow-list only (28.1).
 */
export const HOST_TTFB_MS = Object.freeze([100, 250, 500, 1000, 1500, 3000, 6000, 10000]);
export const HOST_KBPS = Object.freeze([32, 64, 128, 256, 512, 1024, 2048, 4096, 8192]);
export const HOSTS_MAX = 8;
export const HOST_TRANSFER_MIN = 256 * 1024;
/**
 * The switch of 34.6's sending: ON in 4.0.2. POST /v1/events is a closed object; qlab-api takes `hosts` in it from
 * 2026-11-21 (34.6 "The server"), and a body with anything else in `hosts` is refused whole, so the body is built only
 * as hostsValid takes it. Off, the counts are still measured and kept in the day's record from the first page load (or
 * Node start) and leave with the day at its seal. Tests set it per instance (o.sendHosts).
 */
export const SEND_HOSTS = true;
const HOST_KEYS = ['role', 'host', 'files', 'bytes', 'requests', 'unreachable', 'hedged', 'slow_switches', 'ttfb_ms', 'kbps'];
const count = (n) => Number.isInteger(n) && n >= 0;

/** 34.6: whether `hosts` is a body the server takes (steering_40.json `telemetry`): at most 8 entries, each exactly
 * HOST_KEYS, role models, a host of the allow-list once, counts that are integers of 0 or more, 9 and 10 buckets. */
export function hostsValid(list) {
  if (!Array.isArray(list) || list.length > HOSTS_MAX) return false;
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    const keys = Object.keys(e);
    if (keys.length !== HOST_KEYS.length || !HOST_KEYS.every((k) => keys.includes(k))) return false;
    if (e.role !== 'models' || typeof e.host !== 'string' || !hostAllowed(e.host) || e.host !== e.host.toLowerCase() || seen.has(e.host)) return false;
    seen.add(e.host);
    if (!['files', 'bytes', 'requests', 'unreachable', 'hedged', 'slow_switches'].every((k) => count(e[k]))) return false;
    if (!Array.isArray(e.ttfb_ms) || e.ttfb_ms.length !== HOST_TTFB_MS.length + 1 || !e.ttfb_ms.every(count)) return false;
    if (!Array.isArray(e.kbps) || e.kbps.length !== HOST_KBPS.length + 1 || !e.kbps.every(count)) return false;
  }
  return true;
}
const hist = (names, counts) => Object.fromEntries(names.map((n, i) => [n, clip(counts[i] || 0)]));

export class Telemetry4 extends Telemetry {
  /**
   * @param {object} o  Telemetry's options, plus metricsOff: () => Set of group names the config switches off, and
   *   local: (ms) => { day, hour } (the device's local day and hour; tests set a zone)
   */
  constructor(o) {
    super(o);
    this.metricsOff = o.metricsOff || (() => new Set());
    this.local = o.local || DayMath.local;
    this._at = null;
    this.sendHosts = typeof o.sendHosts === 'boolean' ? o.sendHosts : SEND_HOSTS; // 34.6: on in 4.0.2 (SEND_HOSTS)
  }

  /**
   * 34.6: one model request's facts on a models host, into today's record: `requests` (1 when sent), `unreachable` (1
   * when it ended unreachable, 28.3 item 3), `ttfbMs` (from sent to status, when a status came), `bytes` (model bytes
   * it received), `transfer` ({ bytes, ms }: its body, rated when 256 KiB or more), `files` (1 when the file's last
   * byte came from it). A host off the allow-list, or a ninth host of the day, is not counted.
   */
  recordHost(host, { requests = 0, unreachable = 0, ttfbMs = null, bytes = 0, transfer = null, files = 0 } = {}) {
    const h = typeof host === 'string' ? asciiLower(host) : '';
    if (!hostAllowed(h)) return;
    this._edit((d) => {
      const v = (d.v4 = d.v4 || {});
      const all = (v.hosts = v.hosts || {});
      if (!all[h] && Object.keys(all).length >= HOSTS_MAX) return;
      const e = (all[h] = all[h] || { files: 0, bytes: 0, requests: 0, unreachable: 0, ttfb: Array(HOST_TTFB_MS.length + 1).fill(0), kbps: Array(HOST_KBPS.length + 1).fill(0) });
      add(e, 'requests', requests);
      add(e, 'unreachable', unreachable);
      add(e, 'files', files);
      e.bytes = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(e.bytes + Math.max(0, bytes))));
      if (Number.isFinite(ttfbMs) && ttfbMs >= 0) { const i = under(ttfbMs, HOST_TTFB_MS); e.ttfb[i] = clip(e.ttfb[i] + 1); }
      if (transfer && transfer.bytes >= HOST_TRANSFER_MIN) {
        const i = under(transfer.bytes / Math.max(1, transfer.ms), HOST_KBPS); // bytes per ms is kB/s
        e.kbps[i] = clip(e.kbps[i] + 1);
      }
    });
  }

  /** 34.6: the day's `hosts` as the server takes it (hedged and slow_switches 0: 34.4 and 34.5 are SDK 4.0.3). */
  static hostsBody(v) {
    const out = [];
    for (const [host, e] of Object.entries((v && v.hosts) || {})) {
      if (out.length >= HOSTS_MAX || !hostAllowed(host) || !e) continue;
      const n = (x) => (Number.isFinite(x) && x > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(x)) : 0);
      const list = (a, len) => Array.from({ length: len }, (_, i) => n(Array.isArray(a) ? a[i] : 0));
      out.push({ role: 'models', host: asciiLower(host), files: n(e.files), bytes: n(e.bytes), requests: n(e.requests), unreachable: n(e.unreachable),
        hedged: 0, slow_switches: 0, ttfb_ms: list(e.ttfb, HOST_TTFB_MS.length + 1), kbps: list(e.kbps, HOST_KBPS.length + 1) });
    }
    return out;
  }

  // ---- the install's days and the open session (state keys written with the counters) ----
  journal() { return LearnerJournal.from(this.state.get('learner')); }
  _saveJournal(j) { this.state.set('learner', j.toJSON()); }

  // edit the payload of `day` (a take recovered after a kill counts on its own day, 17.6), or today's
  _edit(fn) {
    if (!this._at) return super._edit(fn);
    if (!this.enabled) return;
    const days = this._days();
    const day = this._at;
    if (!days[day]) days[day] = { v: 2, day, product: this.product, platform: this.platform, sdk_version: this.sdkVersion, app_version: this.appVersion, device: this.device, cohorts: [], coverage: {}, downloads: [] };
    fn(days[day]);
    const keys = Object.keys(days).sort();
    while (keys.length > 7) delete days[keys.shift()];
    this._save(days);
  }
  on(day, f) { const at = this._at; this._at = day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= utcDay(this.clock() - 6 * 86_400_000) ? day : null; try { return f(); } finally { this._at = at; } }

  /**
   * A take ended (17.8): an active day when it had audio; a finished take's seconds into take_s and its speech by
   * local hour into hour_speech_s; its audio into the open analytics session (session_s). `hourSpeechMs`: { hour: ms }.
   */
  recordTake({ samples = 0, sampleRate = 16000, aborted = false, hourSpeechMs = {} }) {
    if (!this.enabled || samples <= 0) return;
    const now = this.clock(), day = utcDay(now);
    const j = this.journal();
    j.markActive(day, this.local(now).day);
    this._saveJournal(j);
    const audioMs = Math.floor((1000 * samples) / sampleRate);
    this._edit((d) => {
      const v = (d.v4 = d.v4 || {});
      if (!aborted) {
        v.take_s = v.take_s || new Array(8).fill(0);
        v.take_s[bucket(audioMs / 1000, TAKE_BUCKETS[1])]++;
        v.hour_ms = v.hour_ms || {};
        for (const [h, ms] of Object.entries(hourSpeechMs || {})) if (ms > 0 && +h >= 0 && +h <= 23) add(v.hour_ms, String(+h), ms);
      }
    });
    const s = this.state.get('analytics.session') || { day, audioMs: 0 };
    s.audioMs += audioMs;
    this.state.set('analytics.session', s);
  }

  /** The page session ends (the page is left, the Client closes, or a kill left one open): its audio into session_s. */
  closeSession() {
    const s = this.state.get('analytics.session');
    if (!s) return;
    this.state.set('analytics.session', null);
    if (!this.enabled || !(s.audioMs > 0)) return;
    this.on(s.day, () => this._edit((d) => {
      const v = (d.v4 = d.v4 || {});
      v.session_s = v.session_s || new Array(7).fill(0);
      v.session_s[bucket(s.audioMs / 1000, SESSION_BUCKETS[1])]++;
    }));
  }

  /**
   * One finished take's counts (17.1, 17.8, 17.9), from recited.js takeCounts: `c` = { source, measured, app, judged,
   * range: { surah, first, last } of the measured take }. `repeatSeen`: the measured ayahs of this page session;
   * `detectorRan`: the take was fed to the detector; `recovered`: finished from the journal after a kill.
   */
  countTake(c, { repeatSeen = new Set(), detectorRan = false, recovered = false, day = null } = {}) {
    this.on(day, () => {
      const dayKey = this._at || utcDay(this.clock());
      const j = this.journal();
      this._edit((d) => {
        const v = (d.v4 = d.v4 || {});
        const takes = (v.recited_takes = v.recited_takes || {});
        if (c.source === 'measured') {
          const { surah, first, last } = c.range;
          add(d, 'ayahs', last - first + 1);
          d.surah_ayahs = d.surah_ayahs || {};
          add(d.surah_ayahs, String(surah), last - first + 1);
          add(takes, 'measured', 1);
          if (c.context) add(takes, 'context', 1);
          v.juz = v.juz || {};
          for (let a = first; a <= last; a++) {
            add(v.juz, String(juzOf(surah, a)), 1);
            const k = `${surah}:${a}`;
            if (repeatSeen.has(k)) add(v, 'repeat_ayahs', 1); else repeatSeen.add(k);
          }
        } else if (c.source === 'app') {
          add(d, 'app_ayahs', c.app.ayahs);
          d.app_surah_ayahs = d.app_surah_ayahs || {};
          add(d.app_surah_ayahs, String(c.app.surah), c.app.ayahs);
          add(takes, 'app', 1);
        } else if (detectorRan) {
          add(takes, 'none', 1);
        }
        if (recovered) add(takes, 'recovered', 1);
        const g = c.judged;
        if (g && (g.ayahs || g.unpaired || g.mistakes)) {
          d.judged = d.judged || {};
          for (const k of JUDGED_KEYS) if (g[k]) add(d.judged, k, g[k]);
          for (const [f, m] of [['judged_surah_ayahs', g.bySurah], ['correct_surah_ayahs', g.correctBySurah]]) {
            for (const [s, n] of Object.entries(m || {})) if (n) { d[f] = d[f] || {}; add(d[f], s, n); }
          }
          for (const [rule, n] of Object.entries(g.rules || {})) {
            d.rule_checks = d.rule_checks || {}; d.rule_flags = d.rule_flags || {};
            add(d.rule_checks, rule, n); d.rule_flags[rule] = Math.min(d.rule_checks[rule], (d.rule_flags[rule] || 0) + n);
          }
          if (g.ayahs) {
            const t = j.tenure(dayKey);
            v.tenure = v.tenure || {};
            const x = (v.tenure[t] = v.tenure[t] || { judged: 0, correct: 0 });
            x.judged = clip(x.judged + g.ayahs);
            x.correct = clip(x.correct + g.correct);
            for (const a of g.ayahList || []) j.judged(dayKey, a.correct);
          }
        }
      });
      this._saveJournal(j);
    });
  }

  /** One lease request's outcome (17.8 `lease`): 'ok' or a cause of LEASE_CAUSES. */
  recordLease(outcome) {
    this._edit((d) => {
      const v = (d.v4 = d.v4 || {});
      if (outcome === 'ok') add(v, 'lease_ok', 1);
      else { v.lease_failed = v.lease_failed || {}; add(v.lease_failed, LEASE_CAUSES.includes(outcome) ? outcome : 'other', 1); }
    });
  }

  /** A send point (3.x seal) with the facts of 17.8 and 17.9 sealed into a day's first delta, in the same step. */
  seal() {
    const off = this.metricsOff();
    const days = this._days();
    const sealed = this._sealed();
    const j = this.journal();
    let n = 0;
    for (const day of Object.keys(days).sort()) {
      const p = days[day];
      const v = (p.v4 = p.v4 || {});
      if (!off.has('learner')) { const f = j.takeFacts(day); if (f) { v.learner = f.learner; v.learner_gap = f.gap; v.streak = f.streak; } }
      if (!off.has('judged')) { const t = j.takeTrend(day); if (t) v.trend = t; }
      const body = Telemetry4.wire(p, off, { hosts: this.sendHosts });
      delete days[day];
      if (!Telemetry4.hasContent(body)) continue;
      const reportId = globalThis.crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
      sealed.push({ report_id: reportId, day, body: JSON.stringify({ ...body, report_id: reportId }), attempts: 0, next: 0 });
      n++;
    }
    this._saveJournal(j);
    this._putSealed(this._fresh(sealed));
    this._save(days);
    return n;
  }

  static hasContent(b) {
    return baseHas.call(Telemetry, b) || ['app_ayahs', 'app_surah_ayahs', 'judged', 'juz_ayahs', 'hour_speech_s', 'take_s', 'session_s', 'learner',
      'repeat_ayahs', 'recited_takes', 'lease', 'trend', 'hosts'].some((k) => b[k] !== undefined);
  }

  /** The closed body: the 3.x body, the 4.0 fields each left out when empty, none of a group switched off; `hosts`
   * (34.6) only with the switch on (`hosts: true`) and a host counted that day. */
  static wire(p, off = new Set(), { hosts = false } = {}) {
    const out = baseWire.call(Telemetry, { ...p, coverage: {} });
    delete out.reported;
    const v = p.v4 || {};
    const surahs = (m) => Object.fromEntries(Object.entries(m || {}).filter(([k, n]) => +k >= 1 && +k <= 114 && n > 0).map(([k, n]) => [k, clip(n)]));
    if (p.app_ayahs > 0) out.app_ayahs = clip(p.app_ayahs);
    for (const f of ['app_surah_ayahs', 'judged_surah_ayahs', 'correct_surah_ayahs']) { const m = surahs(p[f]); if (Object.keys(m).length) out[f] = m; }
    const jd = Object.fromEntries(JUDGED_KEYS.filter((k) => p.judged && p.judged[k] > 0).map((k) => [k, clip(p.judged[k])]));
    if (Object.keys(jd).length) out.judged = jd;
    const juz = Object.fromEntries(Object.entries(v.juz || {}).filter(([k, n]) => +k >= 1 && +k <= 30 && n > 0));
    if (Object.keys(juz).length) out.juz_ayahs = juz;
    if (v.repeat_ayahs > 0) out.repeat_ayahs = clip(v.repeat_ayahs);
    const takes = Object.fromEntries(RECITED_KEYS.filter((k) => v.recited_takes && v.recited_takes[k] > 0).map((k) => [k, clip(v.recited_takes[k])]));
    if (Object.keys(takes).length) out.recited_takes = takes;
    if (v.take_s && v.take_s.some((x) => x > 0)) out.take_s = hist(TAKE_BUCKETS[0], v.take_s);
    if (v.session_s && v.session_s.some((x) => x > 0)) out.session_s = hist(SESSION_BUCKETS[0], v.session_s);
    const hours = Object.fromEntries(Object.entries(v.hour_ms || {}).filter(([h, ms]) => +h >= 0 && +h <= 23 && ms > 0).map(([h, ms]) => [h, Math.min(86_400, ms / 1000)]));
    if (Object.keys(hours).length) out.hour_speech_s = hours;
    const lease = {};
    if (v.lease_ok > 0) lease.ok = clip(v.lease_ok);
    const lf = Object.fromEntries(LEASE_CAUSES.filter((k) => v.lease_failed && v.lease_failed[k] > 0).map((k) => [k, clip(v.lease_failed[k])]));
    if (Object.keys(lf).length) lease.failed = lf;
    if (Object.keys(lease).length) out.lease = lease;
    const ten = {};
    for (const k of TENURE_KEYS) { const x = v.tenure && v.tenure[k]; if (x && x.judged > 0) ten[k] = { judged: clip(x.judged), correct: clip(Math.min(x.correct, x.judged)) }; }
    if (Object.keys(ten).length) out.judged_tenure = ten;
    if (v.learner) out.learner = v.learner;
    if (v.learner_gap) out.learner_gap = { [v.learner_gap]: 1 };
    if (v.streak) out.streak = { [v.streak]: 1 };
    if (v.trend) out.trend = { [v.trend]: 1 };
    if (hosts) { const h = Telemetry4.hostsBody(v); if (h.length) out.hosts = h; }
    for (const g of off) for (const f of METRIC_GROUPS[g] || []) delete out[f];
    const reported = REPORTED_4.filter((k) => out[k] !== undefined);
    if (reported.length) out.reported = reported;
    return out;
  }

}
