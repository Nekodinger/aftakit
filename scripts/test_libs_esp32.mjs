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
const L = (sim) => sim.serial.trim().split(/\r?\n/);
// Bundled libraries and ESP32 core APIs that student projects rely on (compile + behaviour on the simulator).

// 1. EEPROM typed API (readFloat / writeFloat / writeString ...) as used by DFRobot_ESP_EC / DFRobot_ESP_PH
{
  const { sim } = await make([], [], `#include <EEPROM.h>
void setup(){ Serial.begin(115200); EEPROM.begin(64); EEPROM.writeFloat(0, 1.2345f); EEPROM.writeInt(4, -77); EEPROM.writeString(8, "halo"); EEPROM.commit();
  char b[8]; EEPROM.readString(8, b, 8); Serial.printf("%.4f %d %s %u\\n", EEPROM.readFloat(0), EEPROM.readInt(4), b, (unsigned)EEPROM.length()); char s[] = "abc"; Serial.println(strupr(s)); Serial.println(isDigit('7') && !isAlpha('7')); }
void loop(){}`);
  await runMs(sim, 100);
  ok(L(sim)[0] === '1.2345 -77 halo 64' && L(sim)[1] === 'ABC' && L(sim)[2] === '1', `EEPROM typed API, strupr, isDigit: ${L(sim).join(' | ')}`);
}
// 2. DFRobot_ESP_EC (GreenPonik) + DFRobot_ESP_PH_WITH_ADC compile and run their begin()
{
  const { sim } = await make([], [], `#include <EEPROM.h>
#include <DFRobot_ESP_EC.h>
#include <DFRobot_ESP_PH_WITH_ADC.h>
DFRobot_ESP_EC ec; DFRobot_ESP_PH_WITH_ADC ph;
void setup(){ Serial.begin(115200); EEPROM.begin(64); ec.begin(); ph.begin(); Serial.println(ec.readEC(1500, 25), 3); }
void loop(){}`);
  await runMs(sim, 200);
  ok(Number.isFinite(parseFloat(L(sim).at(-1))), `DFRobot_ESP_EC + DFRobot_ESP_PH compile and run: EC = ${L(sim).at(-1)}`);
}
// 3. Hardware timer API (2.x and 3.x) and Ticker fire at the right rate
{
  const { sim } = await make([], [], `#include <Ticker.h>
hw_timer_t *t1 = NULL; volatile int a = 0, b = 0, c = 0; Ticker tk;
void IRAM_ATTR onT(){ a++; }
void onTick(){ b++; }
void setup(){ Serial.begin(115200); t1 = timerBegin(0, 80, true); timerAttachInterrupt(t1, &onT, true); timerAlarmWrite(t1, 10000, true); timerAlarmEnable(t1);
  tk.attach_ms(50, onTick); delay(1000); Serial.printf("%d %d\\n", a, b); }
void loop(){}`);
  await runMs(sim, 1200);
  const [a, b] = L(sim)[0].split(' ').map(Number);
  ok(Math.abs(a - 100) <= 2 && Math.abs(b - 20) <= 1, `hw timer 10 ms -> ${a} calls/s, Ticker 50 ms -> ${b} calls/s`);
}
// 4. FastLED on a NeoPixel (WS2812B, GRB)
{
  const { sim, els } = await make([['px', 'wokwi-neopixel', ['VDD', 'DOUT', 'VSS', 'DIN'], { r: 0, g: 0, b: 0 }]],
    [['px:DIN', 'esp:D5'], ['px:VDD', 'esp:VIN'], ['px:VSS', 'esp:GND.1']],
    `#include <FastLED.h>
CRGB leds[1];
void setup(){ FastLED.addLeds<WS2812B, 5, GRB>(leds, 1); leds[0] = CRGB(255, 0, 128); FastLED.show(); }
void loop(){ delay(100); }`);
  await runMs(sim, 150); const e = els.get('px');
  ok(e.r > 0.95 && e.g < 0.05 && Math.abs(e.b - 128 / 255) < 0.02, `FastLED CRGB(255,0,128) -> r=${e.r} g=${e.g} b=${(+e.b).toFixed(2)}`);
}
// 5. NewPing + HC-SR04, DHTesp + DHT22
{
  const { sim } = await make([['us', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND'], {}, { distance: '123' }], ['dht', 'wokwi-dht22', ['VCC', 'SDA', 'NC', 'GND'], {}, { temperature: '27.5', humidity: '61' }]],
    [['us:VCC', 'esp:VIN'], ['us:GND', 'esp:GND.1'], ['us:TRIG', 'esp:D5'], ['us:ECHO', 'esp:D18'], ['dht:VCC', 'esp:3V3'], ['dht:GND', 'esp:GND.1'], ['dht:SDA', 'esp:D4']],
    `#include <NewPing.h>
#include <DHTesp.h>
NewPing sonar(5, 18, 300); DHTesp dht;
void setup(){ Serial.begin(115200); dht.setup(4, DHTesp::DHT22); delay(2100); TempAndHumidity th = dht.getTempAndHumidity(); Serial.printf("%lu %lu %.1f %.0f\\n", sonar.ping_cm(), sonar.ping_median(3) / US_ROUNDTRIP_CM, th.temperature, th.humidity); }
void loop(){}`);
  await runMs(sim, 2600);
  // the HC-SR04 echo is 58.2 µs/cm (343 m/s); NewPing divides by its US_ROUNDTRIP_CM = 57, so it reads 2 % long, as on hardware
  const cm = Math.floor((123 * 58.2 + 28) / 57), med = Math.floor(123 * 58.2 / 57);
  ok(L(sim)[0] === `${cm} ${med} 27.5 61`, `NewPing ping_cm / ping_median + DHTesp: ${L(sim)[0]} (expect ${cm} cm)`);
}
// 6. IBusBM with its ESP32 hardware-timer code path + Keypad + AccelStepper compile
{
  const { sim } = await make([['rx', 'mod-rc-rx', ['VCC', 'GND', 'IBUS', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6']]], [['rx:VCC', 'esp:VIN'], ['rx:GND', 'esp:GND.1'], ['rx:IBUS', 'esp:RX2']],
    `#include <IBusBM.h>
#include <Keypad.h>
#include <AccelStepper.h>
IBusBM ib; AccelStepper st(AccelStepper::DRIVER, 2, 4);
void setup(){ Serial.begin(115200); ib.begin(Serial2); st.setMaxSpeed(100); }
void loop(){ static unsigned long t = 0; if (millis() - t > 300) { t = millis(); Serial.println(ib.readChannel(2)); } }`);
  sim.rc ||= {}; sim.rc.ch = [1500, 1500, 1234, 1500, 1000, 1000, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500]; sim.rc.on = true;
  await runMs(sim, 800);
  ok(L(sim).at(-1) === '1234', `IBusBM (ESP32 timer interrupt) reads CH3 = ${L(sim).at(-1)}`);
}
// 7. U8g2 on the I2C OLED
{
  const { sim, els } = await make([['oled', 'mod-oled-i2c', ['GND', 'VCC', 'SCL', 'SDA'], { drawFrame(b) { this.frame = b; } }]],
    [['oled:VCC', 'esp:3V3'], ['oled:GND', 'esp:GND.1'], ['oled:SDA', 'esp:D21'], ['oled:SCL', 'esp:D22']],
    `#include <U8g2lib.h>
#include <Wire.h>
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
void setup(){ Serial.begin(115200); u8g2.begin(); u8g2.clearBuffer(); u8g2.drawBox(0, 0, 32, 16); u8g2.sendBuffer(); Serial.println("ok"); }
void loop(){ delay(100); }`);
  await runMs(sim, 1200);
  const f = els.get('oled').frame, lit = f ? f.reduce((s, x) => s + x, 0) : 0;
  ok(/ok/.test(sim.serial) && lit === 32 * 16, `U8g2 drawBox 32x16 on SSD1306 -> ${lit} lit pixels`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
