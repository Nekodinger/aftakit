// "Kode otomatis": looks at which microcontroller pin every component is connected to (directly or through the
// breadboard) and writes a complete Arduino sketch with the right libraries, pins, setup and loop for each part.
import { codeFor } from './kb.js';
import { mcusOf, compsOf, wiringState, netsOf } from '../ui/pinmap.js';

const base = (n) => (/^\d+\.\d+V$/.test(n) ? n : String(n).split('.')[0]).toUpperCase();
/** MCU pin name -> Arduino pin expression ("5", "A0"), null for power / GND */
export function ardPin(cat, mcuPin) {
  const g = cat?.gpio?.[mcuPin]; if (typeof g === 'number') return String(g);
  if (/^A\d+$/.test(mcuPin)) return mcuPin;
  const m = /^(?:D|GP|IO)?(\d+)$/.exec(mcuPin); if (m) return m[1];
  return null;
}
const boardKind = (cat) => cat?.board || '';

/** components with their pin map, as seen on the canvas */
export function readCircuit(canvas, catalog) {
  const mcu = mcusOf(canvas, catalog)[0]; if (!mcu) return null;
  const cat = catalog[mcu.type], comps = compsOf(canvas, catalog, mcu), st = wiringState(canvas, mcu, comps);
  // a pin that reaches the MCU through a series resistor (LED anode → 220 Ω → GPIO) counts as connected to that GPIO
  const find = netsOf(canvas), mcuRoot = new Map(mcu.pinInfo.map((i) => [find(`${mcu.id}:${i.name}`), i.name]));
  const resistors = comps.filter((p) => p.type === 'wokwi-resistor');
  const throughR = (ref) => {
    const r0 = find(ref);
    for (const r of resistors) for (const [x, y] of [['1', '2'], ['2', '1']]) if (find(`${r.id}:${x}`) === r0) { const m = mcuRoot.get(find(`${r.id}:${y}`)); if (m) return m; }
    return null;
  };
  const items = comps.filter((p) => p.type !== 'wokwi-resistor').map((p) => {
    const pins = {}, allPins = p.pinInfo.map((i) => base(i.name)), conn = {};
    for (const i of p.pinInfo) {
      const m = st.where.get(`${p.id}:${i.name}`) || throughR(`${p.id}:${i.name}`); if (!m) continue;
      const mp = m.replace('*', ''); conn[i.name] = mp;
      const a = ardPin(cat, mp); if (a != null && pins[base(i.name)] == null) pins[base(i.name)] = a;
    }
    return { id: p.id, type: p.type, name: catalog[p.type]?.name || p.type, attrs: p.attrs || {}, pins, allPins, conn };
  });
  return { mcu, cat, items };
}

/**
 * Build the sketch.
 * @returns {{ code: string, parts: [{id, name, piece, todo}], unknown: string[] }}
 */
export function generateSketch(circ) {
  const board = boardKind(circ.cat), esp = /esp32/.test(board), adcMax = esp ? 4095 : /esp8266|rp2040/.test(board) ? 1023 : 1023;
  const inc = [], glob = [], setup = [], loop = [], parts = [], unknown = [];
  const addU = (arr, xs) => { for (const x of xs || []) if (!arr.includes(x)) arr.push(x); };
  // I²C on non-default ESP32 pins
  const i2c = circ.items.find((it) => it.pins.SDA != null && it.pins.SCL != null && it.type !== 'wokwi-dht22');
  for (const it of circ.items) {
    const c = { ...it, board, adcMax };
    const piece = codeFor(c);
    if (!piece) { if (!/resistor|capacitor|diode|battery|breadboard|npn|mosfet/.test(it.type)) unknown.push(it.id); parts.push({ id: it.id, name: it.name, piece: null }); continue; }
    if (piece.todo) { glob.push(piece.todo); parts.push({ id: it.id, name: it.name, piece: null, todo: piece.todo }); continue; }
    addU(inc, piece.inc);
    glob.push(`// ${it.name} (${it.id})`, ...piece.glob);
    setup.push(...(piece.setup || []).map((l) => l));
    loop.push(`// ${it.id}`, ...piece.loop);
    parts.push({ id: it.id, name: it.name, piece });
  }
  if (i2c && esp && (i2c.pins.SDA !== '21' || i2c.pins.SCL !== '22')) { addU(inc, ['#include <Wire.h>']); setup.unshift(`Wire.begin(${i2c.pins.SDA}, ${i2c.pins.SCL});   // I2C di pin SDA/SCL yang dipakai`); }
  const slow = circ.items.some((it) => /dht/.test(it.type));
  const name = circ.cat?.name || 'mikrokontroler';
  const code = `// Kode otomatis aftakit untuk ${name}
// Komponen: ${circ.items.map((it) => it.id).join(', ') || '-'}
// Buka Serial Monitor (115200 baud) untuk melihat hasil pembacaan.
${inc.join('\n')}${inc.length ? '\n' : ''}
${glob.join('\n')}

void setup() {
  Serial.begin(115200);
${setup.map((l) => '  ' + l).join('\n')}
  Serial.println("Siap!");
}

void loop() {
${loop.map((l) => (l.startsWith('//') ? '\n  ' + l : '  ' + l)).join('\n')}

  delay(${slow ? 2000 : 300});${slow ? '   // DHT dibaca paling cepat tiap 2 detik' : ''}
}
`.replace(/\n{3,}/g, '\n\n');
  return { code, parts, unknown };
}
