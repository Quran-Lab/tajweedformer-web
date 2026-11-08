// The sharing copy: the portal team's decks (the shared copy decks, quranlab.sharing-copy/1), bundled in
// decks.js for en, ar, id, ur, tr, ms, fr, bn. Disclosure lines are shown as written; apps choose the
// language and the timing, never the words. The hadith line is in every deck with its verified source.

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
 * t(key) a string (English when the deck lacks it), minutes(n) the plural impact line, days() lines.
 */
export function copyFor(lang = 'en') {
  const tag = String(lang || 'en');
  const base = tag.toLowerCase().split(/[-_]/)[0];
  const d = extra.get(tag) || extra.get(base) || DECKS[base] || DECKS.en;
  const t = (k) => {
    const v = d.strings[k] !== undefined ? d.strings[k] : DECKS.en.strings[k];
    return typeof v === 'string' ? v.replace(/\{days\}/g, String(d.delete_days)) : v;
  };
  const minutes = (n) => {
    const forms = t('impact.minutes') || {};
    let cat = 'other';
    try { cat = new Intl.PluralRules(d.lang).select(n); } catch (_) { /* other */ }
    const s = forms[cat] || forms.other || '';
    let num = String(n);
    try { num = new Intl.NumberFormat(d.lang).format(n); } catch (_) { /* plain */ }
    return s.replace(/\{minutes\}/g, num);
  };
  return { lang: d.lang, dir: d.dir || 'ltr', version: d.version, consentVersion: d.consent_version, deleteDays: d.delete_days,
    hadithSource: d.hadith_source || null, t, minutes };
}
