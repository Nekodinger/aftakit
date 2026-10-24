// DC motors (brushed and brushless + ESC), LiPo batteries, an RC receiver and quadcopter flight physics.
//
// Motors share one electromechanical model: armature current I = (V − Ke·ω)/R, motor torque Kt·(I − I0) with Kt = Ke
// (SI units, Ke = 60 / (2π·KV)), propeller load Q = C_P/(2π)·ρ·n²·D⁵ and thrust T = C_T·ρ·n²·D⁴ (n in rev/s).
// The spin-up ODE J·dω/dt = Kt(I − I0) − Q is integrated with a linearised implicit Euler step (stable for the tiny rotor
// inertia of coreless motors). Parameters are fitted to bench data: A2212/1000KV + 1045 on 3S ≈ 840 g at 14.7 A,
// 2205/2300KV + 5045 on 4S ≈ 930 g at 23 A, 8520 coreless + 65 mm on 1S ≈ 34 g at 3 A.
//
// The quadcopter is a 6-DOF rigid body (body axes x forward, y left, z up; quaternion attitude) driven by the four
// rotor thrusts, the rotor drag torques (yaw) and gyroscopic/drag terms, with ground contact. Sensors on the frame
// (MPU6050, BMP280, VL53L0X, TF-Luna) read the body's specific force, angular rate, altitude and height above ground.
import { H } from './behaviors2.js';
import { uartLink } from './uart.js';

const { clamp, live, attr } = H;
const US = 16, CPS = 16e6, RHO = 1.225, G = 9.80665, TWO_PI = 2 * Math.PI;
const DT = 0.001, DT_CYC = Math.round(DT * CPS);           // physics step: 1 ms of simulated time

// ------------------------------------------------------------------ parameter tables
// kv rpm/V · R Ω (winding + ESC/wiring) · I0 no-load A · J rotor kg·m² · vNom rated V (brushed) · cells recommended (brushless)
export const MOTORS = {
  'mod-motor-tt': { kv: 1650, R: 4.0, I0: 0.12, J: 2e-7, vNom: 6, vMax: 7.5, gear: 48, b: 2e-7 },
  'mod-motor-130': { kv: 1950, R: 2.6, I0: 0.15, J: 3e-7, vNom: 6, vMax: 7.5 },
  'mod-motor-coreless': { kv: 16000, R: 0.8, I0: 0.08, J: 5e-9, vNom: 3.7, vMax: 4.6 },
  'mod-motor-rs385': { kv: 750, R: 2.0, I0: 0.2, J: 4e-6, vNom: 12, vMax: 18 },
  'mod-motor-rs775': { kv: 1000, R: 0.4, I0: 0.6, J: 2e-5, vNom: 12, vMax: 24 },
  'mod-bldc-a2212': { kv: 1000, R: 0.26, I0: 0.5, J: 1.2e-5, cells: [2, 3], bldc: true },
  'mod-bldc-2205': { kv: 2300, R: 0.11, I0: 1.0, J: 4e-6, cells: [3, 4], bldc: true },
};
// propellers: D m, static thrust / power coefficients, J kg·m²
const PROPS = {
  '1045': { D: 0.254, CT: 0.11, CP: 0.045, J: 2.4e-5 }, '9450': { D: 0.239, CT: 0.115, CP: 0.05, J: 2.0e-5 }, '8045': { D: 0.203, CT: 0.11, CP: 0.045, J: 1.1e-5 },
  '5045': { D: 0.127, CT: 0.13, CP: 0.065, J: 4e-6 }, '5040': { D: 0.127, CT: 0.12, CP: 0.055, J: 3.8e-6 },
  '65': { D: 0.065, CT: 0.12, CP: 0.06, J: 2.5e-8 }, '55': { D: 0.055, CT: 0.12, CP: 0.06, J: 1.5e-8 },
  '75': { D: 0.075, CT: 0.1, CP: 0.05, J: 6e-8 }, '5in': { D: 0.127, CT: 0.1, CP: 0.05, J: 4e-6 }, '8in': { D: 0.203, CT: 0.1, CP: 0.045, J: 1.1e-5 },
};
const propOf = (txt) => {
  const s = String(txt || '');
  if (/tanpa/.test(s)) return null;
  const k = s.match(/^(\d{4})/)?.[1] || (/65 mm/.test(s) ? '65' : /55 mm/.test(s) ? '55' : /75 mm/.test(s) ? '75' : /5 inch/.test(s) ? '5in' : /8 inch/.test(s) ? '8in' : null);
  return k ? PROPS[k] : null;
};
// frame presets: mass kg, motor arm (centre to motor) m, inertia kg·m², frontal drag area m², sensor height m
const FRAMES = {
  F450: { m: 1.0, L: 0.225, I: [0.0110, 0.0110, 0.0200], A: 0.06, h: 0.06 },
  '250': { m: 0.55, L: 0.125, I: [0.0030, 0.0030, 0.0055], A: 0.025, h: 0.03 },
  Mini: { m: 0.040, L: 0.046, I: [2.0e-5, 2.0e-5, 3.6e-5], A: 0.004, h: 0.012 },
};
const frameOf = (txt) => (/250/.test(txt) ? FRAMES['250'] : /Mini/.test(txt) ? FRAMES.Mini : FRAMES.F450);
// drone slots: name, body position unit vector (x forward, y left), spin seen from above (+1 = CCW)
export const SLOTS = [
  { key: 'm1', name: 'Depan-Kanan', x: 1, y: -1, spin: 1 },
  { key: 'm2', name: 'Belakang-Kanan', x: -1, y: -1, spin: -1 },
  { key: 'm3', name: 'Belakang-Kiri', x: -1, y: 1, spin: 1 },
  { key: 'm4', name: 'Depan-Kiri', x: 1, y: 1, spin: -1 },
];
// LiPo open-circuit voltage per cell vs state of charge
const OCV = [[0, 3.27], [0.05, 3.61], [0.1, 3.69], [0.2, 3.74], [0.3, 3.77], [0.4, 3.79], [0.5, 3.82], [0.6, 3.87], [0.7, 3.92], [0.8, 3.98], [0.9, 4.06], [1, 4.2]];
const ocv = (s) => { s = clamp(s); for (let i = 1; i < OCV.length; i++) if (s <= OCV[i][0]) { const [a, va] = OCV[i - 1], [b, vb] = OCV[i]; return va + (vb - va) * (s - a) / (b - a); } return 4.2; };

// ------------------------------------------------------------------ physics clock (1 ms steps in simulated time)
class Phys {
  constructor(sim) { this.sim = sim; this.items = []; this.gen = 0; this.t = 0; this.loads = new Map(); this.rotors = []; this.escs = []; this.batteries = []; }
  add(o, order) { this.items.push({ o, order }); this.items.sort((a, b) => a.order - b.order); }
  restart() {
    const my = ++this.gen; this.t = 0; this.loads.clear();
    const tick = () => {
      if (my !== this.gen) return;
      for (const it of this.items) it.o.step(DT);
      this.t += DT;
      this.sim.after(DT_CYC, tick);
    };
    this.sim.after(DT_CYC, tick);
  }
  batteryFor(net) { return this.batteries.find((b) => b.posNet === net) || (this.batteries.length === 1 ? this.batteries[0] : null); }
}
export const phys = (sim) => (sim._phys ||= new Phys(sim));
const rng = () => { let s = 0x9e3779b9; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; };
const gauss = (r) => (r() + r() + r()) / 1.732;

// ------------------------------------------------------------------ rotor (motor + propeller)
export class Rotor {
  constructor(m, prop) {
    this.m = m; this.prop = prop; this.Ke = 60 / (TWO_PI * m.kv);
    this.J = m.J + (prop?.J || 0);
    this.cq = prop ? (prop.CP / TWO_PI) * RHO * prop.D ** 5 / (TWO_PI * TWO_PI) : 0;   // Q = cq·ω²
    this.ct = prop ? prop.CT * RHO * prop.D ** 4 / (TWO_PI * TWO_PI) : 0;              // T = ct·ω²
    this.reset();
  }
  reset() { this.w = 0; this.I = 0; this.dw = 0; }
  /** V: applied (average) voltage; free = no current path (ESC off / disarmed) */
  step(dt, V, free = false) {
    const { R, I0, b = 0 } = this.m, Ke = this.Ke, w = this.w;
    const I = free ? 0 : (V - Ke * w) / R;
    const fr = Ke * I0 * Math.sign(w);                                   // bearing / iron losses
    const drive = Ke * I;
    if (Math.abs(w) < 1 && Math.abs(drive) <= Ke * I0) { this.I = free ? 0 : I; this.dw = -w / dt; this.w = 0; return; }   // static friction holds the rotor
    const f = drive - fr - this.cq * w * Math.abs(w) - b * w;
    const k = (free ? 0 : Ke * Ke / R) + 2 * this.cq * Math.abs(w) + b;
    const nw = w + (dt * f / this.J) / (1 + dt * k / this.J);
    this.dw = (nw - w) / dt; this.w = nw;
    this.I = free ? 0 : (V - Ke * nw) / R;
  }
  get rpm() { return this.w * 60 / TWO_PI; }
  get thrust() { return this.ct * this.w * this.w; }                     // N (sign handled by the caller)
  get torque() { return this.cq * this.w * Math.abs(this.w); }             // N·m opposing the rotation
}

// time-stamped pulse width (µs) the microcontroller drives on a pin: Servo / ESP32Servo, analogWrite / LEDC, bit-banged
export function pulseUs(sim, name) {
  const b = sim.board, p = b.pins?.[name]; if (!p) return null;
  if (p.servo && p.pulse > 0) return p.pulse / US;
  if (b.kind !== 'avr' && p.freq > 0 && p.duty !== null) { const us = (p.duty / p.freq) * 1e6; return us > 40 ? us : null; }
  if (p.pulse > 0 && b.cpu.cycles - p.lastFall < CPS * 0.06) return p.pulse / US;
  return null;
}

const slotOf = (ctx) => {
  const v = String(attr(ctx, 'pos', 'otomatis'));
  if (/tidak/.test(v)) return 'none';
  const i = SLOTS.findIndex((s) => v.startsWith(s.name));
  return i >= 0 ? i : 'auto';
};
const volts = (sim, a, b) => { const v = sim.last; if (!v) return null; const x = v.v(a), y = b === undefined ? 0 : v.v(b); return live(x) && live(y) ? (x - y) * 5 : null; };

// ------------------------------------------------------------------ brushed DC motors (TT, 130, coreless, RS-385, RS-775)
const brushed = (ctx) => {
  const sim = ctx.sim, m = MOTORS[ctx.part.type];
  const rotor = new Rotor(m, propOf(attr(ctx, 'prop', ctx.part.type === 'mod-motor-coreless' ? '65 mm' : 'tanpa')));
  let angle = 0, lastC = 0, warnedV = false, bat = null;
  const entry = { id: ctx.part.id, rotor, slot: slotOf(ctx), dir: () => Math.sign(rotor.w) || 1, kind: 'brushed' };
  return {
    attach() {
      const P = phys(sim); P.add(this, 1); if (rotor.prop) P.rotors.push(entry);
      const direct = [...ctx.ardPins('+'), ...ctx.ardPins('-')];
      if (direct.length) sim.warn(`motor-direct-${ctx.part.id}`, `${ctx.label}: terhubung langsung ke pin mikrokontroler (${direct.join(', ')}). Pin hanya kuat ±20 mA, motor butuh ${m.vNom <= 4 ? '1–3 A' : 'ratusan mA – beberapa A'}; gunakan driver (MOSFET, L298N, transistor).`);
    },
    step(dt) {
      bat ||= phys(sim).batteryFor(ctx.n('+'));
      const V = volts(sim, ctx.n('+'), ctx.n('-')) ?? 0;
      if (Math.abs(V) > m.vMax && !warnedV && sim.running) { warnedV = true; sim.warn(`motor-ov-${ctx.part.id}`, `${ctx.label}: tegangan ${Math.abs(V).toFixed(1)} V melebihi batas motor ${m.vNom} V (maks ±${m.vMax} V) — motor asli akan panas/terbakar.`); }
      rotor.step(dt, V);
      const vb = bat?.V || Math.abs(V) || 1;
      phys(sim).loads.set(ctx.part.id, { bat, amps: Math.max(0, V * rotor.I) / vb });
    },
    render() {
      const c = sim.board.cpu.cycles, dt = Math.min(0.1, (c - lastC) / CPS); lastC = c;
      const out = rotor.rpm / (m.gear || 1);
      angle = (angle + clamp(out / 60 * 360 * dt, -40, 40)) % 360; ctx.el.angle = angle;      // capped: a stroboscopic view of fast motors
      ctx.el.setText?.('rpm', `${Math.round(Math.abs(out))} rpm${m.gear ? ' (poros)' : ''}${Math.abs(rotor.I) > 0.05 ? ` · ${Math.abs(rotor.I).toFixed(1)} A` : ''}`);
    },
    reset() { rotor.reset(); phys(sim).restart(); warnedV = false; },
    rotor,
  };
};

// ------------------------------------------------------------------ ESC (BLHeli-like): arming, throttle mapping, BEC
const esc = (ctx) => {
  const sim = ctx.sim;
  let sigPins = [], armed = false, okT = 0, badT = 0, lostT = 0, u = 0, vbat = 0, on = false, bat = null, motor = null, ocT = 0, lastUs = null, oneshot = false;
  const self = {
    nets: null, get armed() { return armed; }, get u() { return u; }, get vbat() { return vbat; }, motorI: 0,
    attach() {
      const P = phys(sim); P.add(self, 0); P.escs.push(self);
      self.nets = ['A', 'B', 'C'].map((p) => ctx.n(p));
      sigPins = ctx.ardPins('SIG');
      if (!sigPins.length) sim.warn(`esc-sig-${ctx.part.id}`, `${ctx.label}: kabel SIG (sinyal PWM) belum terhubung ke pin mikrokontroler.`);
    },
    switches: () => [[ctx.n('GND'), ctx.n('BAT-')]],                     // signal ground = battery negative inside the ESC
    drivers2: () => (on ? [{ net: ctx.n('5V'), value: 1, label: ctx.label + ' BEC 5V', rail: true }] : []),
    step(dt) {
      bat ||= phys(sim).batteryFor(ctx.n('BAT+'));
      const v = bat && bat.posNet === ctx.n('BAT+') ? bat.V : volts(sim, ctx.n('BAT+'), ctx.n('BAT-')) ?? 0;
      vbat = v;
      const was = on; on = v > 5.5;
      if (!on) { armed = false; u = 0; okT = badT = 0; if (was) sim.info(`${ctx.label}: ESC mati (tegangan baterai ${v.toFixed(1)} V).`); self.motorI = 0; phys(sim).loads.delete(ctx.part.id); return; }
      if (!was) { sim.info(`🔊 ${ctx.label}: ♪♪♪ ESC menyala (${v.toFixed(1)} V, ${Math.round(v / 3.8)}S) — menunggu sinyal throttle minimum untuk arm.`); okT = badT = 0; }
      const us = sigPins.length ? pulseUs(sim, sigPins[0]) : null;
      lastUs = us;
      if (us === null) {
        lostT += dt; u = 0;
        if (armed && lostT > 0.25) { armed = false; sim.warn(`esc-lost-${ctx.part.id}`, `${ctx.label}: sinyal PWM hilang > 0,25 s — ESC berhenti (failsafe). Kirim throttle minimum lagi untuk arm ulang.`); }
      } else {
        lostT = 0; oneshot = us < 300;
        const lo = oneshot ? 135 : 1100;
        if (!armed) {
          if (us <= lo) { okT += dt; badT = 0; if (okT >= 0.3) { armed = true; sim.info(`🔊 ${ctx.label}: ♪ bip panjang — ESC ARMED (${oneshot ? 'Oneshot125' : 'PWM'} ${Math.round(us)} µs).`); } }
          else { okT = 0; badT += dt; if (badT > 1.5) sim.warn(`esc-noarm-${ctx.part.id}`, `${ctx.label}: tidak mau arm — throttle saat ESC menyala ${Math.round(us)} µs. Kirim 1000 µs (minimum) selama ±1 detik dulu, mis. esc.writeMicroseconds(1000).`); }
          u = 0;
        } else u = oneshot ? clamp((us - 130) / 120) : clamp((us - 1040) / 960);
      }
      motor ||= phys(sim).rotors.find((r) => r.esc === self) || null;
      const iBat = Math.max(0, self.motorI * u) + 0.02;
      phys(sim).loads.set(ctx.part.id, { bat, amps: iBat });
      const lim = +attr(ctx, 'amps', 30);
      if (self.motorI > lim * 1.15) { ocT += dt; if (ocT > 1.5) sim.warn(`esc-oc-${ctx.part.id}`, `${ctx.label}: arus motor ${self.motorI.toFixed(0)} A melebihi rating ESC ${lim} A — ESC asli akan panas/terbakar. Pakai ESC lebih besar atau baling lebih kecil.`); } else ocT = 0;
    },
    render() { ctx.el.setLed?.('arm', armed); },
    reset() { armed = false; okT = badT = lostT = 0; u = 0; on = false; self.motorI = 0; phys(sim).restart(); },
    get lastUs() { return lastUs; },
  };
  return self;
};

// ------------------------------------------------------------------ brushless motor: gets its drive from the ESC wired to A/B/C
const bldc = (ctx) => {
  const sim = ctx.sim, m = MOTORS[ctx.part.type];
  const rotor = new Rotor(m, propOf(attr(ctx, 'prop', '1045')));
  let escRef = undefined, parity = 1, angle = 0, lastC = 0, warnedCells = false;
  const entry = { id: ctx.part.id, rotor, slot: slotOf(ctx), dir: () => parity, kind: 'bldc', esc: null };
  const link = () => {
    const mine = ['A', 'B', 'C'].map((p) => ctx.n(p));
    const e = phys(sim).escs.find((x) => x.nets && mine.every((n) => n >= 0 && x.nets.includes(n)) && new Set(mine).size === 3);
    if (!e) {
      const part = phys(sim).escs.find((x) => x.nets && mine.some((n) => n >= 0 && x.nets.includes(n)));
      sim.warn(`bldc-esc-${ctx.part.id}`, part ? `${ctx.label}: hanya sebagian fase terhubung ke ESC — motor brushless butuh 3 kabel A, B, C ke A, B, C ESC.` : `${ctx.label}: motor brushless harus dihubungkan ke ESC (fase A, B, C), bukan langsung ke baterai/pin.`);
      return null;
    }
    const perm = mine.map((n) => e.nets.indexOf(n));                    // even permutation = default direction
    let inv = 0; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (perm[i] > perm[j]) inv++;
    parity = inv % 2 ? -1 : 1; entry.esc = e;
    return e;
  };
  return {
    attach() { const P = phys(sim); P.add(this, 1); P.rotors.push(entry); },
    step(dt) {
      if (escRef === undefined) escRef = link();
      const e = escRef;
      if (e && e.armed && e.u > 0) {
        rotor.step(dt, e.u * e.vbat);
        if (!warnedCells && m.cells && sim.running) { const s = Math.round(e.vbat / 3.8); if (s > m.cells[1] + 1) { warnedCells = true; sim.warn(`bldc-cells-${ctx.part.id}`, `${ctx.label}: dirancang untuk ${m.cells[0]}–${m.cells[1]}S, baterai ${s}S terlalu tinggi — arus & panas berlebih.`); } }
      } else rotor.step(dt, 0, true);
      if (e) e.motorI = Math.max(0, rotor.I);
    },
    render() {
      const c = sim.board.cpu.cycles, dt = Math.min(0.1, (c - lastC) / CPS); lastC = c;
      angle = (angle + clamp(parity * rotor.rpm / 60 * 360 * dt, -40, 40)) % 360; ctx.el.angle = angle;
      ctx.el.setText?.('rpm', `${Math.round(rotor.rpm)} rpm${rotor.prop ? ` · ${Math.round(rotor.thrust / G * 1000)} g` : ''}`);
    },
    reset() { rotor.reset(); escRef = undefined; phys(sim).restart(); },
    rotor,
  };
};

// ------------------------------------------------------------------ LiPo battery (state of charge, internal resistance, sag)
const lipo = (ctx) => {
  const sim = ctx.sim;
  const cells = parseInt(attr(ctx, 'cells', '3S')) || 3, cap = (+attr(ctx, 'capacity', 2200) || 2200) / 1000, C = parseInt(attr(ctx, 'crate', '25C')) || 25;
  const rCell = 0.010 * (2.2 / cap) * (25 / C);
  let soc = clamp(+attr(ctx, 'charge', 100) / 100), I = 0, warnedLow = false, warnedEmpty = false, warnedC = false;
  const self = {
    posNet: ctx.n('+'), V: cells * ocv(soc), get soc() { return soc; }, get I() { return I; }, cells,
    attach() { const P = phys(sim); P.add(self, 3); P.batteries.push(self); self.posNet = ctx.n('+'); },
    drivers1: () => [{ net: ctx.n('+'), value: self.V / 5, label: ctx.label + ' (+)', rail: true }, { net: ctx.n('-'), value: 0, label: ctx.label + ' (−)', rail: true }],
    step(dt) {
      I = 0; for (const [, l] of phys(sim).loads) if (l.bat === self) I += l.amps;
      soc = Math.max(0, soc - I * dt / 3600 / cap);
      const cellV = soc > 0 ? ocv(soc) : 3.0;
      self.V = Math.max(0, cells * cellV - I * cells * rCell);
      if (sim.running) {
        if (I > cap * C * 1.05 && !warnedC) { warnedC = true; sim.warn(`lipo-c-${ctx.part.id}`, `${ctx.label}: arus ${I.toFixed(0)} A melebihi batas ${C}C × ${cap * 1000} mAh = ${(cap * C).toFixed(0)} A.`); }
        if (self.V / cells < 3.5 && soc < 0.25 && !warnedLow) { warnedLow = true; sim.warn(`lipo-low-${ctx.part.id}`, `${ctx.label}: baterai lemah (${(self.V / cells).toFixed(2)} V/sel, ${Math.round(soc * 100)} %). Segera mendarat — LiPo rusak bila di bawah 3,0 V/sel.`); }
        if (soc <= 0 && !warnedEmpty) { warnedEmpty = true; sim.warn(`lipo-empty-${ctx.part.id}`, `${ctx.label}: baterai habis.`); }
      }
    },
    render() {
      ctx.el.setText?.('cap', `LiPo ${cells}S ${Math.round(cap * 1000)}mAh ${C}C`);
      ctx.el.setText?.('v', `${self.V.toFixed(2)} V${I > 0.05 ? ` · ${I.toFixed(1)} A` : ''}`);
      ctx.el.setText?.('soc', `${Math.round(soc * 100)} % · ${(self.V / cells).toFixed(2)} V/sel`);
    },
    reset() { I = 0; phys(sim).restart(); },
    recharge() { soc = 1; warnedLow = warnedEmpty = false; },
  };
  return self;
};

// ------------------------------------------------------------------ quadcopter frame: 6-DOF rigid body
const quat = {
  mul: (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]],
  norm: (q) => { const n = Math.hypot(...q); return q.map((x) => x / n); },
  mat: ([w, x, y, z]) => [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]],
  yaw: (yaw) => [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)],
};
const mv = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
const mtv = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];
export const euler = (q) => {                                            // roll (x), pitch (y), yaw (z) in degrees, ZYX
  const [w, x, y, z] = q;
  return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)), Math.asin(clamp(2 * (w * y - z * x), -1, 1)), Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))].map((r) => r * 180 / Math.PI);
};

const frame = (ctx) => {
  const sim = ctx.sim;
  const F = frameOf(attr(ctx, 'preset', 'F450')), mass = F.m + (+attr(ctx, 'payload', 0) || 0) / 1000;
  const a = F.L / Math.SQRT2, kd = 0.5 * RHO * 1.0 * F.A;
  const r = rng(), bias = [gauss(r) * 0.4, gauss(r) * 0.4, gauss(r) * 0.4];          // gyro zero-rate offset (°/s): calibrate it in code!
  let st, slots = [], warned = false, t = 0;
  const reset = () => {
    st = { p: [0, 0, 0], v: [0, 0, 0], q: [1, 0, 0, 0], w: [0, 0, 0], ground: true, crashed: false, f: [0, 0, G], maxAlt: 0, thrust: 0, crashText: '' };
  };
  reset();
  const assign = () => {
    const rot = phys(sim).rotors.filter((e) => e.slot !== 'none' && e.rotor.prop);
    const out = [null, null, null, null];
    for (const e of rot) if (typeof e.slot === 'number' && !out[e.slot]) out[e.slot] = e;
    const auto = rot.filter((e) => !out.includes(e)).sort((x, y) => x.id.localeCompare(y.id, undefined, { numeric: true }));
    for (let i = 0; i < 4 && auto.length; i++) if (!out[i]) out[i] = auto.shift();
    slots = out;
    if (!warned) {
      warned = true;
      const n = out.filter(Boolean).length;
      if (n < 4) sim.warn(`drone-motors-${ctx.part.id}`, `${ctx.label}: quadcopter butuh 4 motor berbaling (ditemukan ${n}). Tambahkan motor brushless + ESC atau motor coreless.`);
      if (auto.length) sim.warn(`drone-extra-${ctx.part.id}`, `${ctx.label}: ada lebih dari 4 motor; ${auto.map((e) => e.id).join(', ')} tidak dipasang di frame.`);
      sim.info(`🚁 ${ctx.label}: ${out.map((e, i) => `${SLOTS[i].key.toUpperCase()} ${SLOTS[i].name} ${SLOTS[i].spin > 0 ? 'CCW' : 'CW'} = ${e ? e.id : '—'}`).join(' · ')}. Massa ${Math.round(mass * 1000)} g.`);
    }
  };
  const self = {
    get state() { return st; }, mass, frame: F,
    attach() { phys(sim).add(self, 2); sim.drone = api; },
    step(dt) {
      if (!slots.length) assign();
      t += dt;
      const R = quat.mat(st.q);
      let T = 0, tx = 0, ty = 0, tz = 0;
      const motors = [];
      for (let i = 0; i < 4; i++) {
        const e = slots[i]; if (!e) { motors.push(null); continue; }
        const s = SLOTS[i], ro = e.rotor, dir = e.dir();
        const okDir = dir > 0;                                            // rotor turns the way its slot / propeller expects
        const thr = st.crashed ? 0 : ro.thrust * (okDir ? 1 : -0.35);
        const spin = s.spin * dir;                                        // actual spin seen from above (+1 = CCW)
        const yawT = -spin * (ro.cq * ro.w * ro.w + ro.J * ro.dw * Math.sign(ro.w || 1));   // reaction on the body: rotor drag + spin-up torque
        T += thr; tx += s.y * a * thr; ty += -s.x * a * thr; tz += st.crashed ? 0 : yawT;
        motors.push({ id: e.id, rpm: Math.abs(ro.rpm), thrust: thr, okDir, spin, amps: Math.abs(ro.I) });
        if (!okDir && Math.abs(ro.rpm) > 500 && sim.running) sim.warn(`drone-dir-${e.id}`, `${e.id} (${SLOTS[i].name}) berputar terbalik — baling-baling mendorong ke bawah. ${e.kind === 'bldc' ? 'Tukar dua kabel fase motor ke ESC.' : 'Tukar kabel + dan − motor.'}`);
      }
      st.motors = motors; st.thrust = T;
      // forces (world frame, z up)
      const wind = +attr(ctx, 'wind', 0) || 0;
      const gust = wind ? wind * (1 + 0.35 * Math.sin(t * 0.9) + 0.25 * Math.sin(t * 2.3 + 1)) : 0;
      const vr = [st.v[0] - gust, st.v[1] - gust * 0.3, st.v[2]];
      const sp = Math.hypot(...vr);
      // rotor drag ("H-force"): spinning rotors resist horizontal motion in proportion to their thrust — the reason a
      // tilted quadcopter reaches a steady speed and its accelerometer still sees the tilt
      // axial inflow: climbing reduces rotor thrust, descending increases it (momentum theory, hover induced velocity ≈ 5–6 m/s)
      const vb = mtv(R, vr), hd = 0.045 * Math.max(0, T), Ta = T * clamp(1 - 0.07 * vb[2], 0.45, 1.25);
      const fw = mv(R, [-hd * vb[0], -hd * vb[1], Ta]);
      const acc = [(fw[0] - kd * sp * vr[0]) / mass, (fw[1] - kd * sp * vr[1]) / mass, (fw[2] - kd * sp * vr[2]) / mass - G];
      // torques (body frame): rotor moments + aerodynamic damping + wind disturbance
      const I = F.I, w = st.w, damp = 0.0035 * mass * F.L;
      const dist = wind ? [gauss(r) * 0.002 * wind * F.L * mass, gauss(r) * 0.002 * wind * F.L * mass, 0] : [0, 0, 0];
      const tau = [tx - damp * w[0] + dist[0], ty - damp * w[1] + dist[1], tz - damp * 2 * w[2]];
      const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]];
      const gyro = [w[1] * Iw[2] - w[2] * Iw[1], w[2] * Iw[0] - w[0] * Iw[2], w[0] * Iw[1] - w[1] * Iw[0]];
      let dW = [(tau[0] - gyro[0]) / I[0], (tau[1] - gyro[1]) / I[1], (tau[2] - gyro[2]) / I[2]];
      if (st.crashed) { st.v = [0, 0, 0]; st.w = [0, 0, 0]; st.f = mtv(R, [0, 0, G]); return; }
      // ground contact
      const onGround = st.p[2] <= 1e-4;
      if (onGround && acc[2] <= 0) {
        acc[2] = 0; st.v[2] = Math.max(0, st.v[2]);
        const k = Math.exp(-25 * dt); st.v[0] *= k; st.v[1] *= k; acc[0] = acc[1] = 0;
        if (T < 0.95 * mass * G) {                                         // resting on its legs: stays level
          const yaw = euler(st.q)[2] * Math.PI / 180; st.q = quat.yaw(yaw);
          st.w = [0, 0, st.w[2] * Math.exp(-20 * dt)]; dW = [0, 0, dW[2]];
        }
      }
      st.ground = onGround;
      for (let i = 0; i < 3; i++) { st.v[i] += acc[i] * dt; st.p[i] += st.v[i] * dt; st.w[i] += dW[i] * dt; }
      const wq = [0, st.w[0], st.w[1], st.w[2]];
      const dq = quat.mul(st.q, wq);
      st.q = quat.norm(st.q.map((x, i) => x + 0.5 * dq[i] * dt));
      const R2 = quat.mat(st.q), tiltCos = R2[2][2];
      if (st.p[2] < 0) {                                                  // touch-down
        const vz = st.v[2];
        if (vz < -3 || tiltCos < 0.5) {
          st.crashed = true;
          st.crashText = vz < -3 ? `menghantam tanah ${(-vz).toFixed(1)} m/s` : `terbalik (miring ${Math.round(Math.acos(clamp(tiltCos, -1, 1)) * 180 / Math.PI)}°)`;
          sim.warn(`drone-crash-${ctx.part.id}`, `💥 ${ctx.label}: jatuh — ${st.crashText}. Tekan "Reset drone" di tab Drone.`);
        }
        st.p[2] = 0; st.v[2] = Math.max(0, vz); if (st.crashed) st.v = [0, 0, 0];
      }
      if (st.p[2] > st.maxAlt) st.maxAlt = st.p[2];
      st.acc = acc;
      st.f = mtv(R2, [acc[0], acc[1], acc[2] + G]);                       // specific force in body axes (accelerometer)
    },
    render() {
      const e = euler(st.q);
      for (let i = 0; i < 4; i++) { const m = st.motors?.[i]; if (m) { const k = SLOTS[i].key; self._ang ||= {}; self._ang[k] = ((self._ang[k] || 0) + clamp(m.spin * m.rpm / 40, -45, 45)) % 360; ctx.el.setRotor?.(k, -self._ang[k]); } }
      ctx.el.setText?.('alt', st.crashed ? '💥 JATUH' : `h ${st.p[2].toFixed(2)} m`);
      ctx.el.setText?.('att', `R ${e[0].toFixed(0)}° P ${e[1].toFixed(0)}° Y ${e[2].toFixed(0)}°`);
    },
    reset() { reset(); slots = []; warned = false; t = 0; phys(sim).restart(); },
  };
  const noise = () => gauss(r);
  const api = {
    get state() { return st; }, get mass() { return mass; }, get frame() { return F; }, id: ctx.part.id, slots: () => slots,
    reset() { reset(); },
    /** MPU6050 values (g, °/s) for a chip whose X axis points 'ke depan' / 'ke kanan' / 'ke belakang' / 'ke kiri' */
    imu(orient) {
      const ax = { 'ke depan': [[1, 0], [0, 1]], 'ke kanan': [[0, -1], [1, 0]], 'ke belakang': [[-1, 0], [0, -1]], 'ke kiri': [[0, 1], [-1, 0]] }[orient] || [[1, 0], [0, 1]];
      const vib = Math.min(1, (st.motors || []).reduce((s, m) => s + (m ? m.rpm : 0), 0) / 4 / 9000);
      const f = st.f.map((x) => x / G), wd = st.w.map((x) => x * 180 / Math.PI);
      const along = (v, X) => v[0] * X[0] + v[1] * X[1];
      return {
        ax: along(f, ax[0]) + noise() * (0.004 + 0.03 * vib), ay: along(f, ax[1]) + noise() * (0.004 + 0.03 * vib), az: f[2] + noise() * (0.004 + 0.03 * vib),
        gx: along(wd, ax[0]) + bias[0] + noise() * (0.06 + 0.3 * vib), gy: along(wd, ax[1]) + bias[1] + noise() * (0.06 + 0.3 * vib), gz: wd[2] + bias[2] + noise() * 0.06,
        temp: 31 + 3 * vib,
      };
    },
    /** height of a downward-looking range sensor above the ground, m (null = no return: too tilted) */
    range() { const R = quat.mat(st.q), c = R[2][2]; if (c < 0.6) return null; return (st.p[2] + F.h) / c; },
    altitude() { return st.p[2]; },
  };
  return self;
};

// ------------------------------------------------------------------ RC receiver (FlySky FS-iA6B): PWM / PPM / iBUS
export const RC_DEFAULT = () => [1500, 1500, 1000, 1500, 1000, 1000, 1500, 1500, 1500, 1500, 1500, 1500, 1500, 1500];
const rcrx = (ctx) => {
  const sim = ctx.sim;
  sim.rc ||= { ch: RC_DEFAULT(), on: true };
  const ppm = /PPM/.test(attr(ctx, 'mode', 'PWM'));
  const lv = {}; let gen = 0, link = null, pw = false;
  const CH = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6'];
  const set = (pin, l) => { if (lv[pin] !== l) { lv[pin] = l; sim.resolveNow(); } };
  const ch = (i) => clamp(Math.round(sim.rc.ch[i] ?? 1500), 900, 2100);
  const pwmFrame = (my) => {
    if (my !== gen) return;
    if (pw && sim.rc.on) {
      const pins = ppm ? CH.slice(1) : CH;
      for (const p of pins) set(p, 1);
      pins.forEach((p) => { const i = CH.indexOf(p); sim.after(ch(i) * US, () => { if (my === gen) set(p, 0); }); });
      if (ppm) {                                                          // PPM: 8 channels, 300 µs pulse at the start of each slot
        let t = 0;
        for (let i = 0; i < 8; i++) { const t0 = t; sim.after(Math.max(1, t0 * US), () => { if (my === gen) set('CH1', 1); }); sim.after((t0 + 300) * US, () => { if (my === gen) set('CH1', 0); }); t += ch(i); }
        sim.after(t * US, () => { if (my === gen) set('CH1', 1); }); sim.after((t + 300) * US, () => { if (my === gen) set('CH1', 0); });
      }
    }
    sim.after((ppm ? 22500 : 20000) * US, () => pwmFrame(my));
  };
  const ibus = (my) => {
    if (my !== gen) return;
    if (pw && sim.rc.on && link && !link.busy()) {
      const b = [0x20, 0x40]; for (let i = 0; i < 14; i++) { const v = ch(i); b.push(v & 255, v >> 8); }
      const s = 0xffff - b.reduce((x, y) => x + y, 0); b.push(s & 255, (s >> 8) & 255);
      link.send(b);
    }
    sim.after(7000 * US, () => ibus(my));
  };
  return {
    attach() {
      link = uartLink(ctx, { rx: 'IBUS', tx: 'IBUS' }, { baud: () => 115200, onByte() {} });
      const used = [...CH, 'IBUS'].filter((p) => ctx.ardPins(p).length);
      if (!used.length) sim.warn(`rc-pins-${ctx.part.id}`, `${ctx.label}: belum ada kanal yang terhubung ke mikrokontroler (CH1–CH6 untuk PWM${ppm ? '/PPM' : ''}, atau IBUS ke pin RX serial).`);
      if (sim.board.kind !== 'avr' && used.some((p) => p !== 'IBUS') && ppm) sim.info(`${ctx.label}: PPM dibaca lewat interrupt; di ESP32/RP2040 simulasi waktu interrupt kurang presisi — iBUS (Serial2) atau pulseIn() lebih andal.`);
    },
    drivers1: () => (pw ? [...CH.map((p) => ({ net: ctx.n(p), value: lv[p] ? 3.3 / 5 : 0, label: ctx.label + ' ' + p })).filter((d) => d.net >= 0), ...link.drivers(3.3 / 5)] : []),
    drivers2(v) { const a = v(ctx.n('VCC')), b = v(ctx.n('GND')); pw = live(a) && live(b) && (a - b) * 5 > 3.8; return []; },
    render() { ctx.el.setLed?.('link', pw && sim.rc.on); if (!pw && sim.running) sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VCC ke 5V dan GND ke GND.`); },
    reset() { gen++; link?.reset(); for (const k of Object.keys(lv)) lv[k] = 0; const my = gen; sim.after(2000 * US, () => pwmFrame(my)); sim.after(3000 * US, () => ibus(my)); },
    /** synthetic pulseIn() for the WebAssembly boards */
    pulseFor(pin) { const i = CH.indexOf(pin); if (i < 0 || !pw || !sim.rc.on) return 0; return ppm && i === 0 ? 300 : ch(i); },
  };
};

export const DRONE_BEHAVIORS = {
  'mod-motor-tt': brushed, 'mod-motor-130': brushed, 'mod-motor-coreless': brushed, 'mod-motor-rs385': brushed, 'mod-motor-rs775': brushed,
  'mod-bldc-a2212': bldc, 'mod-bldc-2205': bldc,
  'mod-esc': esc, 'mod-lipo': lipo, 'mod-drone-frame': frame, 'mod-rc-rx': rcrx,
};
