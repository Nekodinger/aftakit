// Two-wire bit-banged peripherals simulated at pin level: TM1637 (display driver) and HX711 (24-bit load-cell ADC).
const US = 16;

// ------------------------------------------------------------------ TM1637
// Start = DIO falls while CLK is high, stop = DIO rises while CLK is high. Bytes are sent LSB first, one bit per CLK
// rising edge; after the 8th falling CLK edge the chip pulls DIO low (ACK) until the falling edge of the 9th clock.
// Commands: 0x40 auto-increment write / 0x44 fixed address, 0xC0|addr start address (then data bytes),
//           0x80|(on<<3)|brightness display control.
export class TM1637 {
  constructor(io, onChange) {
    this.io = io; this.onChange = onChange; this.reset();
  }
  reset() {
    this.clk = 1; this.dio = 1; this.m = 1; this.drv = false; this.active = false; this.nbits = 0; this.cur = 0; this.ack = false; this.idx = 0;
    this.mem = new Uint8Array(8); this.addr = 0; this.auto = true; this.on = false; this.bright = 0; this.cmdKind = null;
    this.io.dioLow(false);
  }
  _drive(low) { this.drv = low; this.io.dioLow(low); this.dio = low ? 0 : this.m; }
  // lvl = what the microcontroller does with DIO; the line itself is also held low by this chip during its ACK
  edgeDio(lvl) {
    this.m = lvl; const eff = this.drv ? 0 : lvl, old = this.dio; this.dio = eff;
    if (this.clk === 1 && old !== eff) {
      if (eff === 0) { this.active = true; this.nbits = 0; this.cur = 0; this.idx = 0; this.ack = false; this.cmdKind = null; }   // start
      else { this.active = false; this.ack = false; this._drive(false); }                                                      // stop
    }
  }
  edgeClk(lvl) {
    const old = this.clk; this.clk = lvl;
    if (!this.active) return;
    if (lvl === 1 && old === 0) {
      if (!this.ack && this.nbits < 8) { this.cur |= this.dio << this.nbits; this.nbits++; }
    } else if (lvl === 0 && old === 1) {
      if (!this.ack && this.nbits === 8) { this.ack = true; this._byte(this.cur); this._drive(true); }
      else if (this.ack) { this.ack = false; this.nbits = 0; this.cur = 0; this._drive(false); }
    }
  }
  _byte(b) {
    if (this.idx++ === 0) {
      if ((b & 0xc0) === 0x40) { this.cmdKind = 'data'; this.auto = !(b & 4); this.read = (b & 2) !== 0; }
      else if ((b & 0xc0) === 0xc0) { this.cmdKind = 'addr'; this.addr = b & 7; }
      else if ((b & 0xc0) === 0x80) { this.cmdKind = 'ctrl'; this.on = !!(b & 8); this.bright = b & 7; this.onChange(this); }
      return;
    }
    if (this.cmdKind === 'addr') {
      this.mem[this.addr & 7] = b; if (this.auto) this.addr = (this.addr + 1) & 7;
      this.onChange(this);
    }
  }
}

// ------------------------------------------------------------------ HX711
// DT (DOUT) low = a conversion is ready (10 conversions/s). The microcontroller then clocks SCK: 24 rising edges shift
// the result out MSB first, 1..3 more pulses select channel/gain for the next conversion (1 = A x128, 2 = B x32, 3 = A x64);
// DT returns high after the last pulse. SCK held high for >= 60 us powers the chip down; it restarts when SCK goes low.
export class HX711 {
  constructor(io, sample) { this.io = io; this.sample = sample; this.reset(); }
  reset() {
    this.sck = 0; this.ready = false; this.bits = 0; this.word = 0; this.gain = 128; this.tRise = 0; this.dt = 1; this.token = 0; this.tail = false; this.tailCount = 0; this.finTok = 0;
    this._schedule(400);                        // first conversion after power-up settling
    this.io.dt(1);
  }
  _schedule(ms) {
    const my = ++this.token;
    this.dt = 1; this.ready = false; this.io.dt(1);
    this.io.after(ms * 1000 * US, () => {
      if (my !== this.token) return;
      this.word = this.sample(this.gain) & 0xffffff; this.ready = true; this.bits = 0; this.dt = 0; this.io.dt(0);
    });
  }
  edgeSck(lvl, t) {
    if (lvl === this.sck) return;
    this.sck = lvl;
    if (lvl === 1) {
      this.tRise = t; this.finTok++;                              // another pulse is coming: the channel-select train is not over yet
      if (this.tail) { this.tailCount++; return; }
      if (!this.ready) return;
      if (this.bits < 24) { this.dt = (this.word >> (23 - this.bits)) & 1; this.io.dt(this.dt); }
      this.bits++;
    } else {
      const us = (t - this.tRise) / US;
      if (us >= 60) { this.tail = false; this._schedule(400); return; }       // power-down / power-up cycle
      if (this.tail || (this.ready && this.bits >= 25)) {
        if (!this.tail) { this.tail = true; this.tailCount = this.bits - 24; this.ready = false; this.dt = 1; this.io.dt(1); }   // DT goes high after pulse 25
        const my = ++this.finTok;
        this.io.after(30 * US, () => {
          if (my !== this.finTok) return;
          this.tail = false; this.gain = this.tailCount === 1 ? 128 : this.tailCount === 2 ? 32 : 64; this._schedule(100);
        });
      }
    }
  }
}
