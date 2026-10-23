// AVR boards (ATmega328P Uno / Nano, ATmega2560 Mega) on avr8js, with pin tracking.
import {
  CPU, avrInstruction, AVRTimer, AVRIOPort, PinState, AVRUSART, AVRADC, AVRTWI, AVRSPI,
  AVREEPROM, EEPROMMemoryBackend, AVRClock, clockConfig, AVRWatchdog, ATtinyTimer1, AVRUSI,
} from 'avr8js';
import { parseHex, toProgMem } from './hex.js';
import { M328P } from './avrmcu.js';

// ATmega328P datasheet 13.2.3: an edge on INT0/INT1 sets INTFn even while the interrupt is masked in EIMSK; the ISR
// runs as soon as the mask is enabled again. avr8js only latches the flag when enabled, which loses interrupts that
// arrive inside SPI transactions (SPI.usingInterrupt() masks INTn: LoRa onReceive, RF24 IRQ, Ethernet...).
const _toggle = AVRIOPort.prototype.toggleInterrupt;
AVRIOPort.prototype.toggleInterrupt = function (pin, rising) {
  const ext = this.externalInts?.[pin], cfg = this.portConfig.externalInterrupts?.[pin];
  if (ext && cfg && !(this.cpu.data[cfg.EIMSK] & (1 << cfg.index))) {
    const mode = (this.cpu.data[cfg.EICR] >> cfg.iscOffset) & 3;              // 1 change, 2 falling, 3 rising (0 = level: not latched)
    if (mode === 1 || (mode === 2 && !rising) || (mode === 3 && rising)) this.cpu.data[ext.flagRegister] |= ext.flagMask;
  }
  return _toggle.call(this, pin, rising);
};

// ATtiny85 Timer1 in PWM mode (PWM1A / PWM1B) counts 0..OCR1C; with COM1x = 2 the OC1x pin is set at BOTTOM and
// cleared at the compare match (3 = inverted). avr8js only drives these pins in its phase-correct path, so ATTinyCore's
// analogWrite() on PB4 (and PB1 via timer 1) produced no output.
const PinOverrideMode = { Set: 2, Clear: 3 };            // avr8js gpio enum (not exported)
const _t1Update = ATtinyTimer1.prototype.timerUpdated;
ATtinyTimer1.prototype.timerUpdated = function (value, prev) {
  _t1Update.call(this, value, prev);
  const port = this.cpu.gpioByPort[this.config.compPortB]; if (!port) return;
  for (const ch of ['A', 'B']) {
    const pwm = ch === 'A' ? this.pwmA : this.pwmB, com = ch === 'A' ? this.comA : this.comB;
    if (!pwm || com < 2) continue;
    const ocr = ch === 'A' ? this.ocrA : this.ocrB, high = (value < ocr) === (com === 2);
    const key = '_pwm' + ch;
    if (this[key] !== high) { this[key] = high; port.timerOverridePin(ch === 'A' ? this.config.compPinA : this.config.compPinB, high ? PinOverrideMode.Set : PinOverrideMode.Clear); }
  }
};

export const CLOCK_HZ = 16_000_000;

// Arduino pin name -> {port, bit, adc?} of the Uno (kept for code that imports it)
export const PIN_MAP = M328P.pinMap;

export class AvrBoard {
  constructor(profile = M328P) {
    this.kind = 'avr'; this.mcu = profile; this.pinMap = profile.pinMap; this.inputThreshold = 0.5;
    this.hexSize = 0;
    this.pins = {};
    this.edgeListeners = {}; // pinName -> [fn(level, cycles)]
    this.serialListeners = [];
    this.faults = [];
    this.inputResolver = null;
    this._init(new Uint16Array(profile.flash / 2).fill(0xffff));
  }

  _init(prog) {
    this.rxQueue = []; this._rxPumping = false; this._uq = {}; this._up = {};
    this._byPort ||= Object.entries(this.pinMap).reduce((o, [n, m]) => { if (m.port) (o[m.port] ||= []).push([n, m]); return o; }, {});
    const m = this.mcu;
    this.cpu = new CPU(prog, m.sram + m.ext);
    const cpu = this.cpu;
    this.clock = new AVRClock(cpu, CLOCK_HZ, m.clock || clockConfig);
    this.timers = m.timers.map((c) => new AVRTimer(cpu, c));
    if (m.attinyTimer1) {
      const t1 = new ATtinyTimer1(cpu, m.attinyTimer1); this.timers.push(t1);
      cpu.data[m.attinyTimer1.OCR1C] = 0xff; t1.ocrC = 0xff;            // datasheet reset value of OCR1C is 0xFF (avr8js starts at 0)
    }
    this.ports = Object.fromEntries(Object.entries(m.ports).map(([k, c]) => [k, new AVRIOPort(cpu, c)]));
    this.usarts = m.usarts.map((u) => new AVRUSART(cpu, u.config, CLOCK_HZ));
    this.usart = this.usarts[0];
    this.adc = new AVRADC(cpu, m.adc);
    this.twi = m.twi ? new AVRTWI(cpu, m.twi, CLOCK_HZ) : null;
    this.spi = m.spi ? new AVRSPI(cpu, m.spi, CLOCK_HZ) : null;
    this.usi = m.usi ? new AVRUSI(cpu, this.ports.B, m.usi.pin, m.usi.data, m.usi.clock) : null;
    this.eeprom = new AVREEPROM(cpu, new EEPROMMemoryBackend(m.eeprom), m.eepromCfg);
    this.watchdog = new AVRWatchdog(cpu, m.wdt, this.clock);
    this.watchdogResets = 0;
    cpu.onWatchdogReset = () => { this.watchdogResets++; this.faults.push('Watchdog reset terjadi'); };
    this._hookUsarts();

    // pin tracking
    for (const name of Object.keys(this.pinMap)) {
      this.pins[name] = { level: null, last: 0, highCycles: 0, rises: 0, lastRise: -1, lastFall: -1, pulse: -1, winStart: 0, duty: null, freq: 0, ext: undefined };
    }
    for (const [pn, port] of Object.entries(this.ports)) {
      port.addListener(() => this._portChanged(pn));
    }
    this.onInit?.();
  }

  // read the level an Arduino pin is *driving*: 1, 0, or null (input / tri-state)
  driveLevel(name) {
    const m = this.pinMap[name];
    if (!m || !m.port) return null;
    const s = this.ports[m.port].pinState(m.bit);
    return s === PinState.High ? 1 : s === PinState.Low ? 0 : null;
  }
  // true while a hardware timer (analogWrite) controls the pin: only then does the duty cycle mean an analogue average.
  // A pin toggled by software at a few hundred Hz (stepper phases, bit-banged buses) is plain digital.
  isHwPwm(name) {
    const A = this.mcu.pwm[name]; if (!A) return false;
    return (Array.isArray(A[0]) ? A : [A]).some(([reg, mask]) => (this.cpu.data[reg] & mask) !== 0);
  }
  isPullup(name) {
    const m = this.pinMap[name];
    return !!(m && m.port && this.ports[m.port].pinState(m.bit) === PinState.InputPullUp);
  }
  setInput(name, high) {
    const m = this.pinMap[name], p = this.pins[name];
    if (!m || !m.port) return;
    high = !!high;
    if (p.ext === high) return;          // idempotent: only touch the port when the external level changes
    p.ext = high;
    this.ports[m.port].setPin(m.bit, high);
  }

  _portChanged(pn) {
    const now = this.cpu.cycles; let changed = null;
    for (const [name, m] of this._byPort[pn] || []) {
      const lvl = this.driveLevel(name);
      const p = this.pins[name];
      // input pin: its external level may depend on PORT (pull-up) even though the drive level stays null
      if (lvl === null && this.inputResolver) this.setInput(name, this.inputResolver(name));
      if (lvl === p.level) continue;
      if (p.level === 1) p.highCycles += now - p.last;
      if (p.level !== 1 && lvl === 1) { p.rises++; p.lastRise = now; }
      if (p.level === 1 && lvl !== 1 && p.lastRise >= 0) { p.pulse = now - p.lastRise; p.lastFall = now; }
      p.level = lvl; p.last = now;
      (changed ||= []).push(name);
      const ls = this.edgeListeners[name];
      if (ls) for (const f of ls) f(lvl, now);
    }
    if (changed && this.afterChange) this.afterChange(changed);
  }

  clearListeners() { this.edgeListeners = {}; this.serialListeners = this.serialListeners.filter((f) => f.keep); }
  onEdge(name, fn) { (this.edgeListeners[name] ||= []).push(fn); }

  // sample duty-cycle / frequency over the window since the last call
  sampleWindow() {
    const now = this.cpu.cycles;
    for (const p of Object.values(this.pins)) {
      const span = now - p.winStart;
      if (span <= 0) continue;
      let hc = p.highCycles + (p.level === 1 ? now - p.last : 0);
      p.duty = hc / span;
      p.freq = p.rises / (span / CLOCK_HZ);
      p.highCycles = 0; p.rises = 0; p.last = now; p.winStart = now;
    }
  }

  loadHex(text) {
    const { bytes, size } = parseHex(text, this.mcu.flash);
    this.hexSize = size;
    this.faults = [];
    const prog = toProgMem(bytes);
    const listeners = this.serialListeners, edge = this.edgeListeners;
    this._init(prog);
    this.serialListeners = listeners; this.edgeListeners = edge;
    this._hookUsarts();
  }

  setAnalog(name, volts) { const m = this.pinMap[name]; if (m && m.adc !== undefined) this.adc.channelValues[m.adc] = volts; }
  // USART0 -> Serial Monitor (+ modules on TX0); USART1..3 (Mega) -> modules on their TX pins
  _hookUsarts() {
    this.usarts.forEach((u, i) => { u.onByteTransmit = (b) => { if (i === 0) this.serialListeners.forEach((f) => f(b)); this.onUsartTx?.(i, b); }; });
  }
  /** feed a byte into USART n (n > 0: Mega Serial1..3), paced like the real receiver */
  usartWrite(n, b) {
    if (n === 0) return this.serialWrite(b);
    const u = this.usarts[n]; if (!u) return;
    const q = ((this._uq ||= {})[n] ||= []); q.push(b & 255);
    const pump = () => { if (!q.length) { this._up[n] = false; return; } const ok = u.writeByte(q[0]); if (ok) q.shift(); this.cpu.addClockEvent(pump, ok ? u.cyclesPerChar + 2 : u.rxEnable ? u.cyclesPerChar : 16000); };
    this._up ||= {}; if (!this._up[n]) { this._up[n] = true; pump(); }
  }
  // bytes for the USART receiver (Serial Monitor input, UART modules on pin 0): queued and fed one frame at a time,
  // because the receiver holds only one incoming character (avr8js refuses a byte while one is in flight)
  serialWrite(code) {
    if (!this.usart) return;                                   // ATtiny85: no USART
    (this.rxQueue ||= []).push(code & 255);
    if (this.rxQueue.length > 4096) this.rxQueue.shift();
    if (!this._rxPumping) this._pumpRx();
  }
  _pumpRx() {
    const q = this.rxQueue, cpu = this.cpu;
    if (!q?.length) { this._rxPumping = false; return; }
    this._rxPumping = true;
    const ok = this.usart.writeByte(q[0]);
    if (ok) q.shift();
    cpu.addClockEvent(() => this._pumpRx(), ok ? this.usart.cyclesPerChar + 2 : this.usart.rxEnable ? this.usart.cyclesPerChar : 16000);
  }

  run(cycles) {
    const cpu = this.cpu, target = cpu.cycles + cycles;
    while (cpu.cycles < target) { avrInstruction(cpu); cpu.tick(); }
    if (this.hexSize && cpu.pc * 2 > this.hexSize + 64 && !this._pcFault) {
      this._pcFault = true;
      this.faults.push(`CPU menjalankan alamat di luar program (PC=0x${(cpu.pc * 2).toString(16)}). Kemungkinan stack overflow / pointer salah.`);
    }
  }
}
