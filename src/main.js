import { parseWiring, applyWiring, wiringToText } from './ui/wiretext.js';
import { initPinMap } from './ui/pinmap.js';
import '@wokwi/elements';
import './style.css';
import { registerParts } from './parts/index.js';
import { CATALOG, CATEGORIES, BY_TAG } from './catalog.js';
import { Simulator, IDLE_HEX } from './sim/sim.js';
import { checkDesign } from './sim/drc.js';
import { CircuitCanvas } from './ui/canvas.js';
import { Editor } from './ui/editor.js';
import { initDroneView } from './ui/droneview.js';
import { initDevice, setDeviceMode, onDeviceChange, isNarrow, isPhone, effectiveDevice, DEVICE_NAMES } from './ui/device.js';
import { compile, loadSettings, saveSettings, testServer, compileEndpoint, parseDiagnostics, gatewayUrl, compileBase } from './compile.js';
import { putZip, getZip, sha256, describeZip } from './libs.js';
import { saveProject, loadProject, sharingAvailable } from './store.js';
import { EXAMPLES, exampleModel, EXAMPLE_GROUPS } from './examples/defs.js';
import { exampleHexText, hasExampleHex, exampleWasm, hasExampleWasm } from './examples/pack.js';
import { initI18n, setLang, LANG, tr } from './i18n.js';
initI18n();

registerParts();
initDevice();
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
for (const [id, fn] of [['#wireCancel', () => canvas.cancelWire()], ['#wireUndoBend', () => canvas.undoBend()]]) {
  const b = $(id); b.addEventListener('pointerdown', (e) => e.stopPropagation()); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
}
$('#wireHint').addEventListener('pointerdown', (e) => e.stopPropagation());
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
  if (state.panel === 'props' || (sim.running && s && !isNarrow())) showPanel('props', true);
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
$('#logClear').onclick = () => { if (consoleTab === 'serial') { serialText = ''; $('#serialOut').textContent = ''; } else if (consoleTab === 'bt') $('#btOut').textContent = ''; else if (consoleTab === 'ftdi') ftdiClear(); else if (consoleTab === 'now') $('#nowOut').textContent = ''; else { $('#logList').textContent = ''; errCount = 0; $('#logBadge').hidden = true; } };
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
    ? 'Library tidak tersedia. Sudah terpasang untuk Uno/Nano/Mega: Servo, LiquidCrystal(_I2C), Adafruit NeoPixel/GFX/SSD1306/ILI9341/BMP280/BME280/MPU6050/ADS1X15/VL53L0X, FastLED, U8g2, DHT, RTClib, OneWire + DallasTemperature, HX711, TM1637, LedControl, MD_Parola, MFRC522, RF24, LoRa, TinyGPS++, IRremote, SD, Keypad, Stepper, AccelStepper, NewPing, RotaryEncoder, MPU6050 (I2Cdev), MPU6050_light, BH1750, ACS712, L298N, GravityTDS, DFRobot_PH, MQUnifiedsensor, MQ135, VL53L0X, TFMPlus, IBusBM, TinyGSM, SoftwareSerial, EEPROM. Periksa ejaan nama file .h.'
    : 'Library tidak tersedia. ESP32/ESP8266/RP2040 punya WiFi, HTTPClient, WiFiClientSecure, ArduinoJson, BluetoothSerial, Preferences, EEPROM, Ticker, ESP32Servo, esp_camera, plus semua library Uno (FastLED, U8g2, DHTesp, Blynk, UniversalTelegramBot, PubSubClient, ThingSpeak, DFRobot_ESP_EC/PH, ...). Library lain diunduh otomatis dari Arduino Library Manager; periksa ejaan nama file .h.';
  if (/expected unqualified-id/.test(msg)) {
    if (/numeric constant|before [‘'"]?\d/.test(msg)) return 'Nama di baris ini sudah dipakai oleh #define atau nama bawaan Arduino (mis. LED, A0, HIGH, LED_BUILTIN). Ganti nama variabelnya, atau hapus #define yang sama.';
    if (/before [‘'"]?(if|for|while|switch|return|Serial|delay|digitalWrite|analogWrite|pinMode)\b/.test(msg)) return 'Perintah ini berada di luar fungsi. Pindahkan ke dalam void setup() { } atau void loop() { }; biasanya ada kurung kurawal } berlebih di atasnya yang menutup fungsi terlalu cepat.';
    if (/before [‘'"]?\{/.test(msg)) return 'Hapus titik koma setelah nama fungsi (contoh salah: void setup(); { ... }), atau tambahkan nama fungsi sebelum kurung kurawal {.';
    return 'Ada kode yang berada di luar fungsi atau kurung kurawal } berlebih. Periksa baris ini dan baris di atasnya: setiap perintah harus di dalam void setup() { } atau void loop() { }, dan jangan memakai nama yang sama dengan #define.';
  }
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
  $('#dronePane').hidden = name !== 'drone'; $('#nowPane').hidden = name !== 'now'; $('#console').classList.toggle('tall', name === 'drone'); $('#console').classList.toggle('mid', name === 'now'); droneView?.show(name === 'drone');
  if (name === 'now') $('#nowBadge').hidden = true;
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
// ------------------------------------------------------------------ ESP-NOW tab: a virtual partner board (remote control)
const NOW_REMOTE = [0x24, 0x6f, 0x28, 0xaa, 0xbb, 0xcc], hex2 = (b) => b.toString(16).padStart(2, '0').toUpperCase();
const macStr = (m) => [...m].map(hex2).join(':');
const nowOut = $('#nowOut'); let nowSentLast = '', nowRepeat = null, nowJoy = { x: 0, y: 0, b: 0 }, nowJoyT = 0;
$('#nowMacs').textContent = `remote ${macStr(NOW_REMOTE)} · board 24:A1:60:2E:3C:10`;
function nowLog(text, cls) {
  const sp = document.createElement('span'); sp.className = cls; sp.textContent = text + '\n'; nowOut.append(sp);
  while (nowOut.childNodes.length > 500) nowOut.firstChild.remove();
  nowOut.scrollTop = nowOut.scrollHeight;
}
const printable = (b) => [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
const nowDescribe = (b) => `${b.length} byte  "${printable(b).slice(0, 48)}"  ${[...b.slice(0, 24)].map(hex2).join(' ')}${b.length > 24 ? ' …' : ''}`;
function nowSend(bytes, quiet) {
  if (!sim.running) { toast('Jalankan simulasi dulu untuk mengirim paket ESP-NOW.', true); return false; }
  if (!sim.espnowActive) { toast('Program belum memanggil esp_now_init().', true); return false; }
  sim.espnowSend(NOW_REMOTE, bytes);
  const d = nowDescribe(bytes);
  if (!quiet || d !== nowSentLast) nowLog(`→ ${d}`, 'me'); nowSentLast = d;
  return true;
}
sim.on('espnow', (e) => {
  if (e.type === 'init') { $('#nowDot').className = 'dot on'; $('#nowName').textContent = 'ESP-NOW aktif (esp_now_init). Remote virtual siap.'; $('#tabNow').hidden = false; nowLog('· esp_now_init() — board siap menerima', 'sys'); }
  else if (e.type === 'deinit') { $('#nowDot').className = 'dot'; $('#nowName').textContent = 'ESP-NOW dimatikan (esp_now_deinit).'; }
  else if (e.type === 'send') { nowLog(`← dari board ke ${macStr(e.mac)}: ${nowDescribe(e.data)}`, 'rx'); if (consoleTab !== 'now') $('#nowBadge').hidden = false; }
});
sim.on('state', (s) => { if (s !== 'running') { $('#nowDot').className = 'dot'; clearInterval(nowRepeat); nowRepeat = null; } });
const nowFmt = () => $('#nowFmt').value;
const nowMap = () => { const m = $('#nowMap').value.trim().split(/\s+/); return ['F', 'B', 'L', 'R', 'S'].map((d, i) => (m[i] || d)[0]); };
function joyBytes() {
  if (nowFmt() === 'joy8') return Uint8Array.from([Math.round((nowJoy.x + 100) * 1.275), Math.round((nowJoy.y + 100) * 1.275), nowJoy.b]);
  const b = new Uint8Array(12), dv = new DataView(b.buffer); dv.setInt32(0, nowJoy.x, true); dv.setInt32(4, nowJoy.y, true); dv.setInt32(8, nowJoy.b, true); return b;
}
// direction pad: hold to repeat (5 packets / s like a real remote), release sends "stop" in character mode
const PAD_JOY = [[0, 100], [0, -100], [-100, 0], [100, 0], [0, 0]];
function padPress(k) {
  const f = nowFmt();
  const once = () => {
    if (f === 'char' || f === 'text') return nowSend(Uint8Array.from([nowMap()[k].charCodeAt(0) & 0xff]), true);
    [nowJoy.x, nowJoy.y] = PAD_JOY[k]; return nowSend(joyBytes(), true);
  };
  clearInterval(nowRepeat); if (once() && k !== 4) nowRepeat = setInterval(once, 200);
  $$('#nowPad button').forEach((b) => b.classList.toggle('on', +b.dataset.k === k && k !== 4));
}
function padRelease() {
  if (!nowRepeat) { $$('#nowPad button').forEach((b) => b.classList.remove('on')); return; }
  clearInterval(nowRepeat); nowRepeat = null; $$('#nowPad button').forEach((b) => b.classList.remove('on'));
  if (nowFmt() === 'char' || nowFmt() === 'text') nowSend(Uint8Array.from([nowMap()[4].charCodeAt(0) & 0xff]), true);
  else { nowJoy.x = 0; nowJoy.y = 0; nowSend(joyBytes(), true); }
}
$('#nowPad').addEventListener('pointerdown', (e) => { const b = e.target.closest('[data-k]'); if (!b) return; e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* synthetic */ } padPress(+b.dataset.k); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#nowPad').addEventListener(ev, () => padRelease());
$('#nowPad').addEventListener('click', (e) => e.preventDefault());
const NOW_KEYS = { ArrowUp: 0, w: 0, ArrowDown: 1, s: 1, ArrowLeft: 2, a: 2, ArrowRight: 3, d: 3, ' ': 4 };
$('#nowPane').addEventListener('keydown', (e) => { if (e.target.closest('input, select')) return; const k = NOW_KEYS[e.key]; if (k === undefined || e.repeat) return; e.preventDefault(); padPress(k); });
$('#nowPane').addEventListener('keyup', (e) => { if (e.target.closest('input, select')) return; if (NOW_KEYS[e.key] !== undefined) { e.preventDefault(); padRelease(); } });
// joystick (struct modes)
const syncNowFmt = () => { const joy = nowFmt().startsWith('joy'); $('#nowJoy').hidden = !joy; $('#nowMapRow').hidden = joy || nowFmt() === 'text'; };
$('#nowFmt').onchange = () => { syncNowFmt(); nowLog(`· format kirim: ${$('#nowFmt').selectedOptions[0].textContent}`, 'sys'); };
syncNowFmt();
(() => {
  const st = $('#nowStick'), knob = st.querySelector('.knob'), val = st.querySelector('.val'); let id = null;
  const show = () => { knob.style.transform = `translate(${nowJoy.x * 0.42}px, ${-nowJoy.y * 0.42}px)`; val.textContent = `x ${nowJoy.x} · y ${nowJoy.y}`; };
  const move = (e) => {
    const r = st.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * 2 - 1, y = (e.clientY - r.top) / r.height * 2 - 1;
    nowJoy.x = Math.round(Math.max(-1, Math.min(1, x)) * 100); nowJoy.y = Math.round(-Math.max(-1, Math.min(1, y)) * 100); show();
    const now = performance.now(); if (now - nowJoyT > 60) { nowJoyT = now; nowSend(joyBytes(), true); }
  };
  st.addEventListener('pointerdown', (e) => { id = e.pointerId; try { st.setPointerCapture(id); } catch { /* synthetic */ } move(e); });
  st.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; nowJoy.x = 0; nowJoy.y = 0; show(); if (sim.running) nowSend(joyBytes(), true); };
  st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
  show();
  const btn = $('#nowBtn');
  btn.addEventListener('pointerdown', () => { nowJoy.b = 1; nowSend(joyBytes(), true); btn.classList.add('primary'); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => { if (!nowJoy.b) return; nowJoy.b = 0; btn.classList.remove('primary'); nowSend(joyBytes(), true); });
})();
// free text / hex bytes
$('#nowForm').onsubmit = (e) => {
  e.preventDefault(); const v = $('#nowIn').value; if (!v) return;
  const hex = /^\s*(0x[0-9a-f]{1,2}\s*)+$/i.test(v) ? v.trim().split(/\s+/).map((h) => parseInt(h, 16)) : null;
  if (nowSend(hex ? Uint8Array.from(hex) : new TextEncoder().encode(v))) $('#nowIn').value = '';
};

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
  const hadNow = !$('#tabNow').hidden; $('#tabNow').hidden = !(['esp32', 'esp8266'].includes(kind) && /#\s*include\s*[<"](esp_now|espnow)\.h/.test(editor.value)) && !sim.espnowActive;
  if (!hadNow && !$('#tabNow').hidden) addLog('info', 'Tab ESP-NOW tersedia: remote virtual (tombol arah / joystick) mengirim paket ESP-NOW ke board, paket dari board tampil di sana.');
  if ((consoleTab === 'bt' && $('#tabBt').hidden) || (consoleTab === 'cam' && $('#tabCam').hidden) || (consoleTab === 'ftdi' && $('#tabFtdi').hidden) || (consoleTab === 'drone' && $('#tabDrone').hidden) || (consoleTab === 'now' && $('#tabNow').hidden)) showConsole('log');
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
  if (m === 'design' && !isNarrow() && state.panel === 'props' && !canvas.selected) showPanel('parts', true);
  if (m === 'build') updateBuildView();
  if (m === 'design') requestAnimationFrame(() => { canvas._applyView(); if (!state.fittedOnce) { canvas.fit(); state.fittedOnce = true; } });
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
    if (state.mode !== 'design') setMode('design');
    if (!isPhone()) $('#console').classList.remove('collapsed');
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
let partCat = 'Semua';
const chips = $('#catChips');
chips.innerHTML = ['Semua', ...CATEGORIES].map((c) => `<button class="chip${c === 'Semua' ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('');
chips.onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; partCat = b.dataset.c; chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === b)); renderPalette(); };
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
    const items = CATALOG.filter((c) => c.cat === cat && (!q || (c.name + ' ' + c.tag + ' ' + (c.keywords || '')).toLowerCase().includes(q)));
    if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.textContent = `${cat} · ${items.length}`; host.append(h);
    const grid = document.createElement('div'); grid.className = 'grid'; host.append(grid);
    for (const c of items) {
      n++;
      const card = document.createElement('div'); card.className = 'card'; card.dataset.tag = c.tag; card.title = c.name;
      card.innerHTML = `<div class="thumb" data-tag="${c.tag}"></div><span class="nm">${esc(c.name)}</span>`;
      grid.append(card); thumbObserver.observe(card.querySelector('.thumb'));
      bindCard(card, c);
    }
  }
  if (!n) host.innerHTML = '<div class="prop-empty">Tidak ada komponen yang cocok.</div>';
  $('#partCount').textContent = n === CATALOG.length ? `${n} komponen · semua bisa disimulasikan` : `${n} dari ${CATALOG.length} komponen`;
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
  if (state.mode !== 'design') setMode('design');
  const id = await canvas.addPart(tag, Math.round(x / 5) * 5, Math.round(y / 5) * 5);
  if (id && isNarrow()) $('#workspace').classList.add('lp-closed'), $$('.rail-btn').forEach((b) => b.classList.remove('on'));
  if (id) toast(`${BY_TAG[tag].name} ditambahkan (${id})`);
}
function addAtCenter(tag) {
  if (state.mode !== 'design') setMode('design');
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
  'mod-gps-m8n': 'u-blox NEO-M8N: GPS + GLONASS/Galileo/BeiDou sekaligus, 9600 baud, kalimat $GNRMC/$GNGGA (TinyGPS++ 1.x membacanya). VCC 3,3–5 V (ada regulator di modul). TX GPS → RX mikrokontroler: ESP32 Serial2 (GPIO16), Mega Serial1 (pin 19), Uno SoftwareSerial. Fix pertama di luar ruangan ±30 detik; LED biru berkedip tiap detik saat fix.',
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
  'mod-car-chassis': 'Sasis 2WD: ML+/ML− ke OUT1/OUT2 dan MR+/MR− ke OUT3/OUT4 driver L298N. ML+ lebih positif = roda kiri maju. Letakkan ESP32, driver, baterai dan sensor di atas sasis: di 3D semuanya ikut mobil. HC-SR04 / VL53L0X / FC-51 / TCRT5000 di atas sasis membaca arena (dinding, rintangan, garis hitam). Tekan 3D lalu Jalankan.',
};
const WIRE_COLORS = ['#e11d48', '#1f2937', '#f5a524', '#2fbf71', '#3d8bfd', '#a855f7', '#06b6d4', '#fb923c', '#ffffff'];
function renderProps(soft) {
  const host = $('#propsBody'); const sel = canvas.selected;
  if (!sel) { host.innerHTML = '<div class="prop-empty">Ketuk komponen atau kabel di kanvas untuk melihat dan mengubah propertinya.</div>'; return; }
  if (sel.kind === 'wire') {
    const w = canvas.wires.find((x) => x.id === sel.id); if (!w) return;
    host.innerHTML = `<div class="prop-h"><b>Kabel</b><code>${esc(w.a)} → ${esc(w.b)}</code></div><div class="swatches">${WIRE_COLORS.map((c) => `<button class="swatch${c === w.color ? ' on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div><div class="prop-actions"><button class="btn" id="tidyWire" title="Jalur siku rapi dari pin ke pin">Rapikan kabel ini</button><button class="btn" id="bendClear"${w.pts?.length ? '' : ' disabled'}>Hapus belokan (${w.pts?.length || 0})</button><button class="btn" id="tidyAll">Rapikan semua kabel</button><button class="btn" id="bundleWire" title="Satukan semua kabel antara dua komponen ini jadi satu bundel rapi">${w.bundle ? 'Lepas bundel' : 'Bundel kabel ke komponen ini'}</button><button class="btn" id="bundleAll">Bundel semua kabel</button><button class="btn danger" id="delWire"><svg><use href="#i-trash"/></svg><span>Hapus kabel</span></button></div><div class="prop-hint">Seret badan kabel untuk menggeser jalurnya (mengikuti jari / mouse). Seret titik ● untuk memindah belokan, seret tanda + di tengah segmen untuk menambah belokan, ketuk ganda ● untuk menghapusnya.</div>`;
    host.querySelectorAll('.swatch').forEach((b) => (b.onclick = () => { canvas.setWireColor(w.id, b.dataset.c); renderProps(); }));
    $('#tidyWire').onclick = () => { canvas.tidyWires(w.id); renderProps(); }; $('#bendClear').onclick = () => { canvas.clearBends(w.id); renderProps(); }; $('#tidyAll').onclick = () => { canvas.tidyWires(); renderProps(); };
    $('#bundleWire').onclick = () => { if (w.bundle) canvas.unbundle(w.id); else { const n = canvas.bundleWires(w.id); toast(n ? `${n} kabel dibundel.` : 'Bundel butuh minimal 2 kabel antara dua komponen yang sama.'); } renderProps(); };
    $('#bundleAll').onclick = () => { const n = canvas.bundleWires(); toast(n ? `${n} kabel disatukan jadi bundel.` : 'Belum ada 2+ kabel antara dua komponen yang sama.'); renderProps(); };
    $('#delWire').onclick = () => canvas.deleteSelected(); return;
  }
  const part = canvas.parts.get(sel.id); if (!part) return; const cat = BY_TAG[part.type];
  if (soft && host.dataset.pid === part.id && document.activeElement?.closest?.('#propsBody')) {
    for (const inp of host.querySelectorAll('[data-k]')) { const p = cat.props.find((x) => x.key === inp.dataset.k); const v = part.attrs[p.key]; if (p.type === 'range' && document.activeElement !== inp) { inp.value = v; inp.parentElement.querySelector('.prop-val').textContent = v + (p.unit || ''); } }
    return;
  }
  host.dataset.pid = part.id;
  const badge = cat?.sim === 'design' ? ['#fff3db', '#9a6400', 'Mode desain: wiring dicek, kode tidak dijalankan'] : cat?.sim === 'visual' ? ['#eceff3', '#6b7385', 'Tampilan saja'] : null;
  let html = `<div class="prop-h"><b>${esc(cat?.name || part.type)}</b><code>${esc(part.id)}</code></div>${badge ? `<span class="prop-badge" style="background:${badge[0]};color:${badge[1]}">${badge[2]}</span>` : ''}`;
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
  state.localId = null; savedSnap = null; refreshDirty();
  stopSim(); await canvas.setModel(exampleModel(ex));
  try {                                                        // examples are built on a breadboard, with right-angle wiring
    const { autoBreadboard } = await import('./ui/autobb.js');
    state.autobb = ex.noBB || [...canvas.parts.values()].some((p) => BY_TAG[p.type]?.breadboard) ? { ok: true, existing: true } : await autoBreadboard(canvas, BY_TAG, { tidy: false });
    if (ex.noBB) canvas.tidyWires(); else canvas.bundleWires();
    canvas.history = []; canvas.hpos = -1; canvas.snapshot();
  } catch (e) { console.warn('breadboard layout', e); }
  editor.value = ex.code; state.exampleId = id; state.projectId = null; state.libs = []; renderLibs(); state.hex = null; state.wasm = null; state.hexFor = null; state.hexOnly = false;
  $('#projectTitle').value = tr(ex.title); editor.marks.clear();
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
$$('.menu > .mb, #btnDevice').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const m = b.parentElement, o = m.classList.contains('open'); closeMenus(); if (!o) m.classList.add('open'); }));
// language: the page reloads in the other language; the current project is carried over in sessionStorage
function switchLang(l) {
  if (l === LANG) return;
  try { sessionStorage.setItem('sim.carry', JSON.stringify({ ...projectData(), localId: state.localId || null, savedSnap })); } catch { /* storage blocked: the default example loads */ }
  state.switchingLang = true;
  setLang(l);
}
$$('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === LANG));
$('#btnLang').textContent = LANG.toUpperCase();
$('#btnLang').onclick = () => switchLang(LANG === 'en' ? 'id' : 'en');
$('#menuDevice .menu-pop').addEventListener('click', (e) => {
  const lb = e.target.closest('[data-lang]'); if (lb) { closeMenus(); switchLang(lb.dataset.lang); return; }
  const b = e.target.closest('[data-dev]'); if (!b) return; closeMenus(); setDeviceMode(b.dataset.dev);
  toast(`Mode tampilan: ${DEVICE_NAMES[b.dataset.dev]}${b.dataset.dev === 'auto' ? ' (' + DEVICE_NAMES[effectiveDevice()] + ')' : ''}`);
});
// layout changed (rotation, window resize, chosen mode): panels and canvas follow
onDeviceChange(() => {
  if (isNarrow() && !$('#workspace').classList.contains('lp-closed')) { $('#workspace').classList.add('lp-closed'); $$('.rail-btn').forEach((b) => b.classList.remove('on')); }
  if (isPhone() && !sim.running) $('#console').classList.add('collapsed');
  requestAnimationFrame(() => { canvas._applyView(); editor._sync?.(); });
});
if (isPhone()) $('#console').classList.add('collapsed');
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

/** empty canvas, default sketch: what the site opens with (examples only load when chosen or linked with #ex=) */
async function newProject() {
  state.localId = null; savedSnap = null; refreshDirty(); stopSim(); await canvas.setModel({ parts: [], connections: [] });
  editor.value = DEFAULT_CODE; state.exampleId = null; state.libs = []; renderLibs(); state.hex = null; state.hexFor = null;
  $('#projectTitle').value = tr('Proyek tanpa judul'); if (location.hash || location.search) history.replaceState(null, '', location.pathname);
  updateBoardInfo(); runCheck();
}
function projectData() { const m = canvas.getModel(); return { v: 2, title: $('#projectTitle').value, code: editor.value, parts: m.parts, connections: m.connections, example: state.exampleId, libs: state.libs }; }
async function applyProject(d) {
  stopSim(); await canvas.setModel({ parts: d.parts || [], connections: d.connections || [] });
  editor.value = d.code || DEFAULT_CODE; { const ex = EXAMPLES.find((e) => e.title === d.title || tr(e.title) === d.title); $('#projectTitle').value = ex ? tr(ex.title) : (d.title || tr('Proyek')); } state.exampleId = d.example && EXAMPLES.find((e) => e.id === d.example)?.code === d.code && (hasExampleHex(d.example) || hasExampleWasm(d.example)) ? d.example : null;
  state.libs = Array.isArray(d.libs) ? d.libs.filter((l) => l && /^[0-9a-f]{64}$/.test(l.sha)) : []; renderLibs();
  state.hex = null; state.hexFor = null; state.hexOnly = false; updateBoardInfo(); runCheck();
}
function download(name, text, type = 'text/plain') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const fname = () => ($('#projectTitle').value || 'proyek').replace(/[^\w\-]+/g, '_').slice(0, 40);
let fileMode = null;
async function doAction(act) {
  switch (act) {
    case 'new': await newProject(); break;
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
    case 'wire-text': openWireText(); break;
    case 'auto-wire': autoWire(); break;
    case 'extras': offerExtras({ manual: true }); break;
    case 'newbie': toggleNewbie(); break;
    case 'auto-bb': {
      stopSim(); const { autoBreadboard } = await import('./ui/autobb.js'); const r = await autoBreadboard(canvas, BY_TAG);
      if (r.ok) { toast(`${r.placed.length} komponen ditancapkan ke breadboard, ${r.wires} kabel dirapikan.`); addLog('ok', `Breadboard: ${r.placed.join(', ')} ditancapkan; semua sambungan listrik tetap sama.`); runCheck(); }
      else toast(r.reason, true);
      break;
    }
    case 'bundle-wires': { const n = canvas.bundleWires(); toast(n ? `${n} kabel disatukan jadi bundel rapi.` : 'Belum ada 2+ kabel antara dua komponen yang sama.'); break; }
    case 'tidy-wires': toast(canvas.tidyWires() ? 'Semua kabel dirapikan (jalur siku).' : 'Belum ada kabel.'); break;
    case 'clear-wires': for (const w of [...canvas.wires]) if (!w.plug) canvas._removeWire(w, true); canvas.emit('change', { structural: true }); break;
    case 'help': openHelp(); break; case 'about': openAbout(); break;
    case 'save': saveLocal(); break; case 'saved': openSaved(); break;
  }
}
$$('.menu-pop').forEach((m) => (m.onclick = (e) => { const b = e.target.closest('[data-act]'); if (b) { closeMenus(); doAction(b.dataset.act); } }));
$$('[data-act2]').forEach((b) => (b.onclick = () => doAction(b.dataset.act2)));
$('#fileIn').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; const text = await f.text();
  try {
    if (fileMode === 'json') { const d = JSON.parse(text); if (!Array.isArray(d.parts)) throw new Error('Berkas bukan proyek simulator (tidak ada daftar komponen).'); await applyProject(d); state.localId = null; savedSnap = null; refreshDirty(); toast('Proyek dibuka.'); }
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
// ------------------------------------------------------------------ save on this device (localStorage)
const SAVE_KEY = 'sim.projects';
const savedAll = () => { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') || {}; } catch { return {}; } };
let savedSnap = null, dirtyT = 0;
const snapOf = () => { const d = projectData(); return JSON.stringify([d.title, d.code, d.parts, d.connections]); };
function refreshDirty() { const dirty = savedSnap !== null && snapOf() !== savedSnap; $('#btnSave .dirty-dot').hidden = !dirty; }
function markDirty() { clearTimeout(dirtyT); dirtyT = setTimeout(refreshDirty, 400); }
function markClean() { savedSnap = snapOf(); refreshDirty(); }
function saveLocal() {
  const all = savedAll(), id = state.localId || 'p' + Date.now().toString(36);
  const data = projectData(); data.title = data.title.trim() || tr('Proyek tanpa judul');
  all[id] = { id, title: data.title, savedAt: Date.now(), parts: data.parts.length, data };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(all)); }
  catch { toast('Penyimpanan perangkat penuh atau diblokir. Pakai Berkas → Unduh proyek (.json).', true); return; }
  state.localId = id; markClean();
  toast(`Proyek "${data.title}" disimpan di perangkat ini (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).`);
}
function openSaved() {
  const list = Object.values(savedAll()).sort((a, b) => b.savedAt - a.savedAt), host = $('#savedList');
  host.innerHTML = list.length ? list.map((p) => `<div class="saved-item${p.id === state.localId ? ' cur' : ''}"><div class="meta"><b>${esc(p.title)}</b><span class="muted small">${new Date(p.savedAt).toLocaleString()} · ${p.parts} komponen</span></div><button type="button" class="btn" data-open="${p.id}">Buka</button><button type="button" class="btn danger" data-del="${p.id}" title="Hapus dari perangkat ini"><svg><use href="#i-trash"/></svg></button></div>`).join('')
    : '<div class="saved-empty muted">Belum ada proyek tersimpan. Tekan Simpan untuk menyimpan proyek yang sedang dibuka.</div>';
  $('#dlgSaved').open || $('#dlgSaved').showModal();
}
$('#savedList').onclick = async (e) => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), all = savedAll();
  if (o && all[o.dataset.open]) {
    if (savedSnap !== null && snapOf() !== savedSnap && !confirm('Perubahan yang belum disimpan akan hilang. Lanjutkan?')) return;
    $('#dlgSaved').close(); await applyProject(all[o.dataset.open].data); state.localId = o.dataset.open; history.replaceState(null, '', location.pathname); markClean(); toast('Proyek dibuka.');
  } else if (d && all[d.dataset.del] && confirm(`Hapus "${all[d.dataset.del].title}" dari perangkat ini?`)) {
    delete all[d.dataset.del]; try { localStorage.setItem(SAVE_KEY, JSON.stringify(all)); } catch { /* ignore */ }
    if (state.localId === d.dataset.del) { state.localId = null; refreshDirty(); }
    openSaved();
  }
};
$('#btnSave').onclick = saveLocal;
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveLocal(); } });
canvas.on('change', markDirty); $('#projectTitle').addEventListener('input', markDirty); $('#code').addEventListener('input', markDirty);
window.addEventListener('beforeunload', (e) => { if (state.localId && savedSnap !== null && snapOf() !== savedSnap && !state.switchingLang) { e.preventDefault(); e.returnValue = ''; } });

$('#shareCopy').onclick = async () => { const i = $('#shareUrl'); i.select(); try { await navigator.clipboard.writeText(i.value); toast('Tautan disalin.'); } catch { document.execCommand('copy'); toast('Tautan disalin.'); } };

// ------------------------------------------------------------------ settings, help, theme
function openSettings() { const s = loadSettings(); $('#setUrl').value = s.url || ''; $('#setStatus').textContent = compileEndpoint() ? 'Endpoint aktif: ' + compileEndpoint() : 'Belum ada server kompilator.'; $('#dlgSettings').showModal(); }
$('#setSave').onclick = () => { saveSettings({ url: $('#setUrl').value.trim() }); toast('Pengaturan disimpan.'); updateBuildView(); renderLibs(); };
$('#setTest').onclick = async () => { $('#setStatus').textContent = 'Menguji…'; const r = await testServer($('#setUrl').value); $('#setStatus').textContent = r.text; };
function openHelp() {
  $('#helpTitle').textContent = 'Cara pakai';
  $('#helpBody').innerHTML = `<h4>Menambah komponen</h4><ul><li>Ketuk kartu komponen untuk menaruhnya di tengah kanvas.</li><li>Di iPad: tahan kartu sebentar lalu seret ke kanvas. Dengan mouse: langsung seret.</li><li>Letakkan komponen di atas breadboard: kakinya menempel otomatis ke lubang terdekat.</li></ul>
  <h4>Membuat kabel</h4><ul><li>Ketuk pin pertama, lalu ketuk pin tujuan. Atau seret dari pin ke pin.</li><li>Selama kabel belum selesai: geser layar (satu jari / seret area kosong) dan cubit zoom tidak membatalkan kabel; ketuk area kosong untuk menambah belokan; seret kabel ke tepi layar untuk menggeser otomatis. Batal: tombol ✕ Batal, Esc, atau ketuk pin awal lagi.</li><li>Geser kabel (di tampilan 2D): tekan lalu seret badan kabel, jalurnya ikut bergeser mengikuti jari / mouse dan tetap bersiku. Seret titik ● untuk memindah belokan, seret + untuk menambah belokan, ketuk ganda ● untuk menghapus. Panel Properti: ganti warna, <b>Rapikan kabel ini</b>, <b>Rapikan semua kabel</b>, hapus.</li><li><b>Ketik</b> (toolbar): sambung kabel dengan teks, satu baris per kabel, mis. <code>esp32:D21 - oled1:SDA kuning</code>, <code>esp32:GND ke bb1:-</code>, <code>bb1:a10 - led1:A</code>.</li></ul>
  <h4>Bundel kabel</h4><ul><li>Menu Edit → <b>Bundel kabel</b> (atau panel Properti kabel): kabel antara dua komponen yang sama disatukan jadi satu jalur rapi, berjajar sejajar, menghindari badan komponen, diikat cable tie. Bundel ikut menyesuaikan saat komponen digeser; <b>Lepas bundel</b> untuk mengurai.</li></ul>
  <h4>Desain PCB</h4><ul><li>Tombol <b>PCB</b>: rangkaian yang sudah benar dijadikan PCB 2 lapis. Breadboard hilang, sambungannya jadi jalur tembaga; modul & board dicolok lewat female header di posisi pin aslinya.</li><li>Seret komponen untuk mengatur posisi, <b>Rute otomatis</b> untuk menarik jalur (clearance 0,2 mm, via otomatis), cek DRC, lalu <b>Unduh Gerber (.zip)</b> — langsung bisa diunggah ke pabrik PCB.</li></ul>
  <h4>Auto wiring · Auto kode · Newbie</h4><ul><li><b>Auto wiring</b>: semua pin komponen yang belum tersambung diberi pin mikrokontroler yang cocok (VCC sesuai tegangan modul, GND, I²C/SPI/UART bawaan, ADC untuk keluaran analog, PWM bila perlu, GPIO bebas untuk sisanya; LED lewat resistor bila ada), lalu ditancapkan ke breadboard dan dirapikan. Alasan tiap pin ditulis di Log.</li><li><b>Saran komponen tambahan</b>: setelah Auto wiring, rangkaian diperiksa terhadap wiring tutorial Random Nerd Tutorials, Adafruit dan datasheet. Bila perlu, muncul jendela saran: resistor 220 Ω untuk LED, pembagi tegangan 1 kΩ + 2 kΩ untuk sinyal 5 V ke pin 3,3 V (HC-SR04, sensor analog 5 V di ESP32), pull-up 4,7 kΩ DS18B20, pull-up 10 kΩ DHT22, resistor dan kapasitor NeoPixel, transistor + dioda untuk relay, modul MOSFET untuk motor/pompa. Centang yang ingin dipakai; komponen baru hanya ditambahkan setelah kamu menekan <b>Tambahkan yang dipilih</b>. Saran bisa dibuka lagi dari menu Edit atau tombol di panel Periksa.</li><li><b>Auto kode</b> (di tab <b>Kode</b>): membaca komponen terhubung ke pin mana, lalu membuat program lengkap dengan library yang sesuai. Bisa dipakai terpisah dari Auto wiring (misalnya setelah merangkai sendiri).</li><li><b>Newbie</b>: panduan langkah demi langkah. Tahap <i>Rangkai</i> menunjukkan pin mana disambung ke mana beserta alasannya (pin menyala kuning, langkah tercentang sendiri saat kabel dibuat), tahap <i>Kode</i> menyusun program per komponen, tahap <i>Uji</i> mengajarkan cara menguji tiap komponen.</li><li>Contoh proyek otomatis dipasang di breadboard; menu Edit → <b>Pasang di breadboard</b> melakukan hal yang sama untuk rangkaianmu, tanpa mengubah sambungan listriknya. Semua kabel digambar bersiku.</li></ul>
  <h4>Tampilan 3D</h4><ul><li>Tombol <b>3D</b> di toolbar: rangkaian dalam 3D dan tetap tersimulasi (LED menyala, layar, NeoPixel, servo ikut bergerak).</li><li>Seret: putar · dua jari / klik kanan: geser · cubit / scroll: zoom · tombol Iso/Atas/Depan · keyboard WASD, Q/E, +/−.</li><li>Komponen bisa dioperasikan langsung di 3D: tekan tombol, putar potensio / encoder, gerakkan joystick, geser saklar, ketuk keypad / DIP / remote IR, dan <b>seret sensor naik-turun</b> untuk mengubah nilainya (suhu, jarak, cahaya, gas …). Panel <b>Kontrol</b> pada kartu komponen berisi semua nilai sensor.</li><li><b>Ukur</b> (M): multimeter. Ketuk pin, lubang breadboard, atau ujung kabel untuk memasang probe; tegangan, HIGH/LOW/PWM, mode pin (INPUT/OUTPUT) dan sambungannya tampil langsung. Dua probe menampilkan beda tegangannya.</li><li><b>Diagnosa</b> (G): daftar kesalahan dari cek rangkaian, peringatan simulasi, dan pengukuran daya tiap komponen. Komponen bermasalah diberi kotak merah / kuning; ketuk butir untuk menuju komponennya.</li></ul>
  <h4>Mobil robot & ESP-NOW</h4><ul><li>Komponen <b>Sasis Mobil Robot 2WD</b> (kategori Robot): sambungkan motornya ke L298N, lalu taruh ESP32, driver, baterai, dan sensor di atas sasis. Menggeser sasis di Desain ikut membawa komponen di atasnya.</li><li>Buka <b>3D</b> lalu <b>Jalankan</b>: mobil berjalan di arena sesuai tegangan motor. Pilih arena (dinding 2×2 m, rintangan, lintasan garis hitam, lantai bebas) di Properti sasis. Tombol <b>Ikuti mobil</b> (K) dan <b>Reset mobil</b> ada di bilah 3D.</li><li>Sensor di atas sasis membaca arena: HC-SR04 / JSN-SR04T / VL53L0X mengukur jarak ke dinding, FC-51 melihat halangan &lt; 15 cm, TCRT5000 mendeteksi garis hitam.</li><li><b>ESP-NOW</b>: <code>#include &lt;esp_now.h&gt;</code> (ESP32) atau <code>&lt;espnow.h&gt;</code> (ESP8266). Tab <b>ESP-NOW</b> di konsol adalah remote virtual: tahan tombol arah (atau W/A/S/D) untuk mengirim huruf perintah, atau pilih format struct joystick. Paket yang dikirim board (<code>esp_now_send</code>) tampil di sana. Callback gaya Arduino-ESP32 2.x dan 3.x sama-sama didukung.</li><li>Contoh siap pakai: grup <b>Robot & ESP-NOW</b> (mobil RC ESP-NOW, robot penghindar halangan, robot pengikut garis).</li></ul>
  <h4>Benda di sekitar sensor (3D)</h4><ul><li>Sensor jarak menampilkan dinding pada jarak yang diatur; seret dinding maju/mundur untuk mengubah jarak. Sensor ketinggian air memperlihatkan tangki berisi air, sensor tanah memperlihatkan tanah (makin gelap makin basah), sensor hujan memperlihatkan tetesan, LDR lampu, sensor api lilin.</li></ul>
  <h4>Mode tampilan: Laptop, iPad, HP</h4><ul><li>Tombol layar di kanan atas memilih tata letak. <b>Otomatis</b> menyesuaikan perangkat. Di HP, panel ada di bilah bawah dan konsol bisa diperkecil. Memilih mode yang lebih kecil dari layar menampilkan pratinjau berbingkai (berguna bagi guru untuk melihat tampilan siswa di HP).</li><li><b>Bahasa</b>: tombol <b>ID</b>/<b>EN</b> di kanan atas (atau menu mode tampilan) mengganti bahasa antarmuka ke Bahasa Indonesia atau English, termasuk nama komponen, menu, pesan Log, dan panduan. Kode program tidak diterjemahkan. Proyek yang sedang dibuka tetap terbawa.</li></ul>
  <h4>Kanvas</h4><ul><li>Satu jari di area kosong: geser kanvas. Dua jari: cubit untuk zoom.</li><li>Seret komponen untuk memindah. Saat simulasi berjalan, seret lewat label nama di atasnya.</li><li>Tombol putar, duplikat, hapus, urungkan/ulangi ada di toolbar atas.</li><li><b>Simpan</b> (Ctrl+S) di kanan atas menyimpan proyek di perangkat ini; buka lagi lewat Berkas → <b>Proyek tersimpan</b>. Titik oranye di tombol Simpan berarti ada perubahan yang belum disimpan.</li></ul>
  <h4>Simulasi</h4><ul><li>Rangkai di <b>Desain</b>, tulis program di <b>Kode</b> (tombol <b>Auto kode</b> membuatkan program dari rangkaianmu), lalu tekan <b>Jalankan</b>. Simulasi berjalan langsung di kanvas Desain (2D maupun 3D); galat kompilasi muncul di Log dengan nomor baris yang bisa diketuk.</li><li>Ubah nilai sensor (suhu, jarak, kelembapan…) di panel Properti saat simulasi berjalan.</li><li>Kode dijalankan untuk Arduino Uno/Nano/Mega, Franzininho (ATtiny85), ESP32 DevKit, ESP32-CAM, NodeMCU / Wemos D1 mini (ESP8266), Raspberry Pi Pico dan Nano RP2040 Connect.</li></ul>
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
    let carry = null; try { carry = sessionStorage.getItem('sim.carry'); sessionStorage.removeItem('sim.carry'); } catch { /* storage blocked */ }
    if (carry) { const c = JSON.parse(carry); await applyProject(c); state.localId = c.localId; savedSnap = c.savedSnap ?? null; if (savedSnap !== null) refreshDirty(); }
    else if (q.get('p')) { const row = await loadProject(q.get('p')); state.projectId = null; await applyProject(row.data || row); toast('Proyek dibuka dari tautan.'); }
    else if (h.startsWith('#d=')) { await applyProject(JSON.parse(await b64.dec(h.slice(3)))); toast('Proyek dibuka dari tautan.'); }
    else if (h.startsWith('#ex=') && EXAMPLES.some((e) => e.id === h.slice(4))) await loadExample(h.slice(4));
    else await newProject();
  } catch (e) { addLog('error', 'Gagal membuka proyek dari tautan: ' + e.message); await newProject(); }
  state.ready = true;
  state.fittedOnce = true;
  window.addEventListener('hashchange', () => { const id = location.hash.slice(4); if (location.hash.startsWith('#ex=') && id !== state.exampleId && EXAMPLES.some((e) => e.id === id)) loadExample(id); });
  window.__sim = { sim, canvas, editor, state, run, setMode, showPanel, runCheck }; window.__BY_TAG = BY_TAG;   // handle for automated tests
})();

// ---------------------------------------------------------------- wiring by typing
let pinMap = null;
function wireTab(t) {
  $$('[data-pmt]').forEach((b) => b.classList.toggle('on', b.dataset.pmt === t));
  $$('[data-pmp]').forEach((p) => (p.hidden = p.dataset.pmp !== t));
  if (t === 'table') pinMap.render();
}
$$('[data-pmt]').forEach((b) => (b.onclick = () => wireTab(b.dataset.pmt)));
canvas.on('change', () => { if ($('#dlgWires').open && !$('#pmHost').hidden) pinMap?.render(); });
function openWireText() {
  const dlg = $('#dlgWires');
  pinMap ||= initPinMap({ canvas, catalog: BY_TAG, host: $('#pmHost'), toast });
  wireTab('table');
  $('#wtResult').innerHTML = '';
  const parts = [...canvas.parts.values()];
  $('#wtParts').innerHTML = parts.length ? 'Komponen: ' + parts.map((p) => `<code title="${esc(BY_TAG[p.type]?.name || p.type)}">${esc(p.id)}</code>`).join(' ') : 'Kanvas masih kosong: tambahkan komponen dulu.';
  $('#wtParts').querySelectorAll('code').forEach((c) => (c.onclick = () => { const t = $('#wtText'); const at = t.selectionStart ?? t.value.length; t.setRangeText(c.textContent + ':', at, at, 'end'); t.focus(); }));
  dlg.showModal();
}
function wtReport(res, applied) {
  const lines = [];
  if (applied != null) lines.push(`<div class="ok">✓ ${applied} kabel tersambung.</div>`);
  else for (const w of res.wires) lines.push(`<div class="ok">✓ baris ${w.line}: ${esc(w.a)} → ${esc(w.b)}</div>`);
  for (const e of res.errors) lines.push(`<div class="${e.dup ? 'warn' : 'err'}">${e.dup ? '•' : '✗'} baris ${e.line} <code>${esc(e.text)}</code>: ${esc(e.msg)}</div>`);
  if (!lines.length) lines.push('<div class="muted">Tidak ada baris kabel.</div>');
  $('#wtResult').innerHTML = lines.join('');
}
$('#tbWireText').onclick = () => openWireText();
$('#wtCheck').onclick = () => wtReport(parseWiring(canvas, BY_TAG, $('#wtText').value));
$('#wtExport').onclick = () => { $('#wtText').value = wiringToText(canvas); $('#wtResult').innerHTML = ''; };
$('#wtApply').onclick = () => {
  const res = parseWiring(canvas, BY_TAG, $('#wtText').value);
  const n = applyWiring(canvas, res.wires);
  wtReport(res, n);
  if (n && !res.errors.some((e) => !e.dup)) { $('#dlgWires').close(); toast(`${n} kabel tersambung.`); }
};

// ---------------------------------------------------------------- 3D view (three.js, loaded on first use)
let view3d = null;
async function toggle3D(force) {
  const btn = $('#tb3d');
  if (!view3d) {
    btn.disabled = true;
    try { const { init3D } = await import('./ui/view3d.js'); view3d = init3D({ canvas, sim, host: $('#view3d'), catalog: BY_TAG, toast, check: () => runCheck(false),
      onAttr: (part, key, commit) => {                       // a sensor value changed in the 3D view: same effects as the Properti panel
        if (key === 'pixels') { canvas.emit('change', { structural: true }); canvas._refreshPins(part); }
        if (key === 'common') canvas._refreshPins(part);
        if (commit) canvas.snapshot();
        if (state.panel === 'props' && canvas.selected?.id === part.id) renderProps(true);
      } }); view3d.onToggle = (on) => { btn.classList.toggle('on', on); document.body.classList.toggle('mode-3d', on); if (on && isPhone()) { $('#console').classList.add('collapsed'); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); } }; }
    catch (e) { toast('Tampilan 3D gagal dimuat: ' + e.message, true); return; }
    finally { btn.disabled = false; }
  }
  if (pcbView?.isOpen && force !== false) pcbView.close();
  if (force === false) view3d.close(); else if (force === true) view3d.open(); else view3d.toggle();
}
$('#tb3d').onclick = () => toggle3D();
window.__view3d = { toggle: toggle3D, get: () => view3d };   // handle for automated tests

// ---------------------------------------------------------------- PCB designer (loaded on first use)
let pcbView = null;
async function togglePcb(force) {
  const btn = $('#tbPcb');
  if (!pcbView) {
    btn.disabled = true;
    try { const { initPcb } = await import('./ui/pcbview.js'); pcbView = initPcb({ canvas, host: $('#pcbView'), catalog: BY_TAG, check: () => runCheck(false), toast, projectName: () => $('#projectTitle').value }); pcbView.onToggle = (on) => { btn.classList.toggle('on', on); document.body.classList.toggle('mode-pcb', on); }; }
    catch (e) { toast('Desain PCB gagal dimuat: ' + e.message, true); return; }
    finally { btn.disabled = false; }
  }
  if (view3d?.isOpen && force !== false) view3d.close();
  if (force === false) pcbView.close(); else if (force === true) pcbView.open(); else pcbView.toggle();
}
$('#tbPcb').onclick = () => togglePcb();
window.__pcb = { toggle: togglePcb, get: () => pcbView };   // handle for automated tests

// ---------------------------------------------------------------- Auto wiring, Auto kode, Newbie (loaded on first use)
const learn = () => Promise.all([import('./learn/autowire.js'), import('./learn/autocode.js'), import('./ui/autobb.js')]);
async function autoWire() {
  const [{ planWiring, applyWiring }, , { autoBreadboard }] = await learn();
  const plan = planWiring(canvas, BY_TAG);
  if (!plan) { toast('Tambahkan mikrokontroler (ESP32 / Arduino) dulu.', true); return; }
  if (!plan.steps.length) { const k = await offerExtras(); if (!k) toast('Semua pin komponen sudah tersambung.'); return; }
  stopSim();
  const n = applyWiring(canvas, plan);
  for (const s of plan.steps) addLog('info', `Auto wiring: ${s.b} → ${s.a}. ${s.reason}`);
  await offerExtras();                                    // resistor / divider / pull-up / driver: only with the user's OK
  const hasBB = [...canvas.parts.values()].some((p) => BY_TAG[p.type]?.breadboard);
  const r = hasBB ? null : await autoBreadboard(canvas, BY_TAG);
  if (!r?.ok) canvas.bundleWires();
  if (r && !r.ok) addLog('info', 'Breadboard: ' + r.reason);
  window.__learn.lastBB = r;
  runCheck(true);
  toast(`${n} kabel dipasang${r?.ok ? ` dan ${r.placed.length} komponen ditancapkan ke breadboard` : ''}. Lihat Log untuk alasan tiap pin.`);
  guide?.refresh();
}
async function autoCode() {
  const [, { readCircuit, generateSketch }] = await learn();
  const circ = readCircuit(canvas, BY_TAG);
  if (!circ) { toast('Tambahkan mikrokontroler dulu.', true); return; }
  if (!circ.items.length) { toast('Belum ada komponen di workspace.', true); return; }
  const g = generateSketch(circ);
  $('#acCode').textContent = g.code;
  const missing = g.parts.filter((p) => p.todo), unk = g.unknown;
  $('#acInfo').textContent = `${circ.cat?.name || 'Board'} · ${g.parts.filter((p) => p.piece).length} komponen dibuatkan kodenya berdasarkan pin yang tersambung.`;
  $('#acParts').innerHTML = (missing.length ? `<div class="chk warn"><span class="ic">!</span><span>Belum tersambung lengkap: ${esc(missing.map((p) => p.id).join(', '))}. Pakai Auto wiring dulu agar kodenya lengkap.</span></div>` : '') + (unk.length ? `<div class="chk info"><span class="ic">i</span><span>Belum ada templat kode untuk: ${esc(unk.join(', '))} (lihat petunjuk di panel Properti).</span></div>` : '');
  $('#acUse').onclick = () => { editor.value = g.code; setCompilerState(''); $('#dlgAutoCode').close(); setMode('code'); toast('Kode otomatis dipasang di editor. Tekan Jalankan untuk mencoba.'); };
  $('#acCopy').onclick = () => navigator.clipboard?.writeText(g.code).then(() => toast('Kode disalin.'));
  $('#dlgAutoCode').showModal();
}
// ---------------------------------------------------------------- Saran komponen tambahan (popup, applied only when confirmed)
async function offerExtras({ manual = false } = {}) {
  const { suggestExtras, applyExtras } = await import('./learn/extras.js');
  const list = suggestExtras(canvas, BY_TAG);
  if (!list.length) { if (manual) toast('Rangkaian sudah rapi: tidak ada komponen tambahan yang disarankan.'); return 0; }
  const dlg = $('#dlgExtras');
  $('#exInfo').textContent = `Agar rangkaian aman dan lolos Periksa, ${list.length} perbaikan berikut disarankan (mengikuti wiring tutorial Random Nerd Tutorials, Adafruit, dan datasheet). Centang yang ingin ditambahkan.`;
  $('#exList').innerHTML = list.map((x, i) => `<label class="ex-item"><input type="checkbox" data-i="${i}" checked><b>${esc(x.title)}</b><p>${esc(x.detail)}</p><span class="ex-parts">${x.parts.map((p) => `<i>+ ${esc(p)}</i>`).join('')}</span><span class="ex-src">Rujukan: ${esc(x.source)}</span></label>`).join('');
  return new Promise((resolve) => {
    const done = async (ok) => {
      $('#exApply').onclick = null; dlg.onclose = null; if (dlg.open) dlg.close();
      if (!ok) { addLog('info', 'Saran komponen tambahan dilewati.'); resolve(0); return; }
      const pick = [...$('#exList').querySelectorAll('input:checked')].map((c) => list[+c.dataset.i]);
      if (!pick.length) { resolve(0); return; }
      stopSim();
      const ids = await applyExtras(canvas, pick);
      for (const x of pick) addLog('ok', `Ditambahkan: ${x.title}. ${x.detail}`);
      if (manual && ids.length) canvas.tidyWires();             // after Auto wiring the breadboard step tidies everything
      runCheck(true); toast(`${ids.length} komponen tambahan dipasang dan disambungkan.`);
      resolve(ids.length);
    };
    $('#exApply').onclick = () => done(true);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
}
$('#btnExtras').onclick = () => offerExtras({ manual: true });

let guide = null;
async function toggleNewbie(force) {
  if (!guide) {
    const { initGuide } = await import('./learn/guide.js');
    guide = initGuide({ canvas, catalog: BY_TAG, host: $('#guide'), editor, act: {
      run: () => run(), check: () => runCheck(false), setMode, toast, running: () => sim.running,
      bundle: () => canvas.bundleWires(), open3D: () => toggle3D(true),
      autobb: async () => { const { autoBreadboard } = await import('./ui/autobb.js'); const r = await autoBreadboard(canvas, BY_TAG); toast(r.ok ? `${r.placed.length} komponen ditancapkan ke breadboard.` : r.reason, !r.ok); },
    } });
    guide.onToggle = (on) => $('#tbNewbie').classList.toggle('on', on);
    sim.on('state', () => guide.isOn && guide.ping());
  }
  guide.toggle(force);
}
$('#tbAutoWire').onclick = () => autoWire();
$('#btnAutoCode').onclick = () => autoCode();
$('#tbNewbie').onclick = () => toggleNewbie();
window.__learn = { autoWire, autoCode, toggleNewbie, offerExtras, get guide() { return guide; } };   // handle for automated tests
