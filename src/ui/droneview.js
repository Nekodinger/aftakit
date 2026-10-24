// "Drone" console tab: chase-camera 3D view of the quadcopter, telemetry, and a two-stick RC transmitter (mode 2)
// that feeds the FlySky receiver part (CH1 roll, CH2 pitch, CH3 throttle, CH4 yaw, CH5 arm switch, CH6 mode switch).
import { euler, SLOTS, RC_DEFAULT } from '../sim/drone.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function initDroneView(sim, els) {
  const { canvas, stickL, stickR, sw5, sw6, btnReset, btnCharge, note } = els;
  sim.rc ||= { ch: RC_DEFAULT(), on: true };
  const g = canvas.getContext('2d');
  let visible = false;

  // ---------------------------------------------------------------- sticks
  // value range -1..1; the throttle axis does not spring back
  const sticks = { L: { x: 0, y: -1 }, R: { x: 0, y: 0 } };
  const apply = () => {
    const us = (v) => Math.round(1500 + 500 * clamp(v, -1, 1));
    const ch = sim.rc.ch;
    ch[0] = us(sticks.R.x); ch[1] = us(sticks.R.y); ch[2] = us(sticks.L.y); ch[3] = us(sticks.L.x);
    ch[4] = sw5.checked ? 2000 : 1000; ch[5] = sw6.checked ? 2000 : 1000;
    drawStick(stickL, sticks.L); drawStick(stickR, sticks.R);
  };
  function drawStick(el, s) {
    const knob = el.querySelector('.knob'); const r = el.clientWidth / 2 - 14;
    knob.style.transform = `translate(${s.x * r}px, ${-s.y * r}px)`;
    el.querySelector('.val').textContent = el === stickL ? `T ${sim.rc.ch[2]} · Y ${sim.rc.ch[3]}` : `R ${sim.rc.ch[0]} · P ${sim.rc.ch[1]}`;
  }
  const bindStick = (el, key, holdY) => {
    let id = null;
    const set = (e) => {
      const b = el.getBoundingClientRect(), r = b.width / 2 - 14;
      sticks[key].x = clamp((e.clientX - b.left - b.width / 2) / r, -1, 1);
      sticks[key].y = clamp(-(e.clientY - b.top - b.height / 2) / r, -1, 1);
      apply();
    };
    el.addEventListener('pointerdown', (e) => { id = e.pointerId; el.setPointerCapture(id); set(e); e.preventDefault(); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
    const up = (e) => { if (e.pointerId !== id) return; id = null; sticks[key].x = 0; if (!holdY) sticks[key].y = 0; apply(); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  bindStick(stickL, 'L', true); bindStick(stickR, 'R', false);
  sw5.onchange = apply; sw6.onchange = apply;
  // keyboard (when the drone pane has focus): W/S throttle, A/D yaw, arrows pitch/roll, Space = arm switch
  const held = new Set();
  canvas.parentElement.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') { sw5.checked = !sw5.checked; apply(); e.preventDefault(); return; }
    if (['w', 's', 'a', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { held.add(k); e.preventDefault(); }
  });
  const axes = () => {
    sticks.L.x = held.has('a') ? -0.6 : held.has('d') ? 0.6 : 0;
    sticks.R.x = held.has('arrowleft') ? -0.5 : held.has('arrowright') ? 0.5 : 0;
    sticks.R.y = held.has('arrowup') ? 0.5 : held.has('arrowdown') ? -0.5 : 0;
  };
  canvas.parentElement.addEventListener('keyup', (e) => { if (held.delete(e.key.toLowerCase())) { axes(); apply(); } });
  canvas.parentElement.addEventListener('blur', () => { if (held.size) { held.clear(); axes(); apply(); } }, true);
  setInterval(() => {
    if (!visible || !held.size) return;
    if (held.has('w')) sticks.L.y = clamp(sticks.L.y + 0.02, -1, 1);
    if (held.has('s')) sticks.L.y = clamp(sticks.L.y - 0.02, -1, 1);
    axes(); apply();
  }, 40);
  btnReset.onclick = () => { sim.drone?.reset(); draw(); };
  btnCharge.onclick = () => { for (const b of sim.behaviors || []) b.recharge?.(); draw(); };

  // ---------------------------------------------------------------- 3D view (chase camera, world z up)
  function draw() {
    const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, Hh = canvas.clientHeight;
    if (!W || !Hh) return;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(Hh * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
    const sky = g.createLinearGradient(0, 0, 0, Hh); sky.addColorStop(0, dark ? '#1b2333' : '#cfe3f7'); sky.addColorStop(1, dark ? '#273041' : '#eef4fa');
    g.fillStyle = sky; g.fillRect(0, 0, W, Hh);
    const d = sim.drone;
    note.hidden = !!d;
    if (!d) { hud(['Tambahkan "Frame Drone Quadcopter X" ke rangkaian untuk simulasi terbang.', 'Motor, ESC, baterai dan receiver tetap bisa diuji di meja tanpa frame.'], W); return; }
    const s = d.state, F = d.frame, arm = F.L / Math.SQRT2;
    const scale = F.L < 0.1 ? 4 : 1;                                     // mini drone: draw 4x larger
    const P = s.p, tgt = [P[0], P[1], P[2] * 1 + 0.15 * scale];
    const cam = [tgt[0] - 2.1 * scale, tgt[1] - 0.9 * scale, tgt[2] + 1.0 * scale];
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const nrm = (a) => { const n = Math.hypot(...a); return a.map((x) => x / n); };
    const f = nrm(sub(tgt, cam)), r = nrm(cross(f, [0, 0, 1])), u = cross(r, f), FOC = Math.min(W, Hh) * 1.35;
    const proj = (p) => { const q = sub(p, cam), z = dot(q, f); if (z < 0.05) return null; return [W / 2 + dot(q, r) / z * FOC, Hh / 2 - dot(q, u) / z * FOC, z]; };
    const line = (a, b, col, w = 1) => { const A = proj(a), B = proj(b); if (!A || !B) return; g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke(); };
    // ground grid (1 m; 0.25 m for the mini drone)
    const step = scale > 1 ? 0.25 : 1, n = 16, cx = Math.round(P[0] / step) * step, cy = Math.round(P[1] / step) * step;
    g.fillStyle = dark ? '#1f3326' : '#cfe8cf';
    const hz = proj([cam[0] + 200 * f[0], cam[1] + 200 * f[1], 0]);
    if (hz) g.fillRect(0, hz[1], W, Hh - hz[1]);
    for (let i = -n; i <= n; i++) {
      const col = dark ? '#2f4a37' : '#b2d4b2';
      line([cx + i * step, cy - n * step, 0], [cx + i * step, cy + n * step, 0], col);
      line([cx - n * step, cy + i * step, 0], [cx + n * step, cy + i * step, 0], col);
    }
    line([0, 0, 0], [1 * step * 2, 0, 0], '#ef4444', 2); line([0, 0, 0], [0, 2 * step, 0], '#22c55e', 2);       // origin: x (depan) merah, y (kiri) hijau
    // shadow + height line
    const sh = proj([P[0], P[1], 0]);
    if (sh) { g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(sh[0], sh[1], Math.max(4, F.L * 1.4 * FOC / sh[2]), Math.max(2, F.L * 0.5 * FOC / sh[2]), 0, 0, 7); g.fill(); }
    g.setLineDash([4, 4]); line([P[0], P[1], 0], P, dark ? '#94a3b8' : '#64748b'); g.setLineDash([]);
    // drone: body axes -> world
    const [w, x, y, z] = s.q;
    const Rm = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
    const W3 = (b) => [P[0] + (Rm[0][0] * b[0] + Rm[0][1] * b[1] + Rm[0][2] * b[2]) * scale, P[1] + (Rm[1][0] * b[0] + Rm[1][1] * b[1] + Rm[1][2] * b[2]) * scale, P[2] + (Rm[2][0] * b[0] + Rm[2][1] * b[1] + Rm[2][2] * b[2]) * scale + 0.04 * scale];
    const prop = d.slots ? d.slots() : [];
    SLOTS.forEach((sl, i) => {
      const c = [sl.x * arm, sl.y * arm, 0];
      line(W3([0, 0, 0]), W3(c), dark ? '#cbd5e1' : '#334155', 4);
      const m = s.motors?.[i], spin = m ? Math.min(1, m.rpm / 6000) : 0, pr = (prop[i]?.rotor.prop?.D || F.L * 0.9) / 2;
      const pts = []; for (let k = 0; k <= 20; k++) { const a = k / 20 * 2 * Math.PI; pts.push(proj(W3([c[0] + pr * Math.cos(a), c[1] + pr * Math.sin(a), 0.01]))); }
      if (pts.every(Boolean)) {
        g.fillStyle = sl.x > 0 ? `rgba(239,68,68,${0.15 + 0.35 * spin})` : `rgba(100,116,139,${0.15 + 0.35 * spin})`;
        g.strokeStyle = m && !m.okDir && m.rpm > 300 ? '#f59e0b' : sl.x > 0 ? '#ef4444' : '#64748b'; g.lineWidth = 1.2;
        g.beginPath(); pts.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.fill(); g.stroke();
      }
      const lp = proj(W3([c[0], c[1], 0.03]));
      if (lp) { g.fillStyle = dark ? '#e2e8f0' : '#0f172a'; g.font = '600 11px system-ui'; g.fillText(`M${i + 1}`, lp[0] - 8, lp[1] - 8); }
    });
    const bodyPts = [[0.06, 0.06], [0.06, -0.06], [-0.06, -0.06], [-0.06, 0.06]].map(([a, b]) => proj(W3([a * F.L / 0.225, b * F.L / 0.225, 0.02])));
    if (bodyPts.every(Boolean)) { g.fillStyle = '#111827'; g.beginPath(); bodyPts.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.fill(); }
    line(W3([0, 0, 0.02]), W3([arm * 0.9, 0, 0.02]), '#ef4444', 3);                                   // nose
    // HUD
    const e = euler(s.q), bat = (sim.behaviors || []).find((b) => b.soc !== undefined && b.cells);
    const escs = (sim.behaviors || []).filter((b) => b._part?.type === 'mod-esc');
    const armed = escs.filter((x) => x.armed).length;
    const lines = [
      s.crashed ? `💥 JATUH — ${s.crashText}. Tekan "Reset drone".` : `Ketinggian ${s.p[2].toFixed(2)} m · naik ${s.v[2].toFixed(2)} m/s · kecepatan ${Math.hypot(s.v[0], s.v[1]).toFixed(1)} m/s`,
      `Roll ${e[0].toFixed(1)}° · Pitch ${e[1].toFixed(1)}° · Yaw ${e[2].toFixed(0)}°  (x ${s.p[0].toFixed(1)} m, y ${s.p[1].toFixed(1)} m)`,
      `Gaya dorong ${(s.thrust / 9.80665 * 1000).toFixed(0)} g / berat ${(d.mass * 1000).toFixed(0)} g${bat ? ` · Baterai ${bat.V.toFixed(2)} V ${Math.round(bat.soc * 100)} % · ${bat.I.toFixed(1)} A` : ''}`,
      (s.motors || []).map((m, i) => (m ? `M${i + 1} ${Math.round(m.rpm)}` : `M${i + 1} —`)).join('  ') + ' rpm' + (escs.length ? ` · ESC armed ${armed}/${escs.length}` : ''),
    ];
    hud(lines, W, s.crashed);
    // attitude indicator
    const R0 = 34, ax = W - R0 - 12, ay = Hh - R0 - 12, rr = -e[0] * Math.PI / 180, pp = e[1] / 45 * R0;
    g.save(); g.beginPath(); g.arc(ax, ay, R0, 0, 7); g.clip();
    g.translate(ax, ay); g.rotate(rr); g.fillStyle = '#60a5fa'; g.fillRect(-R0 * 2, -R0 * 2 + pp, R0 * 4, R0 * 2); g.fillStyle = '#a16207'; g.fillRect(-R0 * 2, pp, R0 * 4, R0 * 2);
    g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(-R0, pp); g.lineTo(R0, pp); g.stroke(); g.restore();
    g.strokeStyle = '#facc15'; g.lineWidth = 2; g.beginPath(); g.moveTo(ax - 16, ay); g.lineTo(ax - 5, ay); g.moveTo(ax + 5, ay); g.lineTo(ax + 16, ay); g.stroke();
    g.strokeStyle = dark ? '#cbd5e1' : '#334155'; g.lineWidth = 1; g.beginPath(); g.arc(ax, ay, R0, 0, 7); g.stroke();
  }
  function hud(lines, W, warn) {
    g.font = '12px ui-monospace, Menlo, monospace';
    const h = 8 + lines.length * 16, w = Math.min(W - 16, Math.max(...lines.map((l) => g.measureText(l).width)) + 16);
    g.fillStyle = 'rgba(15,23,42,.62)'; g.fillRect(8, 8, w, h);
    lines.forEach((l, i) => { g.fillStyle = warn && i === 0 ? '#fca5a5' : '#f8fafc'; g.fillText(l, 16, 22 + i * 16); });
  }
  sim.on('tick', () => { if (visible) draw(); });
  apply();
  return {
    show(v) { visible = v; if (v) { requestAnimationFrame(draw); apply(); } },
    draw,
  };
}
