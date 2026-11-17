// Circuit editor: parts (web components), pin hotspots, wires, selection, pan/zoom,
// rotation, breadboard snapping, undo/redo and full touch support (iPad: tap pins to wire,
// drag parts, one-finger pan on empty canvas, two-finger pinch zoom).
import { BY_TAG, propDefaults } from '../catalog.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ID_BASE = {
  'wokwi-arduino-uno': 'uno', 'wokwi-arduino-nano': 'nano', 'wokwi-esp32-devkit-v1': 'esp32', 'wokwi-arduino-mega': 'mega', 'wokwi-led': 'led', 'wokwi-rgb-led': 'rgb', 'wokwi-resistor': 'r',
  'wokwi-pushbutton': 'btn', 'wokwi-pushbutton-6mm': 'btn', 'wokwi-slide-switch': 'sw', 'wokwi-potentiometer': 'pot',
  'wokwi-slide-potentiometer': 'spot', 'wokwi-buzzer': 'bz', 'wokwi-servo': 'servo', 'wokwi-7segment': 'seg', 'wokwi-lcd1602': 'lcd',
  'wokwi-lcd2004': 'lcd', 'x-lcd1602-i2c': 'lcd', 'x-lcd2004-i2c': 'lcd', 'wokwi-neopixel': 'px', 'wokwi-led-bar-graph': 'bar', 'wokwi-photoresistor-sensor': 'ldr',
  'wokwi-ntc-temperature-sensor': 'ntc', 'wokwi-hc-sr04': 'sonar', 'wokwi-membrane-keypad': 'keypad', 'wokwi-led-ring': 'ring',
  'wokwi-neopixel-matrix': 'matrix', 'wokwi-analog-joystick': 'joy', 'wokwi-pir-motion-sensor': 'pir', 'wokwi-gas-sensor': 'gas',
  'wokwi-ky-040': 'enc', 'wokwi-dip-switch-8': 'dip', 'wokwi-tilt-switch': 'tilt', 'wokwi-dht22': 'dht', 'wokwi-mpu6050': 'mpu', 'wokwi-ds1307': 'rtc',
  'x-breadboard-half': 'bb', 'x-breadboard-mini': 'bb', 'mod-oled-i2c': 'oled',
};
const SIGNAL_COLORS = ['#f5a524', '#2fbf71', '#3d8bfd', '#a855f7', '#06b6d4', '#f43f5e', '#84cc16', '#fb923c'];
const baseName = (p) => (/^\d+\.\d+V$/.test(p) ? p : p.split('.')[0]);   // GND.2 -> GND, but 3.3V stays 3.3V (not pin 3)
const isBB = (type) => !!BY_TAG[type]?.breadboard;
const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]]; // cos,-sin,sin,cos for 0/90/180/270

export class CircuitCanvas {
  constructor(refs) {
    Object.assign(this, refs); // viewport, world, wiresSvg, partsHost, pinLayer, emptyHint, zoomLabel, wireHint
    this.parts = new Map(); this.wires = []; this.handlers = {};
    this.pan = { x: 40, y: 40 }; this.zoom = 1; this.snap = 5;
    this.selected = null; this.pending = null; this.colorIdx = 0; this.interactive = false; this.nextWire = 1;
    this.bbMode = 'wire';   // breadboard holes: 'wire' starts a wire, 'move' drags the breadboard (no accidental wires)
    this.history = []; this.hpos = -1; this._restoring = false;
    this.pinTip = document.createElement('div'); this.pinTip.className = 'pin-tip'; this.pinTip.hidden = true; this.pinLayer.append(this.pinTip);
    this.ghost = document.createElementNS(SVGNS, 'path'); this.ghost.setAttribute('class', 'wire ghost'); this.ghost.style.display = 'none'; this.wiresSvg.append(this.ghost);
    // bend-point handles of the selected wire live above the parts so they can always be grabbed
    this.handlesSvg = document.createElementNS(SVGNS, 'svg'); this.handlesSvg.setAttribute('class', 'wire-handles'); this.handlesSvg.setAttribute('width', '8000'); this.handlesSvg.setAttribute('height', '8000');
    this.world.append(this.handlesSvg);
    this._bind(); this._applyView();
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  emit(evt, data) {
    if (evt === 'change' && !this._restoring) this.snapshot();
    for (const f of this.handlers[evt] || []) f(data);
  }

  // ---------------------------------------------------------------- model
  getModel() {
    return {
      version: 2,
      parts: [...this.parts.values()].map((p) => ({ id: p.id, type: p.type, left: Math.round(p.left * 10) / 10, top: Math.round(p.top * 10) / 10, rotate: p.rot * 90, attrs: { ...p.attrs } })),
      connections: this.wires.map((w) => (w.pts?.length && !w.plug ? [w.a, w.b, w.color, w.pts.map((q) => [Math.round(q.x), Math.round(q.y)])] : [w.a, w.b, w.plug ? 'plug' : w.color])),
    };
  }
  elements() { return new Map([...this.parts].map(([id, p]) => [id, p.el])); }
  simModel() { return { parts: [...this.parts.values()].map((p) => ({ id: p.id, type: p.type, left: p.left, top: p.top, attrs: p.attrs })), connections: this.wires.map((w) => [w.a, w.b]) }; }

  async setModel(model, { fit = true, keepHistory = false } = {}) {
    this._restoring = true;
    try {
      this.clear(true);
      const pending = [];
      for (const p of model.parts || []) {
        if (!BY_TAG[p.type]) { this.emit('toast', { text: `Komponen tidak dikenal dilewati: ${p.type}`, err: true }); continue; }
        pending.push(this._create(p.type, p.left, p.top, p.attrs, p.id, ((p.rotate || 0) / 90) & 3));
      }
      await Promise.all(pending);
      for (const [a, b, color, pts] of model.connections || []) this._addWire(a, b, color === 'plug' ? null : color, true, color === 'plug', pts);
      for (const p of this.parts.values()) if (!isBB(p.type)) this._plug(p, false); // geometry decides breadboard contacts
      this._refreshAll(); this._hint(); this.emit('model');
      if (fit) this.fit();
    } finally { this._restoring = false; }
    if (!keepHistory) { this.history = []; this.hpos = -1; this.snapshot(); }
  }

  clear(silent) {
    for (const p of this.parts.values()) { p.wrap.remove(); p.pins.remove(); }
    this.parts.clear(); for (const w of this.wires) w.g.remove(); this.wires = []; this.select(null);
    this._hint();
    if (!silent) this.emit('change', { structural: true });
  }

  // ---------------------------------------------------------------- history
  snapshot() {
    const s = JSON.stringify(this.getModel());
    if (this.history[this.hpos] === s) return;
    this.history = this.history.slice(0, this.hpos + 1); this.history.push(s);
    if (this.history.length > 80) this.history.shift();
    this.hpos = this.history.length - 1; this.emit('history', this.historyState());
  }
  historyState() { return { canUndo: this.hpos > 0, canRedo: this.hpos < this.history.length - 1 }; }
  async undo() { if (this.hpos > 0) { this.hpos--; await this._restore(); } }
  async redo() { if (this.hpos < this.history.length - 1) { this.hpos++; await this._restore(); } }
  async _restore() {
    await this.setModel(JSON.parse(this.history[this.hpos]), { fit: false, keepHistory: true });
    this._restoring = true; try { for (const f of this.handlers.change || []) f({ structural: true }); } finally { this._restoring = false; }
    this.emit('history', this.historyState());
  }

  // ---------------------------------------------------------------- parts
  _newId(type) {
    const base = ID_BASE[type] || type.replace(/^(wokwi|mod|x)-/, '').split('-')[0].replace(/(\D)\d+$/, '$1');
    if (!this.parts.has(base) && BY_TAG[type]?.board) return base;
    let i = 1; while (this.parts.has(base + i)) i++;
    return base + i;
  }

  async addPart(type, x, y, attrs) {
    const cat = BY_TAG[type];
    if (cat?.board) {
      const other = [...this.parts.values()].find((p) => BY_TAG[p.type]?.board);
      if (other) { this.emit('toast', { text: `Satu rangkaian hanya boleh punya satu mikrokontroler (sudah ada ${other.id}).`, err: true }); return null; }
    }
    const part = await this._create(type, x, y, attrs);
    this._plug(part, true);
    this._hint(); this.select({ kind: 'part', id: part.id });
    this.emit('change', { structural: true });
    return part.id;
  }

  async _create(type, x, y, attrs, id, rot = 0) {
    const cat = BY_TAG[type];
    id = id || this._newId(type);
    const el = document.createElement(type); el.className = 'el';
    const wrap = document.createElement('div'); wrap.className = 'part' + (cat?.sim === 'visual' ? ' vis-only' : '') + (cat?.sim === 'design' ? ' design-only' : '') + (isBB(type) ? ' bb' : ''); wrap.dataset.id = id;
    const grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = id;
    const selBox = document.createElement('div'); selBox.className = 'sel-box';
    wrap.append(selBox, el, grip);
    const pins = document.createElement('div'); pins.className = 'pinbox' + (isBB(type) ? ' bb' : ''); pins.style.cssText = 'position:absolute;left:0;top:0';
    const part = { id, type, left: x ?? 0, top: y ?? 0, rot, attrs: { ...propDefaults(type), ...(attrs || {}) }, el, wrap, grip, pins, pinInfo: [], size: [0, 0] };
    this.parts.set(id, part);
    this.applyAttrs(part);
    if (isBB(type)) { this.partsHost.prepend(wrap); this.pinLayer.prepend(pins); } else { this.partsHost.append(wrap); this.pinLayer.append(pins); }
    el.addEventListener('pininfo-change', () => this._refreshPins(part));
    if (type === 'wokwi-potentiometer' || type === 'wokwi-slide-potentiometer') {
      el.addEventListener('input', () => { const mn = el.min ?? 0, mx = el.max ?? 100; part.attrs.value = Math.round(((+el.value - mn) / (mx - mn)) * 100); this.emit('attrs', part.id); });
    }
    await (el.updateComplete || Promise.resolve());
    this._refreshPins(part); this._place(part);
    return part;
  }

  applyAttrs(part) {
    const { el, attrs, type } = part;
    for (const [k, v] of Object.entries(attrs)) {
      if ((type === 'wokwi-potentiometer' || type === 'wokwi-slide-potentiometer') && k === 'value') {
        const min = el.min ?? 0, max = el.max ?? 100;
        el.value = Math.round(min + (v / 100) * (max - min)); continue;
      }
      if (type === 'wokwi-led-bar-graph' && k === 'color') { el.color = v; continue; }
      if (BY_TAG[type]?.module) continue; // module props are simulation inputs, not element props
      if (k in el) { try { el[k] = k === 'pixels' ? +v : v; } catch { /* readonly */ } }
    }
    if (type === 'wokwi-resistor') el.value = String(attrs.value);
    if (type === 'mod-capacitor' && attrs.capacitance) el.setText?.('label', attrs.capacitance + 'µF');
  }

  // local (unrotated) -> part-relative rotated coordinates
  _xf(part, x, y) {
    const [w, h] = part.size; const [a, b, c, d] = ROT[part.rot & 3]; const cx = w / 2, cy = h / 2;
    return { x: cx + a * (x - cx) + b * (y - cy), y: cy + c * (x - cx) + d * (y - cy) };
  }
  _place(part) {
    part.wrap.style.left = part.pins.style.left = part.left + 'px'; part.wrap.style.top = part.pins.style.top = part.top + 'px';
    part.el.style.transform = part.rot ? `rotate(${part.rot * 90}deg)` : ''; part.el.style.transformOrigin = 'center';
    const [w, h] = part.size; const swap = part.rot & 1;
    part.wrap.style.width = w + 'px'; part.wrap.style.height = h + 'px';
    part.wrap.querySelector('.sel-box').style.cssText = swap ? `left:${(w - h) / 2 - 5}px;top:${(h - w) / 2 - 5}px;width:${h + 10}px;height:${w + 10}px` : '';
    part.grip.style.top = (swap ? (h - w) / 2 : 0) - 19 + 'px'; part.grip.style.left = (swap ? (w - h) / 2 : 0) + 'px';
  }

  _refreshPins(part) {
    const el = part.el; let info = [];
    try { info = el.pinInfo || []; } catch { /* element not ready */ }
    part.pinInfo = info; part.size = [el.offsetWidth || part.size[0] || 0, el.offsetHeight || part.size[1] || 0];
    if (!el.offsetWidth || !el.offsetHeight) {                     // inline hosts may report 0: take the artwork's own size
      const sv = (el.shadowRoot || el).querySelector?.('svg'); let sw = 0, sh = 0;
      try { sw = sv?.width.baseVal.value || 0; sh = sv?.height.baseVal.value || 0; } catch { /* no svg */ }
      if (!part.size[0] && sw) part.size[0] = sw; if (!part.size[1] && sh) part.size[1] = sh;
    }
    part.pins.textContent = '';
    for (const p of info) {
      const q = this._xf(part, p.x, p.y);
      const d = document.createElement('div'); d.className = 'pin'; d.style.left = q.x + 'px'; d.style.top = q.y + 'px';
      d.dataset.pid = part.id; d.dataset.pin = p.name;
      part.pins.append(d);
    }
    this._place(part); this._markWired(); this._redrawWires();
  }
  _refreshAll() { for (const p of this.parts.values()) this._refreshPins(p); }

  pinPos(ref) {
    const i = ref.indexOf(':'); const id = ref.slice(0, i), pin = ref.slice(i + 1);
    const part = this.parts.get(id); if (!part) return null;
    const info = part.pinInfo.find((p) => p.name === pin); if (!info) return null;
    const q = this._xf(part, info.x, info.y);
    return { x: part.left + q.x, y: part.top + q.y, part, info };
  }

  removePart(id) {
    const part = this.parts.get(id); if (!part) return;
    this.wires.filter((w) => w.a.startsWith(id + ':') || w.b.startsWith(id + ':')).forEach((w) => this._removeWire(w, true));
    part.wrap.remove(); part.pins.remove(); this.parts.delete(id);
    if (this.selected?.id === id) this.select(null);
    this._hint(); this.emit('change', { structural: true });
  }

  async duplicate(id) {
    const p = this.parts.get(id); if (!p || BY_TAG[p.type]?.board) return;
    const nid = await this.addPart(p.type, p.left + 24, p.top + 24, p.attrs);
    if (nid && p.rot) this.rotate(nid, p.rot);
    return nid;
  }

  rotate(id, quarterTurns = 1) {
    const part = this.parts.get(id); if (!part) return;
    part.rot = (part.rot + quarterTurns + 4) & 3;
    this._refreshPins(part); this._plug(part, true); this._redrawWires();
    this.emit('change', { structural: true });
  }
  rotateSelected(dir = 1) { if (this.selected?.kind === 'part') this.rotate(this.selected.id, dir); }

  // ---------------------------------------------------------------- breadboard plugging
  _holes(except) {
    const out = [];
    for (const p of this.parts.values()) {
      if (!isBB(p.type) || p === except) continue;
      for (const info of p.pinInfo) { const q = this._xf(p, info.x, info.y); out.push({ ref: `${p.id}:${info.name}`, x: p.left + q.x, y: p.top + q.y }); }
    }
    return out;
  }
  // Snap a part onto breadboard holes (if close) and create hidden "plug" connections.
  _plug(part, snap) {
    if (isBB(part.type)) { for (const p of this.parts.values()) if (!isBB(p.type)) this._plug(p, false); return; }
    for (const w of this.wires.filter((w) => w.plug && (w.a.startsWith(part.id + ':') || w.b.startsWith(part.id + ':')))) this._removeWire(w, true);
    const holes = this._holes(part); if (!holes.length || !part.pinInfo.length) return;
    const pins = part.pinInfo.map((i) => ({ name: i.name, ...this._xf(part, i.x, i.y) })).map((q) => ({ name: q.name, x: part.left + q.x, y: part.top + q.y }));
    const nearest = (x, y, r) => { let best = null, bd = r; for (const h of holes) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } } return best; };
    if (snap) {
      let bestOff = null, bestScore = 0;
      for (const p of pins.slice(0, 8)) {
        const h = nearest(p.x, p.y, 9); if (!h) continue;
        const dx = h.x - p.x, dy = h.y - p.y;
        const score = pins.filter((q) => nearest(q.x + dx, q.y + dy, 1.6)).length - Math.hypot(dx, dy) / 100;
        if (score > bestScore) { bestScore = score; bestOff = { dx, dy }; }
      }
      if (bestOff && bestScore >= Math.min(2, pins.length) - 0.2) {
        part.left += bestOff.dx; part.top += bestOff.dy; this._place(part);
        for (const p of pins) { p.x += bestOff.dx; p.y += bestOff.dy; }
      }
    }
    for (const p of pins) { const h = nearest(p.x, p.y, 2); if (h) this._addWire(`${part.id}:${p.name}`, h.ref, null, true, true); }
    this._markWired(); this._redrawWires();
  }
  pluggedInto(bbId) { return [...new Set(this.wires.filter((w) => w.plug && w.b.startsWith(bbId + ':')).map((w) => w.a.split(':')[0]))]; }

  // ---------------------------------------------------------------- wires
  _autoColor(a, b) {
    const names = [a, b].map((r) => baseName(r.split(':').slice(1).join(':')));
    if (names.some((n) => ['GND', 'VSS', '-', 'GND_IN', 'AGND', 'G', 'IN-'].includes(n))) return '#1f2937';
    if (names.some((n) => ['5V', '3.3V', '3V3', 'VCC', 'VIN', 'V+', 'VDD', 'IOREF', '+', '12V', 'VBUS', 'VSYS', 'TP', 'BP'].includes(n))) return '#e11d48';
    return SIGNAL_COLORS[this.colorIdx++ % SIGNAL_COLORS.length];
  }

  _addWire(a, b, color, silent, plug = false, pts = null) {
    if (a === b || !this.pinPos(a) || !this.pinPos(b)) { if (!silent) this.emit('toast', { text: 'Pin tidak valid.', err: true }); return null; }
    const dup = this.wires.find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
    if (dup) return plug ? dup : null;
    const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'wire-wrap' + (plug ? ' plug' : ''));
    const hit = document.createElementNS(SVGNS, 'path'); hit.setAttribute('class', 'wire-hit');
    const under = document.createElementNS(SVGNS, 'path'); under.setAttribute('class', 'wire under');
    const path = document.createElementNS(SVGNS, 'path'); path.setAttribute('class', 'wire');
    color = plug ? '#0000' : (color || this._autoColor(a, b)); path.style.stroke = color;
    g.append(hit, under, path);
    const w = { id: this.nextWire++, a, b, color, g, hit, under, path, plug, pts: (pts || []).map((q) => (Array.isArray(q) ? { x: +q[0], y: +q[1] } : { x: +q.x, y: +q.y })).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y)) };
    if (!plug) g.addEventListener('pointerdown', (e) => { if (this.pending) return; e.stopPropagation(); this.select({ kind: 'wire', id: w.id }); this.viewport.focus({ preventScroll: true }); });
    this.wiresSvg.insertBefore(g, this.ghost);
    this.wires.push(w); if (!plug) this._drawWire(w); this._markWired();
    return w;
  }
  _removeWire(w, silent) {
    w.g.remove(); this.wires = this.wires.filter((x) => x !== w); this._markWired();
    if (this.selected?.kind === 'wire' && this.selected.id === w.id) this.select(null);
    if (!silent) this.emit('change', { structural: true });
  }
  setWireColor(id, color) { const w = this.wires.find((x) => x.id === id); if (w && !w.plug) { w.color = color; w.path.style.stroke = color; this.emit('change', { structural: false }); } }

  _dir(pos) {
    const [w, h] = pos.part.size; const x = pos.info.x, y = pos.info.y;
    const d = [[x, [-1, 0]], [w - x, [1, 0]], [y, [0, -1]], [h - y, [0, 1]]].sort((p, q) => p[0] - q[0])[0][1];
    const [a, b, c, e] = ROT[pos.part.rot & 3];
    return [a * d[0] + b * d[1], c * d[0] + e * d[1]];
  }
  _curve(pa, pb) {
    const da = this._dir(pa), db = pb.part ? this._dir(pb) : [0, 0];
    const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y), off = Math.min(Math.max(dist * 0.4, 18), 140);
    return `M${pa.x},${pa.y} C${pa.x + da[0] * off},${pa.y + da[1] * off} ${pb.x + db[0] * off},${pb.y + db[1] * off} ${pb.x},${pb.y}`;
  }
  /** polyline through bend points with small rounded corners */
  _poly(points) {
    const r = 6; let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i - 1], c = points[i], n = points[i + 1];
      const l1 = Math.hypot(c.x - p.x, c.y - p.y) || 1, l2 = Math.hypot(n.x - c.x, n.y - c.y) || 1, k1 = Math.min(r, l1 / 2) / l1, k2 = Math.min(r, l2 / 2) / l2;
      d += ` L${c.x - (c.x - p.x) * k1},${c.y - (c.y - p.y) * k1} Q${c.x},${c.y} ${c.x + (n.x - c.x) * k2},${c.y + (n.y - c.y) * k2}`;
    }
    const e = points[points.length - 1]; return d + ` L${e.x},${e.y}`;
  }
  _wireD(pa, pb, pts) { return pts?.length ? this._poly([pa, ...pts, pb]) : this._curve(pa, pb); }
  _drawWire(w) {
    if (w.plug) return;
    const pa = this.pinPos(w.a), pb = this.pinPos(w.b); if (!pa || !pb) return;
    const d = this._wireD(pa, pb, w.pts); w.hit.setAttribute('d', d); w.under.setAttribute('d', d); w.path.setAttribute('d', d);
    if (this.selected?.kind === 'wire' && this.selected.id === w.id) this._drawHandles(w);
  }
  _redrawWires() { for (const w of this.wires) this._drawWire(w); }

  // ---------------------------------------------------------------- wire bend points
  /** handles of the selected wire: ● bend point (drag to move, double-tap to remove), + segment midpoint (drag to add a bend) */
  _drawHandles(w) {
    const g = this.handlesSvg; g.replaceChildren();
    const pa = this.pinPos(w.a), pb = this.pinPos(w.b); if (!pa || !pb || w.plug) return;
    const pts = [pa, ...w.pts, pb], z = this.zoom, rr = Math.max(5, 6 / z), hit = Math.max(12, 16 / z);
    const mk = (x, y, kind, idx) => {
      const c = document.createElementNS(SVGNS, 'g'); c.setAttribute('class', 'wh ' + kind); c.setAttribute('transform', `translate(${x},${y})`);
      c.innerHTML = kind === 'pt' ? `<circle r="${hit}" class="wh-hit"/><circle r="${rr}" class="wh-dot"/>`
        : `<circle r="${hit}" class="wh-hit"/><circle r="${rr * 0.85}" class="wh-mid"/><path d="M${-rr * 0.45},0H${rr * 0.45}M0,${-rr * 0.45}V${rr * 0.45}" class="wh-plus"/>`;
      c.addEventListener('pointerdown', (e) => this._handleDown(e, w, kind, idx));
      g.append(c);
    };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 26 / Math.min(1, z)) mk((a.x + b.x) / 2, (a.y + b.y) / 2, 'mid', i);
    }
    w.pts.forEach((q, i) => mk(q.x, q.y, 'pt', i));
  }
  _handleDown(e, w, kind, idx) {
    e.stopPropagation(); e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (kind === 'pt' && this._lastTap && this._lastTap.w === w.id && this._lastTap.i === idx && now - this._lastTap.t < 350) {   // double-tap: remove the bend
      w.pts.splice(idx, 1); this._lastTap = null; this._drawWire(w); this._drawHandles(w); this.emit('change', { structural: false }); return;
    }
    this._lastTap = { w: w.id, i: idx, t: now };
    let i = idx, inserted = false, moved = false; const sx = e.clientX, sy = e.clientY;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true;
      const p = this.toWorld(ev.clientX, ev.clientY), q = { x: Math.round(p.x / this.snap) * this.snap, y: Math.round(p.y / this.snap) * this.snap };
      if (kind === 'mid' && !inserted) { w.pts.splice(i, 0, q); inserted = true; } else w.pts[i] = q;
      this._drawWire(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (moved) { this._lastTap = null; this._drawHandles(w); this.emit('change', { structural: false }); }
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  /** orthogonal route: leave each pin straight out, then horizontal / vertical runs (grid-aligned) */
  _tidyPts(w) {
    const pa = this.pinPos(w.a), pb = this.pinPos(w.b); if (!pa || !pb) return [];
    const da = this._dir(pa), db = this._dir(pb), L = 15, s = this.snap, sn = (v) => Math.round(v / s) * s;
    const p1 = { x: sn(pa.x + da[0] * L), y: sn(pa.y + da[1] * L) }, p2 = { x: sn(pb.x + db[0] * L), y: sn(pb.y + db[1] * L) };
    const ha = da[0] !== 0, hb = db[0] !== 0, pts = [p1];
    if (ha && hb) { const mx = sn((p1.x + p2.x) / 2); pts.push({ x: mx, y: p1.y }, { x: mx, y: p2.y }); }
    else if (!ha && !hb) { const my = sn((p1.y + p2.y) / 2); pts.push({ x: p1.x, y: my }, { x: p2.x, y: my }); }
    else if (ha) pts.push({ x: p2.x, y: p1.y });
    else pts.push({ x: p1.x, y: p2.y });
    pts.push(p2);
    // drop duplicates and points on a straight line (incl. the pin ends)
    const all = [pa, ...pts, pb], out = [];
    for (let i = 1; i < all.length - 1; i++) {
      const a = out.length ? out[out.length - 1] : all[0], c = all[i], n = all[i + 1];
      if ((c.x === a.x && c.y === a.y) || (c.x === n.x && c.y === n.y)) continue;
      if ((a.x === c.x && c.x === n.x) || (a.y === c.y && c.y === n.y)) continue;
      out.push(c);
    }
    return out;
  }
  /** tidy one wire (id) or all wires: orthogonal routes */
  tidyWires(id) {
    const ws = this.wires.filter((w) => !w.plug && (id === undefined || w.id === id));
    for (const w of ws) { w.pts = this._tidyPts(w); this._drawWire(w); }
    if (ws.length) this.emit('change', { structural: false });
    return ws.length;
  }
  clearBends(id) { const w = this.wires.find((x) => x.id === id); if (w && w.pts.length) { w.pts = []; this._drawWire(w); this.handlesSvg.replaceChildren(); this._drawHandles(w); this.emit('change', { structural: false }); } }
  _markWired() {
    const set = new Set(); for (const w of this.wires) { set.add(w.a); set.add(w.b); }
    for (const p of this.parts.values()) for (const d of p.pins.children) d.classList.toggle('wired', set.has(`${p.id}:${d.dataset.pin}`));
  }

  // ---------------------------------------------------------------- selection
  select(sel) {
    this.selected = sel;
    for (const p of this.parts.values()) p.wrap.classList.toggle('sel', sel?.kind === 'part' && sel.id === p.id);
    for (const w of this.wires) w.g.classList.toggle('sel', sel?.kind === 'wire' && sel.id === w.id);
    const sw = sel?.kind === 'wire' ? this.wires.find((x) => x.id === sel.id) : null;
    if (sw) this._drawHandles(sw); else this.handlesSvg.replaceChildren();
    this.emit('select', sel);
  }
  deleteSelected() {
    const s = this.selected; if (!s) return;
    if (s.kind === 'part') this.removePart(s.id);
    else { const w = this.wires.find((x) => x.id === s.id); if (w) this._removeWire(w); }
  }

  // ---------------------------------------------------------------- view
  _applyView() {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    const s = 24 * this.zoom;
    this.viewport.style.backgroundSize = `${s}px ${s}px`; this.viewport.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
  }
  toWorld(cx, cy) { const r = this.viewport.getBoundingClientRect(); return { x: (cx - r.left - this.pan.x) / this.zoom, y: (cy - r.top - this.pan.y) / this.zoom }; }
  zoomAt(factor, cx, cy) {
    const r = this.viewport.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top;
    const nz = Math.min(3, Math.max(0.15, this.zoom * factor)); const k = nz / this.zoom;
    this.pan.x = px - (px - this.pan.x) * k; this.pan.y = py - (py - this.pan.y) * k; this.zoom = nz; this._applyView();
  }
  fit() {
    const ps = [...this.parts.values()]; const r = this.viewport.getBoundingClientRect();
    if (!ps.length || r.width < 10) { this.zoom = 1; this.pan = { x: 40, y: 40 }; this._applyView(); return; }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of ps) {
      const [w, h] = p.size[0] ? p.size : [80, 80]; const sw = p.rot & 1 ? h : w, sh = p.rot & 1 ? w : h; const cx = p.left + w / 2, cy = p.top + h / 2;
      x0 = Math.min(x0, cx - sw / 2); y0 = Math.min(y0, cy - sh / 2 - 20); x1 = Math.max(x1, cx + sw / 2); y1 = Math.max(y1, cy + sh / 2);
    }
    // keep clear of the floating toolbar (top) and the status pill (bottom)
    const padX = 30, padTop = r.width < 700 ? 120 : 72, padBot = 52, ah = Math.max(80, r.height - padTop - padBot);
    const z = Math.min(1.4, Math.max(0.2, Math.min((r.width - padX * 2) / (x1 - x0), ah / (y1 - y0))));
    this.zoom = z; this.pan = { x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: padTop + (ah - (y1 - y0) * z) / 2 - y0 * z }; this._applyView();
  }
  _hint() { this.emptyHint.hidden = this.parts.size > 0; }

  // ---------------------------------------------------------------- interaction
  _bind() {
    const vp = this.viewport; let drag = null, pan = null, spaceDown = false, pinch = null;
    const touches = new Map();
    this._pointerWorld = { x: 0, y: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { spaceDown = true; }
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      const sel = this.selected; const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { this.cancelWire(); this.select(null); }
      else if (e.key.toLowerCase() === 'b' && !mod) { this.setBbMode(this.bbMode === 'wire' ? 'move' : 'wire'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); this.deleteSelected(); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      else if (mod && e.key.toLowerCase() === 'd' && sel?.kind === 'part') { e.preventDefault(); this.duplicate(sel.id); }
      else if (e.key.toLowerCase() === 'r' && !mod && sel?.kind === 'part') { e.preventDefault(); this.rotate(sel.id, e.shiftKey ? -1 : 1); }
      else if (sel?.kind === 'part' && e.key.startsWith('Arrow')) {
        e.preventDefault(); const p = this.parts.get(sel.id), st = e.shiftKey ? 20 : 5;
        p.left += e.key === 'ArrowRight' ? st : e.key === 'ArrowLeft' ? -st : 0; p.top += e.key === 'ArrowDown' ? st : e.key === 'ArrowUp' ? -st : 0;
        this._place(p); this._redrawWires(); this.emit('change', { structural: false });
      }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else { this.pan.x -= e.deltaX; this.pan.y -= e.deltaY; this._applyView(); }
    }, { passive: false });
    // Safari trackpad pinch
    vp.addEventListener('gesturestart', (e) => e.preventDefault());

    const startPinch = () => {
      const [a, b] = [...touches.values()];
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, r = vp.getBoundingClientRect();
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: this.zoom, wx: (c.x - r.left - this.pan.x) / this.zoom, wy: (c.y - r.top - this.pan.y) / this.zoom };
      if (drag) { drag.part.left = drag.l; drag.part.top = drag.t; for (const o of drag.others) { o.p.left = o.l; o.p.top = o.t; this._place(o.p); } this._place(drag.part); this._redrawWires(); }
      drag = null; pan = null; if (this.pending) this.pending.dragging = false;   // zooming keeps the wire being drawn
    };

    vp.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') { touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (touches.size === 2) { startPinch(); return; } if (touches.size > 2) return; }
      // fingers are imprecise: snap a touch to the nearest pin within ~16 screen px
      // the pin layer lies above every part, so breadboard holes hidden under a component's body would steal the
      // click; a component on top of the breadboard owns the area it covers
      const cover = this._componentUnder(e.clientX, e.clientY);
      let pinEl = e.pointerType === 'touch' ? this._nearestPinEl(e.clientX, e.clientY, 16, !!cover) || e.target.closest?.('.pin') : e.target.closest?.('.pin') || (this.pending ? this._nearestPinEl(e.clientX, e.clientY, 10, !!cover) : null);
      if (pinEl && cover && pinEl.dataset.pid !== cover.dataset.id && isBB(this.parts.get(pinEl.dataset.pid)?.type)) pinEl = null;
      const partEl = e.target.closest?.('.part') || (pinEl ? null : cover);
      // "Geser" mode: a hole of a breadboard grabs the breadboard itself (unless a wire is waiting for its end point)
      const bbHole = pinEl && !this.pending && this.bbMode === 'move' && isBB(this.parts.get(pinEl.dataset.pid)?.type) ? this.parts.get(pinEl.dataset.pid) : null;
      if (bbHole && e.button === 0) {
        this.select({ kind: 'part', id: bbHole.id }); vp.focus({ preventScroll: true }); this.pinTip.hidden = true;
        drag = { part: bbHole, sx: e.clientX, sy: e.clientY, l: bbHole.left, t: bbHole.top, moved: false, others: [] }; vp.setPointerCapture(e.pointerId);
        e.preventDefault(); return;
      }
      if (pinEl && e.button === 0 && !(this.interactive && !this.pending && partEl)) { e.preventDefault(); this._pinDown(pinEl); if (this.pending) { this.pending.sx = e.clientX; this.pending.sy = e.clientY; } this._showTip(pinEl); return; }
      // while a wire waits for its end: dragging anywhere (empty space or a part body) pans the view, a tap adds a bend point
      if (e.button === 1 || spaceDown || (!partEl && e.button === 0) || (this.pending && e.button === 0)) {
        const tap = e.button === 0 && !spaceDown;
        if (tap && !this.pending) { this.select(null); this.pinTip.hidden = true; }
        pan = { sx: e.clientX, sy: e.clientY, px: this.pan.x, py: this.pan.y, tap, moved: false }; vp.setPointerCapture(e.pointerId); vp.classList.add('grabbing'); e.preventDefault(); return;
      }
      if (partEl && e.button === 0) {
        const part = this.parts.get(partEl.dataset.id); this.select({ kind: 'part', id: part.id }); vp.focus({ preventScroll: true });
        const onGrip = e.target.classList?.contains('grip');
        if (!this.interactive || onGrip || isBB(part.type)) {
          // every part moves on its own: a breadboard does not drag its components along (contacts are re-made from geometry)
          drag = { part, sx: e.clientX, sy: e.clientY, l: part.left, t: part.top, moved: false, others: [] }; vp.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      }
    });

    vp.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()]; const r = vp.getBoundingClientRect();
        const z = Math.min(3, Math.max(0.15, pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0));
        const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
        this.zoom = z; this.pan = { x: cx - pinch.wx * z, y: cy - pinch.wy * z }; this._applyView(); return;
      }
      this._pointerWorld = this.toWorld(e.clientX, e.clientY);
      if (pan) {
        if (!pan.moved && Math.hypot(e.clientX - pan.sx, e.clientY - pan.sy) < (e.pointerType === 'touch' ? 8 : 4)) return;
        pan.moved = true; this.pan.x = pan.px + e.clientX - pan.sx; this.pan.y = pan.py + e.clientY - pan.sy; this._applyView(); return;
      }
      if (drag) {
        const dx = (e.clientX - drag.sx) / this.zoom, dy = (e.clientY - drag.sy) / this.zoom;
        if (!drag.moved && Math.hypot(dx, dy) < (e.pointerType === 'touch' ? 6 : 3)) return;
        drag.moved = true; const s = this.snap;
        const nl = Math.round((drag.l + dx) / s) * s, nt = Math.round((drag.t + dy) / s) * s;
        for (const o of drag.others) { o.p.left = o.l + (nl - drag.l); o.p.top = o.t + (nt - drag.t); this._place(o.p); }
        drag.part.left = nl; drag.part.top = nt;
        this._place(drag.part); this._redrawWires();
        return;
      }
      if (this.pending) { this._snapTarget(e); this._drawGhost(); if (this.pending.dragging) this._edgePan(e.clientX, e.clientY, e.pointerType); }
      if (e.pointerType === 'mouse') { const pinEl = e.target.closest?.('.pin'); if (pinEl) this._showTip(pinEl); else this.pinTip.hidden = true; }
    });

    const end = (e) => {
      if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (pinch) { if (touches.size < 2) pinch = null; return; } }
      if (pan) {
        if (pan.tap && !pan.moved && e.type === 'pointerup') {
          if (this.pending) { const w = this.toWorld(e.clientX, e.clientY), s = this.snap; (this.pending.pts ||= []).push({ x: Math.round(w.x / s) * s, y: Math.round(w.y / s) * s }); this._drawGhost(); }
        }
        pan = null; vp.classList.remove('grabbing');
      }
      this._edgePan(null);
      if (drag) {
        if (drag.moved) { this._plug(drag.part, !isBB(drag.part.type)); this._markWired(); this._redrawWires(); this.emit('change', { structural: false }); }
        drag = null;
      }
      if (this.pending?.dragging) {
        this._snapTarget(e);
        const pinEl = this._snapEl || (e.pointerType === 'touch' && this._nearestPinEl(e.clientX, e.clientY, 16)) || document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pin');
        if (pinEl && !(pinEl.dataset.pid === this.pending.pid && pinEl.dataset.pin === this.pending.pin)) this._pinDown(pinEl);
        // released over empty space: the wire stays open (tap the target pin, pan / zoom freely, tap empty space for bends)
        else if (this.pending) { this.pending.dragging = false; this._snapEl?.classList.remove('snap'); this._snapEl = null; this._drawGhost(); }
      }
    };
    vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);

    // palette drag & drop (mouse) — touch devices add parts by tapping the palette card
    vp.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-part')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    vp.addEventListener('drop', (e) => {
      const tag = e.dataTransfer.getData('text/x-part'); if (!tag) return; e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY); this.addPart(tag, Math.round((w.x - 20) / 5) * 5, Math.round((w.y - 20) / 5) * 5);
    });
  }

  /** the topmost non-breadboard component whose body is under a screen point (null = none) */
  _componentUnder(cx, cy) {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const pe = el.closest?.('.part'); if (!pe) continue;
      const part = this.parts.get(pe.dataset.id);
      if (part && !isBB(part.type)) return pe;
    }
    return null;
  }

  _nearestPinEl(cx, cy, radius, skipBB = false) {
    const w = this.toWorld(cx, cy), r = radius / this.zoom; let best = null, bd = r;
    for (const part of this.parts.values()) {
      if (skipBB && isBB(part.type)) continue;
      const [pw, ph] = part.size; const m = r + 4;
      if (w.x < part.left - m || w.y < part.top - m || w.x > part.left + Math.max(pw, ph) + m || w.y > part.top + Math.max(pw, ph) + m) continue;
      for (const info of part.pinInfo) {
        const q = this._xf(part, info.x, info.y); const d = Math.hypot(part.left + q.x - w.x, part.top + q.y - w.y);
        if (d < bd) { bd = d; best = [part, info.name]; }
      }
    }
    if (!best) return null;
    return [...best[0].pins.children].find((d) => d.dataset.pin === best[1]) || null;
  }

  /** auto-pan while a wire is dragged near the viewport edge (call with null to stop) */
  _edgePan(cx, cy, pointerType) {
    if (cx == null) { cancelAnimationFrame(this._edgeRaf); this._edgeRaf = 0; this._edgeAt = null; return; }
    this._edgeAt = { cx, cy, pointerType };
    if (this._edgeRaf) return;
    const step = () => {
      const at = this._edgeAt; if (!at || !this.pending?.dragging) { this._edgeRaf = 0; return; }
      const r = this.viewport.getBoundingClientRect(), m = 40, sp = 12;
      const dx = at.cx < r.left + m ? sp : at.cx > r.right - m ? -sp : 0, dy = at.cy < r.top + m ? sp : at.cy > r.bottom - m ? -sp : 0;
      if (dx || dy) { this.pan.x += dx; this.pan.y += dy; this._applyView(); this._pointerWorld = this.toWorld(at.cx, at.cy);
        this._snapTarget({ clientX: at.cx, clientY: at.cy, pointerType: at.pointerType, target: document.elementFromPoint(at.cx, at.cy) || this.viewport }); this._drawGhost(); }
      this._edgeRaf = requestAnimationFrame(step);
    };
    this._edgeRaf = requestAnimationFrame(step);
  }
  /** while a wire is dragged: the pin within reach of the pointer becomes the target (highlighted, the ghost snaps to it) */
  _snapTarget(e) {
    const el = this.pending?.dragging ? ((e.pointerType === 'touch' ? null : e.target?.closest?.('.pin')) || this._nearestPinEl(e.clientX, e.clientY, e.pointerType === 'touch' ? 22 : 12, !!this._componentUnder(e.clientX, e.clientY))) : null;
    const ok = el && !(el.dataset.pid === this.pending.pid && el.dataset.pin === this.pending.pin) ? el : null;
    if (ok !== this._snapEl) { this._snapEl?.classList.remove('snap'); ok?.classList.add('snap'); this._snapEl = ok; if (ok) this._showTip(ok); }
  }
  undoBend() { if (this.pending?.pts?.length) { this.pending.pts.pop(); this._drawGhost(); } }
  _pinDown(pinEl) {
    const ref = `${pinEl.dataset.pid}:${pinEl.dataset.pin}`;
    if (!this.pending) {
      this.pending = { pid: pinEl.dataset.pid, pin: pinEl.dataset.pin, ref, dragging: true, pts: [] };
      pinEl.classList.add('active'); this.wireHint.hidden = false; this._drawGhost(); return;
    }
    const a = this.pending.ref, pts = this.pending.pts?.length ? this.pending.pts.map((q) => [q.x, q.y]) : null; this.cancelWire();
    if (a === ref) return;
    const w = this._addWire(a, ref, null, false, false, pts);
    if (w) { this.select({ kind: 'wire', id: w.id }); this.emit('change', { structural: true }); }
  }
  setBbMode(m) {
    this.bbMode = m === 'move' ? 'move' : 'wire';
    this.viewport.classList.toggle('bb-move', this.bbMode === 'move');
    if (this.bbMode === 'move') this.cancelWire();
    this.emit('bbmode', this.bbMode);
  }
  hasBreadboard() { for (const p of this.parts.values()) if (isBB(p.type)) return true; return false; }
  cancelWire() {
    this.pending = null; this.ghost.style.display = 'none'; this.wireHint.hidden = true; this._snapEl?.classList.remove('snap'); this._snapEl = null;
    this.pinLayer.querySelectorAll('.pin.active').forEach((d) => d.classList.remove('active'));
  }
  _drawGhost() {
    const pa = this.pinPos(this.pending.ref); if (!pa) return;
    const w = this._snapEl ? this.pinPos(`${this._snapEl.dataset.pid}:${this._snapEl.dataset.pin}`) || this._pointerWorld : this._pointerWorld;
    this.ghost.setAttribute('d', this._wireD(pa, { x: w.x, y: w.y, part: null }, this.pending.pts)); this.ghost.style.display = '';
  }
  pinLabel(part, info) { return info.label && info.label !== (/^\d+\.\d+V$/.test(info.name) ? info.name : info.name.split('.')[0]) ? info.label : (isBB(part.type) ? info.description : info.name); }
  _showTip(pinEl) {
    const part = this.parts.get(pinEl.dataset.pid); const info = part?.pinInfo.find((p) => p.name === pinEl.dataset.pin); if (!info) return;
    const sig = (info.signals || []).map((s) => (s.type === 'power' ? s.signal : s.type === 'analog' ? 'ADC' + (s.channel ?? '') : s.type === 'pwm' ? 'PWM' : `${s.type.toUpperCase()} ${s.signal}`)).join(' · ');
    const cat = BY_TAG[part.type]; const gpio = cat?.gpio?.[info.name];
    const desc = isBB(part.type) ? '' : info.description;
    this.pinTip.textContent = `${part.id}.${this.pinLabel(part, info)}${gpio !== undefined && typeof gpio === 'number' ? ` (GPIO${gpio})` : ''}${desc ? ' – ' + desc : ''}${sig ? '  [' + sig + ']' : ''}`;
    const q = this._xf(part, info.x, info.y);
    this.pinTip.style.left = part.left + q.x + 'px'; this.pinTip.style.top = part.top + q.y + 'px'; this.pinTip.hidden = false;
    clearTimeout(this._tipT); this._tipT = setTimeout(() => { this.pinTip.hidden = true; }, 2500);
  }
}
