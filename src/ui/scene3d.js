// Scenery around sensors in the 3D view: what the sensor is "looking at", drawn from the sensor's own value so that a
// student sees the physical situation that produces the reading.
//   • distance sensors (HC-SR04, JSN-SR04T, VL53L0X, TF-Luna): an obstacle at the set distance in front of the sensor,
//     with the sound / light beam; drag the obstacle to change the distance (on a robot car: the beam to the wall).
//   • FC-51 IR obstacle sensor: a block appears in front of the IR LEDs when "Ada halangan" is on.
//   • water level sensor: a glass tank, water up to the set level of the sensing traces.
//   • soil moisture sensors: a pot of soil around the probe, darker when wetter.
//   • rain sensor: drops on the panel, more drops for heavier rain.
//   • LDR: a lamp above the module, brighter for more light.
//   • flame sensor: a candle in front of the receiver diode, the flame grows with the intensity.
// Every piece lives in the part's own frame (y up, x/z turned with the part), so it follows the part, also on a car.
import * as THREE from 'three';

const MM = 1 / 3.7795;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DIST = {
  'wokwi-hc-sr04': { face: [0.5, 0.43], unit: 'cm', beam: 0x4fc3f7, kind: 'sound' },
  'mod-jsn-sr04t': { face: [0.5, 0.3], unit: 'cm', beam: 0x4fc3f7, kind: 'sound' },
  'mod-vl53l0x': { face: [0.5, 0.23], unit: 'mm', beam: 0xff5252, kind: 'laser' },
  'mod-tfluna': { face: [0.66, 0.36], unit: 'cm', beam: 0xff5252, kind: 'laser' },
};
export const hasScenery = (type) => !!DIST[type] || ['mod-ir-obstacle', 'mod-water-level', 'mod-soil', 'mod-soil-cap', 'mod-rain', 'wokwi-photoresistor-sensor', 'wokwi-flame-sensor'].includes(type);

const glassMat = () => new THREE.MeshPhysicalMaterial({ color: 0xdff3ff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0, transmission: 0.6, side: THREE.DoubleSide, depthWrite: false });
const waterMat = () => new THREE.MeshPhysicalMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0, depthWrite: false });

/** label in the HTML overlay, positioned by the view (world anchor) */
function labelEl(host, cls = '') { const l = document.createElement('div'); l.className = 'v3-slabel ' + cls; host.append(l); return l; }

/**
 * @param it   view item: { part, group (THREE group of the part), model: { body } }
 * @param o    { labelsHost, onCar (part rides on a robot car: arena does the obstacles), attr(key, def) }
 * @returns { group, update(), pick (meshes that can be dragged), dragAxis?, dispose(), anchors: [{el, pos (local)}] } or null
 */
export function makeScenery(it, o) {
  const part = it.part, type = part.type, body = it.model?.body; if (!body) return null;
  const [pw, ph] = part.size, W = pw * MM, D = ph * MM;
  const group = new THREE.Group(); group.matrixAutoUpdate = false;
  const sc = { group, it, pick: [], anchors: [], update: () => {}, dispose() { group.traverse((m) => { m.geometry?.dispose(); m.material?.dispose?.(); }); for (const a of sc.anchors) a.el.remove(); } };
  it.group.updateMatrixWorld(true);
  /** artwork fraction + height above the body's base → the part's group frame (y up) */
  const toLocal = (fx, fy, y = 0) => it.group.worldToLocal(body.localToWorld(new THREE.Vector3((fx - 0.5) * W, y, (fy - 0.5) * D)));
  const dirLocal = (v) => { const a = toLocal(0.5, 0.5, 0), b = it.group.worldToLocal(body.localToWorld(new THREE.Vector3(v.x, v.y, v.z))); return b.sub(a).normalize(); };
  const groundY = () => -it.group.position.y;                     // the floor in this frame (the part's group sits at its base height)
  const attr = (k, d) => { const v = part.attrs?.[k]; return v === undefined ? d : v; };

  if (DIST[type]) {
    const spec = DIST[type], top = (type === 'wokwi-hc-sr04' ? 14 : type === 'mod-tfluna' ? 15.5 : 3);
    const P = toLocal(spec.face[0], spec.face[1], top), n = dirLocal({ x: 0, y: 1, z: 0 });
    const toMm = (v) => (spec.unit === 'cm' ? v * 10 : v);
    // beam: a thin cone from the sensor to the target
    const beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 24, 1, true), new THREE.MeshBasicMaterial({ color: spec.beam, transparent: true, opacity: spec.kind === 'laser' ? 0.35 : 0.07, depthWrite: false, side: THREE.DoubleSide }));
    const axisLine = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1, 8), new THREE.MeshBasicMaterial({ color: spec.beam, transparent: true, opacity: 0.75, depthWrite: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(5, 8, 32), new THREE.MeshBasicMaterial({ color: spec.beam, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    beam.renderOrder = axisLine.renderOrder = ring.renderOrder = 2;
    group.add(beam, axisLine, ring);
    let wall = null, hand = null;
    if (!o.onCar) {
      const horiz = Math.abs(n.y) < 0.5;
      // a wall standing on the ground when the sensor looks sideways, a flat board (a hand) when it looks up
      const ww = 110, wh = Math.max(80, P.y - groundY() + 45);
      const m = new THREE.MeshStandardMaterial({ color: 0xd7ccc8, roughness: 0.85 });
      wall = new THREE.Mesh(horiz ? new THREE.BoxGeometry(ww, wh, 10) : new THREE.BoxGeometry(ww, 10, ww * 0.7), m);
      wall.castShadow = true; wall.receiveShadow = true; wall.userData.scenery = { kind: 'distance' }; group.add(wall); sc.pick.push(wall);
      // stripes so it reads as an object, not a slab
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(horiz ? ww * 0.96 : ww * 0.96, horiz ? 6 : 10.4, horiz ? 10.4 : 6), new THREE.MeshStandardMaterial({ color: 0xff8f00, roughness: 0.7 }));
      stripe.position.y = horiz ? wh * 0.32 : 0; wall.add(stripe);
      if (horiz) wall.lookAt(wall.position.clone().add(new THREE.Vector3(n.x, 0, n.z)));
      hand = { horiz, wh };
    }
    const lab = labelEl(o.labelsHost, 'dist'); sc.anchors.push({ el: lab, pos: new THREE.Vector3() });
    sc.axis = { origin: P.clone(), dir: n.clone(), unit: spec.unit };   // dragging the obstacle moves it along this line
    sc.update = () => {
      const val = +attr('distance', 100), d = Math.max(5, toMm(val));
      const end = P.clone().addScaledVector(n, d);
      const r = spec.kind === 'laser' ? 1.2 : Math.max(3, d * Math.tan(0.13));
      beam.scale.set(r, d, r); beam.position.copy(P).addScaledVector(n, d / 2);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), n);      // cone tip at the sensor
      axisLine.scale.set(1, d, 1); axisLine.position.copy(beam.position); axisLine.quaternion.copy(beam.quaternion);
      ring.position.copy(end).addScaledVector(n, -1); ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      if (wall) {
        wall.position.copy(end).addScaledVector(n, 5);
        if (hand.horiz) wall.position.y = groundY() + hand.wh / 2;
      }
      sc.anchors[0].pos.copy(end).addScaledVector(n, wall ? 14 : 2); if (!wall) sc.anchors[0].pos.y += 6;
      const t = spec.unit === 'cm' ? `${Math.round(val)} cm` : `${Math.round(val)} mm`;
      if (lab.textContent !== t) lab.textContent = t;
    };
  } else if (type === 'mod-ir-obstacle') {
    const P = toLocal(0.92, 0.5, 3), n = dirLocal({ x: 1, y: 0, z: 0 });
    const block = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40), new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.8 }));
    block.castShadow = true; group.add(block);
    const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 2.5, 1, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.25, depthWrite: false })); group.add(ray);
    sc.update = () => {
      const on = !!attr('obstacle', false); block.visible = on && !o.onCar; ray.visible = on;
      const d = 30; block.position.copy(P).addScaledVector(n, d + 20); block.position.y = Math.max(groundY() + 20, P.y);
      ray.scale.set(1, d, 1); ray.position.copy(P).addScaledVector(n, d / 2); ray.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    };
  } else if (type === 'mod-water-level' || type === 'mod-soil' || type === 'mod-soil-cap') {
    // sensing region of the artwork (fractions): traces of the water sensor, prongs of the soil probes
    const reg = type === 'mod-water-level' ? [0.12, 0.27, 0.88, 0.87] : type === 'mod-soil' ? [0.12, 0.33, 0.88, 0.99] : [0.06, 0.37, 0.94, 1.0];
    const tipF = reg[3], baseF = reg[1];
    const pts = []; for (const fx of [reg[0], reg[2]]) for (const fy of [reg[1], reg[3]]) for (const y of [-3, 4]) pts.push(toLocal(fx, fy, y));
    const box = new THREE.Box3().setFromPoints(pts), size = box.getSize(new THREE.Vector3());
    const vertical = size.y > 12;
    const water = type === 'mod-water-level';
    const tank = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), water ? glassMat() : new THREE.MeshStandardMaterial({ color: 0xb5651d, roughness: 0.9 }));
    const fill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), water ? waterMat() : new THREE.MeshStandardMaterial({ color: 0x6d4c2f, roughness: 1 }));
    group.add(tank, fill);
    const pad = water ? 7 : 10;
    const lab = labelEl(o.labelsHost, 'water'); sc.anchors.push({ el: lab, pos: new THREE.Vector3() });
    if (!water) { tank.material.transparent = true; tank.material.opacity = 0.9; }
    sc.update = () => {
      const lv = clamp(+attr('level', water ? 40 : 30) / 100, 0, 1);
      if (vertical) {
        // a tank around the region, liquid (or soil) from the lowest point of the region upward
        const y0 = box.min.y - 2, H = size.y + 6, h = water ? lv * (box.max.y - box.min.y) : 0.72 * H;
        tank.scale.set(size.x + pad * 2, H, size.z + pad * 2); tank.position.set((box.min.x + box.max.x) / 2, y0 + H / 2, (box.min.z + box.max.z) / 2);
        fill.visible = h > 0.3; fill.scale.set(size.x + pad * 2 - 1.2, Math.max(0.3, h), size.z + pad * 2 - 1.2); fill.position.set(tank.position.x, y0 + Math.max(0.3, h) / 2 + 0.3, tank.position.z);
        if (!water) tank.visible = false;
      } else {
        // lying flat (the part frame is the artwork frame): a shallow tray, the liquid covers the region from its tip
        const x0 = (reg[0] - 0.5) * W, x1 = (reg[2] - 0.5) * W, zb = (baseF - 0.5) * D, zt = (tipF - 0.5) * D, L = Math.abs(zt - zb), w = water ? lv * L : 0.75 * L;
        tank.scale.set(x1 - x0 + pad, 3, L + 8); tank.position.set((x0 + x1) / 2, box.min.y - 1, (zb + zt) / 2);
        fill.visible = w > 0.5; fill.scale.set(x1 - x0 + 2, 2.4, Math.max(0.5, w)); fill.position.set((x0 + x1) / 2, box.max.y + 1.2, zt - Math.sign(zt - zb) * w / 2);
        if (!water) tank.visible = true;
      }
      if (!water) fill.material.color.setHSL(0.07, 0.45, 0.42 - 0.3 * lv);     // dry brown → dark wet soil
      sc.anchors[0].pos.set(tank.position.x, Math.max(box.max.y, tank.position.y + tank.scale.y / 2) + 8, tank.position.z);
      const t = water ? `air ${Math.round(lv * 100)} %` : `tanah ${lv < 0.3 ? 'kering' : lv < 0.65 ? 'lembap' : 'basah'} (${Math.round(lv * 100)} %)`;
      if (lab.textContent !== t) lab.textContent = t;
    };
  } else if (type === 'mod-rain') {
    const drops = [], dm = new THREE.MeshPhysicalMaterial({ color: 0x9fd3ff, transparent: true, opacity: 0.75, roughness: 0.05, clearcoat: 1 });
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1 + rnd() * 1.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), dm);
      const p = toLocal(0.13 + rnd() * 0.74, 0.45 + rnd() * 0.5, 1.7); m.position.copy(p); m.scale.y = 0.6; group.add(m); drops.push(m);
    }
    sc.update = () => { const k = Math.round(clamp(+attr('level', 0), 0, 100) / 100 * drops.length); drops.forEach((d, i) => { d.visible = i < k; }); };
  } else if (type === 'wokwi-photoresistor-sensor') {
    const P = toLocal(0.06, 0.47, 3), n = dirLocal({ x: 0, y: 1, z: 0 });
    const lamp = new THREE.Group(); group.add(lamp);
    const bulbM = new THREE.MeshStandardMaterial({ color: 0xfff4c2, emissive: 0xffe08a, emissiveIntensity: 0 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16), bulbM); lamp.add(bulb);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(14, 12, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x37474f, side: THREE.DoubleSide, roughness: 0.6 })); shade.position.y = 7; lamp.add(shade);
    const light = new THREE.PointLight(0xffe7a8, 0, 160, 2); lamp.add(light);
    const pos = P.clone().addScaledVector(n, 60); if (Math.abs(n.y) < 0.5) pos.y = P.y + 35;
    lamp.position.copy(pos); lamp.lookAt(P); lamp.rotateX(Math.PI / 2);
    sc.update = () => { const k = clamp(+attr('level', 50) / 100, 0, 1); bulbM.emissiveIntensity = 0.1 + 2.2 * k; light.intensity = 2500 * k; };
  } else if (type === 'wokwi-flame-sensor') {
    const P = toLocal(0.0, 0.5, 2.5), n = dirLocal({ x: -1, y: 0, z: 0 });
    const candle = new THREE.Group(); group.add(candle);
    const wax = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 30, 24), new THREE.MeshStandardMaterial({ color: 0xf5f0e6, roughness: 0.7 })); wax.position.y = 15; wax.castShadow = true; candle.add(wax);
    const flameM = new THREE.MeshBasicMaterial({ color: 0xffa726, transparent: true, opacity: 0.85 });
    const flame = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 12), flameM); flame.scale.set(1, 2.2, 1); flame.position.y = 36; candle.add(flame);
    const glow = new THREE.PointLight(0xff9100, 0, 120, 2); glow.position.y = 38; candle.add(glow);
    const c = P.clone().addScaledVector(n, 55); candle.position.set(c.x, groundY(), c.z);
    sc.update = (now) => {
      const k = clamp(+attr('level', 0) / 100, 0, 1); flame.visible = k > 0.02;
      const fl = 1 + 0.08 * Math.sin((now || 0) / 70) + 0.05 * Math.sin((now || 0) / 23);
      flame.scale.set(0.6 + k, (1 + 2.2 * k) * fl, 0.6 + k); glow.intensity = 1800 * k;
    };
  } else return null;
  return sc;
}
