// Radio transceivers on a shared "air": Nordic nRF24L01(+) and Semtech SX1276/77/78 (LoRa).
// Radios placed in the same circuit hear each other when their settings match (channel + address, or
// frequency + spreading factor + bandwidth + sync word). A virtual peer can acknowledge / echo packets so a single
// board can be tested on its own.
const US = 16;
const hex = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join('');
const show = (p) => { const t = String.fromCharCode(...p.filter((b) => b !== 0)); return /^[\x20-\x7e]*$/.test(t) && t.length ? `"${t}"` : hex(p); };

export class Air {
  constructor(sim) { this.sim = sim; this.radios = []; }
  add(r) { this.radios.push(r); }
}

// ------------------------------------------------------------------ nRF24L01+
export class NRF24 {
  // io: { after(cycles, fn), now(), irq(low), log(text), peer() -> 'none' | 'ack' | 'echo', air }
  constructor(label, io) { this.label = label; this.io = io; this.reset(); }
  reset() {
    const r = this.reg = new Uint8Array(32);
    r[0x00] = 0x08; r[0x01] = 0x3f; r[0x02] = 0x03; r[0x03] = 0x03; r[0x04] = 0x03; r[0x05] = 0x02; r[0x06] = 0x0e; r[0x07] = 0x0e;
    this.addr = { 0x0a: [0xe7, 0xe7, 0xe7, 0xe7, 0xe7], 0x0b: [0xc2, 0xc2, 0xc2, 0xc2, 0xc2], 0x10: [0xe7, 0xe7, 0xe7, 0xe7, 0xe7] };
    r[0x0c] = 0xc3; r[0x0d] = 0xc4; r[0x0e] = 0xc5; r[0x0f] = 0xc6;
    this.tx = []; this.rx = []; this.ackPl = []; this.cmd = null; this.buf = []; this.ce = 0; this.busy = false; this.gen = (this.gen || 0) + 1; this.lastTx = null; this.pendingEcho = [];
    this._irq();
  }
  get status() { const r = this.reg; const p = this.rx.length ? this.rx[0].pipe : 7; return (r[0x07] & 0x70) | (p << 1) | (this.tx.length >= 3 ? 1 : 0); }
  get aw() { return (this.reg[0x03] & 3) + 2; }
  get prx() { return (this.reg[0x00] & 3) === 3; }                         // PWR_UP and PRIM_RX
  get ptx() { return (this.reg[0x00] & 3) === 2; }
  pipeAddr(p) { const a1 = this.addr[0x0b]; if (p === 0) return this.addr[0x0a].slice(0, this.aw); if (p === 1) return a1.slice(0, this.aw); return [this.reg[0x0a + p], ...a1.slice(1, this.aw)]; }
  get dyn() { return (this.reg[0x1d] & 0x04) !== 0; }
  _irq() { const r = this.reg, m = r[0x00]; const low = ((r[0x07] & 0x40) && !(m & 0x40)) || ((r[0x07] & 0x20) && !(m & 0x20)) || ((r[0x07] & 0x10) && !(m & 0x10)); this.io.irq?.(!!low); }
  fifo() { return (this.tx.length === 0 ? 0x10 : 0) | (this.tx.length >= 3 ? 0x20 : 0) | (this.rx.length >= 3 ? 0x02 : 0) | (this.rx.length === 0 ? 0x01 : 0); }
  csChange(low) {
    if (low) { this.cmd = null; this.buf = []; return; }
    this._finish();
  }
  // first byte of a command returns STATUS, the following ones return / take data
  transfer(b) {
    if (this.cmd === null) {
      this.cmd = b; this.buf = []; this.out = []; const st = this.status;
      const c = b;
      if (c <= 0x1f) this.out = this._readReg(c & 0x1f);
      else if (c === 0x61) { const pk = this.rx[0]; this.out = pk ? [...pk.data] : []; }
      else if (c === 0x60) this.out = [this.rx[0] ? this.rx[0].data.length : 0];
      else if (c === 0xe1) this.tx = [];
      else if (c === 0xe2) this.rx = [];
      else if (c === 0xe3) { if (this.lastTx) this.tx.unshift(this.lastTx); }
      return st;
    }
    const v = this.out?.length ? this.out.shift() : 0x00;
    this.buf.push(b);
    return v;
  }
  _readReg(a) {
    const r = this.reg;
    if (a === 0x0a || a === 0x0b || a === 0x10) return this.addr[a].slice(0, 5);
    if (a === 0x07) return [this.status];
    if (a === 0x17) return [this.fifo()];
    if (a === 0x09) return [this.rx.length ? 1 : 0];
    return [r[a]];
  }
  _finish() {
    const c = this.cmd, d = this.buf; this.cmd = null; this.buf = [];
    if (c === null) return;
    const r = this.reg;
    if (c >= 0x20 && c <= 0x3f && d.length) {
      const a = c & 0x1f;
      if (a === 0x0a || a === 0x0b || a === 0x10) { const cur = this.addr[a]; d.slice(0, 5).forEach((x, i) => (cur[i] = x)); }
      else if (a === 0x07) { r[7] &= ~(d[0] & 0x70); this._irq(); }
      else if (a !== 0x17 && a !== 0x08 && a !== 0x09) { r[a] = d[0]; if (a === 0x00) { this._irq(); this._kick(); } }
    } else if (c === 0x61) { this.rx.shift(); if (!this.rx.length) { /* RX_DR stays until cleared */ } }
    else if (c === 0xa0 || c === 0xb0) { if (this.tx.length < 3) this.tx.push({ data: d.slice(0, 32), noack: c === 0xb0 }); this._kick(); }
    else if ((c & 0xf8) === 0xa8) { this.ackPl.push({ pipe: c & 7, data: d.slice(0, 32) }); }
    else if (c === 0x50) { /* ACTIVATE (nRF24L01 non-plus): nothing to do */ }
  }
  setCE(level) { this.ce = level; if (level) this._kick(); }
  // start transmitting when CE is high in PTX mode with data in the TX FIFO
  _kick() {
    if (!this.ce || !this.ptx || this.busy || !this.tx.length) return;
    if (this.reg[0x07] & 0x10) return;                                        // MAX_RT must be cleared first
    this.busy = true; const g = this.gen;
    const pk = this.tx[0], air = 130 + 50 + pk.data.length * 8 * (this.reg[0x06] & 0x08 ? 0.5 : (this.reg[0x06] & 0x20 ? 4 : 1));
    this.io.after(air * US, () => {
      if (g !== this.gen) return;
      this.busy = false;
      const ok = this._send(pk);
      const autoAck = !pk.noack && (this.reg[0x01] & 1);
      if (ok || !autoAck) { this.tx.shift(); this.lastTx = pk; this.reg[0x07] |= 0x20; this.reg[0x08] = (this.reg[0x08] & 0xf0); }
      else {
        const arc = this.reg[0x04] & 15, ard = ((this.reg[0x04] >> 4) + 1) * 250;
        this.reg[0x08] = (Math.min(15, (this.reg[0x08] >> 4) + 1) << 4) | arc;
        this.busy = true;
        this.io.after(arc * ard * US, () => { if (g !== this.gen) return; this.busy = false; this.reg[0x07] |= 0x10; this._irq(); });
        return;
      }
      this._irq();
      if (this.ce && this.tx.length) this._kick();
    });
  }
  // put a packet on the air; returns true when somebody acknowledged it
  _send(pk) {
    const ch = this.reg[0x05], to = this.addr[0x10].slice(0, this.aw);
    let acked = false;
    for (const o of this.io.air.radios) {
      if (o === this || !(o instanceof NRF24) || o.reg[0x05] !== ch || !o.prx || !o.ce) continue;
      for (let p = 0; p < 6; p++) {
        if (!(o.reg[0x02] & (1 << p))) continue;
        if (o.aw !== this.aw || hex(o.pipeAddr(p)) !== hex(to)) continue;
        const width = o.dyn && (o.reg[0x1c] & (1 << p)) ? pk.data.length : o.reg[0x11 + p] || pk.data.length;
        o.receive(p, pk.data.slice(0, width).concat(Array(Math.max(0, width - pk.data.length)).fill(0)));
        if (o.reg[0x01] & (1 << p)) acked = true;
        const ap = o.ackPl.findIndex((x) => x.pipe === p);
        if (ap >= 0 && acked) { const a = o.ackPl.splice(ap, 1)[0]; this.receive(0, a.data); }
        break;
      }
    }
    const peer = this.io.peer();
    const at = to.every((b) => b >= 0x20 && b < 0x7f) ? `"${String.fromCharCode(...to)}"` : '0x' + hex([...to].reverse()).toUpperCase();
    this.io.log(`${this.label} kirim → alamat ${at}, kanal ${ch}: ${show(pk.data)}${acked ? ' (diterima radio lain)' : peer !== 'none' ? ' (diterima penerima virtual)' : ''}`);
    if (!acked && peer !== 'none') {
      acked = true;
      if (peer === 'echo') {                                                  // the virtual node sends the payload back ~10 ms later
        const data = pk.data.slice(); this.io.after(10000 * US, () => this._deliverEcho(data));
      }
    }
    return acked;
  }
  _deliverEcho(data, tries = 0) {
    if (this.prx && this.ce) {
      const p = this.reg[0x02] & 2 ? 1 : this.reg[0x02] & 1 ? 0 : [2, 3, 4, 5].find((x) => this.reg[0x02] & (1 << x));
      if (p !== undefined) { const w = this.dyn ? data.length : this.reg[0x11 + p] || data.length; this.receive(p, data.slice(0, w)); return; }
    }
    if (tries < 200) this.io.after(5000 * US, () => this._deliverEcho(data, tries + 1));      // wait up to 1 s for startListening()
  }
  receive(pipe, data) {
    if (this.rx.length >= 3) return;
    this.rx.push({ pipe, data }); this.reg[0x07] |= 0x40; this._irq();
  }
}

// ------------------------------------------------------------------ SX1276/77/78 LoRa modem
export class SX127x {
  // io: { after, now, dio0(level), log, peer() -> 'none' | 'echo', air, rssi() }
  constructor(label, io) { this.label = label; this.io = io; this.reset(); }
  reset() {
    const r = this.reg = new Uint8Array(128);
    r[0x01] = 0x09; r[0x06] = 0x6c; r[0x07] = 0x80; r[0x08] = 0x00; r[0x09] = 0x4f; r[0x0b] = 0x2b; r[0x0c] = 0x20; r[0x0e] = 0x80; r[0x0f] = 0x00;
    r[0x1d] = 0x72; r[0x1e] = 0x70; r[0x1f] = 0x64; r[0x20] = 0x00; r[0x21] = 0x08; r[0x22] = 0x01; r[0x26] = 0x00; r[0x31] = 0xc3; r[0x33] = 0x27; r[0x39] = 0x12; r[0x42] = 0x12;
    this.fifo = new Uint8Array(256); this.addr = null; this.write = false; this.gen = (this.gen || 0) + 1; this.dio = 0; this.io.dio0?.(0);
  }
  get mode() { return this.reg[0x01] & 7; }
  get lora() { return (this.reg[0x01] & 0x80) !== 0; }
  get frf() { return (this.reg[0x06] << 16) | (this.reg[0x07] << 8) | this.reg[0x08]; }
  get freqMHz() { return (this.frf * 32) / 524288; }
  get sf() { return this.reg[0x1e] >> 4; }
  get bw() { return this.reg[0x1d] >> 4; }
  get key() { return `${this.frf}|${this.sf}|${this.bw}|${this.reg[0x39]}|${(this.reg[0x33] >> 6) & 1}`; }
  csChange(low) { if (low) { this.addr = null; } }
  transfer(b) {
    if (this.addr === null) { this.write = (b & 0x80) !== 0; this.addr = b & 0x7f; return 0; }
    const a = this.addr; if (a !== 0) this.addr = (this.addr + 1) & 0x7f;
    if (this.write) { this._write(a, b); return 0; }
    return this._read(a);
  }
  _read(a) {
    const r = this.reg;
    if (a === 0x00) { const v = this.fifo[r[0x0d]]; r[0x0d] = (r[0x0d] + 1) & 255; return v; }
    if (a === 0x1b) return Math.max(0, Math.min(255, this.io.rssi() + 164 - 30));  // current RSSI (noise floor)
    return r[a];
  }
  _write(a, v) {
    const r = this.reg;
    if (a === 0x00) { this.fifo[r[0x0d]] = v; r[0x0d] = (r[0x0d] + 1) & 255; return; }
    if (a === 0x12) { r[0x12] &= ~v; this._dio(); return; }                    // IRQ flags: write 1 to clear
    if (a === 0x42 || a === 0x10 || a === 0x13 || a === 0x19 || a === 0x1a) return;
    if (a === 0x01) {
      const old = this.mode; r[0x01] = v;
      if (this.mode === 3 && old !== 3) this._tx();
      return;
    }
    r[a] = v;
  }
  _dio() {
    const map = (this.reg[0x40] >> 6) & 3, f = this.reg[0x12];
    const hi = map === 0 ? (f & 0x40) !== 0 : map === 1 ? (f & 0x08) !== 0 : false;
    if (hi !== !!this.dio) { this.dio = hi ? 1 : 0; this.io.dio0?.(this.dio); }
  }
  airtimeUs(n) {                                                              // Semtech AN1200.13 time-on-air
    const bwHz = [7.8e3, 10.4e3, 15.6e3, 20.8e3, 31.25e3, 41.7e3, 62.5e3, 125e3, 250e3, 500e3][this.bw] || 125e3, sf = this.sf || 7;
    const tSym = (2 ** sf) / bwHz, cr = ((this.reg[0x1d] >> 1) & 7) || 1, ih = this.reg[0x1d] & 1, crc = (this.reg[0x1e] >> 2) & 1, de = (this.reg[0x26] >> 3) & 1;
    const pre = ((this.reg[0x20] << 8) | this.reg[0x21]) + 4.25;
    const pl = 8 + Math.max(Math.ceil((8 * n - 4 * sf + 28 + 16 * crc - 20 * ih) / (4 * (sf - 2 * de))) * (cr + 4), 0);
    return (pre + pl) * tSym * 1e6;
  }
  _tx() {
    const r = this.reg, n = r[0x22], base = r[0x0e];
    const data = Array.from({ length: n }, (_, i) => this.fifo[(base + i) & 255]);
    const g = this.gen, t = this.airtimeUs(n);
    this.io.after(Math.round(t * US), () => {
      if (g !== this.gen) return;
      r[0x12] |= 0x08; r[0x01] = (r[0x01] & 0xf8) | 1; this._dio();         // TxDone, back to standby
      let heard = false;
      for (const o of this.io.air.radios) if (o !== this && o instanceof SX127x && o.key === this.key && o.listening) { o.receive(data, -60, 9.5); heard = true; }
      const peer = this.io.peer();
      this.io.log(`${this.label} kirim LoRa ${this.freqMHz.toFixed(1)} MHz SF${this.sf}: ${show(data)} (${(t / 1000).toFixed(1)} ms)${heard ? ' (diterima radio lain)' : ''}`);
      if (peer === 'echo') this.io.after(Math.round((200000 + t) * US), () => this._echo(data, 0));
    });
  }
  get listening() { return this.lora && (this.mode === 5 || this.mode === 6); }
  _echo(data, tries) {
    if (this.listening) { this.receive(data, -72, 7.25); return; }
    if (tries < 100) this.io.after(10000 * US, () => this._echo(data, tries + 1));
  }
  receive(data, rssi, snr) {
    const r = this.reg, base = r[0x0f];
    data.forEach((b, i) => (this.fifo[(base + i) & 255] = b));
    r[0x10] = base; r[0x13] = data.length; r[0x1a] = Math.max(0, Math.min(255, rssi + (this.freqMHz < 525 ? 164 : 157))); r[0x19] = Math.round(snr * 4) & 255;
    r[0x12] |= 0x40 | 0x10;                                                   // RxDone + ValidHeader
    if (this.mode === 6) r[0x01] = (r[0x01] & 0xf8) | 1;                      // RX single -> standby
    this._dio();
  }
}
