// Orthogonal maze routing on a grid (A* with a bend penalty) — used for wire harnesses on the canvas.

/** binary heap keyed by f */
class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/**
 * Shortest orthogonal path from S to T (points in px) that avoids the rectangles (px: {x0,y0,x1,y1}).
 * @returns array of corner points (S … T), or null.
 */
export function routeOrthogonal(S, T, obstacles, { cell = 8, bend = 6, margin = 120, startDir = null } = {}) {
  const xs = [S.x, T.x, ...obstacles.flatMap((o) => [o.x0, o.x1])], ys = [S.y, T.y, ...obstacles.flatMap((o) => [o.y0, o.y1])];
  const ox = Math.min(...xs) - margin, oy = Math.min(...ys) - margin;
  const W = Math.ceil((Math.max(...xs) + margin - ox) / cell) + 1, H = Math.ceil((Math.max(...ys) + margin - oy) / cell) + 1;
  if (W * H > 400000) return null;
  const blocked = new Uint8Array(W * H);
  for (const o of obstacles) {
    const i0 = Math.max(0, Math.floor((o.x0 - ox) / cell)), i1 = Math.min(W - 1, Math.ceil((o.x1 - ox) / cell)), j0 = Math.max(0, Math.floor((o.y0 - oy) / cell)), j1 = Math.min(H - 1, Math.ceil((o.y1 - oy) / cell));
    for (let j = j0; j <= j1; j++) blocked.fill(1, j * W + i0, j * W + i1 + 1);
  }
  const cs = [Math.round((S.x - ox) / cell), Math.round((S.y - oy) / cell)], ct = [Math.round((T.x - ox) / cell), Math.round((T.y - oy) / cell)];
  blocked[cs[1] * W + cs[0]] = 0; blocked[ct[1] * W + ct[0]] = 0;
  const N = W * H, g = new Float32Array(N * 4).fill(Infinity), from = new Int32Array(N * 4).fill(-1);
  const h = (i, j) => Math.abs(i - ct[0]) + Math.abs(j - ct[1]);
  const heap = new Heap();
  for (let d = 0; d < 4; d++) { const s = (cs[1] * W + cs[0]) * 4 + d, c0 = startDir != null && d !== startDir ? bend : 0; g[s] = c0; heap.push({ s, f: c0 + h(cs[0], cs[1]) }); }
  let end = -1;
  while (heap.size) {
    const { s } = heap.pop(); const d = s & 3, c = s >> 2, i = c % W, j = (c / W) | 0;
    if (i === ct[0] && j === ct[1]) { end = s; break; }
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue;
      const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1]; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni; if (blocked[nc]) continue;
      const ns = nc * 4 + nd, cost = g[s] + 1 + (nd !== d ? bend : 0);
      if (cost < g[ns]) { g[ns] = cost; from[ns] = s; heap.push({ s: ns, f: cost + h(ni, nj) }); }
    }
  }
  if (end < 0) return null;
  const cells = []; for (let s = end; s >= 0; s = from[s]) cells.push(s >> 2);
  cells.reverse();
  const pts = cells.map((c) => ({ x: ox + (c % W) * cell, y: oy + ((c / W) | 0) * cell }));
  pts[0] = { x: S.x, y: S.y }; pts[pts.length - 1] = { x: T.x, y: T.y };
  return simplify(orthogonalize(pts));
}

/** drop points on straight runs (keeps an orthogonal polyline) */
export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.01 && Math.abs(out[out.length - 1].y - p.y) < 0.01) continue;
    out.push({ ...p });
    while (out.length >= 3) {
      const a = out[out.length - 3], b = out[out.length - 2], c = out[out.length - 1];
      if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) out.splice(out.length - 2, 1); else break;
    }
  }
  return out;
}

/** parallel copy of an orthogonal polyline shifted by `o` px to the left of the travel direction */
export function offsetPolyline(pts, o) {
  if (pts.length < 2 || !o) return pts.map((p) => ({ ...p }));
  const nrm = (a, b) => { const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y); return { x: dy, y: -dx }; };
  return pts.map((p, i) => {
    const n1 = i > 0 ? nrm(pts[i - 1], p) : null, n2 = i < pts.length - 1 ? nrm(p, pts[i + 1]) : null;
    if (n1 && n2 && (n1.x !== n2.x || n1.y !== n2.y)) return { x: p.x + (n1.x + n2.x) * o, y: p.y + (n1.y + n2.y) * o };
    const n = n1 || n2; return { x: p.x + n.x * o, y: p.y + n.y * o };
  });
}

/** insert a corner wherever two consecutive points are not on a common horizontal / vertical line */
export function orthogonalize(pts) {
  const out = [];
  for (const p of pts) {
    const a = out[out.length - 1];
    if (a && Math.abs(a.x - p.x) > 0.01 && Math.abs(a.y - p.y) > 0.01) {
      const prevH = out.length > 1 && Math.abs(out[out.length - 2].y - a.y) < 0.01;   // keep alternating directions
      out.push(prevH ? { x: a.x, y: p.y } : { x: p.x, y: a.y });
    }
    out.push({ ...p });
  }
  return out;
}
