// <quranlab-consent> and <quranlab-sharing-settings>: the SDK's own sharing sheet and settings for
// the browser (SHARING_EXPERIENCE.md, PLATFORM_CLIENT.md section 9). Since 3.1.1 the sheet follows the design
// that the Apple and Android SDKs follow too (the contract's sharing_copy/design/README.md): a header with the
// emblem and the name Quran Lab, the title, the body, one card with what is shared, who receives it and how to
// stop, the hadith, the mistakes line, and a bar that does not scroll with two buttons of the same size. A bottom
// sheet on a narrow viewport, a centred card at most 480 px wide on a wide one.
//
// Themable with a `theme` (theme.js) or the CSS custom properties it sets (--ql-bg, --ql-fg, --ql-muted,
// --ql-accent, --ql-accent-fg, --ql-radius, --ql-font, --ql-title-font) and ::part(sheet|title|body|primary|
// secondary|guardian). Everything else is set inside the shadow root: the page's styles do not reach the
// sheet's type (size, weight, line height), and the sizes follow the browser's text size. Right to left from the
// deck's direction, keyboard and screen reader friendly (a modal <dialog>: focus moves in and stays in), two
// buttons of equal weight, nothing pre-ticked. An app's own wording (wording.js) is shown in place of the deck's
// strings it replaces.
//
//   import { QuranLabConsent } from '@quran-lab/tajweedformer';   // defines the elements
//   const yes = await QuranLabConsent.ask({ lang: 'ar', variant: 'first', guardian: false, theme: { accent: '#0b6e4f' } });

import { copyFor } from './copy.js';
import { applyTheme } from './theme.js';

/** The name at the top of the sheet: a constant of the SDK, not a deck string, in Latin letters in every
 * language (as the decks write it). No theme changes or hides it. */
export const SHEET_NAME = 'Quran Lab';

// The system's fonts: the page's --ql-font when it sets one, else these. The name is always in the system's
// Latin face.
const STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Naskh Arabic", "Helvetica Neue", Arial, sans-serif';
const LATIN = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// The design's colours (light, dark). Tint and soft tint are the accent over the sheet's background.
const LIGHT = { bg: '#FFFFFF', text: '#17171A', body: '#3D3D44', secondary: '#62626B', card: '#F4F4F6', divider: '#E4E4E9',
  bar: '#ECECF0', grabber: '#D4D4DA', off: '#C4C4CB', accent: '#0E6B58', onAccent: '#FFFFFF', tint: 11, soft: 6 };
const DARK = { bg: '#1C1C1E', text: '#F4F4F6', body: '#D2D2D8', secondary: '#A7A7B0', card: '#2A2A2D', divider: '#3B3B40',
  bar: '#2E2E32', grabber: '#48484D', off: '#5A5A60', accent: '#62D2B6', onAccent: '#0B0B0C', tint: 16, soft: 8 };
// When an app sets its own background or text colour, the card, the dividers, the grabber and the switch's track
// are its text colour over its background, by the share that gives the design's colours over the default ones.
const DERIVED = { light: { card: 0.045, divider: 0.115, bar: 0.08, grabber: 0.185, off: 0.25 },
  dark: { card: 0.065, divider: 0.145, bar: 0.08, grabber: 0.2, off: 0.3 } };

const tokens = (c) => `
  --_bg: var(--ql-bg, ${c.bg}); --_text: var(--ql-fg, ${c.text}); --_body: var(--ql-fg, ${c.body});
  --_secondary: var(--ql-muted, ${c.secondary}); --_card: ${c.card}; --_divider: ${c.divider}; --_bar-divider: ${c.bar};
  --_grabber: ${c.grabber}; --_switch-off: ${c.off}; --_accent: var(--ql-accent, ${c.accent});
  --_on-accent: var(--ql-accent-fg, ${c.onAccent});
  --_tint: color-mix(in srgb, var(--_accent) ${c.tint}%, var(--_bg));
  --_tint-soft: color-mix(in srgb, var(--_accent) ${c.soft}%, var(--_bg));
  --_on-tint: var(--_accent);`;

// Icons: the reference drawing's SVG paths. The row icons are drawn with a CSS mask in the accent, so that each
// disclosure row is the deck's text alone (one text for a screen reader; the icons are decoration).
const svgUrl = (inner, w = '1.8') => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='${w}' stroke-linecap='round' stroke-linejoin='round'>${inner}</svg>`)}")`;
const MIC = svgUrl("<rect x='9' y='3' width='6' height='11' rx='3'/><path d='M5.5 11.5a6.5 6.5 0 0 0 13 0'/><path d='M12 18v3'/>");
const SHIELD = svgUrl("<path d='M12 3l7 3v5.5c0 4.3-2.9 7.6-7 9.5-4.1-1.9-7-5.2-7-9.5V6l7-3z'/><path d='M9 12l2.2 2.2L15.2 10'/>");
const TOGGLE = svgUrl("<rect x='2.5' y='7' width='19' height='10' rx='5'/><circle cx='16.5' cy='12' r='2.4'/>");
const TOGGLE_RTL = svgUrl("<rect x='2.5' y='7' width='19' height='10' rx='5'/><circle cx='7.5' cy='12' r='2.4'/>");
const WAVE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" focusable="false"><path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 7v10"/><path d="M20 10v4"/></svg>';

// Sizes: em of the sheet's base, `font-size: medium` (the browser's own text size, which the learner sets; the
// page's root size never enters), so 1em = 16 px at the default size. Containers never set a font size, so every
// text's parent is at the base. Line heights are ratios of the design's numbers.
const em = (px) => `calc(${px}em / 16)`;

// The switch of the guardian's confirmation and of the settings: a checkbox with role="switch", drawn here.
const SWITCH = `
.switch { appearance: none; -webkit-appearance: none; flex: none; box-sizing: border-box; margin: 0; inline-size: 50px;
  block-size: 30px; border: 1px solid transparent; border-radius: 15px; cursor: pointer; vertical-align: middle;
  background: radial-gradient(circle 13px at 14px 50%, #FFFFFF 0 10.5px, rgb(0 0 0 / .18) 11.5px, transparent 13px) no-repeat, var(--_switch-off); }
.switch:checked { background: radial-gradient(circle 13px at calc(100% - 14px) 50%, #FFFFFF 0 10.5px, rgb(0 0 0 / .18) 11.5px, transparent 13px) no-repeat, var(--_accent); }
[dir="rtl"] .switch { background: radial-gradient(circle 13px at calc(100% - 14px) 50%, #FFFFFF 0 10.5px, rgb(0 0 0 / .18) 11.5px, transparent 13px) no-repeat, var(--_switch-off); }
[dir="rtl"] .switch:checked { background: radial-gradient(circle 13px at 14px 50%, #FFFFFF 0 10.5px, rgb(0 0 0 / .18) 11.5px, transparent 13px) no-repeat, var(--_accent); }
.switch:focus-visible { outline: 3px solid var(--_on-tint); outline-offset: 2px; }
@media (forced-colors: active) { .switch { appearance: auto; -webkit-appearance: auto; inline-size: 22px; block-size: 22px; } }`;

const RESET = `
:host { all: initial !important; }
*, *::before, *::after { box-sizing: border-box; }
p, h2, ul, li, figure { margin: 0; padding: 0; }`;

const STYLE = `${RESET}
dialog { ${tokens(LIGHT)}
  position: fixed; inset: auto 0 0 0; margin: 0; padding: 0; border: 0; outline: 1px solid transparent;
  inline-size: 100%; max-inline-size: 100%; block-size: auto; max-block-size: calc(100% - 24px);
  max-block-size: calc(100dvh - 24px - env(safe-area-inset-top, 0px));
  overflow: hidden; overscroll-behavior: contain; border-radius: var(--_r) var(--_r) 0 0;
  background: var(--_bg); color: var(--_text); box-shadow: 0 -10px 40px rgb(0 0 0 / .16);
  --_r: var(--ql-radius, 28px); --_font: var(--ql-font, ${STACK});
  font: 400 medium/normal var(--_font); letter-spacing: normal; word-spacing: normal; text-transform: none;
  text-align: start; text-indent: 0; text-shadow: none; white-space: normal; font-style: normal; visibility: visible;
  color-scheme: light; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
dialog[open] { display: flex; flex-direction: column; }
dialog::backdrop { background: rgb(0 0 0 / .45); }
@media (prefers-color-scheme: dark) { dialog { ${tokens(DARK)} color-scheme: dark; box-shadow: 0 -10px 40px rgb(0 0 0 / .5); } }

/* the grabber's band: the scrolling column begins below it, so nothing of the column is drawn in it */
.band { flex: none; padding-block: 8px; background: var(--_bg); }
.grab { inline-size: 36px; block-size: 5px; border-radius: 3px; margin: 0 auto; background: var(--_grabber); }
.wrap, .bar { font-family: var(--_font); font-size: medium; font-weight: 400; line-height: normal; font-style: normal;
  letter-spacing: normal; text-transform: none; color: var(--_text); visibility: visible; }
.wrap { position: relative; flex: 1 1 auto; min-block-size: 0; display: flex; flex-direction: column; }
.scroll { flex: 1 1 auto; min-block-size: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--_grabber) transparent; }
.fade { position: absolute; inset-inline-start: 0; inset-inline-end: var(--_sbw, 0px); pointer-events: none; }
.fade.b { inset-block-end: 0; block-size: 40px; background: linear-gradient(to bottom, transparent, var(--_bg)); }
.fade.t { inset-block-start: 0; block-size: 28px; background: linear-gradient(to top, transparent, var(--_bg)); opacity: 0; }
.wrap.at-end .fade.b { opacity: 0; }
.wrap.scrolled .fade.t { opacity: 1; }

/* 12 below the band's 8: the header stays 20 below the grabber, as drawn */
.col { display: flex; flex-direction: column; gap: 18px; padding: 12px 24px 22px; }
.top { display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; align-items: center; gap: 10px; }
.emblem { flex: none; display: flex; align-items: center; justify-content: center; inline-size: 40px; block-size: 40px;
  border-radius: calc(var(--_r) * 12 / 28); background: var(--_tint); color: var(--_on-tint); }
.emblem svg { display: block; inline-size: 22px; block-size: 22px; }
.name { display: inline-block; direction: ltr; unicode-bidi: isolate; font-family: ${LATIN}; font-size: ${em(15)};
  line-height: calc(20 / 15); font-weight: 600; font-style: normal; letter-spacing: -0.01em; text-transform: none;
  white-space: nowrap; color: var(--_text); opacity: 1; visibility: visible; outline: none; }
h2 { font-family: var(--ql-title-font, var(--_font)); font-size: ${em(26)}; line-height: calc(31 / 26); font-weight: 700;
  letter-spacing: 0; color: var(--_text); outline: none; }
#b { display: flex; flex-direction: column; gap: 18px; }
.body { font-size: ${em(15.5)}; line-height: calc(24 / 15.5); font-weight: 400; color: var(--_body); }
.card { list-style: none; padding: 2px 16px; background: var(--_card); border-radius: calc(var(--_r) * 18 / 28); }
.card li { position: relative; padding-block: 14px; padding-inline-start: 34px; font-size: ${em(14.5)}; line-height: calc(22 / 14.5);
  font-weight: 400; color: var(--_text); }
.card li + li { border-block-start: 1px solid var(--_divider); }
.card li::before { content: ""; position: absolute; inset-inline-start: 0; inset-block-start: 14px; inline-size: 22px;
  block-size: 22px; block-size: 1lh; background-color: var(--_on-tint);
  -webkit-mask: ${MIC} center / 22px 22px no-repeat; mask: ${MIC} center / 22px 22px no-repeat; }
.card li:nth-child(2)::before { -webkit-mask-image: ${SHIELD}; mask-image: ${SHIELD}; }
.card li:nth-child(3)::before { -webkit-mask-image: ${TOGGLE}; mask-image: ${TOGGLE}; }
[dir="rtl"] .card li:nth-child(3)::before { -webkit-mask-image: ${TOGGLE_RTL}; mask-image: ${TOGGLE_RTL}; }
.hadith { display: flex; flex-direction: column; gap: 10px; padding: 16px; background: var(--_tint-soft);
  border-radius: calc(var(--_r) * 18 / 28); }
.hadith .hq { font-size: ${em(15)}; line-height: calc(24 / 15); font-weight: 400; color: var(--_text); }
.hadith .ref { font-size: ${em(12)}; line-height: calc(16 / 12); font-weight: 600; color: var(--_secondary); }
.mistakes { font-size: ${em(15)}; line-height: calc(24 / 15); font-weight: 400; color: var(--_body); }
.guardian { display: flex; align-items: center; gap: 12px; padding: 16px; background: var(--_card);
  border-radius: calc(var(--_r) * 18 / 28); cursor: pointer; }
.guardian span { flex: 1 1 auto; min-inline-size: 0; font-size: ${em(14.5)}; line-height: calc(22 / 14.5); font-weight: 400; color: var(--_text); }
${SWITCH}

dialog[data-script="latin"] h2 { letter-spacing: -0.02em; }
dialog[data-script="latin"] .hadith .ref { text-transform: uppercase; letter-spacing: 0.06em; }
dialog[data-script="arabic"] h2 { line-height: calc(36 / 26); }
dialog[data-script="arabic"] .body { line-height: calc(27 / 15.5); }
dialog[data-script="arabic"] .mistakes { line-height: calc(27 / 15); }
dialog[data-script="arabic"] .card li, dialog[data-script="arabic"] .guardian span { line-height: calc(25 / 14.5); }
dialog[data-script="arabic"] .hadith .hq { line-height: calc(28 / 15); }

.bar { flex: none; display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: 1fr; gap: 10px;
  padding: 12px 24px max(30px, env(safe-area-inset-bottom, 0px)); border-block-start: 1px solid var(--_bar-divider);
  background: var(--_bg); }
button { appearance: none; -webkit-appearance: none; display: block; inline-size: 100%; min-block-size: 52px; margin: 0;
  padding: 15px 16px; border: 1px solid transparent; border-radius: calc(var(--_r) * 14 / 28); cursor: pointer;
  font-family: var(--_font); font-size: 1em; line-height: calc(20 / 16); font-weight: 600; font-style: normal;
  letter-spacing: normal; text-transform: none; text-align: center; white-space: normal; overflow-wrap: anywhere; }
button.primary { background-color: var(--_accent); color: var(--_on-accent); }
button.secondary { background-color: var(--_tint); color: var(--_on-tint); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
button:focus-visible { outline: 3px solid var(--_on-tint); outline-offset: 2px; }
@media (hover: hover) { button:not(:disabled):hover { background-image: linear-gradient(rgb(0 0 0 / .06), rgb(0 0 0 / .06)); } }

@media (min-width: 600px) {
  dialog { inset: 0; margin: auto; inline-size: calc(100% - 32px); max-inline-size: 480px; block-size: fit-content;
    max-block-size: calc(100% - 48px); border-radius: var(--_r); box-shadow: 0 24px 64px rgb(0 0 0 / .28); }
  .band { display: none; }
  .col { padding-block-start: 28px; }
}
@media (prefers-reduced-motion: no-preference) {
  dialog[open] { animation: ql-up 0.28s cubic-bezier(0.2, 0.8, 0.2, 1); }
  dialog[open]::backdrop { animation: ql-fade 0.28s ease-out; }
  .fade { transition: opacity 0.15s; }
  @media (min-width: 600px) { dialog[open] { animation-name: ql-pop; } }
}
@keyframes ql-up { from { transform: translateY(100%); } }
@keyframes ql-pop { from { opacity: 0; transform: scale(0.97); } }
@keyframes ql-fade { from { opacity: 0; } }
@media (forced-colors: active) { .card li::before { background-color: CanvasText; } }
`;

const SETTINGS_STYLE = `${RESET}
:host { display: block !important; }
section { ${tokens(LIGHT)}
  --_r: var(--ql-radius, 28px); --_font: var(--ql-font, ${STACK});
  display: block; padding: 4px 16px; border-radius: calc(var(--_r) * 18 / 28); background: var(--_bg); color: var(--_text);
  font: 400 medium/1.5 var(--_font); letter-spacing: normal; text-transform: none; text-align: start; font-style: normal;
  visibility: visible; color-scheme: light; }
@media (prefers-color-scheme: dark) { section { ${tokens(DARK)} color-scheme: dark; } }
section > * + * { border-block-start: 1px solid var(--_divider); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-block-size: 44px; padding-block: 10px; }
.row label, summary { font-size: ${em(15.5)}; line-height: calc(24 / 15.5); font-weight: 400; color: var(--_text); }
details { padding-block: 12px; }
summary { cursor: pointer; min-block-size: 24px; }
summary:focus-visible { outline: 3px solid var(--_on-tint); outline-offset: 2px; border-radius: 4px; }
details p { margin-block-start: 8px; font-size: ${em(14.5)}; line-height: calc(22 / 14.5); font-weight: 400; color: var(--_body); }
.muted { font-size: ${em(14.5)}; line-height: calc(22 / 14.5); color: var(--_secondary); }
#msg:empty { display: none; }
.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${em(14)}; line-height: 1.5;
  color: var(--_text); word-break: break-all; }
label.guardian { display: flex; gap: 12px; align-items: flex-start; padding-block: 12px; font-size: ${em(14.5)};
  line-height: calc(22 / 14.5); font-weight: 400; color: var(--_text); cursor: pointer; }
label.guardian input { flex: none; inline-size: 20px; block-size: 20px; margin: 1px 0 0; accent-color: var(--_accent); }
button { appearance: none; -webkit-appearance: none; min-block-size: 44px; margin: 0; padding: 11px 16px;
  border: 1px solid transparent; border-radius: calc(var(--_r) * 14 / 28); cursor: pointer; font-family: var(--_font);
  font-size: 1em; line-height: calc(20 / 16); font-weight: 600; letter-spacing: normal; text-transform: none;
  background-color: var(--_tint); color: var(--_on-tint); }
button:focus-visible, input:focus-visible { outline: 3px solid var(--_on-tint); outline-offset: 2px; }
section[data-script="arabic"] .row label, section[data-script="arabic"] summary { line-height: calc(27 / 15.5); }
section[data-script="arabic"] details p, section[data-script="arabic"] .muted, section[data-script="arabic"] label.guardian { line-height: calc(25 / 14.5); }
${SWITCH}
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Which type rules a deck's language takes: Arabic and Urdu (and the other Arabic-script languages) their line
// heights and no negative tracking; Latin scripts the title's tracking and the upper-case reference; any other
// script (Bengali, ...) is set as written.
const ARABIC = /^(ar|ur|fa|ps|sd|ug|ckb|ks)$/;
const LATIN_LANGS = /^(en|fr|id|ms|tr|de|es|it|nl|pt|sw|ha|so|uz|az|sq|bs|ca|cs|da|et|fi|fil|ga|gl|hr|hu|is|lt|lv|mt|nb|nn|no|pl|ro|sk|sl|sv|tl|vi|wo|yo|af|eu|cy)$/;
const scriptOf = (lang) => { const b = String(lang || '').toLowerCase().split(/[-_]/)[0]; return ARABIC.test(b) ? 'arabic' : LATIN_LANGS.test(b) ? 'latin' : 'other'; };

// ---- colours, computed in script when a sheet is shown (and again when the colour scheme changes)
const WHITE = [255, 255, 255, 1];
const NEAR_BLACK = [11, 11, 12, 1];
const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast of two opaque colours ([r, g, b] in 0..255). */
export function contrastRatio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const mix = (a, b, p) => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(1); // color-mix(in srgb, a p, b)
const over = (c, under) => (c[3] >= 1 ? c : mix(c, under, c[3]));
const hex = (c) => `#${c.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** A CSS colour as [r, g, b, alpha] in sRGB (any syntax the browser knows), or null. */
function parseColor(value, doc) {
  const v = String(value || '').trim();
  if (!v) return null;
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    const h = m[1].length <= 4 ? m[1].replace(/./g, (x) => x + x) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/i.exec(v);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4]];
  // anything else (a name, hsl(), oklch(), color-mix(), ...): a 2D canvas converts it to sRGB
  try {
    const c = doc.createElement('canvas');
    c.width = 1; c.height = 1;
    const x = c.getContext('2d', { willReadFrequently: true });
    if (!x) return null;
    x.fillStyle = '#010203';
    x.fillStyle = v;
    if (x.fillStyle === '#010203' && !/^#010203$/i.test(v)) return null; // not a colour
    x.clearRect(0, 0, 1, 1);
    x.fillRect(0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  } catch (_) { return null; }
}

// the properties paint() may set on the element it paints (cleared before each pass)
const PAINTED = ['--_tint', '--_tint-soft', '--_on-accent', '--_on-tint', '--_card', '--_divider', '--_bar-divider', '--_grabber', '--_switch-off'];

/**
 * The colour rules the stylesheet cannot express, for the element that carries the tokens (the sheet's dialog,
 * the settings' section): on-accent is white or near-black, whichever has the higher contrast with the accent
 * (unless the app sets --ql-accent-fg); when the accent as a label on the tint is under 4.5 to 1, the "Not now"
 * label and the icons take the text colour (the fill stays the tint); an app's own background or text colour
 * gives the card, the dividers and the grabber; where color-mix() is missing, the tints are set here.
 * Returns what it decided, or null where there is no browser.
 */
export function paintColors(el) {
  const doc = el && el.ownerDocument;
  const view = doc && doc.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function' || !el.style) return null;
  for (const p of PAINTED) el.style.removeProperty(p);
  const dark = !!(view.matchMedia && view.matchMedia('(prefers-color-scheme: dark)').matches);
  const D = dark ? DARK : LIGHT;
  const cs = view.getComputedStyle(el);
  const own = (p) => cs.getPropertyValue(p).trim() !== '';
  const read = (p, fallback) => parseColor(cs.getPropertyValue(p), doc) || parseColor(fallback, doc);
  const bg = over(read('--_bg', D.bg), dark ? [0, 0, 0, 1] : WHITE);
  const text = over(read('--_text', D.text), bg);
  const accent = over(read('--_accent', D.accent), bg);
  const tint = mix(accent, bg, D.tint / 100);
  const set = (p, v) => el.style.setProperty(p, v);
  const mixes = !!(view.CSS && typeof view.CSS.supports === 'function' && view.CSS.supports('color', 'color-mix(in srgb, red 50%, blue)'));
  if (!mixes) { set('--_tint', hex(tint)); set('--_tint-soft', hex(mix(accent, bg, D.soft / 100))); }
  let onAccent = null;
  if (!own('--ql-accent-fg')) {
    onAccent = contrastRatio(WHITE, accent) >= contrastRatio(NEAR_BLACK, accent) ? '#FFFFFF' : '#0B0B0C';
    set('--_on-accent', onAccent);
  }
  const accentOnTint = contrastRatio(accent, tint);
  const fallback = accentOnTint < 4.5;
  if (fallback) set('--_on-tint', 'var(--_text)');
  if (own('--ql-bg') || own('--ql-fg')) {
    const k = DERIVED[dark ? 'dark' : 'light'];
    set('--_card', hex(mix(text, bg, k.card))); set('--_divider', hex(mix(text, bg, k.divider)));
    set('--_bar-divider', hex(mix(text, bg, k.bar))); set('--_grabber', hex(mix(text, bg, k.grabber)));
    set('--_switch-off', hex(mix(text, bg, k.off)));
  }
  return { dark, accent: hex(accent), tint: hex(tint), onAccent, accentOnTint, fallback };
}

const Base = globalThis.HTMLElement || class {};

export class QuranLabConsent extends Base {
  /**
   * Show the sheet and resolve with the learner's answer (true = share). Dismissing (Escape) is "Not now".
   * @param {{ lang?: string, variant?: 'first'|'reask'|'version', guardian?: boolean, parent?: Element,
   *           wording?: Record<string, string>|null, theme?: object|null }} o
   * @returns {Promise<{ yes: boolean, guardianConfirmed: boolean }>}
   */
  static ask(o = {}) {
    const el = document.createElement('quranlab-consent');
    (o.parent || document.body).appendChild(el);
    return el.show(o).finally(() => el.remove());
  }

  show({ lang = (globalThis.navigator && navigator.language) || 'en', variant = 'first', guardian = false, wording = null, theme = null } = {}) {
    const c = copyFor(lang, wording);
    applyTheme(this, theme);
    const t = c.t;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    // the disclosure, whole and in this order; one text per row
    const lines = ['sheet.what', 'sheet.who', 'sheet.control'].map((k) => `<li>${esc(t(k))}</li>`).join('');
    // the hadith only when the deck says where it was verified
    const verified = !!(c.hadithSource && c.hadithSource.verified_at);
    const hadith = t('sheet.hadith') && verified
      ? `<div class="hadith"><p class="hq">${esc(t('sheet.hadith'))}</p><p class="ref">${esc(t('sheet.hadith_ref'))}</p></div>` : '';
    root.innerHTML = `<style>${STYLE}</style>
<dialog part="sheet" lang="${esc(c.lang)}" dir="${esc(c.dir)}" data-script="${scriptOf(c.lang)}" aria-labelledby="t" aria-describedby="b">
  <div class="band" aria-hidden="true"><div class="grab"></div></div>
  <div class="wrap">
    <div class="scroll">
      <div class="col">
        <div class="top">
          <div class="head"><span class="emblem" aria-hidden="true">${WAVE}</span><span class="name" id="n" dir="ltr" tabindex="-1">${SHEET_NAME}</span></div>
          <h2 id="t" part="title" tabindex="-1">${esc(t(guardian ? 'sheet.guardian.title' : 'sheet.title'))}</h2>
        </div>
        <div id="b" part="body">
          ${variant === 'reask' ? `<p class="body">${esc(t('reask'))}</p>` : ''}
          ${guardian ? `<p class="body" part="guardian">${esc(t('sheet.guardian.body'))}</p>` : `<p class="body">${esc(t('sheet.body'))}</p>`}
          <ul class="card">${lines}</ul>
          ${hadith}
          ${guardian ? '' : `<p class="mistakes">${esc(t('sheet.mistakes'))}</p>`}
        </div>
        ${guardian ? `<label class="guardian" for="g"><span>${esc(t('sheet.guardian.confirm'))}</span><input type="checkbox" role="switch" class="switch" id="g"></label>` : ''}
      </div>
    </div>
    <div class="fade t" aria-hidden="true"></div>
    <div class="fade b" aria-hidden="true"></div>
  </div>
  <div class="bar">
    <button type="button" class="primary" part="primary" id="yes" ${guardian ? 'disabled' : ''}>${esc(t(guardian ? 'sheet.guardian.share' : 'sheet.share'))}</button>
    <button type="button" class="secondary" part="secondary" id="no">${esc(t('sheet.not_now'))}</button>
  </div>
</dialog>`;
    const d = root.querySelector('dialog');
    const g = root.querySelector('#g');
    const yes = root.querySelector('#yes');
    if (g) g.addEventListener('change', () => { yes.disabled = !g.checked; });
    const live = this._live(d);
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => {
        if (answered) return;
        answered = true;
        if (live) live.stop();
        try { d.close(); } catch (_) { /* closed */ }
        resolve({ yes: v, guardianConfirmed: !!(g && g.checked) });
      };
      yes.addEventListener('click', () => done(true));
      root.querySelector('#no').addEventListener('click', () => done(false));
      d.addEventListener('close', () => done(false));
      d.addEventListener('cancel', () => done(false));
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
      if (live) live.start();
      // focus the name, the first thing of the sheet, not a button: neither choice is pre-selected
      root.querySelector('#n').focus();
    });
  }

  /** The parts that need a browser (colours, the fades of the scrolling column); null without one. */
  _live(d) {
    const view = this.ownerDocument && this.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function' || !d || typeof d.getBoundingClientRect !== 'function') return null;
    const root = this.shadowRoot;
    const wrap = root.querySelector('.wrap'), sc = root.querySelector('.scroll'), col = root.querySelector('.col');
    const edges = () => {
      const max = sc.scrollHeight - sc.clientHeight;
      wrap.classList.toggle('scrolled', sc.scrollTop > 1);
      wrap.classList.toggle('at-end', sc.scrollTop >= max - 1);
      wrap.style.setProperty('--_sbw', `${Math.max(0, sc.offsetWidth - sc.clientWidth)}px`);
    };
    const mq = view.matchMedia ? view.matchMedia('(prefers-color-scheme: dark)') : null;
    const repaint = () => { this._colors = paintColors(d); };
    let ro = null;
    return {
      start() {
        repaint();
        edges();
        sc.addEventListener('scroll', edges, { passive: true });
        if (typeof view.ResizeObserver === 'function') { ro = new view.ResizeObserver(edges); ro.observe(sc); ro.observe(col); }
        if (mq && mq.addEventListener) mq.addEventListener('change', repaint);
      },
      stop() {
        sc.removeEventListener('scroll', edges);
        if (ro) ro.disconnect();
        if (mq && mq.removeEventListener) mq.removeEventListener('change', repaint);
      },
    };
  }

  /** The one-time thank-you, as a small dismissable note. */
  static thank({ lang, parent, ms = 6000, wording = null, theme = null } = {}) {
    const c = copyFor(lang || (globalThis.navigator && navigator.language) || 'en', wording);
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.lang = c.lang; el.dir = c.dir;
    el.textContent = c.t('thanks');
    const view = document.defaultView || globalThis;
    const dark = !!(view.matchMedia && view.matchMedia('(prefers-color-scheme: dark)').matches);
    const D = dark ? DARK : LIGHT;
    // the same tokens as the sheet; set inline, so that no rule of the page changes its type
    el.style.cssText = `all:initial;display:block;box-sizing:border-box;position:fixed;inset-inline:16px;inset-block-end:max(16px, env(safe-area-inset-bottom, 0px));max-inline-size:480px;margin-inline:auto;padding:14px 18px;border-radius:calc(var(--ql-radius, 28px) * 14 / 28);background:var(--ql-accent, ${D.accent});color:var(--ql-accent-fg, ${D.onAccent});font:400 medium/1.5 var(--ql-font, ${STACK});letter-spacing:normal;text-transform:none;text-align:start;white-space:normal;visibility:visible;z-index:2147483647;box-shadow:0 10px 30px rgb(0 0 0 / .25)`;
    applyTheme(el, theme);
    (parent || document.body).appendChild(el);
    // on-accent: white or near-black, whichever reads better on the accent (unless the app sets --ql-accent-fg)
    try {
      const cs = view.getComputedStyle(el);
      if (!cs.getPropertyValue('--ql-accent-fg').trim()) {
        const a = parseColor(cs.backgroundColor, document);
        if (a) el.style.color = contrastRatio(WHITE, a) >= contrastRatio(NEAR_BLACK, a) ? '#FFFFFF' : '#0B0B0C';
      }
    } catch (_) { /* the inline default stays */ }
    setTimeout(() => el.remove(), ms);
    return el;
  }
}

/**
 * <quranlab-sharing-settings>: the switch, "What is shared", "Delete what I shared" and the
 * contribution code. Set `.client` to the app's TajweedClient.
 */
export class QuranLabSharingSettings extends Base {
  /** The app's TajweedClient: the settings read and change its sharing state. */
  set client(c) { this._client = c; this.controller = c && c._i ? c._i.ctl : null; }
  get client() { return this._client || null; }
  // SDK internals: the sharing controller behind the Client (web/consent/index.js)
  set controller(c) { this._c = c; this.render(); }
  get controller() { return this._c; }
  connectedCallback() { this.render(); }
  render() {
    if (!this._c) return;
    const c = copyFor(this.getAttribute('lang') || this._c.lang, this._c.wording || null);
    applyTheme(this, this._c.theme || null);
    const t = c.t;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    const on = this._c.state.sharing;
    const code = this._c.recoveryCode();
    root.innerHTML = `<style>${SETTINGS_STYLE}</style>
<section lang="${esc(c.lang)}" dir="${esc(c.dir)}" data-script="${scriptOf(c.lang)}">
  <div class="row"><label for="s">${esc(t('settings.toggle'))}</label>
    <input type="checkbox" role="switch" class="switch" id="s" ${on ? 'checked' : ''} aria-checked="${on}"></div>
  ${this._c.state.guardianVariant ? `<label class="guardian"><input type="checkbox" id="g"> <span>${esc(t('sheet.guardian.confirm'))}</span></label>` : ''}
  <details><summary>${esc(t('settings.what'))}</summary><p>${esc(t('what.detail'))}</p></details>
  ${code ? `<details id="rc"><summary>${esc(t('recovery.reveal'))}</summary><p class="code" id="code"></p><p class="muted">${esc(t('recovery.keep'))}</p><p class="muted">${esc(t('recovery.hint'))}</p></details>` : ''}
  <div class="row"><button class="secondary" id="del">${esc(t('settings.delete'))}</button></div>
  <p class="muted" id="msg" role="status"></p>
</section>`;
    const sec = root.querySelector('section');
    if (sec && this.ownerDocument && typeof sec.getBoundingClientRect === 'function') this._colors = paintColors(sec);
    const rc = root.querySelector('#rc');
    // the code is put in the page only when the learner opens it, never in the initial markup
    if (rc) rc.addEventListener('toggle', () => { root.querySelector('#code').textContent = rc.open ? this._c.recoveryCode() : ''; });
    const msg = root.querySelector('#msg');
    root.querySelector('#s').addEventListener('change', (e) => {
      const g = root.querySelector('#g');
      try { this._c.setSharing(e.target.checked, { guardianConfirmed: !!(g && g.checked) }); } catch (_) { e.target.checked = false; }
      this.render();
    });
    root.querySelector('#del').addEventListener('click', async () => {
      if (!globalThis.confirm || globalThis.confirm(t('delete.confirm'))) {
        const ok = await this._c.deleteShared().then(() => true, () => false);
        msg.textContent = ok ? t('delete.done') : t('delete.failed.network');
        if (ok) this.render();
      }
    });
  }
}

if (globalThis.customElements && !globalThis.customElements.get('quranlab-consent')) {
  globalThis.customElements.define('quranlab-consent', QuranLabConsent);
  globalThis.customElements.define('quranlab-sharing-settings', QuranLabSharingSettings);
}
