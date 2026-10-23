// Behaviours for the extended parts library (IoT sensors, relays, motors, drivers, power).
// Voltages are normalised: 1.0 = 5 V, 0.66 = 3.3 V. Each factory receives the same ctx as behaviors.js.
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const live = (x) => x !== null && x !== undefined;
const attr = (ctx, k, d) => (ctx.part.attrs?.[k] ?? d);
const V = (volts) => volts / 5;
const US = 16; // CPU cycles per microsecond at 16 MHz

const VCC_NAMES = ['VCC', '+', 'V+', 'VIN', '5V', 'VDD', '3V3'], GND_NAMES = ['GND', '-', 'G', 'VSS'];
function rails(ctx) {
  const names = new Set(ctx.el.pinInfo.map((p) => (/^\d+\.\d+V$/.test(p.name) ? p.name : p.name.split('.')[0])));
  return { vcc: VCC_NAMES.find((n) => names.has(n)), gnd: GND_NAMES.find((n) => names.has(n)) };
}
function supply(ctx, v) {
  const { vcc, gnd } = ctx.rails ||= rails(ctx);
  const hi = vcc ? v(ctx.n(vcc)) : null, lo = gnd ? v(ctx.n(gnd)) : null;
  return { ok: live(hi) && live(lo) && hi - lo > 0.5 && lo < 0.25, hi, lo, vcc, gnd };
}
function warnSupply(ctx, s) {
  if (!s.ok && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan ${s.vcc || 'VCC'} ke 5V/3.3V dan ${s.gnd || 'GND'} ke GND.`);
}
const led = (ctx, key, on) => ctx.el.setLed?.(key, !!on);

// ------------------------------------------------------------------ analog / digital sensor modules
// fn(ctx, t) -> output fraction of VCC (0..1). dout: { pin, active(ctx) -> bool, activeLow }
const analogSensor = ({ out, fn, dout, absolute }) => (ctx) => {
  let s = { ok: false };
  return {
    drivers2(v) {
      s = supply(ctx, v); if (!s.ok) return [];
      const t = ctx.sim.board.cpu.cycles / 16e6;
      const res = [];
      if (out) {
        const f = clamp(fn(ctx, t));
        res.push({ net: ctx.n(out), value: absolute ? Math.min(s.hi, f) : s.lo + f * (s.hi - s.lo), label: ctx.label });
      }
      if (dout) {
        const act = dout.active(ctx);
        res.push({ net: ctx.n(dout.pin), value: (dout.activeLow ? !act : act) ? s.hi : s.lo, label: ctx.label });
      }
      return res;
    },
    render(v) {
      s = supply(ctx, v); led(ctx, 'pwr', s.ok);
      if (dout) led(ctx, 'sig', s.ok && dout.active(ctx));
      warnSupply(ctx, s);
    },
  };
};
const lvl = (ctx, def = 50) => clamp(+attr(ctx, 'level', def) / 100);
const thr = (ctx, def = 50) => clamp(+attr(ctx, 'threshold', def) / 100);

// TDS meter v1: ppm = (133.42 V^3 - 255.86 V^2 + 857.39 V) * 0.5  (DFRobot formula, 25 °C) -> invert numerically
function tdsVolt(ppm) { let lo = 0, hi = 2.3; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const p = (133.42 * m ** 3 - 255.86 * m ** 2 + 857.39 * m) * 0.5; if (p < ppm) lo = m; else hi = m; } return (lo + hi) / 2; }
// pulse waveform (normalised 0..1) for a given bpm at time t
function pulseWave(bpm, t) { const ph = (t * bpm / 60) % 1; const sys = Math.exp(-((ph - 0.12) ** 2) / 0.0018), dic = 0.35 * Math.exp(-((ph - 0.42) ** 2) / 0.004); return 0.45 + 0.4 * sys + 0.12 * dic; }

const digitalSensor = ({ out, active, activeLow, ao }) => analogSensor({
  out: ao, fn: (ctx) => (active(ctx) ? 0.9 : 0.1),
  dout: { pin: out, active, activeLow },
});

// ------------------------------------------------------------------ DHT11 / DHT22 single-wire protocol
const dht = ({ pin, model }) => (ctx) => {
  let drive = null, lowStart = -1, s = { ok: false }, busy = false, cpuRef = null;
  const frame = () => {
    const T = +attr(ctx, 'temperature', 28), H = +attr(ctx, 'humidity', 65);
    let b;
    if (model === 11) {
      const hi = Math.round(clamp(H, 0, 100)), ti = Math.trunc(Math.abs(T)), tf = Math.round((Math.abs(T) - ti) * 10) % 10;
      b = [hi, 0, T < 0 ? ti : ti, (T < 0 ? 0x80 : 0) | tf];
    } else {
      const h = Math.round(clamp(H, 0, 100) * 10), t = Math.round(Math.abs(clamp(T, -40, 80)) * 10) | (T < 0 ? 0x8000 : 0);
      b = [h >> 8, h & 255, t >> 8, t & 255];
    }
    b.push((b[0] + b[1] + b[2] + b[3]) & 255);
    return b;
  };
  const respond = () => {
    if (busy || !s.ok) return; busy = true;
    const bits = []; for (const byte of frame()) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    const steps = [[20, 0], [80, null], [80, 0]];              // response: wait, LOW 80us, HIGH 80us
    for (const bit of bits) steps.push([50, null], [bit ? 70 : 26, 0]); // after LOW 50us release; high 26/70us
    steps.push([50, null]);                                     // final LOW 50us then release
    let i = 0;
    const next = () => {
      if (ctx.sim.board.cpu !== cpuRef) { busy = false; return; }
      if (i >= steps.length) { drive = null; busy = false; ctx.sim.resolveNow(); return; }
      const [dt, val] = steps[i++];
      ctx.sim.after(dt * US, () => { drive = val === 0 ? 0 : null; ctx.sim.resolveNow(); next(); });
    };
    // steps encode "after dt, set level": first entry pulls LOW after 20us, then releases after 80us, ...
    next();
  };
  return {
    attach() {
      const mcu = ctx.ardPins(pin);
      if (!mcu.length) { ctx.sim.warn(`dht-${ctx.part.id}`, `${ctx.label}: pin data (${pin}) belum terhubung ke pin Arduino.`); return; }
      ctx.sim.board.onEdge(mcu[0], (level, t) => {
        cpuRef = ctx.sim.board.cpu;
        if (level === 0) { lowStart = t; return; }
        if (lowStart >= 0 && t - lowStart > 500 * US) { lowStart = -1; respond(); }
        lowStart = -1;
      });
    },
    pullups: () => [ctx.n(pin)],
    drivers1: () => (drive === 0 ? [{ net: ctx.n(pin), value: 0, label: ctx.label }] : []),
    drivers2(v) { s = supply(ctx, v); return []; },
    render(v) { s = supply(ctx, v); warnSupply(ctx, s); },
    reset() { drive = null; busy = false; lowStart = -1; },
  };
};

// ------------------------------------------------------------------ YF-S201 flow sensor: f(Hz) = 7.5 * Q(L/min)
const flowSensor = (ctx) => {
  let level = 0, cpuRef = null, s = { ok: false }, angle = 0, lastC = 0;
  const tick = () => {
    if (ctx.sim.board.cpu !== cpuRef) return;
    const f = 7.5 * +attr(ctx, 'flow', 5);
    if (f <= 0 || !s.ok) { level = 0; ctx.sim.after(16000 * 20, tick); return; }
    level ^= 1; ctx.sim.resolveNow();
    ctx.sim.after(Math.max(200, Math.round(16e6 / (2 * f))), tick);
  };
  return {
    drivers2(v) { s = supply(ctx, v); if (!s.ok) return []; return [{ net: ctx.n('SIG'), value: level ? s.hi : s.lo, label: ctx.label }]; },
    render(v) {
      s = supply(ctx, v); warnSupply(ctx, s);
      if (cpuRef !== ctx.sim.board.cpu) { cpuRef = ctx.sim.board.cpu; ctx.sim.after(1600, tick); }
      const c = ctx.sim.board.cpu.cycles; angle = (angle + (s.ok ? +attr(ctx, 'flow', 5) : 0) * 0.0006 * (c - lastC) / 16) % 360; lastC = c; ctx.el.angle = angle;
    },
    reset() { level = 0; },
  };
};

// ------------------------------------------------------------------ relay modules
const relay = (channels) => (ctx) => {
  const on = new Array(channels).fill(false); let s = { ok: false };
  const inName = (i) => (channels === 1 ? 'IN' : 'IN' + (i + 1));
  const sfx = (i) => (channels === 1 ? '' : String(i + 1));
  return {
    switches() {
      const out = [];
      for (let i = 0; i < channels; i++) out.push(on[i] ? [ctx.n('COM' + sfx(i)), ctx.n('NO' + sfx(i))] : [ctx.n('COM' + sfx(i)), ctx.n('NC' + sfx(i))]);
      return out;
    },
    drivers2(v) {
      s = supply(ctx, v); const activeLow = attr(ctx, 'trigger', 'LOW') === 'LOW';
      for (let i = 0; i < channels; i++) {
        const x = v(ctx.n(inName(i)));
        on[i] = s.ok && live(x) && (activeLow ? x - s.lo < 0.3 * (s.hi - s.lo) : x - s.lo > 0.5 * (s.hi - s.lo));
      }
      return [];
    },
    render(v) {
      led(ctx, 'pwr', s.ok); for (let i = 0; i < channels; i++) led(ctx, 'ch' + (i + 1), on[i]);
      warnSupply(ctx, s);
    },
  };
};

// ------------------------------------------------------------------ DC motor / pump / fan
const motor = ({ a, b, spin = 1 }) => (ctx) => {
  let angle = 0, lastC = 0;
  return {
    attach() {
      const direct = [...ctx.ardPins(a), ...ctx.ardPins(b)].filter((p) => /^\d+$|^A\d$/.test(p));
      if (direct.length) ctx.sim.warn(`motor-direct-${ctx.part.id}`, `${ctx.label}: terhubung langsung ke pin Arduino (${direct.join(', ')}). Pin hanya kuat ~20 mA; gunakan driver (L298N, transistor, atau modul MOSFET).`);
    },
    render(v) {
      const va = v(ctx.n(a)), vb = v(ctx.n(b));
      const d = live(va) && live(vb) ? va - vb : 0;
      const c = ctx.sim.board.cpu.cycles, dt = Math.min(0.1, (c - lastC) / 16e6); lastC = c;
      const speed = Math.abs(d) < 0.12 ? 0 : d; // < 0.6 V: motor stalls
      angle = (angle + speed * 1400 * spin * dt) % 360; ctx.el.angle = angle;
    },
  };
};

// ------------------------------------------------------------------ L298N dual H-bridge
const l298n = (ctx) => {
  let st = { a: 0, b: 0 };
  return {
    logicPins: () => ['IN1', 'IN2', 'IN3', 'IN4'].map((p) => ctx.n(p)).filter((n) => n >= 0),
    drivers2(v) {
      const vs = v(ctx.n('12V')), g = v(ctx.n('GND'));
      const out = [];
      if (live(vs) && live(g) && vs - g > 1.2) out.push({ net: ctx.n('5V'), value: g + 1, label: ctx.label + ' 5V', rail: true });
      if (!live(vs) || !live(g) || vs - g < 0.6) { st = { a: 0, b: 0 }; return out; }
      const logicHi = (x) => live(x) && x - g > 0.4;
      const ch = (en, i1, i2, o1, o2) => {
        const e = v(ctx.n(en)); const duty = live(e) ? clamp((e - g) / 0.9) : 1; // unwired EN = jumper fitted
        if (duty < 0.02) return 0;
        const x1 = logicHi(v(ctx.n(i1))), x2 = logicHi(v(ctx.n(i2)));
        const hi = g + (vs - g - 0.4) * duty; // ~2 V drop on the bipolar bridge, scaled
        if (x1 === x2) { out.push({ net: ctx.n(o1), value: g, label: ctx.label }, { net: ctx.n(o2), value: g, label: ctx.label }); return 0; }
        out.push({ net: ctx.n(o1), value: x1 ? hi : g, label: ctx.label }, { net: ctx.n(o2), value: x2 ? hi : g, label: ctx.label });
        return x1 ? duty : -duty;
      };
      st = { a: ch('ENA', 'IN1', 'IN2', 'OUT1', 'OUT2'), b: ch('ENB', 'IN3', 'IN4', 'OUT3', 'OUT4') };
      return out;
    },
    render(v) {
      const vs = v(ctx.n('12V')), g = v(ctx.n('GND')); led(ctx, 'pwr', live(vs) && live(g) && vs - g > 0.6);
      if ((st.a || st.b) && !(live(vs) && vs - g > 1.2) && ctx.sim.running) ctx.sim.warn(`l298-${ctx.part.id}`, `${ctx.label}: tegangan motor (12V) terlalu rendah. Hubungkan baterai/adaptor 6–12 V ke +12V dan GND bersama.`);
    },
  };
};

// ------------------------------------------------------------------ switching elements
const mosfet = (ctx) => {
  let on = 0;
  return {
    drivers2(v) {
      const sig = v(ctx.n('SIG')), g = v(ctx.n('GND')), vin = v(ctx.n('VIN'));
      on = live(sig) && live(g) ? clamp((sig - g - 0.15) / 0.75) : 0;
      if (on < 0.03 || !live(vin)) return [];
      return [{ net: ctx.n('V-'), value: g + (vin - g) * (1 - on), label: ctx.label }];
    },
    render() { led(ctx, 'sig', on > 0.03); },
  };
};
const npn = (ctx) => {
  let on = false;
  return {
    switches: () => (on ? [[ctx.n('C'), ctx.n('E')]] : []),
    drivers2(v) { const b = v(ctx.n('B')), e = v(ctx.n('E')); on = live(b) && live(e) && b - e > 0.12; return []; },
  };
};
const indicator = (pins, gnd) => (ctx) => ({
  render(v) {
    const g = v(ctx.n(gnd));
    for (const [pin, key] of pins) { const x = v(ctx.n(pin)); led(ctx, key, live(x) && live(g) && x - g > 0.4); }
  },
});
const twoTerminalIndicator = (ctx) => ({
  render(v) { const a = v(ctx.n('+')), b = v(ctx.n('-')); led(ctx, 'on', live(a) && live(b) && Math.abs(a - b) > 0.5); },
});
const touch = (ctx) => {
  let pressed = false, s = { ok: false };
  return {
    attach() { ctx.listen(ctx.el, 'button-press', () => { pressed = true; ctx.sim.resolveNow(); }); ctx.listen(ctx.el, 'button-release', () => { pressed = false; ctx.sim.resolveNow(); }); },
    drivers2(v) { s = supply(ctx, v); return s.ok ? [{ net: ctx.n('SIG'), value: pressed ? s.hi : s.lo, label: ctx.label }] : []; },
    render(v) { led(ctx, 'sig', s.ok && pressed); warnSupply(ctx, s); },
  };
};

// ------------------------------------------------------------------ power sources
const battery = (key, def) => (ctx) => ({
  drivers1: () => [{ net: ctx.n('+'), value: V(+attr(ctx, key, def)), label: ctx.label + ' (+)', rail: true }, { net: ctx.n('-'), value: 0, label: ctx.label + ' (−)', rail: true }],
});
const solar = (ctx) => ({
  drivers1: () => [{ net: ctx.n('+'), value: V(6 * clamp(+attr(ctx, 'light', 80) / 100)), label: ctx.label + ' (+)', rail: true }, { net: ctx.n('-'), value: 0, label: ctx.label + ' (−)', rail: true }],
});
const buck = (ctx) => ({
  drivers2(v) {
    const a = v(ctx.n('IN+')), b = v(ctx.n('IN-')); const vo = V(+attr(ctx, 'vout', 5));
    if (!live(a) || !live(b) || a - b < vo + V(1.5)) return [];
    return [{ net: ctx.n('OUT+'), value: b + vo, label: ctx.label + ' OUT+', rail: true }];
  },
});
const voltageSensor = (ctx) => ({
  drivers2(v) { const a = v(ctx.n('VIN')), b = v(ctx.n('-')); if (!live(a) || !live(b)) return []; return [{ net: ctx.n('S'), value: b + (a - b) / 5, label: ctx.label }]; },
});

// ------------------------------------------------------------------ registry
export const BEHAVIORS2 = {
  'mod-soil': analogSensor({ out: 'AO', fn: (c) => 1 - 0.75 * lvl(c, 30), dout: { pin: 'DO', active: (c) => lvl(c, 30) >= thr(c), activeLow: true } }),
  'mod-soil-cap': analogSensor({ out: 'AOUT', fn: (c) => 0.62 - 0.32 * lvl(c, 30) }),
  'mod-water-level': analogSensor({ out: 'S', fn: (c) => 0.72 * lvl(c, 40) }),
  'mod-rain': analogSensor({ out: 'AO', fn: (c) => 1 - 0.8 * lvl(c, 0), dout: { pin: 'DO', active: (c) => lvl(c, 0) >= thr(c, 40), activeLow: true } }),
  'mod-mq135': analogSensor({ out: 'AO', fn: (c) => 0.08 + 0.85 * lvl(c, 20), dout: { pin: 'DO', active: (c) => lvl(c, 20) >= thr(c, 60), activeLow: true } }),
  'mod-pulse': analogSensor({ out: 'S', fn: (c, t) => pulseWave(+attr(c, 'bpm', 75), t) }),
  'mod-acs712': analogSensor({ out: 'OUT', fn: (c) => 0.5 + (0.185 / 5) * +attr(c, 'current', 1) }),
  'mod-tds': analogSensor({ out: 'A', fn: (c) => V(tdsVolt(+attr(c, 'ppm', 250))), absolute: true }),
  'mod-ph': analogSensor({ out: 'Po', fn: (c) => V(2.5 - (+attr(c, 'ph', 7) - 7) * 0.18), absolute: true }),
  'mod-ir-obstacle': digitalSensor({ out: 'OUT', active: (c) => !!attr(c, 'obstacle', false), activeLow: true }),
  'mod-tcrt5000': digitalSensor({ out: 'DO', ao: 'AO', active: (c) => !!attr(c, 'black', false), activeLow: false }),
  'mod-hall': digitalSensor({ out: 'S', active: (c) => !!attr(c, 'magnet', false), activeLow: true }),
  'mod-vibration': digitalSensor({ out: 'DO', active: (c) => !!attr(c, 'shake', false), activeLow: false }),
  'mod-touch': touch,
  'mod-voltage': voltageSensor,
  'mod-flow': flowSensor,
  'mod-dht11': dht({ pin: 'DATA', model: 11 }),
  'wokwi-dht22': dht({ pin: 'SDA', model: 22 }),
  'mod-jsn-sr04t': null, // filled in sim.js with the HC-SR04 behaviour (same protocol)
  'mod-relay1': relay(1), 'mod-relay2': relay(2), 'mod-relay4': relay(4),
  'mod-dc-motor': motor({ a: 'M+', b: 'M-' }), 'mod-pump': motor({ a: '+', b: '-', spin: 1.5 }), 'mod-fan': motor({ a: '+', b: '-', spin: 2 }),
  'mod-l298n': l298n, 'mod-mosfet': mosfet, 'mod-npn': npn,
  'mod-solenoid': twoTerminalIndicator,
  'mod-laser': indicator([['S', 'on']], 'GND'),
  'mod-traffic': indicator([['R', 'R'], ['Y', 'Y'], ['G', 'G']], 'GND'),
  'mod-battery9v': battery('voltage', 9), 'mod-battery18650': battery('voltage', 3.7), 'mod-solar': solar, 'mod-buck': buck,
};

// helpers shared with behaviors3.js
export const H = { clamp, live, attr, V, US, supply, warnSupply, led, analogSensor, digitalSensor, pulseWave, lvl, thr };
