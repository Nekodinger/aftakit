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

// Phase 3 on the WebAssembly ESP32 runtime: BMP280 / BME280 (Adafruit libs) and MAX30102 with the SpO2 algorithm.
const I2C = (id, vcc = 'VCC') => [['esp:D21', `${id}:SDA`], ['esp:D22', `${id}:SCL`], [`${id}:${vcc}`, 'esp:3V3'], [`${id}:GND`, 'esp:GND.1']];
{
  const { sim } = await make([['b', 'mod-bme280', ['VIN', 'GND', 'SCL', 'SDA'], {}, { temperature: '27', pressure: '1005', humidity: '61' }]], I2C('b', 'VIN'),
    `#include <Wire.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup(){ Serial.begin(115200); Wire.begin(21, 22); if(!bme.begin(0x76)){ Serial.println("NOT FOUND"); return; } }
void loop(){ Serial.print(bme.readTemperature()); Serial.print(" "); Serial.print(bme.readPressure()/100.0); Serial.print(" "); Serial.println(bme.readHumidity()); delay(500); }`);
  await runMs(sim, 1500);
  const l = sim.serial.trim().split(/\r?\n/).at(-1).split(' ').map(Number);
  ok(Math.abs(l[0] - 27) < 0.02 && Math.abs(l[1] - 1005) < 0.05 && Math.abs(l[2] - 61) < 0.1, `ESP32 BME280: ${l.join(' / ')} (expect 27 / 1005 / 61)`);
}
{
  const { sim } = await make([['m', 'mod-max30102', ['VIN', 'SCL', 'SDA', 'INT', 'IRD', 'RD', 'GND'], {}, { bpm: '80', spo2: '96' }]], I2C('m', 'VIN'),
    `#include <Wire.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"
MAX30105 p; uint32_t ir[100], red[100]; int32_t spo2, hr; int8_t vs, vh;
void setup(){ Serial.begin(115200); Wire.begin(21, 22); if(!p.begin(Wire, I2C_SPEED_FAST)){ Serial.println("NOT FOUND"); return; } p.setup(60, 4, 2, 100, 411, 4096); }
void loop(){
  for (byte i = 0; i < 100; i++) { while (!p.available()) p.check(); red[i] = p.getFIFORed(); ir[i] = p.getFIFOIR(); p.nextSample(); }
  maxim_heart_rate_and_oxygen_saturation(ir, 100, red, &spo2, &vs, &hr, &vh);
  Serial.printf("%d %d %d %d\\n", (int)spo2, (int)vs, (int)hr, (int)vh);
}`);
  await runMs(sim, 14000);
  const r = sim.serial.trim().split(/\r?\n/).at(-1).split(' ').map(Number);
  ok(r[1] === 1 && Math.abs(r[0] - 96) <= 2, `ESP32 SpO2 algorithm: ${r[0]} % valid=${r[1]} (set 96)`);
  ok(r[3] === 1 && Math.abs(r[2] - 80) <= 6, `ESP32 heart rate: ${r[2]} BPM valid=${r[3]} (set 80)`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
