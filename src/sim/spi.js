// SPI bus: hardware transfers (ATmega328P SPI peripheral, SPI.transfer() of the WebAssembly boards) and bit-banged
// transfers (shiftOut / software-SPI libraries) are both delivered to slave devices one byte at a time.
// A slave is selected while its CS line is LOW. Slaves implement:
//   transfer(byte, dc) -> MISO byte (or undefined = 0xFF)   dc = level of the D/C pin (displays), undefined if none
//   csChange?(low)      called when CS changes (frame boundaries)
export const SPI_DEFAULT = {                                 // hardware SPI pins (SCK, MOSI, MISO) by board kind
  avr: ['13', '11', '12'],
  esp32: [18, 23, 19],
  esp8266: [14, 13, 12],
  rp2040: [18, 19, 16],
  nanorp2040: [13, 11, 12],
};

export class SpiBus {
  constructor(sim) { this.sim = sim; this.slaves = []; this.pins = null; }
  clear() { this.slaves = []; this.pins = null; }
  add(s) { this.slaves.push(s); }
  /** master pin names for hardware SPI (null = board default) */
  setPins(sck, mosi, miso) { this.pins = sck ? { sck, mosi, miso } : null; }
  hwPins() {
    if (this.pins) return this.pins;
    const b = this.sim.board, d = b.mcu?.spiPins || SPI_DEFAULT[b.kind] || SPI_DEFAULT.avr;
    const nm = (x) => (typeof x === 'number' ? b.gpioToName?.[x] : x);
    return { sck: nm(d[0]), mosi: nm(d[1]), miso: nm(d[2]) };
  }
  /** one hardware byte: returns the MISO byte */
  xfer(byte) {
    const p = this.hwPins(), nets = this.sim.ardNets || {};
    const sck = nets[p.sck], mosi = nets[p.mosi];
    let miso = 0xff, any = false;
    for (const s of this.slaves) {
      if (sck === undefined || s.sckNet !== sck || (s.mosiNet >= 0 && s.mosiNet !== mosi)) continue;
      if (!s.selected()) continue;
      any = true;
      const r = s.dev.transfer(byte, s.dc());
      if (r !== undefined && s.misoNet >= 0 && s.misoNet === nets[p.miso]) miso &= r;
    }
    if (!any && this.slaves.length && !this.warned) {
      const wrong = this.slaves.find((s) => s.sckNet !== sck || (s.mosiNet >= 0 && s.mosiNet !== mosi));
      if (wrong) { this.warned = true; this.sim.warn(`spi-pins-${wrong.label}`, `${wrong.label}: jalur SPI belum ke pin SPI hardware (SCK→${p.sck}, MOSI→${p.mosi}, MISO→${p.miso}).`); }
    }
    return miso & 255;
  }
}

/**
 * Connects an SPI slave part to the bus and to bit-banged pins.
 * pins: { sck, mosi, miso, cs, dc } pin names on the part (miso / cs / dc optional)
 */
export function spiSlave(ctx, pins, dev) {
  const sim = ctx.sim, board = () => sim.board;
  const net = (p) => (p ? ctx.n(p) : -1);
  const ard = (p) => (p ? ctx.ardPins(p) : []);
  const s = {
    dev, label: ctx.label,
    sckNet: net(pins.sck), mosiNet: net(pins.mosi), misoNet: net(pins.miso), csNet: net(pins.cs),
    csPins: ard(pins.cs), dcPins: ard(pins.dc),
    selected() {
      if (!pins.cs) return true;
      if (s.csPins.length) return s.csPins.some((p) => board().driveLevel(p) === 0);
      const v = sim.last?.v(s.csNet);
      return v !== null && v !== undefined && v < 0.3;                     // CS tied to GND on the module / breadboard
    },
    dc() {
      if (!pins.dc) return undefined;
      if (s.dcPins.length) return board().driveLevel(s.dcPins[0]) === 0 ? 0 : 1;
      const v = sim.last?.v(net(pins.dc)); return v !== null && v !== undefined && v > 0.5 ? 1 : 0;
    },
  };
  // ---- bit-banged SPI (mode 0, MSB first): sample MOSI on the rising SCK edge
  let bits = 0, acc = 0, out = 0xff, misoBit = 1;
  const mosiPins = ard(pins.mosi);
  const level = (p) => { const l = board().driveLevel(p); return l === null ? (board().isPullup?.(p) ? 1 : 0) : l; };
  for (const p of ard(pins.sck)) {
    board().onEdge(p, (lvl) => {
      if (!s.selected()) return;
      if (lvl === 1) {
        acc = ((acc << 1) | (mosiPins.length ? level(mosiPins[0]) : 1)) & 255;
        if (++bits === 8) { bits = 0; const r = dev.transfer(acc, s.dc()); out = r === undefined ? 0xff : r; acc = 0; }
      } else if (lvl === 0 && s.misoNet >= 0) {
        const nb = (out >> (7 - bits)) & 1;
        if (nb !== misoBit) { misoBit = nb; sim.resolveNow(); }
      }
    });
  }
  for (const p of s.csPins) board().onEdge(p, (lvl) => { bits = 0; acc = 0; dev.csChange?.(lvl === 0); });
  sim.spi.add(s);
  return {
    s,
    // drive MISO only while selected (tri-state otherwise) for bit-banged reads
    misoDriver: () => (s.misoNet >= 0 && pins.cs && s.selected() && mosiPins.length && ard(pins.sck).length ? [{ net: s.misoNet, value: misoBit, label: ctx.label }] : []),
    resetBits() { bits = 0; acc = 0; out = 0xff; misoBit = 1; },
  };
}
