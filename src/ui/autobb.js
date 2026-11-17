// "Pasang di breadboard": moves the small parts of a circuit onto a half-size breadboard the way a student would
// build it on the bench, and rewires it through the breadboard strips and power rails without changing a single
// electrical connection. Parts whose pins sit on the 2.54 mm grid (LEDs, resistors, buttons, sensor modules …) are
// plugged in; big or wired-only parts (displays, servos, motors, relays with screw terminals …) stay beside it.
// The result is checked net by net against the original; on any difference the original circuit is restored.
import { Circuit } from '../sim/circuit.js';

const P = 9.6;                                   // 2.54 mm in canvas px
const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
const isBB = (t) => /breadboard/.test(t);
const base = (p) => (/^\d+\.\d+V$/.test(p) ? p : p.split('.')[0]);
const GND = new Set(['GND', 'AGND', 'VSS', 'GND1', 'GND2']);
const SKIP = /servo|stepper|motor|bldc|battery|lipo|frame|esc|lcd|ili9341|ssd1306|oled|tft|keypad|ir-remote|neopixel|led-ring|led-matrix|max7219|relay|l298n|hx711|load-cell|microsd|sd-card|rc522|gps|sim800|lora|nrf24|esp01|ftdi|solar|buck|pump|fan|solenoid|flow|ph|tds|acs712|lidar|tfluna|rc-rx|dip-switch|rotary-dialer|biaxial|slide-potentiometer|hc-05|bluetooth|camera/i;
const WIRE_RED = '#e11d48', WIRE_BLACK = '#1f2937';

/** union-find nets of a model (part pins with the same base are joined, like the simulator does) */
function nets(parts, connections) {
  const c = new Circuit(parts, connections);
  return { c, of: (ref) => { const i = ref.lastIndexOf(':'); return c.net(ref.slice(0, i), ref.slice(i + 1)); } };
}
const partsOf = (canvas) => [...canvas.parts.values()].map((p) => ({ id: p.id, type: p.type, pins: p.pinInfo.map((x) => x.name) }));

/** pin positions of a part for rotation k, relative to the part's top-left (canvas px) */
function pinsAt(part, k) {
  const [w, h] = part.size, [a, b, c, d] = ROT[k & 3], cx = w / 2, cy = h / 2;
  return part.pinInfo.map((i) => ({ name: i.name, x: cx + a * (i.x - cx) + b * (i.y - cy), y: cy + c * (i.x - cx) + d * (i.y - cy) }));
}
function boxAt(part, k, left, top, m = 0) {
  const [w, h] = part.size, sw = k & 1, cx = left + w / 2, cy = top + h / 2, hw = (sw ? h : w) / 2, hh = (sw ? w : h) / 2;
  return { x0: cx - hw - m, y0: cy - hh - m, x1: cx + hw + m, y1: cy + hh + m };
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (q, b, m = 2.5) => q.x > b.x0 + m && q.x < b.x1 - m && q.y > b.y0 + m && q.y < b.y1 - m;

/** can this part be plugged in: every pin on the 2.54 mm grid, small enough to sit on a half breadboard */
function pluggable(part, catalog) {
  const cat = catalog[part.type];
  if (!cat || cat.board || cat.breadboard || SKIP.test(part.type) || SKIP.test(cat.name || '')) return false;
  const pins = part.pinInfo; if (!pins.length || pins.length > 10) return false;
  const [w, h] = part.size; if (!w || !h || Math.min(w, h) > 140 || Math.max(w, h) > 200) return false;
  const p0 = pins[0];
  return pins.every((p) => { const fx = (p.x - p0.x) / P, fy = (p.y - p0.y) / P; return Math.abs(fx - Math.round(fx)) * P < 1.3 && Math.abs(fy - Math.round(fy)) * P < 1.3; });
}

/**
 * Put the circuit on a breadboard.
 * @returns {Promise<{ok:boolean, placed:string[], wires:number, reason?:string}>}
 */
export async function autoBreadboard(canvas, catalog, { tidy = true } = {}) {
  const all = [...canvas.parts.values()];
  if (all.some((p) => isBB(p.type))) return { ok: false, placed: [], wires: 0, reason: 'Rangkaian sudah memakai breadboard.' };
  const orig = canvas.getModel();
  const board = all.find((p) => catalog[p.type]?.board) || null;
  const cand = all.filter((p) => p !== board && pluggable(p, catalog));

  // ---- original nets
  const N0 = nets(partsOf(canvas), orig.connections.map((c) => [c[0], c[1]]));
  const wiredRefs = new Set(orig.connections.flatMap((c) => [c[0], c[1]]));
  const colorOfNet = new Map(); for (const c of orig.connections) { const n = N0.of(c[0]); if (!colorOfNet.has(n) && c[2] && c[2] !== 'plug') colorOfNet.set(n, c[2]); }
  const netSize = new Map(); for (const r of wiredRefs) { const n = N0.of(r); netSize.set(n, (netSize.get(n) || 0) + 1); }

  // ---- the breadboard beside the board (or at the top-left of the drawing)
  const tmp = document.createElement('x-breadboard-half'); const holesLocal = tmp.pinInfo;
  const bbW = Math.round(14 * 2 + 29 * P), bbH = Math.round(Math.max(...holesLocal.map((q) => q.y)) + 11);
  const boxes = all.map((p) => ({ p, b: boxAt(p, p.rot, p.left, p.top) }));
  const minX = Math.min(...boxes.map((x) => x.b.x0)), minY = Math.min(...boxes.map((x) => x.b.y0));
  let bx, by;
  if (board) { const b = boxAt(board, board.rot, board.left, board.top); bx = Math.round((b.x1 + 70) / P) * P; by = Math.round(b.y0 / P) * P; }
  else { bx = Math.round(minX / P) * P; by = Math.round(minY / P) * P; }
  const holes = holesLocal.map((q) => ({ name: q.name, strip: base(q.name), row: q.name.split('.')[1], x: bx + q.x, y: by + q.y, rail: /^[TB][NP]$/.test(base(q.name)) }));
  const terminal = holes.filter((h) => !h.rail);
  const grid = new Map(), gk = (x, y) => `${Math.round(x / 4)},${Math.round(y / 4)}`;
  for (const h of terminal) { const k = gk(h.x, h.y); (grid.get(k) || grid.set(k, []).get(k)).push(h); }
  const near = (x, y, r = 2.2) => {
    let best = null, bd = r; const i = Math.round(x / 4), j = Math.round(y / 4);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const h of grid.get(`${i + a},${j + b}`) || []) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } }
    return best;
  };

  // ---- placement: left → right in the order the parts were drawn
  const stripUse = new Map();            // strip -> net id using it
  const occupied = new Set();            // hole names holding a pin
  const bodies = [];                     // placed body boxes
  const placed = new Map();              // partId -> { left, top, rot, pins: [{name, hole}] }
  const netKey = (part, pin) => { const r = `${part.id}:${pin}`; return wiredRefs.has(r) || [...wiredRefs].some((x) => x.startsWith(part.id + ':') && base(x.slice(part.id.length + 1)) === base(pin)) ? N0.of(r) : `u:${r}`; };
  const freeUncovered = (strip, extraBody) => holes.filter((h) => h.strip === strip && !occupied.has(h.name) && !bodies.some((b) => inside(h, b)) && !(extraBody && inside(h, extraBody))).length;
  for (const part of cand.sort((a, b) => (a.left - b.left) || (a.top - b.top))) {
    let best = null;
    for (const k of [part.rot, (part.rot + 1) & 3, (part.rot + 2) & 3, (part.rot + 3) & 3]) {
      const rel = pinsAt(part, k);
      for (const h0 of terminal) {
        const dx = h0.x - rel[0].x, dy = h0.y - rel[0].y;
        const hs = rel.map((q) => near(q.x + dx, q.y + dy)); if (hs.some((h) => !h)) continue;
        if (new Set(hs.map((h) => h.name)).size !== hs.length || hs.some((h) => occupied.has(h.name))) continue;
        // strips: one net per strip (pins of one net may share it — that is how an LED meets its resistor)
        let okS = true, share = 0; const mine = new Map();
        hs.forEach((h, i) => {
          const n = netKey(part, rel[i].name), u = stripUse.get(h.strip) ?? mine.get(h.strip);
          if (u !== undefined && u !== n) okS = false; else if (stripUse.has(h.strip)) share++;
          mine.set(h.strip, n);
        });
        if (!okS) continue;
        const left = Math.round(dx * 100) / 100, top = Math.round(dy * 100) / 100, body = boxAt(part, k, left, top);
        if (bodies.some((b) => overlap(b, boxAt(part, k, left, top, -1.5)))) continue;
        if (body.x0 < bx - 4 || body.x1 > bx + bbW + 4) continue;                                // stay over the board width
        // every strip in use must keep a free, visible hole for its wire
        const strips = new Set([...stripUse.keys(), ...mine.keys()]);
        const tentative = new Set(hs.map((h) => h.name));
        let covered = 0, okF = true;
        for (const s of strips) {
          const free = holes.filter((h) => h.strip === s && !occupied.has(h.name) && !tentative.has(h.name) && !bodies.some((b) => inside(h, b)) && !inside(h, body)).length;
          if (!free) { okF = false; break; }
        }
        if (!okF) continue;
        for (const h of terminal) if (!occupied.has(h.name) && inside(h, body)) covered++;
        const col = Math.min(...hs.map((h) => +h.strip.slice(1)));
        const score = col * 3 + covered * 0.6 - share * 25 + (k === part.rot ? 0 : ((k - part.rot) & 1) ? 14 : 40) + (hs[0].strip[0] === 'B' ? 1 : 0);
        if (!best || score < best.score) best = { score, k, left, top, hs, body, rel };
      }
    }
    if (!best) continue;
    best.hs.forEach((h, i) => { occupied.add(h.name); stripUse.set(h.strip, netKey(part, best.rel[i].name)); });
    bodies.push(boxAt(part, best.k, best.left, best.top, 1));
    placed.set(part.id, { left: best.left, top: best.top, rot: best.k, pins: best.rel.map((q, i) => ({ name: q.name, hole: best.hs[i] })) });
  }

  // ---- new positions: placed parts on the board; other parts moved out of the breadboard's way
  const bbBox = { x0: bx - 30, y0: by - 30, x1: bx + bbW + 30, y1: by + bbH + 30 };
  const parts = [{ id: 'bb1', type: 'x-breadboard-half', left: bx, top: by, rotate: 0, attrs: {} }];
  let shiftY = 0;
  for (const p of orig.parts) {
    const pl = placed.get(p.id), live = canvas.parts.get(p.id);
    if (pl) { parts.push({ ...p, left: pl.left, top: pl.top, rotate: pl.rot * 90 }); continue; }
    const b = boxAt(live, live.rot, p.left, p.top);
    if (p.id !== board?.id && overlap(b, bbBox)) shiftY = Math.max(shiftY, bbBox.y1 + 20 - b.y0);
  }
  for (const p of orig.parts) {
    if (placed.has(p.id)) continue; const live = canvas.parts.get(p.id), b = boxAt(live, live.rot, p.left, p.top);
    const dy = p.id !== board?.id && (b.y0 >= bbBox.y0 - 40 || overlap(b, bbBox)) && b.x1 > bbBox.x0 ? shiftY : 0;
    parts.push({ ...p, top: p.top + dy });
  }
  if (parts.filter((p) => p.id === 'bb1').length !== 1 || all.some((p) => p.id === 'bb1')) parts[0].id = 'bb' + Date.now() % 1000;
  const BB = parts[0].id;

  // ---- rewiring, net by net
  const stripNode = new Map();           // strip -> node id (strips joined through one part's twin pins share a node)
  const nodeOfPin = new Map();           // "part:pin" (placed) -> strip
  for (const [pid, pl] of placed) for (const q of pl.pins) nodeOfPin.set(`${pid}:${q.name}`, q.hole.strip);
  const usedHole = new Set(occupied);
  const coveredHole = (h) => bodies.some((b) => inside(h, b));
  const outer = { T: ['a', 'b', 'c', 'd', 'e'], B: ['j', 'i', 'h', 'g', 'f'] };
  const holeIn = (strip) => {
    const rows = outer[strip[0]] || ['a', 'b', 'c', 'd', 'e'];
    for (const r of rows) { const h = holes.find((x) => x.name === `${strip}.${r}`); if (h && !usedHole.has(h.name) && !coveredHole(h)) { usedHole.add(h.name); return h; } }
    for (const r of rows) { const h = holes.find((x) => x.name === `${strip}.${r}`); if (h && !usedHole.has(h.name)) { usedHole.add(h.name); return h; } }
    return null;
  };
  const pinInStrip = (strip) => { for (const [pid, pl] of placed) { const q = pl.pins.find((x) => x.hole.strip === strip); if (q) return `${pid}:${q.name}`; } return null; };
  const railHole = (rail, x) => {
    const c = holes.filter((h) => h.strip === rail && !usedHole.has(h.name)).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    if (c) usedHole.add(c.name); return c;
  };
  const power = catalog[board?.type]?.power || {};
  // supply nets: the board's power pins and GND, plus battery terminals
  const supply = new Map();             // net -> { kind: 'gnd' | 'v', v }
  for (const r of wiredRefs) {
    const [pid, pin] = [r.slice(0, r.lastIndexOf(':')), r.slice(r.lastIndexOf(':') + 1)];
    if (board && pid === board.id) { if (GND.has(base(pin))) supply.set(N0.of(r), { kind: 'gnd' }); else if (power[base(pin)]) supply.set(N0.of(r), { kind: 'v', v: power[base(pin)] }); }
  }
  const vNets = [...supply.entries()].filter(([, s]) => s.kind === 'v').map(([n, s]) => ({ n, v: s.v, users: [...wiredRefs].filter((r) => N0.of(r) === n).length })).sort((a, b) => b.users - a.users);
  const railOf = new Map();             // net -> { top, bottom } rail strip names
  for (const [n, s] of supply) if (s.kind === 'gnd') railOf.set(n, { top: 'TN', bottom: 'BN' });
  if (vNets[0]) railOf.set(vNets[0].n, { top: 'TP', bottom: vNets[1] ? null : 'BP' });
  if (vNets[1]) railOf.set(vNets[1].n, { top: null, bottom: 'BP' });

  const conns = [];
  const add = (a, b, color) => { if (a !== b) conns.push([a, b, color]); };
  const H = (h) => `${BB}:${h.name}`;
  const railsUsed = new Set();
  const netRefs = new Map(); for (const r of wiredRefs) { const n = N0.of(r); (netRefs.get(n) || netRefs.set(n, []).get(n)).push(r); }
  for (const [n, refs] of netRefs) {
    // terminals: one per breadboard strip group + each off-board pin
    const strips = new Set(), off = [], offKey = new Set();
    for (const r of refs) {
      const s = nodeOfPin.get(r); if (s) { strips.add(s); continue; }
      const k = r.slice(0, r.lastIndexOf(':')) + ':' + base(r.slice(r.lastIndexOf(':') + 1)); if (offKey.has(k)) continue; offKey.add(k); off.push(r);   // GND.1 / GND.2 of one part = one terminal
    }
    // placed pins of this net that were not wired themselves but share the base of a wired pin (GND.1 / GND.2)
    for (const [pid] of placed) for (const q of placed.get(pid).pins) if (N0.of(`${pid}:${q.name}`) === n) strips.add(q.hole.strip);
    // strips joined inside one part (button 1.l / 1.r) need only one connection
    const groups = []; const seen = new Set();
    for (const s of strips) {
      if (seen.has(s)) continue; const g = [s]; seen.add(s);
      for (const [pid, pl] of placed) {
        const here = pl.pins.filter((q) => q.hole.strip === s);
        for (const q of here) for (const o of pl.pins) if (o !== q && base(o.name) === base(q.name) && !seen.has(o.hole.strip) && strips.has(o.hole.strip)) { seen.add(o.hole.strip); g.push(o.hole.strip); }
      }
      groups.push(g[0]);
    }
    const col = colorOfNet.get(n), rail = railOf.get(n), kind = supply.get(n)?.kind;
    const color = kind === 'gnd' ? WIRE_BLACK : kind === 'v' ? WIRE_RED : col;
    if (rail && groups.length + off.length > 1) {
      // supply: board pin → rail, every strip → its nearest rail, off-board parts → rail
      const railFor = (strip) => (strip[0] === 'B' ? rail.bottom || rail.top : rail.top || rail.bottom);
      const bPins = off.filter((r) => board && r.startsWith(board.id + ':')), others = off.filter((r) => !bPins.includes(r));
      const feed = rail.top || rail.bottom; railsUsed.add(feed);
      if (bPins.length) { const h = railHole(feed, bx); if (h) add(bPins[0], H(h), color); }
      for (const r of bPins.slice(1)) if (base(r.slice(r.lastIndexOf(':') + 1)) !== base(bPins[0].slice(bPins[0].lastIndexOf(':') + 1))) add(r, bPins[0], color);
      for (const s of groups) { const rr = railFor(s); railsUsed.add(rr); const h = holeIn(s), q = railHole(rr, h ? h.x : holes.find((x) => x.strip === s).x); if (q) add(h ? H(h) : pinInStrip(s), H(q), color); }
      for (const r of others) { const q = railHole(feed, bx + bbW); if (q) add(r, H(q), color); }
      continue;
    }
    // signal: chain the terminals left → right (board pin first)
    const nodes = [...off.map((r) => ({ ref: r, x: canvas.pinPos(r)?.x ?? 0, board: board && r.startsWith(board.id + ':') })), ...groups.map((s) => ({ strip: s, x: holes.find((h) => h.strip === s).x }))]
      .sort((a, b) => (b.board ? 1 : 0) - (a.board ? 1 : 0) || a.x - b.x);
    for (let i = 1; i < nodes.length; i++) {
      const end = (t) => (t.ref ? t.ref : (() => { const h = holeIn(t.strip); return h ? H(h) : pinInStrip(t.strip); })());
      add(end(nodes[i - 1]), end(nodes[i]), color);
    }
  }
  // both rails of one supply joined at the right end (only when the bottom rail is fed from the top one)
  for (const [n, rail] of railOf) {
    if (!rail.top || !rail.bottom) continue;
    if (!railsUsed.has(rail.bottom) || !railsUsed.has(rail.top)) continue;
    const a = railHole(rail.top, bx + bbW), b = railHole(rail.bottom, bx + bbW); if (a && b) add(H(a), H(b), supply.get(n)?.kind === 'gnd' ? WIRE_BLACK : WIRE_RED);
  }

  // nothing plugged in and no supply to share on the rails: a breadboard would only be decoration
  if (!placed.size && !conns.some((c) => c.some((r) => r.startsWith(BB + ':')))) return { ok: false, placed: [], wires: 0, reason: 'Tidak ada komponen yang bisa ditancapkan ke breadboard.' };
  const model = { ...orig, parts, connections: conns, bundles: undefined };
  delete model.bundles; delete model.pcb;
  await canvas.setModel(model, { fit: true, keepHistory: true });
  for (const id of placed.keys()) { const part = canvas.parts.get(id); if (part) canvas._plug(part, true); }   // seat every leg in its hole (absorbs sub-pixel size differences)
  canvas._redrawWires();

  // ---- verify: every original connection kept, nothing new joined
  const N1 = nets(partsOf(canvas), canvas.wires.map((w) => [w.a, w.b]));
  const refs = [...canvas.parts.values()].filter((p) => !isBB(p.type)).flatMap((p) => p.pinInfo.map((i) => `${p.id}:${i.name}`));
  const map = new Map(); let ok = true, why = '';
  for (const r of refs) {
    const a = N0.of(r), b = N1.of(r), wired0 = (netSize.get(a) || 0) > 0;
    if (!wired0) { const others = refs.filter((x) => x !== r && N1.of(x) === b && !(x.slice(0, x.lastIndexOf(':')) === r.slice(0, r.lastIndexOf(':')) && base(x.slice(x.lastIndexOf(':') + 1)) === base(r.slice(r.lastIndexOf(':') + 1)))); if (others.length) { ok = false; why = `${r} tersambung ke ${others[0]}`; break; } continue; }
    if (map.has(a) && map.get(a) !== b) { ok = false; why = `jalur ${r} terputus`; break; }
    map.set(a, b);
  }
  if (ok) { const inv = new Map(); for (const [a, b] of map) { if (inv.has(b) && inv.get(b) !== a) { ok = false; why = 'dua jalur berbeda tergabung'; break; } inv.set(b, a); } }
  if (!ok) { await canvas.setModel(orig, { fit: true, keepHistory: true }); return { ok: false, placed: [], wires: 0, reason: 'Sambungan tidak bisa dipertahankan (' + why + '); rangkaian dikembalikan.' }; }
  if (tidy) canvas.bundleWires();
  return { ok: true, placed: [...placed.keys()], wires: conns.length };
}
