// Runs an Arduino sketch compiled to WebAssembly (ESP32 / ESP8266 / RP2040 runtime in server/esp32rt) and
// exposes the same interface the Simulator expects from AvrBoard. Time is simulated: delay() suspends the
// sketch (Asyncify) and resumes when simulated time reaches the wake-up point. WiFi is simulated; HTTP requests
// go to the real internet through the browser. Bluetooth Serial talks to a terminal panel in the UI.
const US = 16; // simulator time base: 16 "cycles" per microsecond (same as the 16 MHz AVR)
const ESP32_ADC1 = new Set([32, 33, 34, 35, 36, 37, 38, 39]);
const ESP32_ADC2 = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27]);
const te = new TextEncoder(), td = new TextDecoder();

// default UART pins (RX, TX GPIO) per port: ESP32 UART0/1/2, ESP8266 UART0 / UART1 (TX only), RP2040 Serial1/Serial2
const UART_PINS = { esp32: { 0: [3, 1], 1: [9, 10], 2: [16, 17] }, esp8266: { 0: [3, 1], 1: [-1, 2] }, rp2040: { 1: [1, 0], 2: [5, 4] }, nanorp2040: { 1: [0, 1] } };

export class WasmBoard {
  constructor(kind, gpioMap, host) {
    this.kind = kind; this.host = host; this.vHigh = 3.3 / 5;   // 3.3 V GPIO                 // host: { sim, partsOnNet(net), netOfPin(name), proxyUrl }
    this.gpioToName = {}; this.pinMap = {};
    for (const [name, g] of Object.entries(gpioMap || {})) {
      const gpio = g === 'A0' ? 17 : g;                  // ESP8266 A0 is mapped to pseudo-GPIO 17 by the runtime
      if (typeof gpio !== 'number') continue;
      this.gpioToName[gpio] = name;
      const adc = kind === 'esp32' ? ESP32_ADC1.has(gpio) || ESP32_ADC2.has(gpio) : kind === 'esp8266' ? gpio === 17 : kind === 'nanorp2040' ? gpio >= 14 && gpio <= 21 && gpio !== 18 && gpio !== 19 : gpio >= 26 && gpio <= 28;
      this.pinMap[name] = { gpio, adc, port: gpio !== 17 || kind !== 'esp8266' };
    }
    this.inputThreshold = 0.33;                          // 3.3 V logic: HIGH above ~1.65 V
    this.pins = {}; this.edgeListeners = {}; this.serialListeners = []; this.faults = [];
    this.cpu = { cycles: 0, addClockEvent: (fn, c) => this._addEvent(fn, c) };
    this._reset();
  }

  // ------------------------------------------------------------------ AvrBoard-compatible surface
  get pinNames() { return Object.keys(this.pinMap); }
  _reset() {
    this.events = []; this.cpu.cycles = 0; this.faults = [];
    this.analog = {}; this.mode = {}; this.out = {}; this.ext = {}; this.irq = {}; this.irqCount = {};
    for (const name of Object.keys(this.pinMap)) this.pins[name] = { level: null, last: 0, lastRise: -1, lastFall: -1, pulse: -1, duty: null, freq: 0, servo: false };
    this.serialIn = []; this.portIn = {}; this.btIn = []; this.wifi = { ssid: '', since: -1 }; this.httpResp = new Uint8Array(0);
    this.bootWall = Date.now(); this.state = 'idle'; this.inst = null; this.dirty = false; this.calls = 0; this.fx = 0; this._fxSeen = -1; this.idle = 0;
  }
  driveLevel(name) { const m = this.mode[name]; if (m !== 'out') return null; const p = this.pins[name]; if (p.freq > 0 && p.duty !== null) return p.duty > 0.5 ? 1 : 0; return this.out[name] ? 1 : 0; }
  isPullup(name) { return this.mode[name] === 'pullup'; }
  setInput(name, v) {
    const old = this.ext[name]; this.ext[name] = !!v;
    if (old === undefined || old === !!v) return;
    const g = this.pinMap[name]?.gpio, mode = this.irq[g];
    if (!mode) return;
    if (mode === 3 || (mode === 1 && v) || (mode === 2 && !v) || (mode === 5 && v) || (mode === 4 && !v)) this.irqCount[g] = (this.irqCount[g] || 0) + 1;
  }
  setAnalog(name, volts) { this.analog[name] = volts; }
  onEdge(name, fn) { (this.edgeListeners[name] ||= []).push(fn); }
  clearListeners() { this.edgeListeners = {}; this.serialListeners = this.serialListeners.filter((l) => l.keep); }
  sampleWindow() {}
  serialWrite(b) { this.serialIn.push(b); }
  serialIn2(port, b) { this.fx++; if (port === 0) this.serialIn.push(b); else (this.portIn[port] ||= []).push(b); }
  btWrite(text) { for (const b of te.encode(text)) this.btIn.push(b); }

  // ------------------------------------------------------------------ program loading
  async loadWasm(bytes) {
    this._reset();
    const module = await WebAssembly.compile(bytes);
    const imports = { ard: this._imports(), wasi_snapshot_preview1: this._wasi() };
    // stub any import we do not provide so a sketch never fails to instantiate
    for (const imp of WebAssembly.Module.imports(module)) {
      imports[imp.module] ||= {};
      if (imp.kind === 'function' && !imports[imp.module][imp.name]) imports[imp.module][imp.name] = () => 0;
    }
    if (WebAssembly.Module.imports(module).some((i) => i.name === 'jpeg_decode' || i.name === 'jpeg_encode')) {
      const m = await import('jpeg-js'); this.jpeg = m.default || m;
    }
    this.inst = await WebAssembly.instantiate(module, imports);
    this.ex = this.inst.exports; this.mem = this.ex.memory;
    this.ex._initialize?.();
    this.abuf = this.ex.sim_async_buf(); this.asize = this.ex.sim_async_size();
    this.state = 'ready'; this.next = 'sim_setup'; this.current = null;
  }
  get u8() { return new Uint8Array(this.mem.buffer); }
  _str(ptr) { const m = this.u8; let e = ptr; while (m[e]) e++; return td.decode(m.subarray(ptr, e)); }

  // ------------------------------------------------------------------ asyncify plumbing
  _suspend(kind, extra) {
    const dv = new DataView(this.mem.buffer);
    dv.setInt32(this.abuf, this.abuf + 8, true); dv.setInt32(this.abuf + 4, this.abuf + this.asize, true);
    Object.assign(this, { state: kind }, extra);
    this.ex.asyncify_start_unwind(this.abuf);
  }
  _rewinding() { if (this.ex.asyncify_get_state() === 2) { this.ex.asyncify_stop_rewind(); return true; } return false; }
  _invoke(name) {
    this.current = name;
    try { this.ex[name](); }
    catch (e) { this.state = 'crashed'; this.faults.push(`Program berhenti (crash): ${e.message}. Periksa indeks array, pointer, atau rekursi.`); return; }
    if (this.ex.asyncify_get_state() === 1) { this.ex.asyncify_stop_unwind(); return; } // suspended (state set by _suspend)
    this.current = null; this.state = 'ready'; this.next = 'sim_loop';
  }
  _resume(value) {
    this.resumeValue = value; this.state = 'running';
    this.ex.asyncify_start_rewind(this.abuf);
    this._invoke(this.current);
  }

  // ------------------------------------------------------------------ time
  _addEvent(fn, cycles) { this.events.push({ at: this.cpu.cycles + cycles, fn }); this.events.sort((a, b) => a.at - b.at); }
  _advanceTo(c) {
    while (this.events.length && this.events[0].at <= c) { const e = this.events.shift(); this.cpu.cycles = Math.max(this.cpu.cycles, e.at); e.fn(); }
    if (c > this.cpu.cycles) this.cpu.cycles = c;
    for (const p of Object.values(this.pins)) if (p.servo) p.lastFall = this.cpu.cycles;
  }
  // Sketches that spin without delay() (millis() polling, while-loops waiting for a flag) would crawl if every
  // loop() pass only advanced a few microseconds. While passes have no visible side effects the time step grows
  // (x2 up to 500 us); any pin / serial / bus activity resets it, so timing stays accurate where it matters.
  _step(base) {
    if (this.fx !== this._fxSeen) { this._fxSeen = this.fx; this.idle = base; }
    else this.idle = Math.min(500 * US, Math.max(base, (this.idle || base) * 2));
    return this.idle;
  }
  run(cycles) {
    const end = this.cpu.cycles + cycles, t0 = performance.now(), deadline = this.deadline ?? t0 + 14;
    this.runEnd = end; this.runDeadline = deadline; this.spins = 0;
    this.dirty = true;  // inputs may have changed between slices (UI, sensors): first read re-solves lazily
    let guard = 0;
    while (this.inst && guard++ < 200000) {
      if (this.state === 'sleeping') { if (this.wakeAt > end) break; this._advanceTo(this.wakeAt); this.idle = 0; this._resume(); }
      else if (this.state === 'yielded') { this._advanceTo(Math.min(end, this.cpu.cycles + this._step(25 * US))); if (this.cpu.cycles >= end) break; this._resume(); }
      else if (this.state === 'httpdone') this._resume(this.httpStatus);
      else if (this.state === 'ready') { this._advanceTo(Math.min(end, this.cpu.cycles + this._step(2 * US))); this._invoke(this.next); }
      else break; // 'http' (waiting for the network), 'crashed', 'idle'
      if (this.netStarve) { this.netStarve = false; break; }   // sketch polls a socket with no data yet: wait in real time
      if ((guard & 63) === 0 && performance.now() > deadline) { this.lagging = true; return; }  // keep the page responsive
    }
    this._advanceTo(end);
  }

  // ------------------------------------------------------------------ pins
  _name(gpio) {
    const n = this.gpioToName[gpio];
    if (n === undefined && !this._warnedPin?.[gpio]) { (this._warnedPin ||= {})[gpio] = 1; this.host.sim.warn(`gpio-${gpio}`, `GPIO${gpio} tidak ada di pin header board ini. Periksa nomor pin di kode.`); }
    return n;
  }
  _setLevel(name, lvl) {
    const p = this.pins[name], c = this.cpu.cycles; if (!p) return;
    if (p.level === lvl) return;
    if (p.level !== 1 && lvl === 1) p.lastRise = c;
    if (p.level === 1 && lvl !== 1 && p.lastRise >= 0) { p.pulse = c - p.lastRise; p.lastFall = c; }
    p.level = lvl; p.last = c; this.dirty = true; this.fx++;
    for (const f of this.edgeListeners[name] || []) f(lvl, c);
    const sim = this.host.sim;
    if ((sim.fine || sim.finePins?.has(name)) && !sim._resolving && sim.circuit) { sim._resolving = true; try { sim.resolveNow(); } finally { sim._resolving = false; } }
  }
  _fresh() { if (this.dirty) { this.dirty = false; this.host.sim.resolveNow(); } }

  // ------------------------------------------------------------------ imports
  _imports() {
    const self = this, sim = () => this.host.sim;
    const mv = (name) => Math.round(Math.max(0, Math.min(3.3, this.analog[name] ?? 0)) * 1000);
    return {
      pin_mode(gpio, mode) {
        const n = self._name(gpio); if (!n) return;
        self.mode[n] = mode === 3 || mode === 0x13 ? 'out' : mode === 5 || mode === 4 ? 'pullup' : 'in';
        const p = self.pins[n]; p.freq = 0; p.duty = null;
        self._setLevel(n, self.mode[n] === 'out' ? (self.out[n] ? 1 : 0) : null); self.dirty = true;
      },
      digital_write(gpio, v) {
        const n = self._name(gpio); if (!n) return;
        if (self.mode[n] !== 'out') { self.out[n] = !!v;   // the output latch is written even while the pin is an input (1-Wire: digitalWrite(LOW) then pinMode(OUTPUT))
          if (v && self.mode[n] !== 'pullup') { self.mode[n] = 'pullup'; self.dirty = true; } else if (!v && self.mode[n] === 'pullup') { self.mode[n] = 'in'; self.dirty = true; } return; }
        const p = self.pins[n]; p.freq = 0; p.duty = null; self.out[n] = !!v; self._setLevel(n, v ? 1 : 0);
      },
      digital_read(gpio) {
        const n = self._name(gpio); if (!n) return 0;
        if (self.mode[n] === 'out') return self.out[n] ? 1 : 0;
        self._fresh(); return self.ext[n] ? 1 : 0;
      },
      analog_mv(gpio) {
        const n = self._name(gpio); if (!n) return -1;
        if (!self.pinMap[n].adc) { sim().warn(`adc-${gpio}`, `analogRead(${gpio}): ${n} bukan pin ADC. ${self.kind === 'esp32' ? 'Gunakan GPIO32–39 (ADC1).' : self.kind === 'esp8266' ? 'ESP8266 hanya punya satu pin analog: A0.' : self.kind === 'nanorp2040' ? 'Nano RP2040 Connect: A0–A3, A6, A7 (A4/A5 dipakai I2C).' : 'Pico: GP26, GP27, GP28.'}`); return 0; }
        if (self.kind === 'esp32' && ESP32_ADC2.has(gpio) && self._wifiOn()) { sim().warn(`adc2-${gpio}`, `analogRead(${gpio}) gagal: ADC2 tidak bisa dipakai saat WiFi aktif (sama seperti ESP32 asli). Pindahkan sensor ke GPIO32–39.`); return 0; }
        self._fresh(); return mv(n);
      },
      pwm_write(gpio, duty, freq) {
        const n = self._name(gpio); if (!n) return;
        const p = self.pins[n];
        if (duty < 0) { p.freq = 0; p.duty = null; self.mode[n] = 'in'; self._setLevel(n, null); return; }
        self.mode[n] = 'out'; p.freq = Math.max(31, freq || 1000); p.duty = Math.max(0, Math.min(1, duty)); self.out[n] = p.duty > 0.5;
        self._setLevel(n, p.duty > 0.5 ? 1 : 0); self.dirty = true;
      },
      tone(gpio, freq, durMs) {
        const n = self._name(gpio); if (!n) return; const p = self.pins[n];
        if (!freq) { p.freq = 0; p.duty = null; self.out[n] = false; self._setLevel(n, 0); return; }
        self.mode[n] = 'out'; p.freq = freq; p.duty = 0.5; self._setLevel(n, 1); self.dirty = true;
        if (durMs > 0) { const tok = (p.toneTok = (p.toneTok || 0) + 1); self._addEvent(() => { if (p.toneTok === tok) { p.freq = 0; p.duty = null; self.out[n] = false; self._setLevel(n, 0); } }, durMs * 1000 * US); }
      },
      now_us() { self.calls++; return self.cpu.cycles / US; },
      // called at every function entry and loop header (wasm-opt --log-execution): models CPU time and lets a
      // busy loop with no Arduino calls (e.g. `for(;;);`) be suspended so the browser never freezes
      log_execution() {
        if (self._rewinding()) return;
        self.cpu.cycles += 1;                        // ~60 ns per loop header / call (order of a real ESP32 at 240 MHz)
        if ((++self.spins & 0x3fff) !== 0) return;
        if (self.cpu.cycles >= self.runEnd || performance.now() > self.runDeadline) self._suspend('yielded', {});
      },
      delay_us(us) {
        if (self._rewinding()) return;
        self._suspend('sleeping', { wakeAt: self.cpu.cycles + Math.max(1, us) * US });
      },
      yield_() {
        if (self._rewinding()) return;
        self._suspend('yielded', {});
      },
      serial_begin(port, baud) {
        const d = UART_PINS[self.kind]?.[port] || [-1, -1], cur = self.host.sim.uart.ports[port] || {};
        self.host.serialPort(port, cur.rx ?? (d[0] >= 0 ? self.gpioToName[d[0]] : null), cur.tx ?? (d[1] >= 0 ? self.gpioToName[d[1]] : null), baud);
      },
      serial_pins(port, rx, tx) { self.host.serialPort(port, rx >= 0 ? self._name(rx) : undefined, tx >= 0 ? self._name(tx) : undefined); },
      serial_write(port, ptr, n) {
        self.fx++; const b = self.u8.slice(ptr, ptr + n);
        if (port === 0) for (const x of b) for (const l of self.serialListeners) l(x);   // Serial -> Serial Monitor
        self.host.serialOut(port, b);                                                       // ... and to modules on the port's TX pin
      },
      serial_available(port) { return port === 0 ? self.serialIn.length : (self.portIn[port]?.length || 0); },
      serial_read(port) { const q = port === 0 ? self.serialIn : self.portIn[port]; return q?.length ? q.shift() : -1; },
      i2c_begin(sda, scl) { self.host.setI2cPins(self._name(sda), self._name(scl)); },
      i2c_tx(addr, ptr, n, stop) { self.fx++; self._fresh(); return self.host.i2cWrite(addr, self.u8.slice(ptr, ptr + n), !!stop); },
      ir_read(gpio, ptr) {                                     // IRremote replacement: next decoded NEC frame on this pin
        const n = self._name(gpio); if (!n) return 0;
        const q = self.host.sim._ir?.[self.host.sim.ardNets[n]]; if (!q?.length) return 0;
        const f = q.shift(); new Int32Array(self.mem.buffer, ptr, 3).set([f.addr, f.cmd, f.repeat]); self.fx++; return 1;
      },
      spi_begin(sck, miso, mosi) { self.host.setSpiPins(sck >= 0 ? self._name(sck) : null, mosi >= 0 ? self._name(mosi) : null, miso >= 0 ? self._name(miso) : null); },
      spi_xfer(ptr, n) { self.fx++; self._fresh(); for (let i = 0; i < n; i++) { self.cpu.cycles += US; self.u8[ptr + i] = self.host.spiXfer(self.u8[ptr + i]); } },   // ~1 us per byte (8 MHz SCK)
      i2c_rx(addr, ptr, n) { self._fresh(); const r = self.host.i2cRead(addr, n); self.u8.set(r, ptr); return r.length; },
      dht_read(gpio, type, outPtr) {
        const n = self._name(gpio); if (!n) return 0; self._fresh();
        const r = self.host.dhtRead(n, type); if (!r) return 0;
        const f = new Float32Array(self.mem.buffer, outPtr, 2); f[0] = r.t; f[1] = r.h; return 1;
      },
      pulse_in(gpio, state, timeout) { const n = self._name(gpio); if (!n) return 0; self._fresh(); return self.host.pulseIn(n, state, timeout); },
      servo_write(gpio, us) {
        const n = self._name(gpio); if (!n) return; const p = self.pins[n];
        if (us < 0) { p.servo = false; p.pulse = -1; return; }
        self.mode[n] = 'out'; p.servo = true; p.pulse = us * US; p.lastFall = self.cpu.cycles; self.dirty = true;
      },
      neopixel_show(gpio, ptr, nbytes) { self.fx++; const n = self._name(gpio); if (n) self.host.pushPixels(n, self.u8.slice(ptr, ptr + nbytes)); },
      irq_attach(gpio, mode) { if (mode) self.irq[gpio] = mode; else delete self.irq[gpio]; self.irqCount[gpio] = 0; self._fresh(); },
      irq_poll(ptr, max) {
        const dv = new DataView(self.mem.buffer); let k = 0;
        for (const [g, c] of Object.entries(self.irqCount)) { if (!c || k >= max) continue; dv.setInt32(ptr + k * 8, +g, true); dv.setInt32(ptr + k * 8 + 4, c, true); self.irqCount[g] = 0; k++; }
        return k;
      },
      wifi_begin(ssidPtr, passPtr) {
        const ssid = self._str(ssidPtr);
        self.wifi = { ssid, since: ssid ? self.cpu.cycles : -1 };
        if (ssid) sim().info(`WiFi.begin("${ssid}"): tersambung tersimulasi; internet memakai koneksi perangkat ini.`);
      },
      wifi_status() {
        if (!self.wifi.ssid) return 6;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return 1;
        return self.cpu.cycles - self.wifi.since > 1.2e6 * US ? 3 : 6;  // connects ~1.2 s after begin()
      },
      wifi_info(what, out, cap) {
        const nets = self._nets();
        let s = '';
        if (what === 0) s = self._wifiOn() ? '10.10.0.2' : '0.0.0.0';
        else if (what === 1) s = '10.10.0.1';
        else if (what === 2) s = '24:A1:60:2E:3C:10';
        else if (what === 3) s = String(self._rssi());
        else if (what === 10) s = String(nets.length);
        else if (what >= 100 && what < 200) s = nets[what - 100]?.ssid || '';
        else if (what >= 200) s = String(nets[what - 200]?.rssi ?? 0);
        const b = te.encode(s).slice(0, cap - 1); self.u8.set(b, out); self.u8[out + b.length] = 0; return b.length;
      },
      http(mPtr, uPtr, hPtr, bPtr, blen, timeout) {
        if (self._rewinding()) { return self.resumeValue; }
        const method = self._str(mPtr), url = self._str(uPtr), headers = self._str(hPtr), body = blen ? self.u8.slice(bPtr, bPtr + blen) : null;
        self._suspend('http', {});
        self.host.http(method, url, headers, body, timeout).then(({ status, bytes }) => { self.httpStatus = status; self.httpResp = bytes; if (self.state === 'http') self.state = 'httpdone'; });
        return 0;
      },
      http_resp(ptr, cap) { if (ptr && cap) self.u8.set(self.httpResp.subarray(0, cap), ptr); return self.httpResp.length; },
      // ---- IoT gateway sockets (WiFiClient / WiFiClientSecure / WiFiUDP)
      net_open(hostPtr, port, tls) {
        if (self._rewinding()) return self.resumeValue;
        const host = self._str(hostPtr);
        if (!self._wifiOn()) { sim().warn('net-nowifi', `WiFiClient.connect("${host}"): WiFi belum tersambung. Panggil WiFi.begin() dan tunggu WL_CONNECTED dulu.`); return -1; }
        self._await(self.host.net.open(host, port, !!tls)); return 0;
      },
      net_dns(hostPtr, ipPtr) {
        if (self._rewinding()) { const ip = self.resumeValue; if (!ip) return 0; self.u8.set(ip.split('.').map(Number), ipPtr); return 1; }
        if (!self._wifiOn()) return 0;
        self._await(self.host.net.dns(self._str(hostPtr))); return 0;
      },
      net_avail(sid) { const a = self.host.net.avail(sid); if (a === 0) self.netStarve = true; return a; },
      net_read(sid, ptr, n) { const b = self.host.net.read(sid, n); if (b.length) { self.u8.set(b, ptr); self.fx++; } else self.netStarve = true; return b.length; },
      net_write(sid, ptr, n) { self.fx++; return self.host.net.write(sid, self.u8.slice(ptr, ptr + n)); },
      net_close(sid) { self.host.net.close(sid); },
      udp_send(sid, hostPtr, port, ptr, n) { if (!self._wifiOn()) return -1; self.fx++; return self.host.net.udpSend(sid, self._str(hostPtr), port, self.u8.slice(ptr, ptr + n)); },
      udp_recv(sid, ptr, cap, ipPtr, portPtr) {
        const pk = self.host.net.udpRecv(sid); if (!pk) { self.netStarve = true; return 0; }
        const n = Math.min(cap, pk.data.length); self.u8.set(pk.data.subarray(0, n), ptr);
        self.u8.set((pk.from || '0.0.0.0').split('.').map(Number), ipPtr); new Int32Array(self.mem.buffer, portPtr, 1)[0] = pk.port; self.fx++; return n;
      },
      wall_ms() { return Date.now(); },
      // JPEG <-> RGB for esp32-camera's img_converters (Edge Impulse camera examples); bgr = B,G,R byte order
      jpeg_decode(src, len, out, cap, whPtr, bgr) {
        if (!self.jpeg) { sim().warn('jpeg', 'Dekoder JPEG belum siap.'); return 0; }
        let img; try { img = self.jpeg.decode(self.u8.slice(src, src + len), { useTArray: true, formatAsRGBA: false }); } catch (e) { sim().warn('jpeg-bad', 'fmt2rgb888: JPEG rusak (' + e.message + ')'); return 0; }
        const n = img.width * img.height * 3; if (n > cap) return 0;
        const d = img.data, m = self.u8;
        if (bgr) for (let i = 0; i < n; i += 3) { m[out + i] = d[i + 2]; m[out + i + 1] = d[i + 1]; m[out + i + 2] = d[i]; } else m.set(d.subarray(0, n), out);
        const wh = new Int32Array(self.mem.buffer, whPtr, 2); wh[0] = img.width; wh[1] = img.height; return n;
      },
      jpeg_encode(rgb, w, h, q, bgr, out, cap) {
        if (!self.jpeg) return 0;
        const px = new Uint8Array(w * h * 4), m = self.u8;
        for (let i = 0, j = 0; i < w * h * 3; i += 3, j += 4) { px[j] = m[rgb + i + (bgr ? 2 : 0)]; px[j + 1] = m[rgb + i + 1]; px[j + 2] = m[rgb + i + (bgr ? 0 : 2)]; px[j + 3] = 255; }
        const enc = (self._jpegEnc = cap ? self._jpegEnc : self.jpeg.encode({ data: px, width: w, height: h }, q || 80).data);
        if (cap && enc) m.set(enc.subarray(0, cap), out);
        return enc ? enc.length : 0;
      },
      bt_begin(namePtr) { self.host.btBegin(self._str(namePtr)); },
      bt_write(ptr, n) { self.fx++; self.host.btOut(self.u8.slice(ptr, ptr + n)); },
      bt_available() { return self.btIn.length; },
      bt_read() { return self.btIn.length ? self.btIn.shift() : -1; },
      random32() { return (Math.random() * 2 ** 32) >>> 0; },
      log(level, ptr, n) { const t = td.decode(self.u8.slice(ptr, ptr + n)); level ? sim().warn('rt:' + t, t) : sim().info(t); },
      cam_frame(out, cap, whPtr) {
        const f = self.host.camFrame?.();
        if (!out) { self.fx++; self.host.sim.emit('camera', f || { builtin: true }); }   // one event per esp_camera_fb_get()
        if (!f) return 0;
        if (out && cap >= f.bytes.length) { self.u8.set(f.bytes, out); const wh = new Int32Array(self.mem.buffer, whPtr, 2); wh[0] = f.w; wh[1] = f.h; }
        return f.bytes.length;
      },
      nvs(op, keyPtr, buf, len) { return self.host.nvs(op, self._str(keyPtr), buf ? new Uint8Array(self.mem.buffer, buf, Math.max(0, len)) : null, len); },
    };
  }
  // suspend the sketch until a promise settles (network); time keeps running in real time meanwhile
  _await(promise) {
    this._suspend('http', {});
    Promise.resolve(promise).then((v) => { this.httpStatus = v; if (this.state === 'http') this.state = 'httpdone'; }, () => { this.httpStatus = -1; if (this.state === 'http') this.state = 'httpdone'; });
  }
  _wifiOn() { return this.wifi.ssid && this.cpu.cycles - this.wifi.since > 1.2e6 * US; }
  _rssi() { const dl = typeof navigator !== 'undefined' ? navigator.connection?.downlink : undefined; return dl ? Math.round(Math.max(-85, Math.min(-35, -80 + dl * 2))) : -52; }
  _nets() { const own = this.wifi.ssid ? [{ ssid: this.wifi.ssid, rssi: this._rssi() }] : []; return [...own, { ssid: 'Sekolah-WiFi', rssi: -67 }, { ssid: 'Lab-IoT', rssi: -74 }].filter((x, i, a) => a.findIndex((y) => y.ssid === x.ssid) === i); }
  _wasi() {
    const self = this;
    return {
      fd_write(fd, iovs, n, nwritten) {
        const dv = new DataView(self.mem.buffer); let tot = 0;
        for (let i = 0; i < n; i++) { const p = dv.getUint32(iovs + i * 8, true), l = dv.getUint32(iovs + i * 8 + 4, true); for (const x of self.u8.slice(p, p + l)) for (const s of self.serialListeners) s(x); tot += l; }
        dv.setUint32(nwritten, tot, true); return 0;
      },
      // REALTIME (id 0) = the device's real clock at program start + simulated time (as if NTP had synchronised);
      // MONOTONIC = simulated time since boot
      clock_time_get(id, prec, out) {
        const simNs = BigInt(Math.round(self.cpu.cycles / US * 1000));
        new DataView(self.mem.buffer).setBigUint64(out, id === 0 ? BigInt(self.bootWall) * 1000000n + simNs : simNs, true); return 0;
      },
      proc_exit() { self.state = 'crashed'; self.faults.push('Program memanggil exit().'); throw new Error('exit'); },
      random_get(buf, len) { const a = new Uint8Array(self.mem.buffer, buf, len); for (let i = 0; i < len; i++) a[i] = Math.random() * 256; return 0; },
    };
  }
}
