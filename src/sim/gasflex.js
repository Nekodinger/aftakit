// MQ-135 air-quality module and the flex (bend) sensor.
//
// MQ-135: tin-dioxide sensing resistor Rs on a heater, read through the module's load resistor RL:
//   AO = Vc · RL / (Rs + RL). Rs/R0 follows the datasheet curves (power laws fitted by the MQUnifiedsensor library:
//   ppm = a · (Rs/R0)^b), equals 3.6 in clean air, and drifts with temperature / humidity (datasheet fig. 4, the
//   correction used by the MQ135 library). A cold sensor reads low resistance until the heater has warmed it.
//   DO comes from the LM393 comparator: LOW (LED on) when AO is above the potentiometer threshold.
// Flex sensor: a two-terminal resistor that rises with bending; it needs a divider resistor. The divider is solved
//   from every resistor (and MCU pull-up) on the sense node: V = Σ(Vi/Ri) / Σ(1/Ri).
import { H } from './behaviors2.js';

const { clamp, live, attr, led } = H;
const CPS = 16e6;

// ------------------------------------------------------------------ MQ-135
export const MQ135_GAS = {                         // ppm = a · ratio^b (Rs/R0), datasheet fits
  CO2: [110.47, -2.862], 'NH3 (amonia)': [102.2, -2.473], Alkohol: [77.255, -3.18], 'Toluena': [44.947, -3.445], 'Aseton': [34.668, -3.369], CO: [605.18, -3.937],
};
const R0 = 15000, CLEAN = 3.6;
const ratioFor = ([a, b], ppm) => (ppm > 0 ? (ppm / a) ** (1 / b) : Infinity);
const tempHum = (t, h) => (0.00035 * t * t - 0.02718 * t + 1.39538 - (h - 33) * 0.0018) / (0.00035 * 400 - 0.02718 * 20 + 1.39538);

export function mq135Rs(attrs, warm = 1) {
  const co2 = +(attrs.co2 ?? 400), gas = attrs.gas ?? 'tidak ada', ppm = +(attrs.gasppm ?? 0);
  let ratio = Math.min(CLEAN, ratioFor(MQ135_GAS.CO2, co2 - 400));       // the curves give the gas added to clean air (≈400 ppm CO2)
  if (MQ135_GAS[gas] && ppm > 0) ratio = Math.min(ratio, ratioFor(MQ135_GAS[gas], ppm));
  return R0 * ratio * tempHum(+(attrs.temp ?? 20), +(attrs.hum ?? 33)) * warm;
}

const mq135 = (ctx) => {
  const sim = ctx.sim;
  let vc = 0, ao = 0, dlow = false, onAt = null, warnedV = false;
  return {
    drivers2(v) {
      const a = v(ctx.n('VCC')), g = v(ctx.n('GND'));
      vc = live(a) && live(g) ? (a - g) * 5 : 0;
      if (vc < 2.5) { onAt = null; return []; }
      const now = sim.board.cpu.cycles;
      onAt ??= now;
      const t = (now - onAt) / CPS;                                       // heater warm-up: cold SnO2 has a low resistance
      const warm = 0.3 + 0.7 * (1 - Math.exp(-t / 20));
      const rl = (parseFloat(attr(ctx, 'rl', '10')) || 10) * 1000;
      const rs = mq135Rs({ co2: attr(ctx, 'co2', 400), gas: attr(ctx, 'gas', 'tidak ada'), gasppm: attr(ctx, 'gasppm', 0), temp: attr(ctx, 'temp', 20), hum: attr(ctx, 'hum', 33) }, warm);
      ao = (vc * rl) / (rs + rl);
      dlow = ao > vc * clamp(+attr(ctx, 'threshold', 40) / 100);
      return [{ net: ctx.n('AO'), value: (g + ao / 5), label: ctx.label + ' AO' }, { net: ctx.n('DO'), value: dlow ? g : g + vc / 5, label: ctx.label + ' DO' }];
    },
    render() {
      led(ctx, 'pwr', vc > 2.5); led(ctx, 'sig', dlow);
      if (sim.running && vc > 0 && vc < 4.5 && !warnedV) { warnedV = true; sim.warn(`mq135-v-${ctx.part.id}`, `${ctx.label}: pemanas MQ-135 butuh 5 V (±150 mA); pada ${vc.toFixed(1)} V pembacaan tidak akurat. Hubungkan VCC ke 5V/VIN.`); }
    },
    reset() { onAt = null; warnedV = false; },
  };
};

// ------------------------------------------------------------------ flex sensor
const FLEX = { '2.2"': { flat: 25000, k: 0.0156 }, '4.5"': { flat: 10000, k: 0.011 } };
export const flexOhms = (type, deg) => { const f = FLEX[String(type).startsWith('4.5') ? '4.5"' : '2.2"']; return f.flat * (1 + f.k * Math.max(-20, deg)); };

const flex = (ctx) => {
  const sim = ctx.sim;
  let out = null, warned = false;
  const ohms = () => flexOhms(attr(ctx, 'type', '2.2"'), +attr(ctx, 'angle', 0));
  return {
    // own resistance as a weak link (lets RC parts / other dividers see it)
    weak: () => [[ctx.n('1'), ctx.n('2'), ohms()]],
    drivers2(v, pass1) {
      out = null;
      const a = ctx.n('1'), b = ctx.n('2');
      const sa = pass1?.strong(a), sb = pass1?.strong(b);
      if (sa === sb) return [];                                           // both ends driven (or neither): no divider node
      const sense = sa ? b : a, src = sa ? a : b, vs = v(src);
      if (!live(vs)) return [];
      const edges = [{ v: vs, r: ohms() }];
      for (const bh of sim.behaviors) {
        if (bh._part?.id === ctx.part.id || !bh.weak) continue;
        for (const [x, y, r] of bh.weak()) {
          if (!r || (x !== sense && y !== sense)) continue;
          const o = x === sense ? y : x, vo = v(o);
          if (o !== sense && live(vo) && pass1.strong(o)) edges.push({ v: vo, r });
        }
      }
      for (const p of sim.arduinoPinsOnNet(sense)) if (sim.board.isPullup(p)) edges.push({ v: sim.board.vHigh ?? 1, r: sim.board.kind === 'avr' ? 35000 : 45000 });
      if (edges.length < 2) {
        if (!warned && sim.running && sim.arduinoPinsOnNet(sense).length) { warned = true; sim.warn(`flex-div-${ctx.part.id}`, `${ctx.label}: sensor flex butuh resistor pembagi tegangan (mis. 47 kΩ dari pin analog ke GND), kalau tidak pembacaan mengambang.`); }
        return [];
      }
      let num = 0, den = 0; for (const e of edges) { num += e.v / e.r; den += 1 / e.r; }
      out = num / den;
      return [{ net: sense, value: out, label: ctx.label }];
    },
    render() { ctx.el.setText?.('r', `${(ohms() / 1000).toFixed(0)} kΩ`); },
    reset() { warned = false; },
  };
};

export const GASFLEX_BEHAVIORS = { 'mod-mq135': mq135, 'mod-flex': flex };
