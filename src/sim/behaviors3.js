// Behaviours for parts that used to be drawing-only: passives (capacitor, diode), a bare relay, stepper motors,
// the heart-beat sensor, the rotary dialer and the IR remote / receiver.
// Voltages are normalised like in behaviors2.js (1.0 = 5 V). Each factory gets ctx = { sim, part, el, n(pin), ardPins(pin), listen() }.
import { H } from './behaviors2.js';

const { clamp, live, attr, V, US, supply, warnSupply, analogSensor, pulseWave } = H;
const MS = 16000;            // simulator cycles per millisecond (16 cycles per µs on every board)
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const sameCpu = (ctx, ref) => ctx.sim.board.cpu === ref;

// ------------------------------------------------------------------ passives
// Electrolytic capacitor. State: the voltage Vc across it. It charges / discharges with the time constant
// tau = R*C, where R is the resistor connected to its + terminal (the one in the RC network the student built).
// Without such a resistor the wire/ESR value of 50 ohm is used. It drives its + net when nothing else does,
// which is what makes an LED fade out after the supply is removed. Rated voltage and polarity are checked.
const capacitor = (ctx) => {
  let vc = 0, lastC = null, cpuRef = null, warnedRev = false;
  const farads = () => +attr(ctx, 'capacitance', 100) * 1e-6;
  const seriesR = () => {
    const net = ctx.n('+'), rs = [];                          // 0 when no resistor touches +
    for (const b of ctx.sim.behaviors) {
      const links = b.weak?.() || [];
      for (const l of links) if (l[2] > 0 && (l[0] === net || l[1] === net)) rs.push(l[2]);
    }
    if (!rs.length) return 0;
    return 1 / rs.reduce((a, r) => a + 1 / r, 0);          // parallel combination of every resistor touching +
  };
  return {
    drivers2(v, p1) {
      const c = ctx.sim.board.cpu.cycles;
      if (cpuRef !== ctx.sim.board.cpu) { cpuRef = ctx.sim.board.cpu; lastC = c; vc = 0; }
      const dt = Math.max(0, (c - lastC) / 16e6); lastC = c;
      const np = ctx.n('+'), nm = ctx.n('-');
      const vp = v(np), vm = v(nm);
      const ref = live(vm) ? vm : 0;                       // the - side normally sits on GND
      const driven = p1 ? p1.strong(np) : false;
      const Rs = seriesR(), C = farads();
      const upd = (target, R) => { vc += (target - vc) * (dt > 0 ? 1 - Math.exp(-dt / Math.max(1e-6, R * C)) : 0); };
      if (live(vp)) upd(vp - ref, driven ? 50 : Rs || 50);   // towards the source: wired directly (ESR/wires ~50 ohm) or through a resistor
      else if (Rs) upd(0, Rs);                               // no source: discharges through the load resistor
      else upd(0, 600 / C);                                  // open circuit: slow leakage (RC = 600 s)
      vc = clamp(vc, -0.2, 3);
      if (Math.abs(vc) < 0.004) vc = 0;
      return !driven && vc > 0 ? [{ net: np, value: ref + vc, label: ctx.label }] : [];
    },
    render(v) {
      const vp = v(ctx.n('+')), vm = v(ctx.n('-'));
      if (live(vp) && live(vm)) {
        const volts = (vp - vm) * 5, rating = +attr(ctx, 'rating', 16);
        if (volts < -0.7 && !warnedRev) { warnedRev = true; ctx.sim.warn(`cap-rev-${ctx.part.id}`, `${ctx.label}: polaritas terbalik (kaki − lebih positif dari +). Kapasitor elektrolit asli bisa meledak.`); }
        if (volts > rating + 0.01) ctx.sim.warn(`cap-ov-${ctx.part.id}`, `${ctx.label}: tegangan ${volts.toFixed(1)} V melebihi rating ${rating} V.`);
      }
    },
    reset() { vc = 0; lastC = null; cpuRef = null; },
    chargeVolts: () => vc * 5,
  };
};

// Silicon / Schottky diode: conducts from A (anode) to K (cathode) with a forward drop, blocks the other way.
const diode = (ctx) => ({
  drivers2(v, p1) {
    const a = v(ctx.n('A')), k = v(ctx.n('K'));
    const vf = V(+attr(ctx, 'vf', 0.7));
    if (!live(a) || a < vf + 0.002) return [];
    if (live(k) && (p1?.strong(ctx.n('K')) ?? true) && k >= a - vf) return [];      // already at/above A - Vf: reverse or zero bias
    return [{ net: ctx.n('K'), value: a - vf, label: ctx.label }];
  },
});

// ------------------------------------------------------------------ bare double-pole relay KS2E-M-DC5
// 5 V coil (nominal ~178 ohm, 28 mA): pull-in at >= 75 % of rated voltage, drop-out at <= 10 %.
const ks2e = (ctx) => {
  let on = false;
  return {
    attach() {
      const direct = [...ctx.ardPins('COIL1'), ...ctx.ardPins('COIL2')].filter((p) => /^\d+$|^A\d$|^D\d+$/.test(p));
      if (direct.length) ctx.sim.warn(`ks2e-direct-${ctx.part.id}`, `${ctx.label}: koil terhubung langsung ke pin ${direct.join(', ')}. Koil butuh ±28 mA (>20 mA batas aman pin); pakai transistor/MOSFET + dioda flyback.`);
    },
    switches: () => [on ? [ctx.n('P1'), ctx.n('NO1')] : [ctx.n('P1'), ctx.n('NC1')], on ? [ctx.n('P2'), ctx.n('NO2')] : [ctx.n('P2'), ctx.n('NC2')]],
    drivers2(v) {
      const a = v(ctx.n('COIL1')), b = v(ctx.n('COIL2'));
      const d = live(a) && live(b) ? Math.abs(a - b) : 0;
      if (!on && d >= 0.75) on = true; else if (on && d <= 0.1) on = false;
      return [];
    },
    render(v) {
      const a = v(ctx.n('COIL1')), b = v(ctx.n('COIL2'));
      const d = live(a) && live(b) ? Math.abs(a - b) : 0;
      if (d > 0.4 && !on && ctx.sim.running) ctx.sim.warn(`ks2e-low-${ctx.part.id}`, `${ctx.label}: tegangan koil ${(d * 5).toFixed(1)} V terlalu rendah (relay 5 V butuh ≥ 3,75 V). Dengan ESP32 (3,3 V) pakai transistor dari 5 V.`);
    },
    reset() { on = false; },
  };
};

// ------------------------------------------------------------------ stepper motors
// A bipolar two-phase motor: the stator field vector is (iA, iB). The rotor aligns with it, so the electrical angle
// is atan2(iB, iA); one full step (90 deg electrical) moves the shaft by `stepDeg` (NEMA 17: 1.8 deg).
function stepperCore(ctx, pins, stepDeg, onAngle) {
  let re = 0, base = 0, started = false, steps = 0;       // rotor electrical angle (unbounded), zero reference, first-energisation flag
  const dir = (v, p, m) => { const a = v(ctx.n(p)), b = v(ctx.n(m)); if (!live(a) || !live(b)) return 0; const d = a - b; return Math.abs(d) < 0.3 ? 0 : d > 0 ? 1 : -1; };
  return {
    fine: true,
    logicPins: () => pins.map((p) => ctx.n(p)).filter((n) => n >= 0),   // phase pins toggled by software are digital, not PWM
    settle(v) {                                            // runs on the final solution (after drivers such as an L298N)
      const ia = dir(v, pins[0], pins[1]), ib = dir(v, pins[2], pins[3]);
      if (!ia && !ib) return;
      const field = (Math.atan2(ib, ia) * 180) / Math.PI;
      if (!started) { started = true; re = base = field; onAngle(0, 0); return; }   // the shaft shows 0 deg at the first energised position
      const d = wrap180(field - re);
      if (Math.abs(d) < 1e-6 || Math.abs(d) > 179) return;   // no change, or 180 deg flip: the rotor has no torque direction
      re += d; steps += d / 90; onAngle((re - base) * (stepDeg / 90), steps);
    },
    reset() { re = 0; base = 0; started = false; steps = 0; onAngle(0, 0); },
  };
}

const stepperMotor = (ctx) => {
  const core = stepperCore(ctx, ['A+', 'A-', 'B+', 'B-'], +attr(ctx, 'stepDeg', 1.8), (mech) => {
    ctx.el.angle = ((mech % 360) + 360) % 360;
    ctx.el.value = (Math.round(mech * 10) / 10).toFixed(1); ctx.el.units = '°';
  });
  return {
    ...core,
    attach() {
      const direct = ['A+', 'A-', 'B+', 'B-'].flatMap((p) => ctx.ardPins(p)).filter((p) => /^\d+$|^A\d$|^D\d+$/.test(p));
      if (direct.length) ctx.sim.warn(`step-direct-${ctx.part.id}`, `${ctx.label}: koil stepper terhubung langsung ke pin ${direct.join(', ')}. Pin Arduino tidak kuat (±20 mA); pakai driver A4988 / DRV8825 / L298N / ULN2003.`);
    },
  };
};

// Gauge stepper with two hands (X27.168-style): 2 degrees of shaft rotation per electrical cycle (6 steps of 1/3 deg),
// mechanical stop at 315 deg.
const biaxialStepper = (ctx) => {
  const mk = (suffix, key) => stepperCore(ctx, ['A' + suffix + '+', 'A' + suffix + '-', 'B' + suffix + '+', 'B' + suffix + '-'], 0.5 * 1.0, (mech) => {
    // 90 deg electrical = 0.5 deg of hand travel (6 steps/cycle of 1/3 deg -> 2 deg per 360 deg electrical)
    ctx.el[key] = clamp(mech, 0, 315);
  });
  const a = mk('1', 'outerHandAngle'), b = mk('2', 'innerHandAngle');
  return { fine: true, logicPins: () => [...a.logicPins(), ...b.logicPins()], settle(v) { a.settle(v); b.settle(v); }, reset() { a.reset(); b.reset(); } };
};

// ------------------------------------------------------------------ heart-beat sensor: analog pulse waveform
const heartBeat = analogSensor({ out: 'OUT', fn: (c, t) => pulseWave(+attr(c, 'bpm', 75), t) });

// ------------------------------------------------------------------ rotary telephone dial (pulse dialling)
// Two contacts to GND: DIAL closes while the dial is away from rest; PULSE is the normally-closed impulse contact that
// opens once per counted digit: 10 pulses/s, 60 ms open (break) / 40 ms closed (make); the digit 0 sends ten pulses.
const rotaryDialer = (ctx) => {
  let dialClosed = false, pulseClosed = true, cpuRef = null, trainEnd = -1, ended = true, gen = 0;
  const tryRelease = () => { if (ended && (trainEnd < 0 || ctx.sim.board.cpu.cycles >= trainEnd)) { dialClosed = false; ctx.sim.resolveNow(); } };
  return {
    attach() {
      cpuRef = ctx.sim.board.cpu;
      ctx.listen(ctx.el, 'dial-start', () => { dialClosed = true; ended = false; trainEnd = -1; ctx.sim.resolveNow(); });
      ctx.listen(ctx.el, 'dial', (e) => {
        const n = e.detail.digit === 0 ? 10 : e.detail.digit, my = ++gen, board = ctx.sim.board;
        dialClosed = true;
        trainEnd = board.cpu.cycles + n * 100 * MS + 5 * MS;
        for (let i = 0; i < n; i++) {
          ctx.sim.after((i * 100 + 20) * MS, () => { if (gen === my && sameCpu(ctx, cpuRef)) { pulseClosed = false; ctx.sim.resolveNow(); } });
          ctx.sim.after((i * 100 + 80) * MS, () => { if (gen === my && sameCpu(ctx, cpuRef)) { pulseClosed = true; ctx.sim.resolveNow(); } });
        }
        ctx.sim.after(n * 100 * MS + 10 * MS, () => { if (gen === my && sameCpu(ctx, cpuRef)) tryRelease(); });
      });
      ctx.listen(ctx.el, 'dial-end', () => { ended = true; tryRelease(); });
    },
    switches() {
      const out = [];
      if (dialClosed) out.push([ctx.n('DIAL'), ctx.n('GND')]);
      if (pulseClosed) out.push([ctx.n('PULSE'), ctx.n('GND')]);
      return out;
    },
    pullups: () => [ctx.n('DIAL'), ctx.n('PULSE')],
    reset() { dialClosed = false; pulseClosed = true; trainEnd = -1; ended = true; gen++; cpuRef = ctx.sim.board.cpu; },
  };
};

// ------------------------------------------------------------------ IR receiver module (38 kHz demodulator, active-low output)
// Remote: NEC protocol. Frame = 9 ms burst, 4.5 ms gap, 32 bits LSB first (address, ~address, command, ~command),
// each bit = 562 us burst + 562 us gap ('0') or 1687 us gap ('1'), closing 562 us burst. While a key stays down a
// "repeat" code (9 ms burst, 2.25 ms gap, 562 us burst) follows every 108 ms. The demodulator output idles HIGH and
// goes LOW during a burst. The remote is the Wokwi / car-MP3 style remote with address 0x00.
export function necFrame(addr, cmd) {
  const bytes = [addr & 255, ~addr & 255, cmd & 255, ~cmd & 255], seg = [[0, 9000], [1, 4500]];
  for (const b of bytes) for (let i = 0; i < 8; i++) seg.push([0, 562], [1, (b >> i) & 1 ? 1687 : 562]);
  seg.push([0, 562]);
  return seg;
}
export const necRepeat = () => [[0, 9000], [1, 2250], [0, 562]];

const irReceiver = (ctx) => {
  let level = 1, cpuRef = null, gen = 0, held = null, s = { ok: false };
  const remotes = () => ctx.sim.model.parts.filter((p) => p.type === 'wokwi-ir-remote').map((p) => ctx.sim.els.get(p.id)).filter(Boolean);
  const play = (seg, done) => {
    const my = ++gen;
    let i = 0;
    const step = () => {
      if (my !== gen || !sameCpu(ctx, cpuRef)) return;
      if (i >= seg.length) { level = 1; ctx.sim.resolveNow(); done?.(); return; }
      const [lv, us] = seg[i++]; level = lv; ctx.sim.resolveNow();
      ctx.sim.after(us * US, step);
    };
    step();
  };
  return {
    attach() {
      cpuRef = ctx.sim.board.cpu;
      const len = (seg) => seg.reduce((t, x) => t + x[1], 0);
      // decoded frames for the WebAssembly boards' IRremote replacement (the AVR runs the real library on the waveform)
      const queue = (f) => { const q = ((ctx.sim._ir ||= {})[ctx.n('DAT')] ||= []); if (q.length < 16) q.push(f); };
      const send = (code) => {
        const fr = necFrame(0x00, code);
        // hold: repeat codes every 108 ms measured from the start of the previous frame
        const rep = () => { if (!held || !sameCpu(ctx, cpuRef)) return; const r = necRepeat(); play(r, () => { queue({ addr: 0, cmd: code, repeat: 1 }); ctx.sim.after(Math.max(1, 108 * MS - len(r) * US), rep); }); };
        play(fr, () => { queue({ addr: 0, cmd: code, repeat: 0 }); ctx.sim.after(Math.max(1, 108 * MS - len(fr) * US), rep); });
      };
      for (const r of remotes()) {
        ctx.listen(r, 'button-press', (e) => { if (!s.ok) return; held = e.detail.key; send(e.detail.irCode); });
        ctx.listen(r, 'button-release', () => { held = null; });
      }
    },
    drivers2(v) {
      s = supply(ctx, v); if (!s.ok) return [];
      return [{ net: ctx.n('DAT'), value: level ? s.hi : s.lo, label: ctx.label }];
    },
    render(v) { s = supply(ctx, v); warnSupply(ctx, s); },
    reset() { level = 1; gen++; held = null; cpuRef = ctx.sim.board.cpu; },
  };
};

export const BEHAVIORS3 = {
  'mod-capacitor': capacitor,
  'mod-diode': diode,
  'wokwi-ks2e-m-dc5': ks2e,
  'wokwi-stepper-motor': stepperMotor,
  'wokwi-biaxial-stepper': biaxialStepper,
  'wokwi-heart-beat-sensor': heartBeat,
  'wokwi-rotary-dialer': rotaryDialer,
  'wokwi-ir-receiver': irReceiver,
};
