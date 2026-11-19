// What a take counts toward the day's totals: exactly one source per take, the
// detector's measurement first, the app's reportRecited only where the detector counted nothing; and the app's own
// judgement (correct, or incorrect with mistakes and rule ids) paired with the ayahs the take is counted for.
// Pure functions: the loader validates with them (argument errors are thrown in the app's call), the engine Worker
// counts with them.
import { ayahsIn } from '../../web/api/surahs.js';

export const RULE_RE = /^[a-z][a-z0-9_]{0,23}$/;

export class ReportError extends TypeError {}

function checkOutcome(o, where) {
  if (o === undefined || o === null) return null;
  if (typeof o !== 'object' || Array.isArray(o) || typeof o.correct !== 'boolean') throw new ReportError(`${where} must be { correct: true } or { correct: false, mistakes?, rules? }`);
  for (const k of Object.keys(o)) if (!['correct', 'mistakes', 'rules'].includes(k)) throw new ReportError(`${where} has an unknown field ${k}`);
  const out = { correct: o.correct };
  if (o.mistakes !== undefined && o.mistakes !== null) {
    if (o.correct) throw new ReportError(`${where}: a correct outcome has no mistakes`);
    if (!Number.isInteger(o.mistakes) || o.mistakes < 1 || o.mistakes > 1000) throw new ReportError(`${where}: mistakes must be a whole number from 1 to 1000`);
    out.mistakes = o.mistakes;
  }
  if (o.rules !== undefined && o.rules !== null) {
    if (o.correct) throw new ReportError(`${where}: a correct outcome has no rules`);
    if (!Array.isArray(o.rules) || o.rules.length > 8 || o.rules.some((r) => typeof r !== 'string' || !RULE_RE.test(r))) {
      throw new ReportError(`${where}: rules must be at most 8 rule ids (lower-case letters, digits and underscores, at most 24)`);
    }
    out.rules = [...new Set(o.rules)];
  }
  return out;
}

/**
 * Check session.reportRecited(surah, ayahFrom, ayahTo, { outcome, perAyah }) and return the plain report:
 * { surah, from, to, outcome|null, perAyah: { ayah: outcome } }. Throws ReportError on any argument error.
 */
export function checkReport(surah, ayahFrom, ayahTo, opts) {
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) throw new ReportError(`surah ${surah} is not 1 to 114`);
  const n = ayahsIn(surah);
  if (!Number.isInteger(ayahFrom) || !Number.isInteger(ayahTo) || ayahFrom < 1 || ayahFrom > ayahTo || ayahTo > n) {
    throw new ReportError(`ayahs ${ayahFrom} to ${ayahTo} are not inside surah ${surah} (1 to ${n})`);
  }
  if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts))) throw new ReportError('the fourth argument is { outcome, perAyah }');
  const o = opts || {};
  for (const k of Object.keys(o)) if (k !== 'outcome' && k !== 'perAyah') throw new ReportError(`unknown option ${k}`);
  const outcome = checkOutcome(o.outcome, 'outcome');
  const perAyah = {};
  if (o.perAyah !== undefined && o.perAyah !== null) {
    if (typeof o.perAyah !== 'object' || Array.isArray(o.perAyah)) throw new ReportError('perAyah must be { ayah: outcome }');
    for (const [k, v] of Object.entries(o.perAyah)) {
      const a = Number(k);
      if (!Number.isInteger(a) || String(a) !== k || a < ayahFrom || a > ayahTo) throw new ReportError(`perAyah names ayah ${k}, outside ${ayahFrom} to ${ayahTo}`);
      perAyah[a] = checkOutcome(v, `perAyah[${k}]`);
    }
  }
  return { surah, from: ayahFrom, to: ayahTo, outcome, perAyah };
}

/**
 * The counts of one finished take. `measured`: the Core's result ({ found, surah, first, last }) or null when the
 * detector did not run; `report`: the app's checked report or null; `seen`: the ayahs judged earlier in this
 * session (a Set of "surah:ayah", updated here). Returns { source: 'measured'|'app'|'none', measured, app, judged }.
 */
export function takeCounts(measured, report, seen = new Set()) {
  const out = { source: 'none', measured: null, app: null, judged: null };
  let surah, first, last;
  if (measured && measured.found) {
    out.source = 'measured';
    ({ surah, first, last } = measured);
    out.measured = { surah, ayahs: last - first + 1 };
  } else if (report) {
    out.source = 'app';
    ({ surah, from: first, to: last } = report);
    out.app = { surah, ayahs: last - first + 1 };
  } else {
    return out;
  }
  if (!report || (!report.outcome && !Object.keys(report.perAyah).length)) return out;
  const j = { ayahs: 0, correct: 0, incorrect: 0, mistakes: 0, first: 0, first_correct: 0, repeat: 0, repeat_correct: 0, measured: 0, unpaired: 0,
    bySurah: {}, correctBySurah: {}, rules: {}, ayahList: [] };
  const sameSurah = report.surah === surah;
  if (out.source === 'measured') {
    for (const k of Object.keys(report.perAyah)) {
      const a = Number(k);
      if (!sameSurah || a < first || a > last) j.unpaired++;
    }
  }
  // a range outcome's mistakes count once for the range (decided 11-14, as the Apple SDK); a perAyah entry's for its ayah
  if (report.outcome && !report.outcome.correct && report.outcome.mistakes) j.mistakes += report.outcome.mistakes;
  for (let a = first; a <= last; a++) {
    const own = sameSurah ? report.perAyah[a] : null;
    const o = own || report.outcome;
    if (!o) continue;
    const key = `${surah}:${a}`, again = seen.has(key);
    seen.add(key);
    j.ayahs++;
    j.ayahList.push({ surah, ayah: a, correct: o.correct });
    if (out.source === 'measured') j.measured++;
    j.bySurah[surah] = (j.bySurah[surah] || 0) + 1;
    if (o.correct) { j.correct++; j.correctBySurah[surah] = (j.correctBySurah[surah] || 0) + 1; } else j.incorrect++;
    if (again) { j.repeat++; if (o.correct) j.repeat_correct++; } else { j.first++; if (o.correct) j.first_correct++; }
    if (!o.correct) { if (own && own.mistakes) j.mistakes += own.mistakes; for (const r of o.rules || []) j.rules[r] = (j.rules[r] || 0) + 1; }
  }
  out.judged = j;
  return out;
}
