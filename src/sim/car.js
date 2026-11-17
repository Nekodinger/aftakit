// 2WD robot car: chassis with two TT gear motors driven through ML± / MR± (usually from an L298N), differential-drive
// kinematics in an arena, and the sensors that ride on it.
//
// Motors use the shared electromechanical model of sim/drone.js (TT motor, gear 1:48) with the car's mass reflected to
// each motor shaft, so the car accelerates, coasts and reaches ±0.6–0.7 m/s at 6 V like a real kit. Wheel speeds give
// v = (vL + vR) / 2 and a turn rate (vL − vR) / effective track. The pose is integrated in simulated time (1 ms physics steps), so
// it follows delay() and millis() of the sketch exactly.
//
// Parts placed on the chassis plate in Desain are "on the car": an HC-SR04 / JSN-SR04T / VL53L0X there measures the
// distance to the arena walls and obstacles (three rays over a ±7.5° beam), an FC-51 IR sensor sees obstacles closer
// than 15 cm, a TCRT5000 sees the black line of the line-follower track. The 3D view draws the same arena and moves the
// car together with everything mounted on it.
import { H } from './behaviors2.js';
import { Rotor, MOTORS, phys } from './drone.js';

const { clamp, live, attr } = H;
const CPS = 16e6, MMPX = 1 / 3.7795;                       // simulator cycles per second · mm per canvas px
// wheelR, track in m; deck (top of the plate) and wheelW in mm. trackEff: wheel scrub and the caster make a real
// 2WD car turn slower than the geometric track predicts (a 90° pivot at full speed takes ±0.3 s on a TT-motor kit)
export const CAR = { wheelR: 0.0325, track: 0.14, trackEff: 0.25, gear: 48, deck: 39.5, wheelW: 26 };
export const CAR_TYPE = 'mod-car-chassis';

// ------------------------------------------------------------------ arenas (metres; x right, z backwards = down in Desain)
const WALL = 1.0;
const STADIUM = { r: 0.35, half: 0.35, cx: 0 };             // line track: two straights at x = ±r joined by half circles
export function arenaOf(name) {
  const s = String(name || '');
  const walls = /bebas/.test(s) ? null : { half: WALL, h: 0.12 };
  const boxes = /rintangan/.test(s) ? [
    { x: 0, z: -0.62, w: 0.46, d: 0.08, h: 0.12, c: 0xc0392b },
    { x: -0.6, z: 0.05, w: 0.14, d: 0.14, h: 0.14, c: 0x2e86c1 },
    { x: 0.62, z: 0.3, w: 0.18, d: 0.18, h: 0.1, c: 0x27ae60 },
    { x: 0.58, z: -0.52, w: 0.16, d: 0.16, h: 0.12, c: 0xf39c12 },
    { x: -0.35, z: 0.62, w: 0.3, d: 0.08, h: 0.12, c: 0x8e44ad },
  ] : [];
  const line = /garis/.test(s);
  return { name: s, walls, boxes, line, track: line ? STADIUM : null, start: line ? { x: -STADIUM.r, z: 0, th: 0 } : { x: 0, z: 0, th: 0 } };
}
/** points of the black line (closed polyline) */
export function trackPoints(t, n = 96) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;             // walk: right straight down, bottom arc, left straight up, top arc
    const u = a / (Math.PI * 2) * (4 * t.half + 2 * Math.PI * t.r), L1 = 2 * t.half, L2 = Math.PI * t.r;
    if (u < L1) pts.push({ x: t.r, z: -t.half + u });
    else if (u < L1 + L2) { const b = (u - L1) / t.r; pts.push({ x: t.r * Math.cos(b), z: t.half + t.r * Math.sin(b) }); }
    else if (u < 2 * L1 + L2) pts.push({ x: -t.r, z: t.half - (u - L1 - L2) });
    else { const b = (u - 2 * L1 - L2) / t.r; pts.push({ x: -t.r * Math.cos(b), z: -t.half - t.r * Math.sin(b) }); }
  }
  return pts;
}
function distToTrack(t, x, z) {
  // stadium: distance to the centre segment (0, ±half) inflated by r
  const cz = clamp(z, -t.half, t.half);
  return Math.abs(Math.hypot(x - t.cx, z - cz) - t.r);
}

// ------------------------------------------------------------------ what rides on the car (shared with the 3D view)
const centre = (p) => ({ x: p.left + (p.size?.[0] || 0) / 2, y: p.top + (p.size?.[1] || 0) / 2 });
const rot2 = (v, k) => { let { x, y } = v; for (let i = 0; i < (k & 3); i++) [x, y] = [-y, x]; return { x, y }; };
/** ids of parts whose centre lies on the chassis (parts: {id, type, left, top, size, rot}) */
export function mountedOn(car, parts) {
  const [w, h] = car.size || [600, 700], k = car.rot & 3, W = k & 1 ? h : w, Hh = k & 1 ? w : h, c = centre(car);
  const out = [];
  for (const p of parts) {
    if (p.id === car.id || p.type === CAR_TYPE) continue;
    const q = centre(p);
    if (Math.abs(q.x - c.x) <= W / 2 - 8 && Math.abs(q.y - c.y) <= Hh / 2 - 8) out.push(p.id);
  }
  return out;
}
// facing of a sensor in Desain coordinates (unit vector, y down): distance sensors stand on their pin row and look away
// from their body toward the pins' side (as the 3D model stands them up); FC-51 looks out of its IR LED end
const FACE = { 'wokwi-hc-sr04': { x: 0, y: 1 }, 'mod-jsn-sr04t': { x: 0, y: 1 }, 'mod-vl53l0x': { x: 0, y: 1 }, 'mod-ir-obstacle': { x: 1, y: 0 } };
export const DIST_SENSORS = { 'wokwi-hc-sr04': { max: 4.0, unit: 100 }, 'mod-jsn-sr04t': { max: 4.5, unit: 100 }, 'mod-vl53l0x': { max: 2.0, unit: 1000 }, 'mod-tfluna': { max: 8, unit: 100 } };

// ------------------------------------------------------------------ geometry helpers
function rayBox(ox, oz, dx, dz, b) {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  let t0 = 0, t1 = Infinity;
  for (const [o, d, lo, hi] of [[ox, dx, x0, x1], [oz, dz, z0, z1]]) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return Infinity; continue; }
    let a = (lo - o) / d, c = (hi - o) / d; if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) return Infinity;
  }
  return t0 > 0 ? t0 : Infinity;
}
function rayArena(ar, ox, oz, dx, dz) {
  let best = Infinity;
  if (ar.walls) {
    const L = ar.walls.half;
    if (dx > 1e-9) best = Math.min(best, (L - ox) / dx); if (dx < -1e-9) best = Math.min(best, (-L - ox) / dx);
    if (dz > 1e-9) best = Math.min(best, (L - oz) / dz); if (dz < -1e-9) best = Math.min(best, (-L - oz) / dz);
  }
  for (const b of ar.boxes) best = Math.min(best, rayBox(ox, oz, dx, dz, b));
  return best;
}

// ------------------------------------------------------------------ behaviour
const volts = (sim, a, b) => { const v = sim.last; if (!v) return null; const x = v.v(a), y = v.v(b); return live(x) && live(y) ? (x - y) * 5 : null; };
export const carBehavior = (ctx) => {
  const sim = ctx.sim, m = MOTORS['mod-motor-tt'];
  const mass = () => clamp(+attr(ctx, 'mass', 600), 100, 3000) / 1000;
  // each motor carries half the car: reflected inertia m·r²/2 / G² on the motor shaft, rolling resistance as viscous loss
  const motor = () => new Rotor({ ...m, J: m.J + (mass() / 2) * CAR.wheelR ** 2 / CAR.gear ** 2, b: m.b + 1.2e-7 * mass() }, null);
  let L = motor(), R = motor(), ar = arenaOf(attr(ctx, 'arena', '')), mounts = [], sensT = 0, lastC = 0, angL = 0, angR = 0, bumpT = -99, txtT = 0;
  const pose = { x: 0, z: 0, th: 0, v: 0, w: 0, vl: 0, vr: 0, bumped: false };
  const st = { pose, arena: () => ar, mounts: () => mounts, reset: () => reset(true) };
  function reset(keepMotors) {
    ar = arenaOf(attr(ctx, 'arena', '')); Object.assign(pose, ar.start, { v: 0, w: 0, vl: 0, vr: 0, bumped: false });
    if (!keepMotors) { L = motor(); R = motor(); } else { L.reset(); R.reset(); }
    sim.emit('car', { id: ctx.part.id, reset: true });
  }
  function readMounts() {
    const parts = (sim.model?.parts || []).filter((p) => p.left !== undefined);
    const me = parts.find((p) => p.id === ctx.part.id); if (!me) return [];
    const c = centre(me), k = me.rot & 3;
    return mountedOn(me, parts).map((id) => parts.find((p) => p.id === id)).filter((p) => DIST_SENSORS[p.type] || p.type === 'mod-ir-obstacle' || p.type === 'mod-tcrt5000').map((p) => {
      // offset and facing in the car's own frame (undo the chassis rotation)
      const q = centre(p), d = rot2({ x: (q.x - c.x) * MMPX / 1000, y: (q.y - c.y) * MMPX / 1000 }, 4 - k);
      const f = FACE[p.type] ? rot2(rot2(FACE[p.type], p.rot & 3), 4 - k) : null;
      return { part: p, dx: d.x, dz: d.y, fx: f?.x ?? 0, fz: f?.y ?? -1 };
    });
  }
  /** world position / direction of a mounted sensor */
  const toWorld = (s) => {
    const c = Math.cos(pose.th), sn = Math.sin(pose.th);
    // heading th: forward (0, -1) turned clockwise (seen from above) by th
    return { x: pose.x + s.dx * c - s.dz * sn, z: pose.z + s.dx * sn + s.dz * c, fx: s.fx * c - s.fz * sn, fz: s.fx * sn + s.fz * c };
  };
  function senseAll() {
    let changed = false;
    for (const s of mounts) {
      const w = toWorld(s), p = s.part, a = p.attrs || (p.attrs = {});
      if (DIST_SENSORS[p.type]) {
        const spec = DIST_SENSORS[p.type]; let d = Infinity;
        for (const da of [-0.13, 0, 0.13]) {                  // ±7.5° beam
          const c = Math.cos(da), sn = Math.sin(da), dx = w.fx * c - w.fz * sn, dz = w.fx * sn + w.fz * c;
          d = Math.min(d, rayArena(ar, w.x, w.z, dx, dz));
        }
        const val = Math.round(Math.min(d, spec.max + 0.5) * spec.unit);
        if (+a.distance !== val) { a.distance = val; changed = true; }
      } else if (p.type === 'mod-ir-obstacle') {
        const on = rayArena(ar, w.x, w.z, w.fx, w.fz) < 0.15;
        if (!!a.obstacle !== on) { a.obstacle = on; changed = true; }
      } else if (p.type === 'mod-tcrt5000') {
        const on = !!ar.track && distToTrack(ar.track, w.x, w.z) < 0.0125;
        if (!!a.black !== on) { a.black = on; changed = true; }
      }
    }
    if (changed) sim.emit('attrs', ctx.part.id);
  }
  // the car's outline (rectangle of the chassis with its wheels) against the walls and the boxes
  const HW = 0.079, HL = 0.093, OUTLINE = [[-HW, -HL], [HW, -HL], [HW, HL], [-HW, HL], [0, -HL], [0, HL], [-HW, 0], [HW, 0]];
  function collide() {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      const c = Math.cos(pose.th), sn = Math.sin(pose.th);
      let px = 0, pz = 0;
      for (const [lx, lz] of OUTLINE) {
        const x = pose.x + lx * c - lz * sn, z = pose.z + lx * sn + lz * c;
        if (ar.walls) {
          const L = ar.walls.half;
          if (x > L) px = Math.min(px, L - x); if (x < -L) px = Math.max(px, -L - x);
          if (z > L) pz = Math.min(pz, L - z); if (z < -L) pz = Math.max(pz, -L - z);
        }
        for (const b of ar.boxes) {
          const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
          if (x <= x0 || x >= x1 || z <= z0 || z >= z1) continue;
          const m = [[x0 - x, 0], [x1 - x, 0], [0, z0 - z], [0, z1 - z]].sort((a, b2) => Math.hypot(...a) - Math.hypot(...b2))[0];
          if (Math.abs(m[0]) > Math.abs(px)) px = m[0]; if (Math.abs(m[1]) > Math.abs(pz)) pz = m[1];
        }
      }
      if (!px && !pz) break;
      pose.x += px; pose.z += pz; hit = true;
    }
    return hit;
  }
  return {
    attach() {
      phys(sim).add(this, 2);
      mounts = readMounts(); senseAll();
      const direct = ['ML+', 'ML-', 'MR+', 'MR-'].flatMap((p) => ctx.ardPins(p));
      if (direct.length) sim.warn(`car-direct-${ctx.part.id}`, `${ctx.label}: motor terhubung langsung ke pin mikrokontroler (${direct.join(', ')}). Gunakan driver motor (L298N / L9110S / TB6612).`);
    },
    step(dt) {
      const vL = volts(sim, ctx.n('ML+'), ctx.n('ML-')) ?? 0, vR = volts(sim, ctx.n('MR+'), ctx.n('MR-')) ?? 0;
      L.step(dt, vL); R.step(dt, vR);
      pose.vl = (L.w / CAR.gear) * CAR.wheelR; pose.vr = (R.w / CAR.gear) * CAR.wheelR;
      pose.v = (pose.vl + pose.vr) / 2; pose.w = (pose.vl - pose.vr) / CAR.trackEff;
      pose.th += pose.w * dt;
      pose.x += pose.v * Math.sin(pose.th) * dt; pose.z -= pose.v * Math.cos(pose.th) * dt;
      const hit = collide();
      if (hit && !pose.bumped && Math.abs(pose.v) > 0.05 && phys(sim).t - bumpT > 3) { bumpT = phys(sim).t; if (sim.running) sim.info(`${ctx.label}: menabrak dinding / rintangan arena (posisi ${pose.x.toFixed(2)}, ${(-pose.z).toFixed(2)} m).`); }
      pose.bumped = hit;
      if ((sensT += dt) >= 0.01) { sensT = 0; senseAll(); }
      const vb = Math.max(Math.abs(vL), Math.abs(vR), 1);
      phys(sim).loads.set(ctx.part.id, { bat: phys(sim).batteryFor(ctx.n('ML+')), amps: (Math.max(0, vL * L.I) + Math.max(0, vR * R.I)) / vb });
    },
    render() {
      const c = sim.board.cpu.cycles, dt = Math.min(0.1, (c - lastC) / CPS); lastC = c;
      angL = (angL + clamp(L.rpm / CAR.gear / 60 * 360 * dt, -40, 40)) % 360; angR = (angR + clamp(R.rpm / CAR.gear / 60 * 360 * dt, -40, 40)) % 360;
      ctx.el.setRotor?.('l', angL); ctx.el.setRotor?.('r', -angR);
      if (c - txtT > CPS * 0.1) {
        txtT = c; const deg = ((pose.th * 180 / Math.PI) % 360 + 360) % 360;
        // shown as (x to the right, y forward) from the start position, heading clockwise from "forward"
        ctx.el.setText?.('pose', `posisi ${(pose.x - ar.start.x).toFixed(2)}, ${(-(pose.z - ar.start.z)).toFixed(2)} m · arah ${Math.round(deg)}°`);
        ctx.el.setText?.('spd', `${pose.v.toFixed(2)} m/s${pose.bumped ? ' · menabrak!' : ''}`);
      }
    },
    reset() { reset(false); mounts = readMounts(); phys(sim).restart(); senseAll(); },
    car: st,
  };
};

export const CAR_BEHAVIORS = { [CAR_TYPE]: carBehavior };
