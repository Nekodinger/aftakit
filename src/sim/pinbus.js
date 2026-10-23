// Pin-level buses for microcontrollers without the hardware block (ATtiny85):
//  - a serial monitor fed by decoding the software-UART waveform of a TX pin (automatic baud detection)
//  - an I2C bus driven by the USI (or any bit-banged master): START / STOP / bytes / ACK decoded from SDA + SCL edges;
//    the addressed device pulls SDA low for ACK and for the 0-bits of the bytes it returns.
const BAUDS = [300, 1200, 2400, 4800, 9600, 14400, 19200, 28800, 38400, 57600, 74880, 115200, 230400];

export function softSerialMonitor(sim, pin, onByte) {
  const board = sim.board, CPS = 16e6;
  let edges = [], timer = 0, last = -1, level = 1, baud = 0;
  // baud rate: the lowest standard rate for which every pulse in the burst is (close to) a whole number of bits;
  // start-up glitches are tolerated because they only add a small, equal penalty to every candidate
  const detect = () => {
    const w = []; for (let i = 1; i < edges.length; i++) w.push(edges[i][0] - edges[i - 1][0]);
    if (w.length < 3) return baud || 9600;
    for (const b of BAUDS) {
      const T = CPS / b; let err = 0, n = 0;
      for (const x of w) { const k = x / T; if (k > 12) continue; const r = Math.round(k); err += r < 1 ? 0.25 : (k - r) ** 2; n++; }
      if (n && err / n < 0.03) return b;
    }
    return baud || 9600;
  };
  const flush = () => {
    if (!edges.length) return;
    baud = detect();
    const T = CPS / baud;
    const at = (t) => { let l = 1; for (const [et, el] of edges) { if (et <= t) l = el; else break; } return l; };
    let i = 0;
    while (i < edges.length) {
      if (edges[i][1] !== 0) { i++; continue; }
      const s = edges[i][0]; let b = 0;
      for (let k = 0; k < 8; k++) b |= at(s + (k + 1.5) * T) << k;
      if (at(s + 9.5 * T)) onByte(b);                                   // valid stop bit
      const end = s + 9.5 * T; while (i < edges.length && edges[i][0] < end) i++;
    }
    edges = [];
  };
  board.onEdge(pin, (l, t) => {
    const lv = l === 0 ? 0 : 1;
    if (lv === level) return;
    last = t; level = lv; edges.push([t, lv]);
    const my = ++timer;
    sim.after(Math.round(CPS * 0.004), () => { if (my === timer) flush(); });   // 4 ms of silence ends a burst
  });
}

export class PinI2C {
  // io: { sda(): bool line level, drive(low) pulls SDA low, find(addr) -> device | null }
  constructor(io) { this.io = io; this.reset(); }
  reset() { this.scl = 1; this.sda = 1; this.state = 'idle'; this.bits = 0; this.cur = 0; this.dev = null; this.read = false; this.out = 0; this.drive(false); }
  drive(low) { if (this.low !== low) { this.low = low; this.io.drive(low); } }
  // master levels as seen on the line (1 = released / high)
  edgeSda(v) {
    const old = this.sda; this.sda = v;
    if (this.scl !== 1 || old === v || this.low) return;
    if (v === 0) { this.state = 'addr'; this.bits = 0; this.cur = 0; this.dev?.stop?.(); this.dev = null; }       // (repeated) START
    else { this.dev?.stop?.(); this.dev = null; this.state = 'idle'; this.drive(false); }                          // STOP
  }
  edgeScl(v) {
    const old = this.scl; this.scl = v;
    if (old === v || this.state === 'idle') return;
    if (v === 1) {                                                        // rising: sample
      if (this.state === 'addr' || this.state === 'w') { this.cur = (this.cur << 1) | (this.io.sda() ? 1 : 0); this.bits++; }
      else if (this.state === 'mack') { this.nack = this.io.sda(); }
      return;
    }
    // falling edge: change SDA
    if ((this.state === 'addr' || this.state === 'w') && this.bits === 8) {
      const b = this.cur & 255; this.bits = 0; this.cur = 0;
      let ack = false;
      if (this.state === 'addr') {
        this.read = !!(b & 1); this.dev = this.io.find(b >> 1);
        if (this.dev) { this.dev.begin?.(!this.read); ack = true; }
      } else ack = !!this.dev && this.dev.write(b) !== false;
      this.state = ack ? 'sack' : 'idle'; this.drive(ack);
      return;
    }
    if (this.state === 'sack') {                                          // end of our ACK clock
      if (this.read) { this.state = 'r'; this.out = this.dev.read() & 255; this.bits = 0; this.drive(!((this.out >> 7) & 1)); }
      else { this.state = 'w'; this.drive(false); }
      return;
    }
    if (this.state === 'r') {
      this.bits++;
      if (this.bits < 8) this.drive(!((this.out >> (7 - this.bits)) & 1));
      else { this.drive(false); this.state = 'mack'; }
      return;
    }
    if (this.state === 'mack') {                                          // master ACK -> next byte, NACK -> done
      if (this.nack) { this.state = 'done'; this.drive(false); }
      else { this.state = 'r'; this.out = this.dev.read() & 255; this.bits = 0; this.drive(!((this.out >> 7) & 1)); }
    }
  }
}

/** wire a PinI2C between two microcontroller pins and the simulator's I2C devices */
export function attachPinI2C(sim, sdaPin, sclPin) {
  const board = sim.board, sdaNet = sim.ardNets[sdaPin], sclNet = sim.ardNets[sclPin];
  if (sdaNet === undefined || sclNet === undefined) return null;
  let low = false;
  const bus = new PinI2C({
    sda: () => { const v = sim.last?.v(sdaNet); return v === null || v === undefined ? true : v > 0.5; },
    drive: (l) => { low = l; sim.resolveNow(); },
    find: (addr) => { const d = sim.i2c.devices.find((x) => x.addr === addr && x.nets.sda === sdaNet && x.nets.scl === sclNet); return d && d.dev.ready() ? d.dev : null; },
  });
  const lv = (l) => (l === 0 ? 0 : 1);
  board.onEdge(sdaPin, (l) => bus.edgeSda(low ? 0 : lv(l)));
  board.onEdge(sclPin, (l) => bus.edgeScl(lv(l)));
  sim.pinI2C = { drivers: () => (low ? [{ net: sdaNet, value: 0, label: 'I2C ACK/data' }] : []), bus };
  (sim.finePins ||= new Set()).add(sdaPin).add(sclPin);
  return bus;
}
