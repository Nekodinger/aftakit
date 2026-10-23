// Headless tests for the WebAssembly ESP32 / ESP8266 runtime: real Arduino sketches compiled with wasi-sdk.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src, board = 'esp32') {
  writeFileSync('/tmp/_w.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_w.ino').read(), '${board}')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); return Buffer.from(r.wasm, 'base64');
}
class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; this.leds = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  fire(e, detail) { (this.l[e] || []).forEach((f) => f({ detail })); }
  setLed(k, on) { this.leds[k] = on; }
  drawFrame(bits) { this.frame = bits; }
}
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
const NODEMCU = 'A0 RSV RSV.2 SD3 SD2 SD1 CMD SD0 CLK GND 3V3 EN RST GND.2 VIN D0 D1 D2 D3 D4 3V3.2 GND.3 D5 D6 D7 D8 RX TX GND.4 3V3.3'.split(' ');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function make(def, conns, sketch, { board = ['esp', 'wokwi-esp32-devkit-v1', ESP], kind = 'esp32' } = {}) {
  const sim = new Simulator();
  const model = { parts: [{ id: board[0], type: board[1], attrs: {} }], connections: conns };
  const els = new Map([[board[0], new Stub(board[1], board[2])]]);
  for (const [id, type, pins, props, attrs] of def) { model.parts.push({ id, type, attrs: attrs || {} }); els.set(id, new Stub(type, pins, props)); }
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  sim.bt = ''; sim.on('bt', (e) => { if (e.type === 'data') sim.bt += Buffer.from(e.bytes).toString(); else sim.btName = e.name; });
  const diag = sim.build(model, els); await sim.loadWasm(compile(sketch, kind));
  return { sim, els, model, diag };
}
const runMs = async (sim, ms) => { for (let t = 0; t < ms; t += 10) { sim.advance(10); if (sim.board.state === 'http' || sim.board.state === 'httpdone') await new Promise((r) => setTimeout(r, 5)); } };
const logs = (sim) => sim.logs.map((l) => l.level + ': ' + l.text).join('\n');

// 1. Blink on GPIO2 + LED on a resistor
{
  const { sim, els } = await make([['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['esp:D2', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'esp:GND.1']],
    `void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); Serial.println("boot"); }
void loop(){ digitalWrite(2, HIGH); delay(500); digitalWrite(2, LOW); delay(500); }`);
  await runMs(sim, 250); const a = els.get('led1').value; await runMs(sim, 500); const b = els.get('led1').value;
  ok(a === true && b === false && /boot/.test(sim.serial), `ESP32 blink GPIO2: on=${a} off=${b}, serial=${JSON.stringify(sim.serial.trim())}`);
  const t = sim.board.cpu.cycles / 16e6; ok(Math.abs(t - 0.75) < 0.02, `simulated time advances with delay(): ${t.toFixed(3)} s`);
}
// 2. Soil moisture analog sensor on GPIO34 (ADC1), 12-bit result
{
  const { sim } = await make([['pot', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { value: 0, min: 0, max: 1023 }, {}]],
    [['pot:VCC', 'esp:3V3'], ['pot:GND', 'esp:GND.1'], ['pot:SIG', 'esp:D34']],
    `void setup(){ Serial.begin(115200); }
void loop(){ int v = analogRead(34); Serial.print("ADC="); Serial.println(v); delay(200); }`);
  const el = sim.els.get('pot'); el.value = 512; el.fire('input', {});
  await runMs(sim, 450);
  const m = [...sim.serial.matchAll(/ADC=(\d+)/g)].map((x) => +x[1]);
  ok(m.length >= 2 && m.every((x) => Math.abs(x - 2048) < 20), `analogRead(34) pot at 50% of 3V3 -> ~2048 (12-bit): ${m.join(',')}`);
}
// 3. DHT22 via DHT.h on GPIO15
{
  const { sim } = await make([['dht', 'wokwi-dht22', ['VCC', 'SDA', 'NC', 'GND']]], [['dht:VCC', 'esp:3V3'], ['dht:GND', 'esp:GND.1'], ['dht:SDA', 'esp:D15']],
    `#include <DHT.h>
DHT dht(15, DHT22);
void setup(){ Serial.begin(115200); dht.begin(); }
void loop(){ delay(2000); Serial.printf("T=%.1f H=%.1f\\n", dht.readTemperature(), dht.readHumidity()); }`);
  sim.model.parts.find((p) => p.id === 'dht').attrs = { temperature: 29.5, humidity: 70 };
  await runMs(sim, 2200);
  ok(/T=29\.5 H=70\.0/.test(sim.serial), 'DHT22 on ESP32: ' + JSON.stringify(sim.serial.trim()));
}
// 4. LCD 16x2 I2C on GPIO21/22 (LiquidCrystal_I2C)
{
  const { sim } = await make([['lcd', 'x-lcd1602-i2c', ['GND', 'VCC', 'SDA', 'SCL'], { font: new Uint8Array(2048) }, { address: '0x27' }]],
    [['lcd:VCC', 'esp:VIN'], ['lcd:GND', 'esp:GND.1'], ['lcd:SDA', 'esp:D21'], ['lcd:SCL', 'esp:D22']],
    `#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup(){ lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("Halo ESP32"); }
void loop(){ delay(100); }`);
  await runMs(sim, 1500);
  const s = sim.behaviors.find((b) => b._part.id === 'lcd'); const d = s.dev(); const txt = String.fromCharCode(...d.hd.snapshot().chars.slice(0, 10));
  ok(txt === 'Halo ESP32' && d.backlight, `LCD I2C on GPIO21/22 shows "${txt}" backlight=${d.backlight}`);
}
// 5. WiFi connect + status + IP, then HTTP GET through the host fetch (stubbed so the test is deterministic)
{
  globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ suhu: 31, url })).buffer });
  const { sim } = await make([], [],
    `#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
void setup(){ Serial.begin(115200); WiFi.begin("Wokwi-GUEST", "");
  while (WiFi.status() != WL_CONNECTED) { delay(100); Serial.print("."); }
  Serial.println(); Serial.print("IP="); Serial.println(WiFi.localIP());
  HTTPClient http; http.begin("http://api.example.com/data"); int code = http.GET();
  String body = http.getString(); http.end();
  JsonDocument doc; deserializeJson(doc, body);
  Serial.printf("code=%d suhu=%d\\n", code, (int)doc["suhu"]);
}
void loop(){ delay(1000); }`);
  await runMs(sim, 2500);
  ok(/IP=10\.10\.0\.2/.test(sim.serial) && /code=200 suhu=31/.test(sim.serial), 'WiFi + HTTP GET + ArduinoJson: ' + JSON.stringify(sim.serial.replace(/\.+/, '...').trim()));
}
// 6. BluetoothSerial echo
{
  const { sim } = await make([], [],
    `#include <BluetoothSerial.h>
BluetoothSerial BT;
void setup(){ BT.begin("ESP32-Kelas"); }
void loop(){ while (BT.available()) { char c = BT.read(); BT.write(toupper(c)); } delay(10); }`);
  await runMs(sim, 50); sim.btWrite('halo'); await runMs(sim, 100);
  ok(sim.btName === 'ESP32-Kelas' && sim.bt === 'HALO', `BluetoothSerial: name=${sim.btName} echo=${JSON.stringify(sim.bt)}`);
}
// 7. Button with INPUT_PULLUP + interrupt
{
  const { sim, els } = await make([['btn', 'wokwi-pushbutton', ['1.l', '2.l', '1.r', '2.r'], { pressed: false }]],
    [['btn:1.l', 'esp:D4'], ['btn:2.l', 'esp:GND.1']],
    `volatile int n = 0; void IRAM_ATTR isr(){ n++; }
void setup(){ Serial.begin(115200); pinMode(4, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(4), isr, FALLING); }
void loop(){ static int last = -1; if (n != last) { last = n; Serial.printf("n=%d btn=%d\\n", n, digitalRead(4)); } delay(20); }`);
  await runMs(sim, 100);
  const b = els.get('btn'); b.fire('button-press'); await runMs(sim, 100); b.fire('button-release'); await runMs(sim, 100);
  ok(/n=0 btn=1/.test(sim.serial) && /n=1 btn=0/.test(sim.serial), 'INPUT_PULLUP + attachInterrupt FALLING: ' + JSON.stringify(sim.serial.trim()));
}
// 8. ADC2 pin while WiFi is on -> warning like a real ESP32
{
  const { sim } = await make([], [],
    `#include <WiFi.h>
void setup(){ WiFi.begin("x"); delay(1500); analogRead(4); }
void loop(){ delay(100); }`);
  await runMs(sim, 1700);
  ok(/ADC2 tidak bisa dipakai saat WiFi/.test(logs(sim)), 'ADC2 + WiFi warning shown');
}
// 9. Crash (null pointer write) -> clear error instead of a frozen page
{
  const { sim } = await make([], [], `void setup(){ int *p = (int*)0x7fffffff; *p = 5; } void loop(){}`);
  await runMs(sim, 50);
  ok(/crash/i.test(logs(sim)) || sim.board.state === 'crashed', 'out-of-bounds write -> crash message: ' + (sim.logs.find((l) => l.level === 'error')?.text || sim.board.state));
}
// 10. ESP8266 NodeMCU: blink D4 (GPIO2) with LED_BUILTIN-style code
{
  const { sim, els } = await make([['led1', 'wokwi-led', ['A', 'C'], { value: false }]], [['n:D1', 'led1:A'], ['led1:C', 'n:GND']],
    `void setup(){ pinMode(D1, OUTPUT); } void loop(){ digitalWrite(D1, HIGH); delay(300); digitalWrite(D1, LOW); delay(300); }`,
    { board: ['n', 'mod-nodemcu', NODEMCU], kind: 'esp8266' });
  await runMs(sim, 150); const a = els.get('led1').value; await runMs(sim, 300); const b = els.get('led1').value;
  ok(a === true && b === false, `NodeMCU blink D1: on=${a} off=${b}`);
}
// 11. Servo on GPIO18 (ESP32Servo)
{
  const { sim, els } = await make([['sv', 'wokwi-servo', ['GND', 'V+', 'PWM'], { angle: 0 }]], [['sv:PWM', 'esp:D18'], ['sv:V+', 'esp:VIN'], ['sv:GND', 'esp:GND.1']],
    `#include <ESP32Servo.h>
Servo s; void setup(){ s.attach(18); s.write(90); } void loop(){ delay(50); }`);
  await runMs(sim, 300);
  ok(Math.abs(els.get('sv').angle - 90) < 3, 'ESP32Servo write(90) -> angle ' + els.get('sv').angle);
}
// 12. OLED SSD1306 (Adafruit_SSD1306 + GFX) on the default ESP32 I2C pins
{
  const { sim, els } = await make([['oled', 'mod-oled-i2c', ['GND', 'VCC', 'SCL', 'SDA']]],
    [['oled:VCC', 'esp:3V3'], ['oled:GND', 'esp:GND.1'], ['oled:SDA', 'esp:D21'], ['oled:SCL', 'esp:D22']],
    `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 d(128, 64, &Wire, -1);
void setup(){ Serial.begin(115200); if(!d.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("oled fail"); d.clearDisplay(); d.fillRect(0,0,64,32,SSD1306_WHITE); d.display(); Serial.println("ok"); }
void loop(){ delay(100); }`);
  await runMs(sim, 400);
  const f = els.get('oled').frame; const lit = f ? f.reduce((a, b) => a + b, 0) : 0;
  ok(/ok/.test(sim.serial) && lit === 64 * 32, `OLED fillRect 64x32 -> ${lit} lit pixels (expect 2048)`);
}
// 13. NeoPixel strip of 1 on GPIO5
{
  const { sim, els } = await make([['px', 'wokwi-neopixel', ['VDD', 'DOUT', 'VSS', 'DIN'], { r: 0, g: 0, b: 0 }]],
    [['px:DIN', 'esp:D5'], ['px:VDD', 'esp:VIN'], ['px:VSS', 'esp:GND.1']],
    `#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel s(1, 5, NEO_GRB + NEO_KHZ800);
void setup(){ s.begin(); s.setPixelColor(0, s.Color(255, 0, 128)); s.show(); }
void loop(){ delay(100); }`);
  await runMs(sim, 100); const e = els.get('px');
  ok(e.r > 0.95 && e.g < 0.05 && Math.abs(e.b - 128 / 255) < 0.02, `NeoPixel color(255,0,128) -> r=${e.r} g=${e.g} b=${(+e.b).toFixed(2)}`);
}
// 14. Non-blocking millis() loop without delay() keeps time and does not freeze
{
  const { sim } = await make([], [],
    `unsigned long t0 = 0; int n = 0;
void setup(){ Serial.begin(115200); }
void loop(){ if (millis() - t0 >= 100) { t0 = millis(); n++; if (n % 5 == 0) Serial.printf("n=%d\\n", n); } }`);
  const w0 = performance.now(); await runMs(sim, 1000); const wall = performance.now() - w0;
  const last = [...sim.serial.matchAll(/n=(\d+)/g)].pop()?.[1];
  ok(+last >= 9 && +last <= 10 && wall < 1500, `millis() busy loop: n=${last} after 1 s simulated (${wall.toFixed(0)} ms wall)`);
}
// 15. `for(;;);` with no Arduino calls (common "stop here" idiom) must not freeze the page
{
  const { sim } = await make([], [], `void setup(){ Serial.begin(115200); Serial.println("stop"); for(;;); } void loop(){}`);
  const w0 = performance.now(); await runMs(sim, 500); const wall = performance.now() - w0;
  ok(/stop/.test(sim.serial) && wall < 2000 && sim.board.cpu.cycles / 16e6 > 0.2, `for(;;) stays responsive: ${wall.toFixed(0)} ms wall, sim t=${(sim.board.cpu.cycles / 16e6).toFixed(2)} s`);
}
// 16. Pure computation is counted as CPU time
{
  const { sim } = await make([], [], `volatile long x = 0;
void setup(){ Serial.begin(115200); unsigned long t = micros(); for (long i = 0; i < 200000; i++) x += i; Serial.printf("dt=%lu\\n", micros() - t); } void loop(){ delay(100); }`);
  await runMs(sim, 300); const dt = +(/dt=(\d+)/.exec(sim.serial)?.[1]);
  ok(dt > 1000 && dt < 60000, `200k-iteration loop takes simulated time: ${dt} us`);
}
// 17-18. The bundled ESP32 examples run as-is (same code students open from the Examples panel)
{
  const { EXAMPLES } = await import('../src/examples/defs.js');
  const { MODULE_SPECS } = await import('../src/parts/modules.js');
  const WK = { 'wokwi-esp32-devkit-v1': ESP, 'wokwi-dht22': ['VCC', 'SDA', 'NC', 'GND'], 'x-lcd1602-i2c': ['GND', 'VCC', 'SDA', 'SCL'], 'wokwi-pir-motion-sensor': ['VCC', 'OUT', 'GND'], 'wokwi-resistor': ['1', '2'], 'wokwi-led': ['A', 'C'], 'wokwi-pushbutton': ['1.l', '2.l', '1.r', '2.r'] };
  const pinsOf = (t) => WK[t] || Object.values(MODULE_SPECS.find((m) => m.tag === t).pins).flat().map((n) => n.split('|')[0]);
  async function runExample(id) {
    const ex = EXAMPLES.find((e) => e.id === id);
    const sim = new Simulator(); const model = { parts: ex.parts.map((p) => ({ ...p, attrs: { ...(p.attrs || {}) } })), connections: ex.wires };
    const els = new Map(model.parts.map((p) => [p.id, new Stub(p.type, pinsOf(p.type), p.type === 'x-lcd1602-i2c' ? { font: new Uint8Array(2048) } : { value: false })]));
    sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
    sim.shots = []; sim.on('camera', (f) => sim.shots.push(f));
    sim.build(model, els); await sim.loadWasm(compile(ex.code, ex.board)); return { sim, model, els };
  }
  const { sim: a, model: am, els: ae } = await runExample('esp32-iot');
  await runMs(a, 4500);
  const relayDry = a.board.out['D26']; am.parts.find((p) => p.id === 'soil1').attrs.level = 90; await runMs(a, 2200);
  const lcd = a.behaviors.find((b) => b._part.id === 'lcd1').dev(); const row = (r) => String.fromCharCode(...lcd.hd.snapshot().chars.slice(r * 16, r * 16 + 16));
  ok(/Suhu=30\.0 RH=68/.test(a.serial) && /Pompa=ON/.test(a.serial) && /Pompa=OFF/.test(a.serial) && relayDry === false && a.board.out['D26'] === true && /10\.10\.0\.2/.test(row(0)),
    `example esp32-iot: LCD "${row(0).trim()}" / "${row(1).trim()}", serial ${JSON.stringify(a.serial.trim().split('\n').slice(-2))}`);
  const { sim: c, model: cm } = await runExample('esp32cam-pir');
  await runMs(c, 300); cm.parts.find((p) => p.id === 'pir1').attrs.motion = true; await runMs(c, 400);
  ok(/Kamera siap/.test(c.serial) && /Gerakan! Foto 320x240, \d+ byte/.test(c.serial) && c.shots.length === 1, 'example esp32cam-pir: ' + JSON.stringify(c.serial.trim()));
  c.cameraFrame = { bytes: new Uint8Array(5000), w: 640, h: 480 }; await runMs(c, 3200);
  ok(/Foto 640x480, 5000 byte/.test(c.serial), 'ESP32-CAM uses the device camera frame when available');
  // weather: Open-Meteo-shaped JSON through the (stubbed) browser fetch
  let asked = '';
  globalThis.fetch = async (url) => { asked = url; return { status: 200, arrayBuffer: async () => new TextEncoder().encode('{"current":{"time":"2026-10-23T12:00","temperature_2m":31.4,"relative_humidity_2m":66,"wind_speed_10m":9.7}}').buffer }; };
  const { sim: w } = await runExample('esp32-weather'); await runMs(w, 2500);
  const wl = w.behaviors.find((b) => b._part.id === 'lcd1').dev(); const wrow = (r) => String.fromCharCode(...wl.hd.snapshot().chars.slice(r * 16, r * 16 + 16)).trim();
  ok(/api\.open-meteo\.com/.test(asked) && /Jakarta: 31\.4 C, RH 66 %, angin 9\.7/.test(w.serial) && wrow(0).startsWith('Jakarta 31.4') && wrow(1) === 'RH66% 10km/j', `example esp32-weather: LCD "${wrow(0)}" / "${wrow(1)}"`);
  const { sim: bt, els: be } = await runExample('esp32-bluetooth'); bt.bt = ''; bt.on('bt', (e) => { if (e.type === 'data') bt.bt += Buffer.from(e.bytes).toString(); });
  await runMs(bt, 100); bt.btWrite('on\n'); await runMs(bt, 100); const on = be.get('led1').value; bt.btWrite('STATUS\n'); await runMs(bt, 100);
  ok(on === true && /LED menyala/.test(bt.bt) && /LED: ON/.test(bt.bt), 'example esp32-bluetooth: ' + JSON.stringify(bt.bt));
  const { sim: nm, els: ne } = await runExample('nodemcu-button'); await runMs(nm, 100);
  ne.get('btn1').fire('button-press'); await runMs(nm, 100); ne.get('btn1').fire('button-release'); await runMs(nm, 100);
  ok(ne.get('led1').value === true && /LED ON/.test(nm.serial), 'example nodemcu-button: ' + JSON.stringify(nm.serial.trim()));
  const { sim: bl, els: ble } = await runExample('esp32-blink'); await runMs(bl, 250); const l1 = ble.get('led1').value, b2 = bl.board.out['D2']; await runMs(bl, 500);
  ok(l1 === false && b2 === true && ble.get('led1').value === true && /ESP32-D0WD/.test(bl.serial), 'example esp32-blink: ' + JSON.stringify(bl.serial.split('\n')[1]));

}
// 19. CORS-blocked site -> automatic retry through the simulator proxy (Google Apps Script style logging)
{
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); if (!url.startsWith('/api/proxy')) throw new TypeError('Failed to fetch'); return { status: 200, arrayBuffer: async () => new TextEncoder().encode('OK').buffer }; };
  const { sim } = await make([], [], `#include <WiFi.h>
#include <HTTPClient.h>
void setup(){ Serial.begin(115200); WiFi.begin("x"); while (WiFi.status() != WL_CONNECTED) delay(100);
  HTTPClient h; h.begin("https://script.google.com/macros/s/ABC/exec?suhu=30"); int c = h.GET(); Serial.printf("%d %s\\n", c, h.getString().c_str()); }
void loop(){ delay(1000); }`);
  sim.proxyUrl = '/api/proxy?url='; await runMs(sim, 2000);
  ok(/200 OK/.test(sim.serial) && calls.length === 2 && calls[1].includes(encodeURIComponent('https://script.google.com')), 'CORS-blocked request retried via /api/proxy: ' + JSON.stringify(sim.serial.trim()));
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
