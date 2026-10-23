// I2C environmental / biometric sensors: Bosch BMP280 + BME280 (register-accurate, real compensation formulas)
// and the Maxim MAX30102 pulse oximeter (FIFO of red/IR PPG samples).
const US = 16;                                   // CPU cycles per microsecond

// ------------------------------------------------------------------ Bosch BMP280 / BME280
// The firmware libraries convert raw ADC counts with the factory trim constants stored in the chip. The simulator keeps
// typical trim constants and finds, by bisection, the raw counts that the *library's own integer compensation formula*
// (datasheet section 4.2.3 / 4.2.4) turns back into the temperature, pressure and humidity chosen on the slider.
const CAL = { T1: 27504, T2: 26435, T3: -1000, P1: 36477, P2: -10685, P3: 3024, P4: 2855, P5: 140, P6: -7, P7: 15500, P8: -14600, P9: 6000,
  H1: 75, H2: 362, H3: 0, H4: 316, H5: 50, H6: 30 };
const B = (x) => BigInt(x);

export function compT(adc, c = CAL) {            // -> { tFine, centi }  (centi = 0.01 degC)
  const a = B(adc), T1 = B(c.T1);
  const v1 = (((a >> 3n) - (T1 << 1n)) * B(c.T2)) >> 11n;
  const d = (a >> 4n) - T1;
  const v2 = (((d * d) >> 12n) * B(c.T3)) >> 14n;
  const tFine = v1 + v2;
  return { tFine, centi: Number((tFine * 5n + 128n) >> 8n) };
}
export function compP(adc, tFine, c = CAL) {     // -> Pa (float, as Adafruit_BMP280::readPressure)
  let v1 = tFine - 128000n;
  let v2 = v1 * v1 * B(c.P6);
  v2 += (v1 * B(c.P5)) << 17n;
  v2 += B(c.P4) << 35n;
  v1 = ((v1 * v1 * B(c.P3)) >> 8n) + ((v1 * B(c.P2)) << 12n);
  v1 = ((((1n << 47n) + v1)) * B(c.P1)) >> 33n;
  if (v1 === 0n) return 0;
  let p = 1048576n - B(adc);
  p = (((p << 31n) - v2) * 3125n) / v1;
  v1 = (B(c.P9) * (p >> 13n) * (p >> 13n)) >> 25n;
  v2 = (B(c.P8) * p) >> 19n;
  p = ((p + v1 + v2) >> 8n) + (B(c.P7) << 4n);
  return Number(p) / 256;
}
export function compH(adc, tFine, c = CAL) {     // -> %RH (as Adafruit_BME280::readHumidity)
  let v = tFine - 76800n;
  v = (((((B(adc) << 14n) - (B(c.H4) << 20n) - (B(c.H5) * v)) + 16384n) >> 15n) *
    (((((((v * B(c.H6)) >> 10n) * (((v * B(c.H3)) >> 11n) + 32768n)) >> 10n) + 2097152n) * B(c.H2) + 8192n) >> 14n));
  v -= (((((v >> 15n) * (v >> 15n)) >> 7n) * B(c.H1)) >> 4n);
  v = v < 0n ? 0n : v;
  v = v > 419430400n ? 419430400n : v;
  return Number(v >> 12n) / 1024;
}
// smallest integer in [lo, hi] where f(x) reaches the target; f is monotonic (increasing, or decreasing when dec = true)
function search(f, target, lo, hi, dec = false) {
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dec ? f(mid) <= target : f(mid) >= target) hi = mid; else lo = mid + 1; }
  return lo;
}
export function rawFor(tC, pPa, rh) {
  const adcT = search((x) => compT(x).centi, Math.round(tC * 100), 0, 1048575);
  const { tFine } = compT(adcT);
  const adcP = search((x) => compP(x, tFine), pPa, 0, 1048575, true);
  const adcH = search((x) => compH(x, tFine), rh, 0, 65535);
  return { adcT, adcP, adcH };
}

export class BoschEnv {
  // kind: 'bmp280' | 'bme280'; values() -> { temp (degC), pressure (hPa), humidity (%RH) }
  constructor(label, kind, values) { this.label = label; this.kind = kind; this.values = values; this.cache = ''; this.reset(); }
  reset() {
    this.reg = new Uint8Array(256); this.ptr = 0; this.first = true; this.cache = '';
    const r = this.reg, c = CAL;
    r[0xd0] = this.kind === 'bme280' ? 0x60 : 0x58;
    const le16 = (a, v) => { r[a] = v & 255; r[a + 1] = (v >> 8) & 255; };
    [['T1', 0x88], ['T2', 0x8a], ['T3', 0x8c], ['P1', 0x8e], ['P2', 0x90], ['P3', 0x92], ['P4', 0x94], ['P5', 0x96], ['P6', 0x98], ['P7', 0x9a], ['P8', 0x9c], ['P9', 0x9e]]
      .forEach(([k, a]) => le16(a, c[k]));
    if (this.kind === 'bme280') {
      r[0xa1] = c.H1; le16(0xe1, c.H2); r[0xe3] = c.H3;
      r[0xe4] = c.H4 >> 4; r[0xe5] = ((c.H5 & 15) << 4) | (c.H4 & 15); r[0xe6] = c.H5 >> 4; r[0xe7] = c.H6 & 255;
    }
    this._rawDefaults();
    r[0xf5] = 0; r[0xf4] = 0; r[0xf2] = 0;
  }
  _rawDefaults() { const r = this.reg; r[0xf7] = 0x80; r[0xfa] = 0x80; r[0xfd] = 0x80; r[0xf8] = r[0xf9] = r[0xfb] = r[0xfc] = r[0xfe] = 0; }
  ready() { return this.powered !== false; }
  begin(write) { if (write) this.first = true; }
  get mode() { return this.reg[0xf4] & 3; }
  _measure() {
    const r = this.reg, v = this.values(), key = `${v.temp}|${v.pressure}|${v.humidity}`;
    if (key !== this.cache) { this.cache = key; this.raw = rawFor(v.temp, v.pressure * 100, v.humidity); }
    const { adcT, adcP, adcH } = this.raw;
    const osrsT = (r[0xf4] >> 5) & 7, osrsP = (r[0xf4] >> 2) & 7, osrsH = r[0xf2] & 7;
    this._rawDefaults();
    if (osrsP) { r[0xf7] = adcP >> 12; r[0xf8] = (adcP >> 4) & 255; r[0xf9] = (adcP & 15) << 4; }
    if (osrsT) { r[0xfa] = adcT >> 12; r[0xfb] = (adcT >> 4) & 255; r[0xfc] = (adcT & 15) << 4; }
    if (this.kind === 'bme280' && osrsH) { r[0xfd] = adcH >> 8; r[0xfe] = adcH & 255; }
  }
  write(b) {
    if (this.first) { this.ptr = b; this.first = false; return true; }
    const r = this.reg, a = this.ptr;
    if (a === 0xe0) { if (b === 0xb6) this.reset(); }                        // soft reset
    else if (a === 0xf4) { r[0xf4] = b; if ((b & 3) !== 0) this._measure(); if ((b & 3) === 1 || (b & 3) === 2) r[0xf4] = b & ~3; }   // forced mode runs once, then sleeps
    else if (a === 0xf2) { r[0xf2] = b & 7; }                                  // humidity oversampling (applied by the next ctrl_meas write)
    else if (a === 0xf5) r[0xf5] = b;
    this.ptr = (this.ptr + 1) & 255; return true;
  }
  read() {
    const a = this.ptr; this.ptr = (this.ptr + 1) & 255;
    if (a >= 0xf7 && a <= 0xfe && this.mode === 3) this._measure();           // normal mode: always fresh
    if (a === 0xf3) return 0;                                                   // status: not measuring, NVM copy done
    return this.reg[a];
  }
}

// ------------------------------------------------------------------ MAX30102 (also answers as MAX30105 for the SparkFun library)
const SR = [50, 100, 200, 400, 800, 1000, 1600, 3200];
export class MAX30102 {
  // opts() -> { bpm, spo2, finger (bool), now() cycles }
  constructor(label, opts) { this.label = label; this.opts = opts; this.reset(); }
  reset() {
    this.reg = new Uint8Array(256); this.reg[0xff] = 0x15; this.reg[0xfe] = 0x03; this.reg[0x00] = 0x01;   // PWR_RDY
    this.ptr = 0; this.first = true; this.rd = 0; this.wr = 0; this.ovf = 0; this.q = []; this.t0 = null; this.made = 0; this.sub = 0; this.seed = 7; this.tempRdy = false;
  }
  ready() { return this.powered !== false; }
  begin(write) { if (write) this.first = true; }
  get active() { const m = this.reg[0x09] & 7; return (this.reg[0x09] & 0x80) ? 0 : m === 2 ? 1 : m === 3 ? 2 : m === 7 ? 3 : 0; }
  get rate() { return SR[(this.reg[0x0a] >> 2) & 7] / (1 << ((this.reg[0x08] >> 5) & 7)); }       // samples/s after averaging
  _rand() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return (this.seed >>> 8) / 16777216 - 0.5; }
  _wave(ph) {                                                                                     // normalised PPG pulse 0..1 (systolic peak + dicrotic wave)
    const g = (c, w) => Math.exp(-(((ph - c) / w) ** 2));
    return Math.min(1, 1.0 * g(0.18, 0.07) + 0.12 * g(0.46, 0.09));
  }
  _sample(k) {
    const o = this.opts(), r = this.reg;
    const t = k / this.rate, ph = (t * o.bpm / 60) % 1;
    const bits = 15 + ((r[0x0a]) & 3), drop = 18 - bits;
    const lvl = (x) => { const v = Math.max(0, Math.min(262143, Math.round(x))); return (v >> drop) << drop; };
    const w = this._wave(ph);
    // Maxim ratio-of-ratios: SpO2 = -45.060 R^2 + 30.354 R + 94.845  ->  R for the requested saturation
    const s = Math.max(70, Math.min(99.5, o.spo2)), disc = 30.354 ** 2 - 4 * 45.06 * (s - 94.845);
    const R = (30.354 + Math.sqrt(Math.max(0, disc))) / (2 * 45.06);
    const acIr = 0.007, acRed = acIr * R;
    const noise = this._rand() * 0.0002;
    if (!o.finger) return { red: lvl(r[0x0c] * 20 + this._rand() * 40), ir: lvl(r[0x0d] * 30 + this._rand() * 40) };        // ambient light only (< 50 000: "no finger")
    const dcIr = r[0x0d] * 2600, dcRed = r[0x0c] * 2600;                                                                 // LED current 0x1F -> ~ 80 000 counts (typical fingertip)
    return { red: lvl(dcRed * (1 - acRed * w + noise)), ir: lvl(dcIr * (1 - acIr * w + noise)) };
  }
  _advance() {
    const now = this.opts().now();
    if (this.t0 === null) this.t0 = now;
    if (!this.active) { this.t0 = now; this.made = 0; return; }
    const total = Math.floor((now - this.t0) / (16e6 / this.rate));
    for (; this.made < total; this.made++) {
      if (this.q.length >= 32) { this.q.shift(); this.rd = (this.rd + 1) & 31; this.ovf = Math.min(255, this.ovf + 1); }
      this.q.push(this._sample(this.made)); this.wr = (this.wr + 1) & 31;
    }
  }
  write(b) {
    if (this.first) { this.ptr = b; this.first = false; return true; }
    const a = this.ptr, r = this.reg;
    if (a === 0x09) {
      if (b & 0x40) { this.reset(); }                                                             // soft reset (bit self-clears)
      else { r[0x09] = b; this.q = []; this.rd = this.wr = this.ovf = 0; this.t0 = null; this.made = 0; }
    } else if (a === 0x04) { this.wr = b & 31; this.q = []; } else if (a === 0x05) this.ovf = b & 31; else if (a === 0x06) { this.rd = b & 31; this.q = []; }
    else if (a === 0x21) { if (b & 1) { this.tempRdy = true; } r[0x21] = 0; }
    else if (a !== 0xff && a !== 0xfe && a !== 0x07) r[a] = b;
    if (a !== 0x07) this.ptr = (this.ptr + 1) & 255;
    return true;
  }
  read() {
    const a = this.ptr, r = this.reg;
    if (a === 0x07) {                                                                             // FIFO_DATA: the pointer stays here, samples pop in order
      this._advance();
      const n = this.active;
      if (!n) return 0;
      if (!this.cur || this.curPos >= this.cur.length) {
        const s = this.q.shift();
        if (!s) { this.cur = null; return 0; }
        this.rd = (this.rd + 1) & 31;
        const lv = [s.red, s.ir, s.ir].slice(0, n);                                               // slot order: red, IR (, green)
        this.cur = lv.flatMap((v) => [(v >> 16) & 3, (v >> 8) & 255, v & 255]); this.curPos = 0;
      }
      return this.cur[this.curPos++];
    }
    this.ptr = (this.ptr + 1) & 255;
    if (a === 0x04 || a === 0x05 || a === 0x06) { this._advance(); return a === 0x04 ? this.wr : a === 0x05 ? this.ovf : this.rd; }
    if (a === 0x00) { this._advance(); const v = this.reg[0x00] | (this.q.length ? 0x40 : 0); this.reg[0x00] = 0; return v; }
    if (a === 0x01) { const v = this.tempRdy ? 0x02 : 0; this.tempRdy = false; return v; }
    if (a === 0x1f) return 30;                                                                    // die temperature 30.0625 degC
    if (a === 0x20) return 1;
    return r[a];
  }
}
