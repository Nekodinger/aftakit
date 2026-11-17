// PCB view: turns the circuit into a 2-layer PCB, lets the user arrange the parts, auto-routes and exports
// fabrication files (Gerber + drill + BOM in one zip, ready to upload to a PCB fab).
import { makeBoard, route, drc, exportFiles, zip, padPos, bodyBox, fitOutline, compact, RULES } from '../pcb/pcb.js';
import { textStrokes } from '../pcb/font.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initPcb({ canvas, host, catalog, check, toast, projectName }) {
  host.innerHTML = `
    <canvas class="pcb-cv"></canvas>
    <div class="pcb-side">
      <div class="pcb-head"><b>Desain PCB</b><span class="pcb-size"></span></div>
      <div class="pcb-check"></div>
      <div class="pcb-actions">
        <button class="btn primary" data-p="route">Rute otomatis</button>
        <button class="btn" data-p="place">Atur ulang posisi</button>
        <button class="btn" data-p="rot" disabled>Putar komponen</button>
      </div>
      <div class="pcb-layers"><label><input type="checkbox" data-l="top" checked> Tembaga atas</label><label><input type="checkbox" data-l="bot" checked> Tembaga bawah</label><label><input type="checkbox" data-l="silk" checked> Sablon</label><label><input type="checkbox" data-l="rat" checked> Garis rat's nest</label></div>
      <div class="pcb-stats"></div>
      <div class="pcb-drc"></div>
      <div class="pcb-export">
        <button class="btn primary" data-p="gerber">Unduh Gerber (.zip) siap cetak</button>
        <button class="btn" data-p="svg">Unduh gambar PCB (.svg)</button>
      </div>
      <p class="muted small">Seret komponen untuk memindah (jalur dihapus, tekan <b>Rute otomatis</b> lagi). Ketuk lalu <b>Putar</b> untuk memutar 90°. Scroll / cubit untuk zoom, seret area kosong untuk menggeser. Modul & board mikrokontroler dipasang lewat female header di posisi pin aslinya.</p>
    </div>
    <button class="pcb-close btn" title="Kembali ke 2D">✕ Tutup PCB</button>`;
  const cv = host.querySelector('.pcb-cv'), ctx = cv.getContext('2d');
  let board = null, open = false, view = { s: 6, x: 20, y: 20 }, sel = null, layers = { top: true, bot: true, silk: true, rat: true };

  // ---------------------------------------------------------------- model
  function srcParts() {
    return [...canvas.parts.values()].map((p) => ({ id: p.id, type: p.type, left: p.left, top: p.top, rot: p.rot, size: p.size, pinInfo: p.pinInfo, attrs: p.attrs }));
  }
  function build(keepLayout = true) {
    board = makeBoard({ parts: srcParts(), wires: canvas.wires.map((w) => ({ a: w.a, b: w.b })), catalog, layout: keepLayout ? canvas.pcbLayout : null });
    saveLayout(false);
  }
  function saveLayout(emit = true) {
    if (!board) return;
    canvas.pcbLayout = { comps: Object.fromEntries(board.comps.map((c) => [c.id, [+c.x.toFixed(2), +c.y.toFixed(2), c.rot]])) };
    if (emit) canvas.emit('change', { structural: false });
  }
  function doRoute() {
    if (!board) return;
    host.classList.add('busy'); renderSide('Merutekan jalur…');
    setTimeout(() => {
      const t0 = performance.now(); route(board); board.ms = Math.round(performance.now() - t0);
      host.classList.remove('busy'); draw(); renderSide();
      toast?.(board.unrouted.length ? `Rute selesai, ${board.unrouted.length} sambungan belum bisa dirutekan — geser komponen agar lebih lega lalu coba lagi.` : `Semua ${board.stats.nets} net berhasil dirutekan (${board.vias.length} via).`, !!board.unrouted.length);
    }, 30);
  }

  // ---------------------------------------------------------------- side panel
  function renderSide(busy) {
    const side = host.querySelector('.pcb-side');
    side.querySelector('.pcb-size').textContent = board ? `${board.w.toFixed(1)} × ${board.h.toFixed(1)} mm · ${board.comps.length} komponen` : '';
    const res = check?.() || [], err = res.filter((r) => r.level === 'error'), warn = res.filter((r) => r.level === 'warn');
    side.querySelector('.pcb-check').innerHTML = err.length ? `<div class="pcb-bad">✕ Rangkaian belum benar (${err.length} masalah). Perbaiki di 2D dulu: ${esc(err[0].text)}</div>` : warn.length ? `<div class="pcb-warn">! Rangkaian bisa dipakai, ${warn.length} peringatan (lihat Periksa).</div>` : '<div class="pcb-ok">✓ Pemeriksaan rangkaian lulus.</div>';
    const st = board?.stats;
    side.querySelector('.pcb-stats').innerHTML = busy ? `<div class="pcb-busy">${esc(busy)}</div>` : board?.routed
      ? `<div><b>${st.nets - st.failed}/${st.nets}</b> net tersambung · ${st.vias} via · panjang jalur ${st.length} mm${board.ms ? ` · ${board.ms} ms` : ''}</div>`
      : `<div>${board ? board.nets.length : 0} net belum dirutekan. Tekan <b>Rute otomatis</b>.</div>`;
    const issues = board?.routed ? drc(board) : [];
    side.querySelector('.pcb-drc').innerHTML = board?.routed ? (issues.length ? `<div class="pcb-bad">DRC: ${issues.length} masalah</div><ul>${issues.slice(0, 8).map((i) => `<li>${esc(i.msg)}</li>`).join('')}</ul>` : '<div class="pcb-ok">✓ DRC lulus: semua net tersambung, clearance ≥ 0,2 mm.</div>') : '';
    side.querySelector('[data-p=rot]').disabled = !sel;
    side.querySelector('[data-p=gerber]').disabled = !board?.routed;
  }

  // ---------------------------------------------------------------- drawing
  const S = (x, y) => [view.x + x * view.s, view.y + y * view.s];
  function fit() {
    if (!board) return; const r = cv.getBoundingClientRect(), side = 300;
    const W = Math.max(200, r.width - side - 40), H = r.height - 80;
    view.s = Math.min(W / board.w, H / board.h); view.x = 20 + (W - board.w * view.s) / 2; view.y = 50 + (H - board.h * view.s) / 2;
  }
  function draw() {
    const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#20242c'; ctx.fillRect(0, 0, r.width, r.height);
    if (!board) return;
    const s = view.s, [bx, by] = S(0, 0);
    // board
    ctx.fillStyle = '#1f6a3c'; roundRect(bx, by, board.w * s, board.h * s, 1 * s); ctx.fill();
    ctx.strokeStyle = '#e6c84b'; ctx.lineWidth = 1.5; ctx.stroke();
    const trace = (t, color) => { ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, t.w * s); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); t.pts.forEach((p, i) => { const [x, y] = S(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };
    if (layers.bot) for (const t of board.traces) if (t.layer === 1) trace(t, 'rgba(70,140,230,.9)');
    if (layers.top) for (const t of board.traces) if (t.layer === 0) trace(t, 'rgba(225,80,60,.92)');
    // pads, vias, holes
    for (const c of board.comps) for (const p of c.pads) {
      const q = padPos(c, p), [x, y] = S(q.x, q.y), d = p.d * s;
      ctx.fillStyle = '#d6b14a'; if (p.sq) ctx.fillRect(x - d / 2, y - d / 2, d, d); else { ctx.beginPath(); ctx.arc(x, y, d / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#20242c'; ctx.beginPath(); ctx.arc(x, y, (p.drill * s) / 2, 0, Math.PI * 2); ctx.fill();
    }
    for (const v of board.vias) { const [x, y] = S(v.x, v.y); ctx.fillStyle = '#d6b14a'; ctx.beginPath(); ctx.arc(x, y, (RULES.via * s) / 2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#20242c'; ctx.beginPath(); ctx.arc(x, y, (RULES.viaDrill * s) / 2, 0, Math.PI * 2); ctx.fill(); }
    for (const h of board.holes) { const [x, y] = S(h.x, h.y); ctx.fillStyle = '#20242c'; ctx.beginPath(); ctx.arc(x, y, (h.d * s) / 2, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#d6b14a55'; ctx.stroke(); }
    // silkscreen
    if (layers.silk) {
      ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = Math.max(0.8, 0.15 * s);
      for (const c of board.comps) {
        const b = bodyBox(c, 0.4), [x0, y0] = S(b.x0, b.y0), [x1, y1] = S(b.x1, b.y1);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        const th = Math.min(1.2, Math.max(0.8, (b.x1 - b.x0) / Math.max(4, c.id.length) / 1.1));
        strokes(textStrokes(c.id, b.x0 + 0.3, b.y0 - th - 0.4 < 0.5 ? b.y0 + 0.4 : b.y0 - th - 0.4, th));
        if (c.kind === 'conn') c.pads.forEach((p) => { const q = padPos(c, p), lab = p.name.slice(0, 4); strokes(textStrokes(lab, q.x - lab.length * 0.33, b.y1 + 0.5, 0.7)); });
      }
      strokes(textStrokes((projectName?.() || 'aftakit').toUpperCase().slice(0, 24), 2, board.h - 2.6, 1.2));
    }
    // rat's nest: unrouted connections (all of them before routing)
    if (layers.rat) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 1.2;
      const lines = board.routed ? board.unrouted.map((u) => [u.a, u.b]) : ratsnest();
      for (const [a, b] of lines) { const [x0, y0] = S(a[0], a[1]), [x1, y1] = S(b[0], b[1]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (sel) { const c = board.comps.find((x) => x.id === sel); if (c) { const b = bodyBox(c, 0.8), [x0, y0] = S(b.x0, b.y0), [x1, y1] = S(b.x1, b.y1); ctx.strokeStyle = '#7aa7ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); } }
    function strokes(list) { ctx.beginPath(); for (const l of list) l.forEach((p, i) => { const [x, y] = S(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); }
    function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  }
  function ratsnest() {
    const out = [];
    for (const n of board.nets) {
      const ps = n.pads.map((q) => { const c = board.comps.find((x) => x.id === q.comp), p = c?.pads.find((x) => x.name === q.pad); return c && p ? padPos(c, p) : null; }).filter(Boolean);
      const inT = [ps[0]], rest = ps.slice(1);
      while (rest.length) { let bi = 0, bt = inT[0], bd = Infinity; rest.forEach((p, i) => inT.forEach((t) => { const d = Math.hypot(p.x - t.x, p.y - t.y); if (d < bd) { bd = d; bi = i; bt = t; } })); const p = rest.splice(bi, 1)[0]; out.push([[p.x, p.y], [bt.x, bt.y]]); inT.push(p); }
    }
    return out;
  }

  // ---------------------------------------------------------------- interaction
  const toBoard = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.s, y: (e.clientY - r.top - view.y) / view.s }; };
  let drag = null; const touches = new Map(); let pinch = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture?.(e.pointerId);
    if (e.pointerType === 'touch') { touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: view.x, vy: view.y }; drag = null; return; } }
    const p = toBoard(e);
    const hit = board?.comps.slice().reverse().find((c) => { const b = bodyBox(c); return p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1; });
    if (hit) { sel = hit.id; drag = { kind: 'comp', c: hit, x0: hit.x, y0: hit.y, px: p.x, py: p.y, moved: false }; }
    else { sel = null; drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; }
    renderSide(); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()], r = cv.getBoundingClientRect(), k = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, ns = Math.max(1, Math.min(60, pinch.s * k));
      const cx = pinch.cx - r.left, cy = pinch.cy - r.top; view.x = cx - ((cx - pinch.vx) * ns) / pinch.s; view.y = cy - ((cy - pinch.vy) * ns) / pinch.s; view.s = ns; draw(); return;
    }
    if (!drag) return;
    if (drag.kind === 'pan') { view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy; draw(); return; }
    const p = toBoard(e), dx = p.x - drag.px, dy = p.y - drag.py;
    if (!drag.moved && Math.hypot(dx, dy) * view.s < 4) return;
    if (!drag.moved) { drag.moved = true; board.traces = []; board.vias = []; board.unrouted = []; board.routed = false; }
    drag.c.x = Math.round((drag.x0 + dx) / 0.635) * 0.635; drag.c.y = Math.round((drag.y0 + dy) / 0.635) * 0.635; draw();
  });
  const up = (e) => {
    touches.delete(e.pointerId); if (pinch && touches.size < 2) pinch = null;
    if (drag?.kind === 'comp' && drag.moved) { refit(); saveLayout(); renderSide(); }
    drag = null; draw();
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); const r = cv.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top, ns = Math.max(1, Math.min(60, view.s * Math.exp(-e.deltaY * 0.0015)));
    view.x = cx - ((cx - view.x) * ns) / view.s; view.y = cy - ((cy - view.y) * ns) / view.s; view.s = ns; draw();
  }, { passive: false });
  function refit() {                                           // keep the outline tight around the parts (board origin stays top-left)
    const before = { x: board.comps[0]?.x, y: board.comps[0]?.y };
    fitOutline(board);
    const after = { x: board.comps[0]?.x, y: board.comps[0]?.y };
    view.x -= (after.x - before.x) * view.s; view.y -= (after.y - before.y) * view.s;
  }
  host.querySelector('.pcb-side').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const a = b.dataset.p;
    if (a === 'route') doRoute();
    else if (a === 'place') { build(false); compact(board.comps); fitOutline(board); saveLayout(); fit(); draw(); renderSide(); doRoute(); }
    else if (a === 'rot' && sel) { const c = board.comps.find((x) => x.id === sel); c.rot = (c.rot + 1) & 3; board.traces = []; board.vias = []; board.unrouted = []; board.routed = false; refit(); saveLayout(); draw(); renderSide(); }
    else if (a === 'gerber') downloadZip();
    else if (a === 'svg') downloadSvg();
  });
  host.querySelector('.pcb-layers').addEventListener('change', (e) => { const l = e.target.dataset.l; if (l) { layers[l] = e.target.checked; draw(); } });
  host.querySelector('.pcb-close').onclick = () => api.close();
  window.addEventListener('keydown', (e) => {
    if (!open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === 'Escape') { api.close(); e.stopImmediatePropagation(); }
    else if (e.key.toLowerCase() === 'r' && sel && !e.ctrlKey && !e.metaKey) { host.querySelector('[data-p=rot]').click(); e.stopImmediatePropagation(); e.preventDefault(); }
    else if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation();
  }, true);
  new ResizeObserver(() => { if (open) draw(); }).observe(host);

  // ---------------------------------------------------------------- export
  const fname = () => (projectName?.() || 'aftakit').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'aftakit';
  function downloadZip() {
    if (!board?.routed) return;
    const files = exportFiles(board, fname()); files[`${fname()}-preview.svg`] = toSvg();
    save(zip(files), `${fname()}-gerber.zip`);
    toast?.(board.unrouted.length ? `Gerber diunduh, tetapi ${board.unrouted.length} sambungan belum dirutekan — sambung dengan kabel jumper atau rutekan ulang.` : 'Gerber siap cetak diunduh (unggah zip ini ke JLCPCB / PCBWay, 2 layer, 1,6 mm).', !!board.unrouted.length);
  }
  function downloadSvg() { save(new Blob([toSvg()], { type: 'image/svg+xml' }), `${fname()}-pcb.svg`); }
  function save(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); }
  function toSvg() {
    const W = board.w, H = board.h, o = [];
    o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="1" fill="#1f6a3c"/>`);
    const path = (t, col) => `<polyline points="${t.pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${col}" stroke-width="${t.w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    for (const t of board.traces) if (t.layer === 1) o.push(path(t, '#468ce6'));
    for (const t of board.traces) if (t.layer === 0) o.push(path(t, '#e1503c'));
    for (const c of board.comps) for (const p of c.pads) { const q = padPos(c, p); o.push(p.sq ? `<rect x="${q.x - p.d / 2}" y="${q.y - p.d / 2}" width="${p.d}" height="${p.d}" fill="#d6b14a"/>` : `<circle cx="${q.x}" cy="${q.y}" r="${p.d / 2}" fill="#d6b14a"/>`, `<circle cx="${q.x}" cy="${q.y}" r="${p.drill / 2}" fill="#222"/>`); }
    for (const v of board.vias) o.push(`<circle cx="${v.x}" cy="${v.y}" r="${RULES.via / 2}" fill="#d6b14a"/><circle cx="${v.x}" cy="${v.y}" r="${RULES.viaDrill / 2}" fill="#222"/>`);
    for (const h of board.holes) o.push(`<circle cx="${h.x}" cy="${h.y}" r="${h.d / 2}" fill="#222"/>`);
    const sil = []; for (const c of board.comps) { const b = bodyBox(c, 0.4); o.push(`<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" stroke="#fff" stroke-width="0.15"/>`); const th = Math.min(1.2, Math.max(0.8, (b.x1 - b.x0) / Math.max(4, c.id.length) / 1.1)); sil.push(...textStrokes(c.id, b.x0 + 0.3, b.y0 - th - 0.4 < 0.5 ? b.y0 + 0.4 : b.y0 - th - 0.4, th)); }
    for (const l of sil) o.push(`<polyline points="${l.map((p) => p.map((v) => v.toFixed(3)).join(',')).join(' ')}" fill="none" stroke="#fff" stroke-width="0.15" stroke-linecap="round"/>`);
    o.push('</svg>'); return o.join('\n');
  }

  const api = {
    get isOpen() { return open; },
    get board() { return board; },
    open() {
      open = true; host.hidden = false; sel = null; build(true);
      requestAnimationFrame(() => { fit(); draw(); renderSide(); if (!board.routed && board.nets.length) doRoute(); });
      api.onToggle?.(true);
    },
    close() { open = false; host.hidden = true; api.onToggle?.(false); },
    toggle() { return open ? api.close() : api.open(); },
    route: doRoute, files: () => exportFiles(board, fname()),
  };
  return api;
}
