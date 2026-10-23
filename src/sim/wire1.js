// 1-Wire bus (Maxim / Dallas) with DS18B20 temperature sensors, simulated at pin level.
// The microcontroller pin edges are timestamped in CPU cycles (16 per microsecond) so the real timing rules apply:
//   reset      : master holds the line low >= 480 us; slaves answer with a presence pulse (low 60..240 us) 15..60 us after release
//   write slot : master pulls low 1..15 us for a "1", >= 60 us for a "0" (the slave samples ~30 us after the falling edge)
//   read slot  : master pulls low ~3 us then releases; a slave sending "0" keeps the line low for ~60 us, "1" = lets go
// All devices on one line share a bus object, so ROM search / match ROM with several sensors behaves like the real chip.
const US = 16;

export const crc8 = (bytes) => {
  let crc = 0;
  for (const b of bytes) { let x = b; for (let i = 0; i < 8; i++) { const mix = (crc ^ x) & 1; crc >>= 1; if (mix) crc ^= 0x8c; x >>= 1; } }
  return crc;
};

export class DS18B20 {
  constructor(label, getTemp, index = 0) {
    this.label = label; this.getTemp = getTemp;
    let h = 2166136261; for (const c of label + '#' + index) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const sn = [(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, (h * 7 >>> 0) & 255, 0x01 + (index & 0x7f)];
    const rom = [0x28, ...sn]; rom.push(crc8(rom)); this.rom = rom;          // family 0x28 = DS18B20, serial, CRC
    this.reset();
  }
  reset() {
    this.th = 75; this.tl = 70; this.cfg = 0x7f; this.eeprom = [75, 70, 0x7f];
    this.temp = 0x0550;                      // power-on value: +85.0 deg C
    this.busyUntil = -1; this.powered = true; this.parasite = false;
  }
  get resolution() { return 9 + ((this.cfg >> 5) & 3); }
  convTimeUs() { return (750000 >> (12 - this.resolution)); }              // 93.75 / 187.5 / 375 / 750 ms
  startConversion(now) {
    if (this.parasite) return;               // a parasite-powered sensor needs a strong pull-up during conversion: not modelled -> stays at 85 C
    const c = Math.max(-55, Math.min(125, +this.getTemp()));
    let raw = Math.round(c * 16) & 0xffff;
    raw &= ~((1 << (12 - this.resolution)) - 1);                              // lower bits are undefined (0) at reduced resolution
    this.pending = raw; this.busyUntil = now + this.convTimeUs() * US;
  }
  busy(now) {
    if (this.busyUntil < 0) return false;
    if (now >= this.busyUntil) { this.busyUntil = -1; if (this.pending !== undefined) { this.temp = this.pending; this.pending = undefined; } return false; }
    return true;
  }
  scratchpad() {
    const b = [this.temp & 255, (this.temp >> 8) & 255, this.th & 255, this.tl & 255, this.cfg, 0xff, 0x0c, 0x10];
    b.push(crc8(b)); return b;
  }
  alarm() { const t = this.temp / 16; return t >= (this.th << 24 >> 24) || t <= (this.tl << 24 >> 24); }
}

export class OneWireBus {
  // io: { low(bool) drives the shared line, after(cycles, fn), now() }
  constructor(io, label) {
    this.io = io; this.label = label; this.devs = []; this.low = false; this.tFall = -1; this.level = 1; this.gen = 0;
    this.phase = 'idle'; this.sel = []; this.tx = null; this.txPos = 0; this.rxByte = 0; this.rxBits = 0; this.rxBuf = [];
  }
  add(dev) { this.devs.push(dev); }
  hardReset() { this.low = false; this.tFall = -1; this.level = 1; this.gen++; this.phase = 'idle'; this.tx = null; this.sel = []; this.pullChecked = false; }
  ready() { return this.devs.some((d) => d.powered); }
  /** the master (microcontroller) pin changed: lvl = 0 (pulling low) or 1 (released / driven high) */
  edge(lvl, t) {
    if (lvl === this.level) return;
    this.level = lvl;
    if (lvl === 0) { this.tFall = t; this._onFall(t); return; }
    if (this.tFall < 0) return;
    const us = (t - this.tFall) / US; this.tFall = -1;
    if (us >= 240) { this._reset(t); return; }
    if (this.slotRead) { this.slotRead = false; return; }                    // end of a read slot, not a write                               // reset pulse (>= 480 us in the spec; 240 leaves margin)
    this._onWriteSlot(us < 32 ? 1 : 0, t);
  }
  _pulse(startUs, lenUs) {
    const my = ++this.gen;
    this.io.after(startUs * US, () => { if (my === this.gen) { this.low = true; this.io.resolve(); this.io.after(lenUs * US, () => { if (my === this.gen) { this.low = false; this.io.resolve(); } }); } });
  }
  _reset(t) {
    this.sel = this.devs.filter((d) => d.powered); this.phase = 'rom_cmd'; this.rxByte = 0; this.rxBits = 0; this.tx = null;
    this.devs.forEach((d) => d.busy(t));
    this.onReset?.();
    if (this.sel.length) { ++this.gen; const my = this.gen; this.io.after(30 * US, () => { if (my === this.gen) { this.low = true; this.io.resolve(); this.io.after(120 * US, () => { if (my === this.gen) { this.low = false; this.io.resolve(); } }); } }); }
  }
  // ---- read slot (slave transmits): decide the bit when the falling edge arrives
  _onFall(t) {
    if (this.low) return;
    const ph = this.phase;
    this.slotRead = !!this.tx || ['poll', 'powersupply', 'search_a', 'search_b'].includes(ph);
    const bit = this._nextTxBit(t);
    if (bit === 0) { const my = ++this.gen; this.low = true; this.io.resolve(); this.io.after(45 * US, () => { if (my === this.gen) { this.low = false; this.io.resolve(); } }); }
  }
  _nextTxBit(t) {
    const ph = this.phase;
    if (ph === 'poll') return this.sel.some((d) => d.busy(t)) ? 0 : 1;
    if (ph === 'powersupply') return this.sel.every((d) => !d.parasite) ? 1 : 0;
    if (ph === 'search_a' || ph === 'search_b') {
      const i = this.searchPos, comp = ph === 'search_b';
      if (!this.sel.length) return 1;
      let v = 1;
      for (const d of this.sel) { const b = (d.rom[i >> 3] >> (i & 7)) & 1; if ((comp ? b ^ 1 : b) === 0) v = 0; }
      this.phase = comp ? 'search_w' : 'search_b';
      return v;
    }
    if (this.tx) {
      const byte = this.tx[this.txPos >> 3] ?? 0xff;
      const bit = (byte >> (this.txPos & 7)) & 1; this.txPos++;
      if (this.txPos >= this.tx.length * 8) { this.tx = null; if (ph === 'tx_done_poll') this.phase = 'poll'; else this.phase = 'idle'; }
      return bit;
    }
    return 1;
  }
  // ---- write slot (slave receives)
  _onWriteSlot(bit, t) {
    if (this.phase === 'search_w') {
      const i = this.searchPos;
      this.sel = this.sel.filter((d) => ((d.rom[i >> 3] >> (i & 7)) & 1) === bit);
      this.searchPos++;
      this.phase = this.searchPos >= 64 ? 'idle' : 'search_a';
      return;
    }
    if (!['rom_cmd', 'rom_match', 'func_cmd', 'rx_scratch'].includes(this.phase)) return;
    this.rxByte |= bit << this.rxBits;
    if (++this.rxBits < 8) return;
    const b = this.rxByte; this.rxByte = 0; this.rxBits = 0;
    this._onByte(b, t);
  }
  _onByte(b, t) {
    const sel = this.sel;
    switch (this.phase) {
      case 'rom_cmd':
        if (b === 0xcc) { this.phase = 'func_cmd'; }                                              // skip ROM
        else if (b === 0x33) { this.tx = this._andBytes(sel.map((d) => d.rom)); this.txPos = 0; this.phase = 'tx_rom'; }   // read ROM
        else if (b === 0x55) { this.phase = 'rom_match'; this.rxBuf = []; }                      // match ROM
        else if (b === 0xf0 || b === 0xec) {                                                      // search ROM / alarm search
          this.sel = b === 0xec ? sel.filter((d) => d.alarm()) : sel; this.searchPos = 0; this.phase = this.sel.length ? 'search_a' : 'idle';
        } else this.phase = 'idle';
        break;
      case 'rom_match':
        this.rxBuf.push(b);
        if (this.rxBuf.length === 8) {
          this.sel = sel.filter((d) => d.rom.every((x, i) => x === this.rxBuf[i]));
          this.phase = this.sel.length ? 'func_cmd' : 'idle';
        }
        break;
      case 'func_cmd':
        if (b === 0x44) { for (const d of sel) d.startConversion(t); this.phase = 'poll'; }
        else if (b === 0xbe) { this.tx = this._andBytes(sel.map((d) => (d.busy(t), d.scratchpad()))); this.txPos = 0; this.phase = 'tx_scratch'; }
        else if (b === 0x4e) { this.phase = 'rx_scratch'; this.rxBuf = []; }
        else if (b === 0x48) { for (const d of sel) d.eeprom = [d.th, d.tl, d.cfg]; this.phase = 'idle'; }
        else if (b === 0xb8) { for (const d of sel) { [d.th, d.tl, d.cfg] = d.eeprom; } this.phase = 'poll'; }
        else if (b === 0xb4) this.phase = 'powersupply';
        else this.phase = 'idle';
        break;
      case 'rx_scratch':
        this.rxBuf.push(b);
        if (this.rxBuf.length === 3) { for (const d of sel) { d.th = this.rxBuf[0]; d.tl = this.rxBuf[1]; d.cfg = this.rxBuf[2] | 0x1f; } this.phase = 'idle'; }
        break;
      default: break;
    }
  }
  _andBytes(lists) {
    if (!lists.length) return [];
    return lists[0].map((_, i) => lists.reduce((a, l) => a & l[i], 0xff));
  }
}

/** shared bus registry: one OneWireBus per line (net) */
export function busFor(sim, net, label) {
  const m = (sim._ow ||= new Map());
  if (!m.has(net)) {
    const bus = new OneWireBus({ resolve: () => sim.resolveNow(), after: (c, f) => sim.after(c, f), now: () => sim.board.cpu.cycles }, label);
    bus.net = net; bus.count = 0; m.set(net, bus);
  }
  return m.get(net);
}
