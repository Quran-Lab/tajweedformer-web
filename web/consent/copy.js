// The sharing copy: Quran Lab's copy decks (quranlab.sharing-copy/1), bundled in decks.js for en, ar, id, ur,
// tr, ms, fr, bn. Apps choose the language and the timing; an app that replaces strings with its own wording
// (wording.js) makes the learner agree to that wording instead. The hadith line is in every deck with its
// verified source.

import { DECKS } from './decks.js';

const extra = new Map();

/** Add or replace a deck (a newer quranlab.sharing-copy/1 file the backend serves). */
export function registerDeck(lang, deck) {
  if (!deck || deck.format !== 'quranlab.sharing-copy/1') throw new TypeError('registerDeck: a quranlab.sharing-copy/1 deck is needed');
  extra.set(lang, deck);
}
/** Shipped languages. */
export function languages() { return [...new Set([...Object.keys(DECKS), ...extra.keys()])]; }

/** The English source deck. */
export const EN = DECKS.en;

/**
 * The deck for a BCP 47 tag ("ar-EG" -> "ar"; English for a language not shipped), with helpers:
 * t(key) a string (the app's override, else the deck's, else English), minutes(n) the plural impact line.
 * `overrides` is an app's validated wording ({key: text}, plural lines as `impact.minutes.<category>`).
 * Decks up to 2026-11-07 had a `{days}` placeholder (filled from delete_days); later decks delete at once
 * and have none.
 */
export function copyFor(lang = 'en', overrides = null) {
  const tag = String(lang || 'en');
  const base = tag.toLowerCase().split(/[-_]/)[0];
  const d = extra.get(tag) || extra.get(base) || DECKS[base] || DECKS.en;
  const own = overrides || {};
  const fill = (v) => (typeof v === 'string' ? v.replace(/\{days\}/g, String(d.delete_days ?? 0)) : v);
  const t = (k) => {
    if (typeof own[k] === 'string') return own[k];
    const v = d.strings[k] !== undefined ? d.strings[k] : DECKS.en.strings[k];
    return fill(v);
  };
  const minutes = (n) => {
    const forms = t('impact.minutes') || {};
    let cat = 'other';
    try { cat = new Intl.PluralRules(d.lang).select(n); } catch (_) { /* other */ }
    const s = own[`impact.minutes.${cat}`] ?? forms[cat] ?? own['impact.minutes.other'] ?? forms.other ?? '';
    let num = String(n);
    try { num = new Intl.NumberFormat(d.lang).format(n); } catch (_) { /* plain */ }
    return s.replace(/\{minutes\}/g, num);
  };
  return { lang: d.lang, dir: d.dir || 'ltr', version: d.version, consentVersion: d.consent_version, deleteDays: d.delete_days ?? 0,
    deleteTiming: d.delete_timing || (d.delete_days ? 'delayed' : 'immediate'), hadithSource: d.hadith_source || null,
    overridden: Object.keys(own), t, minutes };
}
