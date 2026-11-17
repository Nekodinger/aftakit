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
export function init3D({ canvas, sim, host, catalog }) {
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
      <button data-v="labels" class="on" title="Tampilkan label (L)">Label</button>
      <button data-v="close" class="v3-close" title="Kembali ke 2D (Esc)">2D</button>
    </div>
    <div class="v3-help">Seret: putar · klik kanan / 2 jari: geser · scroll / pinch: zoom · WASD geser · Q/E putar · ketuk komponen untuk info · tekan tombol & putar potensiometer langsung di model</div>
    <div class="v3-info" hidden></div>`;
  const glCanvas = host.querySelector('.v3-gl'), labelsEl = host.querySelector('.v3-labels'), info = host.querySelector('.v3-info');
  let renderer = null, scene, camera, controls, root, raf = 0, open = false, showLabels = true;
  const items = new Map();                       // partId -> { part, group, top (mesh with texture), layers, dirty, last, kind, ... }
  const wiresGroup = new THREE.Group();
  let ground, grid, sun, bbox = new THREE.Box3(), rebuildT = 0, selected = null;

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
    root = new THREE.Group(); scene.add(root, wiresGroup);
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
    for (const it of items.values()) { it.obs?.disconnect(); disposeObj(it.group); root.remove(it.group); if (it.headerGroup) { disposeObj(it.headerGroup); root.remove(it.headerGroup); } }
    items.clear(); labelsEl.replaceChildren();
    const pl = plugged(); bbox.makeEmpty();
    for (const part of canvas.parts.values()) {
      const it = makePart(part, pl); if (!it) continue;
      items.set(part.id, it); root.add(it.group); if (it.headerGroup) root.add(it.headerGroup);
      const b = new THREE.Box3().setFromObject(it.group); if (!b.isEmpty()) bbox.union(b);
      if (!isBB(part.type)) { const l = document.createElement('div'); l.className = 'v3-label'; l.innerHTML = `<i></i>${esc(part.id)}`; l.title = catalog[part.type]?.name || part.type; l.onclick = () => showInfo(part.id); labelsEl.append(l); it.label = l; }
    }
    buildWires(pl);
    if (bbox.isEmpty()) bbox.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 10, 50));
    const c = bbox.getCenter(new THREE.Vector3()), sz = bbox.getSize(new THREE.Vector3()), R = Math.max(sz.x, sz.z, 60);
    ground.scale.set(R * 8, R * 8, 1); ground.position.set(c.x, 0, c.z);
    if (grid) { scene.remove(grid); grid.geometry.dispose(); }
    const step = 10, n = Math.ceil((R * 3) / step) * 2;
    grid = new THREE.GridHelper(n * step, n, 0xd9d1c2, 0xd9d1c2); grid.position.set(Math.round(c.x / step) * step, 0.02, Math.round(c.z / step) * step); grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);
    sun.position.set(c.x + R * 0.6, R * 2.2, c.z + R * 0.9); sun.target.position.copy(c);
    const sc = sun.shadow.camera; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = R * 6; sc.updateProjectionMatrix();
    theme();
    if (selected && items.has(selected)) showInfo(selected); else hideInfo();
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

  function makePart(part, pl) {
    let [w, h] = part.size;
    if (!w || !h) { const r = hostRect(part), z = canvas.zoom || 1; w ||= ((part.rot & 1) ? r.height : r.width) / z; h ||= ((part.rot & 1) ? r.width : r.height) / z; }
    if (!w || !h) { w ||= 20; h ||= 20; }
    const W = w * MM, D = h * MM, plug = pl.has(part.id);
    if (isBB(part.type)) {
      const group = new THREE.Group(), it = { part, group, kind: 'bb' }; group.userData.partId = part.id;
      group.position.set((part.left + w / 2) * MM, 0, (part.top + h / 2) * MM); group.rotation.y = -(part.rot & 3) * Math.PI / 2;
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
    group.position.set((part.left + w / 2) * MM, (plug ? BB_H : 0) + m.lift, (part.top + h / 2) * MM); group.rotation.y = -(part.rot & 3) * Math.PI / 2;
    group.updateMatrixWorld(true);
    const it = { part, group, kind: m.kind, model: m, contacts: m.contacts, tex, cv, standing: m.standing };
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
    if (it?.kind === 'bb') return toV(q, BB_H);
    const c = it?.contacts?.get(pin);
    if (c) { const v3 = c.getWorldPosition(new THREE.Vector3()); if (it.standing) { v3.x = q.x * MM; v3.z = q.y * MM; } return v3; }
    return toV(q, 2);
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
      const dist = A.distanceTo(B), hop = w.bundle && bundleHop.has(w.bundle) ? bundleHop.get(w.bundle) : Math.max(ya, yb) + 7 + Math.min(22, Math.max(4, dist * 0.18));
      const pts = [A, A.clone().setY(ya + 7.5)];
      if (w.pts?.length) for (const q of w.pts) pts.push(toV(q, hop));
      else { const m = A.clone().lerp(B, 0.5); m.y = hop + 2; pts.push(A.clone().lerp(B, 0.2).setY(hop), m, A.clone().lerp(B, 0.8).setY(hop)); }
      pts.push(B.clone().setY(yb + 7.5), B.clone().setY(yb + 7));
      pts[0] = A.clone().setY(ya + 7);
      let curve;
      if (w.pts?.length) {                                            // routed wire: straight runs with small rounded corners
        const P = [A.clone().setY(ya + 7), A.clone().setY(hop), ...w.pts.map((q) => toV(q, hop)), B.clone().setY(hop), B.clone().setY(yb + 7)];
        curve = roundedPath(P.filter((q, i) => i === 0 || q.distanceTo(P[i - 1]) > 0.05), 2.2);
      } else curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(360, 24 + (w.pts?.length || 0) * 24 + pts.length * 14), 0.55, 8, false), new THREE.MeshStandardMaterial({ color: new THREE.Color(w.color || '#3d8bfd'), roughness: 0.45 }));
      tube.castShadow = true; tube.userData.wire = w.id; wiresGroup.add(tube);
      if (w.bundle) tube.userData.bundle = w.bundle;
      for (const P of [A, B]) {                                        // Dupont housing on each end
        const tip = new THREE.Mesh(new THREE.BoxGeometry(2.5, 7, 2.5), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 })); tip.position.copy(P).setY(P.y + 3.6); tip.castShadow = true; wiresGroup.add(tip);
      }
    }
    for (const t of canvas.bundleTies?.() || []) {                   // cable ties around each harness
      const y = bundleHop.get(t.bundle); if (y == null) continue;
      const tie = new THREE.Mesh(new THREE.BoxGeometry(t.w * MM + 0.8, 1.9, t.h * MM + 0.8), new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.5 }));
      tie.position.set((t.x + t.w / 2) * MM, y, (t.y + t.h / 2) * MM); tie.castShadow = true; wiresGroup.add(tie);
      const head = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), tie.material); head.position.copy(tie.position); head.position[t.vertical ? 'x' : 'z'] += (t.vertical ? t.w : t.h) * MM / 2 + 1.1; wiresGroup.add(head);
    }
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
  function placeLabels() {
    if (!showLabels) return;
    const w = host.clientWidth, h = host.clientHeight;
    for (const it of items.values()) {
      if (!it.label) continue;
      if (!it.anchor) { const b = new THREE.Box3().setFromObject(it.group); if (b.isEmpty()) continue; it.anchor = b.getCenter(new THREE.Vector3()); it.anchor.y = b.max.y + 3; }
      v.copy(it.anchor); v.project(camera);
      const vis = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
      it.label.style.display = vis ? '' : 'none';
      if (vis) it.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }
  function liveText(part) {
    const el = part.el;
    if (part.type === 'wokwi-led') return el.value ? 'MENYALA' : 'padam';
    if (/pushbutton/.test(part.type)) return el.pressed ? 'DITEKAN' : 'dilepas';
    if (part.type === 'wokwi-potentiometer') return `posisi ${part.attrs?.value ?? '?'} %`;
    if (part.type === 'wokwi-servo') return `sudut ${Math.round(el.angle ?? 0)}°`;
    return '';
  }
  function showInfo(id) {
    const part = canvas.parts.get(id); if (!part) return hideInfo();
    selected = id; const cat = catalog[part.type] || {};
    const conns = canvas.wires.filter((w) => !w.plug && (w.a.startsWith(id + ':') || w.b.startsWith(id + ':')))
      .map((w) => { const [mine, other] = w.a.startsWith(id + ':') ? [w.a, w.b] : [w.b, w.a]; return `<tr><td><span class="sw" style="background:${esc(w.color)}"></span>${esc(mine.slice(id.length + 1))}</td><td>→ ${esc(other)}</td></tr>`; });
    const bb = [...canvas.parts.values()].filter((p) => isBB(p.type) && canvas.pluggedInto(p.id).includes(id)).map((p) => p.id);
    const live = liveText(part);
    info.innerHTML = `<button class="v3-x" title="Tutup">✕</button><b>${esc(cat.name || part.type)}</b> <code>${esc(id)}</code>
      ${live ? `<div class="v3-live">Status: <b data-live>${esc(live)}</b></div>` : ''}
      ${bb.length ? `<div class="muted small">Tertancap di ${esc(bb.join(', '))}</div>` : ''}
      <div class="v3-tabs"><button class="on" data-t="c">Sambungan (${conns.length})</button><button data-t="p">Pin (${part.pinInfo.length})</button></div>
      <div data-p="c">${conns.length ? `<table>${conns.join('')}</table>` : '<div class="muted small">Belum ada kabel.</div>'}</div>
      <div data-p="p" hidden><div class="v3-pins">${part.pinInfo.map((p) => `<span>${esc(canvas.pinLabel(part, p))}</span>`).join('')}</div></div>
      ${/pushbutton/.test(part.type) ? '<div class="muted small">Tekan tutup tombol di model 3D untuk menekan.</div>' : part.type === 'wokwi-potentiometer' ? '<div class="muted small">Seret kenop ke kiri/kanan untuk memutar.</div>' : ''}`;
    info.hidden = false;
    info.querySelector('.v3-x').onclick = hideInfo;
    info.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { info.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); info.querySelectorAll('[data-p]').forEach((p) => (p.hidden = p.dataset.p !== b.dataset.t)); }));
    for (const it of items.values()) it.label?.classList.toggle('sel', it.part.id === id);
  }
  function hideInfo() { selected = null; info.hidden = true; for (const it of items.values()) it.label?.classList.remove('sel'); }

  // ---------------------------------------------------------------- picking & direct interaction
  function bindPointer() {
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    let down = null, act = null;
    const hit = (e) => {
      const r = glCanvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hs = ray.intersectObjects(root.children, true);
      for (const h of hs) { let o = h.object; while (o && !o.userData.partId) o = o.parent; if (o) return { id: o.userData.partId, obj: h.object, point: h.point }; }
      return null;
    };
    glCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      const h = hit(e); if (!h) return;
      const it = items.get(h.id); if (!it) return;
      if (it.kind === 'button' && sim) {
        controls.enabled = false; act = { kind: 'button', it };
        it.part.el.pressed = true; it.part.el.dispatchEvent(new Event('button-press'));
        try { glCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      } else if (it.kind === 'pot' || it.kind === 'slidepot') {
        controls.enabled = false; act = { kind: 'pot', it, x: e.clientX, v0: +it.part.el.value || 0 };
        try { glCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      }
    }, true);
    glCanvas.addEventListener('pointermove', (e) => {
      if (act?.kind === 'pot') {
        const el = act.it.part.el, mn = el.min ?? 0, mx = el.max ?? (act.it.kind === 'slidepot' ? 100 : 1023);
        el.value = Math.round(Math.min(mx, Math.max(mn, act.v0 + ((e.clientX - act.x) / 220) * (mx - mn))));
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      }
    });
    const up = (e) => {
      if (act?.kind === 'button') { act.it.part.el.pressed = false; act.it.part.el.dispatchEvent(new Event('button-release')); }
      const wasAct = !!act; act = null; controls.enabled = true;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 600) {
        const h = hit(e); if (h) showInfo(h.id); else if (!wasAct) hideInfo();
      } else if (wasAct && selected) showInfo(selected);
      down = null;
    };
    glCanvas.addEventListener('pointerup', up); glCanvas.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- camera tools
  function view(kind) {
    const c = bbox.getCenter(new THREE.Vector3()), sz = bbox.getSize(new THREE.Vector3());
    const R = Math.max(sz.x, sz.z * 1.2, 40), d = (R / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.25 / Math.min(1, camera.aspect) ;
    const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.0001) : kind === 'front' ? new THREE.Vector3(0, 0.42, 1) : new THREE.Vector3(-0.62, 0.95, 0.85);
    controls.target.copy(c); camera.position.copy(c).add(dir.normalize().multiplyScalar(d)); camera.updateProjectionMatrix(); controls.update();
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
    else if (t === 'labels') { showLabels = !showLabels; btn?.classList.toggle('on', showLabels); labelsEl.hidden = !showLabels; }
    else if (t === 'close') api.close();
  }
  function onKey(e) {
    if (!open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), map = { q: () => orbit(-15), e: () => orbit(15), w: () => panBy(0, 1), s: () => panBy(0, -1), a: () => panBy(-1, 0), d: () => panBy(1, 0), '+': () => dolly(0.85), '=': () => dolly(0.85), '-': () => dolly(1.18), r: () => view('iso'), t: () => view('top'), f: () => view('front'), l: () => tool('labels', host.querySelector('[data-v=labels]')), escape: () => api.close() };
    if (map[k]) { e.preventDefault(); map[k](); }
    if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation();          // 2D shortcuts (R, Del, B …) stay inactive while the 3D view is open
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    liveUpdate(now); controls.update(); renderer.render(scene, camera); placeLabels();
    if (selected && info.querySelector('[data-live]')) { const p = canvas.parts.get(selected); if (p) info.querySelector('[data-live]').textContent = liveText(p); }
  }

  const api = {
    get isOpen() { return open; },
    open() {
      if (!renderer) setup();
      open = true; host.hidden = false; resize(); build(); view('iso');
      const help = host.querySelector('.v3-help'); help.classList.remove('fade'); clearTimeout(api._helpT); api._helpT = setTimeout(() => help.classList.add('fade'), 9000);
      cancelAnimationFrame(raf); loop();
      api.onToggle?.(true);
    },
    close() {
      open = false; host.hidden = true; cancelAnimationFrame(raf); raf = 0; hideInfo();
      for (const it of items.values()) it.obs?.disconnect();
      api.onToggle?.(false);
    },
    toggle() { return open ? api.close() : api.open(); },
    _debug: () => ({ items, scene, camera, controls, renderer, build, view, showInfo, info }),
  };
  return api;
}
