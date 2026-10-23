// Orchestrator: wires the AVR core, netlist solver, behaviours and the frame loop together.
import { AvrBoard, PIN_MAP, CLOCK_HZ } from './avr.js';
import { Circuit } from './circuit.js';
import { BEHAVIORS } from './behaviors.js';
import { Audio } from './audio.js';
import { BY_TAG } from '../catalog.js';

export class Simulator {
  constructor() {
    this.board = new AvrBoard();
    this.audio = new Audio();
    this.handlers = {};
    this.running = false;
    this.speed = 1;
    this.hexText = null;
    this.behaviors = [];
    this.warned = new Set();
    this.last = null;
    this.circuit = null;
    this.board.serialListeners.push(Object.assign((b) => this.emit('serial', b), { keep: true }));
    // A pin driven by firmware that shares a net with a closed switch (keypad matrix, button chains) must
    // be re-solved immediately: sketches write a column and read the rows within a few cycles.
    this.board.afterChange = (names) => {
      if (this._resolving || !this.coupled || !this.coupled.size || !this.circuit) return;
      if (!names.some((n) => this.ardNets && this.coupled.has(this.ardNets[n]))) return;
      this._resolving = true;
      try { this.resolveNow(); } finally { this._resolving = false; }
    };
    // used by the AVR core the moment firmware reconfigures a pin as input / enables a pull-up
    this.board.inputResolver = (name) => {
      const net = this.ardNets && this.ardNets[name];
      const pull = this.board.isPullup(name);
      if (net === undefined || !this.last) return pull;
      const v = this.last.v(net);
      return v === null ? pull : v > 0.5;
    };
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return () => this.handlers[evt].splice(this.handlers[evt].indexOf(fn), 1); }
  emit(evt, data) { for (const f of this.handlers[evt] || []) f(data); }

  log(level, text) { this.emit('log', { level, text, t: this.board.cpu.cycles / CLOCK_HZ }); }
  info(text) { this.log('info', text); }
  warn(key, text) { if (this.warned.has(key)) return; this.warned.add(key); this.log('warn', text); }
  error(text) { this.log('error', text); }
  after(cycles, fn) { this.board.cpu.addClockEvent(fn, cycles); }
  circuitStrong(net) { return this.last ? this.last.strong(net) : false; }

  // ------------------------------------------------------------------ build
  /** @returns {{errors:string[], warnings:string[]}} pre-flight diagnostics */
  build(model, els) {
    this.dispose();
    this.model = model; this.els = els;
    this.warned = new Set();
    const diag = { errors: [], warnings: [] };
    const parts = model.parts.map((p) => {
      const el = els.get(p.id);
      return { id: p.id, type: p.type, pins: el && el.pinInfo ? el.pinInfo.map((x) => x.name) : [] };
    });
    this.circuit = new Circuit(parts, model.connections);
    const pf = (text) => { diag.warnings.push(text); this.warn('pf:' + text, text); };
    this.circuit.issues.forEach(pf);

    const boardPart = model.parts.find((p) => BY_TAG[p.type]?.board);
    this.boardPart = boardPart || null;
    if (!boardPart) {
      const anyBoard = model.parts.find((p) => /arduino|esp32|rp2040|franzininho/.test(p.type));
      diag.errors.push(anyBoard
        ? `Board "${BY_TAG[anyBoard.type]?.name || anyBoard.type}" hanya tampilan dan belum bisa disimulasikan. Gunakan Arduino Uno atau Nano (ATmega328P).`
        : 'Belum ada board. Tambahkan Arduino Uno atau Nano dari panel komponen.');
    }

    // Arduino pin nets + rails
    this.ardNets = {}; this.rails = [];
    if (boardPart) {
      for (const name of Object.keys(PIN_MAP)) {
        const n = this.circuit.net(boardPart.id, name);
        if (n >= 0) this.ardNets[name] = n;
      }
      const el = els.get(boardPart.id);
      for (const pin of el.pinInfo.map((x) => x.name)) {
        const base = pin.split('.')[0], net = this.circuit.net(boardPart.id, pin);
        if (base === 'GND') this.rails.push({ net, value: 0, label: 'GND', rail: true });
        else if (base === '5V') this.rails.push({ net, value: 1, label: '5V', rail: true });
        else if (base === '3.3V') this.rails.push({ net, value: 0.66, label: '3.3V', rail: true });
      }
    }

    // behaviours
    this.behaviors = [];
    for (const p of model.parts) {
      const factory = BEHAVIORS[p.type];
      const el = els.get(p.id);
      if (!factory || !el) continue;
      const sim = this, listeners = [];
      const ctx = {
        sim, part: p, el, label: p.id,
        n: (pin) => sim.circuit.net(p.id, pin),
        ardPins: (pin) => sim.arduinoPinsOnNet(sim.circuit.net(p.id, pin)),
        listen: (t, e, f) => { t.addEventListener(e, f); listeners.push([t, e, f]); },
      };
      const b = factory(ctx);
      b._dispose = () => listeners.forEach(([t, e, f]) => t.removeEventListener(e, f));
      b._part = p;
      this.behaviors.push(b);
    }
    for (const b of this.behaviors) b.attach?.();
    this._buildPixelChains();

    // pre-flight: floating parts
    for (const p of model.parts) {
      if (BY_TAG[p.type]?.board) continue;
      const el = els.get(p.id);
      const any = (el?.pinInfo || []).some((x) => this.circuit.isWired(p.id, x.name));
      if (!any && BEHAVIORS[p.type]) pf(`${p.id}: belum ada kabel yang terhubung.`);
      if (BY_TAG[p.type]?.sim === 'visual') pf(`${p.id} (${BY_TAG[p.type].name}) hanya tampilan, tidak ikut disimulasikan.`);
    }
    this.diag = diag;
    this.resolveNow();
    this.renderAll();
    return diag;
  }

  arduinoPinsOnNet(net) {
    if (net < 0) return [];
    return Object.keys(this.ardNets).filter((k) => this.ardNets[k] === net);
  }

  dispose() {
    for (const b of this.behaviors) { b.dispose?.(); b._dispose?.(); }
    this.behaviors = [];
    this.audio.stopAll();
    this.board.clearListeners();
    this.pixelChains = [];
  }

  // ------------------------------------------------------------------ NeoPixel chains
  _buildPixelChains() {
    this.pixelChains = [];
    const px = this.behaviors.filter((b) => b.setPixel);
    if (!px.length) return;
    const dinNet = (b) => this.circuit.net(b._part.id, 'DIN');
    const doutNet = (b) => this.circuit.net(b._part.id, 'DOUT');
    const used = new Set();
    for (const head of px) {
      const pinNames = this.arduinoPinsOnNet(dinNet(head));
      if (!pinNames.length) continue;
      const chain = [head]; used.add(head);
      for (let cur = head; ;) {
        const nxt = px.find((b) => !used.has(b) && dinNet(b) === doutNet(cur));
        if (!nxt) break;
        chain.push(nxt); used.add(nxt); cur = nxt;
      }
      const st = { chain, bytes: [], bit: 0, cur: 0, lastFall: -1 };
      this.pixelChains.push(st);
      const board = this.board;
      board.onEdge(pinNames[0], (lvl, now) => {
        if (lvl === 1) {
          if (st.lastFall >= 0 && now - st.lastFall > 800) { this._flushPixels(st); st.bytes = []; st.bit = 0; st.cur = 0; }
        } else if (lvl === 0 || lvl === null) {
          const w = board.pins[pinNames[0]].pulse;
          if (w > 0) {
            st.cur = (st.cur << 1) | (w > 9 ? 1 : 0); st.bit++;
            if (st.bit === 8) { st.bytes.push(st.cur); st.cur = 0; st.bit = 0; }
          }
          st.lastFall = now;
        }
      });
    }
    for (const b of px) if (!used.has(b)) this.warn(`px-${b._part.id}`, `${b._part.id}: DIN belum terhubung ke pin Arduino atau ke DOUT NeoPixel sebelumnya.`);
  }

  _flushPixels(st) {
    let idx = 0;
    for (const b of st.chain) {
      const n = b.pixelCount();
      for (let k = 0; k < n; k++, idx++) {
        if (idx * 3 + 2 >= st.bytes.length) return;
        const g = st.bytes[idx * 3], r = st.bytes[idx * 3 + 1], bl = st.bytes[idx * 3 + 2];
        b.setPixel(k, r / 255, g / 255, bl / 255);
      }
    }
  }

  // ------------------------------------------------------------------ electrical solve
  solveAll() {
    const strong = [...this.rails], pullups = [], switches = [], weak = [];
    for (const [name, net] of Object.entries(this.ardNets)) {
      const lvl = this.board.driveLevel(name);
      const st = this.board.pins[name];
      if (lvl !== null) {
        const pwm = st && st.freq > 30 && st.duty !== null;
        strong.push({ net, value: pwm ? st.duty : lvl, label: `pin ${name} (${lvl ? 'HIGH' : 'LOW'})` });
      } else if (this.board.isPullup(name)) pullups.push(net);
    }
    for (const b of this.behaviors) {
      if (b.drivers1) strong.push(...b.drivers1());
      if (b.pullups) pullups.push(...b.pullups());
      if (b.switches) switches.push(...b.switches());
      if (b.weak) weak.push(...b.weak());
    }
    this.coupled = new Set(switches.flat());
    const pass1 = this.circuit.solve({ strong, pullups, switches, weak });
    const d2 = [];
    for (const b of this.behaviors) if (b.drivers2) d2.push(...b.drivers2(pass1.v));
    const fin = this.circuit.solve({ strong: [...strong, ...d2], pullups, switches, weak });
    for (const w of fin.warnings) this.warn('w:' + w.text, w.text);
    return fin;
  }

  pushInputs(sol) {
    for (const [name, m] of Object.entries(PIN_MAP)) {
      const net = this.ardNets[name];
      if (m.adc !== undefined) {
        const v = net !== undefined ? sol.v(net) : null;
        this.board.adc.channelValues[m.adc] = (v ?? 0) * 5;
      }
      if (!m.port || this.board.driveLevel(name) !== null) continue;
      if (net === undefined) { this.board.setInput(name, this.board.isPullup(name)); continue; }
      const v = sol.v(net);
      this.board.setInput(name, v === null ? this.board.isPullup(name) : v > 0.5);
    }
  }

  resolveNow() {
    if (!this.circuit) return;
    this.last = this.solveAll();
    this.pushInputs(this.last);
  }

  renderAll() {
    const sol = this.last;
    if (!sol) return;
    for (const b of this.behaviors) { try { b.render?.(sol.v); } catch (e) { this.warn('render:' + b._part.id, `${b._part.id}: ${e.message}`); } }
  }

  // ------------------------------------------------------------------ control
  loadHex(text) {
    this.board.loadHex(text);
    this.hexText = text;
    this.warned = new Set();
    for (const b of this.behaviors) b.reset?.();
    this.lastFaultCount = 0;
  }
  get hasProgram() { return !!this.hexText; }

  start() {
    if (this.running) return;
    if (!this.hexText) throw new Error('Belum ada program. Tekan Kompilasi atau pilih contoh dulu.');
    this.audio.unlock();
    this.running = true; this.lastT = null;
    this.emit('state', 'running');
    const loop = (t) => {
      if (!this.running) return;
      if (this.lastT !== null) this.frame(Math.min(t - this.lastT, 50));
      this.lastT = t;
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.audio.stopAll();
    this.emit('state', 'stopped');
  }

  // run a fixed amount of simulated time (also used by tests and headless runs)
  advance(ms) {
    this.frame(ms);
  }

  frame(dtMs) {
    const b = this.board;
    const slices = Math.max(1, Math.ceil(dtMs / 4));
    for (let i = 0; i < slices; i++) {
      b.run((dtMs / slices) * (CLOCK_HZ / 1000) * this.speed);
      this.resolveNow();
    }
    b.sampleWindow();
    const t = b.cpu.cycles;
    for (const st of this.pixelChains) if (st.bytes.length && st.lastFall >= 0 && t - st.lastFall > 1000) { this._flushPixels(st); st.bytes = []; st.bit = 0; st.cur = 0; }
    this.resolveNow();
    this.renderAll();
    while (b.faults.length) this.error(b.faults.shift());
    this.emit('tick', { time: t / CLOCK_HZ });
  }

  serialWrite(str) { for (const ch of str) this.board.serialWrite(ch.charCodeAt(0)); }
}
