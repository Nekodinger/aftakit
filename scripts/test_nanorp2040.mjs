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

// Arduino Nano RP2040 Connect on the WebAssembly runtime (Arduino mbed numbering D0-D13, A0-A7 = 14-21, WiFiNINA)
const NANO = 'D12 D11 D10 D9 D8 D7 D6 D5 D4 D3 D2 GND.1 RESET RX TX D13 3.3V AREF A0 A1 A2 A3 A4 A5 A6 A7 5V RESET.2 GND.2 VIN'.split(' ');
const NB = { board: ['nano', 'wokwi-nano-rp2040-connect', NANO], kind: 'nanorp2040' };
const lines = (sim) => sim.serial.trim().split(/\r?\n/);
{
  const { sim, els } = await make([['l', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }], ['p', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { value: 1023, min: 0, max: 1023 }, {}]],
    [['nano:D5', 'l:A'], ['l:C', 'nano:GND.1'], ['p:SIG', 'nano:A0'], ['p:VCC', 'nano:3.3V'], ['p:GND', 'nano:GND.2']],
    `void setup(){ Serial.begin(115200); pinMode(5, OUTPUT); pinMode(LED_BUILTIN, OUTPUT); digitalWrite(5, HIGH); }
void loop(){ Serial.println(analogRead(A0)); delay(200); }`, NB);
  await runMs(sim, 500);
  ok(els.get('l').value && Math.abs(els.get('l').brightness - 0.66) < 0.02, `D5 HIGH lights the LED at 3.3 V (${els.get('l').brightness.toFixed(2)})`);
  ok(+lines(sim)[0] === 1023, `analogRead(A0) with A0 at 3.3 V: ${lines(sim)[0]}`);
}
{
  globalThis.fetch = async (url) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode('ok:' + url).buffer });
  const { sim } = await make([], [],
    `#include <WiFiNINA.h>
void setup(){ Serial.begin(115200); while (WiFi.begin("Sekolah", "rahasia") != WL_CONNECTED) delay(500); Serial.println(WiFi.localIP());
  WiFiSSLClient c; Serial.println(WiFi.firmwareVersion() ? "fw" : "fw"); }
void loop(){}`, NB);
  await runMs(sim, 3000);
  ok(/^\d+\.\d+\.\d+\.\d+$/.test(lines(sim)[0]), `WiFiNINA connects: ${lines(sim).join(' | ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
