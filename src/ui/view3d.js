// 3D view of the circuit (three.js), live with the running simulation.
//
// Geometry comes straight from the 2D canvas: 1 canvas px = 1/3.7795 mm (96 dpi, the scale of the Wokwi artwork),
// x → X, y → Z, rotations about the vertical axis. Every part's top face is a texture rendered from its own live SVG
// (plus any <canvas> such as OLED / TFT screens), so LEDs, displays, NeoPixels, servos … look the same as in 2D and
// update while the program runs. A few common parts get real 3D models (5 mm LED with glow, resistor with colour
// bands, tactile button, potentiometer, buzzer); parts plugged into a breadboard sit on it (boards on header pins),
// wires are tubes that follow their bend points.
// Interaction: drag = orbit, right-drag / two fingers = pan, wheel / pinch = zoom; press a button or turn a
// potentiometer directly on the model; tap any part for its info card (pins, connections, live state).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildPart3D, SPEC, pcbEdgeColor } from './models3d.js';
import * as L from './lab3d.js';
import { makeScenery, hasScenery } from './scene3d.js';
import { CAR, CAR_TYPE, mountedOn, arenaOf, trackPoints, DIST_SENSORS } from '../sim/car.js';

const MM = 1 / 3.7795;                                  // px → mm
const BB_H = 8.5, PCB = 1.6, HEADER = 2.5;
const isBB = (t) => /breadboard/.test(t);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BAND = ['#111111', '#7a4a1e', '#d32f2f', '#f57c00', '#fbc02d', '#2e7d32', '#1565c0', '#7b1fa2', '#8a8a8a', '#f5f5f5'];
const LED_RGB = { red: '#ff2a2a', green: '#2bff4a', blue: '#3b7bff', yellow: '#ffe23b', white: '#ffffff', orange: '#ff8c1a', purple: '#b04bff', pink: '#ff5ac8', cyan: '#2be8ff' };

// ------------------------------------------------------------------ texture from the live 2D element
function cssOf(root) {
  let css = '';
  for (const s of root.querySelectorAll?.('style') || []) css += s.textContent + '\n';
  for (const sh of root.adoptedStyleSheets || []) { try { for (const r of sh.cssRules) css += r.cssText + '\n'; } catch { /* cross-origin */ } }
  return css;
}
/** screen rect of a part's element (some custom elements report a zero-width host box: use their artwork instead) */
function hostRect(part) {
  const r = part.el.getBoundingClientRect(); if (r.width && r.height) return r;
  const root = part.el.shadowRoot || part.el; let u = null;
  for (const n of root.querySelectorAll('svg, canvas')) {
    const q = n.getBoundingClientRect(); if (!q.width) continue;
    u = u ? { left: Math.min(u.left, q.left), top: Math.min(u.top, q.top), right: Math.max(u.right, q.right), bottom: Math.max(u.bottom, q.bottom) } : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
  }
  return u ? { ...u, width: u.right - u.left, height: u.bottom - u.top } : r;
}
/** box of a descendant node in the element's own (unrotated, unzoomed) px coordinates */
function localBox(part, node, zoom, size = part.size) {
  const er = hostRect(part), r = node.getBoundingClientRect();
  if (!er.width || !r.width) return null;
  const dx = (r.left + r.width / 2 - (er.left + er.width / 2)) / zoom, dy = (r.top + r.height / 2 - (er.top + er.height / 2)) / zoom;
  const k = part.rot & 3, c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
  const ux = c * dx + s * dy, uy = -s * dx + c * dy;                  // undo the CSS rotation
  const w = (k & 1 ? r.height : r.width) / zoom, h = (k & 1 ? r.width : r.height) / zoom;
  const [W, H] = size;
  return { x: W / 2 + ux - w / 2, y: H / 2 + uy - h / 2, w, h };
}
function snapshot(part, zoom, size = part.size, maxPx = 2048) {
  const [W, H] = size; if (!W || !H) return Promise.resolve(null);
  const k = Math.min(4, maxPx / Math.max(W, H)), cw = Math.ceil(W * k), ch = Math.ceil(H * k);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  const root = part.el.shadowRoot || part.el, svg = root.querySelector('svg');
  const drawCanvases = () => {
    g.imageSmoothingEnabled = false;
    for (const c of root.querySelectorAll('canvas')) {
      const b = localBox(part, c, zoom, size); if (!b || !c.width) continue;
      try { g.drawImage(c, b.x * k, b.y * k, b.w * k, b.h * k); } catch { /* tainted / empty */ }
    }
    return cv;
  };
  if (!svg) return Promise.resolve(drawCanvases());
  const b = localBox(part, svg, zoom, size) || { x: 0, y: 0, w: W, h: H };
  const clone = svg.cloneNode(true);
  clone.querySelectorAll('foreignObject').forEach((n) => n.remove());
  if (!clone.getAttribute('viewBox')) { try { clone.setAttribute('viewBox', `0 0 ${svg.width.baseVal.value} ${svg.height.baseVal.value}`); } catch { /* keep */ } }
  clone.setAttribute('width', Math.max(1, b.w * k)); clone.setAttribute('height', Math.max(1, b.h * k));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.style.transform = ''; clone.removeAttribute('class');
  const css = cssOf(root).replace(/:host\b/g, 'svg');
  if (css) { const st = document.createElementNS('http://www.w3.org/2000/svg', 'style'); st.textContent = css; clone.insertBefore(st, clone.firstChild); }
  // host-level CSS custom properties / colour (e.g. currentColor) carried over
  const hs = getComputedStyle(part.el); clone.style.color = hs.color;
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { try { g.drawImage(img, b.x * k, b.y * k, b.w * k, b.h * k); } catch { /* ignore */ } res(drawCanvases()); };
    img.onerror = () => res(drawCanvases());
    img.src = src;
  });
}
function opaqueFraction(cv) {
  const s = 32, t = document.createElement('canvas'); t.width = s; t.height = s; const g = t.getContext('2d');
  g.drawImage(cv, 0, 0, s, s); const d = g.getImageData(0, 0, s, s).data; let n = 0, r = 0, gg = 0, bb = 0, m = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 200) { n++; const x = (i / 4) % s, y = Math.floor(i / 4 / s); if (x < 2 || y < 2 || x > s - 3 || y > s - 3) { r += d[i]; gg += d[i + 1]; bb += d[i + 2]; m++; } }
  }
  return { f: n / (s * s), edge: m ? new THREE.Color(r / m / 255, gg / m / 255, bb / m / 255) : null };
}

function resistorBands(v) {
  let ohm = parseFloat(v) || 220; const u = String(v).toLowerCase(); if (u.includes('k')) ohm *= 1e3; if (u.includes('m')) ohm *= 1e6;
  const e = Math.max(0, Math.floor(Math.log10(ohm)) - 1), sig = Math.round(ohm / 10 ** e);
  const d1 = Math.floor(sig / 10) % 10, d2 = sig % 10;
  return [BAND[d1], BAND[d2], BAND[Math.min(9, e)], '#c9a227'];
}


// ------------------------------------------------------------------ the view
export function init3D({ canvas, sim, host, catalog, onAttr, check, toast }) {
  host.innerHTML = `
    <canvas class="v3-gl"></canvas>
    <div class="v3-labels"></div>
    <div class="v3-tools" role="toolbar" aria-label="Kontrol tampilan 3D">
      <button data-v="rotl" title="Putar kiri (Q)">⟲</button><button data-v="rotr" title="Putar kanan (E)">⟳</button>
      <span class="v3-sep"></span>
      <button data-v="zout" title="Perkecil (−)">−</button><button data-v="zin" title="Perbesar (+)">+</button>
      <span class="v3-sep"></span>
      <button data-v="iso" title="Tampilan isometrik (R)">Iso</button><button data-v="top" title="Tampak atas (T)">Atas</button><button data-v="front" title="Tampak depan (F)">Depan</button>
      <span class="v3-sep"></span>
      <button data-v="probe" title="Multimeter: ketuk pin untuk mengukur tegangan (M)">Ukur</button>
      <button data-v="diag" title="Cari kesalahan rangkaian (G)">Diagnosa<span class="v3-cnt" hidden></span></button>
      <button data-v="labels" class="on" title="Tampilkan label (L)">Label</button>
      <span class="v3-sep v3-car" hidden></span>
      <button data-v="follow" class="v3-car" hidden title="Kamera mengikuti mobil robot (K)">Ikuti mobil</button>
      <button data-v="carreset" class="v3-car" hidden title="Kembalikan mobil ke posisi awal">Reset mobil</button>
      <button data-v="close" class="v3-close" title="Kembali ke 2D (Esc)">2D</button>
    </div>
    <div class="v3-help">Seret: putar · klik kanan / 2 jari: geser · scroll / pinch: zoom · tekan tombol, putar potensio, seret sensor naik-turun untuk mengubah nilainya, ketuk keypad / saklar langsung di model · <b>Ukur</b>: multimeter · <b>Diagnosa</b>: cari kesalahan</div>
    <div class="v3-side">
      <section class="v3-meter" hidden></section>
      <section class="v3-diag" hidden></section>
    </div>
    <div class="v3-tip" hidden></div>
    <div class="v3-hud" hidden></div>
    <div class="v3-info" hidden></div>`;
  const glCanvas = host.querySelector('.v3-gl'), labelsEl = host.querySelector('.v3-labels'), info = host.querySelector('.v3-info');
  const meterEl = host.querySelector('.v3-meter'), diagEl = host.querySelector('.v3-diag'), tipEl = host.querySelector('.v3-tip'), hudEl = host.querySelector('.v3-hud');
  let renderer = null, scene, camera, controls, root, raf = 0, open = false, showLabels = true;
  const items = new Map();                       // partId -> { part, group, top (mesh with texture), layers, dirty, last, kind, ... }
  const wiresGroup = new THREE.Group(), labGroup = new THREE.Group(), sceneryRoot = new THREE.Group();
  // robot cars: the chassis and every part on it ride in one group that the car's pose moves; the arena around it
  const vehicles = [], sceneries = [], tethers = [];
  let arenaGroup = null, follow = false, lastFrame = 0;
  let ground, grid, sun, bbox = new THREE.Box3(), viewBox = new THREE.Box3(), rebuildT = 0, selected = null;
  // lab state: multimeter probes, fault list, simulator warnings
  let probeMode = false, diagOpen = false, issues = [], worst = new Map(), hoverMarker = null, anim = null, lastSlow = 0;
  const probes = [], runtimeLog = [];
  const PROBE_COLORS = ['#e53935', '#1e1e1e', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa'];
  sim.on?.('log', (e) => { if ((e.level === 'warn' || e.level === 'error') && !runtimeLog.some((r) => r.text === e.text)) { runtimeLog.push({ level: e.level, text: e.text }); if (runtimeLog.length > 60) runtimeLog.shift(); } });
  sim.on?.('state', (s) => { if (s === 'running') runtimeLog.length = 0; if (open) setTimeout(refreshIssues, 400); });

  function setup() {
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 1, 20000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8170, 1.6));
    sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.4;
    scene.add(sun, sun.target);
    ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
    root = new THREE.Group(); scene.add(root, wiresGroup, labGroup, sceneryRoot);
    hoverMarker = new THREE.Mesh(new THREE.SphereGeometry(1.15, 18, 12), new THREE.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: 0.85, depthTest: false }));
    hoverMarker.renderOrder = 10; hoverMarker.visible = false; scene.add(hoverMarker);
    bindPointer();                                               // before the controls: our handler runs first
    controls = new OrbitControls(camera, glCanvas);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = Math.PI * 0.49; controls.screenSpacePanning = false;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    new ResizeObserver(resize).observe(host);
    canvas.on('change', () => schedule()); canvas.on('model', () => schedule());
    host.querySelector('.v3-tools').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) tool(b.dataset.v, b); });
    window.addEventListener('keydown', onKey, true);
  }
  function theme() {
    const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches && getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).reduce((a, b) => a + +b, 0) < 200);
    scene.background = new THREE.Color(dark ? 0x161a22 : 0xf4f0e8);
    ground.material.color.set(dark ? 0x1e232d : 0xece6da);
    if (grid) { grid.material.color?.set?.(dark ? 0x2c3340 : 0xd9d1c2); }
  }
  function resize() {
    if (!renderer) return; const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const schedule = () => { if (!open) return; clearTimeout(rebuildT); rebuildT = setTimeout(build, 120); };

  // ---------------------------------------------------------------- scene from the 2D model
  const plugged = () => { const s = new Set(); for (const p of canvas.parts.values()) if (isBB(p.type)) for (const id of canvas.pluggedInto(p.id)) s.add(id); return s; };
  const toV = (q, y = 0) => new THREE.Vector3(q.x * MM, y, q.y * MM);
  function baseOf(part, pl) { return pl.has(part.id) ? BB_H : 0; }

  function disposeObj(o) { o.traverse((m) => { m.geometry?.dispose(); const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : []; for (const x of ms) { x.map?.dispose(); x.dispose(); } }); }

  function build() {
    if (!renderer) return;
    for (const it of items.values()) { it.obs?.disconnect(); disposeObj(it.group); it.group.removeFromParent(); if (it.headerGroup) { disposeObj(it.headerGroup); it.headerGroup.removeFromParent(); } }
    for (const sc of sceneries.splice(0)) { sc.dispose(); sceneryRoot.remove(sc.group); }
    for (const v of vehicles.splice(0)) v.group.removeFromParent();
    if (arenaGroup) { disposeObj(arenaGroup); scene.remove(arenaGroup); arenaGroup = null; }
    tethers.length = 0;
    items.clear(); labelsEl.querySelectorAll('.v3-label').forEach((n) => n.remove());
    const pl = plugged(); bbox.makeEmpty();
    // parts on a robot car chassis (by their 2D position)
    const all = [...canvas.parts.values()], mountOf = new Map();
    for (const c of all.filter((p) => p.type === CAR_TYPE)) for (const id of mountedOn(c, all)) if (!mountOf.has(id)) mountOf.set(id, c.id);
    for (const part of canvas.parts.values()) {
      const it = makePart(part, pl, mountOf.get(part.id)); if (!it) continue;
      items.set(part.id, it); root.add(it.group); if (it.headerGroup) root.add(it.headerGroup);
      const b = new THREE.Box3().setFromObject(it.group); if (!b.isEmpty()) bbox.union(b);
      if (!isBB(part.type)) { const l = document.createElement('div'); l.className = 'v3-label'; l.hidden = !showLabels; l.innerHTML = l._h = labelHTML(part); l.title = catalog[part.type]?.name || part.type; l.onclick = () => showInfo(part.id); labelsEl.append(l); it.label = l; }
    }
    buildVehicles(all, mountOf);
    buildWires(pl);
    attachWires();
    for (const it of items.values()) {                          // scenery around sensors (obstacle, water, soil, lamp …)
      if (!hasScenery(it.part.type)) continue;
      const sc = makeScenery(it, { labelsHost: labelsEl, onCar: mountOf.has(it.part.id) });
      if (sc) { sceneryRoot.add(sc.group); sceneries.push(sc); it.scenery = sc; }
    }
    if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 10, 50));
    // the camera also frames obstacles up to 1.5 m away, so the thing a sensor measures is in view
    viewBox.copy(bbox);
    for (const sc of sceneries) {
      sc.group.matrix.copy(sc.it.group.matrixWorld); sc.group.updateMatrixWorld(true); sc.update(0);
      for (const m of sc.pick) { const b = new THREE.Box3().setFromObject(m); if (!b.isEmpty() && b.distanceToPoint(bbox.getCenter(new THREE.Vector3())) < 1500) viewBox.union(b); }
    }
    const c = bbox.getCenter(new THREE.Vector3()), sz = bbox.getSize(new THREE.Vector3()), R = Math.max(sz.x, sz.z, 60);
    ground.scale.set(Math.max(R * 8, 9000), Math.max(R * 8, 9000), 1); ground.position.set(c.x, 0, c.z);
    if (grid) { scene.remove(grid); grid.geometry.dispose(); }
    const step = 10, n = Math.ceil((R * 3) / step) * 2;
    grid = new THREE.GridHelper(n * step, n, 0xd9d1c2, 0xd9d1c2); grid.position.set(Math.round(c.x / step) * step, 0.02, Math.round(c.z / step) * step); grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);
    sun.position.set(c.x + R * 0.6, R * 2.2, c.z + R * 0.9); sun.target.position.copy(c);
    const sc = sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = R * 6; sc.updateProjectionMatrix();
    theme();
    if (selected && items.has(selected)) showInfo(selected); else hideInfo();
    afterBuild();
  }

  function texturedTop(part, it, W, D, T, opts = {}) {
    // flat textured face (and stacked alpha layers for irregular outlines: a cheap extrusion of the artwork)
    const mat = new THREE.MeshStandardMaterial({ transparent: true, alphaTest: 0.35, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide });
    const top = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat); top.rotation.x = -Math.PI / 2; top.position.y = T + 0.02; top.castShadow = true; top.receiveShadow = true;
    it.group.add(top); it.top = top; it.layers = [];
    it.refresh = async () => {
      const cv = await snapshot(part, canvas.zoom || 1, [W / MM, D / MM]); if (!cv || !items.has(part.id) || items.get(part.id) !== it) return;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const old = mat.map; mat.map = tex; mat.needsUpdate = true; old?.dispose();
      if (!it.shaped && !opts.noBody) {                       // decide the body once: solid slab or extruded outline
        it.shaped = true; const { f, edge } = opaqueFraction(cv);
        if (f > 0.82 && T > 0.3) {
          const body = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), new THREE.MeshStandardMaterial({ color: edge || new THREE.Color(0x2a6f4a), roughness: 0.8 }));
          body.position.y = T / 2; body.castShadow = true; body.receiveShadow = true; it.group.add(body); it.body = body;
        } else {
          const N = Math.max(2, Math.min(8, Math.round(T / 0.35)));
          for (let i = 0; i < N; i++) {
            const m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, color: new THREE.Color(0.55, 0.55, 0.55), roughness: 0.8 });
            const l = new THREE.Mesh(new THREE.PlaneGeometry(W, D), m); l.rotation.x = -Math.PI / 2; l.position.y = (T * i) / N + 0.01; l.castShadow = i === 0; it.group.add(l); it.layers.push(l);
          }
        }
      } else for (const l of it.layers) { l.material.map = tex; l.material.needsUpdate = true; }
      it.last = performance.now();
    };
    it.dirty = true;
    // the artwork changes when the simulation changes the element: watch its shadow DOM
    const r = part.el.shadowRoot || part.el;
    it.obs = new MutationObserver(() => { it.dirty = true; }); it.obs.observe(r, { subtree: true, attributes: true, childList: true, characterData: true });
    it.hasCanvas = !!r.querySelector('canvas');
  }

  function makePart(part, pl, carId) {
    let [w, h] = part.size;
    if (!w || !h) { const r = hostRect(part), z = canvas.zoom || 1; w ||= ((part.rot & 1) ? r.height : r.width) / z; h ||= ((part.rot & 1) ? r.width : r.height) / z; }
    if (!w || !h) { w ||= 20; h ||= 20; }
    const W = w * MM, D = h * MM, deck = carId ? CAR.deck : 0;
    // a distance sensor on a robot car stands on its pins (on a bracket), facing the way it is drawn
    const plug = pl.has(part.id) || (!!carId && !!DIST_SENSORS[part.type] && part.type !== 'mod-tfluna');
    if (isBB(part.type)) {
      const group = new THREE.Group(), it = { part, group, kind: 'bb', carId }; group.userData.partId = part.id;
      group.position.set((part.left + w / 2) * MM, deck, (part.top + h / 2) * MM); group.rotation.y = -(part.rot & 3) * Math.PI / 2;
      const body = new THREE.Mesh(new THREE.BoxGeometry(W, BB_H, D), new THREE.MeshStandardMaterial({ color: 0xf3f0e9, roughness: 0.9 }));
      body.position.y = BB_H / 2; body.castShadow = true; body.receiveShadow = true; group.add(body);
      texturedTop(part, it, W, D, BB_H, { noBody: true });
      return it;
    }
    // live artwork texture (fixed size canvas, redrawn in place when the element changes)
    const k = Math.min(4, 2048 / Math.max(w, h)), cv = document.createElement('canvas'); cv.width = Math.ceil(w * k); cv.height = Math.ceil(h * k);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const m = buildPart3D({ part, W, D, tex, plugged: plug, catalog, glowTex: glowTex() });
    const group = m.root;
    group.position.set((part.left + w / 2) * MM, (pl.has(part.id) ? BB_H : 0) + m.lift + deck, (part.top + h / 2) * MM); group.rotation.y = -(part.rot & 3) * Math.PI / 2;
    group.updateMatrixWorld(true);
    const it = { part, group, kind: m.kind, model: m, contacts: m.contacts, tex, cv, standing: m.standing, carId };
    it.refresh = async () => {
      const snap = await snapshot(part, canvas.zoom || 1, [w, h]); if (!snap || items.get(part.id) !== it) return;
      const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(snap, 0, 0, cv.width, cv.height); tex.needsUpdate = true;
      if (!it.colored && m.pcbSide) { it.colored = true; const c = pcbEdgeColor(cv, SPEC[part.type]?.pcb || null); if (c) m.pcbSide.color.copy(c); }
      if (m.lenses) for (const L of m.lenses) {                     // module LEDs: glow when the artwork shows them lit
        const d = g.getImageData(Math.min(cv.width - 1, L.fx * cv.width), Math.min(cv.height - 1, L.fy * cv.height), 1, 1).data;
        const lum = (Math.max(d[0], d[1], d[2]) - Math.min(d[0], d[1], d[2])) / 255; L.m.emissiveIntensity = lum > 0.45 && Math.max(d[0], d[1], d[2]) > 150 ? 1.4 : 0;
      }
      it.last = performance.now();
    };
    it.dirty = true;
    const r = part.el.shadowRoot || part.el;
    it.obs = new MutationObserver(() => { it.dirty = true; }); it.obs.observe(r, { subtree: true, attributes: true, childList: true, characterData: true });
    it.hasCanvas = !!r.querySelector('canvas');
    return it;
  }

  let _glow = null;
  function glowTex() {
    if (_glow) return _glow;
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); _glow = new THREE.CanvasTexture(c); return _glow;
  }

  /** world position where a wire lands on a pin (contact marker of the model, or the breadboard hole) */
  function contactOf(ref) {
    const pid = ref.slice(0, ref.lastIndexOf(':')), pin = ref.slice(ref.lastIndexOf(':') + 1), it = items.get(pid), q = canvas.pinPos(ref);
    if (!q) return null;
    if (it?.kind === 'bb') return onCar(it, toV(q, BB_H + (it.carId ? CAR.deck : 0)));
    const c = it?.contacts?.get(pin);
    if (c) { const v3 = c.getWorldPosition(new THREE.Vector3()); return it.standing ? onCar(it, new THREE.Vector3(q.x * MM, v3.y, q.y * MM)) : v3; }
    return onCar(it, toV(q, 2 + (it?.carId ? CAR.deck : 0)));
  }
  /** a point given in Desain coordinates (car at its start pose) → where it is now that the car has moved */
  function onCar(it, v) {
    const veh = it?.vehicle; if (!veh) return v;
    return veh.group.localToWorld(v.clone().sub(veh.O));
  }
  function roundedPath(P, r) {
    const path = new THREE.CurvePath();
    let prev = P[0];
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1], d1 = b.clone().sub(a), d2 = c.clone().sub(b), l1 = d1.length(), l2 = d2.length();
      const k = Math.min(r, l1 / 2, l2 / 2), p1 = b.clone().sub(d1.normalize().multiplyScalar(k)), p2 = b.clone().add(d2.normalize().multiplyScalar(k));
      if (prev.distanceTo(p1) > 0.01) path.add(new THREE.LineCurve3(prev, p1));
      path.add(new THREE.QuadraticBezierCurve3(p1, b, p2)); prev = p2;
    }
    path.add(new THREE.LineCurve3(prev, P[P.length - 1]));
    return path;
  }
  function buildWires(pl) {
    for (const c of [...wiresGroup.children]) { disposeObj(c); wiresGroup.remove(c); }
    const bundleHop = new Map();                                     // wires of one harness run at one height
    for (const w of canvas.wires) {
      if (w.plug || !w.bundle) continue; const A = contactOf(w.a), B = contactOf(w.b); if (!A || !B) continue;
      bundleHop.set(w.bundle, Math.max(bundleHop.get(w.bundle) || 0, Math.max(A.y, B.y) + 10));
    }
    for (const w of canvas.wires) {
      if (w.plug) continue;
      const pa = canvas.pinPos(w.a), pb = canvas.pinPos(w.b); if (!pa || !pb) continue;
      const A = contactOf(w.a), B = contactOf(w.b); if (!A || !B) continue; const ya = A.y, yb = B.y;
      const dist = A.distanceTo(B), hop = w.bundle && bundleHop.has(w.bundle) ? bundleHop.get(w.bundle) : Math.max(ya, yb) + 7 + Math.min(14, Math.max(3, dist * 0.08));
      // right-angle runs only: straight up from the pin, the 2D route (stored bends or the automatic orthogonal one) at one height, straight down
      const route = canvas.wirePoints ? canvas.wirePoints(w) : w.pts || [];
      const P = [A.clone().setY(ya + 7), A.clone().setY(hop), ...route.map((q) => toV(q, hop)), B.clone().setY(hop), B.clone().setY(yb + 7)];
      const curve = roundedPath(P.filter((q, i) => i === 0 || q.distanceTo(P[i - 1]) > 0.05), 1.2);
      const pts = P;
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(400, 16 + pts.length * 20), 0.55, 8, false), new THREE.MeshStandardMaterial({ color: new THREE.Color(w.color || '#3d8bfd'), roughness: 0.45 }));
      tube.castShadow = true; tube.userData.wire = w.id; wiresGroup.add(tube);
      if (w.bundle) tube.userData.bundle = w.bundle;
      for (const P of [A, B]) {                                        // Dupont housing on each end
        const tip = new THREE.Mesh(new THREE.BoxGeometry(2.5, 7, 2.5), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 })); tip.position.copy(P).setY(P.y + 3.6); tip.castShadow = true; tip.userData.wireOf = w.id; wiresGroup.add(tip);
      }
    }
    for (const t of canvas.bundleTies?.() || []) {                   // cable ties around each harness
      const y = bundleHop.get(t.bundle); if (y == null) continue;
      const tie = new THREE.Mesh(new THREE.BoxGeometry(t.w * MM + 0.8, 1.9, t.h * MM + 0.8), new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.5 }));
      tie.position.set((t.x + t.w / 2) * MM, y, (t.y + t.h / 2) * MM); tie.castShadow = true; tie.userData.bundle = t.bundle; wiresGroup.add(tie);
      const head = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), tie.material); head.position.copy(tie.position); head.position[t.vertical ? 'x' : 'z'] += (t.vertical ? t.w : t.h) * MM / 2 + 1.1; head.userData.bundle = t.bundle; wiresGroup.add(head);
    }
  }

  // ---------------------------------------------------------------- robot car: vehicle group, arena, driving
  const carBehavior = (id) => sim.behaviors?.find((b) => b._part?.id === id)?.car || null;
  function buildVehicles(all, mountOf) {
    for (const car of all.filter((p) => p.type === CAR_TYPE)) {
      const cit = items.get(car.id); if (!cit) continue;
      const O = new THREE.Vector3(cit.group.position.x, 0, cit.group.position.z), k = car.rot & 3;
      const group = new THREE.Group(); group.position.copy(O); group.userData.vehicle = car.id; root.add(group); group.updateMatrixWorld(true);
      const veh = { id: car.id, group, O, k, members: new Set([car.id]), wheelAng: 0, last: null, arena: arenaOf(car.attrs?.arena) };
      for (const [id, c] of mountOf) if (c === car.id) veh.members.add(id);
      for (const id of veh.members) { const it = items.get(id); if (!it) continue; group.attach(it.group); it.vehicle = veh; }
      vehicles.push(veh);
      if (!arenaGroup) buildArena(veh);
    }
    for (const b of host.querySelectorAll('.v3-car')) b.hidden = !vehicles.length;
    if (!vehicles.length && follow) { follow = false; host.querySelector('[data-v=follow]')?.classList.remove('on'); }
  }
  /** wires between parts that ride on the same car move with it; wires from the car to the table follow it (tethers) */
  function attachWires() {
    if (!vehicles.length) return;
    const owner = (ref) => { const id = ref.slice(0, ref.lastIndexOf(':')); return vehicles.find((v) => v.members.has(id)) || null; };
    const byWire = new Map(canvas.wires.map((w) => [w.id, w]));
    const bundleCar = new Map();
    for (const obj of [...wiresGroup.children]) {
      const wid = obj.userData.wire ?? obj.userData.wireOf, w = wid != null ? byWire.get(wid) : null;
      if (w) {
        const a = owner(w.a), b = owner(w.b);
        if (a && a === b) { a.group.attach(obj); if (w.bundle) bundleCar.set(w.bundle, a); }
        else if ((a || b) && obj.userData.wire) tethers.push({ w, mesh: obj });
        else if (a || b) {                                            // the plug on the car's end of a tether rides along
          const A = contactOf(w.a), B = contactOf(w.b), nearA = A && B ? obj.position.distanceTo(A) < obj.position.distanceTo(B) : !!a;
          const v = nearA ? a : b; if (v) v.group.attach(obj);
        }
      }
    }
    for (const obj of [...wiresGroup.children]) if (obj.userData.bundle && bundleCar.has(obj.userData.bundle) && !obj.userData.wire) bundleCar.get(obj.userData.bundle).group.attach(obj);
  }
  function buildArena(veh) {
    const ar = veh.arena, g = new THREE.Group(), s = 1000;          // arena metres → mm
    g.position.copy(veh.O).sub(new THREE.Vector3(ar.start.x * s, 0, ar.start.z * s).applyAxisAngle(new THREE.Vector3(0, 1, 0), -veh.k * Math.PI / 2));
    g.rotation.y = -veh.k * Math.PI / 2;
    if (ar.walls) {
      const L = ar.walls.half * s, h = ar.walls.h * s, t = 18, m = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.85 });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * L, 2 * L), new THREE.MeshStandardMaterial({ color: 0xd9cdb6, roughness: 0.95 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = 0.05; floor.receiveShadow = true; g.add(floor);
      for (const [x, z, w, d] of [[0, -L - t / 2, 2 * L + 2 * t, t], [0, L + t / 2, 2 * L + 2 * t, t], [-L - t / 2, 0, t, 2 * L], [L + t / 2, 0, t, 2 * L]]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); wall.position.set(x, h / 2, z); wall.castShadow = true; wall.receiveShadow = true; g.add(wall);
      }
    }
    for (const b of ar.boxes) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(b.w * s, b.h * s, b.d * s), new THREE.MeshStandardMaterial({ color: b.c, roughness: 0.6 }));
      box.position.set(b.x * s, b.h * s / 2, b.z * s); box.castShadow = true; box.receiveShadow = true; g.add(box);
    }
    if (ar.track) {                                                  // black tape line, 25 mm wide
      const pts = trackPoints(ar.track, 160), half = 12.5;
      const geo = new THREE.BufferGeometry(), pos = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, nx = -dz / l * half, nz = dx / l * half;
        const A = [a.x * s, a.z * s], B = [b.x * s, b.z * s];
        pos.push(A[0] + nx, 0.3, A[1] + nz, A[0] - nx, 0.3, A[1] - nz, B[0] + nx, 0.3, B[1] + nz, A[0] - nx, 0.3, A[1] - nz, B[0] - nx, 0.3, B[1] - nz, B[0] + nx, 0.3, B[1] + nz);
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
      const tape = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, side: THREE.DoubleSide })); tape.receiveShadow = true; g.add(tape);
    }
    arenaGroup = g; scene.add(g);
  }
  /** move every car to its simulated pose */
  function updateVehicles(now) {
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0; lastFrame = now;
    let moved = false;
    for (const v of vehicles) {
      const b = carBehavior(v.id), p = b?.pose, st = b?.arena?.().start || v.arena.start;
      const x = p ? p.x - st.x : 0, z = p ? p.z - st.z : 0, th = p ? p.th - st.th : 0;
      const off = new THREE.Vector3(x * 1000, 0, z * 1000).applyAxisAngle(new THREE.Vector3(0, 1, 0), -v.k * Math.PI / 2);
      const prev = v.group.position.clone();
      v.group.position.copy(v.O).add(off); v.group.rotation.y = -th;
      if (!v.last || v.last.distanceToSquared(v.group.position) > 1e-4 || Math.abs((v.lastTh ?? 0) - th) > 1e-4) { moved = true; v.last = v.group.position.clone(); v.lastTh = th; }
      if (follow && v === vehicles[0]) { const d = v.group.position.clone().sub(prev); controls.target.add(d); camera.position.add(d); }
      const wheels = items.get(v.id)?.model?.wheels;
      if (wheels && p && sim.running) { wheels[0].rotation.x -= (p.vl * dt) / CAR.wheelR; wheels[1].rotation.x -= (p.vr * dt) / CAR.wheelR; }
      v.group.updateMatrixWorld(true);
    }
    if (moved) {
      for (const p of probes) placeProbe(p);
      if (now - (api._tetherT || 0) > 90) { api._tetherT = now; for (const t of tethers) rebuildTether(t); }
    }
  }
  function rebuildTether(t) {
    const A = contactOf(t.w.a), B = contactOf(t.w.b); if (!A || !B) return;
    const hop = Math.max(A.y, B.y) + 12, P = [A.clone().setY(A.y + 7), A.clone().setY(hop), B.clone().setY(hop), B.clone().setY(B.y + 7)];
    const curve = roundedPath(P.filter((q, i) => i === 0 || q.distanceTo(P[i - 1]) > 0.05), 4);
    t.mesh.geometry.dispose(); t.mesh.geometry = new THREE.TubeGeometry(curve, 48, 0.55, 8, false);
  }

  // ---------------------------------------------------------------- live state
  function liveUpdate(now) {
    let budget = 3;
    for (const it of items.values()) {
      const el = it.part.el;
      it.model?.update?.();
      if (it.refresh && budget > 0) {
        const due = it.dirty || (it.hasCanvas && sim.running && now - (it.last || 0) > 120);
        if (due && now - (it.last || 0) > 70 && !it.busy) { it.dirty = false; it.busy = true; budget--; it.refresh().finally(() => { it.busy = false; }); }
      }
    }
  }

  // ---------------------------------------------------------------- labels & info card
  const v = new THREE.Vector3();
  function project(p) { v.copy(p).project(camera); const w = host.clientWidth, h = host.clientHeight; return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, vis: v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1 }; }
  function labelHTML(part) {
    const sum = L.propSummary(part, catalog[part.type]);
    return `<i></i>${esc(part.id)}${sum ? `<small>${esc(sum)}</small>` : ''}`;
  }
  function updateLabel(id) { const it = items.get(id); if (it?.label) { const h = labelHTML(it.part); if (it.label._h !== h) { it.label._h = h; it.label.innerHTML = h; } } }
  function placeLabels() {
    for (const p of probes) {
      if (!p.pos) continue; const s = project(p.pos.clone().setY(p.pos.y + 6));
      p.el.style.display = s.vis ? '' : 'none'; if (s.vis) p.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
    for (const sc of sceneries) for (const a of sc.anchors) {
      const s = project(a.pos.clone().applyMatrix4(sc.group.matrixWorld));
      a.el.style.display = s.vis && showLabels ? '' : 'none'; if (s.vis) a.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
    if (!showLabels) return;
    for (const it of items.values()) {
      if (!it.label) continue;
      if (!it.anchor) { const b = new THREE.Box3().setFromObject(it.group); if (b.isEmpty()) continue; it.anchor = b.getCenter(new THREE.Vector3()); it.anchor.y = b.max.y + 3; if (it.vehicle) it.anchorLocal = it.vehicle.group.worldToLocal(it.anchor.clone()); }
      if (it.vehicle && it.anchorLocal) it.anchor.copy(it.anchorLocal).applyMatrix4(it.vehicle.group.matrixWorld);
      const s = project(it.anchor);
      it.label.style.display = s.vis ? '' : 'none';
      if (s.vis) it.label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    }
  }
  function liveText(part) {
    const el = part.el, cat = catalog[part.type];
    if (part.type === 'wokwi-led') return el.value ? 'MENYALA' : 'padam';
    if (/pushbutton/.test(part.type)) return el.pressed ? 'DITEKAN' : 'dilepas';
    if (part.type === 'wokwi-potentiometer' || part.type === 'wokwi-slide-potentiometer') return `posisi ${part.attrs?.value ?? '?'} %`;
    if (part.type === 'wokwi-servo') return `sudut ${Math.round(el.angle ?? 0)}°`;
    if (part.type === 'wokwi-slide-switch') return `posisi ${el.value ? 'kanan (2–3)' : 'kiri (1–2)'}`;
    if (part.type === 'wokwi-analog-joystick') return `X ${(+el.xValue || 0).toFixed(2)} · Y ${(+el.yValue || 0).toFixed(2)}`;
    if (part.type === 'wokwi-ky-040') return `sudut ${Math.round(el.angle ?? 0)}°`;
    return L.propSummary(part, cat);
  }
  const HOW = {
    button: 'Tekan dan tahan tutup tombol di model untuk menekan.', pot: 'Seret kenop ke kiri / kanan untuk memutar.', joystick: 'Seret tuas ke segala arah; ketuk untuk menekan (SEL).',
    encoder: 'Seret ke kiri / kanan untuk memutar per klik; ketuk untuk menekan tombolnya.', slide: 'Ketuk saklar untuk memindah posisinya.',
    sensor: 'Seret sensor ke atas / bawah untuk mengubah nilai utamanya (dan ke kiri / kanan untuk nilai kedua), atau pakai panel Kontrol.',
    distance: 'Seret benda (dinding) di depan sensor maju / mundur untuk mengubah jaraknya, atau pakai panel Kontrol.',
    car: 'Mobil bergerak saat simulasi berjalan, sesuai tegangan motor kiri (ML) dan kanan (MR). Komponen yang diletakkan di atas sasis ikut terbawa; sensor jarak / garis / halangan di atasnya membaca arena.',
    oncar: 'Komponen ini terpasang di mobil robot: nilainya dihitung dari arena (dinding, rintangan, garis) saat mobil bergerak.',
    toggle: 'Ketuk sensor untuk memicu / melepas (mis. ada gerakan, ada halangan).', proxy: 'Ketuk tombol / tuts di model seperti pada komponen asli.',
  };
  function interactKind(it) {
    if (!it || it.kind === 'bb') return null; const cat = catalog[it.part.type];
    if (it.kind === 'button') return 'button'; if (it.kind === 'pot' || it.kind === 'slidepot') return 'pot';
    if (it.kind === 'joystick') return 'joystick'; if (it.kind === 'encoder') return 'encoder';
    if (it.part.type === 'wokwi-slide-switch') return 'slide';
    if (it.kind === 'car') return 'car';
    if (it.vehicle && (DIST_SENSORS[it.part.type] || ['mod-ir-obstacle', 'mod-tcrt5000'].includes(it.part.type))) return 'oncar';
    if (it.scenery?.axis) return 'distance';
    if (L.dragProps(cat).length) return 'sensor'; if (L.toggleProp(cat)) return 'toggle';
    return 'proxy';
  }
  let infoTab = null;
  function showInfo(id) {
    const part = canvas.parts.get(id); if (!part) return hideInfo();
    selected = id; const cat = catalog[part.type] || {}, it = items.get(id), ik = interactKind(it);
    const conns = canvas.wires.filter((w) => !w.plug && (w.a.startsWith(id + ':') || w.b.startsWith(id + ':')))
      .map((w) => { const [mine, other] = w.a.startsWith(id + ':') ? [w.a, w.b] : [w.b, w.a]; return `<tr><td><span class="sw" style="background:${esc(w.color)}"></span>${esc(mine.slice(id.length + 1))}</td><td>→ ${esc(other)}</td></tr>`; });
    const bb = [...canvas.parts.values()].filter((p) => isBB(p.type) && canvas.pluggedInto(p.id).includes(id)).map((p) => p.id);
    const ctl = L.controlsHTML(part, cat), mine = issues.filter((x) => x.parts.includes(id));
    const tabs = [ctl || HOW[ik] ? ['k', 'Kontrol'] : null, ['p', `Pin (${part.pinInfo.length})`], ['c', `Kabel (${conns.length})`]].filter(Boolean);
    if (!tabs.some((t) => t[0] === infoTab)) infoTab = tabs[0][0];
    const live = liveText(part);
    info.innerHTML = `<button class="v3-x" title="Tutup">✕</button><b>${esc(cat.name || part.type)}</b> <code>${esc(id)}</code>
      ${live ? `<div class="v3-live">Status: <b data-live>${esc(live)}</b></div>` : ''}
      ${bb.length ? `<div class="muted small">Tertancap di ${esc(bb.join(', '))}</div>` : ''}
      ${mine.map((x) => `<div class="v3-iss ${x.level}">${x.level === 'error' ? '✕' : '!'} ${esc(x.text)}</div>`).join('')}
      <div class="v3-tabs">${tabs.map(([k, t]) => `<button data-t="${k}" class="${k === infoTab ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>
      <div data-p="k" ${infoTab === 'k' ? '' : 'hidden'}>${HOW[ik] ? `<div class="v3-how">${esc(HOW[ik])}</div>` : ''}${ctl}</div>
      <div data-p="p" ${infoTab === 'p' ? '' : 'hidden'}><table class="v3-ptab"><thead><tr><th>Pin</th><th>Ukur</th><th></th></tr></thead><tbody>${part.pinInfo.map((p) => `<tr data-ref="${esc(id + ':' + p.name)}" title="Ketuk untuk memasang probe multimeter"><td>${esc(canvas.pinLabel(part, p))}</td><td data-r></td><td class="muted" data-s></td></tr>`).join('')}</tbody></table>
        <div class="muted small">Ketuk baris untuk memasang probe multimeter pada pin.</div></div>
      <div data-p="c" ${infoTab === 'c' ? '' : 'hidden'}>${conns.length ? `<table>${conns.join('')}</table>` : '<div class="muted small">Belum ada kabel.</div>'}</div>`;
    info.hidden = false;
    info.querySelector('.v3-x').onclick = hideInfo;
    info.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { infoTab = b.dataset.t; info.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); info.querySelectorAll('[data-p]').forEach((p) => (p.hidden = p.dataset.p !== infoTab)); syncInfo(true); }));
    info.querySelectorAll('[data-k]').forEach((inp) => {
      const p = cat.props.find((x) => x.key === inp.dataset.k);
      if (inp.tagName === 'BUTTON') inp.onclick = () => { setAttr(part, p.key, !part.attrs[p.key], true); flash(part.id, `${p.label}: ${part.attrs[p.key] ? 'ya' : 'tidak'}`); };
      else inp.oninput = inp.onchange = (ev) => setAttr(part, p.key, p.type === 'range' ? +inp.value : inp.value, ev.type === 'change');
    });
    info.querySelectorAll('tr[data-ref]').forEach((tr) => (tr.onclick = () => toggleProbe(tr.dataset.ref)));
    for (const x of items.values()) x.label?.classList.toggle('sel', x.part.id === id);
    syncInfo(true);
  }
  /** live values in the open info card */
  function syncInfo(force) {
    if (!selected || info.hidden) return; const part = canvas.parts.get(selected); if (!part) return;
    const lv = info.querySelector('[data-live]'); if (lv) lv.textContent = liveText(part);
    const cat = catalog[part.type] || {};
    for (const inp of info.querySelectorAll('input[data-k]')) {
      const p = cat.props.find((x) => x.key === inp.dataset.k); const val = part.attrs[p.key] ?? p.def;
      if (document.activeElement !== inp && +inp.value !== +val) inp.value = val;
      const o = info.querySelector(`[data-out="${p.key}"]`); if (o) o.textContent = L.fmtProp(p, val);
    }
    for (const b of info.querySelectorAll('button[data-k]')) { const on = !!part.attrs[b.dataset.k]; b.classList.toggle('on', on); b.textContent = on ? 'Ya' : 'Tidak'; }
    if (infoTab === 'p' || force) {
      const st = L.staticCircuit(canvas);
      for (const tr of info.querySelectorAll('tr[data-ref]')) {
        const r = L.readPin(sim, canvas, tr.dataset.ref, st);
        tr.className = 'lvl-' + r.level + (probes.some((p) => p.ref === r.ref) ? ' probed' : '');
        tr.querySelector('[data-r]').textContent = r.volts !== null ? r.volts.toFixed(2) + ' V' : r.live ? r.state : (r.peers.length || r.viaBB ? '·' : '—');
        tr.querySelector('[data-s]').textContent = r.volts !== null ? r.state + (r.mode ? ' · ' + r.mode : '') : r.live ? '' : (r.peers[0] || (r.viaBB ? 'breadboard' : ''));
        tr.title = (r.detail ? r.detail + '\n' : '') + (r.peers.length ? 'Tersambung ke: ' + r.peers.join(', ') : '') + (r.viaBB ? ' (lewat breadboard)' : '');
      }
    }
  }
  function hideInfo() { selected = null; info.hidden = true; for (const it of items.values()) it.label?.classList.remove('sel'); }

  // ---------------------------------------------------------------- sensor values & gestures
  function setAttr(part, key, val, commit) {
    part.attrs[key] = val; canvas.applyAttrs(part);
    try { onAttr?.(part, key, commit); } catch { /* host hook */ }
    sim.resolveNow?.(); updateLabel(part.id);
    const p = catalog[part.type]?.props?.find((x) => x.key === key);
    if (commit && p && p.type === 'select') schedule();                       // e.g. LED colour: rebuild the model
  }
  let flashT = 0;
  function flash(id, text, x, y) {
    const it = items.get(id); let s = null;
    if (x == null && it) { if (!it.anchor) { const b = new THREE.Box3().setFromObject(it.group); it.anchor = b.getCenter(new THREE.Vector3()); it.anchor.y = b.max.y + 3; } s = project(it.anchor); }
    hudEl.textContent = text; hudEl.hidden = false;
    hudEl.style.transform = `translate(${x ?? s?.x ?? host.clientWidth / 2}px, ${(y ?? s?.y ?? 80) - 26}px) translate(-50%, -100%)`;
    clearTimeout(flashT); flashT = setTimeout(() => { hudEl.hidden = true; }, 1300);
  }
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const snapStep = (x, p) => { const s = +p.step || 1; return clamp(Math.round((x - p.min) / s) * s + +p.min, +p.min, +p.max); };

  /** forward a tap on the 3D model to the matching spot of the 2D element (keypad keys, DIP switches, IR remote …) */
  function proxyClick(it, point) {
    if (!it || it.standing || it.kind === 'bb') return false;
    const part = it.part, l = it.group.worldToLocal(point.clone()), ux = l.x / MM, uy = l.z / MM;
    const z = canvas.zoom || 1, er = hostRect(part), cx = er.left + er.width / 2, cy = er.top + er.height / 2;
    const k = part.rot & 3, c = [1, 0, -1, 0][k], s = [0, 1, 0, -1][k];
    const X = cx + (c * ux - s * uy) * z, Y = cy + (s * ux + c * uy) * z;
    const rootEl = part.el.shadowRoot || part.el; let best = null, ba = Infinity, bp = null, bpa = Infinity;
    for (const n of rootEl.querySelectorAll('*')) {
      if (/^(style|defs|title|desc)$/i.test(n.tagName)) continue;
      const r = n.getBoundingClientRect(); if (!r.width || !r.height || X < r.left || X > r.right || Y < r.top || Y > r.bottom) continue;
      const a = r.width * r.height; if (a < ba) { ba = a; best = n; }
      let cur = ''; try { cur = getComputedStyle(n).cursor; } catch { /* svg */ }
      if (cur === 'pointer' && a < bpa) { bpa = a; bp = n; }
    }
    const t = bp || best; if (!t) return false;
    const o = { bubbles: true, composed: true, cancelable: true, clientX: X, clientY: Y, button: 0, view: window };
    t.dispatchEvent(new MouseEvent('mousedown', o));
    setTimeout(() => { t.dispatchEvent(new MouseEvent('mouseup', o)); t.dispatchEvent(new MouseEvent('click', o)); sim.resolveNow?.(); }, 160);
    sim.resolveNow?.();
    return true;
  }

  // ---------------------------------------------------------------- multimeter
  function pinWorld(part, info) {
    if (isBB(part.type)) { const q = canvas._xf(part, info.x, info.y), it = items.get(part.id); return onCar(it, new THREE.Vector3((part.left + q.x) * MM, BB_H + (it?.carId ? CAR.deck : 0), (part.top + q.y) * MM)); }
    return contactOf(`${part.id}:${info.name}`);
  }
  /** nearest pin to a ray hit (part body, breadboard hole or the end of a wire) */
  function nearestPin(h, e) {
    if (!h) return null;
    if (h.wire) {
      const w = canvas.wires.find((x) => x.id === h.wire); if (!w) return null;
      const A = contactOf(w.a), B = contactOf(w.b); if (!A || !B) return null;
      return A.distanceTo(h.point) <= B.distanceTo(h.point) ? { ref: w.a, pos: A } : { ref: w.b, pos: B };
    }
    const part = canvas.parts.get(h.id); if (!part) return null;
    // pins under the cursor on screen (works for upright modules whose legs hide below the body), else nearest in 3D
    const r = glCanvas.getBoundingClientRect(), cx = e ? e.clientX - r.left : null, cy = e ? e.clientY - r.top : null;
    let best = null, bd = Infinity;
    for (const p of part.pinInfo) {
      const c = pinWorld(part, p); if (!c) continue;
      let d;
      if (e) { const s = project(c); d = Math.hypot(s.x - cx, s.y - cy) / 4; }
      else d = Math.hypot(c.x - h.point.x, c.z - h.point.z) + 0.25 * Math.abs(c.y - h.point.y);
      if (d < bd) { bd = d; best = { ref: `${part.id}:${p.name}`, pos: c }; }
    }
    if (!best || bd > (isBB(part.type) ? (e ? 2.5 : 1.8) : (e ? 4 : 4.5))) return null;
    if (isBB(part.type)) { const pw = canvas.wires.find((w) => w.plug && w.b === best.ref); if (pw) return { ref: pw.a, pos: best.pos }; }   // a leg in this hole: name the part's pin
    return best;
  }
  function probeMesh(color) {
    const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.35, metalness: 0.1 });
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.6, 14), new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.9, roughness: 0.25 })); tip.rotation.x = Math.PI; tip.position.y = 1.3; g.add(tip);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.75, 9, 18), m); grip.position.y = 7.1; g.add(grip);
    const guard = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.7, 18), m); guard.position.y = 2.9; g.add(guard);
    g.traverse((o) => { o.castShadow = true; }); return g;
  }
  function toggleProbe(ref) {
    if (!ref) return;
    const i = probes.findIndex((p) => p.ref === ref);
    if (i >= 0) { const [p] = probes.splice(i, 1); labGroup.remove(p.mesh); disposeObj(p.mesh); p.el.remove(); }
    else {
      if (probes.length >= 6) { const [p] = probes.splice(0, 1); labGroup.remove(p.mesh); disposeObj(p.mesh); p.el.remove(); }
      const used = new Set(probes.map((p) => p.color)), color = PROBE_COLORS.find((c) => !used.has(c)) || PROBE_COLORS[0];
      const el = document.createElement('div'); el.className = 'v3-plabel'; el.style.setProperty('--c', color); labelsEl.append(el);
      const p = { ref, color, mesh: probeMesh(color), el }; labGroup.add(p.mesh); probes.push(p); placeProbe(p);
    }
    if (!probeMode && probes.length) setProbeMode(true, true);
    renderMeter(); syncInfo(true);
  }
  function placeProbe(p) {
    const [pid] = [p.ref.slice(0, p.ref.lastIndexOf(':'))], part = canvas.parts.get(pid), inf = part?.pinInfo.find((x) => x.name === p.ref.slice(p.ref.lastIndexOf(':') + 1));
    p.pos = part && inf ? pinWorld(part, inf) : null; p.mesh.visible = !!p.pos; if (p.pos) p.mesh.position.copy(p.pos);
  }
  function renderMeter() {
    meterEl.hidden = !probeMode; host.classList.toggle('v3-has-side', probeMode || diagOpen);
    if (!probeMode) return;
    const st = L.staticCircuit(canvas), rs = probes.map((p) => ({ p, r: L.readPin(sim, canvas, p.ref, st) }));
    for (const { p, r } of rs) { p.el.textContent = r.volts !== null ? r.volts.toFixed(2) + ' V' : r.live ? r.state : '?'; p.el.classList.toggle('bad', r.level === 'err' || r.level === 'warn'); }
    const a = rs[0]?.r, b = rs[1]?.r, diff = a && b && a.volts !== null && b.volts !== null ? a.volts - b.volts : null;
    meterEl.innerHTML = `<header><b>Multimeter</b><span class="muted">${sim.running ? 'diukur terhadap GND' : 'simulasi berhenti'}</span><button class="v3-x" data-m="close" title="Tutup multimeter">✕</button></header>
      ${rs.length ? rs.map(({ p, r }) => `<div class="v3-mrow lvl-${r.level}" data-ref="${esc(p.ref)}"><i style="background:${p.color}"></i><span class="n">${esc(r.label)}</span><b>${r.volts !== null ? r.volts.toFixed(2) + ' V' : '—'}</b><em>${esc(r.state)}${r.mode ? ' · ' + esc(r.mode) : ''}</em><button class="v3-x" data-rm="${esc(p.ref)}" title="Lepas probe">✕</button>
        ${r.detail ? `<div class="d">${esc(r.detail)}</div>` : ''}${r.peers.length || r.viaBB ? `<div class="d muted">Tersambung ke ${esc(r.peers.slice(0, 6).join(', '))}${r.peers.length > 6 ? ' …' : ''}${r.viaBB ? (r.peers.length ? ' (lewat breadboard)' : 'breadboard saja') : ''}</div>` : r.level !== 'idle' || r.live ? '<div class="d muted">Tidak tersambung ke komponen lain.</div>' : ''}</div>`).join('')
        : '<div class="muted small">Ketuk pin, lubang breadboard, atau ujung kabel pada model untuk memasang probe. Ketuk lagi untuk melepas.</div>'}
      ${diff !== null ? `<div class="v3-diff">Beda tegangan ${esc(rs[0].r.label)} − ${esc(rs[1].r.label)}: <b>${diff.toFixed(2)} V</b></div>` : ''}
      ${rs.length ? '<button class="btn small" data-m="clear">Lepas semua probe</button>' : ''}`;
    meterEl.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleProbe(b.dataset.rm); }));
    meterEl.querySelector('[data-m=close]').onclick = () => setProbeMode(false);
    const cl = meterEl.querySelector('[data-m=clear]'); if (cl) cl.onclick = () => { while (probes.length) toggleProbe(probes[0].ref); };
    meterEl.querySelectorAll('.v3-mrow').forEach((row) => (row.onclick = () => { const id = row.dataset.ref.slice(0, row.dataset.ref.lastIndexOf(':')); focusPart(id); showInfo(id); }));
  }
  function setProbeMode(on, keepProbes) {
    probeMode = on; host.classList.toggle('v3-probing', on);
    host.querySelector('[data-v=probe]')?.classList.toggle('on', on);
    if (!on && !keepProbes) while (probes.length) { const p = probes.pop(); labGroup.remove(p.mesh); disposeObj(p.mesh); p.el.remove(); }
    if (hoverMarker) hoverMarker.visible = false; tipEl.hidden = true;
    renderMeter();
  }
  function hoverProbe(e, hitFn) {
    const h = hitFn(e, true), np = nearestPin(h, e);
    if (!np) { hoverMarker.visible = false; tipEl.hidden = true; glCanvas.style.cursor = ''; return; }
    hoverMarker.position.copy(np.pos); hoverMarker.visible = true; glCanvas.style.cursor = 'crosshair';
    const r = L.readPin(sim, canvas, np.ref), rr = host.getBoundingClientRect();
    tipEl.innerHTML = `<b>${esc(r.label)}</b> ${esc(L.readingText(r))}${r.mode ? ` <span class="muted">${esc(r.mode)}</span>` : ''}${r.detail ? `<div>${esc(r.detail)}</div>` : ''}${r.peers.length ? `<div class="muted">→ ${esc(r.peers.slice(0, 4).join(', '))}${r.peers.length > 4 ? ' …' : ''}</div>` : ''}`;
    tipEl.className = 'v3-tip lvl-' + r.level; tipEl.hidden = false;
    tipEl.style.transform = `translate(${Math.min(rr.width - 250, e.clientX - rr.left + 14)}px, ${e.clientY - rr.top + 14}px)`;
  }

  // ---------------------------------------------------------------- diagnosis
  const halos = [];
  function refreshIssues() {
    if (!renderer) return;
    let res = []; try { res = check?.() || []; } catch { res = []; }
    issues = L.collectIssues({ checkRes: res, runtime: runtimeLog, sim, canvas });
    worst = new Map();
    for (const x of issues) for (const id of x.parts) if (worst.get(id) !== 'error') worst.set(id, x.level);
    for (const it of items.values()) if (it.label) { it.label.classList.toggle('err', worst.get(it.part.id) === 'error'); it.label.classList.toggle('warn', worst.get(it.part.id) === 'warn'); }
    const nErr = issues.filter((x) => x.level === 'error').length, cnt = host.querySelector('.v3-cnt');
    cnt.hidden = !issues.length; cnt.textContent = issues.length; cnt.classList.toggle('err', nErr > 0);
    renderDiag(); drawHalos();
  }
  function drawHalos() {
    for (const h of halos.splice(0)) { labGroup.remove(h); h.geometry.dispose(); h.material.dispose(); }
    if (!diagOpen) return;
    for (const [id, lvl] of worst) {
      const it = items.get(id); if (!it) continue;
      const b = new THREE.Box3().setFromObject(it.group); if (b.isEmpty()) continue; b.expandByScalar(1.6);
      const hb = new THREE.Box3Helper(b, new THREE.Color(lvl === 'error' ? 0xe53935 : 0xf5a524)); hb.material.transparent = true; hb.material.depthTest = false; hb.renderOrder = 5; hb.userData.lvl = lvl;
      labGroup.add(hb); halos.push(hb);
    }
  }
  function renderDiag() {
    diagEl.hidden = !diagOpen; host.classList.toggle('v3-has-side', probeMode || diagOpen); if (!diagOpen) return;
    const nE = issues.filter((x) => x.level === 'error').length, nW = issues.length - nE;
    const src = { cek: 'cek rangkaian', sim: 'simulasi', ukur: 'pengukuran' };
    diagEl.innerHTML = `<header><b>Diagnosa</b><span class="muted">${issues.length ? `${nE} galat · ${nW} peringatan` : 'tidak ada masalah'}</span><button class="v3-x" data-d="close" title="Tutup">✕</button></header>
      ${issues.length ? issues.map((x, i) => `<div class="v3-di ${x.level}" data-i="${i}" title="${x.parts.length ? 'Ketuk untuk melihat komponennya' : ''}"><span class="ic">${x.level === 'error' ? '✕' : '!'}</span><span>${esc(x.text)}<small>${esc(src[x.src] || '')}${x.parts.length ? ' · ' + esc(x.parts.join(', ')) : ''}</small></span></div>`).join('')
        : `<div class="v3-ok">✓ Tidak ditemukan kesalahan wiring.${sim.running ? ' Daya semua komponen terukur normal.' : ' Jalankan simulasi agar daya tiap komponen ikut diukur.'}</div>`}
      <div class="v3-dfoot"><button class="btn small" data-d="re">Periksa ulang</button>${sim.running ? '' : '<span class="muted small">Tips: jalankan simulasi lalu buka Ukur untuk mengecek tegangan tiap pin.</span>'}</div>`;
    diagEl.querySelector('[data-d=close]').onclick = () => setDiag(false);
    diagEl.querySelector('[data-d=re]').onclick = () => { refreshIssues(); toast?.('Rangkaian diperiksa ulang.'); };
    diagEl.querySelectorAll('[data-i]').forEach((d) => (d.onclick = () => {
      const x = issues[+d.dataset.i]; if (!x?.parts.length) return; focusPart(x.parts[0]); showInfo(x.parts[0]);
      if (x.pin && !probes.some((p) => p.ref === x.pin)) toggleProbe(x.pin);
    }));
  }
  function setDiag(on) { diagOpen = on; host.querySelector('[data-v=diag]')?.classList.toggle('on', on); refreshIssues(); }

  // ---------------------------------------------------------------- picking & direct interaction
  function bindPointer() {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down = null, act = null, hoverQ = false;
    const hit = (e, withWires) => {
      const r = glCanvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hs = ray.intersectObjects(withWires ? [...root.children, ...wiresGroup.children] : root.children, true);
      for (const h of hs) {
        if (h.object.userData.wire) return { wire: h.object.userData.wire, obj: h.object, point: h.point };
        let o = h.object; while (o && !o.userData.partId) o = o.parent; if (o) return { id: o.userData.partId, obj: h.object, point: h.point };
      }
      return null;
    };
    api._hit = hit;
    /** an obstacle of a distance sensor under the pointer (it can be dragged along the sensor's beam) */
    const hitScenery = (e) => {
      const picks = sceneries.flatMap((sc) => sc.pick.map((m) => ({ m, sc }))); if (!picks.length) return null;
      const r = glCanvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hs = ray.intersectObjects(picks.map((p) => p.m), true); if (!hs.length) return null;
      let o = hs[0].object; while (o && !picks.some((p) => p.m === o)) o = o.parent;
      return picks.find((p) => p.m === o) || null;
    };
    /** distance along the sensor's axis that is closest to the pointer ray (in the scenery's own frame, mm) */
    const axisParam = (e, sc) => {
      const r = glCanvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const inv = sc.group.matrixWorld.clone().invert(), ro = ray.ray.origin.clone().applyMatrix4(inv), rd = ray.ray.direction.clone().transformDirection(inv);
      const { origin: o, dir: d } = sc.axis, w0 = o.clone().sub(ro), b = d.dot(rd), dd = d.dot(w0), ee = rd.dot(w0), den = 1 - b * b;
      return den < 1e-6 ? null : (b * ee - dd) / den;
    };
    const cap = (e) => { try { glCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
    glCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (probeMode) return;                                          // multimeter: taps only, the view still orbits
      const sh = hitScenery(e);
      if (sh?.sc.axis) { controls.enabled = false; act = { kind: 'obst', it: sh.sc.it, sc: sh.sc, x: e.clientX, y: e.clientY, moved: false }; cap(e); return; }
      const h = hit(e); if (!h) return;
      const it = items.get(h.id); if (!it) return; const el = it.part.el, ik = interactKind(it);
      if (ik === 'button') { controls.enabled = false; act = { kind: 'button', it }; el.pressed = true; el.dispatchEvent(new Event('button-press')); sim.resolveNow?.(); cap(e); }
      else if (ik === 'pot') { controls.enabled = false; act = { kind: 'pot', it, x: e.clientX, v0: +el.value || 0 }; cap(e); }
      else if (ik === 'joystick') { controls.enabled = false; act = { kind: 'joy', it, x: e.clientX, y: e.clientY }; cap(e); }
      else if (ik === 'encoder') { controls.enabled = false; act = { kind: 'enc', it, x: e.clientX, acc: 0 }; cap(e); }
      else if (ik === 'sensor' || ik === 'distance') {
        const ps = L.dragProps(catalog[it.part.type]);
        controls.enabled = false; act = { kind: 'sensor', it, ps, x: e.clientX, y: e.clientY, v0: ps.map((p) => +(it.part.attrs[p.key] ?? p.def)) }; cap(e);
      }
    }, true);
    glCanvas.addEventListener('pointermove', (e) => {
      if (!act) {
        if (probeMode && !e.buttons && !hoverQ) { hoverQ = true; requestAnimationFrame(() => { hoverQ = false; hoverProbe(e, hit); }); }
        return;
      }
      const dx = e.clientX - (act.x ?? e.clientX), dy = e.clientY - (act.y ?? e.clientY);
      if (Math.hypot(dx, dy) > 4) act.moved = true;
      const el = act.it.part.el, rr = host.getBoundingClientRect(), hx = e.clientX - rr.left, hy = e.clientY - rr.top;
      if (act.kind === 'pot') {
        const mn = el.min ?? 0, mx = el.max ?? (act.it.kind === 'slidepot' ? 100 : 1023);
        el.value = Math.round(Math.min(mx, Math.max(mn, act.v0 + ((e.clientX - act.x) / 220) * (mx - mn))));
        el.dispatchEvent(new InputEvent('input', { bubbles: true })); sim.resolveNow?.();
        flash(act.it.part.id, `${act.it.part.id}: ${act.it.part.attrs.value ?? Math.round(((el.value - mn) / (mx - mn)) * 100)} %`, hx, hy);
      } else if (act.kind === 'joy' && act.moved) {
        el.xValue = clamp(-dx / 55, -1, 1); el.yValue = clamp(-dy / 55, -1, 1);               // element convention: left / up = +1
        el.dispatchEvent(new InputEvent('input')); sim.resolveNow?.();
        flash(act.it.part.id, `X ${(-el.xValue).toFixed(2)} · Y ${el.yValue.toFixed(2)}`, hx, hy);
      } else if (act.kind === 'enc') {
        const steps = Math.trunc(dx / 22); act.done ||= 0;
        while (act.done !== steps) {
          const cw = steps > act.done; act.done += cw ? 1 : -1; act.moved = true;
          el.angle = ((el.angle || 0) + (cw ? 1 : -1) * (el.stepSize || 18) + 360) % 360;
          el.dispatchEvent(new InputEvent(cw ? 'rotate-cw' : 'rotate-ccw'));
          flash(act.it.part.id, cw ? '↻ putar kanan' : '↺ putar kiri', hx, hy);
        }
      } else if (act.kind === 'obst' && act.moved) {
        const t = axisParam(e, act.sc); if (t === null) return;
        const p = catalog[act.it.part.type]?.props?.find((x) => x.key === 'distance'); if (!p) return;
        const v = snapStep(act.sc.axis.unit === 'cm' ? t / 10 : t, p);
        if (v !== +act.it.part.attrs.distance) setAttr(act.it.part, 'distance', v, false);
        flash(act.it.part.id, `${act.it.part.id}: jarak ${L.fmtProp(p, act.it.part.attrs.distance)}`, hx, hy);
      } else if (act.kind === 'sensor' && act.moved) {
        const txt = [];
        act.ps.forEach((p, i) => {
          const d = i === 0 ? -dy : dx, span = (+p.max - +p.min);
          const nv = snapStep(act.v0[i] + (d / 240) * span, p);
          if (nv !== +act.it.part.attrs[p.key]) setAttr(act.it.part, p.key, nv, false);
          txt.push(`${p.label} ${L.fmtProp(p, act.it.part.attrs[p.key])}`);
        });
        flash(act.it.part.id, txt.join(' · '), hx, hy);
      }
    });
    const up = (e) => {
      const a = act; act = null; controls.enabled = true;
      if (a?.kind === 'button') { a.it.part.el.pressed = false; a.it.part.el.dispatchEvent(new Event('button-release')); sim.resolveNow?.(); }
      if (a?.kind === 'joy') {
        const el = a.it.part.el;
        if (!a.moved) { el.dispatchEvent(new Event('button-press')); sim.resolveNow?.(); setTimeout(() => { el.dispatchEvent(new Event('button-release')); sim.resolveNow?.(); }, 180); flash(a.it.part.id, 'SEL ditekan'); }
        else { el.xValue = 0; el.yValue = 0; el.dispatchEvent(new InputEvent('input')); sim.resolveNow?.(); }
      }
      if (a?.kind === 'enc' && !a.moved) { const el = a.it.part.el; el.dispatchEvent(new Event('button-press')); sim.resolveNow?.(); setTimeout(() => { el.dispatchEvent(new Event('button-release')); sim.resolveNow?.(); }, 180); flash(a.it.part.id, 'tombol encoder ditekan'); }
      if (a?.kind === 'sensor' && a.moved) { try { onAttr?.(a.it.part, a.ps[0].key, true); } catch { /* hook */ } }
      if (a?.kind === 'obst' && a.moved) { try { onAttr?.(a.it.part, 'distance', true); } catch { /* hook */ } }
      if (a?.kind === 'pot' && a.moved !== false) { try { onAttr?.(a.it.part, 'value', true); } catch { /* hook */ } }
      const tap = down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 600;
      if (tap) {
        if (probeMode) { const np = nearestPin(hit(e, true), e); if (np) toggleProbe(np.ref); else { const h = hit(e); if (h) showInfo(h.id); } }
        else {
          const h = hit(e);
          if (h) {
            const it = items.get(h.id), ik = interactKind(it);
            if (!a && ik === 'slide') { const el = it.part.el; el.value = el.value ? 0 : 1; el.dispatchEvent(new InputEvent('input', { detail: el.value })); sim.resolveNow?.(); flash(h.id, el.value ? 'saklar → posisi 2–3' : 'saklar → posisi 1–2'); }
            else if (!a && ik === 'toggle') { const p = L.toggleProp(catalog[it.part.type]); setAttr(it.part, p.key, !it.part.attrs[p.key], true); flash(h.id, `${p.label}: ${it.part.attrs[p.key] ? 'YA' : 'tidak'}`); }
            else if (!a && ik === 'proxy') proxyClick(it, h.point);
            showInfo(h.id);
          } else if (!a) hideInfo();
        }
      } else if (a?.it && a.moved) { if (selected === a.it.part.id) syncInfo(); else showInfo(a.it.part.id); }
      else if (a && selected) syncInfo();
      down = null;
    };
    glCanvas.addEventListener('pointerup', up); glCanvas.addEventListener('pointercancel', up);
    glCanvas.addEventListener('pointerleave', () => { if (!act) { tipEl.hidden = true; if (hoverMarker) hoverMarker.visible = false; } });
  }

  // ---------------------------------------------------------------- camera tools
  function view(kind) {
    const vb = viewBox.isEmpty() ? bbox : viewBox, c = vb.getCenter(new THREE.Vector3()), sz = vb.getSize(new THREE.Vector3());
    const R = Math.max(sz.x, sz.z * 1.2, 40), d = (R / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.25 / Math.min(1, camera.aspect) ;
    const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.0001) : kind === 'front' ? new THREE.Vector3(0, 0.42, 1) : new THREE.Vector3(-0.62, 0.95, 0.85);
    controls.target.copy(c); camera.position.copy(c).add(dir.normalize().multiplyScalar(d)); camera.updateProjectionMatrix(); controls.update();
  }
  function focusPart(id) {
    const it = items.get(id); if (!it) return;
    const b = new THREE.Box3().setFromObject(it.group), c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const R = Math.max(70, Math.max(sz.x, sz.z) * 3), dir = camera.position.clone().sub(controls.target).normalize();
    anim = { t0: performance.now(), ft: controls.target.clone(), fp: camera.position.clone(), tt: c, tp: c.clone().add(dir.multiplyScalar(R)) };
  }
  function orbit(deg) { const o = camera.position.clone().sub(controls.target); o.applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180); camera.position.copy(controls.target).add(o); controls.update(); }
  function dolly(f) { const o = camera.position.clone().sub(controls.target).multiplyScalar(f); camera.position.copy(controls.target).add(o); controls.update(); }
  function panBy(dx, dz) {
    const o = camera.position.clone().sub(controls.target), d = o.length() * 0.06;
    const fwd = new THREE.Vector3(-o.x, 0, -o.z).normalize(), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const m = right.multiplyScalar(dx * d).add(fwd.multiplyScalar(dz * d)); controls.target.add(m); camera.position.add(m); controls.update();
  }
  function tool(t, btn) {
    if (t === 'rotl') orbit(-45); else if (t === 'rotr') orbit(45);
    else if (t === 'zin') dolly(0.8); else if (t === 'zout') dolly(1.25);
    else if (t === 'iso' || t === 'top' || t === 'front') view(t);
    else if (t === 'labels') { showLabels = !showLabels; btn?.classList.toggle('on', showLabels); for (const it of items.values()) if (it.label) it.label.hidden = !showLabels; }
    else if (t === 'probe') { setProbeMode(!probeMode); if (probeMode) toast?.(sim.running ? 'Multimeter aktif: ketuk pin untuk mengukur.' : 'Multimeter aktif. Jalankan simulasi (▶) agar tegangan terukur.'); }
    else if (t === 'diag') setDiag(!diagOpen);
    else if (t === 'follow') { follow = !follow; host.querySelector('[data-v=follow]')?.classList.toggle('on', follow); if (follow && vehicles[0]) focusPart(vehicles[0].id); toast?.(follow ? 'Kamera mengikuti mobil.' : 'Kamera tidak lagi mengikuti mobil.'); }
    else if (t === 'carreset') {
      let n = 0; for (const v of vehicles) { const b = carBehavior(v.id); if (b) { b.reset(); n++; } }
      sim.resolveNow?.(); toast?.(n ? 'Mobil kembali ke posisi awal.' : 'Jalankan simulasi dulu: posisi mobil dihitung saat program berjalan.');
    }
    else if (t === 'close') api.close();
  }
  function onKey(e) {
    if (!open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), map = { q: () => orbit(-15), e: () => orbit(15), w: () => panBy(0, 1), s: () => panBy(0, -1), a: () => panBy(-1, 0), d: () => panBy(1, 0), '+': () => dolly(0.85), '=': () => dolly(0.85), '-': () => dolly(1.18), r: () => view('iso'), t: () => view('top'), f: () => view('front'), l: () => tool('labels', host.querySelector('[data-v=labels]')), m: () => tool('probe'), g: () => tool('diag'), k: () => vehicles.length && tool('follow'), escape: () => (probeMode ? setProbeMode(false) : api.close()) };
    if (map[k]) { e.preventDefault(); map[k](); }
    if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation();          // 2D shortcuts (R, Del, B …) stay inactive while the 3D view is open
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / 450), k = t * t * (3 - 2 * t);
      controls.target.lerpVectors(anim.ft, anim.tt, k); camera.position.lerpVectors(anim.fp, anim.tp, k); if (t >= 1) anim = null;
    }
    if (vehicles.length) updateVehicles(now);
    for (const sc of sceneries) { sc.group.matrix.copy(sc.it.group.matrixWorld); sc.group.matrixWorldNeedsUpdate = true; sc.update(now); }
    liveUpdate(now); controls.update(); renderer.render(scene, camera); placeLabels();
    for (const h of halos) h.material.opacity = 0.45 + 0.55 * Math.abs(Math.sin(now / 380));
    if (now - lastSlow > 280) {                                       // live readings (multimeter, card, labels)
      lastSlow = now; syncInfo(); if (probeMode) renderMeterLive();
      for (const it of items.values()) if (it.label) updateLabel(it.part.id);
      if (now - (api._issT || 0) > 1500) { api._issT = now; refreshIssues(); }
    }
  }
  /** cheap meter refresh: rebuild only when the readings changed */
  let meterKey = '';
  function renderMeterLive() {
    const st = L.staticCircuit(canvas), key = probes.map((p) => { const r = L.readPin(sim, canvas, p.ref, st); return p.ref + (r.volts?.toFixed(2) ?? r.state) + r.level; }).join('|') + sim.running;
    if (key !== meterKey) { meterKey = key; renderMeter(); }
  }
  function afterBuild() {
    for (const p of probes) placeProbe(p);
    refreshIssues();
  }

  const api = {
    get isOpen() { return open; },
    open() {
      if (!renderer) setup();
      open = true; host.hidden = false; resize(); build(); view('iso');
      if (vehicles.length) { follow = true; host.querySelector('[data-v=follow]')?.classList.add('on'); focusPart(vehicles[0].id); }   // a robot car: the camera rides along
      const help = host.querySelector('.v3-help'); help.classList.remove('fade'); clearTimeout(api._helpT); api._helpT = setTimeout(() => help.classList.add('fade'), 12000);
      cancelAnimationFrame(raf); loop();
      api.onToggle?.(true);
    },
    close() {
      open = false; host.hidden = true; cancelAnimationFrame(raf); raf = 0; hideInfo(); tipEl.hidden = true; hudEl.hidden = true;
      for (const it of items.values()) it.obs?.disconnect();
      api.onToggle?.(false);
    },
    toggle() { return open ? api.close() : api.open(); },
    _debug: () => ({ items, scene, camera, controls, renderer, build, view, showInfo, info, probes, toggleProbe, setProbeMode, setDiag, get issues() { return issues; }, refreshIssues, focusPart, get animating() { return !!anim; }, proxyClick, nearestPin, interactKind, project, contactOf }),
  };
  return api;
}
