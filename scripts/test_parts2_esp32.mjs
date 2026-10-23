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

// Phase 2 parts on the WebAssembly ESP32 runtime: DS18B20 (OneWire + DallasTemperature), HX711, TM1637 with the real libraries.
{
  const { sim } = await make([['ds', 'mod-ds18b20', ['GND', 'DQ', 'VDD'], {}, { temperature: '31.25' }], ['rp', 'wokwi-resistor', ['1', '2'], {}, { value: '4700' }]],
    [['esp:D4', 'ds:DQ'], ['ds:GND', 'esp:GND.1'], ['ds:VDD', 'esp:3V3'], ['rp:1', 'esp:3V3'], ['rp:2', 'esp:D4']],
    `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(4); DallasTemperature ds(&ow);
void setup(){ Serial.begin(115200); ds.begin(); Serial.print("n="); Serial.println(ds.getDeviceCount()); }
void loop(){ ds.requestTemperatures(); Serial.println(ds.getTempCByIndex(0)); delay(1000); }`);
  await runMs(sim, 3500);
  const l = sim.serial.trim().split(/\r?\n/);
  ok(l[0] === 'n=1' && l.slice(1).some((x) => Math.abs(parseFloat(x) - 31.25) < 0.07), `ESP32 DS18B20: ${l.slice(0, 3).join(' ')}`);
}
{
  const { sim } = await make([['hx', 'wokwi-hx711', ['VCC', 'DT', 'SCK', 'GND'], {}, { weight: '2000', type: '5kg' }]],
    [['esp:D18', 'hx:DT'], ['esp:D19', 'hx:SCK'], ['hx:VCC', 'esp:3V3'], ['hx:GND', 'esp:GND.1']],
    `#include <HX711.h>
HX711 s;
void setup(){ Serial.begin(115200); s.begin(18, 19); }
void loop(){ if (s.is_ready()) Serial.println(s.read()); delay(200); }`);
  await runMs(sim, 1500);
  const v = +sim.serial.trim().split(/\r?\n/).at(-1), th = (2000 / 5000) * 0.001 * 128 * 16777216 + 40;
  ok(Math.abs(v - th) < 10, `ESP32 HX711 2 kg: ${v} (theory ${th.toFixed(0)})`);
}
{
  const { sim, els } = await make([['tm', 'mod-tm1637', ['CLK', 'DIO', 'VCC', 'GND'], { frames: [], setSeg7(b, br, on) { this.frames.push([Array.from(b), br, on]); } }]],
    [['esp:D21', 'tm:CLK'], ['esp:D22', 'tm:DIO'], ['tm:VCC', 'esp:3V3'], ['tm:GND', 'esp:GND.1']],
    `#include <TM1637Display.h>
TM1637Display d(21, 22);
void setup(){ d.setBrightness(5); d.showNumberDec(2026, true); }
void loop(){}`);
  await runMs(sim, 300);
  const f = els.get('tm').frames.at(-1);
  ok(f && f[0].join() === [0x5b, 0x3f, 0x5b, 0x7d].join(), `ESP32 TM1637 shows 2026: ${f && f[0].map((x) => x.toString(16)).join(' ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
