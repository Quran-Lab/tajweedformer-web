// The look of the SDK's sharing sheets (consent, guardian, thanks, settings): the same theme keys as the Swift
// SDK's SharingTheme, set as CSS custom properties on each element (an app can also set the properties in its
// own CSS). A theme changes colours, corner radius and fonts, never the words or the consent version.

/** Theme key -> the CSS custom property it sets. */
export const THEME_PROPERTIES = Object.freeze({
  accent: '--ql-accent', accentText: '--ql-accent-fg', background: '--ql-bg', text: '--ql-fg', secondaryText: '--ql-muted',
  cornerRadius: '--ql-radius', titleFont: '--ql-title-font', bodyFont: '--ql-font',
});

/** A theme as CSS custom properties ({ '--ql-accent': '#2a3b8f', ... }); a number cornerRadius is in px. An
 * unknown key or a value that is not a plain CSS value throws a TypeError; null or {} is the default look. */
export function themeProperties(theme) {
  if (theme === null || theme === undefined) return {};
  if (typeof theme !== 'object' || Array.isArray(theme)) throw new TypeError('theme: an object');
  const out = {};
  for (const [k, v] of Object.entries(theme)) {
    if (!(k in THEME_PROPERTIES)) throw new TypeError(`theme: unknown key ${k} (${Object.keys(THEME_PROPERTIES).join(', ')})`);
    if (v === null || v === undefined || v === '') continue;
    if (k === 'cornerRadius' && typeof v === 'number') { out[THEME_PROPERTIES[k]] = `${v}px`; continue; }
    if (typeof v !== 'string' || /[;{}<>]/.test(v)) throw new TypeError(`theme: ${k} must be a CSS value`);
    out[THEME_PROPERTIES[k]] = v;
  }
  return out;
}

/** Sets a theme's properties on an element (its shadow tree inherits them). */
export function applyTheme(el, theme) {
  for (const [k, v] of Object.entries(themeProperties(theme))) el.style.setProperty(k, v);
  return el;
}
