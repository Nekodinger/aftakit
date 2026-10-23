// Static netlist (wires + internally-connected pins) and a small dynamic electrical solver.
// Voltages are fractions of 5 V (0..1). The model is deliberately simple but physically sensible:
//   strong drivers : rails, Arduino outputs, powered sensor outputs
//   switches       : closed contacts merge two nets
//   weak links     : resistors (a node with no strong driver takes the value across a resistor)
//   pull-ups       : INPUT_PULLUP / module pull-ups, weaker than everything else
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
        const base = name.split('.')[0];
        if (byBase.has(base)) union(byBase.get(base), i); else byBase.set(base, i);
      }
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
    }
    const propagate = () => {
      let changed = true, guard = 0;
      while (changed && guard++ < 16) {
        changed = false;
        for (const [a, b] of weak) {
          if (a < 0 || b < 0) continue;
          const ga = find(a), gb = find(b);
          if (ga === gb) continue;
          if (val[ga] === null && val[gb] !== null) { val[ga] = val[gb]; changed = true; }
          else if (val[gb] === null && val[ga] !== null) { val[gb] = val[ga]; changed = true; }
        }
      }
    };
    propagate();
    for (const p of pullups) { if (p < 0) continue; const g = find(p); if (val[g] === null) val[g] = 1; }
    propagate();
    return {
      v: (net) => (net < 0 ? null : val[find(net)]),
      strong: (net) => (net < 0 ? false : isStrong[find(net)]),
      warnings,
    };
  }
}
