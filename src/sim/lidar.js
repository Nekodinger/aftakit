// LIDAR range finders: ST VL53L0X (I2C time-of-flight, up to ~2 m) and Benewake TF-Luna (UART, 0.2–8 m).
// Both read a manual distance, or — with a drone frame in the circuit — the height above the ground of a
// downward-looking sensor on the quadcopter (slant range = h / cos(tilt), no return beyond ~53° tilt).
import { i2cPart } from './i2cParts.js';
import { uartLink } from './uart.js';
import { H } from './behaviors2.js';

const { live, attr } = H;
const US = 16;
const onDrone = (ctx) => ctx.sim.drone && !String(attr(ctx, 'drone', 'ikut')).startsWith('tidak');

// ------------------------------------------------------------------ VL53L0X register model
// Enough of the device for both the Pololu VL53L0X library (direct registers) and the ST API used by Adafruit_VL53L0X:
// model id 0xC0 = 0xEE, the 0x83 strobe handshake, SYSRANGE_START (0x00) self-clearing, RESULT_INTERRUPT_STATUS (0x13)
// ready, RESULT_RANGE_STATUS block at 0x14 (status, SPAD count, signal / ambient rate, range at 0x1E).
export class VL53L0X {
  constructor(label, distMm) { this.label = label; this.distMm = distMm; this.addr = 0x29; this.reset(); }
  reset() {
    this.reg = new Uint8Array(256); this.page = 0; this.ptr = 0; this.first = true; this.started = 0; this.count = 0;
    const r = this.reg;
    r[0xc0] = 0xee; r[0xc1] = 0xaa; r[0xc2] = 0x10; r[0x51] = 0x00; r[0x61] = 0x00; r[0x89] = 0x00; r[0x92] = 0x86;
    r[0x8a] = 0x29; r[0xb6] = 0x0a; r[0xb7] = 0x00;                         // reference signal rate ≈ target: SPAD calibration converges
    for (let i = 0xb0; i <= 0xb5; i++) r[i] = 0xff;
    this.nvmAddr = 0x6b;
  }
  // NVM words read through the 0x94 / 0x83 strobe / 0x90..0x93 window (ST API get_info_from_device, Pololu getSpadInfo)
  _nvm(a) {
    if (a === 0x6b) return 0x00008600;                                   // reference SPADs: 6 aperture SPADs
    if (a === 0x24 || a === 0x25) return 0xffffffff;                      // good-SPAD map: all SPADs usable
    if (a === 0x02) return 0x00000110;                                    // module id / revision
    return 0;
  }
  ready() { return this.powered !== false && !this.shutdown; }
  begin(write) { if (write) this.first = true; }
  _measure() {
    const d = this.distMm(), r = this.reg;
    const valid = d !== null && d >= 20 && d <= 2000;
    const mm = valid ? Math.round(d) : 8190;
    r[0x14] = (valid ? 11 : 4) << 3;                                       // device range status (11 = range valid, 4 = phase fail)
    r[0x15] = 0; r[0x16] = 0x08; r[0x17] = 0x00;                           // effective SPAD count (8.8)
    const sig = valid ? Math.max(0.5, 40 * Math.pow(300 / Math.max(mm, 50), 2)) : 0.1;   // MCPS, falls with distance²
    const s97 = Math.min(0xffff, Math.round(sig * 128));
    r[0x1a] = s97 >> 8; r[0x1b] = s97 & 255; r[0x1c] = 0x00; r[0x1d] = 0x10;  // signal rate, ambient rate (9.7)
    r[0x1e] = mm >> 8; r[0x1f] = mm & 255;
    r[0x13] = 0x04;                                                        // new sample ready
    this.count++;
  }
  write(b) {
    if (this.first) { this.ptr = b; this.first = false; return true; }
    const a = this.ptr;
    if (a === 0xff) this.page = b;
    else if (this.page === 0) {
      this.reg[a] = b;
      if (a === 0x00 && (b & 0x03)) { this.continuous = !!(b & 0x02); this._measure(); this.reg[0x00] = b & 0xfe; }   // single-shot (0x01) / back-to-back (0x02)
      if (a === 0x0b && (b & 0x01)) this.reg[0x13] = 0x00;                   // SYSTEM_INTERRUPT_CLEAR
      if (a === 0x8a) { this.addr = b & 0x7f; this.onAddr?.(this.addr); }    // I2C_SLAVE_DEVICE_ADDRESS (setAddress)
    } else if (a === 0x94) this.nvmAddr = b;
    else if (a === 0x83) this.reg[0x83] = b;
    this.ptr = (this.ptr + 1) & 255; return true;
  }
  read() {
    const a = this.ptr; this.ptr = (this.ptr + 1) & 255;
    if (a === 0x83) return 0x10;                                           // strobe answered at once
    if (a >= 0x90 && a <= 0x93) return (this._nvm(this.nvmAddr) >>> ((0x93 - a) * 8)) & 255;
    if (a === 0x13) { if (this.continuous && !(this.reg[0x13] & 7)) this._measure(); return this.reg[0x13]; }   // continuous mode: next sample ready at once
    if (a === 0x00) return 0x00;                                           // measurement already finished
    return this.reg[a];
  }
}

const vl53 = (ctx) => {
  const sim = ctx.sim;
  const dist = () => {
    if (onDrone(ctx)) { const h = sim.drone.range(); return h === null ? null : h * 1000 + (Math.random() - 0.5) * 6; }
    return +attr(ctx, 'distance', 500) + (Math.random() - 0.5) * 6;
  };
  let dev = null;
  const base = i2cPart(ctx, { vcc: 'VIN', gnd: 'GND', make: () => (dev = new VL53L0X(ctx.label, dist)), addr: () => 0x29 });
  return {
    ...base,
    attach() { base.attach(); if (dev) dev.onAddr = (a) => { const e = sim.i2c.devices.find((d) => d.dev === dev); if (e) e.addr = a; }; },
    reset() { base.reset(); const e = sim.i2c.devices.find((d) => d.dev === dev); if (e) e.addr = 0x29; },
    drivers2(v) {
      base.drivers2(v);
      const x = v(ctx.n('XSHUT'));
      if (dev) { const sd = live(x) && x < 0.2; if (sd && !dev.shutdown) { dev.reset(); const e = sim.i2c.devices.find((d) => d.dev === dev); if (e) e.addr = 0x29; } dev.shutdown = sd; }   // XSHUT low = hardware standby (registers lost)
      return [];
    },
    pullups: () => [...base.pullups(), ctx.n('XSHUT')],                    // XSHUT has a pull-up on the GY-530 board
  };
};

// ------------------------------------------------------------------ TF-Luna: 9-byte frames at 100 Hz, 115200 baud
// 0x59 0x59 Dist_L Dist_H Amp_L Amp_H Temp_L Temp_H checksum (low byte of the sum); distance in cm, temperature = raw/8 − 256.
// Commands 0x5A len id ... checksum are answered (version, frame rate, output format, save, reset).
const tfluna = (ctx) => {
  const sim = ctx.sim;
  let link = null, pw = false, gen = 0, rate = 100, buf = [], enabled = true;
  const reply = (bytes) => { const s = bytes.reduce((a, b) => a + b, 0) & 255; sim.after(800 * US, () => link.send([...bytes, s])); };
  const onByte = (b) => {
    if (!buf.length && b !== 0x5a) return;
    buf.push(b);
    if (buf.length >= 2 && buf.length === buf[1]) {
      const [, len, id] = buf; const pay = buf.slice(3, len - 1); buf = [];
      if (id === 0x01) reply([0x5a, 0x07, 0x01, 0x03, 0x02, 0x03]);                       // firmware version 3.2.3
      else if (id === 0x03) { rate = (pay[0] | (pay[1] << 8)) || 0; reply([0x5a, 0x06, 0x03, pay[0] || 0, pay[1] || 0]); }
      else if (id === 0x07) { enabled = !!pay[0]; reply([0x5a, 0x05, 0x07, pay[0] || 0]); }
      else if (id === 0x02 || id === 0x10 || id === 0x11) reply([0x5a, 0x05, id, 0x00]);  // reset / factory / save: success
      else reply([0x5a, len, id, ...pay]);
    }
    if (buf.length > 32) buf = [];
  };
  const frame = (my) => {
    if (my !== gen) return;
    if (pw && enabled && rate > 0 && !link.busy()) {
      let cm;
      if (onDrone(ctx)) { const h = sim.drone.range(); cm = h === null ? 0 : h * 100; } else cm = +attr(ctx, 'distance', 150);
      cm = cm >= 20 && cm <= 800 ? Math.round(cm + (Math.random() - 0.5) * 2) : 0;
      const amp = cm ? Math.round(Math.min(30000, 2e6 / Math.max(cm, 20) ** 1.2)) : 0;
      const temp = Math.round((40 + 256) * 8);
      const f = [0x59, 0x59, cm & 255, cm >> 8, amp & 255, amp >> 8, temp & 255, temp >> 8];
      link.send([...f, f.reduce((a, b) => a + b, 0) & 255]);
    }
    sim.after(Math.round(16e6 / Math.max(1, rate || 100)), () => frame(my));
  };
  return {
    attach() {
      link = uartLink(ctx, { rx: 'RXD', tx: 'TXD' }, { baud: () => 115200, onByte });
      if (!sim.arduinoPinsOnNet(ctx.n('TXD')).length) sim.warn(`tf-tx-${ctx.part.id}`, `${ctx.label}: pin TXD TF-Luna belum terhubung ke pin RX mikrokontroler (115200 baud).`);
    },
    drivers1: () => (pw ? link.drivers(3.3 / 5) : []),
    drivers2(v) { const a = v(ctx.n('5V')), b = v(ctx.n('GND')); pw = live(a) && live(b) && (a - b) * 5 > 4.2; return []; },
    render() { if (!pw && sim.running) sim.warn(`power-${ctx.part.id}`, `${ctx.label}: butuh 5 V. Hubungkan 5V ke 5V/VIN dan GND ke GND.`); },
    reset() { gen++; link?.reset(); rate = 100; enabled = true; buf = []; const my = gen; sim.after(16e6 * 0.05, () => frame(my)); },
  };
};

export const LIDAR_BEHAVIORS = { 'mod-vl53l0x': vl53, 'mod-tfluna': tfluna };
