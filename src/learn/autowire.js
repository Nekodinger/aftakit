// "Sambung otomatis": every unconnected pin of every component gets a suitable, still-free pin of the
// microcontroller (power at the right voltage, GND, the board's I²C / SPI / UART pins, ADC pins for analog outputs,
// PWM pins where needed, plain GPIO for the rest). An LED goes through a free resistor when there is one.
// The same plan drives the Newbie guide, which asks the student to make each connection by hand.
import { mcusOf, compsOf, planComp, wiringState, netsOf } from '../ui/pinmap.js';
import { pinReason, wireColorTip } from './kb.js';

const COLORS = { power: '#e11d48', gnd: '#1f2937', i2c: ['#f5a524', '#3d8bfd'], analog: '#2fbf71', digital: ['#fb923c', '#a855f7', '#06b6d4', '#3d8bfd', '#2fbf71', '#f5a524'], spi: '#a855f7', uart: '#06b6d4' };
const free = (canvas, part) => !canvas.wires.some((w) => w.a.startsWith(part.id + ':') || w.b.startsWith(part.id + ':'));

/**
 * The connections still to be made.
 * @returns {{ mcu, steps: [{ a, b, comp, compPin, mcuPin, role, reason, tip, color }] } | null}
 */
export function planWiring(canvas, catalog) {
  const mcu = mcusOf(canvas, catalog)[0]; if (!mcu) return null;
  const board = catalog[mcu.type]?.board || '', used = new Set(), steps = [];
  const comps = compsOf(canvas, catalog, mcu);
  const resistors = comps.filter((p) => p.type === 'wokwi-resistor' && free(canvas, p));
  let dIdx = 0;
  for (const comp of comps) {
    if (comp.type === 'wokwi-resistor' || /capacitor|diode|battery|breadboard/.test(comp.type)) continue;
    for (const x of planComp(canvas, catalog, mcu, comp, used)) {
      const color = x.role === 'power' ? COLORS.power : x.role === 'gnd' ? COLORS.gnd : x.role === 'i2c' ? (x.sig === 'SDA' ? COLORS.i2c[0] : COLORS.i2c[1]) : x.role === 'analog' ? COLORS.analog : x.role === 'spi' ? COLORS.spi : x.role === 'uart' ? COLORS.uart : COLORS.digital[dIdx++ % COLORS.digital.length];
      const step = { comp: comp.id, compPin: x.compPin, mcuPin: x.mcuPin, role: x.role, color, a: `${mcu.id}:${x.mcuPin}`, b: `${comp.id}:${x.compPin}` };
      step.reason = pinReason(comp.type, x.compPin, x, board); step.tip = wireColorTip(x.role);
      // LED anode through a series resistor (220 Ω) when one is waiting in the workspace
      if (comp.type === 'wokwi-led' && x.compPin === 'A' && resistors.length) {
        const r = resistors.shift();
        steps.push({ ...step, b: `${r.id}:1`, comp: r.id, compPin: '1', reason: `Arus LED harus dibatasi resistor: pin ${x.mcuPin} → kaki 1 resistor ${r.id}.`, tip: step.tip });
        steps.push({ ...step, a: `${r.id}:2`, mcu: false, reason: `Kaki 2 resistor ${r.id} → kaki A (anoda, kaki panjang) LED ${comp.id}. Resistor 220 Ω membatasi arus ±15 mA agar LED dan pin tidak rusak.` });
        continue;
      }
      steps.push(step);
    }
  }
  return { mcu, board, steps };
}

/** are two pins already connected (directly, through the breadboard or another wire)? */
export function connected(canvas, a, b) { const find = netsOf(canvas); return find(a) === find(b); }

/** make every planned connection; returns the number of wires added */
export function applyWiring(canvas, plan) {
  let n = 0;
  for (const s of plan.steps) if (!connected(canvas, s.a, s.b) && canvas._addWire(s.a, s.b, s.color, true)) n++;
  if (n) canvas.emit('change', { structural: true });
  return n;
}
