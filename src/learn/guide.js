// Newbie mode: a step-by-step tutor for the circuit in the workspace.
//   1. Rangkai — every connection, one at a time: which pin goes where and why, wire colours, how to tidy the
//      wires on the breadboard; the two pins of the current step glow on the canvas and the step ticks itself off
//      as soon as the wire exists (any suitable MCU pin is accepted).
//   2. Kode — the sketch is built up component by component: what to type, what each line does.
//   3. Uji — how to test every component in the simulator (and what the Serial Monitor should show).
import { planWiring, connected } from './autowire.js';
import { readCircuit, generateSketch } from './autocode.js';
import { wiringState, compsOf } from '../ui/pinmap.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pidOf = (r) => r.slice(0, r.lastIndexOf(':')), pinOf = (r) => r.slice(r.lastIndexOf(':') + 1);

export function initGuide({ canvas, catalog, host, editor, act }) {
  let on = false, phase = 'wire', idx = 0, plan = null, planKey = '', sketchParts = [], refreshT = 0;
  const doneManual = new Set(), advanced = new Set();
  host.innerHTML = `<header><span class="gd-cap">🎓</span><b>Mode Newbie</b><span class="gd-sub"></span><button class="gd-min" title="Perkecil">–</button><button class="gd-x" title="Matikan mode Newbie">✕</button></header>
    <nav class="gd-tabs"><button data-ph="wire">1 · Rangkai</button><button data-ph="code">2 · Kode</button><button data-ph="test">3 · Uji</button></nav>
    <div class="gd-prog"><i></i></div><div class="gd-body"></div><footer class="gd-foot"></footer>`;
  const body = host.querySelector('.gd-body'), foot = host.querySelector('.gd-foot'), sub = host.querySelector('.gd-sub');
  host.querySelector('.gd-x').onclick = () => api.toggle(false);
  host.querySelector('.gd-min').onclick = () => host.classList.toggle('min');
  host.querySelectorAll('[data-ph]').forEach((b) => (b.onclick = () => { phase = b.dataset.ph; idx = 0; render(); }));

  // ---------------------------------------------------------------- steps of each phase
  const mcu = () => [...canvas.parts.values()].find((p) => catalog[p.type]?.board || catalog[p.type]?.cat === 'Mikrokontroler');
  const comps = () => { const m = mcu(); return m ? compsOf(canvas, catalog, m) : [...canvas.parts.values()].filter((p) => !/breadboard/.test(p.type)); };
  const label = (ref) => { const p = canvas.parts.get(pidOf(ref)); const i = p?.pinInfo.find((x) => x.name === pinOf(ref)); return p && i ? `${p.id}.${canvas.pinLabel(p, i)}` : ref; };
  const gpioOf = (ref) => { const p = canvas.parts.get(pidOf(ref)), g = catalog[p?.type]?.gpio?.[pinOf(ref)]; return typeof g === 'number' ? ` (GPIO${g})` : ''; };

  function wireSteps() {
    const steps = [];
    const m = mcu();
    steps.push({ id: 'mcu', title: 'Pilih otak rangkaian (mikrokontroler)', html: `<p>Setiap proyek butuh satu mikrokontroler, misalnya <b>ESP32 DevKit</b> (WiFi) atau <b>Arduino Uno</b>. Tambahkan dari panel <b>Komponen</b> → kelompok Mikrokontroler.</p>`, done: () => !!mcu() });
    steps.push({ id: 'comp', title: 'Tambahkan sensor / komponen', html: `<p>Tambahkan komponen yang ingin dipakai (sensor ultrasonik, DHT22, LED, servo …) dari panel <b>Komponen</b>. Panduan langkah berikutnya menyesuaikan komponen yang ada di workspace.</p>${comps().length ? `<p class="gd-ok">Sudah ada: ${esc(comps().map((p) => p.id).join(', '))}</p>` : ''}`, done: () => comps().length > 0 });
    const key = [...canvas.parts.keys()].sort().join(',');
    if (key !== planKey) { plan = null; planKey = key; }
    if (m && !plan) plan = planWiring(canvas, catalog);
    const bb = [...canvas.parts.values()].some((p) => /breadboard/.test(p.type));
    steps.push({ id: 'bb', title: 'Siapkan breadboard (opsional, disarankan)', html: `<p>Breadboard membuat rangkaian rapi dan mudah dianalisis:</p><ul><li><b>Lubang 1 kolom (a–e / f–j) tersambung vertikal</b>: satu kolom = satu titik sambungan.</li><li><b>Rel + (merah) dan − (biru)</b> di tepi untuk daya dan GND, dipakai bersama banyak komponen.</li><li>Tancapkan kaki sensor di kolom yang berbeda-beda agar tidak korslet.</li></ul>`, done: () => bb || doneManual.has('bb'), skip: true, action: bb ? null : ['Pasang di breadboard sekarang', async () => { await act.autobb(); doneManual.add('bb'); }] });
    for (const s of plan?.steps || []) {
      const t = s.mcu === false ? `Sambungkan ${label(s.a)} → ${label(s.b)}` : `Sambungkan ${label(s.b)} → ${label(s.a)}${gpioOf(s.a)}`;
      steps.push({
        id: s.a + '>' + s.b, title: t, wire: s,
        html: `<p>${esc(s.reason)}</p><p class="gd-tip"><span class="gd-sw" style="background:${s.color}"></span>${esc(s.tip)}</p>
          <p class="gd-how"><b>Cara:</b> ketuk pin <b>${esc(label(s.b))}</b> (titik kuning berkedip), lalu ketuk pin <b>${esc(label(s.a))}</b>. Kabel otomatis dibuat bersiku. Kalau komponen tertancap di breadboard, kamu juga boleh menyambung dari lubang di kolom yang sama.</p>`,
        done: () => connected(canvas, s.a, s.b) || altDone(s),
      });
    }
    steps.push({ id: 'tidy', title: 'Rapikan kabel', html: `<p>Kabel yang rapi memudahkan mencari kesalahan:</p><ul><li>Tarik kabel lurus dan <b>bersiku</b> (horizontal / vertikal), jangan menyilang di atas chip.</li><li>Kabel searah dikumpulkan jadi satu <b>bundel</b> dan diikat.</li><li>Merah = VCC, hitam = GND, warna lain untuk sinyal.</li></ul>`, done: () => doneManual.has('tidy'), action: ['Rapikan & bundel kabel', () => { act.bundle(); doneManual.add('tidy'); }], skip: true });
    steps.push({ id: 'check', title: 'Periksa rangkaian', html: `<p>Sebelum menulis kode, pastikan tidak ada kesalahan wiring (korsleting, VCC/GND tertukar, pin salah).</p><div class="gd-check"></div>`, done: () => { const r = act.check(); return !r.some((x) => x.level === 'error'); }, onShow: (el) => { const r = act.check().filter((x) => x.level === 'error' || x.level === 'warn'); el.querySelector('.gd-check').innerHTML = r.length ? r.map((x) => `<div class="gd-iss ${x.level}">${x.level === 'error' ? '✕' : '!'} ${esc(x.text)}</div>`).join('') : '<p class="gd-ok">✓ Tidak ada kesalahan wiring.</p>'; } });
    return steps;
  }
  /** the student used another MCU pin for this component pin: fine when it is connected to the board at all */
  function altDone(s) {
    if (s.mcu === false) return false;
    const m = mcu(); if (!m) return false;
    const st = wiringState(canvas, m, comps()); const w = st.where.get(s.b);
    if (!w) return false; if (['power', 'gnd'].includes(s.role)) return false;
    s.alt = w.replace('*', ''); return true;
  }

  function codeSteps() {
    const circ = readCircuit(canvas, catalog); if (!circ) return [{ id: 'nomcu', title: 'Belum ada mikrokontroler', html: '<p>Tambahkan mikrokontroler dan selesaikan tahap Rangkai dulu.</p>', done: () => false }];
    const g = generateSketch(circ); sketchParts = g.parts.filter((p) => p.piece);
    const steps = [{ id: 'skel', title: 'Kerangka program: setup() dan loop()', html: `<p>Program Arduino selalu punya dua bagian:</p><ul><li><code>setup()</code> dijalankan <b>sekali</b> saat board menyala: mengatur pin dan memulai sensor.</li><li><code>loop()</code> dijalankan <b>berulang terus</b>: membaca sensor dan mengendalikan keluaran.</li></ul><p><code>Serial.begin(115200)</code> membuka Serial Monitor agar hasil bisa dilihat.</p>${block('void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n}')}`, done: () => /Serial\.begin/.test(editor.value) && /void\s+loop/.test(editor.value), code: () => generateSketch({ ...circ, items: [] }).code }];
    sketchParts.forEach((p, k) => {
      const pc = p.piece, items = circ.items.filter((it) => sketchParts.slice(0, k + 1).some((q) => q.id === it.id));
      const key = (pc.loop.find((l) => !l.startsWith('//')) || pc.glob[pc.glob.length - 1] || '').trim();
      steps.push({
        id: 'code-' + p.id, title: `Kode untuk ${p.name} (${p.id})`,
        html: `<p>${esc(pc.explain)}</p>
          ${pc.inc.length ? `<h5>1. Library (paling atas)</h5>${block(pc.inc.join('\n'))}` : ''}
          <h5>${pc.inc.length ? 2 : 1}. Pin & objek (di atas setup)</h5>${block(pc.glob.join('\n'))}
          ${pc.setup.length ? `<h5>${pc.inc.length ? 3 : 2}. Di dalam setup()</h5>${block(pc.setup.join('\n'))}` : ''}
          <h5>Di dalam loop()</h5>${block(pc.loop.join('\n'))}
          <p class="gd-how">Ketik sendiri di editor (tab <b>Kode</b>) agar terbiasa, atau tekan <b>Tempel ke editor</b> untuk menyusun program sampai komponen ini.</p>`,
        done: () => !!key && editor.value.replace(/\s+/g, ' ').includes(key.replace(/\s+/g, ' ')), code: () => generateSketch({ ...circ, items }).code,
      });
    });
    for (const p of g.parts.filter((x) => x.todo)) steps.push({ id: 'todo-' + p.id, title: `${p.name}: lengkapi sambungannya`, html: `<p>${esc(p.todo.replace(/^\/\/ /, ''))}</p>`, done: () => false, skip: true });
    steps.push({ id: 'run', title: 'Kompilasi & jalankan', html: '<p>Tekan <b>Jalankan</b> (▶). Bila ada galat, baris yang salah ditandai di editor; klik pesan di Log untuk melompat ke barisnya. Galat paling umum: lupa titik koma <code>;</code>, kurung kurawal <code>{ }</code> tidak berpasangan, atau salah ketik nama variabel.</p>', done: () => act.running(), action: ['Jalankan ▶', () => act.run()] });
    return steps;
  }

  function testSteps() {
    const circ = readCircuit(canvas, catalog); if (!circ) return [];
    const g = generateSketch(circ);
    const steps = [{ id: 'trun', title: 'Jalankan simulasi & buka Serial Monitor', html: '<p>Tekan <b>Jalankan</b>, lalu buka tab <b>Serial Monitor</b> di bawah. Setiap komponen akan diuji satu per satu.</p>', done: () => act.running(), action: ['Jalankan ▶', () => act.run()] }];
    for (const p of g.parts.filter((x) => x.piece)) {
      steps.push({ id: 'test-' + p.id, title: `Uji ${p.name} (${p.id})`, html: `<p>${esc(p.piece.test)}</p><p class="gd-how"><b>Kalau tidak bekerja:</b> buka <b>3D → Ukur</b> dan ketuk pin VCC (harus ±5 V / 3,3 V), GND (0 V) dan pin sinyal. Pin "mengambang" berarti kabelnya belum tersambung. Buka <b>Diagnosa</b> untuk daftar kesalahan.</p>`, done: () => doneManual.has('test-' + p.id), action: ['Sudah berhasil ✓', () => doneManual.add('test-' + p.id)], extra: ['Buka 3D', () => act.open3D()] });
    }
    steps.push({ id: 'fin', title: 'Selesai! 🎉', html: '<p>Rangkaian dan program sudah teruji. Coba kembangkan: ubah ambang, tambahkan LED peringatan, atau kirim data ke internet (contoh ESP32 IoT di menu Contoh). Simpan proyek lewat <b>Berkas → Simpan</b>.</p>', done: () => false, last: true });
    return steps;
  }
  const block = (code) => `<div class="gd-code"><pre>${esc(code)}</pre><button class="gd-copy" title="Salin">Salin</button></div>`;

  // ---------------------------------------------------------------- render
  let steps = [];
  function render() {
    if (!on) return;
    steps = phase === 'wire' ? wireSteps() : phase === 'code' ? codeSteps() : testSteps();
    host.querySelectorAll('[data-ph]').forEach((b) => b.classList.toggle('on', b.dataset.ph === phase));
    const doneN = steps.filter((s) => safe(s.done)).length;
    host.querySelector('.gd-prog i').style.width = (steps.length ? (doneN / steps.length) * 100 : 0) + '%';
    if (idx >= steps.length) idx = Math.max(0, steps.length - 1);
    const s = steps[idx]; sub.textContent = `${{ wire: 'Rangkai', code: 'Kode', test: 'Uji' }[phase]} · ${doneN}/${steps.length}`;
    const d = s && safe(s.done);
    body.innerHTML = `<ol class="gd-list">${steps.map((x, i) => `<li class="${i === idx ? 'cur' : ''} ${safe(x.done) ? 'ok' : ''}" data-i="${i}"><span>${safe(x.done) ? '✓' : i + 1}</span>${esc(x.title)}</li>`).join('')}</ol>
      ${s ? `<article class="gd-step ${d ? 'ok' : ''}"><h4>${d ? '✓ ' : ''}${esc(s.title)}</h4>${s.html}${s.wire?.alt ? `<p class="gd-ok">✓ Kamu memakai pin ${esc(s.wire.alt)}: tidak apa-apa, Kode otomatis akan menyesuaikan.</p>` : ''}</article>` : ''}`;
    s?.onShow?.(body);
    foot.innerHTML = `<button class="btn" data-f="prev" ${idx ? '' : 'disabled'}>‹ Kembali</button>
      ${s?.wire && !d ? '<button class="btn" data-f="doit">Sambungkan untukku</button>' : ''}
      ${s?.code ? '<button class="btn" data-f="paste">Tempel ke editor</button>' : ''}
      ${s?.action && !d ? `<button class="btn" data-f="act">${esc(s.action[0])}</button>` : ''}
      ${s?.extra ? `<button class="btn" data-f="extra">${esc(s.extra[0])}</button>` : ''}
      <span class="gd-sp"></span>
      ${idx < steps.length - 1 ? `<button class="btn primary" data-f="next">${d || s?.skip ? 'Lanjut ›' : 'Lewati ›'}</button>` : phase !== 'test' ? `<button class="btn primary" data-f="phase">${phase === 'wire' ? 'Ke tahap Kode ›' : 'Ke tahap Uji ›'}</button>` : ''}`;
    body.querySelectorAll('[data-i]').forEach((li) => (li.onclick = () => { idx = +li.dataset.i; render(); }));
    body.querySelectorAll('.gd-copy').forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.previousElementSibling.textContent).then(() => act.toast('Disalin.'), () => act.toast('Salin manual: pilih teks lalu Ctrl+C.')); }));
    const f = (k) => foot.querySelector(`[data-f=${k}]`);
    if (f('prev')) f('prev').onclick = () => { idx--; render(); };
    if (f('next')) f('next').onclick = () => { idx++; render(); };
    if (f('phase')) f('phase').onclick = () => { phase = phase === 'wire' ? 'code' : 'test'; idx = 0; if (phase === 'code') act.setMode('code'); render(); };
    if (f('doit')) f('doit').onclick = () => { const w = s.wire; canvas._addWire(w.a, w.b, w.color, true); canvas.emit('change', { structural: true }); };
    if (f('paste')) f('paste').onclick = () => { editor.value = s.code(); editor.onChange?.(); act.setMode('code'); act.toast('Kode ditempel ke editor.'); onChange(); };
    if (f('act')) f('act').onclick = async () => { await s.action[1](); render(); };
    if (f('extra')) f('extra').onclick = () => s.extra[1]();
    highlight(s);
  }
  const safe = (fn) => { try { return !!fn?.(); } catch { return false; } };
  function highlight(s) {
    document.querySelectorAll('.pin.guide-hl').forEach((p) => p.classList.remove('guide-hl'));
    if (!on || !s?.wire || safe(s.done)) return;
    for (const r of [s.wire.a, s.wire.b]) document.querySelector(`.pin[data-pid="${CSS.escape(pidOf(r))}"][data-pin="${CSS.escape(pinOf(r))}"]`)?.classList.add('guide-hl');
  }
  /** move on by itself when the current step gets done */
  function onChange() {
    if (!on) return; clearTimeout(refreshT);
    refreshT = setTimeout(() => {
      const s = steps[idx], now = s && safe(s.done);
      if (s && now && !advanced.has(phase + s.id) && idx < steps.length - 1 && (s.wire || s.id === 'mcu' || s.id === 'comp' || s.code)) { advanced.add(phase + s.id); idx++; }
      if (['mcu', 'comp'].includes(s?.id)) plan = null;
      render();
    }, 250);
  }
  canvas.on('change', onChange); canvas.on('model', () => { plan = null; doneManual.clear(); onChange(); });
  editor.ta?.addEventListener('input', onChange);

  const api = {
    get isOn() { return on; },
    toggle(force) {
      on = force ?? !on; host.hidden = !on; document.body.classList.toggle('newbie', on);
      if (on) { plan = null; phase = 'wire'; idx = 0; render(); const first = steps.findIndex((x) => !safe(x.done)); if (first > 0) { idx = first; render(); } }
      else highlight(null);
      api.onToggle?.(on);
    },
    refresh: () => { plan = null; render(); },
    ping: () => onChange(),
    _debug: () => ({ get steps() { return steps; }, get idx() { return idx; }, set idx(v) { idx = v; render(); }, get phase() { return phase; }, set phase(v) { phase = v; idx = 0; render(); }, render }),
  };
  return api;
}
