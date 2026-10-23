// Shared helpers for headless simulator tests: stub DOM elements + real compiled sketches (avr-gcc) on an Uno.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
export const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;

export function compile(src, mcu = 'uno') {
  writeFileSync('/tmp/_kit.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch
print(json.dumps(compile_sketch(open('/tmp/_kit.ino').read(), '${mcu}')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.hex) throw new Error('compile failed: ' + r.stderr); return r.hex;
}
export class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  fire(e, detail) { (this.l[e] || []).forEach((f) => f({ detail })); }
}
export const UNO = ['A5.2', 'A4.2', 'AREF', 'GND.1', '13', '12', '11', '10', '9', '8', '7', '6', '5', '4', '3', '2', '1', '0', 'IOREF', 'RESET', '3.3V', '5V', 'GND.2', 'GND.3', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
export const fakeFont = new Uint8Array(256 * 8).fill(0);
export const MEGA = ['SCL', 'SDA', 'AREF', 'GND.1', ...Array.from({ length: 54 }, (_, i) => String(i)), '5V.1', '5V.2', 'GND.4', 'GND.5', 'IOREF', 'RESET', '3.3V', '5V', 'GND.2', 'GND.3', 'VIN', ...Array.from({ length: 16 }, (_, i) => 'A' + i)];
export function circuit(partsDef, conns, board = 'uno') {
  const B = { uno: ['wokwi-arduino-uno', UNO], mega: ['wokwi-arduino-mega', MEGA], attiny85: ['wokwi-franzininho', ['GND.1', 'VCC.1', 'PB4', 'PB5', 'PB3', 'PB2', 'PB1', 'PB0', 'VIN', 'GND.2', 'VCC.2']] }[board];
  const model = { parts: [{ id: 'uno', type: B[0], attrs: {} }], connections: conns };
  const els = new Map([['uno', new Stub(B[0], B[1])]]);
  for (const [id, type, pins, props, attrs] of partsDef) { model.parts.push({ id, type, attrs: attrs || {} }); els.set(id, new Stub(type, pins, props)); }
  return { model, els };
}
let fails = 0;
export const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
export const done = () => { console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0); };
export const make = (def, conns, sketch, board = 'uno') => {
  const sim = new Simulator(); const { model, els } = circuit(def, conns, board);
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  const diag = sim.build(model, els); if (sketch) sim.loadHex(compile(sketch, board));
  return { sim, els, diag };
};
export const lines = (sim) => sim.serial.trim().split(/\r?\n/);
export const logText = (sim) => sim.logs.map((l) => l.text).join(' | ');
