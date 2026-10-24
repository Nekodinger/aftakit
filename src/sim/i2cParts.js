// Behaviours that connect I2C part elements to device models on the simulator's I2C bus.
import { LcdI2C, SSD1306, MPU6050, RTC } from './i2c.js';
import { BoschEnv, MAX30102 } from './i2cEnv.js';

const live = (x) => x !== null && x !== undefined;
// sensors follow the quadcopter's motion when a drone frame is in the circuit (unless set to manual values)
const onDrone = (ctx) => ctx.sim.drone && !String(attr(ctx, 'drone', 'ikut')).startsWith('tidak');
const attr = (ctx, k, d) => (ctx.part.attrs?.[k] ?? d);

export function i2cPart(ctx, { vcc, gnd, sda = 'SDA', scl = 'SCL', make, addr }) {
  let dev = null, wired = false;
  const powered = (v) => { const a = v(ctx.n(vcc)), b = v(ctx.n(gnd)); return live(a) && live(b) && a - b > 0.5 && b < 0.25; };
  return {
    attach() {
      const sim = ctx.sim; dev = make(); ctx.dev = dev;
      if (!sim.boardPart) return;
      const bus = sim.i2cDefaultPins || ['A4', 'A5'];
      if (sim.board.kind === 'avr') {   // fixed TWI pins on the ATmega328P: tell the student right away
        const okSda = ctx.ardPins(sda).includes(bus[0]), okScl = ctx.ardPins(scl).includes(bus[1]);
        wired = okSda && okScl;
        if (!wired) {
          const miss = [!okSda && `${sda} → ${bus[0]}`, !okScl && `${scl} → ${bus[1]}`].filter(Boolean).join(', ');
          sim.warn(`i2c-wire-${ctx.part.id}`, `${ctx.label}: jalur I2C belum benar (${miss}). ${({ ATmega328P: 'Pada Uno/Nano, SDA = A4 dan SCL = A5.', ATmega2560: 'Pada Mega 2560, SDA = pin 20 dan SCL = pin 21 (juga tersedia di header SDA/SCL dekat AREF).', ATtiny85: 'Pada ATtiny85 (USI), SDA = PB0 dan SCL = PB2.' })[sim.board.mcu?.name] || ''}`);
        }
      }
      sim.i2c.add(addr(), dev, { sda: ctx.n(sda), scl: ctx.n(scl) });
    },
    drivers2(v) { if (dev) dev.powered = powered(v); return []; },
    pullups: () => [ctx.n(sda), ctx.n(scl)],
    reset() { dev?.reset?.(); },
    dev: () => dev,
    powered,
  };
}

const lcdI2C = (cols, rows) => (ctx) => {
  let font = null;
  const base = i2cPart(ctx, {
    vcc: 'VCC', gnd: 'GND', make: () => { font ||= new Uint8Array(ctx.el.font); return new LcdI2C(cols, rows, font, ctx.label); },
    addr: () => parseInt(attr(ctx, 'address', '0x27'), 16),
  });
  return {
    ...base,
    attach() { base.attach(); ctx.el.font = new Uint8Array(ctx.dev.hd.font); },
    render(v) {
      const d = ctx.dev; if (!d) return; const on = base.powered(v);
      if (!on && ctx.sim.running && d.hd.cmds > 0) ctx.sim.warn(`lcdi2cp-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VCC ke 5V dan GND ke GND.`);
      const s = d.hd.snapshot();
      ctx.el.characters = on ? s.chars : new Uint8Array(cols * rows).fill(0x20);
      ctx.el.cursor = on && d.hd.cursorOn && s.cx >= 0; ctx.el.blink = on && d.hd.blinkOn && s.cx >= 0;
      ctx.el.cursorX = Math.max(s.cx, 0); ctx.el.cursorY = Math.max(s.cy, 0);
      ctx.el.backlight = on && d.backlight;
      if (d.hd.fontDirty) { ctx.el.font = new Uint8Array(d.hd.font); d.hd.fontDirty = false; }
    },
  };
};

const oled = (ctx) => {
  const base = i2cPart(ctx, { vcc: 'VCC', gnd: 'GND', make: () => new SSD1306(ctx.label), addr: () => 0x3c });
  let shownOff = true;
  return {
    ...base,
    render(v) {
      const d = ctx.dev; if (!d) return; const on = base.powered(v);
      if (!on) { if (!shownOff) { ctx.el.drawFrame(new Uint8Array(128 * 64)); shownOff = true; } return; }
      if (d.dirty || shownOff) { ctx.el.drawFrame(d.frame()); d.dirty = false; shownOff = false; }
    },
  };
};

const mpu = (ctx) => {
  let ad0 = 0;
  const base = i2cPart(ctx, {
    vcc: 'VCC', gnd: 'GND',
    make: () => new MPU6050(ctx.label, () => onDrone(ctx) ? ctx.sim.drone.imu(attr(ctx, 'orient', 'ke depan')) : ({ ax: +attr(ctx, 'ax', 0), ay: +attr(ctx, 'ay', 0), az: +attr(ctx, 'az', 1), gx: +attr(ctx, 'gx', 0), gy: +attr(ctx, 'gy', 0), gz: +attr(ctx, 'gz', 0), temp: +attr(ctx, 'temp', 30) })),
    addr: () => 0x68 + ad0,
  });
  return { ...base, attach() { const x = ctx.sim.last?.v(ctx.n('AD0')); ad0 = live(x) && x > 0.5 ? 1 : 0; base.attach(); } };
};

const rtc = (kind, vcc) => (ctx) => i2cPart(ctx, { vcc, gnd: 'GND', make: () => new RTC(ctx.label, kind), addr: () => 0x68 });

const bosch = (kind, vcc) => (ctx) => i2cPart(ctx, {
  vcc, gnd: 'GND',
  make: () => new BoschEnv(ctx.label, kind, () => ({ temp: +attr(ctx, 'temperature', 24), pressure: +attr(ctx, 'pressure', 1013) * (onDrone(ctx) ? (1 - 2.25577e-5 * ctx.sim.drone.altitude()) ** 5.25588 : 1), humidity: kind === 'bme280' ? +attr(ctx, 'humidity', 50) : 0 })),
  addr: () => parseInt(attr(ctx, 'address', '0x76'), 16),
});

const max30102 = (ctx) => i2cPart(ctx, {
  vcc: 'VIN', gnd: 'GND',
  make: () => new MAX30102(ctx.label, () => ({ bpm: +attr(ctx, 'bpm', 75), spo2: +attr(ctx, 'spo2', 97), finger: attr(ctx, 'finger', 'ya') !== 'tidak', now: () => ctx.sim.board.cpu.cycles })),
  addr: () => 0x57,
});

export const I2C_BEHAVIORS = {
  'mod-bmp280': bosch('bmp280', 'VCC'),
  'mod-bme280': bosch('bme280', 'VIN'),
  'mod-max30102': max30102,
  'x-lcd1602-i2c': lcdI2C(16, 2),
  'x-lcd2004-i2c': lcdI2C(20, 4),
  'mod-oled-i2c': oled,
  'wokwi-mpu6050': mpu,
  'wokwi-ds1307': rtc('ds1307', '5V'),
  'mod-ds3231': rtc('ds3231', 'VCC'),
};
