// PCB designer core (no DOM): turns the working breadboard circuit into a 2-layer through-hole PCB.
//
//  1. netlist   — wires + breadboard strips (+ the board's internal GND/VCC pins) are merged into nets; the
//                 breadboard itself disappears, its connections become copper.
//  2. footprints— every part keeps the real pin geometry of its artwork (1 canvas px = 1/3.7795 mm, so a header
//                 is 2.54 mm pitch): MCU boards and modules plug into header sockets, discrete parts get their
//                 own pads, off-board parts (motors, batteries, servo …) get a 2.54 mm connector.
//  3. placement — the 2D arrangement, squeezed together without overlaps (or the user's own PCB placement).
//  4. routing   — grid A* maze router (0.5 mm grid, 8 directions, 2 layers, vias), nets shortest first,
//                 rip-up-and-retry; clearance 0.2 mm, signal 0.35 mm, power 0.6 mm.
//  5. output    — DRC report, RS-274X Gerbers (copper, mask, silkscreen, outline), Excellon drill, BOM — zipped.
import { SPEC } from '../ui/partspec.js';
import { textStrokes, textWidth } from './font.js';

export const PX = 1 / 3.7795;
const isBB = (t) => /breadboard/.test(t);
const OFFBOARD = new Set(['can', 'motor', 'servo', 'stepper', 'bat9v', 'cell18650', 'frame', 'car']);
export const RULES = { grid: 0.5, clr: 0.2, signal: 0.35, power: 0.6, via: 0.8, viaDrill: 0.4, edge: 1.0, margin: 3 };
const POWER = /^(GND|VCC|VIN|5V|3V3|3\.3V|VDD|VSS|V\+|BAT\+?|BAT-|\+|-|VBUS|VSYS|12V|E\+|E-)$/i;

// ------------------------------------------------------------------ footprints
function footprint(part, catalog) {
  const spec = SPEC[part.type] || {}, cat = catalog[part.type] || {};
  const [pw, ph] = part.size;
  const offboard = spec.pins === 'pads' || OFFBOARD.has(spec.special);
  const name = cat.name || part.type;
  if (offboard) {                                         // connector to an off-board part (2.54 mm header / JST)
    const n = part.pinInfo.length, w = n * 2.54, h = 2.54;
    return { id: part.id, type: part.type, name, kind: 'conn', w, h, body: [0, 0, w, h], pads: part.pinInfo.map((p, i) => ({ name: p.name, x: 1.27 + i * 2.54, y: 1.27, d: 1.7, drill: 1.0, sq: i === 0 })) };
  }
  const w = pw * PX, h = ph * PX, r = spec.pcb === false || !spec.pcb ? (spec.pcb === false ? null : [0, 0, 1, 1]) : spec.pcb;
  const small = /^wokwi-(led|rgb-led|resistor)$|^mod-(capacitor|diode|npn)$/.test(part.type);
  const drill = small ? 0.8 : 1.0, d = small ? 1.6 : 1.75;
  const pads = part.pinInfo.map((p, i) => ({ name: p.name, x: p.x * PX, y: p.y * PX, d, drill, sq: i === 0 }));
  let body = r ? [r[0] * w, r[1] * h, r[2] * w, r[3] * h] : [0, 0, w, h];
  if (small || !r) {                                      // outline hugs the pads for small discrete parts
    const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y), m = part.type === 'wokwi-led' || part.type === 'wokwi-rgb-led' ? 2.6 : 1.4;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const hw = Math.max((Math.max(...xs) - Math.min(...xs)) / 2 + 1.4, m), hh = Math.max((Math.max(...ys) - Math.min(...ys)) / 2 + 1.4, m);
    body = [cx - hw, cy - hh, cx + hw, cy + hh];
  }
  return { id: part.id, type: part.type, name, kind: cat.board || cat.cat === 'Mikrokontroler' ? 'board' : small ? 'part' : 'module', w, h, body, pads };
}

/** absolute position of a pad / rotated rectangle of a placed component */
export function padPos(c, p) {
  const k = c.rot & 3, dx = p.x - c.w / 2, dy = p.y - c.h / 2;
  const [rx, ry] = [[dx, dy], [-dy, dx], [-dx, -dy], [dy, -dx]][k];
  return { x: c.x + rx, y: c.y + ry };
}
export function bodyBox(c, m = 0) {
  const [x0, y0, x1, y1] = c.body, a = padPos(c, { x: x0, y: y0 }), b = padPos(c, { x: x1, y: y1 });
  const pads = c.pads.map((p) => padPos(c, p)), xs = [a.x, b.x, ...pads.map((q) => q.x - 1), ...pads.map((q) => q.x + 1)], ys = [a.y, b.y, ...pads.map((q) => q.y - 1), ...pads.map((q) => q.y + 1)];
  return { x0: Math.min(...xs) - m, y0: Math.min(...ys) - m, x1: Math.max(...xs) + m, y1: Math.max(...ys) + m };
}

// ------------------------------------------------------------------ netlist
export function netlist(parts, wires, catalog) {
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) { parent.set(x, x); return x; } let r = x; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const w of wires) union(w.a, w.b);
  for (const p of parts) {
    if (isBB(p.type)) { const g = new Map(); for (const i of p.pinInfo) { const k = i.name.split('.')[0]; if (g.has(k)) union(`${p.id}:${i.name}`, g.get(k)); else g.set(k, `${p.id}:${i.name}`); } }
    else if (catalog[p.type]?.board || catalog[p.type]?.cat === 'Mikrokontroler') {   // GND.1 / GND.2 … are one net inside the board
      const g = new Map(); for (const i of p.pinInfo) { const k = i.name.replace(/\.\d+$/, ''); if (k === i.name) continue; if (g.has(k)) union(`${p.id}:${i.name}`, g.get(k)); else g.set(k, `${p.id}:${i.name}`); }
    }
  }
  const groups = new Map();
  for (const p of parts) {
    if (isBB(p.type)) continue;
    for (const i of p.pinInfo) { const r = find(`${p.id}:${i.name}`); (groups.get(r) || groups.set(r, []).get(r)).push({ comp: p.id, pad: i.name }); }
  }
  const mcu = parts.find((p) => catalog[p.type]?.board || catalog[p.type]?.cat === 'Mikrokontroler');
  const nets = []; const used = new Map();
  for (const pads of groups.values()) {
    if (pads.length < 2) continue;
    const m = mcu && pads.find((q) => q.comp === mcu.id);
    let name = m ? m.pad.replace(/\.\d+$/, '') : `${pads[0].comp}.${pads[0].pad}`;
    if (!m) { const pw = pads.map((q) => q.pad.replace(/\.\d+$/, '')).find((n) => POWER.test(n)); if (pw) name = /GND|VSS|^-$|BAT-/i.test(pw) ? 'GND' : pw.toUpperCase(); }
    const k = (used.get(name) || 0) + 1; used.set(name, k);
    nets.push({ name: k > 1 ? `${name}_${k}` : name, pads, power: POWER.test(name.replace(/_\d+$/, '')) || /GND|VCC|VIN|5V|3V3/i.test(name) });
  }
  return nets;
}

// ------------------------------------------------------------------ board model
/**
 * @param src { parts: [{id,type,left,top,rot,size,pinInfo,attrs}], wires: [{a,b,plug}], catalog, layout?: {id: [x,y,rot]} }
 */
export function makeBoard({ parts, wires, catalog, layout = null }) {
  const comps = parts.filter((p) => !isBB(p.type) && p.pinInfo?.length).map((p) => {
    const c = footprint(p, catalog); c.value = valueOf(p, catalog); c.rot = p.rot & 3;
    c.x = (p.left + p.size[0] / 2) * PX; c.y = (p.top + p.size[1] / 2) * PX; return c;
  });
  const nets = netlist(parts, wires, catalog).filter((n) => n.pads.every((q) => comps.some((c) => c.id === q.comp)));
  const board = { comps, nets, traces: [], vias: [], unrouted: [], holes: [], w: 0, h: 0 };
  if (layout?.comps && Object.keys(layout.comps).length) {
    for (const c of comps) { const l = layout.comps[c.id]; if (l) { c.x = l[0]; c.y = l[1]; c.rot = l[2] & 3; } }
    // new parts without a saved place: put them to the right
    let x = Math.max(...comps.filter((c) => layout.comps[c.id]).map((c) => bodyBox(c).x1), 0) + 6;
    for (const c of comps) if (!layout.comps[c.id]) { const b = bodyBox(c); c.x += x - b.x0; c.y += 4 - b.y0; x = bodyBox(c).x1 + 4; }
  } else compact(comps);
  fitOutline(board);
  return board;
}
function valueOf(p, catalog) {
  const a = p.attrs || {};
  if (p.type === 'wokwi-resistor') { const v = +a.value || 220; return v >= 1000 ? `${v / 1000}k` : `${v}`; }
  if (p.type === 'wokwi-led') return `LED ${a.color || 'red'}`;
  if (p.type === 'mod-capacitor') return a.capacitance ? `${a.capacitance}uF` : 'C';
  return (catalog[p.type]?.name || p.type).replace(/\s*\(.*\)/, '');
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/** keep the 2D arrangement but squeeze it together; then push apart anything still overlapping */
export function compact(comps, gap = 2.5) {
  if (!comps.length) return;
  const cx = comps.reduce((t, c) => t + c.x, 0) / comps.length, cy = comps.reduce((t, c) => t + c.y, 0) / comps.length;
  const base = comps.map((c) => ({ x: c.x, y: c.y }));
  const ok = () => { const bx = comps.map((c) => bodyBox(c, gap / 2)); for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) if (overlap(bx[i], bx[j])) return false; return true; };
  let best = 1;
  for (let s = 1; s >= 0.2; s -= 0.04) { comps.forEach((c, i) => { c.x = cx + (base[i].x - cx) * s; c.y = cy + (base[i].y - cy) * s; }); if (ok()) best = s; else if (best < 1 || s < 0.9) break; }
  comps.forEach((c, i) => { c.x = cx + (base[i].x - cx) * best; c.y = cy + (base[i].y - cy) * best; });
  for (let it = 0; it < 200 && !ok(); it++) {                  // relax remaining overlaps
    const bx = comps.map((c) => bodyBox(c, gap / 2));
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) {
      if (!overlap(bx[i], bx[j])) continue;
      const a = bx[i], b = bx[j], ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (ox < oy) { const s = (comps[i].x < comps[j].x ? -1 : 1) * (ox / 2 + 0.3); comps[i].x += s; comps[j].x -= s; } else { const s = (comps[i].y < comps[j].y ? -1 : 1) * (oy / 2 + 0.3); comps[i].y += s; comps[j].y -= s; }
    }
  }
  snapAll(comps);
}
function snapAll(comps) { for (const c of comps) { c.x = Math.round(c.x / 0.25) * 0.25; c.y = Math.round(c.y / 0.25) * 0.25; } }
/** board outline = bounding box of all parts + margin; components shifted so the board starts at (0,0) */
export function fitOutline(board) {
  const m = RULES.margin;
  const bx = board.comps.map((c) => bodyBox(c));
  const x0 = Math.min(...bx.map((b) => b.x0)) - m, y0 = Math.min(...bx.map((b) => b.y0)) - m, x1 = Math.max(...bx.map((b) => b.x1)) + m, y1 = Math.max(...bx.map((b) => b.y1)) + m;
  for (const c of board.comps) { c.x -= x0; c.y -= y0; }
  snapAll(board.comps);
  board.w = Math.ceil((x1 - x0) * 2) / 2; board.h = Math.ceil((y1 - y0) * 2) / 2;
  const holes = [];
  if (board.w > 35 && board.h > 25) for (const [hx, hy] of [[3.5, 3.5], [board.w - 3.5, 3.5], [3.5, board.h - 3.5], [board.w - 3.5, board.h - 3.5]]) {
    if (!board.comps.some((c) => { const b = bodyBox(c, 2.2); return hx > b.x0 && hx < b.x1 && hy > b.y0 && hy < b.y1; })) holes.push({ x: hx, y: hy, d: 3.2 });
  }
  board.holes = holes; board.traces = []; board.vias = []; board.unrouted = []; board.routed = false;
}

// ------------------------------------------------------------------ router
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(f, s) { const k = this.k, v = this.v; k.push(f); v.push(s); let i = k.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; } }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) { k[0] = lk; v[0] = lv; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; } }
    return top;
  }
  get size() { return this.k.length; }
}
const D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/**
 * Route every net. Returns { traces: [{net, layer, w, pts:[[x,y]..]}], vias: [{x,y,net}], unrouted: [{net, a:[x,y], b:[x,y]}] }
 */
export function route(board, { passes = 3, onProgress } = {}) {
  const R = RULES, G = R.grid, nx = Math.ceil(board.w / G) + 1, ny = Math.ceil(board.h / G) + 1, N = nx * ny;
  const pads = []; board.comps.forEach((c) => c.pads.forEach((p) => { const q = padPos(c, p); pads.push({ comp: c.id, name: p.name, x: q.x, y: q.y, r: p.d / 2, sq: p.sq, net: 0 }); }));
  board.nets.forEach((n, i) => { n.id = i + 1; for (const q of n.pads) { const pd = pads.find((p) => p.comp === q.comp && p.name === q.pad); if (pd) pd.net = n.id; } });
  const width = (n) => (n.power ? R.power : R.signal);
  const order0 = board.nets.map((n) => {
    const ps = n.pads.map((q) => pads.find((p) => p.comp === q.comp && p.name === q.pad)).filter(Boolean);
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return { n, ps, hp: Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) };
  }).filter((o) => o.ps.length > 1).sort((a, b) => (a.n.power - b.n.power) || (a.hp - b.hp));

  let best = null, order = order0;
  for (let pass = 0; pass < passes; pass++) {
    const res = routePass(order);
    if (!best || res.failed.length < best.failed.length) best = res;
    if (!res.failed.length) break;
    const f = new Set(res.failed.map((o) => o.n.id)); order = [...order.filter((o) => f.has(o.n.id)), ...order.filter((o) => !f.has(o.n.id))];
  }
  board.traces = best.traces; board.vias = best.vias; board.unrouted = best.unrouted; board.routed = true;
  board.stats = { nets: order0.length, failed: best.failed.length, traces: best.traces.length, vias: best.vias.length, length: Math.round(best.traces.reduce((t, s) => t + s.pts.reduce((u, p, i) => (i ? u + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0), 0), 0)) };
  return board;

  function routePass(order) {
    const block = [new Int32Array(N), new Int32Array(N)], copper = [new Int32Array(N), new Int32Array(N)];
    const mark = (arr, x, y, r, v, L = [0, 1]) => {
      const i0 = Math.max(0, Math.floor((x - r) / G)), i1 = Math.min(nx - 1, Math.ceil((x + r) / G)), j0 = Math.max(0, Math.floor((y - r) / G)), j1 = Math.min(ny - 1, Math.ceil((y + r) / G));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if ((i * G - x) ** 2 + (j * G - y) ** 2 > r * r) continue; const c = j * nx + i;
        for (const l of L) { const a = arr[l]; if (v < 0 || a[c] === 0) a[c] = v; else if (a[c] !== v) a[c] = -1; }
      }
    };
    // board edge and mounting holes
    const e = Math.ceil(R.edge / G);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i < e || j < e || i >= nx - e || j >= ny - e) { block[0][j * nx + i] = -1; block[1][j * nx + i] = -1; }
    for (const h of board.holes) mark(block, h.x, h.y, h.d / 2 + 0.6, -1);
    const kHW = 0.3;                                                    // half width used for keep-outs
    for (const p of pads) {
      mark(block, p.x, p.y, (p.sq ? p.r * 1.25 : p.r) + R.clr + kHW, p.net || -1);
      if (p.net) mark(copper, p.x, p.y, Math.max(G * 0.6, p.r - 0.15), p.net);
    }
    const traces = [], vias = [], unrouted = [], failed = [];
    const g = new Float32Array(2 * N * 8), from = new Int32Array(2 * N * 8), tree = [new Uint8Array(N), new Uint8Array(N)];
    let k = 0;
    for (const o of order) {
      onProgress?.(++k / order.length);
      const n = o.n, nid = n.id, hw = width(n) / 2;
      // Prim order: start with the first pad, connect the nearest remaining pad to the tree each time
      tree[0].fill(0); tree[1].fill(0);
      const inTree = [o.ps[0]]; const rest = o.ps.slice(1);
      const addPadTree = (p) => { const r = Math.max(G * 0.6, p.r - 0.15); const i0 = Math.floor((p.x - r) / G), i1 = Math.ceil((p.x + r) / G), j0 = Math.floor((p.y - r) / G), j1 = Math.ceil((p.y + r) / G); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (i >= 0 && j >= 0 && i < nx && j < ny && (i * G - p.x) ** 2 + (j * G - p.y) ** 2 <= r * r) { tree[0][j * nx + i] = 1; tree[1][j * nx + i] = 1; } };
      addPadTree(o.ps[0]);
      let ok = true;
      while (rest.length) {
        rest.sort((a, b) => Math.min(...inTree.map((t) => Math.hypot(t.x - a.x, t.y - a.y))) - Math.min(...inTree.map((t) => Math.hypot(t.x - b.x, t.y - b.y))));
        const src = rest.shift();
        const path = astar(src, inTree, nid);
        if (!path) { ok = false; const t = inTree.reduce((a, b) => (Math.hypot(a.x - src.x, a.y - src.y) < Math.hypot(b.x - src.x, b.y - src.y) ? a : b)); unrouted.push({ net: n.name, a: [src.x, src.y], b: [t.x, t.y] }); inTree.push(src); addPadTree(src); continue; }
        commit(path, n, nid, hw, src);
        inTree.push(src); addPadTree(src);
      }
      if (!ok) failed.push(o);
    }
    return { traces, vias, unrouted, failed };

    function passable(L, c, nid) { const b = block[L][c]; return b === 0 || b === nid; }
    function astar(src, targets, nid) {
      g.fill(Infinity); from.fill(-1);
      const heap = new Heap();
      const h = (i, j) => { let m = Infinity; for (const t of targets) { const dx = Math.abs(i * G - t.x) / G, dy = Math.abs(j * G - t.y) / G; m = Math.min(m, Math.max(dx, dy) + 0.414 * Math.min(dx, dy)); } return m; };
      const r = Math.max(G * 0.6, src.r - 0.15), si = Math.round(src.x / G), sj = Math.round(src.y / G);
      for (let j = Math.floor((src.y - r) / G); j <= Math.ceil((src.y + r) / G); j++) for (let i = Math.floor((src.x - r) / G); i <= Math.ceil((src.x + r) / G); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny || (i * G - src.x) ** 2 + (j * G - src.y) ** 2 > r * r) continue;
        const c = j * nx + i;
        for (let L = 0; L < 2; L++) for (let d = 0; d < 8; d++) { const s = ((L * N + c) << 3) | d, c0 = (i === si && j === sj ? 0 : 0.5) + (L ? 0.3 : 0); if (c0 < g[s]) { g[s] = c0; heap.push(c0 + h(i, j), s); } }
      }
      let iter = 0;
      while (heap.size) {
        const s = heap.pop(); const d = s & 7, LC = s >> 3, L = LC >= N ? 1 : 0, c = LC - L * N, i = c % nx, j = (c / nx) | 0;
        if (++iter > 900000) return null;
        const gs = g[s];
        if (tree[L][c] && from[s] >= 0) return backtrack(s);
        for (let nd = 0; nd < 8; nd++) {
          const turn = Math.min((nd - d + 8) % 8, (d - nd + 8) % 8); if (turn > 2) continue;
          const ni = i + D8[nd][0], nj = j + D8[nd][1]; if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
          const nc = nj * nx + ni; if (!passable(L, nc, nid)) continue;
          if (nd & 1 && (!passable(L, j * nx + ni, nid) || !passable(L, nj * nx + i, nid))) continue;
          // layer preference: top runs horizontally, bottom vertically (fewer blockages between layers)
          const pref = (L === 0 ? D8[nd][1] !== 0 && D8[nd][0] === 0 : D8[nd][0] !== 0 && D8[nd][1] === 0) ? 0.25 : 0;
          const ns = ((L * N + nc) << 3) | nd, cost = gs + (nd & 1 ? 1.414 : 1) + pref + (turn === 1 ? 0.35 : turn === 2 ? 1.6 : 0);
          if (cost < g[ns]) { g[ns] = cost; from[ns] = s; heap.push(cost + h(ni, nj), ns); }
        }
        // via
        const oL = 1 - L, os = ((oL * N + c) << 3) | d;
        if (gs + 9 < g[os] && viaOK(c, nid, i, j)) { g[os] = gs + 9; from[os] = s; heap.push(gs + 9 + h(i, j), os); }
      }
      return null;
    }
    function viaOK(c, nid, i, j) {
      const rr = Math.ceil((R.via / 2 + R.clr) / G);
      for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= ny) return false;
        const cc = b * nx + a; if (!passable(0, cc, nid) || !passable(1, cc, nid)) return false;
      }
      return true;
    }
    function backtrack(s) { const out = []; for (let x = s; x >= 0; x = from[x]) { const LC = x >> 3, L = LC >= N ? 1 : 0; out.push({ L, c: LC - L * N }); } return out.reverse(); }
    function commit(path, n, nid, hw, src) {
      const kr = hw + R.clr + 0.3;
      let run = null;
      const flush = () => { if (run && run.pts.length > 1) { run.pts = simplifyRun(run.pts); traces.push(run); } run = null; };
      for (let q = 0; q < path.length; q++) {
        const { L, c } = path[q], x = (c % nx) * G, y = ((c / nx) | 0) * G;
        if (q > 0 && path[q - 1].L !== L) {                           // layer change = via
          flush(); vias.push({ x, y, net: n.name });
          mark(block, x, y, R.via / 2 + R.clr + 0.3, nid); mark(copper, x, y, G * 0.6, nid);
        }
        if (!run) { run = { net: n.name, layer: L, w: hw * 2, pts: [] }; if (q === 0) run.pts.push([src.x, src.y]); }
        run.pts.push([x, y]);
        mark(block, x, y, kr, nid, [L]); copper[L][c] = nid; tree[L][c] = 1;
      }
      flush();
    }
  }
}

/** drop points on straight runs */
export function simplifyRun(pts) {
  const out = [];
  for (const p of pts) {
    out.push(p);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-6 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0) out.splice(out.length - 2, 1); else break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ DRC
export function drc(board) {
  const issues = [];
  const segs = board.traces.flatMap((t) => t.pts.slice(1).map((p, i) => ({ net: t.net, layer: t.layer, w: t.w, a: t.pts[i], b: p })));
  const dSeg = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], l = vx * vx + vy * vy || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l)); return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy); };
  const pads = board.comps.flatMap((c) => c.pads.map((p) => { const q = padPos(c, p); const net = board.nets.find((n) => n.pads.some((x) => x.comp === c.id && x.pad === p.name)); return { x: q.x, y: q.y, r: p.d / 2, net: net?.name || null, ref: `${c.id}.${p.name}` }; }));
  for (const s of segs) for (const p of pads) {
    if (p.net === s.net) continue;
    const gap = Math.min(dSeg([p.x, p.y], s.a, s.b)) - p.r - s.w / 2;
    if (gap < RULES.clr - 0.06) issues.push({ kind: 'clearance', msg: `jalur ${s.net} terlalu dekat pad ${p.ref} (${gap.toFixed(2)} mm)` });
  }
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const a = segs[i], b = segs[j]; if (a.net === b.net || a.layer !== b.layer) continue;
    const gap = Math.min(dSeg(a.a, b.a, b.b), dSeg(a.b, b.a, b.b), dSeg(b.a, a.a, a.b), dSeg(b.b, a.a, a.b)) - a.w / 2 - b.w / 2;
    if (gap < RULES.clr - 0.06) issues.push({ kind: 'clearance', msg: `jalur ${a.net} dan ${b.net} terlalu dekat (${gap.toFixed(2)} mm)` });
  }
  for (const u of board.unrouted) issues.push({ kind: 'unrouted', msg: `net ${u.net} belum tersambung` });
  return issues;
}

// ------------------------------------------------------------------ fabrication output
const f6 = (v) => Math.round(v * 1e6);
function gerber(board, fn, body, apertures) {
  const lines = [`%TF.GenerationSoftware,aftakit,PCB,1.0*%`, `%TF.FileFunction,${fn}*%`, '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%', 'G01*'];
  apertures.forEach((a, i) => lines.push(`%ADD${10 + i}${a}*%`));
  return lines.concat(body, ['M02*']).join('\n') + '\n';
}
export function exportFiles(board, name = 'aftakit') {
  const H = board.h, X = (x) => `X${f6(x)}`, Y = (y) => `Y${f6(H - y)}`;
  const padList = board.comps.flatMap((c) => c.pads.map((p) => ({ ...padPos(c, p), d: p.d, drill: p.drill, sq: p.sq, rot: c.rot })));
  const apKey = (s) => s;
  const files = {};
  const copper = (layer, side) => {
    const aps = [], idx = new Map(); const ap = (a) => { if (!idx.has(a)) { idx.set(a, aps.length); aps.push(a); } return `D${10 + idx.get(a)}*`; };
    const body = [];
    for (const p of padList) { body.push(ap(p.sq ? `R,${p.d.toFixed(3)}X${p.d.toFixed(3)}` : `C,${p.d.toFixed(3)}`)); body.push(`${X(p.x)}${Y(p.y)}D03*`); }
    for (const v of board.vias) { body.push(ap(`C,${RULES.via.toFixed(3)}`)); body.push(`${X(v.x)}${Y(v.y)}D03*`); }
    for (const t of board.traces.filter((t) => t.layer === layer)) { body.push(ap(`C,${t.w.toFixed(3)}`)); t.pts.forEach((q, i) => body.push(`${X(q[0])}${Y(q[1])}${i ? 'D01' : 'D02'}*`)); }
    return gerber(board, `Copper,L${layer + 1},${side}`, body, aps.map(apKey));
  };
  const mask = (side) => {
    const aps = [], idx = new Map(); const ap = (a) => { if (!idx.has(a)) { idx.set(a, aps.length); aps.push(a); } return `D${10 + idx.get(a)}*`; };
    const body = []; for (const p of padList) { const d = p.d + 0.1; body.push(ap(p.sq ? `R,${d.toFixed(3)}X${d.toFixed(3)}` : `C,${d.toFixed(3)}`)); body.push(`${X(p.x)}${Y(p.y)}D03*`); }
    return gerber(board, `Soldermask,${side}`, body, aps);
  };
  const silk = () => {
    const body = ['D10*'];
    const line = (pts) => pts.forEach((q, i) => body.push(`${X(q[0])}${Y(q[1])}${i ? 'D01' : 'D02'}*`));
    for (const c of board.comps) {
      const b = bodyBox(c, 0.4);
      line([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0]]);
      const p1 = c.pads.find((p) => p.sq); if (p1) { const q = padPos(c, p1); line([[q.x - p1.d / 2 - 0.5, q.y - p1.d / 2 - 0.5], [q.x - p1.d / 2 - 0.5, q.y + p1.d / 2 + 0.5]]); }
      const th = Math.min(1.2, Math.max(0.8, (b.x1 - b.x0) / Math.max(4, c.id.length) / 1.1));
      for (const s of textStrokes(c.id, b.x0 + 0.3, b.y0 - th - 0.4 < 0.5 ? b.y0 + 0.4 : b.y0 - th - 0.4, th)) line(s);
      if (c.kind === 'conn') for (const [i, p] of c.pads.entries()) { const q = padPos(c, p), lab = p.name.slice(0, 4), th2 = 0.7; for (const s of textStrokes(lab, q.x - textWidth(lab, th2) / 2, b.y1 + 0.5, th2)) line(s); if (i > 12) break; }
    }
    const title = `${name.toUpperCase().slice(0, 24)}`; for (const s of textStrokes(title, 2, board.h - 2.6, 1.2)) line(s);
    return gerber(board, 'Legend,Top', body, ['C,0.150']);
  };
  const outline = () => {
    const r = 1, w = board.w, h = board.h, body = ['D10*', `${X(r)}${Y(0)}D02*`, `${X(w - r)}${Y(0)}D01*`, `${X(w)}${Y(r)}D01*`, `${X(w)}${Y(h - r)}D01*`, `${X(w - r)}${Y(h)}D01*`, `${X(r)}${Y(h)}D01*`, `${X(0)}${Y(h - r)}D01*`, `${X(0)}${Y(r)}D01*`, `${X(r)}${Y(0)}D01*`];
    return gerber(board, 'Profile,NP', body, ['C,0.100']);
  };
  files[`${name}-F_Cu.gtl`] = copper(0, 'Top');
  files[`${name}-B_Cu.gbl`] = copper(1, 'Bot');
  files[`${name}-F_Mask.gts`] = mask('Top');
  files[`${name}-B_Mask.gbs`] = mask('Bot');
  files[`${name}-F_Silkscreen.gto`] = silk();
  files[`${name}-Edge_Cuts.gm1`] = outline();
  // Excellon drill (plated: pads + vias; non-plated: mounting holes)
  const tools = new Map(); const tool = (d) => { const k = d.toFixed(3); if (!tools.has(k)) tools.set(k, []); return tools.get(k); };
  for (const p of padList) tool(p.drill).push(p); for (const v of board.vias) tool(RULES.viaDrill).push(v);
  let drl = 'M48\n; aftakit PCB drill file (plated)\nFMAT,2\nMETRIC,TZ\n'; let t = 1;
  const tl = [...tools.keys()]; tl.forEach((k) => (drl += `T${t++}C${k}\n`)); drl += '%\nG90\nG05\n';
  tl.forEach((k, i) => { drl += `T${i + 1}\n`; for (const p of tools.get(k)) drl += `X${p.x.toFixed(3)}Y${(H - p.y).toFixed(3)}\n`; });
  drl += 'T0\nM30\n'; files[`${name}-PTH.drl`] = drl;
  if (board.holes.length) { let n = 'M48\n; aftakit PCB drill file (non-plated mounting holes)\nFMAT,2\nMETRIC,TZ\nT1C3.200\n%\nG90\nG05\nT1\n'; for (const h of board.holes) n += `X${h.x.toFixed(3)}Y${(H - h.y).toFixed(3)}\n`; files[`${name}-NPTH.drl`] = n + 'T0\nM30\n'; }
  // bill of materials
  const rows = new Map();
  for (const c of board.comps) { const k = `${c.value}|${c.kind}`; const r = rows.get(k) || { value: c.value, kind: c.kind, refs: [] }; r.refs.push(c.id); rows.set(k, r); }
  const kindTxt = { board: 'Female header socket (modul board dicolok)', module: 'Header socket / modul', part: 'Komponen THT', conn: 'Konektor 2.54 mm ke komponen luar papan' };
  files[`${name}-BOM.csv`] = 'Qty,Referensi,Nilai/Nama,Pemasangan\n' + [...rows.values()].map((r) => `${r.refs.length},"${r.refs.join(' ')}","${r.value}","${kindTxt[r.kind]}"`).join('\n') + '\n';
  const st = board.stats || {};
  files[`${name}-README.txt`] = [`PCB ${name} — dibuat oleh aftakit`, '', `Ukuran papan : ${board.w.toFixed(1)} x ${board.h.toFixed(1)} mm`, 'Lapisan      : 2 (F.Cu atas, B.Cu bawah), tebal 1.6 mm, FR-4', `Jalur        : sinyal ${RULES.signal} mm, daya ${RULES.power} mm, clearance ${RULES.clr} mm`, `Via          : ${RULES.via} mm / bor ${RULES.viaDrill} mm (${board.vias.length} buah)`, `Net          : ${st.nets ?? board.nets.length}, belum tersambung: ${board.unrouted.length}`, '',
    'File:', '  *-F_Cu.gtl  tembaga atas        *-B_Cu.gbl  tembaga bawah', '  *-F_Mask.gts / *-B_Mask.gbs  solder mask', '  *-F_Silkscreen.gto  sablon', '  *-Edge_Cuts.gm1  garis potong papan', '  *-PTH.drl  lubang berlapis (Excellon, mm)   *-NPTH.drl  lubang baut M3', '  *-BOM.csv  daftar komponen', '',
    'Kirim ke pabrik PCB (JLCPCB / PCBWay / dll.): unggah file zip ini apa adanya, pilih 2 layer, 1.6 mm.', 'Modul dan board mikrokontroler dipasang lewat female header (soket) di posisi pin aslinya.'].join('\n') + '\n';
  return files;
}

// ------------------------------------------------------------------ zip (store, no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, text] of Object.entries(files)) {
    const data = typeof text === 'string' ? enc.encode(text) : text, nb = enc.encode(name), crc = crc32(data);
    const head = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
    parts.push(new Uint8Array(head), nb, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
    off += head.length + nb.length + data.length;
  }
  const cdSize = central.reduce((t, b) => t + b.length, 0), n = Object.keys(files).length;
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(n), ...u16(n), ...u32(cdSize), ...u32(off), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
