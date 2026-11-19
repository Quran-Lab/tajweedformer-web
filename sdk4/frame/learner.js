// This install's own days, kept on the device and never sent: its first active UTC
// day, its active UTC days and local days of the last weeks, the streak at each active day, which days' learner facts
// were sealed, and five weeks of (judged, correct) for the weekly trend. The same rules as the Apple SDK's
// LearnerJournal (tajweedformer-sdk-swift sdk-4.0.0, Cloud/RecitedAnalytics.swift), checked by the same cases.
//
// TODO(Core request R10, docs/core-requests.md): the contract keeps these in the Core's journal, written in the same
// atomic write as the counts they feed (qlc_days_mark, qlc_days_judged, qlc_days_read). Until the Core has them the
// SDK keeps them in its own state (the `learner` key of the Worker's KV), which every step writes in ONE IndexedDB
// transaction with the counters they feed (stores.js StateStore.flush).
//
// Days are `yyyy-mm-dd` strings: UTC days for the counters, the device's local day for the streak.

const DAY_MS = 86_400_000;
const parse = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; };
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

export const DayMath = Object.freeze({
  utc: (ms) => fmt(ms),
  days: (a, b) => { const x = parse(a), y = parse(b); return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / DAY_MS); },
  add: (d, n) => { const x = parse(d); return Number.isNaN(x) ? null : fmt(x + n * DAY_MS); },
  /** The Monday that starts the UTC week (Monday to Sunday) of a day. */
  monday: (d) => { const x = parse(d); if (Number.isNaN(x)) return null; const wd = new Date(x).getUTCDay(); return fmt(x - ((wd + 6) % 7) * DAY_MS); },
  /** The device's local day and hour of a moment (only the hour's bucket and the streak leave the device). */
  local: (ms) => { const t = new Date(ms); return { day: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`, hour: t.getHours() }; },
});

/** The juz of an ayah (Hafs, the 30 standard parts): the starts of juz 1 to 30 as [surah, ayah]. */
const JUZ_STARTS = [[1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 83], [6, 111], [7, 88], [8, 41], [9, 93], [11, 6], [12, 53],
  [15, 1], [17, 1], [18, 75], [21, 1], [23, 1], [25, 21], [27, 56], [29, 46], [33, 31], [36, 28], [39, 32], [41, 47], [46, 1],
  [51, 31], [58, 1], [67, 1], [78, 1]];
export function juzOf(surah, ayah) {
  let j = 1;
  JUZ_STARTS.forEach(([s, a], i) => { if (surah > s || (surah === s && ayah >= a)) j = i + 1; });
  return j;
}

const recent = (days, keep) => [...new Set(days)].sort().slice(-keep);

export class LearnerJournal {
  static from(o) { return Object.assign(new LearnerJournal(), o || {}); }
  constructor() {
    this.firstDay = null;
    this.activeDays = [];
    this.localDays = [];
    this.streaks = {};
    this.sentDays = [];
    this.weeks = {};
    this.trendWeek = null;
  }
  toJSON() { return { firstDay: this.firstDay, activeDays: this.activeDays, localDays: this.localDays, streaks: this.streaks, sentDays: this.sentDays, weeks: this.weeks, trendWeek: this.trendWeek }; }

  /** A take with audio on this UTC day and this local day. */
  markActive(utc, local) {
    if (!this.firstDay || utc < this.firstDay) this.firstDay = utc;
    if (!this.activeDays.includes(utc)) this.activeDays = recent([...this.activeDays, utc], 40);
    if (!this.localDays.includes(local)) this.localDays = recent([...this.localDays, local], 40);
    this.streaks[utc] = this.streak(local);
    const keepFrom = this.activeDays.slice(-10)[0];
    this.streaks = Object.fromEntries(Object.entries(this.streaks).filter(([k]) => this.activeDays.includes(k) && k >= keepFrom));
  }

  /** Consecutive active local days up to and including `local`. */
  streak(local) {
    let n = 0;
    for (let d = local; d && this.localDays.includes(d); d = DayMath.add(d, -1)) n++;
    return n;
  }

  /** The learner facts of an active UTC day, once (null for a day not active or sent already); marks it sent. */
  takeFacts(day) {
    const since = this.firstDay ? DayMath.days(this.firstDay, day) : null;
    if (!this.activeDays.includes(day) || this.sentDays.includes(day) || since === null) return null;
    this.sentDays = recent([...this.sentDays, day], 10);
    const learner = { active: 1, new: since === 0 ? 1 : 0, d1: since === 1 ? 1 : 0, d7: since === 7 ? 1 : 0, d30: since === 30 ? 1 : 0 };
    const prev = this.activeDays.filter((d) => d < day).sort().pop();
    let gap;
    if (prev) { const n = DayMath.days(prev, day); gap = n > 30 ? 'gt_30' : String(n); } else gap = this.firstDay === day ? 'new' : 'gt_30';
    const s = this.streaks[day] || 1;
    const streak = s >= 30 ? 'ge_30' : s >= 14 ? '14_29' : s >= 7 ? '7_13' : s >= 4 ? '4_6' : s >= 2 ? '2_3' : '1';
    return { learner, gap, streak };
  }

  /** One judged ayah on a UTC day (17.9 trend). */
  judged(day, correct) {
    const w = DayMath.monday(day);
    if (!w) return;
    const x = this.weeks[w] || { judged: 0, correct: 0 };
    x.judged++;
    if (correct) x.correct++;
    this.weeks[w] = x;
    const keep = new Set(recent(Object.keys(this.weeks), 6));
    this.weeks = Object.fromEntries(Object.entries(this.weeks).filter(([k]) => keep.has(k)));
  }

  /**
   * 17.9's trend of the week that ended last before `day`, once per week: the last week against the four before;
   * both need 20 judged ayahs, else not_enough; a move of the correct share by 5 points or more is better or worse,
   * else same. Null when sent already, or when none of those five weeks holds a judged ayah.
   */
  takeTrend(day) {
    const thisWeek = DayMath.monday(day);
    const last = thisWeek && DayMath.add(thisWeek, -7);
    if (!last || (this.trendWeek && this.trendWeek >= last)) return null;
    const lw = this.weeks[last] || { judged: 0, correct: 0 };
    const pw = { judged: 0, correct: 0 };
    for (let k = 1; k <= 4; k++) { const x = this.weeks[DayMath.add(last, -7 * k)]; if (x) { pw.judged += x.judged; pw.correct += x.correct; } }
    if (lw.judged + pw.judged === 0) return null;
    this.trendWeek = last;
    if (lw.judged < 20 || pw.judged < 20) return 'not_enough';
    const move = 100 * (lw.correct / lw.judged - pw.correct / pw.judged);
    return move >= 5 ? 'better' : move <= -5 ? 'worse' : 'same';
  }

  /** The days since the first active day as 17.9's tenure: 0 to 6 w1, 7 to 27 w2_4, 28 to 89 m2_3, 90 on later. */
  tenure(day) {
    const n = this.firstDay ? DayMath.days(this.firstDay, day) || 0 : 0;
    return n < 7 ? 'w1' : n < 28 ? 'w2_4' : n < 90 ? 'm2_3' : 'later';
  }
}
