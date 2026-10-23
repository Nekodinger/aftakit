// Per-component simulation behaviours. Each factory gets ctx = { sim, part, el, n(pin), ardPins(pin), listen(target,evt,fn) }
// and returns any of: switches() weak() pullups() drivers1() drivers2(v) attach() render(v) dispose()
import { HD44780 } from './lcd.js';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const live = (x) => x !== null && x !== undefined;
const powered = (v, ctx, vcc = 'VCC', gnd = 'GND') => {
  const a = v(ctx.n(vcc)), b = v(ctx.n(gnd));
  return live(a) && live(b) && a > 0.8 && b < 0.2;
};
const warnPower = (ctx, v, ok, vcc = 'VCC', gnd = 'GND') => {
  if (!ok && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan ${vcc} ke 5V dan ${gnd} ke GND.`);
};
const attr = (ctx, k, d) => (ctx.part.attrs?.[k] ?? d);

// ---------- passive / outputs ----------
const resistor = (ctx) => ({ weak: () => [[ctx.n('1'), ctx.n('2')]] });

const led = (ctx) => ({
  render(v) {
    const a = v(ctx.n('A')), c = v(ctx.n('C'));
    let b = 0;
    if (live(a) && live(c)) {
      const d = a - c;
      b = d > 0.3 ? clamp(d) : 0;
      if (b > 0.5 && ctx.sim.circuitStrong(ctx.n('A')) && ctx.sim.circuitStrong(ctx.n('C')))
        ctx.sim.warn(`led-${ctx.part.id}`, `${ctx.label}: tidak ada resistor pembatas arus, LED bisa terbakar. Tambahkan resistor 220 Ω.`);
    }
    ctx.el.value = b > 0.02; ctx.el.brightness = b;
  },
});

const rgbLed = (ctx) => ({
  render(v) {
    const com = v(ctx.n('COM')), anode = attr(ctx, 'common', 'cathode') === 'anode';
    const ch = (pin) => { const x = v(ctx.n(pin)); if (!live(x) || !live(com)) return 0; const d = anode ? com - x : x - com; return d > 0.3 ? clamp(d) : 0; };
    ctx.el.ledRed = ch('R'); ctx.el.ledGreen = ch('G'); ctx.el.ledBlue = ch('B');
  },
});

const sevenSeg = (ctx) => ({
  render(v) {
    const com = v(ctx.n('COM.1')), anode = attr(ctx, 'common', 'cathode') === 'anode';
    const vals = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'].map((p) => {
      const x = v(ctx.n(p));
      if (!live(x) || !live(com)) return 0;
      return (anode ? com - x : x - com) > 0.5 ? 1 : 0;
    });
    ctx.el.values = vals;
  },
});

const barGraph = (ctx) => ({
  render(v) {
    const vals = [];
    for (let i = 1; i <= 10; i++) {
      const a = v(ctx.n('A' + i)), c = v(ctx.n('C' + i));
      vals.push(live(a) && live(c) && a - c > 0.5 ? 1 : 0);
    }
    ctx.el.values = vals;
  },
});

const buzzer = (ctx) => {
  let pins = [];
  return {
    attach() {
      pins = ctx.ardPins('1');
      if (!pins.length) ctx.sim.info(`${ctx.label}: kaki + belum terhubung ke pin Arduino.`);
    },
    render(v) {
      const gnd = v(ctx.n('2'));
      let freq = 0;
      for (const p of pins) freq = Math.max(freq, ctx.sim.board.pins[p]?.freq || 0);
      const grounded = live(gnd) && gnd < 0.2;
      if (freq > 20 && !grounded) ctx.sim.warn(`buz-${ctx.part.id}`, `${ctx.label}: kaki − harus terhubung ke GND agar berbunyi.`);
      const on = freq > 20 && grounded;
      ctx.el.hasSignal = on;
      if (on) ctx.sim.audio.tone(ctx.part.id, freq); else ctx.sim.audio.off(ctx.part.id);
    },
    dispose() { ctx.sim.audio.off(ctx.part.id); },
  };
};

const servo = (ctx) => {
  let pins = [], angle = 0, seen = false;
  return {
    attach() {
      pins = ctx.ardPins('PWM');
      if (!pins.length) ctx.sim.warn(`servo-${ctx.part.id}`, `${ctx.label}: kabel sinyal (PWM) belum terhubung ke pin Arduino.`);
    },
    render(v) {
      const ok = powered(v, ctx, 'V+', 'GND');
      let best = null;
      for (const p of pins) {
        const st = ctx.sim.board.pins[p];
        if (st && st.pulse > 0 && ctx.sim.board.cpu.cycles - st.lastFall < 16e6 * 0.1) best = st.pulse;
      }
      if (best !== null) {
        const us = best / 16;
        angle = clamp((us - 544) / (2400 - 544), 0, 1) * 180; seen = true;
      }
      if (seen && !ok) ctx.sim.warn(`servo-pw-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan V+ ke 5V dan GND ke GND.`);
      ctx.el.angle = ok || !seen ? angle : ctx.el.angle;
    },
  };
};

// ---------- inputs ----------
const pushbutton = (ctx) => {
  let pressed = false;
  return {
    attach() {
      ctx.listen(ctx.el, 'button-press', () => { pressed = true; });
      ctx.listen(ctx.el, 'button-release', () => { pressed = false; });
    },
    switches: () => (pressed ? [[ctx.n('1.l'), ctx.n('2.l')]] : []),
  };
};

const slideSwitch = (ctx) => ({
  attach() { ctx.listen(ctx.el, 'input', () => {}); },
  switches: () => (ctx.el.value ? [[ctx.n('2'), ctx.n('3')]] : [[ctx.n('1'), ctx.n('2')]]),
});

const dipSwitch = (ctx) => ({
  switches() {
    const out = [];
    (ctx.el.values || []).forEach((on, i) => { if (on) out.push([ctx.n(`${i + 1}a`), ctx.n(`${i + 1}b`)]); });
    return out;
  },
});

const pot = (sigPin) => (ctx) => ({
  attach() {
    const sync = () => {
      const el = ctx.el; const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
      ctx.part.attrs.value = Math.round(pct); ctx.sim.emit('attrs', ctx.part.id);
    };
    ctx.listen(ctx.el, 'input', sync);
  },
  drivers2(v) {
    const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
    if (!live(hi) || !live(lo)) return [];
    const el = ctx.el; const f = clamp((el.value - el.min) / (el.max - el.min));
    return [{ net: ctx.n(sigPin), value: lo + f * (hi - lo), label: ctx.label }];
  },
});

const joystick = (ctx) => {
  let pressed = false;
  return {
    attach() {
      ctx.listen(ctx.el, 'button-press', () => { pressed = true; });
      ctx.listen(ctx.el, 'button-release', () => { pressed = false; });
    },
    pullups: () => [ctx.n('SEL')],
    drivers1: () => (pressed ? [{ net: ctx.n('SEL'), value: 0, label: ctx.label }] : []),
    drivers2(v) {
      const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
      if (!live(hi) || !live(lo)) return [];
      return [
        { net: ctx.n('HORZ'), value: lo + clamp((1 - ctx.el.xValue) / 2) * (hi - lo), label: ctx.label },
        { net: ctx.n('VERT'), value: lo + clamp((1 - ctx.el.yValue) / 2) * (hi - lo), label: ctx.label },
      ];
    },
  };
};

const keypad = (ctx) => {
  const down = new Set();
  return {
    attach() {
      ctx.listen(ctx.el, 'button-press', (e) => down.add(e.detail.key));
      ctx.listen(ctx.el, 'button-release', (e) => down.delete(e.detail.key));
    },
    switches() {
      const cols = ctx.el.columns === '3' ? 3 : 4, out = [];
      for (const k of down) {
        const i = ctx.el.keys.indexOf(k);
        if (i < 0) continue;
        const row = Math.floor(i / 4), col = i % 4;
        if (col < cols) out.push([ctx.n('R' + (row + 1)), ctx.n('C' + (col + 1))]);
      }
      return out;
    },
  };
};

const encoder = (ctx) => {
  let clk = 1, dt = 1, sw = false, busy = false;
  const queue = [];
  const stepMs = 1; // ms between quadrature edges
  const pump = () => {
    if (busy || !queue.length) return;
    busy = true;
    const dir = queue.shift();
    // CW: CLK falls, DT falls, CLK rises, DT rises. CCW swaps the two lines.
    const a = dir > 0 ? 'clk' : 'dt', b = dir > 0 ? 'dt' : 'clk';
    const seq = [[a, 0], [b, 0], [a, 1], [b, 1]];
    let i = 0;
    const next = () => {
      if (i >= seq.length) { busy = false; pump(); return; }
      const [line, val] = seq[i++];
      if (line === 'clk') clk = val; else dt = val;
      ctx.sim.resolveNow();
      ctx.sim.after(16000 * stepMs, next);
    };
    next();
  };
  return {
    attach() {
      ctx.listen(ctx.el, 'rotate-cw', () => { queue.push(1); if (ctx.sim.running) pump(); });
      ctx.listen(ctx.el, 'rotate-ccw', () => { queue.push(-1); if (ctx.sim.running) pump(); });
      ctx.listen(ctx.el, 'button-press', () => { sw = true; });
      ctx.listen(ctx.el, 'button-release', () => { sw = false; });
    },
    pullups: () => [ctx.n('CLK'), ctx.n('DT'), ctx.n('SW')],
    drivers1: () => [
      { net: ctx.n('CLK'), value: clk, label: ctx.label },
      { net: ctx.n('DT'), value: dt, label: ctx.label },
      ...(sw ? [{ net: ctx.n('SW'), value: 0, label: ctx.label }] : []),
    ],
    reset() { clk = 1; dt = 1; queue.length = 0; busy = false; },
  };
};

const tilt = (ctx) => ({
  drivers2(v) {
    const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
    if (!live(hi) || !live(lo) || hi < 0.8 || lo > 0.2) return [];
    return [{ net: ctx.n('OUT'), value: attr(ctx, 'tilted', false) ? hi : lo, label: ctx.label }];
  },
});

// ---------- sensors ----------
const analogModule = (cfg) => (ctx) => ({
  drivers2(v) {
    const ok = powered(v, ctx, 'VCC', 'GND');
    const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
    if (!ok) return [];
    const f = clamp(+attr(ctx, 'level', cfg.def ?? 50) / 100);
    const out = [];
    if (cfg.ao) out.push({ net: ctx.n(cfg.ao), value: lo + f * (hi - lo), label: ctx.label });
    if (cfg.dout) {
      const th = +attr(ctx, 'threshold', cfg.th ?? 50) / 100;
      const active = f >= th;
      const high = cfg.activeLow ? !active : active;
      out.push({ net: ctx.n(cfg.dout), value: high ? hi : lo, label: ctx.label });
    }
    return out;
  },
  render(v) {
    const ok = powered(v, ctx, 'VCC', 'GND');
    const f = clamp(+attr(ctx, 'level', cfg.def ?? 50) / 100);
    const th = +attr(ctx, 'threshold', cfg.th ?? 50) / 100;
    const active = f >= th;
    for (const k of cfg.ledPower || []) if (k in ctx.el) ctx.el[k] = ok;
    for (const k of cfg.ledSignal || []) if (k in ctx.el) ctx.el[k] = ok && (cfg.signalOnActive === false ? !active : active);
  },
});

const ldr = (ctx) => {
  const base = analogModule({ ao: 'AO', dout: 'DO', def: 50, th: 50, ledPower: ['ledPower'] })(ctx);
  return { ...base, render(v) { base.render(v); ctx.el.ledDO = powered(v, ctx) && +attr(ctx, 'level', 50) >= 50; } };
};

const ntc = (ctx) => ({
  drivers2(v) {
    if (!powered(v, ctx)) return [];
    const T = +attr(ctx, 'level', 24) + 273.15, B = 3950, T0 = 298.15;
    const rRatio = Math.exp(B * (1 / T0 - 1 / T));       // R / R0
    const f = 1 / (1 + rRatio);                            // Wokwi's Arduino example inverts exactly this divider
    const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
    return [{ net: ctx.n('OUT'), value: lo + f * (hi - lo), label: ctx.label }];
  },
});

const pir = (ctx) => ({
  drivers2(v) {
    if (!powered(v, ctx)) return [];
    const hi = v(ctx.n('VCC')), lo = v(ctx.n('GND'));
    return [{ net: ctx.n('OUT'), value: attr(ctx, 'motion', false) ? hi : lo, label: ctx.label }];
  },
});

const hcsr04 = (ctx) => {
  let echo = 0, prev = null, ok = false;
  return {
    attach() {
      const trig = ctx.ardPins('TRIG');
      if (!trig.length) ctx.sim.warn(`hc-${ctx.part.id}`, `${ctx.label}: pin TRIG belum terhubung ke pin Arduino.`);
      if (!ctx.ardPins('ECHO').length) ctx.sim.warn(`hc2-${ctx.part.id}`, `${ctx.label}: pin ECHO belum terhubung ke pin Arduino.`);
      for (const p of trig) {
        ctx.sim.board.onEdge(p, (lvl) => {
          const fell = prev === 1 && lvl === 0; prev = lvl;
          if (!fell || !ok) return;
          const cm = clamp(+attr(ctx, 'distance', 100), 2, 400);
          ctx.sim.after(3200, () => {                     // ~200 µs after trigger
            echo = 1; ctx.sim.resolveNow();
            ctx.sim.after(Math.round(cm * 58.2 * 16), () => { echo = 0; ctx.sim.resolveNow(); });
          });
        });
      }
    },
    drivers2(v) {
      ok = powered(v, ctx);
      if (!ok) return [];
      return [{ net: ctx.n('ECHO'), value: echo, label: ctx.label }];
    },
    render(v) { warnPower(ctx, v, ok); },
    reset() { echo = 0; prev = null; },
  };
};

// ---------- displays ----------
const lcd = (cols, rows) => (ctx) => {
  let hd, pins = {}, prevE = null, baseFont = null;
  const need = ['RS', 'E', 'D4', 'D5', 'D6', 'D7'];
  return {
    attach() {
      baseFont = new Uint8Array(ctx.el.font);
      hd = new HD44780(cols, rows, baseFont);
      ctx.el.font = new Uint8Array(hd.font);
      const missing = [];
      for (const k of ['RS', 'E', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']) {
        const arr = ctx.ardPins(k); pins[k] = arr[0] || null;
        if (!arr.length && need.includes(k)) missing.push(k);
      }
      if (missing.length) ctx.sim.warn(`lcd-${ctx.part.id}`, `${ctx.label}: pin ${missing.join(', ')} belum terhubung ke Arduino. LCD tidak akan menampilkan apa pun.`);
      if (!pins.E) return;
      ctx.sim.board.onEdge(pins.E, (lvl) => {
        const fell = prevE === 1 && lvl === 0; prevE = lvl;
        if (!fell) return;
        const b = ctx.sim.board, rd = (k) => (pins[k] ? (b.driveLevel(pins[k]) ? 1 : 0) : 0);
        const rs = rd('RS');
        const eight = pins.D0 && pins.D1 && pins.D2 && pins.D3;
        const hi = (rd('D7') << 7) | (rd('D6') << 6) | (rd('D5') << 5) | (rd('D4') << 4);
        if (eight) hd.clock(rs, hi | (rd('D3') << 3) | (rd('D2') << 2) | (rd('D1') << 1) | rd('D0'), false);
        else hd.clock(rs, hi, true);
      });
    },
    render(v) {
      const on = powered(v, ctx, 'VDD', 'VSS');
      if (!on && ctx.sim.running && hd.cmds > 0) ctx.sim.warn(`lcdp-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VDD ke 5V dan VSS ke GND.`);
      const s = hd.snapshot();
      ctx.el.characters = on ? s.chars : new Uint8Array(cols * rows).fill(0x20);
      ctx.el.cursor = on && hd.cursorOn && s.cx >= 0; ctx.el.blink = on && hd.blinkOn && s.cx >= 0;
      ctx.el.cursorX = Math.max(s.cx, 0); ctx.el.cursorY = Math.max(s.cy, 0);
      ctx.el.backlight = true;
      if (hd.fontDirty) { ctx.el.font = new Uint8Array(hd.font); hd.fontDirty = false; }
    },
    reset() { hd = new HD44780(cols, rows, baseFont); ctx.el.font = new Uint8Array(hd.font); prevE = null; },
  };
};

// ---------- NeoPixel family: simple pixel-sink objects used by the sim-level chain decoder ----------
const pixelPart = (count) => (ctx) => ({
  pixelCount: () => count(ctx.el),
  setPixel(i, r, g, b) {
    const el = ctx.el;
    if (el.tagName.toLowerCase() === 'wokwi-neopixel') { el.r = r; el.g = g; el.b = b; }
    else if (el.tagName.toLowerCase() === 'wokwi-led-ring') el.setPixel(i, { r, g, b });
    else el.setPixel(Math.floor(i / el.cols), i % el.cols, { r, g, b });
  },
  attach() { if ('animation' in ctx.el) ctx.el.animation = false; },
  reset() {
    const n = count(ctx.el);
    for (let i = 0; i < n; i++) this.setPixel(i, 0, 0, 0);
  },
});

export const BEHAVIORS = {
  'wokwi-resistor': resistor,
  'wokwi-led': led,
  'wokwi-rgb-led': rgbLed,
  'wokwi-7segment': sevenSeg,
  'wokwi-led-bar-graph': barGraph,
  'wokwi-buzzer': buzzer,
  'wokwi-servo': servo,
  'wokwi-pushbutton': pushbutton,
  'wokwi-pushbutton-6mm': pushbutton,
  'wokwi-slide-switch': slideSwitch,
  'wokwi-dip-switch-8': dipSwitch,
  'wokwi-potentiometer': pot('SIG'),
  'wokwi-slide-potentiometer': pot('SIG'),
  'wokwi-analog-joystick': joystick,
  'wokwi-membrane-keypad': keypad,
  'wokwi-ky-040': encoder,
  'wokwi-tilt-switch': tilt,
  'wokwi-photoresistor-sensor': ldr,
  'wokwi-ntc-temperature-sensor': ntc,
  'wokwi-pir-motion-sensor': pir,
  'wokwi-hc-sr04': hcsr04,
  'wokwi-gas-sensor': analogModule({ ao: 'AOUT', dout: 'DOUT', def: 20, th: 60, activeLow: true, ledPower: ['ledPower'], ledSignal: ['ledD0'] }),
  'wokwi-flame-sensor': analogModule({ ao: 'AOUT', dout: 'DOUT', def: 0, th: 50, activeLow: true, ledPower: ['ledPower'], ledSignal: ['ledSignal'] }),
  'wokwi-big-sound-sensor': analogModule({ ao: 'AOUT', dout: 'DOUT', def: 10, th: 50, ledPower: ['led1'], ledSignal: ['led2'] }),
  'wokwi-small-sound-sensor': analogModule({ ao: 'AOUT', dout: 'DOUT', def: 10, th: 50, ledPower: ['ledPower'], ledSignal: ['ledSignal'] }),
  'wokwi-lcd1602': lcd(16, 2),
  'wokwi-lcd2004': lcd(20, 4),
  'wokwi-neopixel': pixelPart(() => 1),
  'wokwi-led-ring': pixelPart((el) => el.pixels || 16),
  'wokwi-neopixel-matrix': pixelPart((el) => (el.rows || 8) * (el.cols || 8)),
};
