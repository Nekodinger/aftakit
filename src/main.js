import '@wokwi/elements';
import './style.css';
import { registerParts } from './parts/index.js';
import { CATALOG, CATEGORIES, BY_TAG } from './catalog.js';
import { Simulator, IDLE_HEX } from './sim/sim.js';
import { checkDesign } from './sim/drc.js';
import { CircuitCanvas } from './ui/canvas.js';
import { Editor } from './ui/editor.js';
import { compile, loadSettings, saveSettings, testServer, compileEndpoint, parseDiagnostics } from './compile.js';
import { saveProject, loadProject, sharingAvailable } from './store.js';
import { EXAMPLES, exampleModel, EXAMPLE_GROUPS } from './examples/defs.js';
import { exampleHexText, hasExampleHex } from './examples/pack.js';

registerParts();
const $ = (s) => document.querySelector(s);

// Reliable taps on iPad: fire the button on touch pointerup (no 300 ms delay, works even when the browser
// drops the synthetic click after a long-press/pinch gesture) and swallow the duplicate click that may follow.
(() => {
  let down = null;
  document.addEventListener('pointerdown', (e) => { down = e.pointerType === 'touch' ? { btn: e.target.closest?.('button'), x: e.clientX, y: e.clientY } : null; }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || e.pointerType !== 'touch' || !d.btn || d.btn.disabled || d.btn.closest('#viewport')) return;
    if (e.target.closest?.('button') !== d.btn || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
    d.btn._tapTs = performance.now(); d.btn.click();
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button');
    if (b && e.isTrusted && b._tapTs && performance.now() - b._tapTs < 800) { e.stopImmediatePropagation(); e.preventDefault(); b._tapTs = 0; }
  }, true);
})();
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isNarrow = () => window.matchMedia('(max-width: 1100px)').matches;
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

const DEFAULT_CODE = `void setup() {\n  // jalankan sekali\n}\n\nvoid loop() {\n  // diulang terus-menerus\n}\n`;
const state = { exampleId: null, projectId: null, hex: null, hexFor: null, hexOnly: false, busy: false, mode: 'design', panel: 'parts' };

// ------------------------------------------------------------------ toast
let toastT;
function toast(text, err = false) { const t = $('#toast'); t.textContent = text; t.classList.toggle('err', err); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600); }

// ------------------------------------------------------------------ core objects
const sim = new Simulator();
const canvas = new CircuitCanvas({
  viewport: $('#viewport'), world: $('#world'), wiresSvg: $('#wires'), partsHost: $('#parts'), pinLayer: $('#pinLayer'),
  emptyHint: $('#emptyHint'), zoomLabel: $('#zoomLabel'), wireHint: $('#wireHint'),
});
const editor = new Editor({ ta: $('#code'), hl: $('#hl'), gutter: $('#gutter'), pos: $('#cursorPos'), onChange: () => setCompilerState(''), onRun: () => run() });
editor.value = DEFAULT_CODE;
canvas.on('toast', ({ text, err }) => toast(text, err));
canvas.on('change', ({ structural }) => {
  if (structural && sim.running) stopSim('Rangkaian diubah — simulasi dihentikan.');
  if (state.panel === 'props') renderProps();
  updateBoardInfo(); scheduleCheck();
});
canvas.on('select', (s) => {
  const part = s?.kind === 'part';
  for (const id of ['#tbRotL', '#tbRotR', '#tbDup']) $(id).disabled = !part;
  $('#tbDel').disabled = !s;
  if (state.panel === 'props' || (state.mode === 'simulate' && s && !isNarrow())) showPanel('props', true);
});
canvas.on('attrs', () => { if (state.panel === 'props') renderProps(true); });
canvas.on('history', ({ canUndo, canRedo }) => { $('#tbUndo').disabled = !canUndo; $('#tbRedo').disabled = !canRedo; });
sim.on('attrs', () => { if (state.panel === 'props') renderProps(true); });

// ------------------------------------------------------------------ log
let errCount = 0;
function addLog(level, text, extra = {}) {
  const el = document.createElement('div'); el.className = 'log ' + level;
  const ico = { error: '✕', warn: '!', info: 'i', ok: '✓' }[level] || 'i';
  const t = extra.t != null ? extra.t.toFixed(2) + 's' : '';
  let msg = esc(text);
  if (extra.line) msg = `<a class="jump" data-line="${extra.line}" data-col="${extra.col || 1}">sketch.ino:${extra.line}</a> ${esc(extra.msg ?? text)}`;
  el.innerHTML = `<span class="ico">${ico}</span><span class="t">${t}</span><span class="msg">${msg}${extra.fix ? `<span class="fix">${esc(extra.fix)}</span>` : ''}</span>`;
  const list = $('#logList'); list.append(el); list.scrollTop = list.scrollHeight;
  while (list.children.length > 400) list.firstChild.remove();
  if (level === 'error') { errCount++; const b = $('#logBadge'); b.hidden = false; b.textContent = errCount; if ($('#console').classList.contains('collapsed')) $('#console').classList.remove('collapsed'); }
}
$('#logList').addEventListener('click', (e) => { const a = e.target.closest('a.jump'); if (a) { setMode('code'); editor.goto(+a.dataset.line, +a.dataset.col); } });
$('#logClear').onclick = () => { if (consoleTab === 'serial') { serialText = ''; $('#serialOut').textContent = ''; } else { $('#logList').textContent = ''; errCount = 0; $('#logBadge').hidden = true; } };
$('#consoleToggle').onclick = () => { $('#console').classList.toggle('collapsed'); requestAnimationFrame(() => canvas._applyView()); };
sim.on('log', (l) => addLog(l.level, l.text, { t: l.t }));

// gcc reports a missing ';' at the NEXT token (often the next line); point at the line that really lacks it
function fixMissingSemicolon(d, code) {
  if (!/expected [‘'"]?;[’'"]? before/.test(d.message)) return d;
  const lines = code.split('\n'); const cur = lines[d.line - 1] || '';
  if (cur.slice(0, Math.max(0, d.col - 1)).trim() !== '') return d;
  let k = d.line - 2; while (k >= 0 && !lines[k].replace(/\/\/.*$/, '').trim()) k--;
  if (k < 0) return d;
  const prev = lines[k].replace(/\/\/.*$/, '').trimEnd();
  if (/[;{}]$/.test(prev)) return d;
  return { ...d, line: k + 1, col: prev.length + 1, message: d.message + ' (titik koma kurang di akhir baris ini)' };
}

function hintFor(msg) {
  if (/was not declared in this scope/.test(msg)) return 'Periksa ejaan nama, atau deklarasikan variabel/fungsi sebelum dipakai.';
  if (/titik koma kurang di akhir baris ini/.test(msg)) return 'Tambahkan titik koma (;) di akhir baris ini.';
  if (/expected [‘'“]?;/.test(msg)) return 'Kemungkinan titik koma (;) kurang di akhir baris sebelumnya (kompilator menunjuk token berikutnya).';
  if (/No such file or directory|fatal error:/.test(msg)) return 'Library tidak tersedia. Tersedia: Servo, LiquidCrystal, LiquidCrystal_I2C, Adafruit_NeoPixel, Adafruit_SSD1306 + GFX, DHT, RTClib, Wire, SPI, EEPROM, SoftwareSerial.';
  if (/undefined reference to .(setup|loop)/.test(msg)) return 'Sketch harus punya fungsi void setup() dan void loop().';
  if (/expected [‘']\}|expected declaration/.test(msg)) return 'Kurung kurawal { } tidak seimbang.';
  return '';
}

// ------------------------------------------------------------------ console tabs + serial
let consoleTab = 'log';
function showConsole(name) {
  consoleTab = name;
  $$('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  $('#logList').hidden = name !== 'log'; $('#serialPane').hidden = name !== 'serial';
  if (name === 'serial') $('#serialBadge').hidden = true;
}
$$('[data-tab]').forEach((b) => (b.onclick = () => { showConsole(b.dataset.tab); $('#console').classList.remove('collapsed'); }));
const serialOut = $('#serialOut'); let serialText = '';
sim.on('serial', (b) => {
  serialText += b === 13 ? '' : String.fromCharCode(b);
  if (serialText.length > 30000) serialText = serialText.slice(-20000);
  serialOut.textContent = serialText; serialOut.scrollTop = serialOut.scrollHeight;
  if (consoleTab !== 'serial') $('#serialBadge').hidden = false;
});
$('#serialForm').onsubmit = (e) => { e.preventDefault(); const i = $('#serialIn'); if (!sim.running) { toast('Jalankan simulasi dulu untuk mengirim data serial.', true); return; } sim.serialWrite(i.value + $('#serialEol').value.replace('\\n', '\n').replace('\\r', '\r')); i.value = ''; };

// ------------------------------------------------------------------ modes & panels
function setMode(m) {
  state.mode = m; $('#workspace').dataset.mode = m;
  $$('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (m === 'code') requestAnimationFrame(() => editor._sync());
  if (m === 'simulate') { $('#console').classList.remove('collapsed'); if (!isNarrow()) showPanel('props', true); }
  if (m === 'design' && !isNarrow() && state.panel === 'props' && !canvas.selected) showPanel('parts', true);
  if (m === 'build') updateBuildView();
  if (m === 'design' || m === 'simulate') requestAnimationFrame(() => { canvas._applyView(); if (!state.fittedOnce) { canvas.fit(); state.fittedOnce = true; } });
}
$$('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
function showPanel(name, force) {
  const ws = $('#workspace');
  const closed = ws.classList.contains('lp-closed');
  if (!force && name === state.panel && !closed) { ws.classList.add('lp-closed'); $$('.rail-btn').forEach((b) => b.classList.remove('on')); requestAnimationFrame(() => canvas._applyView()); return; }
  state.panel = name; ws.classList.remove('lp-closed');
  if (state.mode === 'code' || state.mode === 'build') setMode('design');
  $$('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $$('.lp').forEach((s) => (s.hidden = s.dataset.lp !== name));
  if (name === 'props') renderProps();
  if (name === 'check') runCheck();
  requestAnimationFrame(() => canvas._applyView());
}
$$('.rail-btn').forEach((b) => (b.onclick = () => showPanel(b.dataset.panel)));
$('#lpClose').onclick = () => { $('#workspace').classList.add('lp-closed'); $$('.rail-btn').forEach((b) => b.classList.remove('on')); };
if (isNarrow()) $('#workspace').classList.add('lp-closed');

// ------------------------------------------------------------------ status
function setStatus(kind, text) { $('#simDot').className = 'dot ' + (kind || ''); $('#simText').textContent = text; }
function setCompilerState(t) { $('#compilerState').textContent = t; }
function boardOf() { const p = [...canvas.parts.values()].find((x) => BY_TAG[x.type]?.board); return p ? { part: p, cat: BY_TAG[p.type], runnable: BY_TAG[p.type].sim === 'full' } : null; }
function updateBoardInfo() {
  const b = boardOf();
  const txt = !b ? '· tanpa mikrokontroler (rangkaian listrik saja)' : b.runnable ? `· ${b.cat.name} · kode dijalankan` : `· ${b.cat.name} · mode desain (kode tidak dijalankan)`;
  $('#boardInfo').textContent = txt;
  $('#boardTarget').textContent = b ? `Target: ${b.cat.name}${b.runnable ? '' : ' — hanya bisa dikompilasi & diunggah lewat Arduino IDE'}` : 'Tanpa board';
}
sim.on('state', (s) => {
  const r = s === 'running'; const b = boardOf();
  setStatus(r ? (b && !b.runnable ? 'design' : 'run') : '', r ? 'Berjalan' : 'Berhenti');
  $('#btnRun').disabled = false; $('#btnStop').disabled = !r; canvas.interactive = r;
  document.body.classList.toggle('is-running', r);
});
sim.on('tick', ({ time }) => {
  if (state.boardEl) { const b = sim.board; try { state.boardEl.led13 = !!b.pins['13']?.level; state.boardEl.ledPower = true; } catch { /* no led props */ } }
  if (sim.running) $('#simText').textContent = `Berjalan · ${time.toFixed(1)} s`;
});
function stopSim(msg) { if (sim.running) { sim.stop(); if (msg) addLog('info', msg); } }

// ------------------------------------------------------------------ design-rule check
let checkT;
function scheduleCheck() { clearTimeout(checkT); checkT = setTimeout(() => runCheck(false), 700); }
function runCheck(toLog = false) {
  const res = checkDesign(canvas.simModel(), canvas.elements());
  const list = $('#checkList');
  list.innerHTML = res.length ? res.map((r) => `<div class="chk ${r.level}"><span class="ic">${{ error: '✕', warn: '!', info: 'i', ok: '✓' }[r.level]}</span><span>${esc(r.text)}</span></div>`).join('') : '<div class="prop-empty">Belum ada komponen.</div>';
  const worst = res.some((r) => r.level === 'error') ? 'error' : res.some((r) => r.level === 'warn') ? 'warn' : res.some((r) => r.level === 'ok') ? 'ok' : '';
  const badge = $('#checkBadge'); badge.hidden = !worst || worst === 'ok'; badge.className = 'rail-badge ' + (worst === 'warn' ? 'warn' : '');
  if (toLog) for (const r of res.filter((x) => x.level !== 'info')) addLog(r.level === 'ok' ? 'ok' : r.level, 'Cek rangkaian: ' + r.text);
  return res;
}
$('#btnCheck').onclick = () => { runCheck(); toast('Pemeriksaan selesai.'); };
$('#tbCheck').onclick = () => showPanel('check', true);

// ------------------------------------------------------------------ run pipeline
async function doCompile() {
  const b = boardOf();
  if (b && !b.runnable) {
    const msg = `${b.cat.name} memakai inti ${b.cat.mcu}. Simulator ini hanya menjalankan kode ATmega328P (Uno/Nano). Unduh kode (.ino) lalu kompilasi & unggah dengan Arduino IDE (pilih board ${b.cat.mcu}).`;
    $('#buildOut').textContent = msg; addLog('info', msg); setCompilerState('Tidak dikompilasi'); return false;
  }
  const code = editor.value;
  setCompilerState('Mengompilasi…');
  const exd = state.exampleId && EXAMPLES.find((e) => e.id === state.exampleId), pk = exd ? await exampleHexText(exd.id) : null, pre = pk ? { code: exd.code, ...pk } : null;
  const res = await compile(code, { precompiled: pre });
  $('#buildOut').textContent = [res.stdout, res.stderr].filter(Boolean).join('\n') || '(tidak ada keluaran)';
  const diags = (res.diagnostics?.length ? res.diagnostics : parseDiagnostics(res.stderr)).map((d) => fixMissingSemicolon(d, code));
  editor.setMarks(diags);
  if (!res.ok) {
    errCount = 0;
    if (diags.length) for (const d of diags) addLog(d.severity === 'warn' ? 'warn' : 'error', d.message, { line: d.line, col: d.col, msg: d.message, fix: hintFor(d.message) });
    else addLog('error', res.error || 'Kompilasi gagal.');
    addLog('error', `Kompilasi gagal${diags.length ? ` (${diags.filter((d) => d.severity === 'error').length} galat)` : ''}. Simulasi tidak dijalankan.`);
    setCompilerState('Gagal'); setStatus('err', 'Kompilasi gagal'); showConsole('log');
    return false;
  }
  for (const d of diags) addLog('warn', d.message, { line: d.line, col: d.col, msg: d.message });
  state.hex = res.hex; state.hexFor = code; state.hexOnly = false;
  const size = (res.stdout || '').split('\n').find((l) => /Sketch uses/.test(l));
  addLog('ok', `Kompilasi berhasil (${res.source}).${size ? ' ' + size : ''}`);
  setCompilerState('Siap · ' + res.source);
  return true;
}

function buildSim(hex) {
  stopSim();
  const model = canvas.simModel();
  const b = boardOf(); state.boardEl = b?.runnable ? b.part.el : null;
  const diag = sim.build(model, canvas.elements());
  if (diag.errors.length) { for (const e of diag.errors) addLog('error', e); setStatus('err', 'Rangkaian bermasalah'); return false; }
  sim.loadHex(hex);
  return true;
}

async function run() {
  if (state.busy) return; state.busy = true; $('#btnRun').disabled = true;
  try {
    if (state.mode !== 'simulate') setMode('simulate');
    const b = boardOf();
    if (b?.runnable || state.hexOnly) {
      if (!state.hexOnly && (state.hexFor !== editor.value || !state.hex)) { if (!(await doCompile())) return; }
      if (!state.hex) { addLog('error', 'Belum ada program.'); return; }
      if (!buildSim(state.hex)) return;
      serialText = ''; serialOut.textContent = '';
      sim.start(); addLog('info', 'Simulasi dimulai.');
    } else {
      const res = runCheck(true);
      if (b) addLog('info', `${b.cat.name}: mode desain. Daya, sensor, saklar, relay, dan motor disimulasikan; pin GPIO tidak dikendalikan karena kode ${b.cat.mcu} tidak dapat dijalankan di sini.`);
      else addLog('info', 'Tanpa mikrokontroler: rangkaian dijalankan sebagai rangkaian listrik (baterai, saklar, LED, relay, motor).');
      if (res.some((r) => r.level === 'error')) addLog('error', 'Ada kesalahan rangkaian. Lihat panel Periksa.');
      if (!buildSim(IDLE_HEX)) return;
      sim.start();
    }
  } catch (e) { addLog('error', e.message); setStatus('err', 'Galat'); console.error(e); }
  finally { state.busy = false; $('#btnRun').disabled = false; }
}
$('#btnRun').onclick = run; $('#btnRun2').onclick = run;
$('#btnStop').onclick = () => stopSim('Simulasi dihentikan.');
$('#btnReset').onclick = () => {
  const b = boardOf();
  const hex = b?.runnable || state.hexOnly ? state.hex : IDLE_HEX;
  if (!hex) { toast('Belum ada program untuk di-reset.', true); return; }
  const was = sim.running; if (buildSim(hex)) { serialText = ''; serialOut.textContent = ''; addLog('info', 'Program dimulai ulang dari awal.'); if (was) sim.start(); else { sim.advance(0); setStatus('', 'Berhenti'); } }
};
$('#btnCompile').onclick = async () => { if (state.busy) return; state.busy = true; try { await doCompile(); } finally { state.busy = false; } };
$('#bCompile').onclick = async () => { if (state.busy) return; state.busy = true; try { await doCompile(); updateBuildView(); } finally { state.busy = false; } };
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

// ------------------------------------------------------------------ canvas toolbar
$('#tbUndo').onclick = () => canvas.undo(); $('#tbRedo').onclick = () => canvas.redo();
$('#tbRotL').onclick = () => canvas.rotateSelected(-1); $('#tbRotR').onclick = () => canvas.rotateSelected(1);
$('#tbDup').onclick = () => { if (canvas.selected?.kind === 'part') canvas.duplicate(canvas.selected.id); };
$('#tbDel').onclick = () => canvas.deleteSelected();
$('#tbGrid').onclick = () => { canvas.snap = canvas.snap === 5 ? 1 : 5; $('#tbGrid').classList.toggle('on', canvas.snap === 5); toast(canvas.snap === 5 ? 'Jepret ke grid aktif' : 'Jepret ke grid nonaktif'); };
$('#zoomIn').onclick = () => canvas.zoomAt(1.2); $('#zoomOut').onclick = () => canvas.zoomAt(1 / 1.2); $('#zoomFit').onclick = () => canvas.fit();
for (const id of ['#tbRotL', '#tbRotR', '#tbDup', '#tbDel']) $(id).disabled = true;
window.addEventListener('resize', () => canvas._applyView());

// ------------------------------------------------------------------ palette (cards with live thumbnails, tap or drag to add)
let partFilter = 'all', partCat = 'Semua';
const chips = $('#catChips');
chips.innerHTML = ['Semua', ...CATEGORIES].map((c) => `<button class="chip${c === 'Semua' ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
chips.onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; partCat = b.dataset.c; chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); renderPalette(); };
$('#partFilter').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; partFilter = b.dataset.f; $$('#partFilter button').forEach((x) => x.classList.toggle('on', x === b)); renderPalette(); };
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue; const box = en.target; thumbObserver.unobserve(box);
    const el = document.createElement(box.dataset.tag); const cat = BY_TAG[box.dataset.tag];
    el.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.2);transform-origin:center';
    if (box.dataset.tag === 'wokwi-led-ring') el.pixels = 12;
    for (const p of cat?.props || []) if (!cat.module && p.key in el && p.type !== 'range') { try { el[p.key] = p.def; } catch { /* ignore */ } }
    box.style.position = 'relative'; box.append(el);
    Promise.resolve(el.updateComplete).then(() => requestAnimationFrame(() => {
      const w = el.offsetWidth || 60, h = el.offsetHeight || 40; const s = Math.min(70 / w, 54 / h, 1.4);
      el.style.transform = `translate(-50%,-50%) scale(${s})`;
    }));
  }
}, { root: $('#partList'), rootMargin: '200px' });
function renderPalette() {
  const q = $('#partSearch').value.trim().toLowerCase(), host = $('#partList'); host.textContent = ''; let n = 0;
  for (const cat of CATEGORIES) {
    if (partCat !== 'Semua' && cat !== partCat) continue;
    const items = CATALOG.filter((c) => c.cat === cat && (partFilter === 'all' || c.sim === 'full') && (!q || (c.name + ' ' + c.tag + ' ' + (c.keywords || '')).toLowerCase().includes(q)));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = `${cat} · ${items.length}`; host.append(h);
    const grid = document.createElement('div'); grid.className = 'grid'; host.append(grid);
    for (const c of items) {
      n++;
      const card = document.createElement('div'); card.className = 'card'; card.dataset.tag = c.tag; card.title = c.name;
      const tag = c.sim === 'full' ? ['sim', 'SIM'] : c.sim === 'design' ? ['design', 'DESAIN'] : ['visual', 'GAMBAR'];
      card.innerHTML = `<span class="tag ${tag[0]}">${tag[1]}</span><div class="thumb" data-tag="${c.tag}"></div><span class="nm">${esc(c.name)}</span>`;
      grid.append(card); thumbObserver.observe(card.querySelector('.thumb'));
      bindCard(card, c);
    }
  }
  if (!n) host.innerHTML = '<div class="prop-empty">Tidak ada komponen yang cocok.</div>';
  $('#partCount').textContent = `${CATALOG.length} komponen · ${CATALOG.filter((c) => c.sim === 'full').length} disimulasikan · SIM = disimulasikan, DESAIN = cek kabel, GAMBAR = tampilan`;
}
function bindCard(card, c) {
  let st = null; const ghost = $('#dragGhost');
  const endDrag = () => { ghost.hidden = true; if (st?.timer) clearTimeout(st.timer); st = null; };
  card.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    st = { x: e.clientX, y: e.clientY, t: Date.now(), drag: false, touch: e.pointerType !== 'mouse', id: e.pointerId };
    if (st.touch) st.timer = setTimeout(() => { if (st && !st.moved) { st.drag = true; ghost.textContent = '+ ' + c.name; ghost.hidden = false; ghost.style.left = st.x + 'px'; ghost.style.top = st.y + 'px'; navigator.vibrate?.(10); } }, 260);
  });
  card.addEventListener('pointermove', (e) => {
    if (!st) return; const d = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (!st.drag && !st.touch && d > 6) { st.drag = true; ghost.textContent = '+ ' + c.name; ghost.hidden = false; card.setPointerCapture(e.pointerId); }
    if (!st.drag && st.touch && d > 8) { st.moved = true; clearTimeout(st.timer); }
    if (st.drag) { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; }
  });
  card.addEventListener('touchmove', (e) => { if (st?.drag) e.preventDefault(); }, { passive: false });
  card.addEventListener('pointerup', (e) => {
    if (!st) return; const s = st; endDrag();
    if (s.drag) {
      const r = $('#viewport').getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && state.mode !== 'code') {
        const w = canvas.toWorld(e.clientX, e.clientY); addPart(c.tag, w.x - 20, w.y - 20);
      }
    } else if (!s.moved && Date.now() - s.t < 600) addAtCenter(c.tag);
  });
  card.addEventListener('pointercancel', endDrag);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
}
async function addPart(tag, x, y) {
  if (state.mode !== 'design' && state.mode !== 'simulate') setMode('design');
  const id = await canvas.addPart(tag, Math.round(x / 5) * 5, Math.round(y / 5) * 5);
  if (id && isNarrow()) $('#workspace').classList.add('lp-closed'), $$('.rail-btn').forEach((b) => b.classList.remove('on'));
  if (id) toast(`${BY_TAG[tag].name} ditambahkan (${id})`);
}
function addAtCenter(tag) {
  if (state.mode !== 'design' && state.mode !== 'simulate') setMode('design');
  const r = $('#viewport').getBoundingClientRect(), c = canvas.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  // look for a free spot near the centre (spiral search) so new parts don't land on top of the board
  const boxes = [...canvas.parts.values()].filter((p) => !BY_TAG[p.type]?.breadboard).map((p) => [p.left - 15, p.top - 25, p.left + p.size[0] + 15, p.top + p.size[1] + 15]);
  const est = 90; let best = [c.x - 40, c.y - 40];
  search: for (let ring = 0; ring < 14; ring++) {
    const steps = Math.max(1, ring * 8);
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2, x = c.x - 40 + Math.cos(a) * ring * 45, y = c.y - 40 + Math.sin(a) * ring * 45;
      if (!boxes.some(([x0, y0, x1, y1]) => x < x1 && x + est > x0 && y < y1 && y + est > y0)) { best = [x, y]; break search; }
    }
  }
  addPart(tag, best[0], best[1]);
}
$('#partSearch').addEventListener('input', () => renderPalette());

// ------------------------------------------------------------------ properties
const HINTS = {
  'wokwi-gas-sensor': 'DO aktif LOW: LOW saat gas melewati ambang.', 'wokwi-flame-sensor': 'DO aktif LOW saat api terdeteksi.',
  'wokwi-big-sound-sensor': 'DO aktif HIGH saat suara melewati ambang.', 'wokwi-hc-sr04': 'Atur jarak objek. Baca dengan pulseIn(ECHO, HIGH) / 58.',
  'wokwi-photoresistor-sensor': 'Cahaya terang = tegangan AO lebih tinggi; DO HIGH saat ≥ 50%.', 'wokwi-ntc-temperature-sensor': 'Gunakan persamaan Beta (B=3950) untuk mengubah ADC ke °C.',
  'wokwi-potentiometer': 'Putar knob di kanvas saat simulasi, atau geser nilai di sini.', 'wokwi-pushbutton': 'Ketuk/tekan tombol di kanvas saat simulasi berjalan.',
  'wokwi-dht22': 'Gunakan library DHT (Adafruit): DHT dht(pin, DHT22). Baca paling cepat tiap 2 detik.', 'mod-dht11': 'DHT dht(pin, DHT11). Baca paling cepat tiap 2 detik.',
  'wokwi-mpu6050': 'I2C alamat 0x68 (AD0 ke 5V = 0x69). Uno: SDA = A4, SCL = A5. Nilai mentah: aksel 16384/g, gyro 131 per °/s.',
  'wokwi-ds1307': 'I2C 0x68, gunakan RTClib (RTC_DS1307). Jam mengikuti waktu perangkat.', 'mod-ds3231': 'I2C 0x68, gunakan RTClib (RTC_DS3231).',
  'x-lcd1602-i2c': 'LiquidCrystal_I2C lcd(0x27, 16, 2); lcd.init(); lcd.backlight(); Uno: SDA = A4, SCL = A5.', 'x-lcd2004-i2c': 'LiquidCrystal_I2C lcd(0x27, 20, 4);',
  'mod-oled-i2c': 'Adafruit_SSD1306 display(128, 64, &Wire, -1); display.begin(SSD1306_SWITCHCAPVCC, 0x3C);',
  'mod-relay1': 'Kebanyakan modul relay aktif LOW: digitalWrite(IN, LOW) = relay ON. Beban dihubungkan ke COM dan NO.',
  'mod-relay2': 'Aktif LOW secara bawaan. Ubah pengaturan "Aktif saat" sesuai modul Anda.', 'mod-relay4': 'Aktif LOW secara bawaan. Setiap kanal: COMx, NOx, NCx.',
  'mod-soil': 'AO: makin basah makin kecil nilainya. DO LOW saat lebih basah dari ambang.', 'mod-soil-cap': 'AOUT turun saat tanah basah (~3.1 V kering, ~1.5 V basah pada 5 V).',
  'mod-water-level': 'S naik seiring ketinggian air (0 saat kering).', 'mod-rain': 'AO turun saat hujan; DO LOW saat intensitas di atas ambang.',
  'mod-flow': 'Frekuensi pulsa = 7,5 × debit (L/menit). Hitung pulsa dengan attachInterrupt().', 'mod-l298n': 'IN1/IN2 = arah motor A, ENA = kecepatan (PWM). Tanpa kabel ENA dianggap jumper terpasang. GND baterai harus disatukan dengan GND Arduino.',
  'mod-ir-obstacle': 'OUT LOW saat ada halangan.', 'mod-tcrt5000': 'DO HIGH di atas garis hitam (cahaya tidak memantul).', 'mod-touch': 'Ketuk lingkaran di kanvas saat simulasi: SIG HIGH selama disentuh.',
  'mod-pulse': 'Keluaran analog berbentuk gelombang detak sesuai BPM.', 'mod-acs712': 'OUT = 2,5 V + 0,185 V/A (versi 5 A).', 'mod-voltage': 'S = Vin ÷ 5. Arduino: V = analogRead × 5/1023 × 5.',
  'mod-tds': 'Rumus DFRobot: ppm = (133,42V³ − 255,86V² + 857,39V) × 0,5.', 'mod-ph': 'pH = 7 + (2,5 − V) / 0,18.', 'mod-mosfet': 'SIG HIGH/PWM menyambungkan V− ke GND, sehingga beban di antara V+ dan V− menyala.',
  'mod-npn': 'Basis butuh resistor (mis. 1 kΩ). Kolektor ke beban, emitor ke GND.', 'x-breadboard-half': 'Lubang a–e satu kolom terhubung; f–j satu kolom terhubung; rel + dan − terhubung sepanjang baris. Seret komponen ke lubang: kaki akan menempel otomatis.',
  'x-breadboard-mini': 'Lubang a–e satu kolom terhubung; f–j satu kolom terhubung.',
  'wokwi-esp32-devkit-v1': 'Mode desain: wiring diperiksa (pin 3.3 V, ADC2, pin input-only 34–39, strapping). Kode tidak dijalankan.',
  'mod-esp32-cam': 'Untuk proyek kamera/Edge Impulse. GPIO bebas terbatas (2, 4, 12, 13, 14, 15). Mode desain; kode tidak dijalankan.',
};
const WIRE_COLORS = ['#e11d48', '#1f2937', '#f5a524', '#2fbf71', '#3d8bfd', '#a855f7', '#06b6d4', '#fb923c', '#ffffff'];
function renderProps(soft) {
  const host = $('#propsBody'); const sel = canvas.selected;
  if (!sel) { host.innerHTML = '<div class="prop-empty">Ketuk komponen atau kabel di kanvas untuk melihat dan mengubah propertinya.</div>'; return; }
  if (sel.kind === 'wire') {
    const w = canvas.wires.find((x) => x.id === sel.id); if (!w) return;
    host.innerHTML = `<div class="prop-h"><b>Kabel</b><code>${esc(w.a)} → ${esc(w.b)}</code></div><div class="swatches">${WIRE_COLORS.map((c) => `<button class="swatch${c === w.color ? ' on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div><div class="prop-actions"><button class="btn danger" id="delWire"><svg><use href="#i-trash"/></svg><span>Hapus kabel</span></button></div>`;
    host.querySelectorAll('.swatch').forEach((b) => (b.onclick = () => { canvas.setWireColor(w.id, b.dataset.c); renderProps(); }));
    $('#delWire').onclick = () => canvas.deleteSelected(); return;
  }
  const part = canvas.parts.get(sel.id); if (!part) return; const cat = BY_TAG[part.type];
  if (soft && host.dataset.pid === part.id && document.activeElement?.closest?.('#propsBody')) {
    for (const inp of host.querySelectorAll('[data-k]')) { const p = cat.props.find((x) => x.key === inp.dataset.k); const v = part.attrs[p.key]; if (p.type === 'range' && document.activeElement !== inp) { inp.value = v; inp.parentElement.querySelector('.prop-val').textContent = v + (p.unit || ''); } }
    return;
  }
  host.dataset.pid = part.id;
  const badge = cat?.sim === 'full' ? ['#e3f6ea', '#17803f', 'Disimulasikan'] : cat?.sim === 'design' ? ['#fff3db', '#9a6400', 'Mode desain: wiring dicek, kode tidak dijalankan'] : ['#eceff3', '#6b7385', 'Tampilan saja (tidak disimulasikan)'];
  let html = `<div class="prop-h"><b>${esc(cat?.name || part.type)}</b><code>${esc(part.id)}</code></div><span class="prop-badge" style="background:${badge[0]};color:${badge[1]}">${badge[2]}</span>`;
  for (const p of cat?.props || []) {
    const v = part.attrs[p.key];
    if (p.type === 'select') html += `<div class="prop-row"><label>${esc(p.label)}</label><select data-k="${p.key}">${p.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    else if (p.type === 'range') html += `<div class="prop-row"><label>${esc(p.label)}</label><div><input type="range" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"><div class="prop-val">${v}${p.unit || ''}</div></div></div>`;
    else if (p.type === 'bool') html += `<div class="prop-row"><label>${esc(p.label)}</label><input type="checkbox" data-k="${p.key}" ${v ? 'checked' : ''}></div>`;
    else html += `<div class="prop-row"><label>${esc(p.label)}</label><input type="text" data-k="${p.key}" value="${esc(v ?? '')}"></div>`;
  }
  if (HINTS[part.type]) html += `<div class="prop-hint">${esc(HINTS[part.type])}</div>`;
  html += `<div class="prop-actions"><button class="btn" id="pRot"><svg><use href="#i-rotr"/></svg><span>Putar</span></button><button class="btn" id="dupPart"><svg><use href="#i-copy"/></svg><span>Duplikat</span></button><button class="btn danger" id="delPart"><svg><use href="#i-trash"/></svg><span>Hapus</span></button></div>`;
  if (!cat?.breadboard) {
    const wired = new Set(canvas.wires.flatMap((w) => [w.a, w.b]));
    html += `<div class="prop-pins"><h4>Pin (${part.pinInfo.length})</h4><table>${part.pinInfo.map((i) => { const g = cat?.gpio?.[i.name]; return `<tr><td>${esc(canvas.pinLabel(part, i))}${typeof g === 'number' ? ` <span class="muted">GPIO${g}</span>` : ''}</td><td>${wired.has(part.id + ':' + i.name) ? 'terhubung' : '—'}</td></tr>`; }).join('')}</table></div>`;
  }
  host.innerHTML = html;
  host.querySelectorAll('[data-k]').forEach((inp) => {
    inp.oninput = inp.onchange = (ev) => {
      const p = cat.props.find((x) => x.key === inp.dataset.k);
      const v = inp.type === 'checkbox' ? inp.checked : p.type === 'range' ? +inp.value : inp.value;
      part.attrs[p.key] = v; canvas.applyAttrs(part);
      if (p.type === 'range') inp.parentElement.querySelector('.prop-val').textContent = v + (p.unit || '');
      if (p.key === 'pixels') canvas.emit('change', { structural: true });
      if (p.key === 'pixels' || p.key === 'common') canvas._refreshPins(part);
      if (ev.type === 'change') canvas.snapshot();
      sim.resolveNow?.();
    };
  });
  $('#pRot').onclick = () => canvas.rotate(part.id, 1);
  $('#delPart').onclick = () => canvas.removePart(part.id);
  $('#dupPart').onclick = () => canvas.duplicate(part.id);
}

// ------------------------------------------------------------------ examples / projects
async function loadExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id); if (!ex) return;
  stopSim(); await canvas.setModel(exampleModel(ex));
  editor.value = ex.code; state.exampleId = id; state.projectId = null; state.hex = null; state.hexFor = null; state.hexOnly = false;
  $('#projectTitle').value = ex.title; editor.marks.clear();
  addLog('info', `Contoh dimuat: ${ex.title}. ${ex.board === 'design' ? 'Board ini dalam mode desain; tekan Jalankan untuk memeriksa rangkaian.' : 'Tekan Jalankan.'}`);
  history.replaceState(null, '', '#ex=' + id);
  updateBoardInfo(); runCheck();
  if (isNarrow()) { $('#workspace').classList.add('lp-closed'); $$('.rail-btn').forEach((b) => b.classList.remove('on')); }
  if (state.mode !== 'design') setMode('design'); else requestAnimationFrame(() => canvas.fit());
}
const exl = $('#examplesList');
exl.innerHTML = EXAMPLE_GROUPS.map((g) => `<div class="ex-group">${esc(g)}</div>` + EXAMPLES.filter((e) => e.group === g).map((e) => `<button class="ex" data-ex="${e.id}"><b>${esc(e.title)}</b><span>${esc(e.desc)}</span>${e.tags ? `<div class="tagrow">${e.tags.map((t) => `<i>${esc(t)}</i>`).join('')}</div>` : ''}</button>`).join('')).join('');
exl.onclick = (e) => { const b = e.target.closest('[data-ex]'); if (b) loadExample(b.dataset.ex); };

function closeMenus() { $$('.menu.open').forEach((m) => m.classList.remove('open')); }
$$('.menu > .mb').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const m = b.parentElement, o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); }));
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

function projectData() { const m = canvas.getModel(); return { v: 2, title: $('#projectTitle').value, code: editor.value, parts: m.parts, connections: m.connections, example: state.exampleId }; }
async function applyProject(d) {
  stopSim(); await canvas.setModel({ parts: d.parts || [], connections: d.connections || [] });
  editor.value = d.code || DEFAULT_CODE; $('#projectTitle').value = d.title || 'Proyek'; state.exampleId = d.example && EXAMPLES.find((e) => e.id === d.example)?.code === d.code && hasExampleHex(d.example) ? d.example : null;
  state.hex = null; state.hexFor = null; state.hexOnly = false; updateBoardInfo(); runCheck();
}
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const fname = () => ($('#projectTitle').value || 'proyek').replace(/[^\w\-]+/g, '_').slice(0, 40);
let fileMode = null;
async function doAction(act) {
  switch (act) {
    case 'new': stopSim(); await canvas.setModel({ parts: [], connections: [] }); editor.value = DEFAULT_CODE; state.exampleId = null; state.hex = null; state.hexFor = null; $('#projectTitle').value = 'Proyek tanpa judul'; history.replaceState(null, '', location.pathname); updateBoardInfo(); runCheck(); break;
    case 'export-json': download(fname() + '.json', JSON.stringify(projectData(), null, 2), 'application/json'); break;
    case 'export-ino': download(fname() + '.ino', editor.value); break;
    case 'export-hex': if (state.hex) download(fname() + '.hex', state.hex); else toast('Belum ada hasil kompilasi. Tekan Kompilasi dulu.', true); break;
    case 'import-json': fileMode = 'json'; $('#fileIn').accept = '.json,application/json'; $('#fileIn').click(); break;
    case 'import-hex': fileMode = 'hex'; $('#fileIn').accept = '.hex'; $('#fileIn').click(); break;
    case 'settings': openSettings(); break;
    case 'undo': canvas.undo(); break; case 'redo': canvas.redo(); break;
    case 'rotate': canvas.rotateSelected(1); break;
    case 'duplicate': if (canvas.selected?.kind === 'part') canvas.duplicate(canvas.selected.id); break;
    case 'delete': canvas.deleteSelected(); break;
    case 'clear-wires': for (const w of [...canvas.wires]) if (!w.plug) canvas._removeWire(w, true); canvas.emit('change', { structural: true }); break;
    case 'help': openHelp(); break; case 'about': openAbout(); break;
  }
}
$$('.menu-pop').forEach((m) => (m.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) { closeMenus(); doAction(b.dataset.act); } }));
$$('[data-act2]').forEach((b) => (b.onclick = () => doAction(b.dataset.act2)));
$('#fileIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; const text = await f.text();
  try {
    if (fileMode === 'json') { const d = JSON.parse(text); if (!Array.isArray(d.parts)) throw new Error('Berkas bukan proyek simulator (tidak ada daftar komponen).'); await applyProject(d); toast('Proyek dibuka.'); }
    else { const { parseHex } = await import('./sim/hex.js'); parseHex(text); state.hex = text; state.hexFor = editor.value; state.hexOnly = true; state.exampleId = null; addLog('ok', `Berkas HEX dimuat (${f.name}). Tekan Jalankan.`); toast('HEX dimuat — tekan Jalankan.'); }
  } catch (err) { addLog('error', 'Gagal membuka berkas: ' + err.message); toast(err.message, true); }
};

// ------------------------------------------------------------------ build view
function updateBuildView() {
  const b = boardOf();
  $('#buildTarget').textContent = !b ? 'Tidak ada mikrokontroler di rangkaian.' : b.runnable ? `Target: ${b.cat.name} (${b.cat.mcu}) — dikompilasi dengan avr-gcc + core Arduino.` : `Target: ${b.cat.name} (${b.cat.mcu}) — tidak dikompilasi di sini.`;
  $('#buildHelp').innerHTML = b && !b.runnable
    ? `Untuk ${esc(b.cat.mcu)}: unduh <code>.ino</code>, buka di Arduino IDE, pilih board <b>${esc(b.cat.name)}</b>, lalu Upload. Gunakan panel <b>Periksa</b> untuk memastikan kabel aman sebelum dirakit.`
    : `Library yang tersedia: Servo, LiquidCrystal, LiquidCrystal_I2C, Adafruit_NeoPixel, Adafruit_SSD1306 + GFX, DHT, RTClib, Wire, SPI, EEPROM, SoftwareSerial. ${compileEndpoint() ? 'Server kompilator: ' + esc(compileEndpoint()) : 'Server kompilator belum diatur: hanya contoh bawaan yang bisa dijalankan; kode sendiri bisa dijalankan dari berkas .hex.'}`;
}

// ------------------------------------------------------------------ share
const b64 = {
  async enc(str) { const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw')); const buf = new Uint8Array(await new Response(cs).arrayBuffer()); let s = ''; buf.forEach((x) => (s += String.fromCharCode(x))); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  async dec(t) { const s = atob(t.replace(/-/g, '+').replace(/_/g, '/')); const u = Uint8Array.from(s, (c) => c.charCodeAt(0)); const ds = new Blob([u]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return new Response(ds).text(); },
};
$('#btnShare').onclick = async () => {
  const dlg = $('#dlgShare'), data = projectData(); let url, msg, note = '';
  try {
    if (sharingAvailable()) {
      const r = await saveProject({ id: state.projectId, title: data.title, data }); state.projectId = r.id;
      url = `${location.origin}${location.pathname}?p=${r.id}`; msg = r.updated ? 'Proyek diperbarui. Tautan tetap sama:' : 'Proyek tersimpan di database. Bagikan tautan ini:';
      note = 'Hanya peramban ini yang punya kunci untuk memperbarui proyek; orang lain yang membuka tautan mendapat salinan.';
    } else throw new Error('db-off');
  } catch (e) {
    try { const enc = await b64.enc(JSON.stringify(data)); url = `${location.origin}${location.pathname}#d=${enc}`; msg = 'Tautan berisi seluruh proyek (tanpa database):'; note = e.message === 'db-off' ? 'Database belum aktif pada build ini, jadi proyek dikodekan langsung di tautan.' : 'Database gagal (' + e.message + '). Proyek dikodekan langsung di tautan.'; if (url.length > 8000) note += ' Tautan panjang; pertimbangkan Unduh proyek (.json).'; }
    catch (e2) { toast('Gagal membuat tautan: ' + e2.message, true); return; }
  }
  $('#shareMsg').textContent = msg; $('#shareUrl').value = url; $('#shareNote').textContent = note; dlg.showModal(); $('#shareUrl').select();
};
$('#shareCopy').onclick = async () => { const i = $('#shareUrl'); i.select(); try { await navigator.clipboard.writeText(i.value); toast('Tautan disalin.'); } catch { document.execCommand('copy'); toast('Tautan disalin.'); } };

// ------------------------------------------------------------------ settings, help, theme
function openSettings() { const s = loadSettings(); $('#setUrl').value = s.url || ''; $('#setStatus').textContent = compileEndpoint() ? 'Endpoint aktif: ' + compileEndpoint() : 'Belum ada server kompilator.'; $('#dlgSettings').showModal(); }
$('#setSave').onclick = () => { saveSettings({ url: $('#setUrl').value.trim() }); toast('Pengaturan disimpan.'); updateBuildView(); };
$('#setTest').onclick = async () => { $('#setStatus').textContent = 'Menguji…'; const r = await testServer($('#setUrl').value); $('#setStatus').textContent = r.text; };
function openHelp() {
  $('#helpTitle').textContent = 'Cara pakai';
  $('#helpBody').innerHTML = `<h4>Menambah komponen</h4><ul><li>Ketuk kartu komponen untuk menaruhnya di tengah kanvas.</li><li>Di iPad: tahan kartu sebentar lalu seret ke kanvas. Dengan mouse: langsung seret.</li><li>Letakkan komponen di atas breadboard: kakinya menempel otomatis ke lubang terdekat.</li></ul>
  <h4>Membuat kabel</h4><ul><li>Ketuk pin pertama, lalu ketuk pin tujuan. Atau seret dari pin ke pin.</li><li>Ketuk kabel untuk memilih, lalu ganti warna atau hapus di panel Properti.</li></ul>
  <h4>Kanvas</h4><ul><li>Satu jari di area kosong: geser kanvas. Dua jari: cubit untuk zoom.</li><li>Seret komponen untuk memindah. Saat simulasi berjalan, seret lewat label nama di atasnya.</li><li>Tombol putar, duplikat, hapus, urungkan/ulangi ada di toolbar atas.</li></ul>
  <h4>Simulasi</h4><ul><li>Desain → Kode → Simulasi. Tekan <b>Jalankan</b>; galat kompilasi muncul di Log dengan nomor baris yang bisa diketuk.</li><li>Ubah nilai sensor (suhu, jarak, kelembapan…) di panel Properti saat simulasi berjalan.</li><li>Arduino Uno/Nano: kode dijalankan. ESP32/ESP8266/Pico: mode desain (daya & sensor disimulasikan, wiring diperiksa).</li></ul>`;
  $('#dlgHelp').showModal();
}
function openAbout() {
  $('#helpTitle').textContent = 'Tentang simulator';
  $('#helpBody').innerHTML = `<p>Emulator AVR ATmega328P (avr8js) dengan pemecah rangkaian, ${CATALOG.length} komponen (${CATALOG.filter((c) => c.sim === 'full').length} disimulasikan), I2C (LCD, OLED, MPU6050, RTC), DHT11/22, relay, motor & driver, breadboard, dan pemeriksaan rangkaian ESP32.</p><p class="muted small">Komponen Wokwi Elements (MIT). Dibuat untuk pembelajaran STEAM.</p>`;
  $('#dlgHelp').showModal();
}
$('#btnTheme').onclick = () => { const d = document.documentElement; const t = d.dataset.theme === 'dark' ? 'light' : 'dark'; d.dataset.theme = t; try { localStorage.setItem('sim.theme', t); } catch { /* private mode */ } };

// ------------------------------------------------------------------ editor key bar (iPad keyboard lacks quick symbols)
$('#keyBar').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('#keyBar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) editor._ins(b.dataset.ins); });

// ------------------------------------------------------------------ boot
renderPalette(); renderProps(); updateBoardInfo(); updateBuildView();
(async () => {
  const q = new URLSearchParams(location.search), h = location.hash;
  try {
    if (q.get('p')) { const row = await loadProject(q.get('p')); state.projectId = null; await applyProject(row.data || row); toast('Proyek dibuka dari tautan.'); }
    else if (h.startsWith('#d=')) { await applyProject(JSON.parse(await b64.dec(h.slice(3)))); toast('Proyek dibuka dari tautan.'); }
    else await loadExample(h.startsWith('#ex=') && EXAMPLES.some((e) => e.id === h.slice(4)) ? h.slice(4) : 'blink');
  } catch (e) { addLog('error', 'Gagal membuka proyek dari tautan: ' + e.message); await loadExample('blink'); }
  state.fittedOnce = true;
  window.addEventListener('hashchange', () => { const id = location.hash.slice(4); if (location.hash.startsWith('#ex=') && id !== state.exampleId && EXAMPLES.some((e) => e.id === id)) loadExample(id); });
  window.__sim = { sim, canvas, editor, state, run, setMode, showPanel, runCheck };   // handle for automated tests
})();
