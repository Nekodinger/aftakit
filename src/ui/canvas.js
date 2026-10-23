// Circuit editor: parts (Wokwi web components), pin hotspots, wires, selection, pan/zoom.
import { BY_TAG, propDefaults } from '../catalog.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ID_BASE = {
  'wokwi-arduino-uno': 'uno', 'wokwi-arduino-nano': 'nano', 'wokwi-led': 'led', 'wokwi-rgb-led': 'rgb', 'wokwi-resistor': 'r',
  'wokwi-pushbutton': 'btn', 'wokwi-pushbutton-6mm': 'btn', 'wokwi-slide-switch': 'sw', 'wokwi-potentiometer': 'pot',
  'wokwi-slide-potentiometer': 'spot', 'wokwi-buzzer': 'bz', 'wokwi-servo': 'servo', 'wokwi-7segment': 'seg', 'wokwi-lcd1602': 'lcd',
  'wokwi-lcd2004': 'lcd', 'wokwi-neopixel': 'px', 'wokwi-led-bar-graph': 'bar', 'wokwi-photoresistor-sensor': 'ldr',
  'wokwi-ntc-temperature-sensor': 'ntc', 'wokwi-hc-sr04': 'sonar', 'wokwi-membrane-keypad': 'keypad', 'wokwi-led-ring': 'ring',
  'wokwi-neopixel-matrix': 'matrix', 'wokwi-analog-joystick': 'joy', 'wokwi-pir-motion-sensor': 'pir', 'wokwi-gas-sensor': 'gas',
  'wokwi-ky-040': 'enc', 'wokwi-dip-switch-8': 'dip', 'wokwi-tilt-switch': 'tilt',
};
const SIGNAL_COLORS = ['#f5a524', '#3ecf8e', '#4da3ff', '#c084fc', '#22d3ee', '#fb7185', '#a3e635', '#fb923c'];
const baseName = (p) => p.split('.')[0];

export class CircuitCanvas {
  constructor(refs) {
    Object.assign(this, refs); // viewport, world, wiresSvg, partsHost, pinLayer, emptyHint, zoomLabel, wireHint
    this.parts = new Map(); this.wires = []; this.handlers = {};
    this.pan = { x: 40, y: 40 }; this.zoom = 1;
    this.selected = null; this.pending = null; this.colorIdx = 0; this.interactive = false; this.nextWire = 1;
    this.pinTip = document.createElement('div'); this.pinTip.className = 'pin-tip'; this.pinTip.hidden = true; this.pinLayer.append(this.pinTip);
    this.ghost = document.createElementNS(SVGNS, 'path'); this.ghost.setAttribute('class', 'wire ghost'); this.ghost.style.display = 'none'; this.wiresSvg.append(this.ghost);
    this._bind(); this._applyView();
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
  emit(evt, data) { for (const f of this.handlers[evt] || []) f(data); }

  // ---------------------------------------------------------------- model
  getModel() {
    return {
      version: 1,
      parts: [...this.parts.values()].map((p) => ({ id: p.id, type: p.type, left: Math.round(p.left), top: Math.round(p.top), attrs: { ...p.attrs } })),
      connections: this.wires.map((w) => [w.a, w.b, w.color]),
    };
  }
  elements() { return new Map([...this.parts].map(([id, p]) => [id, p.el])); }
  simModel() { return { parts: [...this.parts.values()].map((p) => ({ id: p.id, type: p.type, left: p.left, top: p.top, attrs: p.attrs })), connections: this.wires.map((w) => [w.a, w.b]) }; }

  async setModel(model) {
    this.clear(true);
    const pending = [];
    for (const p of model.parts || []) {
      if (!BY_TAG[p.type]) { this.emit('toast', { text: `Komponen tidak dikenal dilewati: ${p.type}`, err: true }); continue; }
      pending.push(this._create(p.type, p.left, p.top, p.attrs, p.id));
    }
    await Promise.all(pending);
    for (const [a, b, color] of model.connections || []) this._addWire(a, b, color, true);
    this._refreshAll(); this._hint(); this.emit('model');
    this.fit();
  }

  clear(silent) {
    for (const p of this.parts.values()) { p.wrap.remove(); p.pins.remove(); }
    this.parts.clear(); for (const w of this.wires) w.g.remove(); this.wires = []; this.select(null);
    this._hint();
    if (!silent) this.emit('change', { structural: true });
  }

  // ---------------------------------------------------------------- parts
  _newId(type) {
    const base = ID_BASE[type] || type.replace(/^wokwi-/, '').split('-')[0];
    if (!this.parts.has(base) && BY_TAG[type]?.board) return base;
    let i = 1; while (this.parts.has(base + i)) i++;
    return base + i;
  }

  async addPart(type, x, y, attrs) {
    const cat = BY_TAG[type];
    if (cat?.board && [...this.parts.values()].some((p) => BY_TAG[p.type]?.board)) {
      this.emit('toast', { text: 'Rangkaian hanya boleh punya satu board Arduino.', err: true }); return null;
    }
    const part = await this._create(type, x, y, attrs);
    this._hint(); this.select({ kind: 'part', id: part.id });
    this.emit('change', { structural: true });
    return part.id;
  }

  async _create(type, x, y, attrs, id) {
    const cat = BY_TAG[type];
    id = id || this._newId(type);
    const el = document.createElement(type); el.className = 'el';
    const wrap = document.createElement('div'); wrap.className = 'part' + (cat?.sim === 'visual' ? ' vis-only' : ''); wrap.dataset.id = id;
    const grip = document.createElement('span'); grip.className = 'grip'; grip.textContent = id;
    const selBox = document.createElement('div'); selBox.className = 'sel-box';
    wrap.append(selBox, grip, el);
    const pins = document.createElement('div'); pins.className = 'pinbox'; pins.style.cssText = 'position:absolute;left:0;top:0';
    const part = { id, type, left: x ?? 0, top: y ?? 0, attrs: { ...propDefaults(type), ...(attrs || {}) }, el, wrap, grip, pins, pinInfo: [], size: [0, 0] };
    this.parts.set(id, part);
    this.applyAttrs(part);
    this.partsHost.append(wrap); this.pinLayer.append(pins);
    this._place(part);
    el.addEventListener('pininfo-change', () => this._refreshPins(part));
    if (type === 'wokwi-potentiometer' || type === 'wokwi-slide-potentiometer') {
      el.addEventListener('input', () => { const mn = el.min ?? 0, mx = el.max ?? 100; part.attrs.value = Math.round(((+el.value - mn) / (mx - mn)) * 100); this.emit('attrs', part.id); });
    }
    await (el.updateComplete || Promise.resolve());
    this._refreshPins(part);
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
      if (k in el) { try { el[k] = k === 'pixels' ? +v : v; } catch { /* readonly */ } }
    }
    if (type === 'wokwi-resistor') el.value = String(attrs.value);
  }

  _place(part) { part.wrap.style.left = part.pins.style.left = part.left + 'px'; part.wrap.style.top = part.pins.style.top = part.top + 'px'; }

  _refreshPins(part) {
    const el = part.el; let info = [];
    try { info = el.pinInfo || []; } catch { /* element not ready */ }
    part.pinInfo = info; part.size = [el.offsetWidth || 0, el.offsetHeight || 0];
    part.pins.textContent = '';
    for (const p of info) {
      const d = document.createElement('div'); d.className = 'pin'; d.style.left = p.x + 'px'; d.style.top = p.y + 'px';
      d.dataset.pid = part.id; d.dataset.pin = p.name;
      part.pins.append(d);
    }
    this._markWired(); this._redrawWires();
  }
  _refreshAll() { for (const p of this.parts.values()) this._refreshPins(p); }

  pinPos(ref) {
    const [id, ...rest] = ref.split(':'); const pin = rest.join(':');
    const part = this.parts.get(id); if (!part) return null;
    const info = part.pinInfo.find((p) => p.name === pin); if (!info) return null;
    return { x: part.left + info.x, y: part.top + info.y, part, info };
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
    const nid = await this.addPart(p.type, p.left + 24, p.top + 24, p.attrs); return nid;
  }

  // ---------------------------------------------------------------- wires
  _autoColor(a, b) {
    const names = [a, b].map((r) => baseName(r.split(':').slice(1).join(':')));
    if (names.includes('GND') || names.includes('VSS') || names.includes('K') && false) return '#8f9bad';
    if (names.some((n) => ['5V', '3.3V', 'VCC', 'VIN', 'V+', 'VDD', 'IOREF'].includes(n))) return '#ef4b52';
    return SIGNAL_COLORS[this.colorIdx++ % SIGNAL_COLORS.length];
  }

  _addWire(a, b, color, silent) {
    if (a === b || !this.pinPos(a) || !this.pinPos(b)) { if (!silent) this.emit('toast', { text: 'Pin tidak valid.', err: true }); return null; }
    if (this.wires.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a))) return null;
    const g = document.createElementNS(SVGNS, 'g'); g.setAttribute('class', 'wire-wrap');
    const hit = document.createElementNS(SVGNS, 'path'); hit.setAttribute('class', 'wire-hit');
    const under = document.createElementNS(SVGNS, 'path'); under.setAttribute('class', 'wire'); under.style.stroke = '#000a'; under.style.strokeWidth = '5.4'; under.style.pointerEvents = 'none';
    const path = document.createElementNS(SVGNS, 'path'); path.setAttribute('class', 'wire');
    color = color || this._autoColor(a, b); path.style.stroke = color;
    g.append(hit, under, path);
    const w = { id: this.nextWire++, a, b, color, g, hit, under, path };
    g.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.select({ kind: 'wire', id: w.id }); this.viewport.focus(); });
    this.wiresSvg.insertBefore(g, this.ghost);
    this.wires.push(w); this._drawWire(w); this._markWired();
    return w;
  }
  _removeWire(w, silent) {
    w.g.remove(); this.wires = this.wires.filter((x) => x !== w); this._markWired();
    if (this.selected?.kind === 'wire' && this.selected.id === w.id) this.select(null);
    if (!silent) this.emit('change', { structural: true });
  }

  _dir(pos) {
    const [w, h] = pos.part.size; const x = pos.info.x, y = pos.info.y;
    const d = [[x, [-1, 0]], [w - x, [1, 0]], [y, [0, -1]], [h - y, [0, 1]]].sort((p, q) => p[0] - q[0])[0];
    return d[1];
  }
  _curve(pa, pb) {
    const da = this._dir(pa), db = pb.part ? this._dir(pb) : [0, 0];
    const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y), off = Math.min(Math.max(dist * 0.45, 28), 150);
    return `M${pa.x},${pa.y} C${pa.x + da[0] * off},${pa.y + da[1] * off} ${pb.x + db[0] * off},${pb.y + db[1] * off} ${pb.x},${pb.y}`;
  }
  _drawWire(w) {
    const pa = this.pinPos(w.a), pb = this.pinPos(w.b); if (!pa || !pb) return;
    const d = this._curve(pa, pb); w.hit.setAttribute('d', d); w.under.setAttribute('d', d); w.path.setAttribute('d', d);
  }
  _redrawWires() { for (const w of this.wires) this._drawWire(w); }
  _markWired() {
    const set = new Set(); for (const w of this.wires) { set.add(w.a); set.add(w.b); }
    for (const p of this.parts.values()) for (const d of p.pins.children) d.classList.toggle('wired', set.has(`${p.id}:${d.dataset.pin}`));
  }

  // ---------------------------------------------------------------- selection
  select(sel) {
    this.selected = sel;
    for (const p of this.parts.values()) p.wrap.classList.toggle('sel', sel?.kind === 'part' && sel.id === p.id);
    for (const w of this.wires) w.g.classList.toggle('sel', sel?.kind === 'wire' && sel.id === w.id);
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
    this.viewport.style.backgroundImage = 'radial-gradient(circle, var(--dot) 1.2px, transparent 1.4px)';
    this.viewport.style.backgroundSize = `${s}px ${s}px`; this.viewport.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
  }
  toWorld(cx, cy) { const r = this.viewport.getBoundingClientRect(); return { x: (cx - r.left - this.pan.x) / this.zoom, y: (cy - r.top - this.pan.y) / this.zoom }; }
  zoomAt(factor, cx, cy) {
    const r = this.viewport.getBoundingClientRect();
    const px = (cx ?? r.left + r.width / 2) - r.left, py = (cy ?? r.top + r.height / 2) - r.top;
    const nz = Math.min(2.5, Math.max(0.2, this.zoom * factor)); const k = nz / this.zoom;
    this.pan.x = px - (px - this.pan.x) * k; this.pan.y = py - (py - this.pan.y) * k; this.zoom = nz; this._applyView();
  }
  fit() {
    const ps = [...this.parts.values()]; const r = this.viewport.getBoundingClientRect();
    if (!ps.length || r.width < 10) { this.zoom = 1; this.pan = { x: 40, y: 40 }; this._applyView(); return; }
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of ps) { const [w, h] = p.size[0] ? p.size : [80, 80]; x0 = Math.min(x0, p.left); y0 = Math.min(y0, p.top - 20); x1 = Math.max(x1, p.left + w); y1 = Math.max(y1, p.top + h); }
    const pad = 36, z = Math.min(1.25, Math.max(0.25, Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0))));
    this.zoom = z; this.pan = { x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z }; this._applyView();
  }
  _hint() { this.emptyHint.hidden = this.parts.size > 0; }

  // ---------------------------------------------------------------- interaction
  _bind() {
    const vp = this.viewport; let drag = null, pan = null, spaceDown = false;
    this._pointerWorld = { x: 0, y: 0 };

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { spaceDown = true; }
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
      const sel = this.selected;
      if (e.key === 'Escape') { this.cancelWire(); this.select(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); this.deleteSelected(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel?.kind === 'part') { e.preventDefault(); this.duplicate(sel.id); }
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

    vp.addEventListener('pointerdown', (e) => {
      const pinEl = e.target.closest?.('.pin');
      const partEl = e.target.closest?.('.part');
      if (pinEl && e.button === 0) { e.preventDefault(); this._pinDown(pinEl); return; }
      if (e.button === 1 || spaceDown || (!partEl && e.button === 0)) {
        if (!partEl && e.button === 0 && !spaceDown) { this.cancelWire(); this.select(null); }
        pan = { sx: e.clientX, sy: e.clientY, px: this.pan.x, py: this.pan.y }; vp.setPointerCapture(e.pointerId); vp.style.cursor = 'grabbing'; e.preventDefault(); return;
      }
      if (partEl && e.button === 0) {
        const part = this.parts.get(partEl.dataset.id); this.select({ kind: 'part', id: part.id }); vp.focus({ preventScroll: true });
        const onGrip = e.target.classList?.contains('grip');
        if (!this.interactive || onGrip) {
          drag = { part, sx: e.clientX, sy: e.clientY, l: part.left, t: part.top, moved: false }; vp.setPointerCapture(e.pointerId);
          if (onGrip) e.preventDefault();
        }
      }
    });

    vp.addEventListener('pointermove', (e) => {
      this._pointerWorld = this.toWorld(e.clientX, e.clientY);
      if (pan) { this.pan.x = pan.px + e.clientX - pan.sx; this.pan.y = pan.py + e.clientY - pan.sy; this._applyView(); return; }
      if (drag) {
        const dx = (e.clientX - drag.sx) / this.zoom, dy = (e.clientY - drag.sy) / this.zoom;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        drag.part.left = Math.round((drag.l + dx) / 5) * 5; drag.part.top = Math.round((drag.t + dy) / 5) * 5;
        this._place(drag.part); this._redrawWires();
        return;
      }
      if (this.pending) this._drawGhost();
      const pinEl = e.target.closest?.('.pin');
      if (pinEl) this._showTip(pinEl); else this.pinTip.hidden = true;
    });

    const end = (e) => {
      if (pan) { pan = null; vp.style.cursor = ''; }
      if (drag) { if (drag.moved) this.emit('change', { structural: false }); drag = null; }
      if (this.pending?.dragging) {
        const pinEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.pin');
        if (pinEl && !(pinEl.dataset.pid === this.pending.pid && pinEl.dataset.pin === this.pending.pin)) this._pinDown(pinEl);
        else if (this.pending) this.pending.dragging = false;
      }
    };
    vp.addEventListener('pointerup', end); vp.addEventListener('pointercancel', end);

    // palette drag & drop
    vp.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-part')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    vp.addEventListener('drop', (e) => {
      const tag = e.dataTransfer.getData('text/x-part'); if (!tag) return; e.preventDefault();
      const w = this.toWorld(e.clientX, e.clientY); this.addPart(tag, Math.round((w.x - 20) / 5) * 5, Math.round((w.y - 20) / 5) * 5);
    });
  }

  _pinDown(pinEl) {
    const ref = `${pinEl.dataset.pid}:${pinEl.dataset.pin}`;
    if (!this.pending) {
      this.pending = { pid: pinEl.dataset.pid, pin: pinEl.dataset.pin, ref, dragging: true };
      pinEl.classList.add('active'); this.wireHint.hidden = false; this._drawGhost(); return;
    }
    const a = this.pending.ref; this.cancelWire();
    if (a === ref) return;
    const w = this._addWire(a, ref);
    if (w) { this.select({ kind: 'wire', id: w.id }); this.emit('change', { structural: true }); }
  }
  cancelWire() {
    this.pending = null; this.ghost.style.display = 'none'; this.wireHint.hidden = true;
    this.pinLayer.querySelectorAll('.pin.active').forEach((d) => d.classList.remove('active'));
  }
  _drawGhost() {
    const pa = this.pinPos(this.pending.ref); if (!pa) return; const w = this._pointerWorld;
    this.ghost.setAttribute('d', this._curve(pa, { x: w.x, y: w.y, part: null })); this.ghost.style.stroke = '#19b4c4'; this.ghost.style.display = '';
  }
  _showTip(pinEl) {
    const part = this.parts.get(pinEl.dataset.pid); const info = part?.pinInfo.find((p) => p.name === pinEl.dataset.pin); if (!info) return;
    const sig = (info.signals || []).map((s) => (s.type === 'power' ? s.signal : s.type === 'analog' ? 'ADC' + (s.channel ?? '') : s.type === 'pwm' ? 'PWM' : `${s.type.toUpperCase()} ${s.signal}`)).join(' · ');
    this.pinTip.textContent = `${part.id}.${info.name}${info.description ? ' – ' + info.description : ''}${sig ? '  [' + sig + ']' : ''}`;
    this.pinTip.style.left = part.left + info.x + 'px'; this.pinTip.style.top = part.top + info.y + 'px'; this.pinTip.hidden = false;
  }
}
