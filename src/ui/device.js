// Layout modes: Laptop, iPad (tablet) and HP (phone).
//
// "Otomatis" picks the layout from the screen (width and touch). A mode can also be chosen by hand:
//  • a layout larger than the screen (Laptop on a phone) zooms the page out like "request desktop site",
//    by giving the viewport meta tag a fixed width;
//  • a layout smaller than the window (HP on a laptop) shows the app in a centred device-sized frame, handy for a
//    teacher who wants to preview what students see on their phones.
// CSS reads two attributes on <html>: data-device (laptop | tablet | phone) and data-w (xs < 600 ≤ s < 860 ≤ m < 1100 ≤ l),
// the width of the app itself, so the responsive rules also work inside the preview frame.

const KEY = 'sim.device';
const TARGET = { laptop: 1280, tablet: 1024, phone: 430 };          // layout width each mode is designed for (px)
export const DEVICE_NAMES = { auto: 'Otomatis', laptop: 'Laptop', tablet: 'iPad / tablet', phone: 'HP' };

const root = document.documentElement;
let mode = 'auto', listeners = [];

/** physical screen width in CSS px for the current orientation (not affected by our own viewport changes) */
function physWidth() {
  const a = screen.width || window.innerWidth, b = screen.height || window.innerHeight;
  return matchMedia('(orientation: landscape)').matches ? Math.max(a, b) : Math.min(a, b);
}
/** what "Otomatis" means on this device */
export function detectDevice() {
  const w = Math.min(physWidth(), window.innerWidth || 9999);
  const coarse = matchMedia('(pointer: coarse)').matches, hover = matchMedia('(hover: hover)').matches;
  if (w < 700) return 'phone';
  if (w < 1100 || (coarse && !hover)) return 'tablet';
  return 'laptop';
}
export const deviceMode = () => mode;
export const effectiveDevice = () => root.dataset.device || 'laptop';
export const appWidth = () => document.getElementById('app')?.clientWidth || window.innerWidth;
export const isPhone = () => effectiveDevice() === 'phone';
export const isNarrow = () => isPhone() || appWidth() <= 1100;
export const onDeviceChange = (f) => listeners.push(f);

function setViewport(width, phone) {
  const m = document.getElementById('metaViewport'); if (!m) return;
  // phone: maximum-scale stops iOS from zooming into the code editor when it gets focus (pinch zoom still works)
  const c = width ? `width=${width}, viewport-fit=cover` : `width=device-width, initial-scale=1${phone ? ', maximum-scale=1' : ''}, viewport-fit=cover`;
  if (m.getAttribute('content') !== c) m.setAttribute('content', c);
}
function widthClass() {
  const w = appWidth(), c = w < 600 ? 'xs' : w < 860 ? 's' : w < 1100 ? 'm' : 'l';
  if (root.dataset.w !== c) { root.dataset.w = c; return true; }
  return false;
}
function apply() {
  const dev = mode === 'auto' ? detectDevice() : mode;
  const changed = root.dataset.device !== dev;
  root.dataset.device = dev; root.dataset.devMode = mode;
  // forced layout wider than the physical screen: zoom out (Laptop/iPad layout on a phone)
  const needZoom = mode !== 'auto' && dev !== 'phone' && TARGET[dev] > physWidth() + 40;
  setViewport(needZoom ? TARGET[dev] : 0, dev === 'phone' && physWidth() < 700);
  // forced layout narrower than the window: centred frame
  const framed = mode !== 'auto' && dev !== 'laptop' && window.innerWidth > TARGET[dev] + 60;
  root.classList.toggle('framed', framed);
  root.style.setProperty('--frame-w', framed ? TARGET[dev] + 'px' : '100%');
  const wc = widthClass();
  if (changed || wc) for (const f of listeners) { try { f(dev); } catch (e) { console.error(e); } }
  syncMenu();
}
function syncMenu() {
  for (const b of document.querySelectorAll('[data-dev]')) b.classList.toggle('on', b.dataset.dev === mode);
  const icon = document.querySelector('#devIcon use'); if (icon) icon.setAttribute('href', '#i-dev-' + (mode === 'auto' ? 'auto' : mode));
  const btn = document.getElementById('btnDevice'); if (btn) btn.title = `Mode tampilan & bahasa · Language: ${DEVICE_NAMES[mode]}${mode === 'auto' ? ' (' + DEVICE_NAMES[effectiveDevice()] + ')' : ''}`;
  const ai = document.getElementById('devAutoInfo'); if (ai) ai.textContent = '· ' + DEVICE_NAMES[detectDevice()];
}
export function setDeviceMode(m) {
  mode = TARGET[m] ? m : 'auto';
  try { localStorage.setItem(KEY, mode); } catch { /* private mode */ }
  apply();
}
export function initDevice() {
  try { mode = localStorage.getItem(KEY) || 'auto'; } catch { mode = 'auto'; }
  if (mode !== 'auto' && !TARGET[mode]) mode = 'auto';
  apply();
  let t = 0;
  const re = () => { clearTimeout(t); t = setTimeout(apply, 60); };
  window.addEventListener('resize', re); window.addEventListener('orientationchange', re);
  const app = document.getElementById('app');
  if (app && 'ResizeObserver' in window) new ResizeObserver(() => { if (widthClass()) for (const f of listeners) { try { f(effectiveDevice()); } catch (e) { console.error(e); } } }).observe(app);
}
