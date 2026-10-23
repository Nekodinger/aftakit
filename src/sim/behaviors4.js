// Pin-level protocol parts: DS18B20 (1-Wire), TM1637 display, HX711 load-cell amplifier.
import { H } from './behaviors2.js';
import { OneWireBus, DS18B20, busFor } from './wire1.js';
import { TM1637, HX711 } from './twowire.js';

const { clamp, live, attr, supply, warnSupply } = H;
const lvlOf = (l) => (l === 0 ? 0 : 1);          // 0 = pulled low, anything else (1 = driven high, null = released) = high

// the net has a resistor to somewhere (a pull-up) or a pin with the internal pull-up enabled
function hasPullResistor(ctx, net) {
  return ctx.sim.behaviors.some((b) => (b.weak?.() || []).some((l) => l[0] === net || l[1] === net));
}

// ------------------------------------------------------------------ DS18B20
const ds18b20 = (ctx) => {
  let dev = null, bus = null, owner = false, s = { ok: false }, gndOk = false, pull = false;
  return {
    attach() {
      const net = ctx.n('DQ'); bus = busFor(ctx.sim, net, ctx.label);
      const idx = ctx.sim.model.parts.filter((p) => p.type === 'mod-ds18b20').findIndex((p) => p.id === ctx.part.id);
      dev = new DS18B20(ctx.label, () => attr(ctx, 'temperature', 25), idx);
      bus.add(dev);
      pull = hasPullResistor(ctx, net);
      if (!bus.owner) {
        bus.owner = ctx.part.id; owner = true;
        const pins = ctx.ardPins('DQ');
        if (!pins.length) ctx.sim.warn(`ds-pin-${ctx.part.id}`, `${ctx.label}: pin DQ belum terhubung ke pin Arduino/ESP32.`);
        for (const p of pins) ctx.sim.board.onEdge(p, (l, t) => bus.edge(lvlOf(l), t));
        bus.onReset = () => {
          if (!bus.pullChecked) {
            bus.pullChecked = true;
            const anyPull = bus.pull || pins.some((p) => ctx.sim.board.isPullup?.(p));
            if (!anyPull) ctx.sim.warn(`ds-pull-${ctx.part.id}`, `${ctx.label}: jalur DQ tidak punya resistor pull-up. Pasang resistor 4,7 kΩ antara DQ dan VDD; tanpa itu library melaporkan sensor tidak ditemukan (−127 °C).`);
          }
        };
      }
      bus.pull = bus.pull || pull;
    },
    finePins: () => (owner ? ctx.ardPins('DQ') : []),
    drivers1: () => (owner && bus.low ? [{ net: ctx.n('DQ'), value: 0, label: ctx.label }] : []),
    drivers2(v) {
      s = supply(ctx, v); gndOk = live(s.lo) && s.lo < 0.25;
      dev.powered = gndOk; dev.parasite = !s.ok;
      return [];
    },
    render(v) {
      s = supply(ctx, v); gndOk = live(s.lo) && s.lo < 0.25;
      if (owner && ctx.sim.running && v(ctx.n('DQ')) === null && ctx.ardPins('DQ').every((p) => ctx.sim.board.driveLevel(p) === null) && ctx.sim.board.cpu.cycles > 16000 * 20)
        ctx.sim.warn(`ds-pull-${ctx.part.id}`, `${ctx.label}: jalur DQ mengambang (tidak ada pull-up). Pasang resistor 4,7 kΩ antara DQ dan VDD; tanpa itu library melaporkan sensor tidak ditemukan (−127 °C).`);
      if (!gndOk && ctx.sim.running) ctx.sim.warn(`ds-gnd-${ctx.part.id}`, `${ctx.label}: pin GND belum terhubung ke GND, sensor tidak menjawab.`);
      else if (gndOk && !s.ok && ctx.sim.running && dev.busyUntil >= 0) ctx.sim.warn(`ds-par-${ctx.part.id}`, `${ctx.label}: VDD tidak diberi 3–5,5 V (mode parasit). Konversi suhu butuh pull-up kuat; hubungkan VDD ke 5V/3V3 agar terbaca benar.`);
    },
    reset() { dev?.reset(); if (owner) bus.hardReset(); },
    dev: () => dev,
  };
};

// ------------------------------------------------------------------ TM1637 4-digit display
const tm1637 = (ctx) => {
  let chip = null, dioLow = false, s = { ok: false };
  const paint = () => {
    if (!chip) return;
    const on = s.ok && chip.on, bright = on ? (chip.bright + 1) / 8 : 0;
    ctx.el.setSeg7?.(Array.from(chip.mem.slice(0, 4)), bright, s.ok && chip.on);
  };
  return {
    attach() {
      chip = new TM1637({ dioLow: (low) => { if (dioLow !== low) { dioLow = low; ctx.sim.resolveNow(); } } }, paint);
      const clk = ctx.ardPins('CLK'), dio = ctx.ardPins('DIO');
      if (!clk.length) ctx.sim.warn(`tm-clk-${ctx.part.id}`, `${ctx.label}: pin CLK belum terhubung ke pin Arduino.`);
      if (!dio.length) ctx.sim.warn(`tm-dio-${ctx.part.id}`, `${ctx.label}: pin DIO belum terhubung ke pin Arduino.`);
      for (const p of clk) ctx.sim.board.onEdge(p, (l) => { if (s.ok) chip.edgeClk(lvlOf(l)); });
      for (const p of dio) ctx.sim.board.onEdge(p, (l) => { if (s.ok) chip.edgeDio(lvlOf(l)); });
    },
    finePins: () => [...ctx.ardPins('CLK'), ...ctx.ardPins('DIO')],
    pullups: () => (s.ok ? [ctx.n('CLK'), ctx.n('DIO')] : []),                        // the module has pull-ups on both lines
    drivers1: () => (s.ok && dioLow ? [{ net: ctx.n('DIO'), value: 0, label: ctx.label }] : []),
    drivers2(v) { s = supply(ctx, v); return []; },
    render(v) { const was = s.ok; s = supply(ctx, v); warnSupply(ctx, s); if (was !== s.ok) paint(); },
    reset() { chip?.reset(); dioLow = false; paint(); },
    chip: () => chip,
  };
};

// ------------------------------------------------------------------ HX711 + load cell
// counts = (load / capacity) * sensitivity(1 mV/V) * gain * 2^24   (differential input, ratiometric to the 5 V excitation)
const hx711 = (ctx) => {
  let chip = null, dt = 1, s = { ok: false }, seed = 12345;
  const capacity = () => (attr(ctx, 'type', '5kg') === '50kg' ? 50000 : 5000);
  const sample = (gain) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const noise = ((seed >>> 16) % 7) - 3;                       // +-3 counts of ADC noise
    if (gain === 32) return noise;                               // channel B is not connected
    const w = clamp(+attr(ctx, 'weight', 0), 0, capacity() * 1.2);
    const counts = (w / capacity()) * 0.001 * gain * 16777216 + noise + 40;     // + a small zero offset, as a real cell has
    return Math.round(Math.max(-8388608, Math.min(8388607, counts)));
  };
  return {
    attach() {
      chip = new HX711({ dt: (l) => { if (dt !== l) { dt = l; ctx.sim.resolveNow(); } }, after: (c, f) => ctx.sim.after(c, f) }, sample);
      const sck = ctx.ardPins('SCK');
      if (!sck.length) ctx.sim.warn(`hx-sck-${ctx.part.id}`, `${ctx.label}: pin SCK belum terhubung ke pin Arduino.`);
      if (!ctx.ardPins('DT').length) ctx.sim.warn(`hx-dt-${ctx.part.id}`, `${ctx.label}: pin DT belum terhubung ke pin Arduino.`);
      for (const p of sck) ctx.sim.board.onEdge(p, (l, t) => { if (s.ok) chip.edgeSck(lvlOf(l), t); });
    },
    drivers1: () => (s.ok ? [{ net: ctx.n('DT'), value: dt ? s.hi : s.lo, label: ctx.label }] : []),
    drivers2(v) { s = supply(ctx, v); return []; },
    render(v) { s = supply(ctx, v); warnSupply(ctx, s); },
    reset() { chip?.reset(); dt = 1; },
  };
};

export const BEHAVIORS4 = {
  'mod-ds18b20': ds18b20,
  'mod-tm1637': tm1637,
  'wokwi-hx711': hx711,
};
