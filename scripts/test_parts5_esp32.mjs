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

// Phase 5 radios on the ESP32 runtime (RF24 + LoRa libraries compiled for WebAssembly)
const lines = (sim) => sim.serial.trim().split(/\r?\n/);
{
  const { sim } = await make([['r', 'mod-nrf24', ['GND', 'CE', 'SCK', 'MISO', 'VCC', 'CSN', 'MOSI', 'IRQ'], {}, { peer: 'penerima virtual' }]],
    [['esp:D4', 'r:CE'], ['esp:D5', 'r:CSN'], ['esp:D18', 'r:SCK'], ['esp:D23', 'r:MOSI'], ['esp:D19', 'r:MISO'], ['r:VCC', 'esp:3V3'], ['r:GND', 'esp:GND.1']],
    `#include <SPI.h>
#include <RF24.h>
RF24 radio(4, 5); const byte addr[6] = "00001";
void setup(){ Serial.begin(115200); Serial.println(radio.begin() ? "begin ok" : "begin fail"); radio.openWritingPipe(addr); radio.stopListening(); }
void loop(){ int v = 42; Serial.println(radio.write(&v, sizeof(v)) ? "sent ok" : "sent fail"); delay(300); }`);
  await runMs(sim, 800);
  ok(lines(sim)[0] === 'begin ok' && lines(sim)[1] === 'sent ok', `ESP32 RF24: ${lines(sim).join(' | ')}`);
}
{
  const { sim } = await make([['l', 'mod-lora', ['GND', '3.3V', 'RST', 'DIO0', 'NSS', 'MOSI', 'MISO', 'SCK'], {}, { peer: 'gema (kirim balik)' }]],
    [['esp:D5', 'l:NSS'], ['esp:D14', 'l:RST'], ['esp:D2', 'l:DIO0'], ['esp:D18', 'l:SCK'], ['esp:D23', 'l:MOSI'], ['esp:D19', 'l:MISO'], ['l:3.3V', 'esp:3V3'], ['l:GND', 'esp:GND.1']],
    `#include <SPI.h>
#include <LoRa.h>
void setup(){ Serial.begin(115200); LoRa.setPins(5, 14, 2); Serial.println(LoRa.begin(433E6) ? "ok" : "fail"); LoRa.beginPacket(); LoRa.print("esp"); LoRa.endPacket(); }
void loop(){ if (LoRa.parsePacket()) { String s; while (LoRa.available()) s += (char)LoRa.read(); Serial.println(s); } }`);
  await runMs(sim, 1000);
  ok(lines(sim).join('|') === 'ok|esp', `ESP32 LoRa + echo: ${lines(sim).join(' | ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
