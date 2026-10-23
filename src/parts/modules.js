// Generic module parts (sensor boards, MCU boards, actuators...) drawn from a declarative spec.
// Each spec becomes a custom element <mod-xxx> that exposes `pinInfo` like Wokwi elements, so the
// canvas, the net solver and the behaviours treat them exactly like the built-in Wokwi parts.
const P = 9.6; // 0.1 inch header pitch at 96 dpi (same as Wokwi elements)

// pin entry: "NAME" or "NAME|Label shown on silkscreen"
const parsePin = (s) => { const [name, label] = s.split('|'); return { name, label: label ?? name.split('.')[0] }; };

function layout(spec) {
  const { w, h } = spec; const pins = []; const sides = spec.pins || {};
  const place = (arr, side) => {
    if (!arr?.length) return;
    const n = arr.length, along = side === 'l' || side === 'r' ? h : w;
    const start = spec.start?.[side] ?? (along - (n - 1) * P) / 2;
    arr.forEach((s, i) => {
      const { name, label } = parsePin(s); const t = start + i * P;
      const x = side === 'l' ? 5 : side === 'r' ? w - 5 : t;
      const y = side === 't' ? 5 : side === 'b' ? h - 5 : t;
      pins.push({ name, label, x: +x.toFixed(2), y: +y.toFixed(2), side, signals: [], description: spec.pinDesc?.[name] || '' });
    });
  };
  place(sides.l, 'l'); place(sides.r, 'r'); place(sides.t, 't'); place(sides.b, 'b');
  return pins;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function decoSvg(d) {
  const f = d.fill ?? 'none', st = d.stroke ? ` stroke="${d.stroke}" stroke-width="${d.sw ?? 1}"` : '';
  switch (d.t) {
    case 'rect': return `<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="${d.rx ?? 1}" fill="${f}"${st}/>`;
    case 'circle': return `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${f}"${st}/>`;
    case 'path': return `<path d="${d.d}" fill="${f}"${st}/>`;
    case 'text': return `<text x="${d.x}" y="${d.y}" font-size="${d.size ?? 7}" fill="${d.fill ?? '#fff'}" text-anchor="${d.anchor ?? 'middle'}" font-weight="${d.bold ? 700 : 500}" font-family="Arial,Helvetica,sans-serif">${esc(d.text)}</text>`;
    case 'led': return `<circle data-led="${d.key}" cx="${d.x}" cy="${d.y}" r="${d.r ?? 2.6}" fill="#3a2a2a" data-on="${d.color ?? '#ff3b30'}" stroke="#0006" stroke-width=".6"/>`;
    case 'rotor': return `<g data-rotor transform-origin="${d.x} ${d.y}"><circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${d.fill ?? '#c9ced6'}" stroke="#555" stroke-width="1"/>`
      + `<rect x="${d.x - d.r * 0.9}" y="${d.y - 2}" width="${d.r * 1.8}" height="4" rx="2" fill="#555"/><rect x="${d.x - 2}" y="${d.y - d.r * 0.9}" width="4" height="${d.r * 1.8}" rx="2" fill="#777"/>`
      + `<circle cx="${d.x}" cy="${d.y}" r="3" fill="#333"/></g>`;
    case 'pad': return `<circle data-pad cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${f}" stroke="#d9c27a" stroke-width="1.5" style="cursor:pointer"/>`;
    case 'grid': { // vent / mesh pattern
      let s = ''; for (let yy = d.y; yy < d.y + d.h; yy += d.step) for (let xx = d.x; xx < d.x + d.w; xx += d.step) s += `<rect x="${xx}" y="${yy}" width="${d.step * 0.6}" height="${d.step * 0.6}" fill="${d.fill}"/>`;
      return s;
    }
    default: return '';
  }
}

export function defineModule(spec) {
  if (customElements.get(spec.tag)) return;
  const pinInfo = layout(spec);
  class ModuleElement extends HTMLElement {
    static spec = spec;
    constructor() {
      super(); this._angle = 0; this._leds = {}; this.attachShadow({ mode: 'open' });
      const { w, h } = spec;
      const pinsSvg = pinInfo.map((p) => {
        const hz = p.side === 'l' || p.side === 'r';
        const lx = p.side === 'l' ? p.x + 6 : p.side === 'r' ? p.x - 6 : p.x;
        const ly = p.side === 't' ? p.y + 11 : p.side === 'b' ? p.y - 7 : p.y + 2.2;
        const anchor = p.side === 'l' ? 'start' : p.side === 'r' ? 'end' : 'middle';
        const rot = !hz && spec.vlabels ? ` transform="rotate(-90 ${lx} ${ly})"` : '';
        return `<rect x="${p.x - 2.6}" y="${p.y - 2.6}" width="5.2" height="5.2" fill="#d4af37" stroke="#7a6320" stroke-width=".5"/>`
          + (spec.nolabels ? '' : `<text x="${lx}" y="${ly}" font-size="${spec.pinFont ?? 5.6}" fill="${spec.labelColor ?? '#fff'}" text-anchor="${anchor}" font-family="Arial,Helvetica,sans-serif"${rot}>${esc(p.label)}</text>`);
      }).join('');
      const body = spec.body === false ? '' : `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${spec.rx ?? 4}" fill="${spec.color ?? '#1b4f9c'}" stroke="#0005"/>`;
      const label = spec.label === false ? '' : `<text x="${spec.lx ?? w / 2}" y="${spec.ly ?? h / 2 + 3}" font-size="${spec.lsize ?? 8}" fill="${spec.lcolor ?? '#fff'}" text-anchor="middle" font-weight="700" font-family="Arial,Helvetica,sans-serif">${esc(spec.label ?? spec.name)}</text>`;
      const screen = spec.screen ? `<canvas width="${spec.screen.cols}" height="${spec.screen.rows}" style="position:absolute;left:${spec.screen.x}px;top:${spec.screen.y}px;width:${spec.screen.w}px;height:${spec.screen.h}px;image-rendering:pixelated;background:#000"></canvas>` : '';
      this.shadowRoot.innerHTML = `<style>:host{display:inline-block;position:relative;width:${w}px;height:${h}px;line-height:0}svg{display:block;overflow:visible}[data-rotor]{transition:none}</style>`
        + `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${body}${(spec.deco || []).map(decoSvg).join('')}${label}${pinsSvg}</svg>${screen}`;
      this._rotor = this.shadowRoot.querySelector('[data-rotor]');
      this._canvas = this.shadowRoot.querySelector('canvas');
      for (const pad of this.shadowRoot.querySelectorAll('[data-pad]')) {
        const down = (e) => { e.stopPropagation(); pad.setAttribute('fill', '#f3d77a'); this.dispatchEvent(new Event('button-press')); };
        const up = () => { pad.setAttribute('fill', spec.deco.find((d) => d.t === 'pad').fill); this.dispatchEvent(new Event('button-release')); };
        pad.addEventListener('pointerdown', down); pad.addEventListener('pointerup', up); pad.addEventListener('pointerleave', up); pad.addEventListener('pointercancel', up);
      }
    }
    get pinInfo() { return pinInfo; }
    get updateComplete() { return Promise.resolve(true); }
    get spec() { return spec; }
    setLed(key, on) {
      if (this._leds[key] === on) return; this._leds[key] = on;
      for (const c of this.shadowRoot.querySelectorAll(`[data-led="${key}"]`)) c.setAttribute('fill', on ? c.dataset.on : '#3a2a2a');
    }
    set angle(a) { this._angle = a; if (this._rotor) this._rotor.setAttribute('transform', `rotate(${a})`); }
    get angle() { return this._angle; }
    // 1-bit framebuffer (Uint8Array cols*rows of 0/1) -> canvas
    drawFrame(bits, color = [140, 220, 255]) {
      if (!this._canvas) return; const { cols, rows } = spec.screen; const ctx = this._canvas.getContext('2d');
      const img = ctx.createImageData(cols, rows);
      for (let i = 0; i < cols * rows; i++) { const o = i * 4; const on = bits[i]; img.data[o] = on ? color[0] : 0; img.data[o + 1] = on ? color[1] : 0; img.data[o + 2] = on ? color[2] : 0; img.data[o + 3] = 255; }
      ctx.putImageData(img, 0, 0);
    }
    setText(sel, text) { const t = this.shadowRoot.querySelector(`[data-text="${sel}"]`); if (t) t.textContent = text; }
  }
  customElements.define(spec.tag, ModuleElement);
}

// ------------------------------------------------------------------ specs
const blue = '#1b4f9c', red = '#b3262e', black = '#222831', green = '#1f7a45', purple = '#5b2a86';
const mesh = (x, y, w, h) => ({ t: 'grid', x, y, w, h, step: 4, fill: '#9aa4b1' });
const chip = (x, y, w, h, text = '') => [{ t: 'rect', x, y, w, h, fill: '#111', rx: 1 }, ...(text ? [{ t: 'text', x: x + w / 2, y: y + h / 2 + 2.5, text, size: 6, fill: '#bbb' }] : [])];
const pwr = (x, y) => ({ t: 'led', key: 'pwr', x, y, color: '#ff3b30' });
const sig = (x, y, c = '#33d17a') => ({ t: 'led', key: 'sig', x, y, color: c });

export const MODULE_SPECS = [
  // ===================== Microcontrollers (design + wiring check; code is not executed)
  { tag: 'mod-esp32-cam', name: 'ESP32-CAM (AI-Thinker)', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'esp32', board: 'esp32', mcu: 'ESP32', w: 104, h: 156, color: '#202b3d',
    pins: { l: ['5V', 'GND', 'IO12', 'IO13', 'IO15', 'IO14', 'IO2', 'IO4'], r: ['3V3', 'IO16', 'IO0', 'GND.2|GND', 'VCC|VCC out', 'U0R', 'U0T', 'GND.3|GND'] }, start: { l: 74, r: 74 },
    deco: [{ t: 'rect', x: 10, y: 4, w: 84, h: 14, fill: '#c9a227', rx: 1 }, { t: 'rect', x: 30, y: 22, w: 44, h: 40, fill: '#9aa3ad', rx: 2 }, { t: 'circle', x: 52, y: 42, r: 13, fill: '#1a1a1a', stroke: '#555', sw: 2 }, { t: 'circle', x: 52, y: 42, r: 5, fill: '#2b4d7a' },
      { t: 'circle', x: 21, y: 134, r: 4, fill: '#fff7d6', stroke: '#aaa' }, { t: 'text', x: 21, y: 147, text: 'FLASH', size: 5 }], label: 'ESP32-CAM', ly: 70, lsize: 7,
    gpio: { IO12: 12, IO13: 13, IO15: 15, IO14: 14, IO2: 2, IO4: 4, IO16: 16, IO0: 0, U0R: 3, U0T: 1 }, keywords: 'esp32 cam kamera camera ov2640 ai thinker edge impulse', power: { '5V': 5, '3V3': 3.3, VCC: 3.3 } },
  { tag: 'mod-nodemcu', name: 'NodeMCU ESP8266 (v3)', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'esp8266', board: 'esp8266', mcu: 'ESP8266', w: 118, h: 214, color: '#1e1e1e',
    pins: { l: ['A0', 'RSV', 'RSV.2|RSV', 'SD3', 'SD2', 'SD1', 'CMD', 'SD0', 'CLK', 'GND', '3V3', 'EN', 'RST', 'GND.2|GND', 'VIN'], r: ['D0', 'D1', 'D2', 'D3', 'D4', '3V3.2|3V3', 'GND.3|GND', 'D5', 'D6', 'D7', 'D8', 'RX', 'TX', 'GND.4|GND', '3V3.3|3V3'] },
    deco: [{ t: 'rect', x: 28, y: 6, w: 62, h: 56, fill: '#a7adb6', rx: 2 }, { t: 'text', x: 59, y: 38, text: 'ESP-12E', size: 8, fill: '#333' }, { t: 'rect', x: 44, y: 196, w: 30, h: 16, fill: '#c0c4c9', rx: 2 }], label: 'NodeMCU', ly: 110,
    gpio: { D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15, RX: 3, TX: 1, A0: 'A0', SD3: 10, SD2: 9 }, keywords: 'esp8266 wifi nodemcu lolin iot', power: { VIN: 5, '3V3': 3.3 } },
  { tag: 'mod-d1mini', name: 'Wemos D1 Mini (ESP8266)', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'esp8266', board: 'esp8266', mcu: 'ESP8266', w: 100, h: 118, color: '#2864b4',
    pins: { l: ['RST', 'A0', 'D0', 'D5', 'D6', 'D7', 'D8', '3V3'], r: ['TX', 'RX', 'D1', 'D2', 'D3', 'D4', 'GND', '5V'] },
    deco: [{ t: 'rect', x: 26, y: 6, w: 48, h: 40, fill: '#a7adb6', rx: 2 }], label: 'D1 mini', ly: 70,
    gpio: { D0: 16, D1: 5, D2: 4, D3: 0, D4: 2, D5: 14, D6: 12, D7: 13, D8: 15, RX: 3, TX: 1, A0: 'A0' }, keywords: 'esp8266 wemos d1 mini wifi', power: { '5V': 5, '3V3': 3.3 } },
  { tag: 'mod-pico', name: 'Raspberry Pi Pico', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'rp2040', board: 'rp2040', mcu: 'RP2040', w: 90, h: 206, color: '#1d7a3a',
    pins: { l: ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND.2|GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND.3|GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND.4|GND', 'GP14', 'GP15'],
      r: ['VBUS', 'VSYS', 'GND.5|GND', '3V3_EN', '3V3', 'ADC_VREF', 'GP28', 'AGND', 'GP27', 'GP26', 'RUN', 'GP22', 'GND.6|GND', 'GP21', 'GP20', 'GP19', 'GP18', 'GND.7|GND', 'GP17', 'GP16'] },
    deco: [...chip(30, 86, 30, 30, 'RP2040'), { t: 'rect', x: 33, y: 0, w: 24, h: 12, fill: '#c0c4c9', rx: 1 }], label: 'Pico', ly: 140, pinFont: 5,
    gpio: Object.fromEntries([...Array(29).keys()].map((i) => ['GP' + i, i])), keywords: 'rp2040 raspberry pi pico micropython', power: { VBUS: 5, '3V3': 3.3 } },

  // ===================== Sensors
  { tag: 'mod-dht11', name: 'DHT11 (modul 3 pin)', cat: 'Sensor', sim: 'full', w: 52, h: 84, color: blue, pins: { b: ['VCC|+', 'DATA|OUT', 'GND|-'] },
    deco: [{ t: 'rect', x: 8, y: 6, w: 36, h: 46, fill: '#3d8fd6', rx: 3 }, mesh(12, 10, 30, 38)], label: 'DHT11', ly: 62, lsize: 7, outs: ['DATA'], keywords: 'suhu kelembapan temperature humidity', logic: 'vcc',
    props: [{ key: 'temperature', label: 'Suhu', type: 'range', min: 0, max: 50, step: 1, def: 28, unit: ' °C' }, { key: 'humidity', label: 'Kelembapan', type: 'range', min: 20, max: 90, step: 1, def: 65, unit: ' %' }] },
  { tag: 'mod-ds18b20', name: 'DS18B20 (probe tahan air)', cat: 'Sensor', sim: 'visual', w: 44, h: 96, color: black, pins: { b: ['GND|GND', 'DQ|DATA', 'VDD|VDD'] },
    deco: [{ t: 'rect', x: 14, y: 4, w: 16, h: 50, fill: '#c0c4c9', rx: 7 }], label: 'DS18B20', ly: 68, lsize: 6, outs: ['DQ'], keywords: 'suhu temperature onewire 1-wire probe' },
  { tag: 'mod-bmp280', name: 'BMP280 (tekanan udara, I2C)', cat: 'Sensor', sim: 'visual', w: 70, h: 54, color: purple, pins: { t: ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO'] },
    deco: [...chip(28, 26, 14, 12)], label: 'BMP280', ly: 48, lsize: 6, keywords: 'tekanan pressure altitude barometer i2c' },
  { tag: 'mod-bme280', name: 'BME280 (suhu, RH, tekanan)', cat: 'Sensor', sim: 'visual', w: 56, h: 54, color: purple, pins: { t: ['VIN', 'GND', 'SCL', 'SDA'] }, deco: [...chip(21, 26, 14, 12)], label: 'BME280', ly: 48, lsize: 6, keywords: 'humidity pressure i2c' },
  { tag: 'mod-soil', name: 'Sensor Kelembapan Tanah (resistif)', cat: 'Sensor', sim: 'full', w: 64, h: 150, color: blue, pins: { t: ['VCC', 'GND', 'DO', 'AO'] },
    deco: [pwr(14, 30), sig(50, 30), { t: 'rect', x: 22, y: 22, w: 20, h: 14, fill: '#2a6fd0', rx: 2 }, { t: 'path', d: 'M12 52 h16 v86 l-8 10 l-8 -10z M36 52 h16 v86 l-8 10 l-8 -10z', fill: '#c6a144' }],
    label: 'SOIL', ly: 47, lsize: 7, outs: ['AO', 'DO'], logic: 'vcc', keywords: 'soil moisture tanah kelembapan tanaman irigasi',
    props: [{ key: 'level', label: 'Kelembapan tanah', type: 'range', min: 0, max: 100, step: 1, def: 30, unit: ' %' }, { key: 'threshold', label: 'Ambang DO', type: 'range', min: 0, max: 100, step: 1, def: 50, unit: ' %' }] },
  { tag: 'mod-soil-cap', name: 'Sensor Tanah Kapasitif v1.2', cat: 'Sensor', sim: 'full', w: 46, h: 160, color: black, pins: { t: ['GND', 'VCC', 'AOUT'] },
    deco: [...chip(14, 20, 18, 12, '555'), { t: 'path', d: 'M4 60 h38 v84 l-19 14 l-19 -14z', fill: '#2c3440' }, { t: 'text', x: 23, y: 120, text: 'Capacitive', size: 5 }], label: 'v1.2', ly: 48, lsize: 6, outs: ['AOUT'], logic: 'vcc',
    keywords: 'soil moisture capacitive kapasitif tanah', props: [{ key: 'level', label: 'Kelembapan tanah', type: 'range', min: 0, max: 100, step: 1, def: 30, unit: ' %' }] },
  { tag: 'mod-water-level', name: 'Sensor Ketinggian Air', cat: 'Sensor', sim: 'full', w: 54, h: 160, color: red, pins: { t: ['S', '+', '-'] },
    deco: [...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ t: 'rect', x: 8, y: 44 + i * 10, w: 38, h: 3, fill: '#d9c27a', rx: 0 })), pwr(27, 24)], label: 'WATER', ly: 36, lsize: 6, outs: ['S'], logic: 'vcc',
    keywords: 'water level ketinggian air banjir tangki flood', props: [{ key: 'level', label: 'Ketinggian air', type: 'range', min: 0, max: 100, step: 1, def: 40, unit: ' %' }] },
  { tag: 'mod-rain', name: 'Sensor Hujan (panel + modul)', cat: 'Sensor', sim: 'full', w: 80, h: 118, color: blue, pins: { t: ['VCC', 'GND', 'DO', 'AO'] },
    deco: [pwr(18, 28), sig(62, 28), { t: 'rect', x: 8, y: 50, w: 64, h: 62, fill: '#1c3f80', rx: 2 }, ...[0, 1, 2, 3, 4, 5].map((i) => ({ t: 'rect', x: 12, y: 54 + i * 10, w: 56, h: 3, fill: '#d9c27a', rx: 0 }))],
    label: 'RAIN', ly: 44, lsize: 7, outs: ['AO', 'DO'], logic: 'vcc', keywords: 'rain hujan raindrop cuaca',
    props: [{ key: 'level', label: 'Intensitas hujan', type: 'range', min: 0, max: 100, step: 1, def: 0, unit: ' %' }, { key: 'threshold', label: 'Ambang DO', type: 'range', min: 0, max: 100, step: 1, def: 40, unit: ' %' }] },
  { tag: 'mod-ir-obstacle', name: 'Sensor Halangan IR (FC-51)', cat: 'Sensor', sim: 'full', w: 96, h: 40, color: blue, pins: { l: ['OUT', 'GND', 'VCC'] },
    deco: [{ t: 'circle', x: 84, y: 12, r: 5, fill: '#1c1c1c' }, { t: 'circle', x: 84, y: 28, r: 5, fill: '#e8e8f0' }, pwr(40, 10), sig(40, 30)], label: 'IR', lx: 58, lsize: 7, outs: ['OUT'], logic: 'vcc',
    keywords: 'infrared obstacle halangan ir proximity robot', props: [{ key: 'obstacle', label: 'Ada halangan', type: 'bool', def: false }] },
  { tag: 'mod-tcrt5000', name: 'Sensor Garis TCRT5000', cat: 'Sensor', sim: 'full', w: 52, h: 84, color: blue, pins: { t: ['VCC', 'GND', 'DO', 'AO'] },
    deco: [{ t: 'rect', x: 14, y: 56, w: 24, h: 18, fill: '#111', rx: 2 }, { t: 'circle', x: 20, y: 65, r: 4, fill: '#2b4d7a' }, { t: 'circle', x: 32, y: 65, r: 4, fill: '#ddd' }, pwr(14, 32), sig(38, 32)],
    label: 'LINE', ly: 48, lsize: 6, outs: ['DO', 'AO'], logic: 'vcc', keywords: 'line follower garis robot tcrt5000', props: [{ key: 'black', label: 'Di atas garis hitam', type: 'bool', def: false }] },
  { tag: 'mod-mq135', name: 'Sensor Kualitas Udara MQ-135', cat: 'Sensor', sim: 'full', w: 74, h: 84, color: blue, pins: { b: ['VCC', 'GND', 'DO', 'AO'] },
    deco: [{ t: 'circle', x: 37, y: 30, r: 22, fill: '#c0c4c9', stroke: '#888', sw: 2 }, mesh(23, 16, 28, 28), pwr(8, 8), sig(66, 8)], label: 'MQ-135', ly: 64, lsize: 6, outs: ['AO', 'DO'], logic: 'vcc',
    keywords: 'gas udara air quality co2 polusi mq135', props: [{ key: 'level', label: 'Polusi udara', type: 'range', min: 0, max: 100, step: 1, def: 20, unit: ' %' }, { key: 'threshold', label: 'Ambang DO', type: 'range', min: 0, max: 100, step: 1, def: 60, unit: ' %' }] },
  { tag: 'mod-pulse', name: 'Sensor Detak Jantung (Pulse)', cat: 'Sensor', sim: 'full', w: 60, h: 74, color: '#1e8a5a', rx: 30, pins: { b: ['S', '+', '-'] },
    deco: [{ t: 'path', d: 'M30 46 l-14 -14 a7 7 0 0 1 14 -8 a7 7 0 0 1 14 8z', fill: '#ff5a6e' }], label: 'PULSE', ly: 58, lsize: 6, outs: ['S'], logic: 'vcc', keywords: 'heart pulse detak jantung bpm',
    props: [{ key: 'bpm', label: 'Detak', type: 'range', min: 40, max: 160, step: 1, def: 75, unit: ' bpm' }] },
  { tag: 'mod-touch', name: 'Sensor Sentuh TTP223', cat: 'Sensor', sim: 'full', w: 46, h: 62, color: red, pins: { b: ['VCC', 'SIG|I/O', 'GND'] },
    deco: [{ t: 'pad', x: 23, y: 24, r: 15, fill: '#e0b84e' }, sig(40, 6)], label: false, outs: ['SIG'], logic: 'vcc', keywords: 'touch sentuh ttp223 kapasitif', pinDesc: { SIG: 'HIGH saat disentuh' } },
  { tag: 'mod-acs712', name: 'Sensor Arus ACS712 (5A)', cat: 'Sensor', sim: 'full', w: 96, h: 56, color: red, pins: { l: ['IP+', 'IP+.2|IP-'], r: ['VCC', 'OUT', 'GND'] },
    deco: [{ t: 'rect', x: 0, y: 10, w: 22, h: 36, fill: '#2c74c9', rx: 2 }, ...chip(40, 20, 16, 14)], label: 'ACS712', ly: 50, lsize: 6, outs: ['OUT'], logic: 'vcc', keywords: 'current arus ampere listrik',
    props: [{ key: 'current', label: 'Arus', type: 'range', min: -5, max: 5, step: 0.1, def: 1, unit: ' A' }] },
  { tag: 'mod-voltage', name: 'Sensor Tegangan 0–25 V', cat: 'Sensor', sim: 'full', w: 80, h: 56, color: red, pins: { l: ['VIN|VCC', '-.2|GND'], r: ['S', '+', '-'] },
    deco: [{ t: 'rect', x: 0, y: 12, w: 20, h: 32, fill: '#2c74c9', rx: 2 }], label: 'VOLT', lsize: 7, outs: ['S'], keywords: 'voltage tegangan pembagi divider baterai',
    pinDesc: { S: 'S = Vin / 5' } },
  { tag: 'mod-flow', name: 'Sensor Aliran Air YF-S201', cat: 'Sensor', sim: 'full', w: 110, h: 64, color: '#1b1b1b', pins: { l: ['VCC|Merah +', 'GND|Hitam -', 'SIG|Kuning'] },
    deco: [{ t: 'rect', x: 30, y: 18, w: 76, h: 28, fill: '#2d2d2d', rx: 4 }, { t: 'rotor', x: 68, y: 32, r: 11, fill: '#3b7dd8' }], label: 'YF-S201', ly: 60, lsize: 6, outs: ['SIG'], logic: 'vcc',
    keywords: 'water flow aliran air debit pompa irigasi', props: [{ key: 'flow', label: 'Debit', type: 'range', min: 0, max: 30, step: 0.5, def: 5, unit: ' L/menit' }] },
  { tag: 'mod-hall', name: 'Sensor Magnet Hall KY-003', cat: 'Sensor', sim: 'full', w: 44, h: 62, color: black, pins: { b: ['S', '+', '-'] },
    deco: [{ t: 'rect', x: 16, y: 8, w: 12, h: 10, fill: '#333' }, sig(36, 30)], label: 'HALL', ly: 36, lsize: 6, outs: ['S'], logic: 'vcc', keywords: 'hall magnet magnetic',
    props: [{ key: 'magnet', label: 'Ada magnet', type: 'bool', def: false }] },
  { tag: 'mod-vibration', name: 'Sensor Getaran SW-420', cat: 'Sensor', sim: 'full', w: 56, h: 72, color: blue, pins: { b: ['VCC', 'GND', 'DO'] },
    deco: [{ t: 'rect', x: 18, y: 8, w: 20, h: 14, fill: '#888', rx: 4 }, pwr(10, 34), sig(46, 34)], label: 'SW-420', ly: 46, lsize: 6, outs: ['DO'], logic: 'vcc', keywords: 'vibration getaran gempa earthquake',
    props: [{ key: 'shake', label: 'Ada getaran', type: 'bool', def: false }] },
  { tag: 'mod-tds', name: 'Sensor TDS (kualitas air)', cat: 'Sensor', sim: 'full', w: 60, h: 64, color: blue, pins: { b: ['A', '+', '-'] },
    deco: [...chip(18, 10, 24, 14)], label: 'TDS', ly: 40, lsize: 7, outs: ['A'], logic: 'vcc', keywords: 'tds water quality ppm air minum hidroponik',
    props: [{ key: 'ppm', label: 'TDS', type: 'range', min: 0, max: 1000, step: 10, def: 250, unit: ' ppm' }] },
  { tag: 'mod-ph', name: 'Sensor pH (modul PH-4502C)', cat: 'Sensor', sim: 'full', w: 96, h: 66, color: blue, pins: { r: ['To', 'Do', 'Po', 'G', 'G.2|G', 'V+'] },
    deco: [{ t: 'rect', x: 6, y: 18, w: 22, h: 26, fill: '#c9a227', rx: 11 }, ...chip(36, 22, 18, 16)], label: 'pH', lx: 40, ly: 58, lsize: 7, outs: ['Po'], keywords: 'ph asam basa acid kimia hidroponik',
    props: [{ key: 'ph', label: 'pH', type: 'range', min: 0, max: 14, step: 0.1, def: 7, unit: '' }] },
  { tag: 'mod-jsn-sr04t', name: 'Ultrasonik Tahan Air JSN-SR04T', cat: 'Sensor', sim: 'full', w: 86, h: 58, color: green, pins: { b: ['VCC|5V', 'TRIG', 'ECHO', 'GND'] },
    deco: [...chip(30, 10, 26, 16)], label: 'JSN-SR04T', ly: 38, lsize: 6, outs: ['ECHO'], keywords: 'ultrasonic jarak waterproof distance tangki',
    props: [{ key: 'distance', label: 'Jarak', type: 'range', min: 20, max: 450, step: 1, def: 100, unit: ' cm' }] },
  { tag: 'mod-ds3231', name: 'RTC DS3231 (I2C)', cat: 'Sensor', sim: 'full', w: 100, h: 60, color: blue, pins: { l: ['32K', 'SQW', 'SCL', 'SDA', 'VCC', 'GND'] },
    deco: [{ t: 'circle', x: 70, y: 30, r: 18, fill: '#c0c4c9', stroke: '#888' }], label: 'DS3231', lx: 70, ly: 33, lsize: 6, lcolor: '#333', keywords: 'rtc clock jam waktu real time i2c' },
  { tag: 'mod-gps', name: 'GPS NEO-6M', cat: 'Sensor', sim: 'visual', w: 96, h: 86, color: blue, pins: { b: ['VCC', 'RX', 'TX', 'GND'] }, deco: [{ t: 'rect', x: 26, y: 8, w: 44, h: 44, fill: '#c9a227', rx: 2 }],
    label: 'NEO-6M', ly: 64, lsize: 7, keywords: 'gps lokasi location navigasi uart' },
  { tag: 'mod-rc522', name: 'RFID RC522', cat: 'Sensor', sim: 'visual', w: 104, h: 120, color: blue, pins: { b: ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'] },
    deco: [{ t: 'rect', x: 10, y: 8, w: 84, h: 70, fill: 'none', stroke: '#d9c27a', sw: 3, rx: 6 }, ...chip(42, 82, 20, 12)], label: 'RC522', ly: 48, lsize: 8, keywords: 'rfid kartu card nfc absensi spi' },
  { tag: 'mod-max30102', name: 'MAX30102 (SpO2 & detak)', cat: 'Sensor', sim: 'visual', w: 58, h: 54, color: purple, pins: { t: ['VIN', 'SCL', 'SDA', 'INT'] }, deco: [...chip(22, 24, 14, 10)], label: 'MAX30102', ly: 46, lsize: 5.5, keywords: 'spo2 oximeter heart i2c' },

  // ===================== Displays
  { tag: 'mod-oled-i2c', name: 'OLED 0.96" SSD1306 (I2C)', cat: 'Tampilan', sim: 'full', w: 108, h: 98, color: '#1d3a73', pins: { t: ['GND', 'VCC', 'SCL', 'SDA'] },
    deco: [{ t: 'rect', x: 4, y: 18, w: 100, h: 58, fill: '#0b0b0b', rx: 2 }], screen: { x: 6, y: 21, w: 96, h: 48, cols: 128, rows: 64 }, label: 'SSD1306 128x64', ly: 88, lsize: 6,
    keywords: 'oled display layar i2c ssd1306 0.96' },
  { tag: 'mod-tm1637', name: '7-Segment 4 Digit TM1637', cat: 'Tampilan', sim: 'visual', w: 130, h: 52, color: blue, pins: { r: ['CLK', 'DIO', 'VCC', 'GND'] },
    deco: [{ t: 'rect', x: 6, y: 6, w: 92, h: 40, fill: '#111', rx: 2 }, { t: 'text', x: 52, y: 37, text: '88:88', size: 28, fill: '#ff3b30', bold: true }], label: false, keywords: 'tm1637 clock 7 segment jam' },
  { tag: 'mod-max7219', name: 'Matriks LED 8x8 MAX7219', cat: 'Tampilan', sim: 'visual', w: 110, h: 96, color: '#1d5c2e', pins: { l: ['VCC', 'GND', 'DIN', 'CS', 'CLK'] },
    deco: [{ t: 'rect', x: 22, y: 6, w: 84, h: 84, fill: '#111', rx: 2 }, ...[...Array(64).keys()].map((i) => ({ t: 'circle', x: 28 + (i % 8) * 10.3, y: 12 + Math.floor(i / 8) * 10.3, r: 3.6, fill: '#4a1414' }))], label: false, keywords: 'matrix led max7219 running text' },

  // ===================== Actuators / outputs
  { tag: 'mod-relay1', name: 'Modul Relay 1 Kanal', cat: 'Aktuator', sim: 'full', w: 116, h: 60, color: blue, pins: { l: ['VCC', 'GND', 'IN'], r: ['NO', 'COM', 'NC'] },
    deco: [{ t: 'rect', x: 34, y: 8, w: 44, h: 36, fill: '#1f6fd6', rx: 2 }, { t: 'text', x: 56, y: 28, text: 'SRD-05VDC', size: 5.2 }, pwr(24, 50), { t: 'led', key: 'ch1', x: 88, y: 50, color: '#33d17a' }], label: false,
    keywords: 'relay saklar switch lampu pompa ac', props: [{ key: 'trigger', label: 'Aktif saat', type: 'select', options: ['LOW', 'HIGH'], def: 'LOW' }], pinDesc: { IN: 'Sinyal kendali dari mikrokontroler', NO: 'Normally Open', NC: 'Normally Closed', COM: 'Common' } },
  { tag: 'mod-relay2', name: 'Modul Relay 2 Kanal', cat: 'Aktuator', sim: 'full', w: 126, h: 92, color: blue, pins: { l: ['VCC', 'GND', 'IN1', 'IN2'], r: ['NO1', 'COM1', 'NC1', 'NO2', 'COM2', 'NC2'] },
    deco: [{ t: 'rect', x: 40, y: 6, w: 44, h: 36, fill: '#1f6fd6', rx: 2 }, { t: 'rect', x: 40, y: 50, w: 44, h: 36, fill: '#1f6fd6', rx: 2 }, { t: 'led', key: 'ch1', x: 92, y: 24, color: '#33d17a' }, { t: 'led', key: 'ch2', x: 92, y: 68, color: '#33d17a' }, pwr(30, 46)], label: false,
    keywords: 'relay 2 channel', props: [{ key: 'trigger', label: 'Aktif saat', type: 'select', options: ['LOW', 'HIGH'], def: 'LOW' }] },
  { tag: 'mod-relay4', name: 'Modul Relay 4 Kanal', cat: 'Aktuator', sim: 'full', w: 130, h: 150, color: blue, pins: { l: ['VCC', 'GND', 'IN1', 'IN2', 'IN3', 'IN4'], r: ['NO1', 'COM1', 'NC1', 'NO2', 'COM2', 'NC2', 'NO3', 'COM3', 'NC3', 'NO4', 'COM4', 'NC4'] },
    deco: [0, 1, 2, 3].flatMap((i) => [{ t: 'rect', x: 44, y: 8 + i * 35, w: 40, h: 30, fill: '#1f6fd6', rx: 2 }, { t: 'led', key: 'ch' + (i + 1), x: 92, y: 23 + i * 35, color: '#33d17a' }]).concat([pwr(30, 140)]), label: false,
    keywords: 'relay 4 channel smart home', props: [{ key: 'trigger', label: 'Aktif saat', type: 'select', options: ['LOW', 'HIGH'], def: 'LOW' }] },
  { tag: 'mod-dc-motor', name: 'Motor DC', cat: 'Aktuator', sim: 'full', w: 96, h: 60, color: '#9aa3ad', rx: 10, pins: { l: ['M+|+', 'M-|-'] }, labelColor: '#222',
    deco: [{ t: 'rect', x: 74, y: 25, w: 22, h: 10, fill: '#777' }, { t: 'rotor', x: 50, y: 30, r: 18, fill: '#c9ced6' }], label: false, keywords: 'motor dc dinamo roda kipas' },
  { tag: 'mod-l298n', name: 'Driver Motor L298N', cat: 'Aktuator', sim: 'full', w: 136, h: 136, color: red,
    pins: { l: ['OUT1', 'OUT2'], r: ['OUT3', 'OUT4'], b: ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'], t: ['12V|+12V', 'GND', '5V|+5V'] },
    deco: [{ t: 'rect', x: 44, y: 22, w: 48, h: 50, fill: '#111', rx: 1 }, { t: 'grid', x: 48, y: 26, w: 40, h: 22, step: 5, fill: '#333' }, pwr(30, 100)], label: 'L298N', ly: 90, lsize: 8,
    keywords: 'motor driver l298n h-bridge robot', pinDesc: { ENA: 'Enable/PWM motor A (jumper = selalu aktif)', ENB: 'Enable/PWM motor B' } },
  { tag: 'mod-pump', name: 'Pompa Air Mini 5V', cat: 'Aktuator', sim: 'full', w: 80, h: 66, color: '#d9dde3', rx: 8, labelColor: '#222', pins: { l: ['+', '-'] },
    deco: [{ t: 'rect', x: 62, y: 8, w: 16, h: 8, fill: '#9aa3ad' }, { t: 'rotor', x: 44, y: 36, r: 14, fill: '#4aa3f0' }], label: false, keywords: 'pump pompa air irigasi akuarium' },
  { tag: 'mod-fan', name: 'Kipas DC 5V', cat: 'Aktuator', sim: 'full', w: 80, h: 80, color: '#222', rx: 6, pins: { b: ['+', '-'] },
    deco: [{ t: 'rotor', x: 40, y: 36, r: 26, fill: '#3a3f47' }], label: false, keywords: 'fan kipas pendingin cooling' },
  { tag: 'mod-solenoid', name: 'Solenoid Valve 12V', cat: 'Aktuator', sim: 'full', w: 90, h: 60, color: '#c0c4c9', rx: 6, labelColor: '#222', pins: { l: ['+', '-'] },
    deco: [{ t: 'rect', x: 26, y: 8, w: 40, h: 44, fill: '#222', rx: 4 }, { t: 'led', key: 'on', x: 46, y: 30, r: 5, color: '#33d17a' }], label: false, keywords: 'solenoid valve keran kunci door lock' },
  { tag: 'mod-mosfet', name: 'Modul MOSFET IRF520', cat: 'Aktuator', sim: 'full', w: 110, h: 64, color: purple, pins: { l: ['SIG', 'VCC', 'GND'], r: ['VIN', 'GND.2|GND', 'VIN.2|V+', 'V-'] },
    deco: [{ t: 'rect', x: 40, y: 10, w: 22, h: 30, fill: '#111' }, { t: 'rect', x: 43, y: 2, w: 16, h: 10, fill: '#aaa' }, sig(30, 54)], label: 'IRF520', ly: 54, lx: 66, lsize: 6,
    keywords: 'mosfet driver pwm motor led strip', pinDesc: { 'V+': 'Terhubung langsung ke VIN', 'V-': 'Ke beban (−), disambung ke GND saat SIG HIGH' } },
  { tag: 'mod-npn', name: 'Transistor NPN BC547', cat: 'Pasif & Dasar', sim: 'full', w: 34, h: 50, color: '#1b1b1b', rx: 12, pins: { b: ['C', 'B', 'E'] }, label: 'BC547', ly: 24, lsize: 5.5, keywords: 'transistor npn switch saklar bc547 2n2222' },
  { tag: 'mod-laser', name: 'Modul Laser KY-008', cat: 'Aktuator', sim: 'full', w: 48, h: 60, color: black, pins: { b: ['S', 'VCC|+', 'GND|-'] },
    deco: [{ t: 'rect', x: 16, y: 4, w: 16, h: 18, fill: '#c9a227', rx: 2 }, { t: 'led', key: 'on', x: 24, y: 6, r: 3, color: '#ff2020' }], label: 'LASER', ly: 36, lsize: 6, keywords: 'laser pointer ky-008' },
  { tag: 'mod-traffic', name: 'Modul Lampu Lalu Lintas', cat: 'Aktuator', sim: 'full', w: 40, h: 104, color: black, pins: { b: ['R', 'Y', 'G', 'GND'] }, nolabels: false,
    deco: [{ t: 'led', key: 'R', x: 20, y: 16, r: 8, color: '#ff3b30' }, { t: 'led', key: 'Y', x: 20, y: 38, r: 8, color: '#ffcc00' }, { t: 'led', key: 'G', x: 20, y: 60, r: 8, color: '#33d17a' }], label: false, keywords: 'traffic light lampu lalu lintas' },

  // ===================== Communication
  { tag: 'mod-hc05', name: 'Bluetooth HC-05', cat: 'Komunikasi', sim: 'visual', w: 72, h: 120, color: blue, pins: { b: ['STATE', 'RXD', 'TXD', 'GND', 'VCC', 'EN'] },
    deco: [{ t: 'rect', x: 10, y: 6, w: 52, h: 66, fill: '#2a7d3f', rx: 2 }], label: 'HC-05', ly: 90, lsize: 8, vlabels: true, keywords: 'bluetooth hc05 hc06 serial android' },
  { tag: 'mod-nrf24', name: 'NRF24L01 (2.4 GHz)', cat: 'Komunikasi', sim: 'visual', w: 96, h: 50, color: green, pins: { l: ['GND', 'CE', 'SCK', 'MISO'], r: ['VCC', 'CSN', 'MOSI', 'IRQ'] },
    deco: [{ t: 'path', d: 'M60 6 h30 v6 h-26 v6 h26 v6 h-26 v6 h26', fill: 'none', stroke: '#d9c27a', sw: 2 }], label: 'nRF24L01', lx: 46, lsize: 6, keywords: 'radio wireless nrf24 rf' },
  { tag: 'mod-lora', name: 'LoRa SX1278 (Ra-02)', cat: 'Komunikasi', sim: 'visual', w: 90, h: 76, color: '#d0d4da', labelColor: '#222', lcolor: '#222', pins: { l: ['GND', '3.3V', 'RST', 'DIO0'], r: ['NSS', 'MOSI', 'MISO', 'SCK'] },
    label: 'LoRa Ra-02', lsize: 7, keywords: 'lora lorawan long range sx1278 iot' },
  { tag: 'mod-sim800l', name: 'GSM SIM800L', cat: 'Komunikasi', sim: 'visual', w: 96, h: 80, color: red, pins: { l: ['NET', 'VCC', 'RST', 'RXD', 'TXD', 'GND'] },
    deco: [{ t: 'rect', x: 40, y: 14, w: 46, h: 40, fill: '#aaa', rx: 3 }], label: 'SIM800L', lx: 62, ly: 70, lsize: 6, keywords: 'gsm sms telepon sim800 gprs' },
  { tag: 'mod-esp01', name: 'ESP-01 (ESP8266)', cat: 'Komunikasi', sim: 'visual', w: 90, h: 60, color: '#1d1d1d', pins: { l: ['GND', 'IO2', 'IO0', 'RX'], r: ['TX', 'EN', 'RST', '3V3'] },
    deco: [{ t: 'path', d: 'M30 6 h40 v6 h-36 v6 h36', fill: 'none', stroke: '#d9c27a', sw: 2 }, ...chip(36, 26, 18, 18)], label: false, keywords: 'esp01 wifi at command' },

  // ===================== Power
  { tag: 'mod-battery9v', name: 'Baterai 9V', cat: 'Daya', sim: 'full', w: 64, h: 110, color: '#2b2b2b', rx: 6, pins: { t: ['+', '-'] },
    deco: [{ t: 'rect', x: 0, y: 70, w: 64, h: 40, fill: '#e8b923', rx: 0 }], label: '9V', ly: 50, lsize: 16, keywords: 'battery baterai power daya',
    props: [{ key: 'voltage', label: 'Tegangan', type: 'range', min: 1.5, max: 12, step: 0.5, def: 9, unit: ' V' }] },
  { tag: 'mod-battery18650', name: 'Baterai Li-ion 18650', cat: 'Daya', sim: 'full', w: 150, h: 48, color: '#2b6cb0', rx: 10, pins: { l: ['+', '-'] }, label: '18650 3.7V', lsize: 9, keywords: 'li-ion lithium battery 18650',
    props: [{ key: 'voltage', label: 'Tegangan', type: 'range', min: 3, max: 4.2, step: 0.1, def: 3.7, unit: ' V' }] },
  { tag: 'mod-buck', name: 'Step-Down LM2596', cat: 'Daya', sim: 'full', w: 116, h: 62, color: blue, pins: { l: ['IN+', 'IN-'], r: ['OUT+', 'IN-.2|OUT-'] },
    deco: [{ t: 'circle', x: 40, y: 20, r: 10, fill: '#333' }, { t: 'rect', x: 62, y: 8, w: 20, h: 14, fill: '#2a6fd0' }], label: 'LM2596', ly: 52, lsize: 7, keywords: 'buck step down regulator converter',
    props: [{ key: 'vout', label: 'Tegangan keluar', type: 'range', min: 1.5, max: 12, step: 0.1, def: 5, unit: ' V' }] },
  { tag: 'mod-solar', name: 'Panel Surya 6V', cat: 'Daya', sim: 'full', w: 130, h: 94, color: '#1c2a4a', rx: 2, pins: { b: ['+', '-'] },
    deco: [...[...Array(12).keys()].map((i) => ({ t: 'rect', x: 6 + (i % 4) * 30, y: 6 + Math.floor(i / 4) * 24, w: 28, h: 22, fill: '#26457d', rx: 0 }))], label: false, keywords: 'solar surya panel energi terbarukan',
    props: [{ key: 'light', label: 'Cahaya matahari', type: 'range', min: 0, max: 100, step: 1, def: 80, unit: ' %' }] },

  // ===================== Passive
  { tag: 'mod-capacitor', name: 'Kapasitor Elektrolit', cat: 'Pasif & Dasar', sim: 'visual', w: 34, h: 56, color: '#1b4f9c', rx: 8, pins: { b: ['+', '-'] }, label: '100µF', ly: 24, lsize: 5.5, keywords: 'capacitor kapasitor elco' },
  { tag: 'mod-diode', name: 'Dioda 1N4007', cat: 'Pasif & Dasar', sim: 'visual', w: 70, h: 20, color: '#1b1b1b', rx: 3, pins: { l: ['A'], r: ['K'] }, deco: [{ t: 'rect', x: 50, y: 0, w: 5, h: 20, fill: '#ccc', rx: 0 }], label: false, keywords: 'diode dioda penyearah' },
];

export function registerModules() { for (const s of MODULE_SPECS) defineModule(s); }
