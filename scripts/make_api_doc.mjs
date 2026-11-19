// Writes docs/api.md: every public name of the package (API 4), read from web/index.d.ts, as the Android and Apple
// SDKs write theirs from their sources (scripts/make_api_doc.py).
//
//   node scripts/make_api_doc.mjs           write docs/api.md
//   node scripts/make_api_doc.mjs --check   exit 1 when docs/api.md differs (test/v4/api_doc.test.mjs runs it)
//
// web/index.d.ts is the whole public surface and nothing else, so the page cannot name a call that does not exist or
// miss one that does: every declaration becomes a section with its doc comment, and every member of a class or an
// interface its signature as written there, with the member's doc comment. Nothing is written by hand below the
// fixed opening, which says what the declarations cannot.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/** The text of a doc comment, on one line. */
function docText(block) {
  return block.replace(/^\s*\/\*\*/, '').replace(/\*\/\s*$/, '').split('\n')
    .map((l) => l.replace(/^\s*\* ?/, '').trim()).filter(Boolean).join(' ').trim();
}

/** Brackets still open in a piece of a signature (string literals left out). */
function depth(s) {
  let d = 0;
  for (const ch of s.replace(/'[^']*'/g, '').replace(/=>/g, '')) {
    if ('({[<'.includes(ch)) d++;
    else if (')}]>'.includes(ch) && d > 0) d--;
  }
  return d;
}

/** [{ kind, name, doc, text, members: [{ sig, doc }] }] in the order of the file, and the file's opening comment. */
export function parse(src) {
  const lines = src.split('\n');
  const intro = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith('//')) intro.push(lines[i++].replace(/^\/\/\s?/, ''));
  const decls = [];
  let doc = [];
  const takeDoc = (j) => { // a doc comment from line j: [text, the line after it]
    let k = j;
    while (!lines[k].includes('*/')) k++;
    return [docText(lines.slice(j, k + 1).join('\n')), k + 1];
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\/\*\*/.test(l)) { const [t, n] = takeDoc(i); doc.push(t); i = n; continue; }
    const m = /^(?:export )?(?:declare )?(const|function|class|interface|type) (\w+)/.exec(l);
    if (!m) { if (l.trim()) doc = []; i++; continue; }
    const [, kind, name] = m;
    const d = { kind, name, doc: doc.join(' '), text: '', members: [] };
    doc = [];
    if ((kind === 'class' || kind === 'interface') && l.trimEnd().endsWith('{')) {
      d.text = l.replace(/\s*\{\s*$/, '');
      i++;
      let mdoc = [];
      while (i < lines.length && lines[i] !== '}') {
        const ml = lines[i];
        if (/^\s*\/\*\*/.test(ml)) { const [t, n] = takeDoc(i); mdoc.push(t); i = n; continue; }
        let sig = ml.trim();
        while ((depth(sig) > 0 || !/[;,]$/.test(sig)) && i + 1 < lines.length && lines[i + 1] !== '}') sig += ' ' + lines[++i].trim();
        sig = sig.replace(/;$/, '');
        if (sig && sig !== 'private constructor()') d.members.push({ sig, doc: mdoc.join(' ') });
        mdoc = [];
        i++;
      }
      i++;
    } else {
      let text = l;
      while (!/;\s*$/.test(text) && i + 1 < lines.length) text += '\n' + lines[++i];
      d.text = text.replace(/;\s*$/, '');
      i++;
    }
    decls.push(d);
  }
  return { intro, decls };
}

const KIND = { class: 'class', interface: 'interface', type: 'type', const: 'constant', function: 'function' };

export function render(pkg, src) {
  const { intro, decls } = parse(src);
  const out = [];
  out.push(`# ${pkg.name} ${pkg.version}: API`, '');
  out.push('Every public name of the package, generated from [`web/index.d.ts`](../web/index.d.ts) by',
    '`scripts/make_api_doc.mjs`: do not edit this page by hand. In a browser the hosted loader',
    '(`https://web.quranlab.ai/4/loader.js`) puts the same names on `globalThis.QuranLab`; the npm package hands out the',
    'same classes, and in Node its `node` entry runs them with a desktop key and its app id. The names and the call order',
    'are the same in the Android, Apple and C SDKs.', '');
  out.push('> ' + intro.join(' '), '');
  out.push('## Call order', '', '```js',
    "const client = await QuranLab.TajweedClient.create({ key: 'qlk_v1_...' });   // or import { TajweedClient } from '@quran-lab/tajweedformer'",
    'const model = await client.model();',
    'const session = await model.listen({ endOnSilenceMs: 1500 });',
    'for await (const chunk of session.chunks) console.log(chunk.decoded.text);',
    '```', '',
    'An app that owns its audio replaces `listen` with `model.session({ sampleRate })` and `session.push(samples)`.',
    'There is no `analytics` option in 4.0: the anonymous analytics are always on, and `create()` refuses an `analytics`',
    'key, whatever its value, with `invalid_argument` (see [migrating-to-4.md](migrating-to-4.md)). There is no `audience`',
    'option either: every app shows the same sharing sheet, and `create()` refuses an `audience` key the same way.', '');
  out.push('## Contents', '');
  for (const d of decls) out.push(`- [\`${d.name}\`](#${d.name.toLowerCase()}) (${KIND[d.kind]})`);
  out.push('');
  for (const d of decls) {
    out.push(`## ${d.name}`, '');
    if (d.doc) out.push(d.doc, '');
    out.push('```ts', d.text.trim(), '```', '');
    for (const m of d.members) out.push(`- \`${m.sig}\`${m.doc ? `: ${m.doc}` : ''}`);
    if (d.members.length) out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(read('package.json'));
  const page = render(pkg, read('web/index.d.ts'));
  const target = path.join(ROOT, 'docs', 'api.md');
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(target, 'utf8').replace(/\r\n/g, '\n'); } catch (_) { /* missing */ }
    if (have !== page) { console.error('docs/api.md differs from web/index.d.ts: run node scripts/make_api_doc.mjs'); process.exit(1); }
    console.log('docs/api.md is web/index.d.ts');
  } else {
    writeFileSync(target, page);
    console.log(`wrote docs/api.md: ${parse(read('web/index.d.ts')).decls.length} declarations`);
  }
}
