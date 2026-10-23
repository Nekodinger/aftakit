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

// UART modules on the WebAssembly boards: Serial2 / custom pins / SoftwareSerial shim.
const lines = (sim) => sim.serial.trim().split(/\r?\n/);
{
  const { sim } = await make([['g', 'mod-gps', ['VCC', 'RX', 'TX', 'GND'], {}, { lat: '-6.9147', lng: '107.6098' }]],
    [['g:TX', 'esp:RX2'], ['g:RX', 'esp:TX2'], ['g:VCC', 'esp:3V3'], ['g:GND', 'esp:GND.1']],
    `#include <TinyGPS++.h>
TinyGPSPlus gps;
void setup(){ Serial.begin(115200); Serial2.begin(9600); }
void loop(){ while (Serial2.available()) gps.encode(Serial2.read()); if (gps.location.isUpdated()) { Serial.printf("%.4f %.4f\\n", gps.location.lat(), gps.location.lng()); delay(2000); } }`);
  await runMs(sim, 2500);
  ok(lines(sim)[0] === '-6.9147 107.6098', `ESP32 Serial2 (GPIO16/17) + TinyGPS++: ${lines(sim).join(' | ')}`);
}
{
  const { sim } = await make([['m', 'mod-sim800l', ['NET', 'VCC', 'RST', 'RXD', 'TXD', 'GND']]],
    [['m:TXD', 'esp:D26'], ['m:RXD', 'esp:D27'], ['m:VCC', 'esp:VIN'], ['m:GND', 'esp:GND.1']],
    `void setup(){ Serial.begin(115200); Serial1.begin(9600, SERIAL_8N1, 26, 27); delay(3500); while (Serial1.available()) Serial1.read();
  Serial1.println("AT+CSQ"); delay(200); while (Serial1.available()) Serial.write(Serial1.read()); }
void loop(){}`);
  await runMs(sim, 4000);
  ok(/\+CSQ: 20,0/.test(sim.serial), `ESP32 Serial1 on custom pins (26/27) + SIM800L: ${JSON.stringify(sim.serial)}`);
}
{
  const { sim } = await make([['g', 'mod-gps', ['VCC', 'RX', 'TX', 'GND']]],
    [['g:TX', 'esp:D4'], ['g:RX', 'esp:D5'], ['g:VCC', 'esp:3V3'], ['g:GND', 'esp:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial ss(4, 5);
void setup(){ Serial.begin(115200); ss.begin(9600); }
void loop(){ static String s; while (ss.available()) { char c = ss.read(); if (c == '\\n') { if (s.startsWith("$GPRMC")) { Serial.println(s.substring(0, 6)); delay(3000); } s = ""; } else s += c; } }`);
  await runMs(sim, 2000);
  ok(lines(sim)[0] === '$GPRMC', `ESP32 SoftwareSerial shim: ${lines(sim).join(' | ')}`);
}
{
  const wrong = await make([['g', 'mod-gps', ['VCC', 'RX', 'TX', 'GND']]],
    [['g:TX', 'esp:RX2'], ['g:VCC', 'esp:3V3'], ['g:GND', 'esp:GND.1']],
    `void setup(){ Serial.begin(115200); Serial2.begin(115200); } void loop(){ if (Serial2.available()) Serial.write(Serial2.read()); }`);
  await runMs(wrong.sim, 1500);
  ok(wrong.sim.serial === '' && /baud rate tidak cocok/.test(logs(wrong.sim)), 'baud mismatch on Serial2 -> no data + clear warning');
}
{
  const { sim, els } = await make([['ir', 'wokwi-ir-receiver', ['GND', 'VCC', 'DAT']], ['rem', 'wokwi-ir-remote', []]], [['ir:VCC', 'esp:3V3'], ['ir:GND', 'esp:GND.1'], ['ir:DAT', 'esp:D15']],
    `#include <IRremote.hpp>
IRrecv old(15); decode_results r;
void setup(){ Serial.begin(115200); IrReceiver.begin(15, ENABLE_LED_FEEDBACK); }
void loop(){ if (IrReceiver.decode()) { Serial.printf("%s %X %X %d\\n", getProtocolString(IrReceiver.decodedIRData.protocol), IrReceiver.decodedIRData.command, IrReceiver.decodedIRData.decodedRawData, IrReceiver.decodedIRData.flags); IrReceiver.resume(); } delay(5); }`);
  const rem = els.get('rem');
  await runMs(sim, 100); rem.fire('button-press', { key: '1', irCode: 0x30 }); await runMs(sim, 200); rem.fire('button-release', { key: '1', irCode: 0x30 }); await runMs(sim, 200);
  ok(lines(sim)[0] === 'NEC 30 CF30FF00 0' && lines(sim)[1] === 'NEC 30 0 1', `ESP32 IRremote: ${lines(sim).join(' | ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
