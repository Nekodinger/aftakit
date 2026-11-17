// Realistic 3D models of the catalogue parts.
//
// Every part is built in its own coordinates (mm, origin at the centre of its 2D artwork, x right, z = artwork
// down, y up). Two techniques are combined:
//  • "lifted artwork": regions of the part's live 2D artwork become real solids (a chip becomes a 1.2 mm black
//    package, an HC-SR04 transducer a 12 mm metal can, an LCD a bezel with the live screen inside …). Their top
//    faces show the matching piece of the artwork texture, so printed details and live states (screens, LEDs,
//    rotating motor hubs) stay correct.
//  • hand-made models for parts whose shape is the point: LEDs, resistors, diodes, capacitors, transistors,
//    buttons, potentiometers, servo (with turning horn), stepper, motors, batteries, joystick, drone frame …
// The pins decide how a part stands: modules plugged into a breadboard sit on male headers (or stand upright on
// right-angle / edge pins such as the HC-SR04 or DHT22), loose modules show their headers pointing up for jumper
// wires, boards like the Uno have female headers. Each pin gets a contact marker where wires attach.
import * as THREE from 'three';

export const MM = 1 / 3.7795;
export const BB_H = 8.5;
const PCB = 1.6, SPACER = 2.5, PIN_UP = 6, PIN_DN = 3;
import { C, S } from './partspec.js';
export { SPEC } from './partspec.js';


// ------------------------------------------------------------------ helpers
const mat = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: o.r ?? 0.6, metalness: o.m ?? (o.metal ? 0.75 : 0.05), ...(o.extra || {}) });
const isMetal = (c) => c === C.silver || c === C.mesh || c === 0x9da3ab || c === 0xc8c8c8 || c === 0xd5d8dc || c === 0xc4c8ce;
function shade(c, k) { const x = new THREE.Color(c); x.multiplyScalar(k); return x; }

/** set uv of all upward-facing vertices from their position in part coordinates (so a top face shows its piece of the artwork) */
function topUV(geom, ox, oz, W, D) {
  const p = geom.attributes.position, n = geom.attributes.normal; let uv = geom.attributes.uv;
  if (!uv) { uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2); geom.setAttribute('uv', uv); }
  for (let i = 0; i < p.count; i++) if (n.getY(i) > 0.5) uv.setXY(i, (p.getX(i) + ox) / W + 0.5, 1 - ((p.getZ(i) + oz) / D + 0.5));
  uv.needsUpdate = true;
}
function roundedRect(w, d, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2; r = Math.min(r, w / 2, d / 2);
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
}

// ------------------------------------------------------------------ build one part
/**
 * @param o { part, W, D (mm), tex (live CanvasTexture of the artwork), plugged (bool), catalog, glowTex }
 * @returns { root, contacts: Map(pin -> Object3D), update(), pick (meshes for direct interaction), kind }
 */
export function buildPart3D(o) {
  const { part, W, D, tex } = o, spec = S[part.type] || {}, cat = o.catalog[part.type] || {};
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); root.userData.partId = part.id;
  const contacts = new Map(), out = { root, contacts, kind: spec.special || 'generic', update: null, pick: null, texMats: [] };
  const fx = (f) => (f - 0.5) * W, fz = (f) => (f - 0.5) * D;
  const pinLocal = (info) => ({ x: (info.x * MM) - W / 2, z: (info.y * MM) - D / 2 });
  const [pw, ph] = part.size;
  const pins = part.pinInfo.map((i) => ({ name: i.name, x: (i.x / (pw || 1) - 0.5) * W, z: (i.y / (ph || 1) - 0.5) * D, fx: i.x / (pw || 1), fy: i.y / (ph || 1) }));
  const texMat = () => { const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0.05 }); out.texMats.push(m); return m; };
  const add = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; body.add(m); return m; };

  // ---------- board / body base
  const isBoard = !!cat.board || cat.cat === 'Mikrokontroler';
  let pcbRect = spec.pcb === false ? null : (spec.pcb || [0, 0, 1, 1]);
  const T = spec.pcb === false ? 0 : (spec.h ?? PCB);
  if (spec.ring) {                                                   // NeoPixel ring: annulus PCB + one 5050 per pixel
    const ro = Math.min(W, D) * 0.48, ri = ro * 0.74, sh = new THREE.Shape(); sh.absarc(0, 0, ro, 0, Math.PI * 2, false); const hole = new THREE.Path(); hole.absarc(0, 0, ri, 0, Math.PI * 2, true); sh.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(sh, { depth: PCB, bevelEnabled: false, curveSegments: 48 }); g.rotateX(-Math.PI / 2); g.translate(0, 0, -D * 0.02);
    add(new THREE.Mesh(g, mat(0x1d4d26)));
    const n = +part.el.pixels || 16, rr = (ro + ri) / 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2, gx = Math.cos(a) * rr, gz = Math.sin(a) * rr - D * 0.02;
      const bg = new THREE.BoxGeometry(5, 1.6, 5); topUV(bg, gx, gz + 0.8, W, D);
      const m = new THREE.Mesh(bg, [mat(C.white), mat(C.white), texMat(), mat(C.white), mat(C.white), mat(C.white)]); m.position.set(gx, PCB + 0.8, gz); m.rotation.y = -a; add(m);
    }
    pcbRect = null;
  } else if (pcbRect) {
    const [x0, y0, x1, y1] = pcbRect, w = (x1 - x0) * W, d = (y1 - y0) * D, cx = fx((x0 + x1) / 2), cz = fz((y0 + y1) / 2);
    const g = new THREE.ExtrudeGeometry(roundedRect(w, d, Math.min(1.2, w / 8)), { depth: T, bevelEnabled: false, curveSegments: 6 });
    g.rotateX(-Math.PI / 2); g.translate(cx, 0, cz); topUV(g, 0, 0, W, D);
    const side = mat(0x2d6b3f, { r: 0.8 }); out.pcbSide = side;                       // edge colour follows the artwork later
    const pcb = new THREE.Mesh(g, [texMat(), side]); add(pcb); out.pcb = pcb;
  }

  // ---------- lifted artwork features
  const top = T;
  for (const f of spec.f || []) {
    const k = f[0];
    if (k === 'box') {
      const [, x0, y0, x1, y1, h, color, tx = 1, z0 = 0] = f, w = (x1 - x0) * W, d = (y1 - y0) * D, cx = fx((x0 + x1) / 2), cz = fz((y0 + y1) / 2);
      const g = new THREE.BoxGeometry(w, h, d); if (tx) topUV(g, cx, cz, W, D);
      const sm = mat(color, { metal: isMetal(color), r: isMetal(color) ? 0.35 : 0.6 });
      const m = new THREE.Mesh(g, [sm, sm, tx ? texMat() : sm, sm, sm, sm]); m.position.set(cx, top + z0 + h / 2, cz); add(m);
    } else if (k === 'cyl') {
      const [, cxf, cyf, r0, h, color, tx = 1, z0 = 0] = f, r = r0 < 1 ? r0 * W : r0, cx = fx(cxf), cz = fz(cyf);
      const g = new THREE.CylinderGeometry(r, r, h, 40); if (tx) topUV(g, cx, cz, W, D);
      const sm = mat(color, { metal: isMetal(color), r: isMetal(color) ? 0.35 : 0.55 });
      const m = new THREE.Mesh(g, [sm, tx ? texMat() : sm, sm]); m.position.set(cx, top + z0 + h / 2, cz); add(m);
    } else if (k === 'dome') {
      const [, cxf, cyf, r0, color, op] = f, r = r0 < 1 ? r0 * W : r0;
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshPhysicalMaterial({ color, roughness: 0.35, transparent: op < 1, opacity: op, clearcoat: 0.3 }));
      m.position.set(fx(cxf), top + (part.type.includes('pir') ? 2 : 0), fz(cyf)); add(m);
    } else if (k === 'bezel') {                                        // LCD: black frame with the live screen sunk inside
      const [, x0, y0, x1, y1, sx0, sy0, sx1, sy1, h] = f, bm = mat(0x111111, { r: 0.5 });
      const rects = [[x0, y0, x1, sy0], [x0, sy1, x1, y1], [x0, sy0, sx0, sy1], [sx1, sy0, x1, sy1]];
      for (const [a, b, c2, d2] of rects) { const m = new THREE.Mesh(new THREE.BoxGeometry((c2 - a) * W, h, (d2 - b) * D), bm); m.position.set(fx((a + c2) / 2), top + h / 2, fz((b + d2) / 2)); add(m); }
      const sg = new THREE.BoxGeometry((sx1 - sx0) * W, h - 0.8, (sy1 - sy0) * D), scx = fx((sx0 + sx1) / 2), scz = fz((sy0 + sy1) / 2); topUV(sg, scx, scz, W, D);
      const glass = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.25, metalness: 0.0, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 }); out.texMats.push(glass);
      const s = new THREE.Mesh(sg, [bm, bm, glass, bm, bm, bm]); s.position.set(scx, top + (h - 0.8) / 2, scz); add(s);
    } else if (k === 'grid') {
      const [, x0, y0, x1, y1, nx, ny, fill, h, color] = f, cw = (x1 - x0) / nx, ch = (y1 - y0) / ny, sm = mat(color);
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const cx = fx(x0 + (i + 0.5) * cw), cz = fz(y0 + (j + 0.5) * ch), g = new THREE.BoxGeometry(cw * W * fill, h, ch * D * fill); topUV(g, cx, cz, W, D);
        const m = new THREE.Mesh(g, [sm, sm, texMat(), sm, sm, sm]); m.position.set(cx, top + h / 2, cz); add(m);
      }
    } else if (k === 'hs') {                                           // finned heatsink
      const [, x0, y0, x1, y1, h, fins] = f, w = (x1 - x0) * W, d = (y1 - y0) * D, cx = fx((x0 + x1) / 2), cz = fz((y0 + y1) / 2), hm = mat(0x1a1a1a, { r: 0.45, m: 0.4 });
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, 3, d), hm); base.position.set(cx, top + 1.5, cz); add(base);
      for (let i = 0; i < fins; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(w / (fins * 2.2), h - 3, d), hm); m.position.set(cx - w / 2 + (i + 0.5) * (w / fins), top + 3 + (h - 3) / 2, cz); add(m); }
    } else if (k === 'term') {                                         // blue screw terminal block
      const [, x0, y0, x1, y1] = f, w = (x1 - x0) * W, d = (y1 - y0) * D, cx = fx((x0 + x1) / 2), cz = fz((y0 + y1) / 2), h = 10, tm = mat(C.blueTerm, { r: 0.5 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), tm); m.position.set(cx, top + h / 2, cz); add(m);
      const along = d > w, n = Math.max(2, Math.round((along ? d : w) / 5)), sm = mat(C.silver, { metal: true, r: 0.3 });
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5, s = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.6, 16), sm); s.position.set(cx + (along ? 0 : t * w), top + h + 0.3, cz + (along ? t * d : 0)); add(s, false);
        const slot = new THREE.Mesh(new THREE.BoxGeometry(along ? 2.2 : 0.4, 0.2, along ? 0.4 : 2.2), mat(0x333333)); slot.position.set(s.position.x, s.position.y + 0.35, s.position.z); add(slot, false);
      }
    } else if (k === 'pipe') {                                         // lying cylinder
      const [, ax, a0, a1, c, r, color, zc] = f, len = (a1 - a0) * (ax === 'x' ? W : D), g = new THREE.CylinderGeometry(r, r, len, 28);
      const m = new THREE.Mesh(g, mat(color, { metal: isMetal(color) || color === 0xc9a227, r: 0.35 }));
      if (ax === 'x') { m.rotation.z = Math.PI / 2; m.position.set(fx((a0 + a1) / 2), top + zc, fz(c)); } else { m.rotation.x = Math.PI / 2; m.position.set(fx(c), top + zc, fz((a0 + a1) / 2)); }
      add(m);
    } else if (k === 'lens') {                                         // 5 mm LED lens over the (live) artwork
      const [, cxf, cyf, r, color] = f, lm = new THREE.MeshPhysicalMaterial({ color, transparent: true, opacity: 0.55, roughness: 0.15, emissive: color, emissiveIntensity: 0 });
      const cy = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 4.5, 28), lm); cy.position.set(fx(cxf), top + 2.25, fz(cyf)); add(cy);
      const dm = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), lm); dm.position.set(fx(cxf), top + 4.5, fz(cyf)); add(dm);
      (out.lenses ||= []).push({ m: lm, fx: cxf, fy: cyf });
    }
  }

  // ---------- special models
  const sp = spec.special;
  const legMat = mat(0xc4c4c4, { metal: true, r: 0.3 });
  const leg = (x, z, y0, y1, r = 0.25) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(0.01, y1 - y0), 8), legMat); m.position.set(x, (y0 + y1) / 2, z); add(m, false); return m; };
  const pinsBy = (n) => pins.find((p) => p.name === n);
  const legsH = o.plugged ? 3 : 4;                                     // body height above the base on its legs
  if (sp === 'led' || sp === 'rgbled') {
    const ps = pins; const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length, cz = ps.reduce((s, p) => s + p.z, 0) / ps.length;
    const rgb = sp === 'rgbled', col = new THREE.Color(rgb ? 0xffffff : ({ red: '#ff2a2a', green: '#2bff4a', blue: '#3b7bff', yellow: '#ffe23b', white: '#ffffff', orange: '#ff8c1a', purple: '#b04bff' }[part.el.color] || part.el.color || '#ff2a2a'));
    const lens = new THREE.MeshPhysicalMaterial({ color: col, transparent: true, opacity: rgb ? 0.88 : 0.78, roughness: rgb ? 0.55 : 0.15, transmission: 0.2, emissive: col, emissiveIntensity: 0 });
    const y = legsH;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 5.2, 28), lens); cyl.position.set(cx, y + 2.6, cz); add(cyl);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.5, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), lens); dome.position.set(cx, y + 5.2, cz); add(dome);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 1, 28), lens); rim.position.set(cx, y + 0.5, cz); add(rim);
    for (const p of ps) { const lx = cx + (p.x - cx) * Math.min(1, 1.6 / (Math.hypot(p.x - cx, p.z - cz) || 1)), lz = cz + (p.z - cz) * Math.min(1, 1.6 / (Math.hypot(p.x - cx, p.z - cz) || 1)); leg(lx, lz, 0.6, y + 0.4); leg(p.x, p.z, 0, 0.7); const j = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, Math.hypot(p.x - lx, p.z - lz) + 0.3, 6), legMat); j.rotation.z = Math.PI / 2; j.rotation.y = -Math.atan2(p.z - lz, p.x - lx); j.position.set((p.x + lx) / 2, 0.65, (p.z + lz) / 2); add(j, false); }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: o.glowTex, color: col, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); glow.scale.set(16, 16, 1); glow.position.set(cx, y + 4, cz); body.add(glow);
    const light = new THREE.PointLight(col, 0, 60, 2); light.position.set(cx, y + 4, cz); body.add(light);
    out.update = () => {
      const el = part.el; let br, c = null;
      if (rgb) { const r = +el.ledRed || 0, g = +el.ledGreen || 0, b = +el.ledBlue || 0; br = Math.max(r, g, b); if (br > 0) c = new THREE.Color(r / br, g / br, b / br); }
      else br = el.value ? Math.max(0.15, Math.min(1, +(el.brightness ?? 1) || 1)) : 0;
      if (c) { lens.emissive.copy(c); glow.material.color.copy(c); light.color.copy(c); }
      lens.emissiveIntensity = 0.1 + 1.6 * br; glow.material.opacity = 0.85 * br; light.intensity = 900 * br;
    };
    out.kind = 'led';
  } else if (sp === 'res' || sp === 'diode') {
    const a = pins[0], b = pins[pins.length - 1], len = Math.hypot(b.x - a.x, b.z - a.z), ang = Math.atan2(b.z - a.z, b.x - a.x);
    const g = new THREE.Group(); g.position.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2); g.rotation.y = -ang; body.add(g);
    const y0 = sp === 'res' ? 2.6 : 2.4, bodyL = sp === 'res' ? Math.min(6.3, len * 0.62) : Math.min(5.2, len * 0.55), r = sp === 'res' ? 1.15 : 1.35;
    const bm = new THREE.Mesh(new THREE.CapsuleGeometry(r, bodyL - 2 * r, 6, 18), mat(sp === 'res' ? 0xd8c3a0 : 0x1a1a1a, { r: 0.6 })); bm.rotation.z = Math.PI / 2; bm.position.y = y0; bm.castShadow = true; g.add(bm);
    const bands = sp === 'res' ? resistorBands(part.attrs?.value ?? part.el.value) : ['#d0d0d0'];
    bands.forEach((bc, i) => {
      const rr = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.05, r + 0.05, sp === 'res' ? 0.45 : 0.7, 18), mat(bc, { r: 0.45 })); rr.rotation.z = Math.PI / 2;
      rr.position.set(sp === 'res' ? -bodyL / 2 + 1.0 + i * (i === 3 ? 1.35 : 0.95) : bodyL / 2 - 1.1, y0, 0); g.add(rr);
    });
    for (const s of [-1, 1]) {
      const hz = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, len / 2 - bodyL / 2 + 0.3, 6), legMat); hz.rotation.z = Math.PI / 2; hz.position.set(s * (len / 2 + bodyL / 2) / 2, y0, 0); g.add(hz);
      const vt = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, y0, 6), legMat); vt.position.set(s * len / 2, y0 / 2, 0); g.add(vt);
    }
    out.kind = 'res';
  } else if (sp === 'ecap') {
    const r = Math.min(W, D) * 0.42, h = 11, cx = 0, cz = -D * 0.08, y = 1;
    const g = new THREE.CylinderGeometry(r, r, h, 36); topUV(g, cx, cz, W, D);
    const sleeve = mat(0x1f4fa0, { r: 0.4 }); const m = new THREE.Mesh(g, [sleeve, mat(C.silver, { metal: true, r: 0.3 }), sleeve]); m.position.set(cx, y + h / 2, cz); add(m);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.02, r + 0.02, h * 0.98, 36, 1, true, Math.PI * 0.35, Math.PI * 0.35), mat(0xdfe6f0)); stripe.position.copy(m.position); add(stripe, false);
    for (const p of pins) leg(p.x, p.z, 0, y + 0.2);
  } else if (sp === 'to92') {
    const cx = pins.reduce((s, p) => s + p.x, 0) / pins.length, cz = pins.reduce((s, p) => s + p.z, 0) / pins.length - 1.5, y = 3;
    const g = new THREE.CylinderGeometry(2.4, 2.4, 4.6, 28, 1, false, -Math.PI / 2, Math.PI); const m = new THREE.Mesh(g, mat(0x1a1a1a, { r: 0.5 })); m.position.set(cx, y + 2.3, cz); add(m);
    const f2 = new THREE.Mesh(new THREE.BoxGeometry(4.8, 4.6, 0.02), mat(0x1a1a1a)); f2.position.set(cx, y + 2.3, cz); add(f2);
    for (const p of pins) leg(p.x, p.z, 0, y + 0.2, 0.22);
  } else if (sp === 'button') {
    const six = /6mm/.test(part.type), s = six ? 6 : 12, y = 0.4;
    const b = new THREE.Mesh(new THREE.BoxGeometry(s, 3.4, s), mat(0x1d1d1d)); b.position.y = y + 1.7; add(b);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(s * 0.96, 0.3, s * 0.96), mat(0xb0b0b0, { metal: true, r: 0.3 })); plate.position.y = y + 3.55; add(plate);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const k = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.35, 10), mat(0x111111)); k.position.set(dx * s * 0.36, y + 3.75, dz * s * 0.36); add(k, false); }
    const capCol = { red: 0xd32f2f, green: 0x2e7d32, blue: 0x1565c0, yellow: 0xf9c80e, white: 0xf2f2f2, black: 0x222222 }[part.el.color] ?? 0xd32f2f;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.29, s * 0.31, 3, 28), mat(capCol, { r: 0.45 })); cap.position.y = y + 5; add(cap);
    for (const p of pins) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, Math.abs(p.z) > Math.abs(p.x) ? 0.7 : 2.5), legMat); m.position.set(p.x * 0.85, y + 0.6, p.z * 0.85); add(m, false); leg(p.x, p.z, 0, y + 0.6); }
    out.update = () => { cap.position.y = part.el.pressed ? y + 4.1 : y + 5; };
    out.pick = cap; out.kind = 'button';
  } else if (sp === 'pot') {                                           // rotary potentiometer module
    const cx = fx(0.53), cz = fz(0.42), r = 0.3 * W;
    const can = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 6, 40), mat(0x9aa0a8, { metal: true, r: 0.35 })); can.position.set(cx, T + 3, cz); add(can);
    const knob = new THREE.Group(); knob.position.set(cx, T + 6, cz); body.add(knob);
    const bush = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 4, 24), mat(C.silver, { metal: true, r: 0.3 })); bush.position.y = 2; knob.add(bush);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 9, 20), mat(0xe5e5e5, { r: 0.5 })); shaft.position.y = 8.5; shaft.castShadow = true; knob.add(shaft);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 2.8), mat(0x222222)); mark.position.set(0, 13.05, -1.6); knob.add(mark);
    out.update = () => { const el = part.el, f = ((+el.value || 0) - (el.min ?? 0)) / (((el.max ?? 1023) - (el.min ?? 0)) || 1); knob.rotation.y = -(-135 + 270 * Math.min(1, Math.max(0, f))) * Math.PI / 180; };
    out.pick = shaft; out.kind = 'pot';
  } else if (sp === 'slidepot') {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.86 * W, 7, 0.36 * D), [mat(C.silver, { metal: true, r: 0.35 }), mat(C.silver, { metal: true, r: 0.35 }), texMat(), mat(C.silver, { metal: true }), mat(C.silver, { metal: true }), mat(C.silver, { metal: true })]);
    topUV(base.geometry, 0, fz(0.51), W, D); base.position.set(0, 7 / 2 + 0.5, fz(0.51)); add(base);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.09 * W, 9, 0.6 * D), mat(0x1b1b1b, { r: 0.5 })); knob.position.set(0, 7 + 4.5, fz(0.55)); add(knob);
    for (const p of pins) leg(p.x, p.z, 0, 0.6);
    out.update = () => { const el = part.el, f = ((+el.value || 0) - (el.min ?? 0)) / (((el.max ?? 100) - (el.min ?? 0)) || 1); knob.position.x = fx(0.22 + 0.56 * Math.min(1, Math.max(0, f))); };
    out.pick = knob; out.kind = 'slidepot';
  } else if (sp === 'joystick') {
    const cx = fx(0.5), cz = fz(0.46), hous = new THREE.Mesh(new THREE.BoxGeometry(0.72 * W, 10, 0.68 * D), mat(0x1c1c1c, { r: 0.55 })); hous.position.set(cx, T + 5, cz); add(hous);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.25 * W, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x2a2a2a)); ball.position.set(cx, T + 10, cz); add(ball);
    const stick = new THREE.Group(); stick.position.set(cx, T + 10, cz); body.add(stick);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 10, 16), mat(0x333333)); rod.position.y = 5; stick.add(rod);
    const capG = new THREE.CylinderGeometry(0.42 * W, 0.42 * W, 5, 40); topUV(capG, 0, 0, W, D);
    const capM = mat(0x2b2b2b, { r: 0.8 }); const capT = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.9 });
    const cap = new THREE.Mesh(capG, [capM, capT, capM]); cap.position.y = 12; cap.castShadow = true; stick.add(cap);
    out.update = () => { const el = part.el; stick.rotation.z = (+el.xValue || 0) * 0.35; stick.rotation.x = -(+el.yValue || 0) * 0.35; };
  } else if (sp === 'buzzer') {
    const cx = fx(0.43), cz = fz(0.45), r = 0.42 * W, h = 9.5, y = 0.6;
    const g = new THREE.CylinderGeometry(r, r, h, 40); topUV(g, cx, cz, W, D);
    const sm = mat(0x141414, { r: 0.55 }); const m = new THREE.Mesh(g, [sm, texMat(), sm]); m.position.set(cx, y + h / 2, cz); add(m);
    for (const p of pins) leg(p.x, p.z, 0, y + 0.2);
  } else if (sp === 'encoder') {
    const cx = fx(0.43), cz = fz(0.47), sh = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 14, 20), mat(0xbfbfbf, { metal: true, r: 0.4 })); sh.position.set(cx, T + 6.5 + 7, cz); add(sh);
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 2, 6), mat(C.silver, { metal: true, r: 0.3 })); nut.position.set(cx, T + 7.5, cz); add(nut);
  } else if (sp === 'servo') {
    // SG90: blue case, mounting tabs, output boss with the horn turning to el.angle, 3-wire lead to the connector
    const blue = new THREE.MeshPhysicalMaterial({ color: 0x2457c5, roughness: 0.35, transmission: 0.05, clearcoat: 0.4 });
    const bx = [0.33, 0.9], bz = [0.3, 0.65], bw = (bx[1] - bx[0]) * W, bd = (bz[1] - bz[0]) * D, bcx = fx((bx[0] + bx[1]) / 2), bcz = fz((bz[0] + bz[1]) / 2);
    const caseM = new THREE.Mesh(new THREE.BoxGeometry(bw, 22.5, bd), blue); caseM.position.set(bcx, 11.25, bcz); add(caseM);
    const tabs = new THREE.Mesh(new THREE.BoxGeometry(0.69 * W, 2.4, bd), blue); tabs.position.set(fx(0.625), 16.5, bcz); add(tabs);
    const sx = fx(0.535), sz = fz(0.48);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(5.8, 5.8, 4.5, 32), blue); boss.position.set(sx, 22.5 + 2.25, sz); add(boss);
    const gear = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 3, 18), mat(0xf2f2f2)); gear.position.set(sx, 27 + 1.5, sz); add(gear);
    const horn = new THREE.Group(); horn.position.set(sx, 30, sz); body.add(horn);
    const hm = mat(0xf4f4f4, { r: 0.55 });
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 2, 24), hm); horn.add(hub);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(5, 1.6, 16), hm); arm.position.set(0, 0, -8); horn.add(arm);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 1.6, 20), hm); tip.position.set(0, 0, -16); horn.add(tip);
    for (let i = 0; i < 4; i++) { const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.7, 8), mat(0x888888)); hole.position.set(0, 0, -6 - i * 3); horn.add(hole); }
    horn.traverse((m) => { m.castShadow = true; });
    const conn = new THREE.Mesh(new THREE.BoxGeometry(0.11 * W, 2.6, 0.2 * D), mat(0x111111)); conn.position.set(fx(0.06), 1.3, fz(0.49)); add(conn);
    [0xa0522d, 0xe53935, 0xff9800].forEach((c, i) => {
      const z = fz(0.45 + i * 0.04), a = new THREE.Vector3(bcx - bw / 2, 9, z), b = new THREE.Vector3(fx(0.12), 1.3, z);
      const curve = new THREE.CatmullRomCurve3([a, a.clone().add(new THREE.Vector3(-3, -2, 0)), new THREE.Vector3((a.x + b.x) / 2, 2, z), b]);
      add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.5, 6), mat(c, { r: 0.5 })));
    });
    out.update = () => { horn.rotation.y = -(+part.el.angle || 0) * Math.PI / 180; };
    out.kind = 'servo';
  } else if (sp === 'stepper') {
    const w = W, d = 0.9 * D, cz = fz(0.45), alu = mat(0xc4c8ce, { metal: true, r: 0.35 }), blk = mat(0x1a1a1a, { r: 0.5 });
    [[0, 8, alu], [8, 30, blk], [30, 38, alu]].forEach(([y0, y1, m], i) => {
      const g = new THREE.BoxGeometry(w, y1 - y0, d); if (i === 2) topUV(g, 0, cz, W, D);
      const mm = new THREE.Mesh(g, i === 2 ? [m, m, texMat(), m, m, m] : m); mm.position.set(0, y0 + (y1 - y0) / 2, cz); add(mm);
    });
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 2, 40), alu); boss.position.set(fx(0.5), 39, fz(0.45)); add(boss);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 22, 20), mat(0xdedede, { metal: true, r: 0.25 })); shaft.position.set(fx(0.5), 51, fz(0.45)); add(shaft);
    out.shaft = shaft;
  } else if (sp === 'can') {                                          // DC / brushless motor standing on its mount, hub shows the live artwork
    const [cxf, cyf, rf, h, color, rTop] = spec.can, cx = fx(cxf), cz = fz(cyf), r = rf * W;
    const bldc = part.type.includes('bldc');
    const g = new THREE.CylinderGeometry(r, r, h, 48); topUV(g, cx, cz, W, D);
    const sm = mat(color, { metal: !bldc || color === 0x2a2f3a, r: 0.35 });
    const m = new THREE.Mesh(g, [sm, texMat(), sm]); m.position.set(cx, h / 2, cz); add(m);
    if (bldc) { for (let i = 0; i < 4; i++) { const arm = new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, 2, 3), mat(0x222222)); arm.rotation.y = (i * Math.PI) / 2 + Math.PI / 4; arm.position.set(cx, 1, cz); add(arm); } }
    else { const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, 1.5, 24), mat(0xeeeeee)); ring.position.set(cx, h + 0.75, cz); add(ring); }
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rTop ? 0.8 : 1.5, rTop ? 0.8 : 1.5, 8, 12), mat(0xdedede, { metal: true, r: 0.25 })); shaft.position.set(cx, h + 4, cz); add(shaft);
    pins.forEach((p, i) => {
      const dir = new THREE.Vector3(p.x - cx, 0, p.z - cz); const L = dir.length() || 1; dir.multiplyScalar(1 / L);
      const a = new THREE.Vector3(cx + dir.x * r * 0.9, 2, cz + dir.z * r * 0.9), b = new THREE.Vector3(p.x, 0.6, p.z);
      add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, a.clone().lerp(b, 0.5).setY(1.5), b]), 16, 0.6, 6), mat([0xd32f2f, 0x1a1a1a, 0xf5c518][i % 3], { r: 0.5 })), false);
    });
    out.kind = 'motor';
  } else if (sp === 'motor') {                                        // brushed DC motor lying on its side, live hub at the shaft end
    const [len, r, color, hx, hy, hr] = spec.motor, cx = 0, cz = fz(hy) * 0.3, y = r;
    const sm = mat(color, { metal: true, r: 0.32 });
    const can = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 48), sm); can.rotation.z = Math.PI / 2; can.position.set(cx, y, cz); add(can);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 0.96, 3, 40), mat(0x2b2b2b, { r: 0.6 })); cap.rotation.z = Math.PI / 2; cap.position.set(cx - len / 2 - 1.5, y, cz); add(cap);
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.32, r * 0.32, 1.6, 24), sm); boss.rotation.z = Math.PI / 2; boss.position.set(cx + len / 2 + 0.8, y, cz); add(boss);
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.8, r * 0.1), Math.max(0.8, r * 0.1), 8, 12), mat(0xdedede, { metal: true, r: 0.25 })); sh.rotation.z = Math.PI / 2; sh.position.set(cx + len / 2 + 4, y, cz); add(sh);
    // hub disc showing the live (rotating) artwork of the motor face
    const hrad = Math.max(r * 0.9, 4), tr = hr * W, hg = new THREE.CylinderGeometry(tr, tr, 1.2, 40); topUV(hg, fx(hx), fz(hy), W, D);
    hg.scale(hrad / tr, 1, hrad / tr);
    const hub = new THREE.Mesh(hg, [mat(0x333333), texMat(), mat(0x333333)]); hub.rotation.z = -Math.PI / 2; hub.position.set(cx + len / 2 + 8.6, y, cz); add(hub);
    const tabs = [-1, 1].map((sgn) => { const t = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3, 0.4), mat(C.gold, { metal: true, r: 0.3 })); t.position.set(cx - len / 2 - 3.5, y + sgn * r * 0.45, cz); add(t, false); return t.position.clone(); });
    pins.forEach((p, i) => {                                         // leads from the terminals to the solder pads
      const a = tabs[i % 2], b = new THREE.Vector3(p.x, 0.6, p.z), c2 = i % 2 ? 0x1a1a1a : 0xd32f2f;
      add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, a.clone().add(new THREE.Vector3(-4, 0, 0)), new THREE.Vector3((a.x + b.x) / 2 - 3, 1.5, (a.z + b.z) / 2), b]), 20, 0.55, 6), mat(c2, { r: 0.5 })), false);
    });
    out.kind = 'motor';
  } else if (sp === 'bat9v') {
    const g = new THREE.BoxGeometry(W * 0.96, 17, D * 0.9); topUV(g, 0, D * 0.04, W, D);
    const sm = mat(0x222222, { r: 0.45 }); const m = new THREE.Mesh(g, [sm, sm, texMat(), sm, sm, sm]); m.position.set(0, 8.5, D * 0.04); add(m);
    for (const p of pins) { const s = new THREE.Mesh(new THREE.CylinderGeometry(p.name.includes('+') ? 1.6 : 2.4, 2.4, 3, p.name.includes('+') ? 20 : 6), mat(C.silver, { metal: true, r: 0.25 })); s.position.set(p.x, 17 + 1.5, p.z + 1.5); add(s); }
  } else if (sp === 'cell18650') {
    const r = Math.min(9, D * 0.48), len = W * 0.92;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 40), mat(0x2e6fc0, { r: 0.3 })); m.rotation.z = Math.PI / 2; m.position.set(0, r, 0); add(m);
    const nub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.4, r * 0.4, 1.4, 24), mat(C.silver, { metal: true, r: 0.25 })); nub.rotation.z = Math.PI / 2; nub.position.set(len / 2 + 0.7, r, 0); add(nub);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.002, r * 1.002, 2, 40, 1, true), mat(0xeeeeee)); ring.rotation.z = Math.PI / 2; ring.position.set(len / 2 - 3, r, 0); add(ring, false);
  } else if (sp === 'frame') {                                        // quadcopter X frame with four motors (hubs show the live props)
    const cm = mat(0x1d1d1d, { r: 0.5 });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16 * W, 3, 0.16 * D), cm); plate.position.y = 6; add(plate);
    const pts = [[0.21, 0.19], [0.79, 0.19], [0.21, 0.81], [0.79, 0.81]];
    for (const [px, pz] of pts) {
      const x = fx(px), z = fz(pz), len = Math.hypot(x, z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(len, 3, 4.5), cm); arm.position.set(x / 2, 6, z / 2); arm.rotation.y = -Math.atan2(z, x); add(arm);
      const r = 0.13 * W, g = new THREE.CylinderGeometry(r, r, 9, 36); topUV(g, x, z, W, D);
      const sm = mat(0x3a3f4a, { metal: true, r: 0.4 }); const mo = new THREE.Mesh(g, [sm, texMat(), sm]); mo.position.set(x, 7.5 + 4.5, z); add(mo);
    }
  }

  // ---------- generic artwork base for parts with no PCB and no special (should not happen for listed parts)
  if (!pcbRect && !spec.ring && !sp && !(spec.f || []).length) {
    const g = new THREE.BoxGeometry(W, 2, D); topUV(g, 0, 0, W, D); const sm = mat(0x333333);
    add(new THREE.Mesh(g, [sm, sm, texMat(), sm, sm, sm])).position.y = 1;
  }

  // ---------- pins: headers / legs / pads and the wire contact points
  const pinMode = spec.pins || (pcbRect ? 'auto' : 'pads');
  const inPcb = (p) => pcbRect && p.fx >= pcbRect[0] - 0.01 && p.fx <= pcbRect[2] + 0.01 && p.fy >= pcbRect[1] - 0.01 && p.fy <= pcbRect[3] + 0.01;
  // modules whose pins stick out of one edge (right-angle header, sensor legs) stand upright when plugged into a breadboard
  const outside = pins.filter((p) => (pcbRect ? !inPcb(p) : false));
  let edge = null;
  const bodyRect = pcbRect || (spec.f?.[0]?.[0] === 'box' ? spec.f[0].slice(1, 5) : null);
  if (bodyRect && pins.length) {
    const ext = pins.every((p) => p.fy > bodyRect[3] - 0.02) ? 'b' : pins.every((p) => p.fy < bodyRect[1] + 0.02) ? 't' : pins.every((p) => p.fx > bodyRect[2] - 0.02) ? 'r' : pins.every((p) => p.fx < bodyRect[0] + 0.02) ? 'l' : null;
    if (ext && (outside.length === pins.length || pinMode === 'legs')) edge = ext;
  }
  out.standing = !!(edge && o.plugged && !['led', 'rgbled', 'res', 'diode', 'ecap', 'to92', 'button'].includes(sp));
  const gold = mat(C.gold, { metal: true, r: 0.28 }), plastic = mat(0x111111, { r: 0.6 });
  const spacerGeo = new THREE.BoxGeometry(2.5, SPACER, 2.5), pinGeo = new THREE.BoxGeometry(0.64, 1, 0.64);
  const mk = (name, x, y, z) => { const c = new THREE.Object3D(); c.position.set(x, y, z); c.userData.pin = name; body.add(c); contacts.set(name, c); };
  for (const p of pins) {
    if (pinMode === 'female') { mk(p.name, p.x, T + 8.5, p.z); continue; }
    if (pinMode === 'pads' || (sp && pinMode !== 'auto' && pinMode !== 'legs')) {
      let y = sp === 'servo' ? 1.3 : 0.5;
      if (!sp) for (const f of spec.f || []) if (f[0] === 'box' && p.fx >= f[1] - 0.02 && p.fx <= f[3] + 0.02 && p.fy >= f[2] - 0.02 && p.fy <= f[4] + 0.02) y = Math.max(y, T + (f[8] || 0) + f[5]);
      mk(p.name, p.x, y, p.z); continue;
    }
    if (pinMode === 'legs') {
      if (!sp) {
        const m = new THREE.Mesh(pinGeo, legMat); m.scale.y = 3; m.position.set(p.x, 1.5, p.z); add(m, false);
        if (edge && bodyRect) {                                        // legs run from the body edge to the pin (DHT22, …)
          const ex = edge === 'r' ? fx(bodyRect[2]) : edge === 'l' ? fx(bodyRect[0]) : p.x, ez = edge === 'b' ? fz(bodyRect[3]) : edge === 't' ? fz(bodyRect[1]) : p.z;
          const len = Math.hypot(p.x - ex, p.z - ez); if (len > 0.3) { const l = new THREE.Mesh(pinGeo, legMat); l.scale.y = len; l.rotation[edge === 'l' || edge === 'r' ? 'z' : 'x'] = Math.PI / 2; l.position.set((p.x + ex) / 2, 1.2, (p.z + ez) / 2); add(l, false); }
        }
      }
      mk(p.name, p.x, 0, p.z); continue;
    }
    if (sp === 'pot' || sp === 'joystick' || sp === 'encoder' || inPcb(p) || !pcbRect) {
      if (o.plugged) {                                               // male header pointing down into the breadboard
        const s = new THREE.Mesh(spacerGeo, plastic); s.position.set(p.x, -SPACER / 2, p.z); add(s, false);
        const m = new THREE.Mesh(pinGeo, gold); m.scale.y = PIN_DN + SPACER; m.position.set(p.x, -(PIN_DN + SPACER) / 2, p.z); add(m, false);
        mk(p.name, p.x, T + 0.2, p.z);
      } else {                                                       // header pointing up for jumper wires
        const s = new THREE.Mesh(spacerGeo, plastic); s.position.set(p.x, T + SPACER / 2, p.z); add(s, false);
        const m = new THREE.Mesh(pinGeo, gold); m.scale.y = PIN_UP + SPACER + T; m.position.set(p.x, (PIN_UP + SPACER + T) / 2, p.z); add(m, false);
        mk(p.name, p.x, T + SPACER + PIN_UP, p.z);
      }
    } else {                                                         // right-angle header: horizontal pins from the board edge
      const ex = edge === 'r' ? fx(pcbRect[2]) : edge === 'l' ? fx(pcbRect[0]) : p.x, ez = edge === 'b' ? fz(pcbRect[3]) : edge === 't' ? fz(pcbRect[1]) : p.z;
      const len = Math.hypot(p.x - ex, p.z - ez) + 1, y = T + 1.3;
      const m = new THREE.Mesh(pinGeo, gold); m.scale.y = len; m.rotation[edge === 'l' || edge === 'r' ? 'z' : 'x'] = Math.PI / 2; m.position.set((p.x + ex) / 2, y, (p.z + ez) / 2); add(m, false);
      const s = new THREE.Mesh(spacerGeo, plastic); s.position.set(ex + (edge === 'r' ? 1.3 : edge === 'l' ? -1.3 : 0), y, ez + (edge === 'b' ? 1.3 : edge === 't' ? -1.3 : 0)); add(s, false);
      mk(p.name, p.x, y, p.z);
    }
  }

  // ---------- standing upright on edge pins
  if (out.standing) {
    const ps = pins, ax = edge === 'b' || edge === 't' ? 'x' : 'z';
    const line = edge === 'b' ? Math.max(...ps.map((p) => p.z)) : edge === 't' ? Math.min(...ps.map((p) => p.z)) : edge === 'r' ? Math.max(...ps.map((p) => p.x)) : Math.min(...ps.map((p) => p.x));
    const lift = (pinMode === 'legs' ? 0 : T / 2) + 0.2;
    if (ax === 'x') { body.position.set(0, 0, -line); const piv = new THREE.Group(); piv.position.set(0, lift, line); piv.rotation.x = edge === 'b' ? Math.PI / 2 : -Math.PI / 2; root.remove(body); piv.add(body); root.add(piv); }
    else { body.position.set(-line, 0, 0); const piv = new THREE.Group(); piv.position.set(line, lift, 0); piv.rotation.z = edge === 'r' ? -Math.PI / 2 : Math.PI / 2; root.remove(body); piv.add(body); root.add(piv); }
  }
  out.lift = !out.standing && o.plugged && pinMode === 'auto' && !sp ? SPACER : 0;    // modules on headers sit above the board
  if (sp === 'pot' || sp === 'joystick' || sp === 'encoder') out.lift = o.plugged ? SPACER : 0;
  root.traverse((m) => { if (m.isMesh) m.userData.partId = part.id; });
  return out;
}

const BAND = ['#111111', '#7a4a1e', '#d32f2f', '#f57c00', '#fbc02d', '#2e7d32', '#1565c0', '#7b1fa2', '#8a8a8a', '#f5f5f5'];
export function resistorBands(v) {
  let ohm = parseFloat(v) || 220; const u = String(v).toLowerCase(); if (u.includes('k')) ohm *= 1e3; if (u.includes('m')) ohm *= 1e6;
  const e = Math.max(0, Math.floor(Math.log10(ohm)) - 1), sig = Math.round(ohm / 10 ** e);
  return [BAND[Math.floor(sig / 10) % 10], BAND[sig % 10], BAND[Math.min(9, e)], '#c9a227'];
}

/** colour of the board edge: average of the artwork just inside the PCB outline */
export function pcbEdgeColor(cv, rect) {
  const s = 48, t = document.createElement('canvas'); t.width = t.height = s; const g = t.getContext('2d');
  const [x0, y0, x1, y1] = rect || [0, 0, 1, 1];
  g.drawImage(cv, x0 * cv.width, y0 * cv.height, (x1 - x0) * cv.width, (y1 - y0) * cv.height, 0, 0, s, s);
  const d = g.getImageData(0, 0, s, s).data; let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const x = (i / 4) % s, y = Math.floor(i / 4 / s); if ((x < 3 || y < 3 || x > s - 4 || y > s - 4) && d[i + 3] > 200) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; } }
  return n ? new THREE.Color(r / n / 255, gg / n / 255, b / n / 255).multiplyScalar(0.85) : null;
}
