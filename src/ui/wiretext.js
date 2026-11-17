// Wiring by typing: one connection per line, e.g.
//   esp32:D21 - oled1:SDA            (part id : pin name)
//   D22 -> SCL  kuning               (a pin name that exists on only one part needs no id; optional colour word)
//   esp32:GND ke bb1:-               (repeated pins such as GND, breadboard rails + / − / TP / BN: the hole nearest the other end)
//   bb1:a10 - led1:A                 (breadboard holes by their printed name: column letter + row number)
// Separators: "-", "->", "→", "<->", "=", "ke", "to", "dengan" (surrounded by spaces), or a comma / semicolon between pins.
// Lines starting with # or // are comments. Several connections may share a line when separated by ";".
const SEP = new Set(['-', '--', '->', '-->', '→', '<->', '↔', '=', 'ke', 'to', 'dengan', 'with', '—', '–']);
export const COLOR_WORDS = {
  merah: '#e11d48', red: '#e11d48', hitam: '#1f2937', black: '#1f2937', kuning: '#f5a524', yellow: '#f5a524', hijau: '#2fbf71', green: '#2fbf71',
  biru: '#3d8bfd', blue: '#3d8bfd', ungu: '#a855f7', purple: '#a855f7', violet: '#a855f7', tosca: '#06b6d4', cyan: '#06b6d4', toska: '#06b6d4',
  oranye: '#fb923c', orange: '#fb923c', jingga: '#fb923c', putih: '#ffffff', white: '#ffffff',
};
const COLOR_NAME = Object.fromEntries(Object.entries(COLOR_WORDS).filter(([k]) => /^[a-z]+$/.test(k) && !['red', 'black', 'yellow', 'green', 'blue', 'purple', 'violet', 'cyan', 'toska', 'orange', 'jingga', 'white'].includes(k)).map(([k, v]) => [v, k]));
const isBBType = (t) => /breadboard/.test(t);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, '');

/** candidate pins (names) of one part for a typed pin token */
function pinCandidates(canvas, part, tok, cat) {
  const t = norm(tok), infos = part.pinInfo;
  if (!t) return [];
  const by = (f) => infos.filter(f).map((i) => i.name);
  let r = by((i) => i.name.toLowerCase() === t);
  if (r.length) return r;
  if (isBBType(part.type)) {
    const rail = { '+': ['TP', 'BP'], '-': ['TN', 'BN'], '−': ['TN', 'BN'], vcc: ['TP', 'BP'], gnd: ['TN', 'BN'], 'top+': ['TP'], 'top-': ['TN'], 'bot+': ['BP'], 'bot-': ['BN'], 'atas+': ['TP'], 'atas-': ['TN'], 'bawah+': ['BP'], 'bawah-': ['BN'] }[t];
    if (rail) return by((i) => rail.includes(i.name.split('.')[0]));
    r = by((i) => (i.description || '').toLowerCase() === t);                     // a10
    if (!r.length) { const m = /^(\d+)([a-j])$/.exec(t); if (m) r = by((i) => (i.description || '').toLowerCase() === m[2] + m[1]); }   // 10a
    if (r.length) return r;
    return by((i) => i.name.split('.')[0].toLowerCase() === t);                    // TP, BN
  }
  r = by((i) => (i.label || '').toLowerCase() === t || canvas.pinLabel(part, i).toLowerCase() === t);
  if (r.length) return r;
  const gpio = cat?.gpio || {};
  const m = /^(?:gpio|io|g|d|p)?(\d+)$/.exec(t);
  if (m) {                                                                          // GPIO21 / IO21 / 21 / D13
    r = by((i) => gpio[i.name] === +m[1]);
    if (!r.length) r = by((i) => i.name.toLowerCase() === m[1] || i.name.toLowerCase() === 'd' + m[1]);
    if (r.length) return r;
  }
  r = by((i) => i.name.split('.')[0].toLowerCase() === t);                         // GND → GND.1, GND.2 …
  if (r.length) return r;
  const alias = { '3.3v': ['3v3', '3.3v'], '3v3': ['3v3', '3.3v'], vcc: ['vcc', 'vin', '5v', '3v3'], '+': ['+', 'vcc', 'v+', 'a', 'anode'], '-': ['-', 'gnd', 'v-', 'c', 'cathode', 'k'], anoda: ['a'], katoda: ['c', 'k'], katode: ['c', 'k'], k: ['c', 'cathode'], anode: ['a'], cathode: ['c', 'k'], sda: ['sda', 'data', 'din'], scl: ['scl', 'clk', 'sck'], data: ['sda', 'din', 'dat'], clk: ['scl', 'sck', 'clock'] }[t];
  if (alias) for (const a of alias) { r = by((i) => i.name.split('.')[0].toLowerCase() === a || (i.label || '').toLowerCase() === a); if (r.length) return r; }
  return [];
}

function findPart(canvas, id) {
  const t = norm(id), parts = [...canvas.parts.values()];
  let p = parts.find((x) => x.id.toLowerCase() === t);
  if (p) return { part: p };
  const pre = parts.filter((x) => x.id.toLowerCase().startsWith(t) || x.type.toLowerCase().replace(/^(wokwi|x|mod)-/, '').startsWith(t));
  if (pre.length === 1) return { part: pre[0] };
  return { err: pre.length ? `"${id}" cocok dengan beberapa komponen (${pre.map((x) => x.id).join(', ')}); tulis id lengkapnya.` : `komponen "${id}" tidak ada di kanvas.` };
}

/** resolve a pin token to a list of candidate refs */
function resolve(canvas, catalog, tok) {
  const i = tok.lastIndexOf(':');
  if (i > 0) {
    const { part, err } = findPart(canvas, tok.slice(0, i)); if (err) return { err };
    const c = pinCandidates(canvas, part, tok.slice(i + 1), catalog[part.type]);
    if (!c.length) return { err: `pin "${tok.slice(i + 1)}" tidak ada pada ${part.id} (pin: ${part.pinInfo.slice(0, 14).map((p) => canvas.pinLabel(part, p)).join(', ')}${part.pinInfo.length > 14 ? ', …' : ''}).` };
    return { refs: c.map((n) => `${part.id}:${n}`) };
  }
  const hits = [];
  for (const part of canvas.parts.values()) {
    if (isBBType(part.type)) continue;
    const c = pinCandidates(canvas, part, tok, catalog[part.type]); if (c.length) hits.push([part, c]);
  }
  if (!hits.length) return { err: `pin "${tok}" tidak ditemukan; tulis sebagai idKomponen:pin (mis. esp32:D21).` };
  if (hits.length > 1) return { err: `pin "${tok}" ada di beberapa komponen (${hits.map(([p]) => p.id).join(', ')}); tulis idKomponen:${tok}.` };
  return { refs: hits[0][1].map((n) => `${hits[0][0].id}:${n}`) };
}

/** split a line into [pinA, pinB, colour?] tokens */
function tokens(line) {
  const t = line.replace(/[,]/g, ' ').split(/\s+/).filter(Boolean).filter((x) => !SEP.has(x.toLowerCase()));
  // "a:b-c:d" without spaces: split on a dash or arrow between two refs
  if (t.length === 1) { const m = /^(.+?:[^\s]+?)(?:->|→|<->|=)(.+)$/.exec(t[0]) || /^(.+?:[^-\s]+)-(.+:.+)$/.exec(t[0]); if (m) return [m[1], m[2]]; }
  return t;
}

/**
 * Parse wiring text. Returns { wires: [{a, b, color, line}], errors: [{line, text, msg}] } (nothing is changed).
 */
export function parseWiring(canvas, catalog, text) {
  const wires = [], errors = [];
  const used = new Set(canvas.wires.flatMap((w) => [w.a, w.b]));
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, li) => {
    for (const seg of raw.split(';')) {
      const line = seg.replace(/(^|\s)(\/\/|#(?![0-9a-f]{3,8}\b)).*$/i, '').trim();
      if (!line) continue;
      const tk = tokens(line);
      let color = null;
      if (tk.length >= 3 && COLOR_WORDS[tk[tk.length - 1].toLowerCase()]) color = COLOR_WORDS[tk.pop().toLowerCase()];
      else if (tk.length >= 3 && /^#[0-9a-f]{3,8}$/i.test(tk[tk.length - 1])) color = tk.pop();
      if (tk.length !== 2) { errors.push({ line: li + 1, text: line, msg: 'format: pinA - pinB [warna], mis. "esp32:D21 - oled1:SDA kuning".' }); continue; }
      const A = resolve(canvas, catalog, tk[0]), B = resolve(canvas, catalog, tk[1]);
      if (A.err || B.err) { errors.push({ line: li + 1, text: line, msg: A.err || B.err }); continue; }
      // several candidates (GND.1/GND.2, rail holes): take the pair that is closest, preferring holes / pins not yet wired
      let best = null;
      for (const a of A.refs) for (const b of B.refs) {
        if (a === b) continue;
        const pa = canvas.pinPos(a), pb = canvas.pinPos(b); if (!pa || !pb) continue;
        const cost = Math.hypot(pa.x - pb.x, pa.y - pb.y) + (A.refs.length > 1 && used.has(a) ? 400 : 0) + (B.refs.length > 1 && used.has(b) ? 400 : 0);
        if (!best || cost < best.cost) best = { a, b, cost };
      }
      if (!best) { errors.push({ line: li + 1, text: line, msg: 'kedua ujung menunjuk pin yang sama.' }); continue; }
      if (canvas.wires.some((w) => (w.a === best.a && w.b === best.b) || (w.a === best.b && w.b === best.a)) || wires.some((w) => (w.a === best.a && w.b === best.b) || (w.a === best.b && w.b === best.a))) {
        errors.push({ line: li + 1, text: line, msg: 'kabel ini sudah ada.', dup: true }); continue;
      }
      used.add(best.a); used.add(best.b);
      wires.push({ a: best.a, b: best.b, color, line: li + 1 });
    }
  });
  return { wires, errors };
}

/** add the parsed wires to the canvas (one undo step) */
export function applyWiring(canvas, wires) {
  let n = 0;
  for (const w of wires) if (canvas._addWire(w.a, w.b, w.color, true)) n++;
  if (n) canvas.emit('change', { structural: true });
  return n;
}

/** current wiring as text (breadboard holes by their printed name) */
export function wiringToText(canvas) {
  const name = (ref) => {
    const [pid, pin] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];
    const part = canvas.parts.get(pid); const info = part?.pinInfo.find((p) => p.name === pin);
    if (part && isBBType(part.type) && info?.description && /^[a-j]\d+$/.test(info.description)) return `${pid}:${info.description}`;
    return ref;
  };
  return canvas.wires.filter((w) => !w.plug).map((w) => `${name(w.a)} - ${name(w.b)}${COLOR_NAME[w.color] ? ' ' + COLOR_NAME[w.color] : ''}`).join('\n');
}
