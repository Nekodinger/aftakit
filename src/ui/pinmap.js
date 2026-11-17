// "Sambung" table: wire components to the microcontroller without dragging.
// Rows = pins of the microcontroller (grouped: power, then GPIO with their functions), one column per component
// in the workspace. Each cell is a drop-down with that component's pins; choosing one makes / moves the wire at once
// (one undo step per change). "Otomatis" fills a column with a sensible mapping (power, GND, I²C, SPI, UART, ADC for
// analog outputs, free GPIO for the rest) without touching existing connections. Connections made through a
// breadboard are recognised and shown (read-only) too.
const isBB = (t) => /breadboard/.test(t);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (n) => n.replace(/\.\d+$/, '').toUpperCase();     // GND.2 → GND, 3.3V stays
const pidOf = (ref) => ref.slice(0, ref.lastIndexOf(':'));
const pinOf = (ref) => ref.slice(ref.lastIndexOf(':') + 1);

// ---------------------------------------------------------------- microcontroller pin knowledge
const ESP32_FN = {
  21: ['I2C SDA'], 22: ['I2C SCL'], 23: ['SPI MOSI'], 19: ['SPI MISO'], 18: ['SPI SCK'], 5: ['SPI SS'], 16: ['UART2 RX'], 17: ['UART2 TX'],
  3: ['UART0 RX', 'Serial'], 1: ['UART0 TX', 'Serial'], 25: ['DAC1'], 26: ['DAC2'],
};
const ESP32_ADC1 = new Set([32, 33, 34, 35, 36, 39]), ESP32_ADC2 = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27]);
const UNO_FN = { A4: ['I2C SDA'], A5: ['I2C SCL'], 11: ['SPI MOSI'], 12: ['SPI MISO'], 13: ['SPI SCK', 'LED'], 10: ['SPI SS'], 0: ['RX', 'Serial'], 1: ['TX', 'Serial'], 2: ['INT0'], 3: ['INT1'] };
const UNO_PWM = new Set(['3', '5', '6', '9', '10', '11']);

/** description of one MCU pin: { kind: 'power'|'gnd'|'gpio'|'other', gpio, tags[], warn } */
export function mcuPinInfo(part, info, cat) {
  const n = info.name, B = base(n), sig = info.signals || [];
  if (B === 'GND' || sig.some((s) => s.type === 'power' && s.signal === 'GND')) return { kind: 'gnd', tags: ['GND'] };
  if (/^(VIN|5V|3V3|3\.3V|VCC|VBUS|VSYS|IOREF|AREF|V5|V3)$/.test(B) || sig.some((s) => s.type === 'power')) return { kind: 'power', tags: [B === 'VIN' ? 'VIN 5V' : B] };
  if (/^(EN|RST|RESET|RUN|NC)$/.test(B)) return { kind: 'other', tags: [B] };
  const tags = [], board = cat?.board || '';
  let gpio = cat?.gpio?.[n];
  if (/esp32/.test(board) && typeof gpio === 'number') {
    tags.push(...(ESP32_FN[gpio] || []));
    if (ESP32_ADC1.has(gpio)) tags.push('ADC1'); else if (ESP32_ADC2.has(gpio)) tags.push('ADC2');
    const warn = gpio >= 34 ? 'hanya input' : [0, 2, 12, 15].includes(gpio) ? 'pin boot' : (gpio === 1 || gpio === 3) ? 'dipakai Serial' : '';
    if (gpio < 34) tags.push('PWM');
    return { kind: 'gpio', gpio, tags, warn, adc: ESP32_ADC1.has(gpio) || ESP32_ADC2.has(gpio), adc1: ESP32_ADC1.has(gpio), inOnly: gpio >= 34 };
  }
  if (/^(uno|nano|mega)$/.test(board)) {
    const isA = /^A\d+$/.test(n);
    gpio = isA ? n : n.replace(/^D/, '');
    tags.push(...(UNO_FN[gpio] || []));
    if (isA) tags.push('ADC'); if (UNO_PWM.has(gpio)) tags.push('PWM');
    return { kind: 'gpio', gpio, tags, warn: gpio === '0' || gpio === '1' ? 'dipakai Serial' : '', adc: isA };
  }
  for (const s of sig) {
    if (s.type === 'i2c') tags.push('I2C ' + s.signal); else if (s.type === 'spi') tags.push('SPI ' + s.signal); else if (s.type === 'usart') tags.push('UART ' + s.signal);
    else if (s.type === 'analog') tags.push('ADC'); else if (s.type === 'pwm' && !tags.includes('PWM')) tags.push('PWM');
  }
  const m = /(\d+)$/.exec(n);
  return { kind: 'gpio', gpio: typeof gpio === 'number' ? gpio : m ? +m[1] : null, tags, adc: tags.includes('ADC') || /^A\d+$|^ADC|^GP2[6-8]$/.test(n) };
}

// ---------------------------------------------------------------- component pin roles (for "Otomatis")
const FIVE_V = /sr04|servo|relay|mq|lcd1602|lcd2004|l298|stepper|pir|esc|motor|ultrasonic|neopixel|ws2812|hx711|sound|soil|water|ph|tds|flame/i;
function compRole(part, info) {
  const n = info.name, B = base(n).replace(/[^A-Z0-9+\-]/g, ''), sig = info.signals || [], names = new Set(part.pinInfo.map((p) => base(p.name)));
  const t = part.type;
  if (/pushbutton/.test(t)) return n === '1.l' ? { role: 'digital' } : n === '2.l' ? { role: 'gnd' } : { role: 'skip' };
  if (/^wokwi-(resistor|capacitor)|mod-(resistor|capacitor|diode)/.test(t)) return { role: 'skip' };
  if (/lcd1602|lcd2004/.test(t) && !names.has('SDA')) {
    if (/^D[0-3]$/.test(B) || B === 'V0') return { role: 'skip' };
    if (B === 'RW' || B === 'K' || B === 'VSS') return { role: 'gnd' };
    if (B === 'A' || B === 'VDD') return { role: 'power', v: 5 };
    return { role: 'digital' };
  }
  if (t === 'wokwi-led') return B === 'A' ? { role: 'digital', pwm: true } : { role: 'gnd' };
  if (B === 'NC') return { role: 'skip' };
  const i2cPart = part.pinInfo.some((p) => (p.signals || []).some((s) => s.type === 'i2c'));
  if (i2cPart && /^(DC|RST|CS|RES)$/.test(B)) return { role: 'skip' };                // I²C display: SPI-only pins stay free
  if (B === 'VIN' && (names.has('3V3') || names.has('VCC'))) return { role: 'skip' };  // one supply pin is enough
  if (sig.some((s) => s.type === 'power' && s.signal === 'GND') || /^(GND|VSS|G|-|V-|COM)$/.test(B)) return { role: 'gnd' };
  if (B === '5V' || B === 'VIN') return { role: 'power', v: 5 };
  if (B === '3V3' || B === '3.3V' || B === '33V') return { role: 'power', v: 3.3 };
  if (sig.some((s) => s.type === 'power') || /^(VCC|VDD|V\+|\+|VS|VBAT|PWR)$/.test(B)) return { role: 'power', v: FIVE_V.test(t) ? 5 : 3.3 };
  const i2c = sig.find((s) => s.type === 'i2c');
  if (i2c || ((B === 'SDA' || B === 'SCL') && names.has('SDA') && names.has('SCL'))) return { role: 'i2c', sig: i2c?.signal || B };
  const spi = sig.find((s) => s.type === 'spi'); if (spi) return { role: 'spi', sig: spi.signal };
  if (/^(MOSI|DIN|SDI)$/.test(B) && names.has('SCK')) return { role: 'spi', sig: 'MOSI' };
  if (/^(MISO|DOUT|SDO)$/.test(B) && names.has('SCK')) return { role: 'spi', sig: 'MISO' };
  if (/^(SCK|SCLK)$/.test(B)) return { role: 'spi', sig: 'SCK' };
  if (/^(CS|SS|NSS|SDA)$/.test(B) && names.has('SCK')) return { role: 'spi', sig: 'SS' };
  if (/^(TX|TXD)$/.test(B) && (names.has('RX') || names.has('RXD'))) return { role: 'uart', sig: 'TX' };
  if (/^(RX|RXD)$/.test(B) && (names.has('TX') || names.has('TXD'))) return { role: 'uart', sig: 'RX' };
  if (sig.some((s) => s.type === 'analog') || /^(AO|AOUT|A0|VOUT|VRX|VRY|X|Y)$/.test(B) || (/^(OUT|SIG|S)$/.test(B) && /pot|ldr|photo|flex|ntc|soil|sound|gas|mq|water|ph|tds|force|fsr|joystick|slide/i.test(t))) return { role: 'analog' };
  if (sig.some((s) => s.type === 'pwm') || /^(PWM|SERVO)$/.test(B)) return { role: 'digital', pwm: true };
  return { role: 'digital' };
}

// ---------------------------------------------------------------- connectivity (direct wires + breadboard strips)
export function netsOf(canvas) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let r = x; while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const w of canvas.wires) union(w.a, w.b);
  for (const p of canvas.parts.values()) {
    if (!isBB(p.type)) continue;
    const groups = new Map();
    for (const i of p.pinInfo) { const g = i.name.split('.')[0]; if (!groups.has(g)) groups.set(g, `${p.id}:${i.name}`); else union(`${p.id}:${i.name}`, groups.get(g)); }
  }
  return find;
}

export const mcusOf = (canvas, catalog) => [...canvas.parts.values()].filter((p) => catalog[p.type]?.board || catalog[p.type]?.cat === 'Mikrokontroler');
export const compsOf = (canvas, catalog, mcu) => [...canvas.parts.values()].filter((p) => p !== mcu && !isBB(p.type) && p.pinInfo.length && !(catalog[p.type]?.board));
export { compRole };

/** who is connected to which MCU pin: direct wires, and through breadboard strips / other parts ("via") */
export function wiringState(canvas, mcu, cs) {
  const find = netsOf(canvas);
  const direct = new Map();                  // `${mcuPin}|${compId}` -> [compPin]
  const where = new Map();                   // compRef -> mcuPin (direct) or mcuPin + '*' (indirect)
  for (const w of canvas.wires) {
    if (w.plug) continue;
    for (const [a, b] of [[w.a, w.b], [w.b, w.a]]) {
      if (pidOf(a) !== mcu.id) continue;
      const cid = pidOf(b); if (!cs.some((c) => c.id === cid)) continue;
      const k = `${pinOf(a)}|${cid}`; (direct.get(k) || direct.set(k, []).get(k)).push(pinOf(b)); where.set(b, pinOf(a));
    }
  }
  const via = new Map();
  const rootOf = new Map(mcu.pinInfo.map((i) => [find(`${mcu.id}:${i.name}`), i.name]));
  for (const c of cs) for (const i of c.pinInfo) {
    const ref = `${c.id}:${i.name}`; if (where.has(ref)) continue;
    const m = rootOf.get(find(ref)); if (!m) continue;
    const k = `${m}|${c.id}`; (via.get(k) || via.set(k, []).get(k)).push(i.name); where.set(ref, m + '*');
  }
  return { direct, via, where };
}

/**
 * Sensible MCU pins for the still-unconnected pins of one component.
 * @param usedMcu MCU pins already taken (shared between components when planning several)
 * @returns [{ mcuPin, compPin, role, sig, v }]
 */
export function planComp(canvas, catalog, mcu, comp, usedMcu) {
  const cat = catalog[mcu.type], st = wiringState(canvas, mcu, compsOf(canvas, catalog, mcu));
  const infos = mcu.pinInfo.map((i) => ({ i, f: mcuPinInfo(mcu, i, cat) }));
  usedMcu ||= new Set();
  for (const x of st.where.values()) usedMcu.add(x.replace('*', ''));
  const has = (n) => infos.find((x) => x.i.name === n);
  const avr = /^(uno|nano|mega)$/.test(cat?.board || ''), esp = /esp32/.test(cat?.board || '');
  const pick = (pred, allowUsed = false) => { const x = infos.find((x) => pred(x) && (allowUsed || !usedMcu.has(x.i.name))); return x?.i.name; };
  const power = (v) => {
    const want = avr ? ['5V', 'VCC'] : v >= 5 ? ['VIN', '5V', 'VBUS', 'VSYS', 'VCC'] : ['3V3', '3.3V', 'VCC', 'VIN'];
    for (const w of want) { const x = infos.find((x) => x.f.kind === 'power' && base(x.i.name) === w); if (x) return x.i.name; }
    return infos.find((x) => x.f.kind === 'power')?.i.name;
  };
  const gnd = () => infos.find((x) => x.f.kind === 'gnd')?.i.name;
  const prefDigital = esp ? [4, 13, 14, 27, 26, 25, 5, 18, 19, 23, 15, 2, 12, 33, 32] : null;   // keep ADC1 pins for analog sensors
  const digital = (pwm, input) => {
    if (prefDigital) for (const g of prefDigital) { const x = infos.find((x) => x.f.gpio === g && !usedMcu.has(x.i.name)); if (x) return x.i.name; }
    if (avr) { const order = pwm ? ['3', '5', '6', '9', '10', '11', '2', '4', '7', '8', '12', '13'] : ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']; for (const g of order) { const x = infos.find((x) => x.f.gpio === g && !usedMcu.has(x.i.name)); if (x) return x.i.name; } }
    return pick((x) => x.f.kind === 'gpio' && (input || !x.f.inOnly) && !x.f.warn && !x.f.adc) || pick((x) => x.f.kind === 'gpio' && (input || !x.f.inOnly) && !/Serial/.test(x.f.warn || ''));
  };
  const analog = () => (esp ? pick((x) => x.f.adc1) : null) || pick((x) => x.f.adc) || digital();
  const bus = (tag, shared = true) => infos.find((x) => x.f.tags?.includes(tag) && (shared || !usedMcu.has(x.i.name)))?.i.name;
  const plan = [];
  for (const info of comp.pinInfo) {
    const ref = `${comp.id}:${info.name}`; if (st.where.has(ref)) continue;
    const r = compRole(comp, info); let m = null;
    if (r.role === 'skip') continue;
    if (r.role === 'gnd') m = gnd();
    else if (r.role === 'power') m = power(r.v);
    else if (r.role === 'i2c') m = bus('I2C ' + r.sig);
    else if (r.role === 'spi') m = r.sig === 'SS' ? (bus('SPI SS', false) || digital()) : bus('SPI ' + r.sig);
    else if (r.role === 'uart') m = r.sig === 'TX' ? (esp ? 'RX2' : avr ? '2' : bus('UART RX')) : (esp ? 'TX2' : avr ? '3' : bus('UART TX'));
    else if (r.role === 'analog') m = analog();
    else m = digital(r.pwm);
    if (!m || !has(m)) continue;
    plan.push({ mcuPin: m, compPin: info.name, ...r });
    if (!['gnd', 'power', 'i2c'].includes(r.role) && !(r.role === 'spi' && r.sig !== 'SS')) usedMcu.add(m);
  }
  return plan;
}

export function initPinMap({ canvas, catalog, host, toast }) {
  let mcuId = null, onlyUsed = false;

  const mcus = () => mcusOf(canvas, catalog);
  const comps = (mcu) => compsOf(canvas, catalog, mcu);
  const label = (part, info) => canvas.pinLabel(part, info);

  const state = (mcu, cs) => wiringState(canvas, mcu, cs);

  // ---------------------------------------------------------------- edits
  function setCell(mcu, comp, mcuPin, compPin) {
    let changed = false;
    for (const w of [...canvas.wires]) {
      if (w.plug) continue;
      const ends = [w.a, w.b];
      const mcuEnd = ends.find((r) => pidOf(r) === mcu.id), compEnd = ends.find((r) => pidOf(r) === comp.id);
      if (!mcuEnd || !compEnd) continue;
      // the cell's old wire(s), and the chosen component pin's wire to another MCU pin (a component pin has one MCU pin)
      if (pinOf(mcuEnd) === mcuPin || (compPin && pinOf(compEnd) === compPin)) { canvas._removeWire(w, true); changed = true; }
    }
    if (compPin) { if (canvas._addWire(`${mcu.id}:${mcuPin}`, `${comp.id}:${compPin}`, null, true)) changed = true; }
    if (changed) canvas.emit('change', { structural: true });
  }

  function autoMap(mcu, comp) {
    let n = 0;
    for (const x of planComp(canvas, catalog, mcu, comp)) if (canvas._addWire(`${mcu.id}:${x.mcuPin}`, `${comp.id}:${x.compPin}`, null, true)) n++;
    if (n) canvas.emit('change', { structural: true });
    return n;
  }

  // ---------------------------------------------------------------- render
  function render() {
    const prev = host.querySelector('.pm-scroll'), sx = prev?.scrollLeft || 0, sy = prev?.scrollTop || 0;
    const ms = mcus();
    if (!ms.length) { host.innerHTML = '<div class="pm-empty">Belum ada mikrokontroler di kanvas. Tambahkan ESP32 / Arduino dulu dari panel Komponen.</div>'; return; }
    const mcu = ms.find((p) => p.id === mcuId) || ms[0]; mcuId = mcu.id;
    const cat = catalog[mcu.type], cs = comps(mcu);
    if (!cs.length) { host.innerHTML = `<div class="pm-empty">Tambahkan sensor / komponen ke kanvas, lalu sambungkan ke <b>${esc(mcu.id)}</b> di sini.</div>`; return; }
    const st = state(mcu, cs);
    const rows = mcu.pinInfo.map((i) => ({ i, f: mcuPinInfo(mcu, i, cat) }));
    const order = { power: 0, gnd: 1, gpio: 2, other: 3 };
    rows.sort((a, b) => order[a.f.kind] - order[b.f.kind] || (a.f.kind === 'gpio' ? (typeof a.f.gpio === 'number' && typeof b.f.gpio === 'number' ? a.f.gpio - b.f.gpio : String(a.f.gpio ?? a.i.name).localeCompare(String(b.f.gpio ?? b.i.name), 'en', { numeric: true })) : 0));
    const used = (r) => cs.some((c) => st.direct.has(`${r.i.name}|${c.id}`) || st.via.has(`${r.i.name}|${c.id}`));
    const head = cs.map((c) => {
      const total = c.pinInfo.filter((i) => compRole(c, i).role !== 'skip').length || c.pinInfo.length;
      const done = c.pinInfo.filter((i) => st.where.has(`${c.id}:${i.name}`)).length;
      const miss = c.pinInfo.filter((i) => { const r = compRole(c, i).role; return (r === 'power' || r === 'gnd') && !st.where.has(`${c.id}:${i.name}`); }).map((i) => label(c, i));
      return `<th><div class="pm-ch"><b title="${esc(catalog[c.type]?.name || c.type)}">${esc(catalog[c.type]?.name || c.type)}</b><code>${esc(c.id)}</code>
        <span class="pm-prog ${done >= total ? 'ok' : ''}">${Math.min(done, total)}/${total} pin</span>
        <button type="button" class="pm-auto" data-auto="${esc(c.id)}" title="Isi otomatis pin yang belum tersambung">Otomatis</button>
        ${miss.length ? `<span class="pm-miss" title="Pin daya belum tersambung">belum: ${esc(miss.join(', '))}</span>` : ''}</div></th>`;
    }).join('');
    let lastKind = null, body = '';
    for (const r of rows) {
      if (onlyUsed && !used(r)) continue;
      if (r.f.kind !== lastKind) { lastKind = r.f.kind; body += `<tr class="pm-sec"><td colspan="${cs.length + 1}">${{ power: 'Daya', gnd: 'Ground', gpio: 'GPIO / sinyal', other: 'Lainnya' }[r.f.kind]}</td></tr>`; }
      const tags = (r.f.tags || []).filter((t) => t !== r.i.name).map((t) => `<span class="pm-tag ${/I2C/.test(t) ? 'i2c' : /SPI/.test(t) ? 'spi' : /UART|Serial|RX|TX/.test(t) ? 'uart' : /ADC|DAC/.test(t) ? 'adc' : /GND/.test(t) ? 'gnd' : r.f.kind === 'power' ? 'pwr' : ''}">${esc(t)}</span>`).join('');
      const gp = r.f.kind === 'gpio' && typeof r.f.gpio === 'number' && /esp32/.test(cat?.board || '') ? `<span class="pm-gpio">GPIO${r.f.gpio}</span>` : '';
      body += `<tr class="pm-${r.f.kind}"><th class="pm-pin"><b>${esc(label(mcu, r.i))}</b>${gp}<div class="pm-tags">${tags}${r.f.warn ? `<span class="pm-tag warn">${esc(r.f.warn)}</span>` : ''}</div></th>`;
      for (const c of cs) {
        const k = `${r.i.name}|${c.id}`, d = st.direct.get(k) || [], v = st.via.get(k) || [];
        if (!d.length && v.length) { body += `<td><div class="pm-via" title="Tersambung lewat breadboard / komponen lain">${esc(v.map((n) => label(c, c.pinInfo.find((i) => i.name === n) || { name: n })).join(', '))}<small>lewat breadboard</small></div></td>`; continue; }
        const cur = d[0] || '';
        const opts = c.pinInfo.map((i) => {
          const w = st.where.get(`${c.id}:${i.name}`), elsewhere = w && w.replace('*', '') !== r.i.name;
          const lab = label(c, i), desc = i.description && i.description !== lab ? ` – ${i.description}` : '';
          return `<option value="${esc(i.name)}" ${i.name === cur ? 'selected' : ''}>${esc(lab + desc)}${elsewhere ? ` (sekarang di ${esc(w.replace('*', ''))})` : ''}</option>`;
        }).join('');
        const role = cur ? compRole(c, c.pinInfo.find((i) => i.name === cur) || { name: cur }).role : '';
        body += `<td><select class="pm-sel ${cur ? 'on r-' + role : ''}" data-m="${esc(r.i.name)}" data-c="${esc(c.id)}" aria-label="${esc(c.id)} ke ${esc(r.i.name)}"><option value="">—</option>${opts}</select>${d.length > 1 ? `<small class="pm-more">+${d.length - 1}</small>` : ''}</td>`;
      }
      body += '</tr>';
    }
    host.innerHTML = `<div class="pm-bar">
        <label>Mikrokontroler ${ms.length > 1 ? `<select id="pmMcu">${ms.map((p) => `<option value="${esc(p.id)}" ${p.id === mcu.id ? 'selected' : ''}>${esc(p.id)} · ${esc(catalog[p.type]?.name || p.type)}</option>`).join('')}</select>` : `<b>${esc(catalog[mcu.type]?.name || mcu.type)}</b> <code>${esc(mcu.id)}</code>`}</label>
        <label class="pm-chk"><input type="checkbox" id="pmUsed" ${onlyUsed ? 'checked' : ''}> Hanya pin terpakai</label>
        <button type="button" class="btn" id="pmAutoAll">Otomatis semua</button>
      </div>
      <div class="pm-scroll"><table class="pm-table"><thead><tr><th class="pm-corner">Pin ${esc(mcu.id)} ↓ · Komponen →</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="muted small pm-note">Pilih pin komponen di kolomnya pada baris pin mikrokontroler. Perubahan langsung dipasang sebagai kabel (Ctrl+Z untuk urungkan). Satu pin komponen hanya ke satu pin mikrokontroler; memilihnya di baris lain memindahkan kabelnya. Untuk LED, pasang resistor seri (mis. 220 Ω).</p>`;
    const sc = host.querySelector('.pm-scroll'); sc.scrollLeft = sx; sc.scrollTop = sy;
    host.querySelector('#pmMcu')?.addEventListener('change', (e) => { mcuId = e.target.value; render(); });
    host.querySelector('#pmUsed').onchange = (e) => { onlyUsed = e.target.checked; render(); };
    host.querySelector('#pmAutoAll').onclick = () => { let n = 0; for (const c of cs) n += autoMap(mcu, c); toast?.(n ? `${n} kabel dipasang otomatis.` : 'Tidak ada pin yang perlu disambung otomatis.'); render(); };
    host.querySelectorAll('[data-auto]').forEach((b) => (b.onclick = () => { const c = canvas.parts.get(b.dataset.auto); const n = autoMap(mcu, c); toast?.(n ? `${n} kabel ${c.id} dipasang otomatis.` : `Semua pin ${c.id} sudah tersambung.`); render(); }));
    host.querySelectorAll('select.pm-sel').forEach((s) => (s.onchange = () => { setCell(mcu, canvas.parts.get(s.dataset.c), s.dataset.m, s.value); render(); }));
  }
  return { render, autoMap: (mcuPid, compId) => autoMap(canvas.parts.get(mcuPid), canvas.parts.get(compId)), setCell: (m, c, mp, cp) => setCell(canvas.parts.get(m), canvas.parts.get(c), mp, cp) };
}
