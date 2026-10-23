// I2C (TWI) bus for the ATmega328P plus device models: PCF8574 LCD backpack, SSD1306 OLED,
// MPU6050 IMU and DS1307 / DS3231 real-time clocks. Devices are attached by behaviours.
import { HD44780 } from './lcd.js';

const bcd = (n) => ((Math.floor(n / 10) << 4) | (n % 10)) & 255;
const unbcd = (b) => (b >> 4) * 10 + (b & 15);

export class I2CBus {
  constructor(sim) { this.sim = sim; this.devices = new Map(); this.cur = null; this.write = false; this.log = []; }
  attach(twi) { this.twi = twi; twi.eventHandler = this; }
  add(addr, dev) {
    if (this.devices.has(addr)) this.sim.warn(`i2c-dup-${addr}`, `Dua perangkat I2C memakai alamat yang sama 0x${addr.toString(16)} (${this.devices.get(addr).label} dan ${dev.label}). Ubah alamat salah satunya.`);
    this.devices.set(addr, dev);
  }
  clear() { this.devices.clear(); this.cur = null; }
  // ---- TWIEventHandler
  start() { this.twi.completeStart(); }
  stop() { this.cur?.stop?.(); this.cur = null; this.twi.completeStop(); }
  connectToSlave(addr, write) {
    const d = this.devices.get(addr);
    this.cur = d && d.ready() ? d : null; this.write = write;
    if (this.cur) this.cur.begin?.(write);
    else if (!this.warnedScan?.has(addr)) {
      (this.warnedScan ||= new Set()).add(addr);
      if (this.devices.size || addr !== 0) this.sim.warn(`i2c-miss-${addr}`, `I2C: tidak ada perangkat yang menjawab di alamat 0x${addr.toString(16).padStart(2, '0')}. Periksa alamat, kabel SDA→A4 / SCL→A5, dan daya modul.`);
    }
    this.twi.completeConnect(!!this.cur);
  }
  writeByte(v) { const ok = this.cur ? this.cur.write(v) !== false : false; this.twi.completeWrite(ok); }
  readByte() { this.twi.completeRead(this.cur ? this.cur.read() & 255 : 0xff); }
}

// ------------------------------------------------------------------ PCF8574 + HD44780 (LiquidCrystal_I2C)
export class LcdI2C {
  constructor(cols, rows, font, label) { this.cols = cols; this.rows = rows; this.label = label; this.baseFont = font; this.reset(); }
  reset() { this.hd = new HD44780(this.cols, this.rows, this.baseFont); this.prev = 0; this.backlight = false; this.port = 0xff; }
  ready() { return this.powered !== false; }
  write(b) {
    const e = (b >> 2) & 1, pe = (this.prev >> 2) & 1;
    this.backlight = !!(b & 8);
    if (pe && !e) this.hd.clock(b & 1, b & 0xf0, true);
    this.prev = b; this.port = b; return true;
  }
  read() { return this.port; }
}

// ------------------------------------------------------------------ SSD1306 128x64 OLED
const ARGS = { 0x20: 1, 0x21: 2, 0x22: 2, 0x81: 1, 0x8d: 1, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 };
export class SSD1306 {
  constructor(label) { this.label = label; this.reset(); }
  reset() {
    this.ram = new Uint8Array(128 * 8); this.mode = 2; this.col = 0; this.page = 0; this.c0 = 0; this.c1 = 127; this.p0 = 0; this.p1 = 7;
    this.on = false; this.invert = false; this.segRemap = false; this.comDec = false; this.startLine = 0;
    this.ctrl = null; this.cmd = []; this.dirty = true;
  }
  ready() { return this.powered !== false; }
  begin() { this.ctrl = null; }
  write(b) {
    if (this.ctrl === null) { this.ctrl = b; return true; }       // control byte: 0x00 commands, 0x40 data (Co bit 0x80)
    if (this.ctrl & 0x40) this._data(b); else this._command(b);
    if (this.ctrl & 0x80) this.ctrl = null;                        // Co=1 -> next byte is a new control byte
    return true;
  }
  read() { return this.on ? 0x03 : 0x43; }
  _command(b) {
    this.cmd.push(b); const c = this.cmd[0]; const need = ARGS[c] ?? 0;
    if (this.cmd.length <= need) return;
    const a = this.cmd.slice(1); this.cmd = [];
    if (c === 0xae) this.on = false; else if (c === 0xaf) this.on = true;
    else if (c === 0xa6) this.invert = false; else if (c === 0xa7) this.invert = true;
    else if (c === 0xa0) this.segRemap = false; else if (c === 0xa1) this.segRemap = true;
    else if (c === 0xc0) this.comDec = false; else if (c === 0xc8) this.comDec = true;
    else if (c >= 0x40 && c <= 0x7f) this.startLine = c & 63;
    else if (c === 0x20) this.mode = a[0] & 3;
    else if (c === 0x21) { this.c0 = a[0] & 127; this.c1 = a[1] & 127; this.col = this.c0; }
    else if (c === 0x22) { this.p0 = a[0] & 7; this.p1 = a[1] & 7; this.page = this.p0; }
    else if (c >= 0xb0 && c <= 0xb7) this.page = c & 7;
    else if (c <= 0x0f) this.col = (this.col & 0xf0) | c;
    else if (c >= 0x10 && c <= 0x1f) this.col = (this.col & 0x0f) | ((c & 15) << 4);
    this.dirty = true;
  }
  _data(b) {
    this.ram[this.page * 128 + (this.col & 127)] = b; this.dirty = true;
    if (this.mode === 0) { // horizontal
      if (this.col >= this.c1) { this.col = this.c0; this.page = this.page >= this.p1 ? this.p0 : this.page + 1; } else this.col++;
    } else if (this.mode === 1) { // vertical
      if (this.page >= this.p1) { this.page = this.p0; this.col = this.col >= this.c1 ? this.c0 : this.col + 1; } else this.page++;
    } else this.col = (this.col + 1) & 127; // page mode
  }
  frame() {
    const out = new Uint8Array(128 * 64);
    if (!this.on) return out;
    for (let y = 0; y < 64; y++) {
      const ry = (y + this.startLine) & 63;
      for (let x = 0; x < 128; x++) {
        const bit = (this.ram[(ry >> 3) * 128 + x] >> (ry & 7)) & 1;
        const dx = this.segRemap ? x : 127 - x, dy = this.comDec ? y : 63 - y;
        out[dy * 128 + dx] = bit ^ (this.invert ? 1 : 0);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ MPU6050
export class MPU6050 {
  constructor(label, values) { this.label = label; this.values = values; this.reset(); }
  reset() { this.reg = new Uint8Array(128); this.reg[0x6b] = 0x40; this.reg[0x75] = 0x68; this.ptr = 0; this.first = true; }
  ready() { return this.powered !== false; }
  begin(write) { if (write) this.first = true; }
  write(b) { if (this.first) { this.ptr = b & 127; this.first = false; } else { this.reg[this.ptr] = b; this.ptr = (this.ptr + 1) & 127; } return true; }
  _sample() {
    const v = this.values(); const r = this.reg; const sleep = r[0x6b] & 0x40;
    const afs = (r[0x1c] >> 3) & 3, gfs = (r[0x1b] >> 3) & 3;
    const aLsb = 16384 / (1 << afs), gLsb = 131 / (1 << gfs);
    const put = (a, x) => { let n = Math.max(-32768, Math.min(32767, Math.round(x))); if (n < 0) n += 65536; r[a] = n >> 8; r[a + 1] = n & 255; };
    if (sleep) { for (let a = 0x3b; a <= 0x48; a++) r[a] = 0; return; }
    put(0x3b, v.ax * aLsb); put(0x3d, v.ay * aLsb); put(0x3f, v.az * aLsb);
    put(0x41, (v.temp - 36.53) * 340);
    put(0x43, v.gx * gLsb); put(0x45, v.gy * gLsb); put(0x47, v.gz * gLsb);
  }
  read() { if (this.ptr === 0x3b || this.ptr === 0x41 || this.ptr === 0x43) this._sample(); const b = this.reg[this.ptr]; this.ptr = (this.ptr + 1) & 127; return b; }
}

// ------------------------------------------------------------------ DS1307 / DS3231 RTC
export class RTC {
  constructor(label, kind, nowSec) { this.label = label; this.kind = kind; this.nowSec = nowSec; this.offset = 0; this.ram = new Uint8Array(64); this.ptr = 0; this.first = true; this.buf = null; }
  ready() { return this.powered !== false; }
  _date() { return new Date((Date.now() + this.offset * 1000)); }
  begin(write) { if (write) { this.first = true; this.buf = null; } }
  _regs() {
    const d = this._date(); const r = new Uint8Array(19);
    r[0] = bcd(d.getSeconds()); r[1] = bcd(d.getMinutes()); r[2] = bcd(d.getHours()); r[3] = d.getDay() + 1; r[4] = bcd(d.getDate()); r[5] = bcd(d.getMonth() + 1); r[6] = bcd(d.getFullYear() % 100);
    if (this.kind === 'ds3231') { r[0x0e] = 0x1c; r[0x0f] = 0; r[0x11] = 26; r[0x12] = 0x40; } else r[7] = 0x03;
    return r;
  }
  write(b) {
    if (this.first) { this.ptr = b & 63; this.first = false; this.buf = this._regs(); return true; }
    if (this.ptr <= 6) {
      this.buf[this.ptr] = b;
      if (this.ptr === 6 || this.ptr >= 0) {
        const r = this.buf; const want = new Date(2000 + unbcd(r[6]), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), unbcd(r[2] & 0x3f), unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
        if (!isNaN(want)) this.offset = (want.getTime() - Date.now()) / 1000;
      }
    } else if (this.kind === 'ds1307' && this.ptr >= 8) this.ram[this.ptr] = b;
    this.ptr = (this.ptr + 1) & 63; return true;
  }
  read() {
    if (!this.buf || this.ptr === 0) this.buf = this._regs();
    const b = this.ptr < 19 ? this.buf[this.ptr] : this.ram[this.ptr]; this.ptr = (this.ptr + 1) & 63; return b;
  }
}
