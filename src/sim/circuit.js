// Static netlist (wires + internally-connected pins) and a small dynamic electrical solver.
// Voltages are fractions of 5 V (0..1). The model is deliberately simple but physically sensible:
//   strong drivers : rails, Arduino outputs, powered sensor outputs
//   switches       : closed contacts merge two nets
//   weak links     : resistors (a node with no strong driver takes the value across a resistor)
//   pull-ups       : INPUT_PULLUP / module pull-ups, weaker than everything else
// header pins that carry the same signal on a board (the Mega repeats SDA/SCL next to AREF)
const BOARD_LINKS = { 'wokwi-arduino-mega': [['SDA', '20'], ['SCL', '21']] };

export class Circuit {
  /** @param parts [{id,type,pins:[names]}]  @param connections [["id:pin","id:pin"],...] */
  constructor(parts, connections) {
    this.keys = new Map();   // "id:pin" -> index
    this.parent = [];
    const idx = (k) => {
      if (!this.keys.has(k)) { this.keys.set(k, this.parent.length); this.parent.push(this.parent.length); }
      return this.keys.get(k);
    };
    const find = (x) => { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) this.parent[b] = a; };
    this.issues = [];
    for (const p of parts) {
      const byBase = new Map();
      for (const name of p.pins) {
        const i = idx(`${p.id}:${name}`);
        const base = (/^\d+\.\d+V$/.test(name) ? name : name.split('.')[0]);   // pins with one base (GND.1, GND.2, 1.l/1.r) are joined; '3.3V' is a name, not pin '3' + suffix
        if (byBase.has(base)) union(byBase.get(base), i); else byBase.set(base, i);
      }
      for (const [a, b] of BOARD_LINKS[p.type] || []) if (p.pins.includes(a) && p.pins.includes(b)) union(idx(`${p.id}:${a}`), idx(`${p.id}:${b}`));
    }
    this.wired = new Set();
    for (const [a, b] of connections) {
      if (!this.keys.has(a)) { this.issues.push(`Kabel merujuk pin yang tidak ada: ${a}`); continue; }
      if (!this.keys.has(b)) { this.issues.push(`Kabel merujuk pin yang tidak ada: ${b}`); continue; }
      union(this.keys.get(a), this.keys.get(b));
      this.wired.add(a); this.wired.add(b);
    }
    // compact roots -> net ids
    const roots = new Map();
    this.netOfIndex = this.parent.map((_, i) => {
      const r = find(i);
      if (!roots.has(r)) roots.set(r, roots.size);
      return roots.get(r);
    });
    this.netCount = roots.size;
    this.members = Array.from({ length: this.netCount }, () => []);
    for (const [k, i] of this.keys) this.members[this.netOfIndex[i]].push(k);
  }

  net(partId, pin) {
    const i = this.keys.get(`${partId}:${pin}`);
    return i === undefined ? -1 : this.netOfIndex[i];
  }
  isWired(partId, pin) { return this.wired.has(`${partId}:${pin}`); }

  /**
   * @param strong [{net,value,label,rail?}]
   * @param pullups [net]
   * @param switches [[netA,netB]]
   * @param weak [[netA,netB]]
   */
  solve({ strong = [], pullups = [], switches = [], weak = [] }) {
    const n = this.netCount;
    const par = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (const [a, b] of switches) if (a >= 0 && b >= 0) { const ra = find(a), rb = find(b); if (ra !== rb) par[rb] = ra; }
    const val = new Array(n).fill(null);
    const peak = new Array(n).fill(null);    // PWM nets: level of the pulses (val holds the average)
    const isStrong = new Array(n).fill(false);
    const by = new Map();
    for (const s of strong) {
      if (s.net < 0) continue;
      const g = find(s.net);
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(s);
    }
    const warnings = [];
    for (const [g, list] of by) {
      const vals = list.map((s) => s.value);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      let v;
      if (hi - lo > 0.25) {
        const rail = list.find((s) => s.rail);
        v = rail ? rail.value : list[0].value;
        warnings.push({ kind: 'short', text: `Korsleting: ${[...new Set(list.map((s) => s.label))].join(' ↔ ')} terhubung langsung dengan tegangan berbeda` });
      } else v = vals.reduce((a, b) => a + b, 0) / vals.length;
      val[g] = v; isStrong[g] = true;
      if (list.length === 1 && list[0].peak !== undefined) peak[g] = list[0].peak;
    }
    const propagate = () => {
      let changed = true, guard = 0;
      while (changed && guard++ < 16) {
        changed = false;
        for (const [a, b] of weak) {
          if (a < 0 || b < 0) continue;
          const ga = find(a), gb = find(b);
          if (ga === gb) continue;
          if (val[ga] === null && val[gb] !== null) { val[ga] = val[gb]; peak[ga] = peak[gb]; changed = true; }
          else if (val[gb] === null && val[ga] !== null) { val[gb] = val[ga]; peak[gb] = peak[ga]; changed = true; }
        }
      }
    };
    propagate();
    for (const p of pullups) { if (p < 0) continue; const g = find(p); if (val[g] === null) val[g] = 1; }
    propagate();
    // resistor networks: a node that is not driven but joins several resistors settles at the conductance-weighted
    // mean of its neighbours (nodal analysis, Gauss-Seidel), so 5 V → 1 kΩ → GPIO → 2 kΩ → GND gives 3.33 V.
    // A node on a single resistor keeps its neighbour's value exactly as before.
    const adj = new Map(), link = (x, y, c) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push([y, c]); };
    for (const [a, b, r] of weak) {
      if (a < 0 || b < 0) continue; const ga = find(a), gb = find(b); if (ga === gb) continue;
      const c = 1 / Math.max(1, +r || 1000); link(ga, gb, c); link(gb, ga, c);
    }
    const PULL = 1 / 40000, pulled = new Set(pullups.filter((p) => p >= 0).map(find));   // INPUT_PULLUP ≈ 40 kΩ to VCC
    const free = [...adj.keys()].filter((g) => !isStrong[g] && (adj.get(g).length > 1 || pulled.has(g)));
    for (let it = 0; it < 80 && free.length; it++) {
      let dmax = 0;
      for (const g of free) {
        let s = 0, w = 0;
        for (const [h, c] of adj.get(g)) if (val[h] !== null) { s += c * val[h]; w += c; }
        if (pulled.has(g) && adj.get(g).length) { s += PULL; w += PULL; }
        if (!w) continue;
        const nv = s / w; if (val[g] === null || Math.abs(nv - val[g]) > dmax) dmax = Math.abs(nv - (val[g] ?? 0));
        val[g] = nv;
      }
      if (dmax < 1e-5) break;
    }
    for (const g of free) if (adj.get(g).filter(([h]) => val[h] !== null).length > 1) peak[g] = null;
    return {
      v: (net) => (net < 0 ? null : val[find(net)]),
      strong: (net) => (net < 0 ? false : isStrong[find(net)]),
      peak: (net) => (net < 0 ? null : peak[find(net)]),
      warnings,
    };
  }
}
