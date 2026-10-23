// ATmega328P (Arduino Uno / Nano) with the standard peripherals, plus pin tracking.
import {
  CPU, avrInstruction, AVRTimer, timer0Config, timer1Config, timer2Config,
  AVRIOPort, portBConfig, portCConfig, portDConfig, PinState,
  AVRUSART, usart0Config, AVRADC, adcConfig, AVRTWI, twiConfig, AVRSPI, spiConfig,
  AVREEPROM, EEPROMMemoryBackend, eepromConfig, AVRClock, clockConfig, AVRWatchdog, watchdogConfig,
} from 'avr8js';
import { parseHex, toProgMem } from './hex.js';

export const CLOCK_HZ = 16_000_000;

// Arduino pin name -> {port:'B'|'C'|'D', bit}
export const PIN_MAP = {};
for (let i = 0; i < 8; i++) PIN_MAP[String(i)] = { port: 'D', bit: i };
for (let i = 8; i <= 13; i++) PIN_MAP[String(i)] = { port: 'B', bit: i - 8 };
for (let i = 0; i < 6; i++) PIN_MAP['A' + i] = { port: 'C', bit: i, adc: i };
PIN_MAP['A6'] = { port: null, bit: -1, adc: 6 };
PIN_MAP['A7'] = { port: null, bit: -1, adc: 7 };

export class AvrBoard {
  constructor() {
    this.hexSize = 0;
    this.pins = {};
    this.edgeListeners = {}; // pinName -> [fn(level, cycles)]
    this.serialListeners = [];
    this.faults = [];
    this.inputResolver = null;
    this._init(new Uint16Array(16384).fill(0xffff));
  }

  _init(prog) {
    this.cpu = new CPU(prog);
    const cpu = this.cpu;
    this.clock = new AVRClock(cpu, CLOCK_HZ, clockConfig);
    this.timers = [new AVRTimer(cpu, timer0Config), new AVRTimer(cpu, timer1Config), new AVRTimer(cpu, timer2Config)];
    this.ports = { B: new AVRIOPort(cpu, portBConfig), C: new AVRIOPort(cpu, portCConfig), D: new AVRIOPort(cpu, portDConfig) };
    this.usart = new AVRUSART(cpu, usart0Config, CLOCK_HZ);
    this.adc = new AVRADC(cpu, adcConfig);
    this.twi = new AVRTWI(cpu, twiConfig, CLOCK_HZ);
    this.spi = new AVRSPI(cpu, spiConfig, CLOCK_HZ);
    this.eeprom = new AVREEPROM(cpu, new EEPROMMemoryBackend(1024), eepromConfig);
    this.watchdog = new AVRWatchdog(cpu, watchdogConfig, this.clock);
    this.watchdogResets = 0;
    cpu.onWatchdogReset = () => { this.watchdogResets++; this.faults.push('Watchdog reset terjadi'); };
    this.usart.onByteTransmit = (b) => this.serialListeners.forEach((f) => f(b));

    // pin tracking
    for (const name of Object.keys(PIN_MAP)) {
      this.pins[name] = { level: null, last: 0, highCycles: 0, rises: 0, lastRise: -1, lastFall: -1, pulse: -1, winStart: 0, duty: null, freq: 0, ext: undefined };
    }
    for (const [pn, port] of Object.entries(this.ports)) {
      port.addListener(() => this._portChanged(pn));
    }
    this.onInit?.();
  }

  // read the level an Arduino pin is *driving*: 1, 0, or null (input / tri-state)
  driveLevel(name) {
    const m = PIN_MAP[name];
    if (!m || !m.port) return null;
    const s = this.ports[m.port].pinState(m.bit);
    return s === PinState.High ? 1 : s === PinState.Low ? 0 : null;
  }
  isPullup(name) {
    const m = PIN_MAP[name];
    return !!(m && m.port && this.ports[m.port].pinState(m.bit) === PinState.InputPullUp);
  }
  setInput(name, high) {
    const m = PIN_MAP[name], p = this.pins[name];
    if (!m || !m.port) return;
    high = !!high;
    if (p.ext === high) return;          // idempotent: only touch the port when the external level changes
    p.ext = high;
    this.ports[m.port].setPin(m.bit, high);
  }

  _portChanged(pn) {
    const now = this.cpu.cycles; let changed = null;
    for (const [name, m] of Object.entries(PIN_MAP)) {
      if (m.port !== pn) continue;
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
    const { bytes, size } = parseHex(text);
    this.hexSize = size;
    this.faults = [];
    const prog = toProgMem(bytes);
    const listeners = this.serialListeners, edge = this.edgeListeners;
    this._init(prog);
    this.serialListeners = listeners; this.edgeListeners = edge;
    this.usart.onByteTransmit = (b) => this.serialListeners.forEach((f) => f(b));
  }

  serialWrite(code) { this.usart.writeByte(code); }

  run(cycles) {
    const cpu = this.cpu, target = cpu.cycles + cycles;
    while (cpu.cycles < target) { avrInstruction(cpu); cpu.tick(); }
    if (this.hexSize && cpu.pc * 2 > this.hexSize + 64 && !this._pcFault) {
      this._pcFault = true;
      this.faults.push(`CPU menjalankan alamat di luar program (PC=0x${(cpu.pc * 2).toString(16)}). Kemungkinan stack overflow / pointer salah.`);
    }
  }
}
