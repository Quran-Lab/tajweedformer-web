// Makes test/sharing/deck_fragments.json: for each of the eight languages, the length in UTF-8 bytes and the
// SHA-256 of the sentence that copy deck 2026-11-12.1 added to `sheet.who` and `what.detail`, which the bundled
// deck (2026-11-13.1) does not have. Only the length and the hash are written: the text itself stays in the
// contract's archive and does not come into this repository.
//
//   node test/sharing/deck_fragments.mjs <the contract's sharing_copy folder>     (or SHARING_COPY_DIR=<folder>)
//
// Reads <folder>/archive/2026-11-12.1/<lang>.json and <folder>/<lang>.json, each checked against the SHA-256
// its folder's READY file lists. The fragment of a key is what the archived string has between the longest
// start and the longest end it shares with the new string, with the white space at its two ends left out; the
// new string must be the archived one without that fragment, or the script stops. test/sharing_copy.test.mjs
// slides a window of that length over the UTF-8 bytes of what the sheet shows and fails when a window has the
// hash.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || process.env.SHARING_COPY_DIR;
if (!dir) { console.error('usage: node test/sharing/deck_fragments.mjs <the contract\'s sharing_copy folder>'); process.exit(2); }
const ARCHIVED = '2026-11-12.1';
const LANGS = ['ar', 'bn', 'en', 'fr', 'id', 'ms', 'tr', 'ur'];
const KEYS = ['sheet.who', 'what.detail'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function deck(folder, lang) {
  const bytes = readFileSync(path.join(folder, `${lang}.json`));
  const ready = readFileSync(path.join(folder, 'READY'), 'utf8');
  if (!ready.includes(`${sha256(bytes)} *${lang}.json`)) throw new Error(`${folder}/${lang}.json is not the file its READY lists`);
  return JSON.parse(bytes.toString('utf8'));
}

function fragment(old, now, where) {
  let a = 0;
  while (a < now.length && old[a] === now[a]) a++;
  let b = 0;
  while (b < now.length - a && old[old.length - 1 - b] === now[now.length - 1 - b]) b++;
  if (a + b !== now.length) throw new Error(`${where}: the new string is not the archived one with one part left out`);
  const cut = old.slice(a, old.length - b).trim();
  if (!cut) throw new Error(`${where}: nothing was left out`);
  return cut;
}

let bundled = null;
const languages = {};
for (const lang of LANGS) {
  const old = deck(path.join(dir, 'archive', ARCHIVED), lang), now = deck(dir, lang);
  if (old.version !== ARCHIVED) throw new Error(`${lang}: the archived deck is ${old.version}`);
  bundled = bundled || now.version;
  if (now.version !== bundled) throw new Error(`${lang}: the decks disagree on their version`);
  const changed = Object.keys(old.strings).filter((k) => JSON.stringify(old.strings[k]) !== JSON.stringify(now.strings[k])).sort();
  if (JSON.stringify(changed) !== JSON.stringify(KEYS)) throw new Error(`${lang}: the strings that differ are ${changed.join(', ')}`);
  const cuts = KEYS.map((k) => fragment(old.strings[k], now.strings[k], `${lang} ${k}`));
  // one entry per different fragment, with the keys it was cut from
  const entries = [];
  cuts.forEach((cut, i) => {
    const bytes = Buffer.from(cut, 'utf8');
    const hit = entries.find((e) => e.sha256 === sha256(bytes));
    if (hit) hit.keys.push(KEYS[i]); else entries.push({ keys: [KEYS[i]], bytes: bytes.length, sha256: sha256(bytes) });
  });
  languages[lang] = entries;
}
const out = { format: 'quranlab.deck-fragments/1', archived: ARCHIVED, bundled,
  note: 'Per language: the UTF-8 length and SHA-256 of what the archived deck\'s strings have and the bundled deck\'s do not. Made by test/sharing/deck_fragments.mjs; never edited by hand.',
  languages };
writeFileSync(new URL('./deck_fragments.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${LANGS.length} languages, ${Object.values(languages).reduce((n, e) => n + e.length, 0)} fragments (archived ${ARCHIVED}, bundled ${bundled}): ${LANGS.map((l) => `${l} ${languages[l].map((e) => `${e.bytes} bytes in ${e.keys.join(' and ')}`).join('; ')}`).join(', ')}`);
