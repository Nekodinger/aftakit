import '@wokwi/elements';
import './style.css';
import { registerParts } from './parts/index.js';
import { CATALOG, CATEGORIES, BY_TAG } from './catalog.js';
import { Simulator, IDLE_HEX } from './sim/sim.js';
import { checkDesign } from './sim/drc.js';
import { CircuitCanvas } from './ui/canvas.js';
import { Editor } from './ui/editor.js';
import { initDroneView } from './ui/droneview.js';
import { compile, loadSettings, saveSettings, testServer, compileEndpoint, parseDiagnostics, gatewayUrl, compileBase } from './compile.js';
import { putZip, getZip, sha256, describeZip } from './libs.js';
import { saveProject, loadProject, sharingAvailable } from './store.js';
import { EXAMPLES, exampleModel, EXAMPLE_GROUPS } from './examples/defs.js';
import { exampleHexText, hasExampleHex, exampleWasm, hasExampleWasm } from './examples/pack.js';

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
const state = { libs: [], exampleId: null, projectId: null, hex: null, hexFor: null, hexOnly: false, busy: false, mode: 'design', panel: 'parts' };

// ------------------------------------------------------------------ toast
let toastT;
function toast(text, err = false) { const t = $('#toast'); t.textContent = text; t.classList.toggle('err', err); t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600); }

// ------------------------------------------------------------------ core objects
const sim = new Simulator();
// HTTP from simulated ESP32 boards: direct fetch first, then this relay for IoT services without CORS (api/proxy.js)
sim.proxyUrl = '/api/proxy?url=';
const canvas = new CircuitCanvas({
  viewport: $('#viewport'), world: $('#world'), wiresSvg: $('#wires'), partsHost: $('#parts'), pinLayer: $('#pinLayer'),
  emptyHint: $('#emptyHint'), zoomLabel: $('#zoomLabel'), wireHint: $('#wireHint'),
});
const editor = new Editor({ ta: $('#code'), hl: $('#hl'), gutter: $('#gutter'), pos: $('#cursorPos'), onChange: () => setCompilerState(''), onRun: () => run() });
editor.value = DEFAULT_CODE;
canvas.on('toast', ({ text, err }) => toast(text, err));
canvas.on('model', () => updateBoardInfo());
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
$('#logClear').onclick = () => { if (consoleTab === 'serial') { serialText = ''; $('#serialOut').textContent = ''; } else if (consoleTab === 'bt') $('#btOut').textContent = ''; else if (consoleTab === 'ftdi') ftdiClear(); else { $('#logList').textContent = ''; errCount = 0; $('#logBadge').hidden = true; } };
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
  if (/expected ';' after/.test(msg)) return 'Tambahkan titik koma (;) di akhir baris ini.';   // clang (ESP32) points at the right line
  if (/expected [‘'“]?;/.test(msg)) return 'Kemungkinan titik koma (;) kurang di akhir baris sebelumnya (kompilator menunjuk token berikutnya).';
  if (/No such file or directory|fatal error:|file not found/.test(msg)) return runtimeOf(boardOf()) === 'avr'
    ? 'Library tidak tersedia. Uno/Nano: Servo, LiquidCrystal, LiquidCrystal_I2C, Adafruit_NeoPixel, Adafruit_SSD1306 + GFX, DHT, RTClib, Wire, SPI, EEPROM, SoftwareSerial.'
    : 'Library tidak tersedia. ESP32/ESP8266: WiFi, HTTPClient, WiFiClientSecure, ArduinoJson, BluetoothSerial, Preferences, EEPROM, Wire, SPI, LiquidCrystal(_I2C), Adafruit_SSD1306 + GFX, Adafruit_NeoPixel, DHT, ESP32Servo, RTClib, esp_camera.';
  if (/did you mean/.test(msg)) return 'Kemungkinan salah ketik: lihat saran nama yang benar di pesan ini.';
  if (/use of undeclared identifier/.test(msg)) return 'Periksa ejaan nama, atau deklarasikan variabel/fungsi sebelum dipakai.';
  if (/undefined reference to .(setup|loop)/.test(msg)) return 'Sketch harus punya fungsi void setup() dan void loop().';
  if (/expected [‘']\}|expected declaration/.test(msg)) return 'Kurung kurawal { } tidak seimbang.';
  return '';
}

// ------------------------------------------------------------------ console tabs + serial
let consoleTab = 'log', droneView = null;
function showConsole(name) {
  consoleTab = name;
  $$('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  $('#logList').hidden = name !== 'log'; $('#serialPane').hidden = name !== 'serial';
  $('#btPane').hidden = name !== 'bt'; $('#camPane').hidden = name !== 'cam'; $('#ftdiPane').hidden = name !== 'ftdi';
  $('#dronePane').hidden = name !== 'drone'; $('#console').classList.toggle('tall', name === 'drone'); droneView?.show(name === 'drone');
  if (name === 'serial') $('#serialBadge').hidden = true;
  if (name === 'bt') $('#btBadge').hidden = true;
  if (name === 'ftdi') $('#ftdiBadge').hidden = true;
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

// ------------------------------------------------------------------ Bluetooth terminal (simulated phone app)
const btOut = $('#btOut');
function btAppend(text, mine) {
  const sp = document.createElement('span'); if (mine) sp.className = 'me'; sp.textContent = text; btOut.append(sp);
  while (btOut.childNodes.length > 600) btOut.firstChild.remove();
  btOut.scrollTop = btOut.scrollHeight;
  if (!mine && consoleTab !== 'bt') $('#btBadge').hidden = false;
}
function btReset() { btOut.textContent = ''; $('#btDot').className = 'dot'; $('#btName').textContent = 'Bluetooth belum aktif (program memanggil BT.begin)'; }
const btDec = new TextDecoder();
sim.on('bt', (e) => {
  if (e.type === 'begin') {
    $('#btDot').className = 'dot on'; $('#btName').textContent = `Tersambung ke "${e.name}" (Bluetooth Serial tersimulasi)`; $('#tabBt').hidden = false;
    addLog('info', `Bluetooth aktif: "${e.name}". Buka tab Bluetooth untuk mengirim/menerima data seperti aplikasi Serial Bluetooth Terminal di HP.`);
  } else btAppend(btDec.decode(e.bytes, { stream: true }).replace(/\r/g, ''), false);
});
function btSend(text) {
  if (!sim.running) { toast('Jalankan simulasi dulu untuk mengirim data Bluetooth.', true); return; }
  if (sim.board.kind !== 'esp32') { toast('Bluetooth Classic hanya ada di ESP32.', true); return; }
  sim.btWrite(text + '\n'); btAppend('> ' + text + '\n', true);
}
$('#btForm').onsubmit = (e) => { e.preventDefault(); const i = $('#btIn'); if (i.value) btSend(i.value); i.value = ''; };
$$('[data-bt]').forEach((b) => (b.onclick = () => btSend(b.dataset.bt)));
// ------------------------------------------------------------------ Drone tab: 3D view + RC transmitter
droneView = initDroneView(sim, { canvas: $('#droneCanvas'), stickL: $('#stickL'), stickR: $('#stickR'), sw5: $('#sw5'), sw6: $('#sw6'), btnReset: $('#droneReset'), btnCharge: $('#droneCharge'), note: $('#droneNote') });
const DRONE_TYPES = new Set(['mod-drone-frame', 'mod-esc', 'mod-rc-rx', 'mod-bldc-a2212', 'mod-bldc-2205']);

// ------------------------------------------------------------------ USB-Serial (FTDI) terminal: the computer side of an FTDI adapter
const ftdiOut = $('#ftdiOut'), ftdiDec = {};
function ftdiAppend(text, mine, id) {
  const multi = $('#ftdiPort').options.length > 1;
  const sp = document.createElement('span'); if (mine) sp.className = 'me';
  sp.textContent = text; ftdiOut.append(sp);
  while (ftdiOut.childNodes.length > 1500) ftdiOut.firstChild.remove();
  ftdiOut.scrollTop = ftdiOut.scrollHeight;
  if (!mine && consoleTab !== 'ftdi') $('#ftdiBadge').hidden = false;
  return multi && id;
}
function ftdiClear() { ftdiOut.textContent = ''; }
let ftdiLastId = null;
sim.on('ftdi', ({ id, b }) => {
  const sel = $('#ftdiPort'); if (sel.options.length > 1 && sel.value !== id) return;      // several adapters: show the selected port
  if (b === 13) return;
  ftdiAppend((ftdiDec[id] ||= new TextDecoder()).decode(new Uint8Array([b]), { stream: true }), false, id); ftdiLastId = id;
});
const ftdiPort = () => { const ps = sim.ftdiPorts || []; return ps.find((p) => p.id === $('#ftdiPort').value) || ps[0]; };
$('#ftdiForm').onsubmit = (e) => {
  e.preventDefault(); const i = $('#ftdiIn');
  if (!sim.running) { toast('Jalankan simulasi dulu untuk mengirim data lewat FTDI.', true); return; }
  const p = ftdiPort(); if (!p) { toast('Tidak ada modul FTDI di rangkaian.', true); return; }
  p.send(i.value + $('#ftdiEol').value.replace('\\r', '\r').replace('\\n', '\n')); ftdiAppend('> ' + i.value + '\n', true); i.value = '';
};
$('#ftdiDtr').onclick = () => {
  if (!sim.running) { toast('Jalankan simulasi dulu.', true); return; }
  const p = ftdiPort(); if (!p) return;
  if (p.pulseDtr()) { addLog('info', `${p.label}: DTR → RESET, program dimulai ulang (auto-reset).`); ftdiClear(); $('#btnReset').click(); }
  else toast('Pulsa DTR terkirim, tetapi DTR tidak tersambung ke RESET (pakai kapasitor 100 nF/100 µF ke pin RESET).');
};
// HTTP requests go through this device's real internet connection
sim.on('net', ({ method, url }) => addLog('info', `🌐 ${method} ${url.length > 90 ? url.slice(0, 90) + '…' : url}`));

// ------------------------------------------------------------------ ESP32-CAM image source (sample / device camera / photo)
const CAM_W = 320, CAM_H = 240, SAMPLE = import.meta.env.BASE_URL + 'cam-sample.jpg';
const camCanvas = document.createElement('canvas'); camCanvas.width = CAM_W; camCanvas.height = CAM_H;
let camStream = null, camTimer = null, lastShotUrl = null, lastShotT = 0;
$('#camSample').src = SAMPLE;
function drawCover(src, sw, sh) {
  const g = camCanvas.getContext('2d'), s = Math.max(CAM_W / sw, CAM_H / sh), w = sw * s, h = sh * s;
  g.drawImage(src, (CAM_W - w) / 2, (CAM_H - h) / 2, w, h);
  return new Promise((res) => camCanvas.toBlob(async (bl) => res(bl ? new Uint8Array(await bl.arrayBuffer()) : null), 'image/jpeg', 0.7));
}
function stopCamera() { clearInterval(camTimer); camTimer = null; camStream?.getTracks().forEach((t) => t.stop()); camStream = null; $('#camVideo').hidden = true; }
async function setCamSource(kind) {
  stopCamera(); $('#camSample').hidden = kind === 'device';
  if (kind === 'sample') { sim.cameraFrame = null; $('#camSample').src = SAMPLE; $('#camStatus').textContent = ''; return; }
  if (kind === 'photo') { $('#camFile').click(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    const v = $('#camVideo'); v.srcObject = camStream; v.hidden = false; await v.play();
    const grab = async () => { if (v.videoWidth) { const bytes = await drawCover(v, v.videoWidth, v.videoHeight); if (bytes) sim.cameraFrame = { bytes, w: CAM_W, h: CAM_H }; } };
    await grab(); camTimer = setInterval(grab, 400);
    $('#camStatus').textContent = 'Kamera aktif — foto ESP32-CAM diambil dari kamera ini.';
  } catch (e) {
    $('#camStatus').textContent = 'Kamera tidak bisa dibuka (' + (e.name === 'NotAllowedError' ? 'izin ditolak' : e.message) + '). Memakai gambar contoh.';
    document.querySelector('input[name=camSrc][value=sample]').checked = true; $('#camSample').hidden = false; sim.cameraFrame = null;
  }
}
$$('input[name=camSrc]').forEach((r) => (r.onchange = () => r.checked && setCamSource(r.value)));
$('#camFile').onchange = async () => {
  const f = $('#camFile').files[0]; if (!f) return;
  const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
  const bytes = await drawCover(img, img.naturalWidth, img.naturalHeight);
  sim.cameraFrame = bytes ? { bytes, w: CAM_W, h: CAM_H } : null; $('#camSample').src = img.src;
  $('#camStatus').textContent = `Foto "${f.name}" dipakai sebagai gambar kamera (${CAM_W}×${CAM_H}).`; $('#camFile').value = '';
};
sim.on('camera', (f) => {
  $('#tabCam').hidden = false;
  const now = performance.now(); if (now - lastShotT < 150) return; lastShotT = now;
  if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
  lastShotUrl = f.builtin ? null : URL.createObjectURL(new Blob([f.bytes], { type: 'image/jpeg' }));
  $('#camShot').src = lastShotUrl || SAMPLE;
  $('#camShotInfo').textContent = `Foto terakhir · ${f.builtin ? '320×240 (gambar contoh)' : `${f.w}×${f.h} · ${(f.bytes.length / 1024).toFixed(1)} KB`} · t=${(sim.board.cpu.cycles / 16e6).toFixed(1)} s`;
});
function updateBoardTabs() {
  const b = boardOf(), kind = runtimeOf(b);
  $('#tabBt').hidden = !(kind === 'esp32' && /BluetoothSerial/.test(editor.value));
  $('#tabCam').hidden = !(b?.part.type === 'mod-esp32-cam' || /esp_camera\.h/.test(editor.value));
  const ftdis = [...canvas.parts.values()].filter((p) => p.type === 'mod-ftdi').map((p) => p.id), sel = $('#ftdiPort');
  $('#tabFtdi').hidden = !ftdis.length;
  const hadDrone = !$('#tabDrone').hidden; $('#tabDrone').hidden = ![...canvas.parts.values()].some((p) => DRONE_TYPES.has(p.type));
  if (!hadDrone && !$('#tabDrone').hidden && [...canvas.parts.values()].some((p) => p.type === 'mod-drone-frame')) addLog('info', 'Tab Drone tersedia: tampilan 3D, telemetri, dan remote (stik) untuk receiver RC.');
  if (ftdis.join() !== [...sel.options].map((o) => o.value).join()) { const cur = sel.value; sel.innerHTML = ftdis.map((id) => `<option value="${id}">${id}</option>`).join(''); if (ftdis.includes(cur)) sel.value = cur; }
  sel.hidden = ftdis.length < 2;
  if ((consoleTab === 'bt' && $('#tabBt').hidden) || (consoleTab === 'cam' && $('#tabCam').hidden) || (consoleTab === 'ftdi' && $('#tabFtdi').hidden) || (consoleTab === 'drone' && $('#tabDrone').hidden)) showConsole('log');
}

// ------------------------------------------------------------------ user libraries (.zip) + gateway info
function renderLibs() {
  const host = $('#libList'); if (!host) return;
  host.innerHTML = state.libs.length ? state.libs.map((l, i) => `<div class="lib-item"><div class="grow"><b>${esc(l.name)}</b>${l.edgeImpulse ? '<span class="tag">Edge Impulse</span> ' : ''}
    <span class="muted small">${(l.size / 1048576).toFixed(1)} MB</span>${l.include ? `<br><code>#include &lt;${esc(l.include)}&gt;</code>` : ''}</div>
    <button class="mini" data-libdel="${i}" title="Hapus dari proyek">Hapus</button></div>`).join('') : '<p class="muted small">Belum ada library .zip di proyek ini.</p>';
  $('#libBadge').hidden = !state.libs.length; $('#libBadge').textContent = state.libs.length || '';
  const gw = gatewayUrl();
  $('#gwInfo').innerHTML = gw ? `WiFiClient, WiFiClientSecure, WiFiUDP, MQTT, Blynk, Telegram memakai koneksi nyata lewat gateway server kompilasi (<code>${esc(gw)}</code>). Hanya koneksi keluar; port: 80, 443, 1883, 8883, 8080, 8443, 9443, UDP 53/123/5683.`
    : 'Gateway belum aktif: atur URL server kompilasi di Berkas → Pengaturan. Tanpa gateway, HTTPClient tetap jalan (lewat browser), tetapi Blynk/MQTT/Telegram tidak bisa tersambung.';
}
$('#libAdd').onclick = () => $('#libFile').click();
$('#libFile').onchange = async () => {
  const f = $('#libFile').files[0]; $('#libFile').value = ''; if (!f) return;
  try {
    if (f.size > 60 << 20) throw new Error('file terlalu besar (maks 60 MB)');
    const buf = await f.arrayBuffer(); const d = describeZip(f.name, buf); const sha = await sha256(buf);
    await putZip(sha, new Blob([buf], { type: 'application/zip' }));
    state.libs = [...state.libs.filter((l) => l.sha !== sha), { name: d.name, sha, size: f.size, include: d.include, edgeImpulse: d.edgeImpulse }];
    renderLibs(); addLog('ok', `Library "${d.name}" ditambahkan${d.include ? ` — pakai #include <${d.include}>` : ''}.`);
    toast('Library ditambahkan.');
  } catch (e) { toast('Gagal menambah library: ' + e.message, true); }
};
$('#libList').onclick = (e) => { const b = e.target.closest('[data-libdel]'); if (!b) return; state.libs.splice(+b.dataset.libdel, 1); renderLibs(); };
renderLibs();

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
const runtimeOf = (b) => (b?.cat.runtime === 'wasm' ? b.cat.wasm : 'avr');
const avrMcu = (b) => (b?.cat.board === 'mega' ? 'mega' : b?.cat.board === 'attiny85' ? 'attiny85' : 'uno');                       // AVR family: ATmega328P or ATmega2560
const progKey = (b) => runtimeOf(b) + (runtimeOf(b) === 'avr' ? ':' + avrMcu(b) : '');
function boardOf() { const p = [...canvas.parts.values()].find((x) => BY_TAG[x.type]?.board); return p ? { part: p, cat: BY_TAG[p.type], runnable: BY_TAG[p.type].sim === 'full' } : null; }
function updateBoardInfo() {
  const b = boardOf(); queueMicrotask(updateBoardTabs);
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
  if (state.boardEl) {
    const b = sim.board;
    try {
      if (b.kind === 'avr' && b.mcu?.name === 'ATtiny85') state.boardEl.led1 = !!b.pins.PB1?.level;   // Franzininho LED on PB1
      else if (b.kind === 'avr') state.boardEl.led13 = !!b.pins['13']?.level;
      else if (state.boardEl.tagName === 'WOKWI-ESP32-DEVKIT-V1') state.boardEl.led1 = !!b.pins.D2?.level;  // blue LED on GPIO2
      else if (state.boardEl.tagName === 'WOKWI-NANO-RP2040-CONNECT') state.boardEl.ledBuiltIn = !!b.pins.D13?.level;
      state.boardEl.ledPower = true;
    } catch { /* no led props */ }
  }
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
    const msg = `${b.cat.name} memakai inti ${b.cat.mcu}. Simulator ini menjalankan kode Uno/Nano (ATmega328P), Mega 2560, Franzininho (ATtiny85), ESP32, ESP32-CAM, NodeMCU/D1 mini (ESP8266), Pico dan Nano RP2040 Connect. Untuk board ini unduh kode (.ino) lalu kompilasi & unggah dengan Arduino IDE.`;
    $('#buildOut').textContent = msg; addLog('info', msg); setCompilerState('Tidak dikompilasi'); return false;
  }
  const code = editor.value;
  setCompilerState('Mengompilasi…');
  const kind = runtimeOf(b);
  const exd = state.exampleId && EXAMPLES.find((e) => e.id === state.exampleId);
  let pre = null;
  if (exd && kind === 'avr' && avrMcu(b) === 'uno') { const pk = await exampleHexText(exd.id); pre = pk ? { code: exd.code, ...pk } : null; }
  else if (exd) { const pw = exampleWasm(exd.id); pre = pw ? { code: exd.code, ...pw } : null; }
  const res = await compile(code, { precompiled: pre, board: kind, mcu: avrMcu(b), libs: kind === 'avr' ? [] : state.libs, getLib: getZip, onProgress: (t) => { setCompilerState(t); $('#buildOut').textContent = t; } });
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
  state.hex = res.hex || null; state.wasm = res.wasm || null; state.hexFor = progKey(b) + '|' + state.libs.map((l) => l.sha).join(',') + '|' + code; state.hexOnly = false;
  for (const line of (res.stdout || '').split('\n')) { if (/^Library Manager:/.test(line)) addLog('info', line); else if (/^PERINGATAN/.test(line)) addLog('warn', line); }
  const size = res.wasm ? `Program ${kind.toUpperCase()} (WebAssembly) ${(res.wasm.length / 1024).toFixed(0)} KB.` : (res.stdout || '').split('\n').find((l) => /Sketch uses/.test(l));
  addLog('ok', `Kompilasi berhasil (${res.source}).${size ? ' ' + size : ''}`);
  setCompilerState('Siap · ' + res.source);
  return true;
}

// prog: Intel HEX text (Uno/Nano) or a WebAssembly module (Uint8Array) for ESP32 / ESP8266 / Pico
async function buildSim(prog) {
  stopSim();
  const model = canvas.simModel();
  const b = boardOf(); state.boardEl = b?.runnable ? b.part.el : null;
  sim.gatewayUrl = gatewayUrl();
  const diag = sim.build(model, canvas.elements());
  if (diag.errors.length) { for (const e of diag.errors) addLog('error', e); setStatus('err', 'Rangkaian bermasalah'); return false; }
  if (prog instanceof Uint8Array) {
    if (sim.board.kind === 'avr') { addLog('error', 'Program ESP32 tidak bisa dijalankan di board ini. Tekan Kompilasi lagi.'); return false; }
    await sim.loadWasm(prog);
  } else sim.loadHex(prog);
  return true;
}
const currentProg = (b) => (b?.runnable || state.hexOnly ? (runtimeOf(b) !== 'avr' && !state.hexOnly ? state.wasm : state.hex) : IDLE_HEX);

async function run() {
  if (state.busy) return; state.busy = true; $('#btnRun').disabled = true;
  try {
    if (state.mode !== 'simulate') setMode('simulate');
    const b = boardOf();
    if (b?.runnable || state.hexOnly) {
      if (!state.hexOnly && (state.hexFor !== progKey(b) + '|' + state.libs.map((l) => l.sha).join(',') + '|' + editor.value || !currentProg(b))) { if (!(await doCompile())) return; }
      const prog = currentProg(b);
      if (!prog) { addLog('error', 'Belum ada program.'); return; }
      if (!(await buildSim(prog))) return;
      serialText = ''; serialOut.textContent = ''; btReset();
      sim.start(); addLog('info', 'Simulasi dimulai.');
    } else {
      const res = runCheck(true);
      if (b) addLog('info', `${b.cat.name}: mode desain. Daya, sensor, saklar, relay, dan motor disimulasikan; pin GPIO tidak dikendalikan karena kode ${b.cat.mcu} tidak dapat dijalankan di sini.`);
      else addLog('info', 'Tanpa mikrokontroler: rangkaian dijalankan sebagai rangkaian listrik (baterai, saklar, LED, relay, motor).');
      if (res.some((r) => r.level === 'error')) addLog('error', 'Ada kesalahan rangkaian. Lihat panel Periksa.');
      if (!(await buildSim(IDLE_HEX))) return;
      sim.start();
    }
  } catch (e) { addLog('error', e.message); setStatus('err', 'Galat'); console.error(e); }
  finally { state.busy = false; $('#btnRun').disabled = false; }
}
$('#btnRun').onclick = run; $('#btnRun2').onclick = run;
$('#btnStop').onclick = () => stopSim('Simulasi dihentikan.');
$('#btnReset').onclick = async () => {
  const b = boardOf();
  const prog = currentProg(b);
  if (!prog) { toast('Belum ada program untuk di-reset.', true); return; }
  const was = sim.running; if (await buildSim(prog)) { serialText = ''; serialOut.textContent = ''; btReset(); addLog('info', 'Program dimulai ulang dari awal.'); if (was) sim.start(); else { sim.advance(0); setStatus('', 'Berhenti'); } }
};
$('#btnCompile').onclick = async () => { if (state.busy) return; state.busy = true; try { await doCompile(); } finally { state.busy = false; } };
$('#bCompile').onclick = async () => { if (state.busy) return; state.busy = true; try { await doCompile(); updateBuildView(); } finally { state.busy = false; } };
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

// ------------------------------------------------------------------ canvas toolbar
$('#tbUndo').onclick = () => canvas.undo(); $('#tbRedo').onclick = () => canvas.redo();
$('#tbRotL').onclick = () => canvas.rotateSelected(-1); $('#tbRotR').onclick = () => canvas.rotateSelected(1);
$('#tbDup').onclick = () => { if (canvas.selected?.kind === 'part') canvas.duplicate(canvas.selected.id); };
$('#tbDel').onclick = () => canvas.deleteSelected();
// breadboard: choose what a tap on a hole does (prevents accidental wires when moving the board)
const syncBbMode = () => { const m = canvas.bbMode; $('#bbMove').classList.toggle('on', m === 'move'); $('#bbWire').classList.toggle('on', m === 'wire'); };
const syncBbGroup = () => { $('#bbModeGroup').hidden = !canvas.hasBreadboard(); };
$('#bbMove').onclick = () => { canvas.setBbMode('move'); toast('Mode Geser: seret breadboard dari lubang mana pun. Kabel tidak akan dibuat.'); };
$('#bbWire').onclick = () => { canvas.setBbMode('wire'); toast('Mode Kabel: ketuk lubang breadboard untuk membuat kabel.'); };
canvas.on('bbmode', (m) => { syncBbMode(); try { localStorage.setItem('sim.bbMode', m); } catch { /* storage blocked */ } });
canvas.on('model', syncBbGroup); canvas.on('change', syncBbGroup);
try { if (localStorage.getItem('sim.bbMode') === 'move') canvas.setBbMode('move'); } catch { /* storage blocked */ }
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
  'wokwi-esp32-devkit-v1': 'Kode ESP32 dijalankan (WiFi, HTTP, Bluetooth, Serial1/Serial2). GPIO keluaran 3,3 V. ADC2 tidak bisa dipakai saat WiFi aktif; GPIO34–39 hanya input.',
  'mod-esp32-cam': 'Kode dijalankan; kamera memakai kamera perangkat / foto yang diunggah. GPIO bebas terbatas (2, 4, 12, 13, 14, 15).',
  'wokwi-franzininho': 'ATtiny85 (ATTinyCore): pin 0–5 = PB0–PB5, LED di PB1, analog A1=PB2, A2=PB4, A3=PB3. Serial hanya kirim (TX di PB0). I2C: SDA PB0, SCL PB2.',
  'wokwi-arduino-mega': 'ATmega2560: pin 0–53, A0–A15, PWM 2–13 & 44–46, Serial1 (18/19), Serial2 (16/17), Serial3 (14/15), I2C SDA 20 / SCL 21, SPI 50–53. RAM 8 KB.',
  'mod-ds18b20': 'OneWire + DallasTemperature. Wajib resistor 4,7 kΩ antara DQ dan VDD. Beberapa sensor boleh satu jalur (dibedakan alamat ROM-nya).',
  'mod-tm1637': 'Library TM1637Display: TM1637Display d(CLK, DIO); d.setBrightness(7); d.showNumberDec(1234);',
  'wokwi-hx711': 'Library HX711 (bogde): scale.begin(DT, SCK); tare(), lalu set_scale(faktor kalibrasi). 1 mV/V × gain 128.',
  'mod-bmp280': 'Adafruit_BMP280: bmp.begin(0x76). readAltitude(1013.25) menghitung ketinggian dari tekanan.',
  'mod-bme280': 'Adafruit_BME280: bme.begin(0x76). Suhu, kelembapan, tekanan. Library BME280 tidak menerima chip BMP280 (ID berbeda).',
  'mod-max30102': 'SparkFun MAX3010x: particleSensor.begin(Wire, I2C_SPEED_FAST); IR < 50000 berarti tidak ada jari. Algoritma SpO2 butuh RAM besar (pakai ESP32/Mega).',
  'mod-max7219': 'LedControl lc(DIN, CLK, CS, 1) atau MD_MAX72XX (SPI). Bit 7 tiap baris = LED paling kiri. Ingat lc.shutdown(0, false).',
  'mod-max7219-4': 'MD_Parola P(MD_MAX72XX::FC16_HW, CS, 4); P.begin(); P.displayText(...). DIN→MOSI (11 Uno / 51 Mega), CLK→SCK (13 / 52).',
  'wokwi-ssd1306': 'OLED SPI: Adafruit_SSD1306 d(128, 64, &SPI, DC, RST, CS) atau software SPI d(128, 64, MOSI, CLK, DC, RST, CS).',
  'wokwi-ili9341': 'Adafruit_ILI9341 tft(CS, DC, RST) dengan SPI hardware (MOSI 11, SCK 13, MISO 12 pada Uno). Warna RGB565.',
  'wokwi-microsd-card': 'Library SD: SD.begin(CS). Kartu FAT16 64 MB; isi kartu tetap ada saat program diulang. DI=MOSI, DO=MISO.',
  'mod-rc522': 'Library MFRC522: MFRC522 rfid(SS, RST). Pin "SDA" = chip select SPI. Pilih kartu di properti untuk menempelkannya; kartu MIFARE 1K dengan kunci FFFFFFFFFFFF.',
  'mod-nrf24': 'Library RF24: RF24 radio(CE, CSN). VCC 3,3 V! Paket terlihat di log. Pilih "gema" untuk uji kirim-terima dengan satu board, atau pasang dua modul.',
  'mod-lora': 'LoRa (Sandeep Mistry): LoRa.setPins(NSS, RST, DIO0); LoRa.begin(433E6). Waktu kirim sesuai time-on-air sebenarnya (SF, BW).',
  'mod-gps': 'TinyGPS++ dengan SoftwareSerial(RX, TX) 9600 baud. TX GPS → pin RX Arduino. Atur posisi di properti.',
  'mod-motor-tt': 'Motor kuning 3–6 V dengan gearbox 1:48 (±200 rpm di 6 V). Kendalikan lewat L298N/MOSFET, jangan langsung dari pin.',
  'mod-motor-130': 'Motor DC kecil 3–6 V (±10.000 rpm tanpa beban). Butuh driver: MOSFET, transistor, atau L298N.',
  'mod-motor-coreless': 'Motor coreless 8520 untuk drone mini (1S 3,7 V, ±34 g gaya dorong dengan baling 65 mm). Kendalikan dengan MOSFET logic-level + PWM.',
  'mod-motor-rs385': 'Motor DC 12 V ±8.000 rpm. Gunakan L298N / MOSFET dan catu 12 V.',
  'mod-motor-rs775': 'Motor DC 12 V torsi besar (arus macet ±30 A). Gunakan MOSFET/driver arus besar.',
  'mod-bldc-a2212': 'Motor brushless A2212 1000KV (drone F450, baling 1045, 2–3S). Hubungkan A/B/C ke ESC; tukar dua fase untuk membalik arah putar.',
  'mod-bldc-2205': 'Motor brushless 2205 2300KV untuk drone racing 5 inci (3–4S). Hubungkan A/B/C ke ESC.',
  'mod-esc': 'ESC 30A: BAT+/BAT− ke LiPo, A/B/C ke motor, SIG ke pin PWM (Servo/ESP32Servo 1000–2000 µs). Arm: kirim 1000 µs ±1 detik. 5V = BEC.',
  'mod-drone-frame': 'Frame quadcopter X: motor berbaling dipasang otomatis M1 depan-kanan (CCW), M2 belakang-kanan (CW), M3 belakang-kiri (CCW), M4 depan-kiri (CW). MPU6050, BMP280 dan LIDAR ikut gerakan drone. Lihat tab Drone.',
  'mod-rc-rx': 'Receiver FS-iA6B: kanal dari remote di tab Drone. CH1–CH6 PWM (pulseIn), PPM di CH1, atau iBUS (115200) di pin IBUS → RX serial.',
  'mod-lipo': 'Baterai LiPo: pilih jumlah sel (3S = 11,1 V nominal, 12,6 V penuh), kapasitas dan C-rating. Tegangan turun saat arus besar dan saat isi berkurang.',
  'mod-vl53l0x': 'LIDAR ToF VL53L0X (I2C 0x29, 3–5 V): library VL53L0X (Pololu) atau Adafruit_VL53L0X. Jangkauan ±2 m.',
  'mod-tfluna': 'LIDAR TF-Luna: UART 115200, bingkai 9 byte 0x59 0x59 (jarak cm). Library TFMPlus. Jangkauan 0,2–8 m, daya 5 V.',
  'mod-mq135': 'MQ-135 butuh 5 V (pemanas). AO = analog (naik bila udara kotor), DO = LOW di atas ambang. Pakai library MQUnifiedsensor (kalibrasi R0 di udara bersih, CO2 = hasil + 400) atau analogRead. Panaskan ±1 menit sebelum membaca.',
  'mod-flex': 'Sensor flex: hambatan naik saat ditekuk (2.2": 25 kΩ datar → ±60 kΩ di 90°). Rangkai pembagi tegangan: 5V → flex → pin analog → resistor 47 kΩ → GND.',
  'mod-ftdi': 'Adaptor USB-Serial: terminal PC di tab USB-Serial. Silangkan TXD→RX dan RXD→TX, satukan GND. Baud terminal diatur di Properti; jumper 5V/3.3V. DTR→kapasitor→RESET untuk auto-reset.',
  'mod-hc05': 'SoftwareSerial bt(RX, TX); bt.begin(9600). Data muncul di tab Bluetooth. EN ke 5V saat menyala = mode AT (38400).',
  'mod-sim800l': 'AT command lewat Serial (9600). SMS: AT+CMGF=1, AT+CMGS="nomor", teks, lalu karakter 26 (Ctrl-Z). SMS & panggilan tampil di log.',
  'mod-esp01': 'Firmware AT (115200, bisa diubah). 3V3 dan EN ke 3,3 V. AT+CWJAP lalu AT+CIPSTART/CIPSEND mengirim HTTP sungguhan lewat browser.',
  'mod-capacitor': 'Muatan mengikuti τ = R·C (R = resistor yang terhubung ke kaki +). Perhatikan polaritas dan rating tegangan.',
  'mod-diode': 'Arus hanya mengalir dari A (anoda) ke K (katoda) dengan jatuh tegangan Vf.',
  'wokwi-ks2e-m-dc5': 'Relay 5 V tanpa driver: jangan langsung dari pin Arduino; pakai transistor + dioda flyback.',
  'wokwi-stepper-motor': 'Gunakan driver (L298N/ULN2003/A4988). Library Stepper/AccelStepper. 200 langkah = 1 putaran (1,8°).',
  'wokwi-heart-beat-sensor': 'OUT berupa denyut digital sesuai BPM.', 'wokwi-rotary-dialer': 'Pin DIAL dan PULSE pakai INPUT_PULLUP; hitung pulsa saat DIAL LOW.',
  'wokwi-ir-receiver': 'Library IRremote: IrReceiver.begin(pin). Tekan tombol remote IR di kanvas. Protokol NEC.',
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
  if (part.type === 'wokwi-microsd-card') {                    // files the sketch wrote on the virtual card
    const bh = sim.behaviors.find((b) => b._part?.id === part.id && b.files);
    let files = []; try { files = bh ? bh.files() : []; } catch { files = []; }
    html += `<div class="prop-pins"><h4>Isi kartu SD (${files.length} berkas)</h4>${files.length ? `<table>${files.map((f, i) => `<tr><td>${esc(f.name)}</td><td>${f.size} B <button class="btn" data-sd="${i}">Unduh</button></td></tr>`).join('')}</table>` : '<div class="prop-empty">Belum ada berkas. Jalankan program yang menulis ke kartu.</div>'}<button class="btn" id="sdRefresh">Muat ulang daftar</button></div>`;
    state.sdFiles = files;
  }
  html += `<div class="prop-actions"><button class="btn" id="pRot"><svg><use href="#i-rotr"/></svg><span>Putar</span></button><button class="btn" id="dupPart"><svg><use href="#i-copy"/></svg><span>Duplikat</span></button><button class="btn danger" id="delPart"><svg><use href="#i-trash"/></svg><span>Hapus</span></button></div>`;
  if (!cat?.breadboard) {
    const wired = new Set(canvas.wires.flatMap((w) => [w.a, w.b]));
    html += `<div class="prop-pins"><h4>Pin (${part.pinInfo.length})</h4><table>${part.pinInfo.map((i) => { const g = cat?.gpio?.[i.name]; return `<tr><td>${esc(canvas.pinLabel(part, i))}${typeof g === 'number' ? ` <span class="muted">GPIO${g}</span>` : ''}</td><td>${wired.has(part.id + ':' + i.name) ? 'terhubung' : '—'}</td></tr>`; }).join('')}</table></div>`;
  }
  host.innerHTML = html;
  host.querySelectorAll('[data-sd]').forEach((b) => (b.onclick = () => {
    const f = state.sdFiles?.[+b.dataset.sd]; if (!f) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([f.data()], { type: 'application/octet-stream' }));
    a.download = f.name.split('/').pop().toLowerCase(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }));
  const sdr = host.querySelector('#sdRefresh'); if (sdr) sdr.onclick = () => renderProps();
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
  editor.value = ex.code; state.exampleId = id; state.projectId = null; state.libs = []; renderLibs(); state.hex = null; state.wasm = null; state.hexFor = null; state.hexOnly = false;
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

function projectData() { const m = canvas.getModel(); return { v: 2, title: $('#projectTitle').value, code: editor.value, parts: m.parts, connections: m.connections, example: state.exampleId, libs: state.libs }; }
async function applyProject(d) {
  stopSim(); await canvas.setModel({ parts: d.parts || [], connections: d.connections || [] });
  editor.value = d.code || DEFAULT_CODE; $('#projectTitle').value = d.title || 'Proyek'; state.exampleId = d.example && EXAMPLES.find((e) => e.id === d.example)?.code === d.code && (hasExampleHex(d.example) || hasExampleWasm(d.example)) ? d.example : null;
  state.libs = Array.isArray(d.libs) ? d.libs.filter((l) => l && /^[0-9a-f]{64}$/.test(l.sha)) : []; renderLibs();
  state.hex = null; state.hexFor = null; state.hexOnly = false; updateBoardInfo(); runCheck();
}
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const fname = () => ($('#projectTitle').value || 'proyek').replace(/[^\w\-]+/g, '_').slice(0, 40);
let fileMode = null;
async function doAction(act) {
  switch (act) {
    case 'new': stopSim(); await canvas.setModel({ parts: [], connections: [] }); editor.value = DEFAULT_CODE; state.exampleId = null; state.libs = []; renderLibs(); state.hex = null; state.hexFor = null; $('#projectTitle').value = 'Proyek tanpa judul'; history.replaceState(null, '', location.pathname); updateBoardInfo(); runCheck(); break;
    case 'export-json': download(fname() + '.json', JSON.stringify(projectData(), null, 2), 'application/json'); break;
    case 'export-ino': download(fname() + '.ino', editor.value); break;
    case 'export-hex': if (state.hex) download(fname() + '.hex', state.hex); else toast(state.wasm ? 'File .hex hanya untuk Uno/Nano. Untuk ESP32 unduh .ino lalu unggah lewat Arduino IDE.' : 'Belum ada hasil kompilasi. Tekan Kompilasi dulu.', true); break;
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
$('#setSave').onclick = () => { saveSettings({ url: $('#setUrl').value.trim() }); toast('Pengaturan disimpan.'); updateBuildView(); renderLibs(); };
$('#setTest').onclick = async () => { $('#setStatus').textContent = 'Menguji…'; const r = await testServer($('#setUrl').value); $('#setStatus').textContent = r.text; };
function openHelp() {
  $('#helpTitle').textContent = 'Cara pakai';
  $('#helpBody').innerHTML = `<h4>Menambah komponen</h4><ul><li>Ketuk kartu komponen untuk menaruhnya di tengah kanvas.</li><li>Di iPad: tahan kartu sebentar lalu seret ke kanvas. Dengan mouse: langsung seret.</li><li>Letakkan komponen di atas breadboard: kakinya menempel otomatis ke lubang terdekat.</li></ul>
  <h4>Membuat kabel</h4><ul><li>Ketuk pin pertama, lalu ketuk pin tujuan. Atau seret dari pin ke pin.</li><li>Ketuk kabel untuk memilih, lalu ganti warna atau hapus di panel Properti.</li></ul>
  <h4>Kanvas</h4><ul><li>Satu jari di area kosong: geser kanvas. Dua jari: cubit untuk zoom.</li><li>Seret komponen untuk memindah. Saat simulasi berjalan, seret lewat label nama di atasnya.</li><li>Tombol putar, duplikat, hapus, urungkan/ulangi ada di toolbar atas.</li></ul>
  <h4>Simulasi</h4><ul><li>Desain → Kode → Simulasi. Tekan <b>Jalankan</b>; galat kompilasi muncul di Log dengan nomor baris yang bisa diketuk.</li><li>Ubah nilai sensor (suhu, jarak, kelembapan…) di panel Properti saat simulasi berjalan.</li><li>Kode dijalankan untuk Arduino Uno/Nano, ESP32 DevKit, ESP32-CAM, NodeMCU / Wemos D1 mini (ESP8266) dan Raspberry Pi Pico.</li></ul>
  <h4>ESP32: WiFi, internet, Bluetooth, kamera</h4><ul><li><b>WiFi</b> tersimulasi: <code>WiFi.begin()</code> tersambung ±1 detik (nama/password bebas, mis. "Wokwi-GUEST"), IP 10.10.0.2.</li><li><b>Internet nyata</b>: <code>HTTPClient</code> (GET/POST, http/https) memakai koneksi iPad/laptop ini; layanan tanpa izin CORS otomatis lewat proxy simulator.</li><li><b>Blynk, Telegram, MQTT, ThingSpeak</b>: <code>WiFiClient</code> / <code>WiFiClientSecure</code> / <code>WiFiUDP</code> tersambung sungguhan lewat <b>gateway IoT</b> server kompilasi (seperti Wokwi), jadi library asli (BlynkSimpleEsp32, UniversalTelegramBot, PubSubClient…) dan API key asli langsung bisa dipakai.</li><li><b>Library</b>: <code>#include</code> library dari Arduino Library Manager diunduh otomatis. Library .zip (mis. Edge Impulse) ditambahkan di panel <b>Library</b>.</li><li><b>Bluetooth</b>: <code>BluetoothSerial</code> tersambung ke tab <b>Bluetooth</b> di konsol (seperti aplikasi Serial Bluetooth Terminal di HP).</li><li><b>ESP32-CAM</b>: <code>esp_camera_fb_get()</code> mengambil foto JPEG dari tab <b>Kamera</b>: kamera iPad/laptop, foto unggahan, atau gambar contoh.</li><li>Seperti ESP32 asli: ADC2 (GPIO 0, 2, 4, 12–15, 25–27) tidak bisa dibaca saat WiFi aktif — pakai GPIO 32–39. GPIO 34–39 hanya input. Logika 3,3 V.</li><li><b>Edge Impulse</b>: unggah ekspor "Arduino library" di panel Library; ESP32-CAM memakai gambar dari tab Kamera (<code>fmt2rgb888</code> didukung).</li><li>Belum didukung: WebServer / server di dalam ESP32 (gateway hanya koneksi keluar), Bluetooth BLE, FreeRTOS task. Waktu CPU diperkirakan, bukan akurat per siklus.</li></ul>`;
  $('#dlgHelp').showModal();
}
function openAbout() {
  $('#helpTitle').textContent = 'Tentang simulator';
  $('#helpBody').innerHTML = `<p>Emulator AVR ATmega328P (avr8js) dan runtime Arduino-ESP32/ESP8266/Pico berbasis WebAssembly (kode dikompilasi dengan clang, WiFi/HTTP/Bluetooth/kamera lewat perangkat ini), dengan pemecah rangkaian, ${CATALOG.length} komponen (${CATALOG.filter((c) => c.sim === 'full').length} disimulasikan), I2C (LCD, OLED, MPU6050, RTC), DHT11/22, relay, motor & driver, breadboard, dan pemeriksaan rangkaian ESP32 (3,3 V, ADC1/ADC2, strapping).</p><p class="muted small">Komponen Wokwi Elements (MIT). Dibuat untuk pembelajaran STEAM.</p>`;
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
