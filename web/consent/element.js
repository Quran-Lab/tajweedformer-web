// <quranlab-consent> and <quranlab-sharing-settings>: the SDK's own sharing sheet and settings for
// the browser (SHARING_EXPERIENCE.md, PLATFORM_CLIENT.md section 9). Themable with a `theme` (theme.js) or
// the CSS custom properties it sets (--ql-bg, --ql-fg, --ql-muted, --ql-accent, --ql-accent-fg, --ql-radius,
// --ql-font, --ql-title-font) and ::part(sheet|title|body|primary|secondary|guardian), RTL from the deck's
// direction, keyboard and screen reader friendly (a modal <dialog>), two buttons of equal weight, nothing
// pre-ticked. An app's own wording (wording.js) is shown in place of the deck's strings it replaces.
//
//   import '@quran-lab/tajweedformer/consent';         // defines the elements
//   const yes = await QuranLabConsent.ask({ lang: 'ar', variant: 'first', guardian: false, theme: { accent: '#0b6e4f' } });

import { copyFor } from './copy.js';
import { applyTheme } from './theme.js';

const STYLE = `
:host { all: initial; }
dialog { box-sizing: border-box; max-inline-size: min(34rem, calc(100vw - 2rem)); inline-size: 100%; border: none;
  max-block-size: calc(100dvh - 2rem); overflow: auto; overscroll-behavior: contain;
  padding: 1.5rem; border-radius: var(--ql-radius, 16px); background: var(--ql-bg, #fdfcf8); color: var(--ql-fg, #1c1b19);
  font: 400 1rem/1.55 var(--ql-font, system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Naskh Arabic", sans-serif);
  box-shadow: 0 20px 60px rgb(0 0 0 / .25); }
dialog::backdrop { background: rgb(0 0 0 / .45); }

h2 { margin: 0 0 .75rem; font-size: 1.25rem; line-height: 1.3; font-weight: 650; font-family: var(--ql-title-font, inherit); }
p { margin: 0 0 .75rem; }
.muted { color: var(--ql-muted, inherit); opacity: .85; font-size: .95rem; }
ul { margin: 0 0 1rem; padding-inline-start: 1.1rem; }
li { margin-block-end: .35rem; }
label.guardian { display: flex; gap: .6rem; align-items: flex-start; margin: .5rem 0 1rem; font-weight: 600; }
label.guardian input { inline-size: 1.2rem; block-size: 1.2rem; margin: .15rem 0 0; accent-color: var(--ql-accent, #2a3b8f); }
.buttons { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
@media (max-width: 420px) { .buttons { grid-template-columns: 1fr; } }
button { font: inherit; font-weight: 600; min-block-size: 2.9rem; border-radius: calc(var(--ql-radius, 16px) * .6); cursor: pointer;
  padding: .6rem 1rem; border: 2px solid var(--ql-accent, #2a3b8f); }
button.primary { background: var(--ql-accent, #2a3b8f); color: var(--ql-accent-fg, #fff); }
button.secondary { background: transparent; color: inherit; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 3px solid var(--ql-accent, #2a3b8f); outline-offset: 2px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: .6rem 0; }
.code { font-family: ui-monospace, monospace; font-size: .85rem; word-break: break-all; }
@media (prefers-color-scheme: dark) {
  dialog { background: var(--ql-bg, #1c1b19); color: var(--ql-fg, #f3f1ea); }
  button { border-color: var(--ql-accent, #a9b6ff); }
  button.primary { background: var(--ql-accent, #a9b6ff); color: var(--ql-accent-fg, #10142e); }
  label.guardian input, button:focus-visible { accent-color: var(--ql-accent, #a9b6ff); outline-color: var(--ql-accent, #a9b6ff); }
}
h2:focus { outline: none; }
`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    const lines = (guardian ? ['sheet.what', 'sheet.who', 'sheet.control'] : ['sheet.mistakes', 'sheet.what', 'sheet.who', 'sheet.control'])
      .map((k) => `<li>${esc(t(k))}</li>`).join('');
    const hadith = t('sheet.hadith') ? `<p class="muted">${esc(t('sheet.hadith'))}<br><small>${esc(t('sheet.hadith_ref'))}</small></p>` : '';
    root.innerHTML = `<style>${STYLE}</style>
<dialog part="sheet" lang="${esc(c.lang)}" dir="${esc(c.dir)}" aria-labelledby="t" aria-describedby="b">
  <h2 id="t" part="title" tabindex="-1">${esc(t(guardian ? 'sheet.guardian.title' : 'sheet.title'))}</h2>
  <div id="b" part="body">
    ${guardian ? `<p part="guardian">${esc(t('sheet.guardian.body'))}</p>` : ''}
    ${variant === 'reask' ? `<p>${esc(t('reask'))}</p>` : ''}
    ${guardian ? '' : `<p>${esc(t('sheet.body'))}</p>`}
    ${hadith}
    <ul>${lines}</ul>
  </div>
  ${guardian ? `<label class="guardian"><input type="checkbox" id="g"> <span>${esc(t('sheet.guardian.confirm'))}</span></label>` : ''}
  <div class="buttons">
    <button class="primary" part="primary" id="yes" ${guardian ? 'disabled' : ''}>${esc(t(guardian ? 'sheet.guardian.share' : 'sheet.share'))}</button>
    <button class="secondary" part="secondary" id="no">${esc(t('sheet.not_now'))}</button>
  </div>
</dialog>`;
    const d = root.querySelector('dialog');
    const g = root.querySelector('#g');
    const yes = root.querySelector('#yes');
    if (g) g.addEventListener('change', () => { yes.disabled = !g.checked; });
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (answered) return; answered = true; try { d.close(); } catch (_) { /* closed */ } resolve({ yes: v, guardianConfirmed: !!(g && g.checked) }); };
      yes.addEventListener('click', () => done(true));
      root.querySelector('#no').addEventListener('click', () => done(false));
      d.addEventListener('close', () => done(false));
      d.addEventListener('cancel', () => done(false));
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
      // focus the title, not a button: neither choice is pre-selected
      root.querySelector('#t').focus();
    });
  }

  /** The one-time thank-you, as a small dismissable note. */
  static thank({ lang, parent, ms = 6000, wording = null, theme = null } = {}) {
    const c = copyFor(lang || (globalThis.navigator && navigator.language) || 'en', wording);
    const el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.lang = c.lang; el.dir = c.dir;
    el.textContent = c.t('thanks');
    el.style.cssText = 'position:fixed;inset-inline:1rem;inset-block-end:1rem;max-inline-size:32rem;margin-inline:auto;padding:1rem 1.25rem;border-radius:var(--ql-radius,14px);background:var(--ql-accent,#2a3b8f);color:var(--ql-accent-fg,#fff);font:500 1rem/1.5 var(--ql-font,system-ui,sans-serif);z-index:2147483647;box-shadow:0 10px 30px rgb(0 0 0 / .25)';
    applyTheme(el, theme);
    (parent || document.body).appendChild(el);
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
    root.innerHTML = `<style>${STYLE} :host{display:block} section{font:400 1rem/1.5 var(--ql-font,system-ui,sans-serif);color:inherit}</style>
<section lang="${esc(c.lang)}" dir="${esc(c.dir)}">
  <div class="row"><label for="s">${esc(t('settings.toggle'))}</label>
    <input type="checkbox" role="switch" id="s" ${on ? 'checked' : ''} aria-checked="${on}"></div>
  ${this._c.state.guardianVariant ? `<label class="guardian"><input type="checkbox" id="g"> <span>${esc(t('sheet.guardian.confirm'))}</span></label>` : ''}
  <details><summary>${esc(t('settings.what'))}</summary><p>${esc(t('what.detail'))}</p></details>
  ${code ? `<details id="rc"><summary>${esc(t('recovery.reveal'))}</summary><p class="code" id="code"></p><p class="muted">${esc(t('recovery.keep'))}</p><p class="muted">${esc(t('recovery.hint'))}</p></details>` : ''}
  <div class="row"><button class="secondary" id="del">${esc(t('settings.delete'))}</button></div>
  <p class="muted" id="msg" role="status"></p>
</section>`;
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
