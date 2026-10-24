// UART links between the microcontroller and serial modules (GPS, HC-05, SIM800L, ESP-01 ...).
// Microcontroller -> module: hardware serial bytes (AVR USART on pin 1, ESP32 Serial/Serial1/Serial2/SoftwareSerial ports)
//   are routed by the net of the port's TX pin; bit-banged serial (AVR SoftwareSerial) is decoded from the pin edges.
// Module -> microcontroller: the module drives a real waveform on its TX pin (so SoftwareSerial / pulseIn see it) and
//   the bytes are also handed to a hardware receiver whose RX pin is on that net.
const US = 16;
export const BAUDS = [1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 74880, 115200];

export class UartHub {
  constructor(sim) { this.sim = sim; this.links = []; this.ports = {}; }
  clear() { this.links = []; this.ports = {}; }
  add(l) { this.links.push(l); }
  /** wasm boards: a serial port's pins / baud (port 0 = Serial) */
  setPort(port, rxName, txName, baud) { const p = (this.ports[port] ||= {}); if (rxName !== undefined) p.rx = rxName; if (txName !== undefined) p.tx = txName; if (baud) p.baud = baud; }
  netOf(name) { return name ? this.sim.ardNets?.[name] : undefined; }
  /** bytes written by the microcontroller on a hardware port whose TX pin is `txName` */
  fromMcu(txName, bytes, baud) {
    const net = this.netOf(txName); if (net === undefined) return;
    for (const l of this.links) if (l.rxNet === net) l.receiveBytes(bytes, baud);
  }
}

/**
 * Device side of a UART. pins: { rx, tx } pin names on the module. dev: { onByte(b), baud() }
 * Returns { send(bytes|string), drivers(), level, busy() }
 */
export function uartLink(ctx, pins, dev) {
  const sim = ctx.sim, board = sim.board;
  const rxNet = ctx.n(pins.rx), txNet = ctx.n(pins.tx);
  const T = () => (16e6 / dev.baud());
  let level = 1, q = [], sending = false, gen = 0, warned = false;
  const link = {
    rxNet, txNet, label: ctx.label,
    receiveBytes(bytes, baud) {
      if (baud && dev.baud() && Math.abs(baud - dev.baud()) / dev.baud() > 0.04 && !dev.autoBaud) {
        if (!warned) { warned = true; sim.warn(`baud-${ctx.part.id}`, `${ctx.label}: baud rate tidak cocok — kode memakai ${baud}, modul ${dev.baud()}. Data yang diterima akan rusak; samakan dengan Serial.begin(${dev.baud()}).`); }
        return;
      }
      if (dev.autoBaud && baud) dev.setBaud?.(baud);
      for (const b of bytes) dev.onByte(b);
    },
  };
  sim.uart.add(link);
  // ---- module -> MCU: hardware receivers on the TX net
  const hwTargets = () => {
    const out = [];
    const okBaud = (baud) => {
      if (!baud || dev.autoBaud || Math.abs(baud - dev.baud()) / dev.baud() <= 0.04) return true;
      if (!warned) { warned = true; sim.warn(`baud-${ctx.part.id}`, `${ctx.label}: baud rate tidak cocok — modul mengirim pada ${dev.baud()}, kode membaca pada ${baud}. Data akan rusak; gunakan begin(${dev.baud()}).`); }
      return false;
    };
    if (board.kind === 'avr') board.mcu.usarts.forEach((u, i) => { if (sim.ardNets?.[u.rx] === txNet && okBaud(board.usarts[i].baudRate)) out.push((b) => board.usartWrite(i, b)); });
    else for (const [port, p] of Object.entries(sim.uart.ports)) if (p.rx && sim.ardNets?.[p.rx] === txNet && okBaud(p.baud)) out.push((b) => board.serialIn2?.(+port, b));
    return out;
  };
  const setLevel = (l) => { if (l !== level) { level = l; sim.resolveNow(); } };
  const pump = () => {
    if (!q.length) { sending = false; return; }
    sending = true; const b = q.shift(), t = T(), my = gen;
    setLevel(0);                                                         // start bit
    for (let k = 0; k < 8; k++) sim.after(Math.round((k + 1) * t), () => { if (my === gen) setLevel((b >> k) & 1); });
    sim.after(Math.round(9 * t), () => {
      if (my !== gen) return;
      setLevel(1); for (const f of hwTargets()) f(b);
      for (const l of sim.uart.links) if (l !== link && l.rxNet === txNet && txNet >= 0) l.receiveBytes([b], dev.baud());   // module -> module (e.g. FTDI <-> GPS)
    });
    sim.after(Math.round(10 * t), () => { if (my === gen) pump(); });
  };
  // ---- MCU -> module, bit-banged: decode the waveform on the module's RX pin
  const rxPins = sim.arduinoPinsOnNet(rxNet).filter((p) => !(board.kind === 'avr' && board.mcu.usarts.some((u) => u.tx === p)));
  let edges = [], start = -1;
  const decode = () => {
    const t = T(), at = (time) => { let l = 1; for (const [et, el] of edges) { if (et <= time) l = el; else break; } return l; };
    if (at(start + 0.5 * t)) {                                            // false start bit (glitch, e.g. pinMode before the line idles HIGH)
      const s0 = start; edges = edges.filter(([et]) => et > s0); start = -1;
      const i = edges.findIndex(([, el]) => el === 0);
      if (i >= 0) { edges = edges.slice(i); start = edges[0][0]; schedule(); } else edges = [];
      return;
    }
    let b = 0; for (let k = 0; k < 8; k++) b |= at(start + (k + 1.5) * t) << k;
    const stop = at(start + 9.5 * t);
    edges = edges.filter(([et]) => et > start + 9.5 * t); start = -1;
    if (!stop) { if (!warned && !dev.autoBaud) { warned = true; sim.warn(`baud-${ctx.part.id}`, `${ctx.label}: data serial rusak (framing error). Periksa baud rate: modul memakai ${dev.baud()}.`); } }
    dev.onByte(b);
    if (edges.length && edges[0][1] === 0) { start = edges[0][0]; schedule(); }
  };
  const schedule = () => { const s0 = start; sim.after(Math.max(1, Math.round(start + 9.6 * T() - board.cpu.cycles)), () => { if (start === s0) decode(); }); };
  for (const p of rxPins) {
    board.onEdge(p, (l, t) => {
      const lv = l === 0 ? 0 : 1;
      if (start < 0) { if (lv === 0) { start = t; edges = [[t, 0]]; schedule(); } return; }
      edges.push([t, lv]);
    });
  }
  return {
    link,
    send(data) {
      const bytes = typeof data === 'string' ? [...data].map((c) => c.charCodeAt(0) & 255) : [...data];
      q.push(...bytes); if (!sending) pump();
    },
    drivers: (hi) => [{ net: txNet, value: level ? hi : 0, label: ctx.label }],
    reset() { gen++; q = []; sending = false; level = 1; edges = []; start = -1; warned = false; },
    get level() { return level; },
    busy: () => sending,
  };
}

/** NMEA 0183 sentence with checksum */
export function nmea(body) { let c = 0; for (const ch of body) c ^= ch.charCodeAt(0); return `$${body}*${c.toString(16).toUpperCase().padStart(2, '0')}\r\n`; }
