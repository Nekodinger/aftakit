import '@wokwi/elements';
import './style.css';
import { CATALOG, CATEGORIES, BY_TAG } from './catalog.js';
import { Simulator } from './sim/sim.js';
import { CircuitCanvas } from './ui/canvas.js';
import { Editor } from './ui/editor.js';
import { compile, loadSettings, saveSettings, testServer, compileEndpoint, parseDiagnostics } from './compile.js';
import { saveProject, loadProject, sharingAvailable } from './store.js';
import { EXAMPLES, exampleModel } from './examples/defs.js';
import { exampleHexText, hasExampleHex } from './examples/pack.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DEFAULT_CODE = `void setup() {\n  // jalankan sekali\n}\n\nvoid loop() {\n  // diulang terus-menerus\n}\n`;
const state = { exampleId: null, projectId: null, hex: null, hexFor: null, hexOnly: false, built: false, busy: false, dirtyBuild: true };

// ------------------------------------------------------------------ toast
let toastT;
function toast(text, err = false) { const t = $('#toast'); t.textContent = text; t.classList.toggle('err', err); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600); }

// ------------------------------------------------------------------ core objects
const sim = new Simulator();
const canvas = new CircuitCanvas({
  viewport: $('#viewport'), world: $('#world'), wiresSvg: $('#wires'), partsHost: $('#parts'), pinLayer: $('#pinLayer'),
  emptyHint: $('#emptyHint'), zoomLabel: $('#zoomLabel'), wireHint: $('#wireHint'),
});
const editor = new Editor({ ta: $('#code'), hl: $('#hl'), gutter: $('#gutter'), pos: $('#cursorPos'), onChange: () => { state.dirtyBuild = true; setCompilerState(''); }, onRun: () => run() });
editor.value = DEFAULT_CODE;
canvas.on('toast', ({ text, err }) => toast(text, err));
canvas.on('change', ({ structural }) => { if (structural && sim.running) stopSim('Rangkaian diubah — simulasi dihentikan.'); state.built = false; renderProps(); });
canvas.on('select', () => { renderProps(); });
canvas.on('attrs', () => { if ($('#sideProps') && !$('#sideProps').hidden) renderProps(true); });

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
  if (level === 'error') { errCount++; const b = $('#logBadge'); b.hidden = false; b.textContent = errCount; }
}
$('#logList').addEventListener('click', (e) => { const a = e.target.closest('a.jump'); if (a) { showSide('code'); editor.goto(+a.dataset.line, +a.dataset.col); } });
$('#logClear').onclick = () => { $('#logList').textContent = ''; errCount = 0; $('#logBadge').hidden = true; };
sim.on('log', (l) => addLog(l.level, l.text, { t: l.t }));

function hintFor(msg) {
  if (/was not declared in this scope/.test(msg)) return 'Periksa ejaan nama, atau deklarasikan variabel/fungsi sebelum dipakai.';
  if (/expected [‘'“]?;/.test(msg)) return 'Kemungkinan titik koma (;) kurang di akhir baris sebelumnya (kompilator menunjuk token berikutnya).';
  if (/No such file or directory|fatal error:/.test(msg)) return 'Library tidak tersedia. Tersedia: Servo, LiquidCrystal, Adafruit_NeoPixel, Wire, SPI, EEPROM, SoftwareSerial.';
  if (/undefined reference to .(setup|loop)/.test(msg)) return 'Sketch harus punya fungsi void setup() dan void loop().';
  if (/expected [‘']\}|expected declaration/.test(msg)) return 'Kurung kurawal { } tidak seimbang.';
  return '';
}

// ------------------------------------------------------------------ tabs
function showSide(name) {
  document.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('on', b.dataset.side === name));
  $('#sideCode').hidden = name !== 'code'; $('#sideSerial').hidden = name !== 'serial'; $('#sideProps').hidden = name !== 'props';
  if (name === 'serial') $('#serialBadge').hidden = true;
  if (name === 'props') renderProps();
  if (name === 'code') editor._sync();
}
document.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => showSide(b.dataset.side)));
document.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  $('#logList').hidden = b.dataset.tab !== 'log'; $('#buildOut').hidden = b.dataset.tab !== 'build';
}));
function showLogTab(name) { document.querySelector(`[data-tab="${name}"]`).click(); }

// ------------------------------------------------------------------ serial
const serialOut = $('#serialOut'); let serialText = '';
sim.on('serial', (b) => {
  serialText += b === 13 ? '' : String.fromCharCode(b);
  if (serialText.length > 30000) serialText = serialText.slice(-20000);
  serialOut.textContent = serialText; serialOut.scrollTop = serialOut.scrollHeight;
  if ($('#sideSerial').hidden) $('#serialBadge').hidden = false;
});
$('#serialClear').onclick = () => { serialText = ''; serialOut.textContent = ''; };
$('#serialForm').onsubmit = (e) => { e.preventDefault(); const i = $('#serialIn'); if (!sim.running) { toast('Jalankan simulasi dulu untuk mengirim data serial.', true); return; } sim.serialWrite(i.value + $('#serialEol').value); i.value = ''; };

// ------------------------------------------------------------------ status / state
function setStatus(kind, text) { $('#simDot').className = 'dot ' + (kind || ''); $('#simText').textContent = text; }
function setCompilerState(t) { $('#compilerState').textContent = t; }
sim.on('state', (s) => {
  const run = s === 'running';
  setStatus(run ? 'run' : '', run ? 'Berjalan' : 'Berhenti');
  $('#btnRun').disabled = false; $('#btnStop').disabled = !run; canvas.interactive = run;
  document.body.classList.toggle('is-running', run);
});
sim.on('tick', ({ time }) => {
  if (state.boardEl) {
    const b = sim.board; const lvl = (n) => !!b.pins[n]?.level;
    try { state.boardEl.led13 = lvl('13'); state.boardEl.ledPower = true; } catch { /* element lacks led props */ }
  }
  if (sim.running) $('#simText').textContent = `Berjalan · ${time.toFixed(1)} s`;
});
function stopSim(msg) { if (sim.running) { sim.stop(); if (msg) addLog('info', msg); } }

// ------------------------------------------------------------------ run pipeline
async function doCompile() {
  const code = editor.value;
  setCompilerState('Mengompilasi…');
  const exd = state.exampleId && EXAMPLES.find((e) => e.id === state.exampleId), pk = exd ? await exampleHexText(exd.id) : null, pre = pk ? { code: exd.code, ...pk } : null;
  const res = await compile(code, { precompiled: pre });
  $('#buildOut').textContent = [res.stdout, res.stderr].filter(Boolean).join('\n') || '(tidak ada keluaran)';
  const diags = res.diagnostics?.length ? res.diagnostics : parseDiagnostics(res.stderr);
  editor.setMarks(diags);
  if (!res.ok) {
    errCount = 0;
    if (diags.length) for (const d of diags) addLog(d.severity === 'warn' ? 'warn' : 'error', d.message, { line: d.line, col: d.col, msg: d.message, fix: hintFor(d.message) });
    else addLog('error', res.error || 'Kompilasi gagal.');
    addLog('error', `Kompilasi gagal${diags.length ? ` (${diags.filter((d) => d.severity === 'error').length} galat)` : ''}. Simulasi tidak dijalankan.`);
    setCompilerState('Gagal'); setStatus('err', 'Kompilasi gagal');
    return false;
  }
  for (const d of diags) addLog('warn', d.message, { line: d.line, col: d.col, msg: d.message });
  state.hex = res.hex; state.hexFor = code; state.hexOnly = false;
  const size = (res.stdout || '').split('\n').find((l) => /Sketch uses/.test(l));
  addLog('ok', `Kompilasi berhasil (${res.source}).${size ? ' ' + size : ''}`);
  setCompilerState('Siap · ' + res.source);
  return true;
}

function buildSim() {
  stopSim();
  const model = canvas.simModel();
  const boardPart = model.parts.find((p) => BY_TAG[p.type]?.board);
  state.boardEl = boardPart ? canvas.parts.get(boardPart.id).el : null;
  const diag = sim.build(model, canvas.elements());
  if (diag.errors.length) { for (const e of diag.errors) addLog('error', e); setStatus('err', 'Rangkaian bermasalah'); return false; }
  sim.loadHex(state.hex);
  state.built = true; return true;
}

async function run() {
  if (state.busy) return; state.busy = true; $('#btnRun').disabled = true;
  try {
    if (!state.hexOnly && (state.hexFor !== editor.value || !state.hex)) { if (!(await doCompile())) return; }
    if (!state.hex) { addLog('error', 'Belum ada program.'); return; }
    if (!buildSim()) return;
    serialText = ''; serialOut.textContent = '';
    sim.start(); addLog('info', 'Simulasi dimulai.');
  } catch (e) { addLog('error', e.message); setStatus('err', 'Galat'); console.error(e); }
  finally { state.busy = false; $('#btnRun').disabled = false; }
}
$('#btnRun').onclick = run;
$('#btnStop').onclick = () => stopSim('Simulasi dihentikan.');
$('#btnReset').onclick = async () => {
  if (!state.hex) { toast('Belum ada program untuk di-reset.', true); return; }
  const was = sim.running; if (buildSim()) { serialText = ''; serialOut.textContent = ''; addLog('info', 'Program dimulai ulang dari awal.'); if (was) sim.start(); else { sim.advance(0); setStatus('', 'Berhenti'); } }
};
$('#btnCompile').onclick = async () => { if (state.busy) return; state.busy = true; try { await doCompile(); showLogTab('log'); } finally { state.busy = false; } };
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

// ------------------------------------------------------------------ palette
function renderPalette(filter = '') {
  const q = filter.trim().toLowerCase(), host = $('#partList'); host.textContent = ''; let n = 0;
  for (const cat of CATEGORIES) {
    const items = CATALOG.filter((c) => c.cat === cat && (!q || (c.name + ' ' + c.tag + ' ' + (c.keywords || '')).toLowerCase().includes(q)));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = cat; host.append(h);
    for (const c of items) {
      n++;
      const b = document.createElement('button'); b.className = 'part-item' + (c.sim === 'visual' ? ' vis' : ''); b.draggable = true; b.dataset.tag = c.tag;
      b.innerHTML = `<span class="thumb">${esc(c.name.slice(0, 2).toUpperCase())}</span><span class="nm"><b>${esc(c.name)}</b><span class="tag">${c.sim === 'visual' ? 'tampilan saja' : c.tag.replace('wokwi-', '')}</span></span>`;
      b.ondragstart = (e) => { e.dataTransfer.setData('text/x-part', c.tag); e.dataTransfer.effectAllowed = 'copy'; };
      b.onclick = () => addAtCenter(c.tag);
      host.append(b);
    }
  }
  if (!n) host.innerHTML = '<div class="prop-empty">Tidak ada komponen yang cocok.</div>';
  $('#partCount').textContent = CATALOG.length + ' jenis';
}
function addAtCenter(tag) {
  const r = $('#viewport').getBoundingClientRect(), w = canvas.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const off = (canvas.parts.size % 6) * 20;
  canvas.addPart(tag, Math.round((w.x - 40 + off) / 5) * 5, Math.round((w.y - 40 + off) / 5) * 5);
}
$('#partSearch').addEventListener('input', (e) => renderPalette(e.target.value));

// ------------------------------------------------------------------ properties
const HINTS = {
  'wokwi-gas-sensor': 'Keluaran digital DO aktif LOW (LOW = gas terdeteksi melewati ambang).', 'wokwi-flame-sensor': 'Keluaran digital DO aktif LOW saat api terdeteksi.',
  'wokwi-big-sound-sensor': 'Keluaran digital DO aktif HIGH saat suara melewati ambang.', 'wokwi-hc-sr04': 'Atur jarak objek. Sketch memakai pulseIn(ECHO) atau NewPing-style.',
  'wokwi-photoresistor-sensor': 'Intensitas tinggi = tegangan AO lebih tinggi; DO HIGH saat ≥ 50%.', 'wokwi-ntc-temperature-sensor': 'Gunakan persamaan Beta (B=3950) untuk mengonversi ADC ke °C.',
  'wokwi-potentiometer': 'Putar knob langsung di kanvas saat simulasi, atau geser nilai di sini.', 'wokwi-pushbutton': 'Klik/tekan tombol langsung di kanvas saat simulasi berjalan.',
};
function renderProps(soft) {
  const host = $('#propsBody'); if ($('#sideProps').hidden && !soft) { /* render lazily */ }
  const sel = canvas.selected;
  if (!sel || sel.kind !== 'part') {
    host.innerHTML = sel?.kind === 'wire' ? `<div class="prop-h"><b>Kabel</b></div><p class="muted">Tekan <kbd>Delete</kbd> untuk menghapus kabel terpilih.</p><button class="btn danger" id="delWire">Hapus kabel</button>` : '<div class="prop-empty">Pilih komponen di kanvas untuk melihat dan mengubah propertinya.</div>';
    const d = $('#delWire'); if (d) d.onclick = () => canvas.deleteSelected(); return;
  }
  const part = canvas.parts.get(sel.id); if (!part) return; const cat = BY_TAG[part.type];
  let html = `<div class="prop-h"><b>${esc(cat?.name || part.type)}</b><code>${esc(part.id)}</code></div>`;
  if (cat?.sim === 'visual') html += `<div class="prop-hint">Komponen ini hanya tampilan; tidak ikut disimulasikan.</div>`;
  for (const p of cat?.props || []) {
    const v = part.attrs[p.key];
    if (p.type === 'select') html += `<div class="prop-row"><label>${esc(p.label)}</label><select data-k="${p.key}">${p.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    else if (p.type === 'range') html += `<div class="prop-row"><label>${esc(p.label)}</label><div><input type="range" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"><div class="prop-val">${v}${p.unit || ''}</div></div></div>`;
    else if (p.type === 'bool') html += `<div class="prop-row"><label>${esc(p.label)}</label><input type="checkbox" data-k="${p.key}" ${v ? 'checked' : ''}></div>`;
    else html += `<div class="prop-row"><label>${esc(p.label)}</label><input type="text" data-k="${p.key}" value="${esc(v ?? '')}"></div>`;
  }
  if (HINTS[part.type]) html += `<div class="prop-hint">${esc(HINTS[part.type])}</div>`;
  const wired = new Set(canvas.wires.flatMap((w) => [w.a, w.b]));
  html += `<div class="prop-pins"><h4>Pin</h4><table>${part.pinInfo.map((i) => `<tr><td>${esc(i.name)}</td><td>${wired.has(part.id + ':' + i.name) ? 'terhubung' : '—'}</td></tr>`).join('')}</table></div>`;
  html += `<div style="margin-top:14px;display:flex;gap:8px"><button class="btn" id="dupPart">Duplikat</button><button class="btn danger" id="delPart">Hapus</button></div>`;
  host.innerHTML = html;
  host.querySelectorAll('[data-k]').forEach((inp) => {
    inp.oninput = inp.onchange = () => {
      const p = cat.props.find((x) => x.key === inp.dataset.k);
      let v = inp.type === 'checkbox' ? inp.checked : p.type === 'range' ? +inp.value : inp.value;
      part.attrs[p.key] = v; canvas.applyAttrs(part);
      if (p.type === 'range') inp.parentElement.querySelector('.prop-val').textContent = v + (p.unit || '');
      if (p.key === 'pixels') canvas.emit('change', { structural: true });
      canvas._refreshPins(part);
    };
  });
  $('#delPart').onclick = () => canvas.removePart(part.id);
  $('#dupPart').onclick = () => canvas.duplicate(part.id);
}
canvas.on('select', (s) => { if (s?.kind === 'part' && $('#sideProps').hidden && window.innerWidth > 980 && false) showSide('props'); });

// ------------------------------------------------------------------ examples / projects
async function loadExample(id) {
  const ex = EXAMPLES.find((e) => e.id === id); if (!ex) return;
  stopSim(); await canvas.setModel(exampleModel(ex));
  editor.value = ex.code; state.exampleId = id; state.projectId = null; state.hex = null; state.hexFor = null; state.hexOnly = false; state.built = false;
  $('#projectTitle').value = ex.title; showSide('code'); editor.marks.clear();
  addLog('info', `Contoh dimuat: ${ex.title}. Tekan Jalankan.`);
  history.replaceState(null, '', '#ex=' + id);
}
const exl = $('#examplesList');
exl.innerHTML = EXAMPLES.map((e) => `<button data-ex="${e.id}"><span class="ex-title">${esc(e.title)}</span><span class="ex-desc">${esc(e.desc)}</span></button>`).join('');
exl.onclick = (e) => { const b = e.target.closest('[data-ex]'); if (b) { closeMenus(); loadExample(b.dataset.ex); } };

function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.querySelectorAll('.menu > .btn').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const m = b.parentElement, o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); }));
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

function projectData() { const m = canvas.getModel(); return { v: 1, title: $('#projectTitle').value, code: editor.value, parts: m.parts, connections: m.connections, example: state.exampleId }; }
async function applyProject(d) {
  stopSim(); await canvas.setModel({ parts: d.parts || [], connections: d.connections || [] });
  editor.value = d.code || DEFAULT_CODE; $('#projectTitle').value = d.title || 'Proyek'; state.exampleId = d.example && EXAMPLES.find((e) => e.id === d.example)?.code === d.code && hasExampleHex(d.example) ? d.example : null;
  state.hex = null; state.hexFor = null; state.hexOnly = false;
}
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const fname = () => ($('#projectTitle').value || 'proyek').replace(/[^\w\-]+/g, '_').slice(0, 40);
let fileMode = null;
$('#menuFile .menu-pop').onclick = async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return; closeMenus();
  switch (b.dataset.act) {
    case 'new': stopSim(); await canvas.setModel({ parts: [], connections: [] }); editor.value = DEFAULT_CODE; state.exampleId = null; state.hex = null; state.hexFor = null; $('#projectTitle').value = 'Proyek tanpa judul'; history.replaceState(null, '', location.pathname); break;
    case 'export-json': download(fname() + '.json', JSON.stringify(projectData(), null, 2), 'application/json'); break;
    case 'export-ino': download(fname() + '.ino', editor.value); break;
    case 'export-hex': if (state.hex) download(fname() + '.hex', state.hex); else toast('Belum ada hasil kompilasi. Tekan Kompilasi dulu.', true); break;
    case 'import-json': fileMode = 'json'; $('#fileIn').accept = '.json,application/json'; $('#fileIn').click(); break;
    case 'import-hex': fileMode = 'hex'; $('#fileIn').accept = '.hex'; $('#fileIn').click(); break;
    case 'settings': openSettings(); break;
  }
};
$('#fileIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; const text = await f.text();
  try {
    if (fileMode === 'json') { const d = JSON.parse(text); if (!Array.isArray(d.parts)) throw new Error('Berkas bukan proyek simulator (tidak ada daftar komponen).'); await applyProject(d); toast('Proyek dibuka.'); }
    else { const { parseHex } = await import('./sim/hex.js'); parseHex(text); state.hex = text; state.hexFor = editor.value; state.hexOnly = true; state.exampleId = null; addLog('ok', `Berkas HEX dimuat (${f.name}). Tekan Jalankan.`); toast('HEX dimuat — tekan Jalankan.'); }
  } catch (err) { addLog('error', 'Gagal membuka berkas: ' + err.message); toast(err.message, true); }
};

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

// ------------------------------------------------------------------ settings
function openSettings() { const s = loadSettings(); $('#setUrl').value = s.url || ''; $('#setStatus').textContent = compileEndpoint() ? 'Endpoint aktif: ' + compileEndpoint() : 'Belum ada server kompilator.'; $('#dlgSettings').showModal(); }
$('#setSave').onclick = () => { saveSettings({ url: $('#setUrl').value.trim() }); toast('Pengaturan disimpan.'); };
$('#setTest').onclick = async () => { $('#setStatus').textContent = 'Menguji…'; const r = await testServer($('#setUrl').value); $('#setStatus').textContent = r.text; };

// ------------------------------------------------------------------ zoom buttons
$('#zoomIn').onclick = () => canvas.zoomAt(1.2); $('#zoomOut').onclick = () => canvas.zoomAt(1 / 1.2); $('#zoomFit').onclick = () => canvas.fit();
window.addEventListener('resize', () => canvas._applyView());

// ------------------------------------------------------------------ boot
renderPalette(); renderProps();
(async () => {
  const q = new URLSearchParams(location.search), h = location.hash;
  try {
    if (q.get('p')) { const row = await loadProject(q.get('p')); state.projectId = null; await applyProject(row.data || row); toast('Proyek dibuka dari tautan.'); }
    else if (h.startsWith('#d=')) { await applyProject(JSON.parse(await b64.dec(h.slice(3)))); toast('Proyek dibuka dari tautan.'); }
    else await loadExample(h.startsWith('#ex=') && EXAMPLES.some((e) => e.id === h.slice(4)) ? h.slice(4) : 'blink');
  } catch (e) { addLog('error', 'Gagal membuka proyek dari tautan: ' + e.message); await loadExample('blink'); }
  window.__sim = { sim, canvas, editor, state, run };   // handle for automated tests
})();
