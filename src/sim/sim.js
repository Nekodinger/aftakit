// Orchestrator: wires the AVR core, netlist solver, behaviours and the frame loop together.
import { AvrBoard, CLOCK_HZ } from './avr.js';
import { M2560, T85 } from './avrmcu.js';
import { WasmBoard } from './wasmboard.js';
import { NetGateway } from './netgw.js';
import { Circuit } from './circuit.js';
import { BEHAVIORS as B1 } from './behaviors.js';
import { BEHAVIORS2 } from './behaviors2.js';
import { I2C_BEHAVIORS } from './i2cParts.js';
import { BEHAVIORS3 } from './behaviors3.js';
import { BEHAVIORS4 } from './behaviors4.js';
import { BEHAVIORS5 } from './behaviors5.js';
import { BEHAVIORS6 } from './behaviors6.js';
import { I2CBus } from './i2c.js';
import { SpiBus } from './spi.js';
import { UartHub } from './uart.js';
import { softSerialMonitor, attachPinI2C } from './pinbus.js';
import { Audio } from './audio.js';
import { BY_TAG } from '../catalog.js';

const BEHAVIORS = { ...B1, ...BEHAVIORS2, ...BEHAVIORS3, ...BEHAVIORS4, ...BEHAVIORS5, ...BEHAVIORS6, ...I2C_BEHAVIORS, 'mod-jsn-sr04t': B1['wokwi-hc-sr04'] };
// firmware that just idles (rjmp .-2): used when the circuit has no runnable microcontroller
export const IDLE_HEX = ':02000000FFCF30\n:00000001FF\n';

export class Simulator {
  constructor() {
    this.audio = new Audio();
    this.handlers = {};
    this.running = false;
    this.speed = 1;
    this.hexText = null;
    this.behaviors = [];
    this.warned = new Set();
    this.last = null;
    this.circuit = null;
    this.i2c = new I2CBus(this);
    this.spi = new SpiBus(this);
    this.uart = new UartHub(this);
    this.avr = new AvrBoard();
    this.board = this.avr;
    this._bindBoard(this.avr);
    this.btHandlers = [];
  }

  _bindBoard(board) {
    board.serialListeners = board.serialListeners.filter((l) => !l.keep);
    board.serialListeners.push(Object.assign((b) => this.emit('serial', b), { keep: true }));
    if (board.kind !== 'avr') return;
    board.onUsartTx = (i, b) => { if (this.uart.links.length) this.uart.fromMcu(board.mcu.usarts[i].tx, [b], board.usarts[i].baudRate); };   // USARTn TX pin -> serial modules
    const hookSpi = () => { if (board.spi) board.spi.onTransfer = (v) => this.spi.xfer(v); };
    const hookTwi = () => { if (board.twi) this.i2c.attach(board.twi); };
    board.onInit = () => { hookTwi(); hookSpi(); };
    hookTwi(); hookSpi();
    // A pin driven by firmware that shares a net with a closed switch (keypad matrix, button chains) must
    // be re-solved immediately: sketches write a column and read the rows within a few cycles.
    board.afterChange = (names) => {
      if (this._resolving || !this.circuit) return;
      // `fine` parts (stepper motors) must see every step of the driver pins, not one sample per 4 ms slice
      if (!this.fine && !(this.finePins?.size && names.some((n) => this.finePins.has(n))) && (!this.coupled || !this.coupled.size || !names.some((n) => this.ardNets && this.coupled.has(this.ardNets[n])))) return;
      this._resolving = true;
      try { this.resolveNow(); } finally { this._resolving = false; }
    };
    // used by the AVR core the moment firmware reconfigures a pin as input / enables a pull-up
    board.inputResolver = (name) => {
      const net = this.ardNets && this.ardNets[name];
      const pull = board.isPullup(name);
      if (net === undefined || !this.last) return pull;
      const v = this.last.v(net);
      return v === null ? pull : v > 0.5;
    };
  }

  // host services for WebAssembly boards (ESP32 / ESP8266 / RP2040)
  _wasmHost() {
    const sim = this;
    const netOf = (name) => sim.ardNets[name] ?? -1;
    const partsOn = (net) => (net < 0 ? [] : (sim.circuit.members[net] || []).map((m) => { const i = m.indexOf(':'); return { id: m.slice(0, i), pin: m.slice(i + 1) }; }));
    const partById = (id) => sim.model.parts.find((p) => p.id === id);
    const v = (net) => (sim.last && net >= 0 ? sim.last.v(net) : null);
    const powered = (id, vccPins, gndPins) => {
      const vc = vccPins.map((p) => v(sim.circuit.net(id, p))).find((x) => x !== null && x !== undefined);
      const gd = gndPins.map((p) => v(sim.circuit.net(id, p))).find((x) => x !== null && x !== undefined);
      return vc !== undefined && gd !== undefined && vc - gd > 0.5 && gd < 0.25;
    };
    return {
      sim,
      setI2cPins(sda, scl) { sim.i2c.setBus(netOf(sda), netOf(scl)); sim._i2cNames = [sda, scl]; },
      i2cWrite(addr, bytes, stop) { return sim.i2c.txn(addr, bytes, stop); },
      i2cRead(addr, n) { return sim.i2c.rxn(addr, n); },
      setSpiPins(sck, mosi, miso) { sim.spi.setPins(sck, mosi, miso); },
      spiXfer(b) { return sim.spi.xfer(b); },
      serialPort(port, rx, tx, baud) { sim.uart.setPort(port, rx, tx, baud); },
      serialOut(port, bytes) { const p = sim.uart.ports[port]; if (p?.tx && sim.uart.links.length) sim.uart.fromMcu(p.tx, bytes, p.baud); },
      dhtRead(name, type) {
        const hit = partsOn(netOf(name)).find((m) => (partById(m.id)?.type === 'wokwi-dht22' && m.pin === 'SDA') || (partById(m.id)?.type === 'mod-dht11' && m.pin === 'DATA'));
        if (!hit) { sim.warn(`dht-none-${name}`, `DHT: tidak ada sensor DHT yang pin datanya terhubung ke ${name}.`); return null; }
        const p = partById(hit.id);
        if (!powered(p.id, ['VCC'], ['GND'])) { sim.warn(`dht-pw-${p.id}`, `${p.id}: tidak mendapat daya. Hubungkan VCC ke 3V3/5V dan GND ke GND.`); return null; }
        const real = p.type === 'mod-dht11' ? 11 : 22;
        if (type !== real && !(type === 21 && real === 22)) sim.warn(`dht-type-${p.id}`, `${p.id} adalah DHT${real}, tetapi kode memakai DHT${type}. Pembacaan sensor asli akan salah; ubah tipe di kode.`);
        return { t: +(p.attrs?.temperature ?? 28), h: +(p.attrs?.humidity ?? 65) };
      },
      pulseIn(name, state, timeout) {
        const hit = partsOn(netOf(name)).find((m) => ['wokwi-hc-sr04', 'mod-jsn-sr04t'].includes(partById(m.id)?.type) && m.pin === 'ECHO');
        if (!hit) return 0;
        const p = partById(hit.id);
        if (!powered(p.id, ['VCC'], ['GND'])) { sim.warn(`hc-pw-${p.id}`, `${p.id}: tidak mendapat daya (butuh 5 V).`); return 0; }
        const trigNet = sim.circuit.net(p.id, 'TRIG');
        if (!Object.values(sim.ardNets).includes(trigNet)) { sim.warn(`hc-trig-${p.id}`, `${p.id}: pin TRIG belum terhubung ke mikrokontroler.`); return 0; }
        if (!state) return 0;
        const us = Math.max(2, Math.min(450, +(p.attrs?.distance ?? 100))) * 58.2;
        return us > timeout ? 0 : us;
      },
      pushPixels(name, bytes) {
        const net = netOf(name);
        const st = sim.pixelChains.find((c) => sim.circuit.net(c.chain[0]._part.id, 'DIN') === net);
        if (!st) { sim.warn(`px-none-${name}`, `NeoPixel: tidak ada LED NeoPixel yang DIN-nya terhubung ke ${name}.`); return; }
        st.bytes = [...bytes]; sim._flushPixels(st);
      },
      async http(method, url, headers, body, timeout) {
        const hdr = {}; for (const line of headers.split('\n')) { const i = line.indexOf(':'); if (i > 0) hdr[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        const go = async (u) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), Math.max(1000, timeout || 5000)); try { const r = await fetch(u, { method, headers: hdr, body: body && method !== 'GET' ? body : undefined, signal: ac.signal }); return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) }; } finally { clearTimeout(t); } };
        sim.emit('net', { method, url });
        try { return await go(url); }
        catch (e) {
          if (e.name === 'AbortError') { sim.warn('http-timeout:' + url, `HTTP ${method} ${url}: waktu habis.`); return { status: -11, bytes: new Uint8Array(0) }; }
          if (sim.proxyUrl) {
            try {
              const r = await go(sim.proxyUrl + encodeURIComponent(url));
              if (r.status === 403) sim.warn('http-proxy:' + new URL(url).hostname, `HTTP ${url}: situs menolak akses dari browser (CORS) dan tidak ada di daftar proxy simulator.`);
              else if (!(sim._viaProxy ||= new Set()).has(new URL(url).hostname) && sim._viaProxy.add(new URL(url).hostname)) sim.info(`(lewat proxy simulator karena ${new URL(url).hostname} tidak mengizinkan akses langsung dari browser)`);
              return r;
            } catch { /* fall through */ }
          }
          sim.warn('http-fail:' + url, `HTTP ${method} ${url} gagal (tidak ada internet, alamat salah, atau situs menolak akses dari browser/CORS).`);
          return { status: -1, bytes: new Uint8Array(0) };
        }
      },
      get net() { return sim.net; },
      camFrame() { return sim.cameraFrame || null; },   // {bytes: JPEG Uint8Array, w, h} set by the UI (device camera / uploaded photo)
      btBegin(name) { sim.emit('bt', { type: 'begin', name }); },
      btOut(bytes) { sim.emit('bt', { type: 'data', bytes }); },
      nvs(op, key, buf, len) {
        const K = 'sim.nvs.' + key; let store;
        try { store = globalThis.localStorage; } catch { store = null; }
        const mem = (sim._nvs ||= {});
        const get = () => (store ? store.getItem(K) : mem[K] ?? null), set = (x) => (store ? store.setItem(K, x) : (mem[K] = x));
        if (op === 0) { const x = get(); if (x === null) return -1; const b = Uint8Array.from(atob(x), (c) => c.charCodeAt(0)); if (buf && len > 0) buf.set(b.subarray(0, len)); return b.length; }
        if (op === 1) { let s = ''; for (const c of buf.subarray(0, len)) s += String.fromCharCode(c); set(btoa(s)); return len; }
        if (op === 2) { if (store) store.removeItem(K); else delete mem[K]; return 0; }
        if (op === 3) { if (store) for (const k of Object.keys(store)) { if (k.startsWith(K + '/')) store.removeItem(k); } return 0; }
        return -1;
      },
    };
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return () => this.handlers[evt].splice(this.handlers[evt].indexOf(fn), 1); }
  emit(evt, data) { for (const f of this.handlers[evt] || []) f(data); }

  log(level, text) { this.emit('log', { level, text, t: this.board.cpu.cycles / CLOCK_HZ }); }
  info(text) { this.log('info', text); }
  warn(key, text) {
    // without a runnable board, "not connected to an Arduino pin" hints are noise (design / circuit-only mode)
    if (!this.boardPart && /pin Arduino|ke Arduino|langsung ke pin/.test(text)) return;
    if (this.warned.has(key)) return; this.warned.add(key); this.log('warn', text); }
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

    const anyBoard = model.parts.find((p) => BY_TAG[p.type]?.board);
    const boardPart = anyBoard && BY_TAG[anyBoard.type].sim === 'full' ? anyBoard : null;
    this.boardPart = boardPart; this.designBoard = boardPart ? null : anyBoard || null;
    this.i2c.clear(); this.spi.clear(); this.uart.clear();
    // pick the execution engine: AVR emulator, or the WebAssembly Arduino runtime (ESP32 / ESP8266 / RP2040)
    const bcat = boardPart ? BY_TAG[boardPart.type] : null;
    if (bcat?.runtime === 'wasm') {
      this.board = new WasmBoard(bcat.wasm, bcat.gpio, this._wasmHost()); this._bindBoard(this.board);
      this.net = new NetGateway(this.gatewayUrl || '', (lvl, t) => (lvl === 'warn' ? this.warn('gw:' + t, t) : this.info(t)));
    }
    else if (bcat?.board === 'mega') { if (!this.mega) { this.mega = new AvrBoard(M2560); } if (this.board !== this.mega) { this.board = this.mega; this._bindBoard(this.mega); } }
    else if (bcat?.board === 'attiny85') { if (!this.tiny) { this.tiny = new AvrBoard(T85); } if (this.board !== this.tiny) { this.board = this.tiny; this._bindBoard(this.tiny); } }
    else if (this.board !== this.avr) { this.board = this.avr; this._bindBoard(this.avr); }
    const I2C_DEFAULT = { avr: [12, 13], esp32: [21, 22], esp8266: [4, 5], rp2040: [4, 5], nanorp2040: [18, 19] };

    // Arduino pin nets + rails
    this.ardNets = {}; this.rails = [];
    if (boardPart) {
      for (const name of Object.keys(this.board.pinMap)) {
        const n = this.circuit.net(boardPart.id, name);
        if (n >= 0) this.ardNets[name] = n;
      }
    }
    // default I2C pins of the board (Wire.begin(sda, scl) can change them on ESP32/ESP8266/RP2040)
    if (this.board.kind === 'avr') this.i2cDefaultPins = [...this.board.mcu.i2c];
    else { const [sd, sc] = I2C_DEFAULT[this.board.kind]; this.i2cDefaultPins = [this.board.gpioToName[sd], this.board.gpioToName[sc]]; }
    this.i2c.setBus(this.ardNets[this.i2cDefaultPins[0]] ?? -1, this.ardNets[this.i2cDefaultPins[1]] ?? -1);
    this._i2cNames = this.i2cDefaultPins;
    // power rails of whichever board is present (runnable or design-only): powers sensors, LEDs, modules
    if (anyBoard) {
      const el = els.get(anyBoard.id), power = BY_TAG[anyBoard.type].power || {};
      for (const pin of (el?.pinInfo || []).map((x) => x.name)) {
        const base = (/^\d+\.\d+V$/.test(pin) ? pin : pin.split('.')[0]), net = this.circuit.net(anyBoard.id, pin);
        if (base === 'GND' || base === 'AGND') this.rails.push({ net, value: 0, label: `${anyBoard.id} GND`, rail: true });
        else if (power[base]) this.rails.push({ net, value: power[base] / 5, label: `${anyBoard.id} ${base}`, rail: true });
      }
    }

    // behaviours
    this._ow = null; this._air = null; this._ir = null; this.btModules = []; this._hostSvc = null;
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
      const b = factory(ctx); if (!b) continue;
      b._dispose = () => listeners.forEach(([t, e, f]) => t.removeEventListener(e, f));
      b._part = p;
      this.behaviors.push(b);
    }
    for (const b of this.behaviors) b.attach?.();
    this.fine = this.behaviors.some((b) => b.fine);
    this.finePins = new Set(this.behaviors.flatMap((b) => b.finePins?.() || []));   // pins whose every edge must be re-solved (1-Wire, TM1637, HX711 lines)
    this.logicNets = new Set(this.behaviors.flatMap((b) => b.logicPins?.() || []));
    // ATtiny85: Serial is a software UART on PB0, Wire runs on the USI -> decode both at pin level
    this.pinI2C = null;
    if (this.boardPart && this.board.kind === 'avr' && this.board.mcu?.softSerialTx) {
      softSerialMonitor(this, this.board.mcu.softSerialTx, (b) => this.emit('serial', b));
      attachPinI2C(this, ...this.board.mcu.i2c);
    }   // nets that are digital inputs of driver chips
    this._buildPixelChains();

    // pre-flight: floating parts
    for (const p of model.parts) {
      if (BY_TAG[p.type]?.board || BY_TAG[p.type]?.breadboard) continue;
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
    this.net?.dispose(); this.net = null;
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
        const hw = this.board.isHwPwm ? this.board.isHwPwm(name) : true;
        const pwm = st && st.freq > 30 && st.duty !== null && (hw || !this.logicNets?.has(net));   // software toggling into a logic input stays digital
        const vh = this.board.vHigh ?? 1;                       // logic HIGH: 5 V (AVR) or 3.3 V (ESP32 / ESP8266 / RP2040)
        strong.push(pwm ? { net, value: st.duty * vh, peak: vh, label: `pin ${name} (PWM)` } : { net, value: lvl * vh, label: `pin ${name} (${lvl ? 'HIGH' : 'LOW'})` });
      } else if (this.board.isPullup(name)) pullups.push(net);
    }
    if (this.pinI2C) strong.push(...this.pinI2C.drivers());
    for (const b of this.behaviors) {
      if (b.drivers1) strong.push(...b.drivers1());
      if (b.pullups) pullups.push(...b.pullups());
      if (b.switches) switches.push(...b.switches());
      if (b.weak) weak.push(...b.weak());
    }
    this.coupled = new Set(switches.flat());
    const pass1 = this.circuit.solve({ strong, pullups, switches, weak });
    const d2 = [];
    for (const b of this.behaviors) if (b.drivers2) d2.push(...b.drivers2(pass1.v, pass1));
    const fin = this.circuit.solve({ strong: [...strong, ...d2], pullups, switches, weak });
    for (const w of fin.warnings) this.warn('w:' + w.text, w.text);
    for (const b of this.behaviors) b.settle?.(fin.v);   // behaviours that depend on the final solution (stepper motors)
    return fin;
  }

  pushInputs(sol) {
    const th = this.board.inputThreshold ?? 0.5;
    for (const [name, m] of Object.entries(this.board.pinMap)) {
      const net = this.ardNets[name];
      if (m.adc !== undefined && m.adc !== false) {
        const v = net !== undefined ? sol.v(net) : null;
        this.board.setAnalog(name, (v ?? 0) * 5);
      }
      if (!m.port || this.board.driveLevel(name) !== null) continue;
      if (net === undefined) { this.board.setInput(name, this.board.isPullup(name)); continue; }
      const v = sol.v(net);
      this.board.setInput(name, v === null ? this.board.isPullup(name) : v > th);
    }
  }
  i2cPinText() { const [a, b] = this._i2cNames || ['A4', 'A5']; return `SDA→${a} / SCL→${b}`; }

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
  async loadWasm(bytes) {
    this.uart.ports = {};
    await this.board.loadWasm(bytes);
    this.hexText = 'wasm';
    this.warned = new Set();
    for (const b of this.behaviors) b.reset?.();
    this.resolveNow();
  }

  btWrite(text) { if (this.btModules?.length) this.btModules.forEach((f) => f(text)); else this.board.btWrite?.(text); }   // HC-05 modules take the terminal when present

  loadHex(text) {
    this.board.loadHex(text);
    this.hexText = text;
    this.warned = new Set();
    for (const b of this.behaviors) b.reset?.();
    this.lastFaultCount = 0;
    this.resolveNow(); // push sensor levels / ADC values into the freshly reset CPU before the first instruction
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
    b.deadline = performance.now() + 14;   // wall-clock budget for the whole frame (WebAssembly boards)
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
