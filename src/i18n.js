// Interface language (Indonesian = source, English = translation). Code is never translated: the sketch editor,
// generated code, Serial/Bluetooth/FTDI terminals and build output keep their original text.
//
// Every user-visible Indonesian fragment of the app (catalog names, help, log messages, dialogs, server messages)
// is listed in i18n-en.json. Templated messages ("${id}: tidak mendapat daya ...") are stored as their static pieces,
// so a whole message is translated by replacing each known piece inside it, longest first.
import EN from './i18n-en.js';

const KEY = 'sim.lang';
export const LANG = (() => { try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'id'; } catch { return 'id'; } })();
export const isEn = LANG === 'en';

export function setLang(lang) {
  try { localStorage.setItem(KEY, lang); } catch { /* private mode: keep the current page */ }
  location.reload();
}

const LETTER = /[\p{L}\p{N}]/u;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let RE = null;
const MAP = new Map(Object.entries(EN));
function regex() {
  if (RE) return RE;
  const keys = [...MAP.keys()].sort((a, b) => b.length - a.length);
  // a piece that starts/ends with a letter must not be glued to another word ("di" inside "dipakai")
  const alt = keys.map((k) => (LETTER.test(k[0]) ? '(?<![\\p{L}\\p{N}_])' : '') + esc(k) + (LETTER.test(k.at(-1)) ? '(?![\\p{L}\\p{N}_])' : ''));
  RE = new RegExp(alt.join('|'), 'gu');
  return RE;
}

/** translate a UI string (no-op in Indonesian) */
export function tr(s) {
  if (!isEn || typeof s !== 'string' || !s || !/[a-z]{2}/i.test(s)) return s;
  const flat = s.includes('\n') || s.includes('  ') ? s.replace(/\s+/g, ' ') : s;
  const t = flat.trim();
  const hit = MAP.get(t);
  if (hit !== undefined) return flat.replace(t, () => hit);
  const out = flat.replace(regex(), (m) => MAP.get(m) ?? m);
  return out === flat ? s : out;
}

// ------------------------------------------------------------------ DOM translation
const SKIP = '#code, #hl, #serialOut, #btOut, #ftdiOut, #buildOut, #acCode, .gd-code, #nowOut, pre, code, textarea, script, style, [contenteditable], [data-noi18n]';
const ATTRS = ['title', 'placeholder', 'aria-label', 'data-tip', 'alt'];
const skipped = (el) => !el || !!el.closest?.(SKIP);

function textNode(n) {
  const p = n.parentElement;
  if (!p || skipped(p)) return;
  const v = n.data, t = tr(v);
  if (t === v) return;
  if (p.tagName === 'OPTION' && !p.hasAttribute('value')) p.setAttribute('value', p.textContent);   // keep the data value Indonesian
  n.data = t;
}
function attrs(el) {
  if (skipped(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a); if (!v) continue;
    const t = tr(v); if (t !== v) el.setAttribute(a, t);
  }
}
function walk(root) {
  if (root.nodeType === 3) { textNode(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) { if (skipped(root)) return; attrs(root); }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) textNode(n); else attrs(n); }
}

export function initI18n() {
  document.documentElement.lang = LANG;
  if (!isEn) return;
  document.title = tr(document.title);
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') textNode(m.target);
      else if (m.type === 'attributes') attrs(m.target);
      else for (const n of m.addedNodes) walk(n);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  // native dialogs
  for (const k of ['alert', 'confirm', 'prompt']) { const f = window[k].bind(window); window[k] = (msg, ...r) => f(tr(String(msg ?? '')), ...r); }
}
