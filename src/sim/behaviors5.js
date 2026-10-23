// SPI parts: MAX7219 LED matrix (single 8x8 and 4-in-1 FC-16), SSD1306 OLED (SPI), ILI9341 TFT, microSD card.
import { H } from './behaviors2.js';
import { spiSlave } from './spi.js';
import { SSD1306 } from './i2c.js';
import { SDCard } from './sdcard.js';
import { MFRC522, MifareClassic } from './rc522.js';
import { Air, NRF24, SX127x } from './radio.js';

const { live, attr, supply, warnSupply } = H;

// ------------------------------------------------------------------ MAX7219 (daisy-chained 16-bit shift registers, latched on CS rising edge)
export class MAX7219Chain {
  constructor(n) { this.n = n; this.reset(); }
  reset() {
    this.digits = Array.from({ length: this.n }, () => new Uint8Array(8));
    this.intensity = new Uint8Array(this.n); this.scan = new Uint8Array(this.n).fill(7); this.shutdown = new Uint8Array(this.n).fill(1);
    this.test = new Uint8Array(this.n); this.decode = new Uint8Array(this.n); this.sr = []; this.dirty = true;
  }
  transfer(b) { this.sr.push(b); if (this.sr.length > 2 * this.n) this.sr.shift(); }
  csChange(low) {
    if (low) return;                                         // latch on the rising edge
    const sr = this.sr; this.sr = [];
    if (sr.length < 2) return;
    // the last 16 bits shifted in sit in device 0 (next to DIN), the ones before in device 1, ...
    for (let k = 0; k < this.n && sr.length >= 2 * (k + 1); k++) {
      const op = sr[sr.length - 2 * (k + 1)] & 15, data = sr[sr.length - 2 * k - 1];
      if (op >= 1 && op <= 8) this.digits[k][op - 1] = data;
      else if (op === 9) this.decode[k] = data;
      else if (op === 10) this.intensity[k] = data & 15;
      else if (op === 11) this.scan[k] = data & 7;
      else if (op === 12) this.shutdown[k] = data & 1 ? 0 : 1;
      else if (op === 15) this.test[k] = data & 1;
    }
    this.dirty = true;
  }
  rows(k) {
    if (this.test[k]) return new Uint8Array(8).fill(255);
    if (this.shutdown[k]) return new Uint8Array(8);
    return this.digits[k].map((v, i) => (i <= this.scan[k] ? v : 0));
  }
}

const max7219 = (n, rightToLeft) => (ctx) => {
  let chip = null, s = { ok: false }, link = null;
  const paint = () => {
    if (!chip) return;
    const rows = [], br = [];
    for (let m = 0; m < n; m++) { const k = rightToLeft ? n - 1 - m : m; rows.push(s.ok ? chip.rows(k) : new Uint8Array(8)); br.push(chip.intensity[k]); }
    ctx.el.setMatrix?.(rows, (Math.max(...br) + 1) / 16);
    chip.dirty = false;
  };
  return {
    attach() {
      chip = new MAX7219Chain(n);
      link = spiSlave(ctx, { sck: 'CLK', mosi: 'DIN', cs: 'CS' }, { transfer: (b) => chip.transfer(b), csChange: (low) => chip.csChange(low) });
      if (!ctx.ardPins('DIN').length) ctx.sim.warn(`mx-din-${ctx.part.id}`, `${ctx.label}: pin DIN belum terhubung ke pin Arduino.`);
      if (!ctx.ardPins('CS').length) ctx.sim.warn(`mx-cs-${ctx.part.id}`, `${ctx.label}: pin CS belum terhubung ke pin Arduino (data hanya diterima saat CS di-LOW-kan lalu di-HIGH-kan).`);
    },
    drivers2(v) { s = supply(ctx, v); return []; },
    render(v) { const was = s.ok; s = supply(ctx, v); warnSupply(ctx, s); if (chip?.dirty || was !== s.ok) paint(); },
    reset() { chip?.reset(); link?.resetBits(); paint(); },
    chip: () => chip,
  };
};

// the Wokwi SSD1306 board can be fed on VIN (3-5 V) or on its 3V3 pin
function oledSupply(ctx, v) {
  const g = v(ctx.n('GND')), a = v(ctx.n('VIN')), b = v(ctx.n('3V3'));
  const hi = Math.max(live(a) ? a : -1, live(b) ? b : -1);
  return { ok: live(g) && g < 0.25 && hi - g > 0.5, hi, lo: g, vcc: 'VIN/3V3', gnd: 'GND' };
}

// ------------------------------------------------------------------ SSD1306 OLED over 4-wire SPI (D/C selects command or data)
const oledSpi = (ctx) => {
  let dev = null, s = { ok: false }, link = null;
  const draw = () => {
    const el = ctx.el; if (!el.imageData) { el.frame = dev.frame(); return; }
    const f = s.ok ? dev.frame() : new Uint8Array(128 * 64), d = el.imageData.data;
    for (let i = 0; i < f.length; i++) { const o = i * 4, on = f[i]; d[o] = on ? 0x9f : 0; d[o + 1] = on ? 0xe6 : 0; d[o + 2] = on ? 0xff : 0; d[o + 3] = 255; }
    el.redraw?.();
  };
  return {
    attach() {
      dev = new SSD1306(ctx.label);
      link = spiSlave(ctx, { sck: 'CLK', mosi: 'DATA', cs: 'CS', dc: 'DC' }, { transfer: (b, dc) => { if (dc) dev._data(b); else dev._command(b); } });
      if (!ctx.ardPins('DC').length) ctx.sim.warn(`oled-dc-${ctx.part.id}`, `${ctx.label}: pin DC belum terhubung ke pin Arduino (DC memilih perintah/data).`);
    },
    drivers2(v) { s = oledSupply(ctx, v); return []; },
    render(v) { const was = s.ok; s = oledSupply(ctx, v); warnSupply(ctx, s); if (dev && (dev.dirty || was !== s.ok)) { draw(); dev.dirty = false; } },
    reset() { dev?.reset(); link?.resetBits(); if (dev) draw(); },
    dev: () => dev,
  };
};

// ------------------------------------------------------------------ ILI9341 240x320 TFT (MIPI-DBI commands, RGB565 frame memory)
const ARGN = { 0x2a: 4, 0x2b: 4, 0x36: 1, 0x3a: 1, 0x37: 2, 0x26: 1, 0x51: 1, 0xb1: 2, 0xb6: 3, 0xc0: 1, 0xc1: 1, 0xc5: 2, 0xc7: 1, 0xf2: 1, 0xe0: 15, 0xe1: 15,
  0xcf: 3, 0xed: 4, 0xe8: 3, 0xcb: 5, 0xf7: 1, 0xea: 2, 0x33: 6 };
export class ILI9341 {
  constructor() { this.fb = new Uint16Array(240 * 320); this.reset(); }
  reset() {
    this.fb.fill(0); this.cmd = -1; this.args = []; this.c0 = 0; this.c1 = 239; this.p0 = 0; this.p1 = 319; this.c = 0; this.p = 0;
    this.madctl = 0; this.on = false; this.sleep = true; this.invert = false; this.hi = -1; this.ram = false; this.dirty = true; this.rd = null; this.scroll = 0;
  }
  transfer(b, dc) {
    if (!dc) {                                                            // command byte
      this.cmd = b; this.args = []; this.ram = false; this.hi = -1; this.rd = null;
      if (b === 0x01) { const fb = this.fb; this.reset(); this.fb = fb; }
      else if (b === 0x11) this.sleep = false; else if (b === 0x10) this.sleep = true;
      else if (b === 0x29) { this.on = true; this.dirty = true; } else if (b === 0x28) { this.on = false; this.dirty = true; }
      else if (b === 0x20 || b === 0x21) { this.invert = b === 0x21; this.dirty = true; }
      else if (b === 0x2c) { this.ram = true; this.c = this.c0; this.p = this.p0; }
      else if (b === 0x3c) this.ram = true;                               // memory write continue
      else if (b === 0x04) this.rd = [0x00, 0x00, 0x93, 0x41];            // read display ID (dummy + ID1..3)
      else if (b === 0x09) this.rd = [0x00, 0x80 | (this.madctl & 0x40) | 0x14, 0x53, 0x04, this.on ? 0x00 : 0x00];
      else if (b === 0x0a) this.rd = [(this.sleep ? 0 : 0x10) | (this.on ? 0x04 : 0) | 0x88];   // power mode (Adafruit example prints 0x9C)
      else if (b === 0x0b) this.rd = [this.madctl];
      else if (b === 0x0c) this.rd = [0x05];
      else if (b === 0x0f) this.rd = [0xc0];
      else if (b === 0xd3) this.rd = [0x00, 0x00, 0x93, 0x41];
      return 0;
    }
    if (this.rd) { return this.rd.length ? this.rd.shift() : 0; }
    if (this.ram) {
      if (this.hi < 0) { this.hi = b; return 0; }
      const v = (this.hi << 8) | b; this.hi = -1; this._px(v); return 0;
    }
    this.args.push(b);
    const a = this.args, n = ARGN[this.cmd] ?? 0;
    if (a.length === n) {
      if (this.cmd === 0x2a) { this.c0 = (a[0] << 8) | a[1]; this.c1 = (a[2] << 8) | a[3]; }
      else if (this.cmd === 0x2b) { this.p0 = (a[0] << 8) | a[1]; this.p1 = (a[2] << 8) | a[3]; }
      else if (this.cmd === 0x36) { this.madctl = a[0]; }
      else if (this.cmd === 0x37) { this.scroll = ((a[0] << 8) | a[1]) % 320; this.dirty = true; }
    }
    return 0;
  }
  _px(v) {
    const mv = this.madctl & 0x20, mx = this.madctl & 0x40, my = this.madctl & 0x80;
    const row = mv ? this.c : this.p, col = mv ? this.p : this.c;     // row/column address in frame memory
    if (row < 320 && col < 240) {
      const x = mx ? col : 239 - col, y = my ? 319 - row : row;          // the panel scans mirrored; Adafruit rotation 0 sets MX
      if (!(this.madctl & 0x08)) v = ((v & 0x1f) << 11) | (v & 0x07e0) | (v >> 11);   // RGB order -> swap red/blue on this BGR panel
      this.fb[y * 240 + x] = v;
    }
    this.dirty = true;
    if (++this.c > this.c1) { this.c = this.c0; if (++this.p > this.p1) this.p = this.p0; }
  }
  rgba(out) {
    const show = this.on && !this.sleep;
    for (let y = 0; y < 320; y++) {
      const sy = (y + this.scroll) % 320;
      for (let x = 0; x < 240; x++) {
        let v = show ? this.fb[sy * 240 + x] : 0; if (show && this.invert) v ^= 0xffff;
        const o = (y * 240 + x) * 4;
        out[o] = ((v >> 11) & 31) * 255 / 31; out[o + 1] = ((v >> 5) & 63) * 255 / 63; out[o + 2] = (v & 31) * 255 / 31; out[o + 3] = 255;
      }
    }
    return out;
  }
}

const ili9341 = (ctx) => {
  let dev = null, s = { ok: false }, link = null, img = null;
  const draw = () => {
    const cv = ctx.el.canvas, g = cv?.getContext?.('2d');
    if (!g || typeof ImageData === 'undefined') { ctx.el.fb = dev.fb; return; }
    img ||= new ImageData(240, 320);
    if (s.ok) dev.rgba(img.data); else for (let i = 0; i < img.data.length; i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  };
  return {
    attach() {
      dev = new ILI9341();
      link = spiSlave(ctx, { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS', dc: 'D/C' }, dev);
      if (!ctx.ardPins('D/C').length) ctx.sim.warn(`tft-dc-${ctx.part.id}`, `${ctx.label}: pin D/C belum terhubung ke pin Arduino.`);
    },
    drivers2(v) { s = supply(ctx, v); return []; },
    render(v) {
      const was = s.ok; s = supply(ctx, v); warnSupply(ctx, s);
      if (dev && (dev.dirty || was !== s.ok)) { dev.dirty = false; draw(); }
    },
    reset() { dev?.reset(); link?.resetBits(); if (dev) draw(); },
    dev: () => dev,
  };
};

// ------------------------------------------------------------------ microSD card module (files survive sketch restarts)
const microsd = (ctx) => {
  let card = null, s = { ok: false }, link = null;
  return {
    attach() {
      const store = ((ctx.sim._sdStore ||= {})[ctx.part.id] ||= new Map());
      card = new SDCard(store);
      const io = { transfer: (b) => (s.ok ? card.transfer(b) : 0xff), csChange: (low) => card.csChange(low) };
      link = spiSlave(ctx, { sck: 'SCK', mosi: 'DI', miso: 'DO', cs: 'CS' }, io);
      if (!ctx.ardPins('CS').length) ctx.sim.warn(`sd-cs-${ctx.part.id}`, `${ctx.label}: pin CS belum terhubung ke pin Arduino (SD.begin(pinCS) memakai pin ini).`);
      if (!ctx.ardPins('DO').length) ctx.sim.warn(`sd-do-${ctx.part.id}`, `${ctx.label}: pin DO (MISO) belum terhubung; kartu tidak bisa menjawab.`);
    },
    drivers1: () => (link ? link.misoDriver() : []),
    drivers2(v) { s = supply(ctx, v); card.inserted = attr(ctx, 'inserted', 'ya') !== 'tidak'; return []; },
    render(v) { s = supply(ctx, v); warnSupply(ctx, s); },
    reset() { card?.reset(); link?.resetBits(); },
    files: () => card?.files() || [],
    card: () => card,
  };
};

// ------------------------------------------------------------------ RC522 RFID reader + MIFARE Classic 1K cards (card memory is kept per UID)
export const RFID_CARDS = { 'Kartu 1': [0xd3, 0x4f, 0x8a, 0x1e], 'Kartu 2': [0xf2, 0x19, 0x6c, 0x2b], 'Gantungan kunci': [0x83, 0xa5, 0x11, 0x0c] };
const rc522 = (ctx) => {
  let chip = null, link = null, ok = false, last = null;
  const cards = (ctx.sim._rfid ||= {});
  const card = () => {
    const sel = attr(ctx, 'card', 'tidak ada'), uid = RFID_CARDS[sel];
    if (sel !== last) { last = sel; if (uid) { cards[sel] ||= new MifareClassic(uid); cards[sel].state = 'idle'; cards[sel].auth = -1; } }   // card (re)enters the field
    return uid ? cards[sel] : null;
  };
  const rstLow = () => ctx.ardPins('RST').some((p) => ctx.sim.board.driveLevel(p) === 0);
  return {
    attach() {
      chip = new MFRC522(ctx.label, card);
      link = spiSlave(ctx, { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'SDA' }, {
        transfer: (b) => (ok && !rstLow() ? chip.transfer(b) : 0),
        csChange: (low) => chip.csChange(low),
      });
      if (!ctx.ardPins('SDA').length) ctx.sim.warn(`rc-ss-${ctx.part.id}`, `${ctx.label}: pin SDA (SS/CS) belum terhubung ke pin Arduino. Pada RC522, pin "SDA" adalah chip select SPI, bukan SDA I2C.`);
    },
    drivers1: () => (link ? link.misoDriver() : []),
    drivers2(v) {
      const g = v(ctx.n('GND')), hi = v(ctx.n('3.3V'));
      ok = live(g) && live(hi) && g < 0.25 && hi - g > 0.5;
      return [];
    },
    render(v) {
      const g = v(ctx.n('GND')), hi = v(ctx.n('3.3V'));
      if (!ok && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan 3.3V ke 3V3 dan GND ke GND.`);
      if (live(hi) && live(g) && hi - g > 0.8) ctx.sim.warn(`rc-5v-${ctx.part.id}`, `${ctx.label}: pin 3.3V diberi ${((hi - g) * 5).toFixed(1)} V. RC522 bekerja pada 3,3 V; 5 V dapat merusak modul asli.`);
    },
    reset() { chip?.reset(); link?.resetBits(); last = null; },
    chip: () => chip,
  };
};

// ------------------------------------------------------------------ radios: nRF24L01 and LoRa SX1278 on the shared air
function radioLog(ctx) {
  let lastT = -1e12, skipped = 0;
  return (text) => {
    const t = ctx.sim.board.cpu.cycles;
    if (t - lastT < 16e6 * 0.25) { skipped++; return; }
    ctx.sim.info('📡 ' + text + (skipped ? ` (+${skipped} paket lain)` : '')); lastT = t; skipped = 0;
  };
}
const peerOf = (ctx) => { const p = attr(ctx, 'peer', 'penerima virtual'); return p === 'tidak ada' ? 'none' : p.startsWith('gema') ? 'echo' : 'ack'; };
function power33(ctx, v, vccPin) {
  const g = v(ctx.n('GND')), hi = v(ctx.n(vccPin));
  return { ok: live(g) && live(hi) && g < 0.25 && hi - g > 0.5, over: live(g) && live(hi) && hi - g > 0.8, hi, g };
}

const nrf24 = (ctx) => {
  let dev = null, link = null, irqLow = false, pw = { ok: false };
  return {
    attach() {
      const sim = ctx.sim, air = (sim._air ||= new Air(sim));
      dev = new NRF24(ctx.label, { after: (c, f) => sim.after(c, f), irq: (low) => { if (low !== irqLow) { irqLow = low; sim.resolveNow(); } }, log: radioLog(ctx), peer: () => peerOf(ctx), air });
      air.add(dev);
      link = spiSlave(ctx, { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CSN' }, { transfer: (b) => (pw.ok ? dev.transfer(b) : 0), csChange: (low) => dev.csChange(low) });
      const ce = ctx.ardPins('CE');
      for (const p of ce) sim.board.onEdge(p, (l) => dev.setCE(l === 1 ? 1 : 0));
      if (!ce.length) ctx.sim.warn(`nrf-ce-${ctx.part.id}`, `${ctx.label}: pin CE belum terhubung ke pin Arduino (CE menyalakan pemancar/penerima).`);
      if (!ctx.ardPins('CSN').length) ctx.sim.warn(`nrf-csn-${ctx.part.id}`, `${ctx.label}: pin CSN belum terhubung ke pin Arduino.`);
    },
    drivers1: () => [...(link ? link.misoDriver() : []), ...(pw.ok ? [{ net: ctx.n('IRQ'), value: irqLow ? 0 : pw.hi, label: ctx.label }] : [])],
    drivers2(v) { pw = power33(ctx, v, 'VCC'); return []; },
    render(v) {
      if (!pw.ok && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VCC ke 3.3V dan GND ke GND.`);
      if (pw.over) ctx.sim.warn(`nrf-5v-${ctx.part.id}`, `${ctx.label}: VCC diberi ${((pw.hi - pw.g) * 5).toFixed(1)} V. nRF24L01 hanya tahan 1,9–3,6 V; pakai pin 3.3V (atau modul adaptor 5 V).`);
    },
    reset() { dev?.reset(); link?.resetBits(); },
    dev: () => dev,
  };
};

const lora = (ctx) => {
  let dev = null, link = null, dio = 0, pw = { ok: false };
  const rstLow = () => ctx.ardPins('RST').some((p) => ctx.sim.board.driveLevel(p) === 0);
  return {
    attach() {
      const sim = ctx.sim, air = (sim._air ||= new Air(sim));
      dev = new SX127x(ctx.label, { after: (c, f) => sim.after(c, f), dio0: (l) => { if (l !== dio) { dio = l; sim.resolveNow(); } }, log: radioLog(ctx), peer: () => peerOf(ctx), air, rssi: () => -110 });
      air.add(dev);
      link = spiSlave(ctx, { sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'NSS' }, { transfer: (b) => (pw.ok && !rstLow() ? dev.transfer(b) : 0), csChange: (low) => dev.csChange(low) });
      for (const p of ctx.ardPins('RST')) sim.board.onEdge(p, (l) => { if (l === 0) dev.reset(); });
      if (!ctx.ardPins('NSS').length) ctx.sim.warn(`lora-nss-${ctx.part.id}`, `${ctx.label}: pin NSS (chip select) belum terhubung ke pin Arduino.`);
    },
    drivers1: () => [...(link ? link.misoDriver() : []), ...(pw.ok ? [{ net: ctx.n('DIO0'), value: dio ? pw.hi : 0, label: ctx.label }] : [])],
    drivers2(v) { pw = power33(ctx, v, '3.3V'); return []; },
    render(v) {
      if (!pw.ok && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan 3.3V ke 3V3 dan GND ke GND.`);
      if (pw.over) ctx.sim.warn(`lora-5v-${ctx.part.id}`, `${ctx.label}: pin 3.3V diberi ${((pw.hi - pw.g) * 5).toFixed(1)} V. SX1278 maksimal 3,7 V; 5 V merusak modul asli.`);
    },
    reset() { dev?.reset(); link?.resetBits(); },
    dev: () => dev,
  };
};

export const BEHAVIORS5 = {
  'mod-nrf24': nrf24,
  'mod-lora': lora,
  'mod-rc522': rc522,
  'wokwi-microsd-card': microsd,
  'wokwi-ili9341': ili9341,
  'mod-max7219': max7219(1, false),
  'mod-max7219-4': max7219(4, true),
  'wokwi-ssd1306': oledSpi,
};
