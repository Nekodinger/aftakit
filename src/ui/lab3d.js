// "Lab" helpers for the 3D view: measuring pins like a multimeter, finding faults, and the sensor controls
// that turn a 3D part into something you can test by hand. Pure functions over the canvas / simulator state.
import { Circuit } from '../sim/circuit.js';

export const isBB = (t) => /breadboard/.test(t);
const base = (p) => (/^\d+\.\d+V$/.test(p) ? p : p.split('.')[0]);
export const POWER = new Set(['VCC', 'V+', 'VIN', '5V', 'VDD', '3V3', '3.3V', '12V', '+', 'VBUS', '3V', 'VCC1', 'VCC2']);
export const GROUND = new Set(['GND', '-', 'G', 'VSS', 'AGND', 'GND1', 'GND2']);
export const isPowerPin = (pin) => POWER.has(base(pin));
export const isGndPin = (pin) => GROUND.has(base(pin));
const splitRef = (ref) => { const i = ref.lastIndexOf(':'); return [ref.slice(0, i), ref.slice(i + 1)]; };
const fmtV = (v) => (Math.abs(v) < 0.005 ? '0.00' : v.toFixed(2)) + ' V';

/** netlist of the current 2D drawing (works while the simulation is stopped) */
export function staticCircuit(canvas) {
  const m = canvas.simModel();
  const parts = m.parts.map((p) => ({ id: p.id, type: p.type, pins: (canvas.parts.get(p.id)?.pinInfo || []).map((x) => x.name) }));
  return new Circuit(parts, m.connections);
}

/** the circuit the simulator is solving, when it matches the drawing (same parts and wires) */
export function liveCircuit(sim, canvas) {
  if (!sim?.running || !sim.circuit || !sim.last || !sim.model) return null;
  const m = canvas.simModel();
  if (m.parts.length !== sim.model.parts.length || m.connections.length !== sim.model.connections.length) return null;
  return sim.circuit;
}

/** other pins on the same net, breadboard holes folded into "via breadboard" */
export function netPeers(circ, canvas, ref) {
  const [pid, pin] = splitRef(ref); const n = circ.net(pid, pin);
  if (n < 0) return { peers: [], viaBB: false, net: -1 };
  let viaBB = false; const peers = [];
  for (const k of circ.members[n]) {
    if (k === ref) continue; const [q] = splitRef(k); const part = canvas.parts.get(q);
    if (!part) continue; if (isBB(part.type)) { viaBB = true; continue; }
    if (q === pid) continue;                                      // the part's own duplicate pins (GND.1 / GND.2)
    peers.push(k);
  }
  return { peers: [...new Set(peers)], viaBB, net: n };
}

/**
 * Multimeter reading of one pin (measured against GND).
 * @returns {{ref, pid, pin, label, live, volts, state, mode, level:'ok'|'warn'|'err'|'idle', detail, peers, viaBB}}
 */
export function readPin(sim, canvas, ref, circStatic) {
  const [pid, pin] = splitRef(ref); const part = canvas.parts.get(pid);
  const info = part?.pinInfo.find((p) => p.name === pin);
  const out = { ref, pid, pin, label: part && info ? `${pid}.${canvas.pinLabel(part, info)}` : ref, live: false, volts: null, state: '—', mode: '', level: 'idle', detail: '', peers: [], viaBB: false };
  if (!part || !info) { out.detail = 'Pin tidak ditemukan.'; return out; }
  const live = liveCircuit(sim, canvas), circ = live || circStatic || staticCircuit(canvas);
  Object.assign(out, netPeers(circ, canvas, ref));
  const wired = out.peers.length > 0 || out.viaBB;
  if (isBB(part.type) && !wired) { out.detail = 'Lubang breadboard kosong.'; }
  if (!live) {
    out.detail ||= sim?.running ? 'Rangkaian diubah setelah simulasi dimulai: jalankan ulang untuk mengukur.' : 'Jalankan simulasi (▶) untuk mengukur tegangan.';
    if (!wired && !isBB(part.type)) { out.level = 'warn'; out.state = 'tidak tersambung'; }
    return out;
  }
  out.live = true;
  const n = live.net(pid, pin), v = sim.last.v(n), pk = sim.last.peak(n), vh = (sim.board?.vHigh ?? 1) * 5;
  // microcontroller pin: what the program configured
  if (sim.boardPart?.id === pid && sim.board?.pins?.[pin]) {
    const d = sim.board.driveLevel(pin), st = sim.board.pins[pin];
    out.mode = d !== null ? (st.freq > 30 && st.duty !== null ? `OUTPUT PWM ${Math.round(st.freq)} Hz` : 'OUTPUT') : sim.board.isPullup(pin) ? 'INPUT_PULLUP' : 'INPUT';
  } else if (sim.arduinoPinsOnNet) {
    const pins = sim.arduinoPinsOnNet(n); if (pins.length) out.mode = `ke pin ${pins.join(', ')} ${sim.boardPart?.id || ''}`.trim();
  }
  if (v === null) {
    out.state = 'mengambang'; out.level = wired ? 'warn' : 'idle';
    out.detail = wired ? 'Tidak ada sumber tegangan pada jalur ini, jadi nilai input bisa acak. Beri pull-up/pull-down (mis. INPUT_PULLUP) atau periksa kabelnya.' : 'Pin ini belum tersambung ke apa pun.';
    if (isPowerPin(pin) && wired) { out.level = 'err'; out.detail = 'Pin daya tidak mendapat tegangan: sambungkan ke 5V / 3V3.'; }
    if (isGndPin(pin) && wired) { out.level = 'err'; out.detail = 'Pin GND tidak terhubung ke ground board / baterai.'; }
    return out;
  }
  out.volts = v * 5; out.level = 'ok';
  if (pk !== null && pk > 0 && v < pk - 0.01) { out.state = `PWM ${Math.round((v / pk) * 100)}%`; out.detail = `Puncak ${fmtV(pk * 5)}, rata-rata ${fmtV(out.volts)}.`; }
  else out.state = out.volts >= 0.6 * vh ? 'HIGH' : out.volts <= 0.3 * vh ? 'LOW' : 'tengah';
  if (isPowerPin(pin) && out.volts < 0.5) { out.level = 'err'; out.detail = 'Pin daya bernilai 0 V: komponen tidak mendapat daya. Periksa kabel VCC.'; }
  else if (isGndPin(pin) && out.volts > 0.3) { out.level = 'err'; out.detail = `Pin GND bertegangan ${fmtV(out.volts)}: kemungkinan tertukar dengan VCC.`; }
  else if (isPowerPin(pin) && out.volts > 5.5 && !/battery|lipo|l298n|buck|esc|solar|mosfet|motor|bldc/.test(part.type)) { out.level = 'err'; out.detail = `Diberi ${fmtV(out.volts)}: melebihi 5 V, modul bisa rusak.`; }
  return out;
}
export const readingText = (r) => (r.volts !== null ? `${fmtV(r.volts)} · ${r.state}` : r.state);

/** live power check of every part (only while the simulation runs): VCC at 0 V, GND not at 0 V */
export function liveFaults(sim, canvas) {
  const live = liveCircuit(sim, canvas); if (!live) return [];
  const out = [];
  for (const part of canvas.parts.values()) {
    if (isBB(part.type) || part.id === sim.boardPart?.id || part.id === sim.designBoard?.id) continue;
    const pins = part.pinInfo.map((p) => p.name); if (!pins.some((p) => live.isWired(part.id, p) || netPeers(live, canvas, part.id + ':' + p).viaBB)) continue;
    for (const pin of pins) {
      if (!isPowerPin(pin) && !isGndPin(pin)) continue;
      const n = live.net(part.id, pin), v = sim.last.v(n), { peers, viaBB } = netPeers(live, canvas, `${part.id}:${pin}`);
      if (!peers.length && !viaBB) continue;
      if (isPowerPin(pin) && (v === null || v * 5 < 0.5)) out.push({ level: 'error', text: `${part.id}: pin ${base(pin)} terukur ${v === null ? 'mengambang' : '0 V'} saat simulasi, komponen tidak mendapat daya.`, parts: [part.id], pin: `${part.id}:${pin}` });
      if (isGndPin(pin) && v !== null && v * 5 > 0.3) out.push({ level: 'error', text: `${part.id}: pin ${base(pin)} terukur ${fmtV(v * 5)}, bukan 0 V. VCC dan GND mungkin tertukar.`, parts: [part.id], pin: `${part.id}:${pin}` });
    }
  }
  return out;
}

/** part ids mentioned in a message ("led1: …", "… ke pin D2 esp") */
export function partsInText(text, ids) {
  const found = [];
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^A-Za-z0-9_\\-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9_\\-])`);
    if (re.test(text) && !found.some((f) => f.includes(id))) found.push(id);
  }
  return found;
}

/** everything wrong with the circuit: design-rule check + simulator warnings + live power faults */
export function collectIssues({ checkRes = [], runtime = [], sim, canvas }) {
  const ids = [...canvas.parts.keys()], seen = new Set(), out = [];
  const push = (it) => { if (seen.has(it.text)) return; seen.add(it.text); out.push(it); };
  for (const r of checkRes) if (r.level === 'error' || r.level === 'warn') push({ level: r.level, text: r.text, parts: partsInText(r.text, ids), src: 'cek' });
  for (const r of runtime) push({ level: r.level === 'error' ? 'error' : 'warn', text: r.text, parts: partsInText(r.text, ids), src: 'sim' });
  for (const r of liveFaults(sim, canvas)) push({ ...r, src: 'ukur' });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// ------------------------------------------------------------------ sensor controls
const NO_DRAG = new Set(['pixels', 'threshold', 'payload', 'wind', 'lat', 'lng', 'alt', 'sats', 'capacity', 'charge']);
/** range props a hand gesture may change (vertical drag = first, horizontal = second) */
export function dragProps(cat) { return (cat?.props || []).filter((p) => p.type === 'range' && !NO_DRAG.has(p.key)).slice(0, 2); }
export function toggleProp(cat) { const b = (cat?.props || []).filter((p) => p.type === 'bool'); return b.length === 1 && !dragProps(cat).length ? b[0] : null; }
const fmtNum = (v, p) => { const s = +p.step || 1, d = s >= 1 ? 0 : Math.min(3, String(s).split('.')[1]?.length || 1); return (+v).toFixed(d); };
export const fmtProp = (p, v) => (p.type === 'bool' ? (v ? 'ya' : 'tidak') : p.type === 'range' ? fmtNum(v, p) + (p.unit || '') : String(v));
/** short reading for the floating label: "24°C · 60%" */
export function propSummary(part, cat) {
  const ps = (cat?.props || []).filter((p) => (p.type === 'range' && !NO_DRAG.has(p.key)) || p.type === 'bool').slice(0, 2);
  return ps.map((p) => (p.type === 'bool' ? `${p.label}: ${part.attrs[p.key] ? 'ya' : 'tidak'}` : fmtProp(p, part.attrs[p.key] ?? p.def))).join(' · ');
}
const escH = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function controlsHTML(part, cat) {
  let h = '';
  for (const p of cat?.props || []) {
    const v = part.attrs[p.key] ?? p.def;
    if (p.type === 'range') h += `<label class="v3-ctl"><span>${escH(p.label)}<b data-out="${p.key}">${escH(fmtProp(p, v))}</b></span><input type="range" data-k="${p.key}" min="${p.min}" max="${p.max}" step="${p.step}" value="${v}"></label>`;
    else if (p.type === 'select') h += `<label class="v3-ctl row"><span>${escH(p.label)}</span><select data-k="${p.key}">${p.options.map((o) => `<option ${o === v ? 'selected' : ''}>${escH(o)}</option>`).join('')}</select></label>`;
    else if (p.type === 'bool') h += `<label class="v3-ctl row"><span>${escH(p.label)}</span><button type="button" class="v3-tog${v ? ' on' : ''}" data-k="${p.key}" aria-pressed="${!!v}">${v ? 'Ya' : 'Tidak'}</button></label>`;
  }
  return h;
}
