// "Saran komponen tambahan": after Auto wiring (or on request) the circuit is checked against the wiring that common
// references use (Random Nerd Tutorials, Adafruit, SparkFun, Arduino docs), and missing support parts are proposed:
//   • LED / RGB LED straight on a GPIO          → 220 Ω series resistor per LED leg
//   • 5 V signal into a 3.3 V GPIO (ESP32 …)    → voltage divider 1 kΩ (series) + 2 kΩ (to GND): 5 V → 3.33 V
//   • DS18B20 data line                         → 4.7 kΩ pull-up DQ–VDD (1-Wire needs it)
//   • bare DHT22 / AM2302 sensor                → 10 kΩ pull-up DATA–VCC
//   • NeoPixel / WS2812 data input              → 330 Ω series resistor (+ 1000 µF across the supply of rings / matrices)
//   • bare relay coil on a GPIO                 → NPN transistor + 1 kΩ base resistor + flyback diode 1N4007
//   • DC motor / pump / fan on the board pins   → MOSFET module (IRF520) switched by a PWM pin
// Nothing is changed until the user ticks the suggestions in the popup; apply() then adds the parts and rewires.
import { mcusOf, compsOf, netsOf } from '../ui/pinmap.js';

const pidOf = (ref) => ref.slice(0, ref.lastIndexOf(':'));
const pinOf = (ref) => ref.slice(ref.lastIndexOf(':') + 1);
const base = (n) => String(n).replace(/\.\d+$/, '').toUpperCase();
const is33 = (board) => /esp32|esp8266|rp2040/.test(board || '');
const SIGNAL_WIRE = '#fb923c';

/** everything the rules need about the current drawing */
function scan(canvas, catalog) {
  const mcu = mcusOf(canvas, catalog)[0]; if (!mcu) return null;
  const cat = catalog[mcu.type] || {}, board = cat.board || '';
  const find = netsOf(canvas);
  const mcuNets = new Map(mcu.pinInfo.map((i) => [find(`${mcu.id}:${i.name}`), i.name]));
  const power = cat.power || {};
  const kindOf = (mcuPin) => (base(mcuPin) === 'GND' ? 'gnd' : power[base(mcuPin)] || power[mcuPin] ? 'power' : 'gpio');
  const mcuPinAt = (ref) => mcuNets.get(find(ref)) || null;               // MCU pin directly on the net of ref
  const resistorsOn = (ref) => {                                          // resistors with a leg on the net of ref
    const n = find(ref), out = [];
    for (const p of canvas.parts.values()) if (p.type === 'wokwi-resistor') for (const l of ['1', '2']) if (find(`${p.id}:${l}`) === n) out.push({ r: p, leg: l });
    return out;
  };
  /** the wire that brings an MCU pin onto the net of ref (direct, or into a breadboard strip) */
  const mcuWire = (ref) => {
    const now = netsOf(canvas), n = now(ref);                            // fresh: earlier suggestions may have rewired
    for (const w of canvas.wires) {
      if (w.plug) continue;
      for (const [m, e] of [[w.a, w.b], [w.b, w.a]]) if (pidOf(m) === mcu.id && pidOf(e) !== mcu.id && now(e) === n) return { w, mcuEnd: m, otherEnd: e };
    }
    return null;
  };
  const supplyOf = (p) => {                                               // volts on the part's VCC-like pin
    const v = p.pinInfo.find((i) => /^(VCC|VDD|V\+|\+|5V|VIN)$/.test(base(i.name))); if (!v) return null;
    const m = mcuPinAt(`${p.id}:${v.name}`); if (!m) return null;
    return power[base(m)] ?? power[m] ?? null;
  };
  const gndPin = mcu.pinInfo.find((i) => base(i.name) === 'GND')?.name;
  const pin5 = mcu.pinInfo.find((i) => ['5V', 'VIN', 'VBUS'].includes(base(i.name)))?.name;
  const pin33 = mcu.pinInfo.find((i) => ['3V3', '3.3V'].includes(base(i.name)))?.name;
  return { mcu, cat, board, find, mcuPinAt, kindOf, resistorsOn, mcuWire, supplyOf, gndPin, pin5, pin33, comps: compsOf(canvas, catalog, mcu) };
}

/** where to drop new parts: under everything, away from breadboard holes (Auto breadboard tidies them later) */
function placer(canvas) {
  let y = 0, x = Infinity;
  for (const p of canvas.parts.values()) { y = Math.max(y, p.top + Math.max(p.size[0], p.size[1])); x = Math.min(x, p.left); }
  let i = 0;
  return () => { const k = i++; return { x: (Number.isFinite(x) ? x : 0) + (k % 6) * 90, y: y + 60 + Math.floor(k / 6) * 70 }; };
}

async function add(canvas, type, at, attrs) { return canvas.addPart(type, Math.round(at.x / 5) * 5, Math.round(at.y / 5) * 5, attrs); }
const wire = (canvas, a, b, color = SIGNAL_WIRE) => canvas._addWire(a, b, color, true);

/**
 * @returns {{ key, title, detail, source, parts: string[], apply: (canvas, place) => Promise<string[]> }[]}
 */
export function suggestExtras(canvas, catalog) {
  const s = scan(canvas, catalog); if (!s) return [];
  const out = [];
  const gpioOn = (ref) => { const m = s.mcuPinAt(ref); return m && s.kindOf(m) === 'gpio' ? m : null; };
  const noResistor = (ref) => !s.resistorsOn(ref).length;

  for (const p of s.comps) {
    const ref = (pin) => `${p.id}:${pin}`;
    // ---- LED and RGB LED: series resistor on every leg driven by a GPIO
    if (p.type === 'wokwi-led' || p.type === 'wokwi-rgb-led') {
      const legs = p.type === 'wokwi-led' ? ['A'] : ['R', 'G', 'B'];
      const need = legs.filter((l) => gpioOn(ref(l)) && noResistor(ref(l)) && noResistor(ref(p.type === 'wokwi-led' ? 'C' : 'COM')));
      if (need.length) out.push({
        key: `led-${p.id}`, parts: need.map(() => 'Resistor 220 Ω'),
        title: `${p.id}: resistor 220 Ω seri ${need.length > 1 ? `di kaki ${need.join(', ')}` : 'di kaki anoda'}`,
        detail: `LED langsung dari pin ${need.map((l) => gpioOn(ref(l))).join(', ')} menarik arus terlalu besar dan bisa merusak LED atau pin. Resistor 220 Ω membatasi arus ±${is33(s.board) ? '5' : '13'} mA.`,
        source: 'Random Nerd Tutorials: ESP32/Arduino LED (resistor 220–330 Ω)',
        async apply(canvas, place) {
          const ids = [];
          for (const l of need) {
            const mw = s.mcuWire(ref(l)); if (!mw) continue;
            canvas._removeWire(mw.w, true);
            const id = await add(canvas, 'wokwi-resistor', place(), { value: '220' }); ids.push(id);
            wire(canvas, mw.mcuEnd, `${id}:1`, mw.w.color); wire(canvas, `${id}:2`, mw.otherEnd, mw.w.color);
          }
          return ids;
        },
      });
    }
    // ---- 5 V outputs into 3.3 V GPIOs: divider 1 k + 2 k
    if (is33(s.board)) {
      const ct = catalog[p.type] || {}, outs = ct.outs || [], vcc = s.supplyOf(p);
      if (ct.logic === 'vcc' && vcc && vcc > 3.6) {
        for (const o of p.pinInfo.filter((i) => outs.includes(base(i.name)))) {
          const g = gpioOn(ref(o.name)); if (!g || !noResistor(ref(o.name))) continue;
          const v = (vcc * 2000 / 3000).toFixed(2);
          out.push({
            key: `div-${p.id}-${o.name}`, parts: ['Resistor 1 kΩ', 'Resistor 2 kΩ'],
            title: `${p.id}.${base(o.name)} → ${g}: pembagi tegangan 1 kΩ + 2 kΩ`,
            detail: `${ct.name} bekerja di ${vcc} V, jadi pin ${base(o.name)} juga mengeluarkan ${vcc} V, padahal GPIO ${s.cat.mcu || 'mikrokontroler'} hanya tahan 3,3 V. Pembagi 1 kΩ (seri) + 2 kΩ (ke GND) menurunkannya menjadi ${v} V.`,
            source: 'Random Nerd Tutorials & mischianti.org: HC-SR04 dengan ESP32 (pembagi 1 kΩ / 2 kΩ di ECHO); modul MQ 5 V ke ADC ESP32',
            async apply(canvas, place) {
              const mw = s.mcuWire(ref(o.name)); if (!mw) return [];
              canvas._removeWire(mw.w, true);
              const r1 = await add(canvas, 'wokwi-resistor', place(), { value: '1000' }), r2 = await add(canvas, 'wokwi-resistor', place(), { value: '2000' });
              wire(canvas, mw.otherEnd, `${r1}:1`, mw.w.color); wire(canvas, `${r1}:2`, mw.mcuEnd, mw.w.color);
              wire(canvas, `${r2}:1`, mw.mcuEnd, mw.w.color); wire(canvas, `${r2}:2`, `${s.mcu.id}:${s.gndPin}`, '#1f2937');
              return [r1, r2];
            },
          });
        }
      }
    }
    // ---- 1-Wire DS18B20 and the bare DHT22: pull-up resistors
    const pull = p.type === 'mod-ds18b20' ? ['DQ', 'VDD', '4700', '4,7 kΩ', 'Random Nerd Tutorials: ESP32 DS18B20 (resistor 4,7 kΩ antara VCC dan data)']
      : p.type === 'wokwi-dht22' ? ['SDA', 'VCC', '10000', '10 kΩ', 'Adafruit DHT guide: pull-up 10 kΩ dari pin data ke VCC (sensor tanpa modul)'] : null;
    if (pull && s.mcuPinAt(ref(pull[0])) && s.mcuPinAt(ref(pull[1]))) {
      const has = s.resistorsOn(ref(pull[0])).some(({ r, leg }) => s.find(`${r.id}:${leg === '1' ? '2' : '1'}`) === s.find(ref(pull[1])));
      if (!has) out.push({
        key: `pull-${p.id}`, parts: [`Resistor ${pull[3]}`],
        title: `${p.id}: resistor pull-up ${pull[3]} antara ${pull[0] === 'SDA' ? 'DATA' : pull[0]} dan ${pull[1]}`,
        detail: p.type === 'mod-ds18b20' ? 'Jalur 1-Wire hanya bisa ditarik ke LOW oleh sensor; tanpa pull-up 4,7 kΩ pembacaan jadi −127 °C atau sensor tidak ditemukan.' : 'DHT22 tanpa modul tidak punya resistor pull-up di jalur data; tanpa 10 kΩ pembacaan sering gagal (NaN).',
        source: pull[4],
        async apply(canvas, place) { const id = await add(canvas, 'wokwi-resistor', place(), { value: pull[2] }); wire(canvas, `${id}:1`, ref(pull[0])); wire(canvas, `${id}:2`, ref(pull[1]), '#e11d48'); return [id]; },
      });
    }
    // ---- NeoPixel: 330 Ω on DIN, 1000 µF across the supply of rings and matrices
    if (/^wokwi-(neopixel|led-ring|neopixel-matrix)$/.test(p.type) && gpioOn(ref('DIN'))) {
      const vccPin = p.pinInfo.find((i) => /^(VCC|VDD)$/.test(base(i.name)))?.name, gnd = p.pinInfo.find((i) => /^(GND|VSS)$/.test(base(i.name)))?.name;
      const big = p.type !== 'wokwi-neopixel';
      const hasCap = [...canvas.parts.values()].some((c) => c.type === 'mod-capacitor' && s.find(`${c.id}:+`) === s.find(ref(vccPin)));
      const needR = noResistor(ref('DIN')), needC = big && !hasCap && vccPin && gnd && s.mcuPinAt(ref(vccPin));
      if (needR || needC) out.push({
        key: `px-${p.id}`, parts: [...(needR ? ['Resistor 330 Ω'] : []), ...(needC ? ['Kapasitor 1000 µF'] : [])],
        title: `${p.id}: ${[needR && 'resistor 330 Ω di DIN', needC && 'kapasitor 1000 µF di catu daya'].filter(Boolean).join(' + ')}`,
        detail: 'Resistor seri di jalur data meredam lonjakan sinyal yang bisa merusak LED pertama; kapasitor besar di VCC–GND menahan lonjakan arus saat banyak LED menyala.',
        source: 'Random Nerd Tutorials & Adafruit NeoPixel Überguide (220–470 Ω di data, 100–1000 µF di catu daya)',
        async apply(canvas, place) {
          const ids = [];
          if (needR) { const mw = s.mcuWire(ref('DIN')); if (mw) { canvas._removeWire(mw.w, true); const id = await add(canvas, 'wokwi-resistor', place(), { value: '330' }); ids.push(id); wire(canvas, mw.mcuEnd, `${id}:1`, mw.w.color); wire(canvas, `${id}:2`, mw.otherEnd, mw.w.color); } }
          if (needC) { const id = await add(canvas, 'mod-capacitor', place(), { capacitance: '1000', rating: '16' }); ids.push(id); wire(canvas, `${id}:+`, ref(vccPin), '#e11d48'); wire(canvas, `${id}:-`, ref(gnd), '#1f2937'); }
          return ids;
        },
      });
    }
    // ---- bare relay coil straight on GPIOs: NPN driver + flyback diode
    if (p.type === 'wokwi-ks2e-m-dc5') {
      const coils = ['COIL1', 'COIL2'].filter((c) => s.mcuPinAt(ref(c)));
      const g = coils.map((c) => gpioOn(ref(c))).find(Boolean);
      if (g) out.push({
        key: `relay-${p.id}`, parts: ['Transistor NPN', 'Resistor 1 kΩ', 'Dioda 1N4007'],
        title: `${p.id}: driver transistor NPN + resistor 1 kΩ + dioda flyback`,
        detail: `Kumparan relay butuh ±70 mA, jauh di atas kemampuan pin (±20 mA). Pin ${g} menggerakkan basis transistor lewat 1 kΩ; transistor menyambungkan kumparan ke GND. Dioda 1N4007 (katoda ke 5 V) menyerap lonjakan tegangan saat relay dilepas.`,
        source: 'JLCPCB / Instructables "Driving a relay with an Arduino": 2N2222, basis 1 kΩ, 1N4007',
        async apply(canvas, place) {
          const ends = coils.map((c) => s.mcuWire(ref(c))).filter(Boolean);
          for (const e of ends) canvas._removeWire(e.w, true);
          const gpio = `${s.mcu.id}:${g}`, v5 = `${s.mcu.id}:${s.pin5 || s.pin33}`, gnd = `${s.mcu.id}:${s.gndPin}`;
          const q = await add(canvas, 'mod-npn', place()), r = await add(canvas, 'wokwi-resistor', place(), { value: '1000' }), d = await add(canvas, 'mod-diode', place());
          wire(canvas, gpio, `${r}:1`); wire(canvas, `${r}:2`, `${q}:B`); wire(canvas, `${q}:E`, gnd, '#1f2937');
          wire(canvas, ref('COIL1'), v5, '#e11d48'); wire(canvas, ref('COIL2'), `${q}:C`, '#a855f7');
          wire(canvas, `${d}:K`, ref('COIL1'), '#e11d48'); wire(canvas, `${d}:A`, ref('COIL2'), '#a855f7');
          return [q, r, d];
        },
      });
    }
    // ---- motors / pumps / fans / solenoids on the board pins: MOSFET module
    if (/^mod-(dc-motor|pump|fan|solenoid|motor-tt|motor-130)$/.test(p.type)) {
      const pos = p.pinInfo.find((i) => /^(\+|M\+)$/.test(base(i.name)))?.name, neg = p.pinInfo.find((i) => /^(-|M-)$/.test(base(i.name)))?.name;
      if (pos && neg && (s.mcuPinAt(ref(pos)) || s.mcuPinAt(ref(neg)))) {
        out.push({
          key: `fet-${p.id}`, parts: ['Modul MOSFET IRF520'],
          title: `${p.id}: modul MOSFET (IRF520) sebagai saklar motor`,
          detail: `${catalog[p.type]?.name || p.id} tersambung langsung ke pin board: ${s.mcuPinAt(ref(pos)) && s.kindOf(s.mcuPinAt(ref(pos))) !== 'gpio' ? 'motor selalu menyala dan tidak bisa dikendalikan' : 'pin GPIO tidak kuat memberi arus motor'}. Modul MOSFET dikendalikan pin PWM (bisa atur kecepatan) dan mengambil arus dari catu 5 V.`,
          source: 'Random Nerd Tutorials: ESP32 DC motor; modul IRF520 MOSFET (SIG = PWM, V+/V− = beban)',
          async apply(canvas, place) {
            for (const pin of [pos, neg]) for (const w of [...canvas.wires]) if (!w.plug && (w.a === ref(pin) || w.b === ref(pin)) && [w.a, w.b].some((x) => pidOf(x) === s.mcu.id)) canvas._removeWire(w, true);
            const used = new Set(canvas.wires.flatMap((w) => [w.a, w.b]).filter((x) => pidOf(x) === s.mcu.id).map(pinOf));
            const pwmPin = (/esp32/.test(s.board) ? ['D25', 'D26', 'D27', 'D14', 'D4', 'D13'] : /esp8266/.test(s.board) ? ['D5', 'D6', 'D7', 'D1', 'D2'] : ['9', '10', '5', '6', '3', '11']).find((x) => s.mcu.pinInfo.some((i) => i.name === x) && !used.has(x));
            const f = await add(canvas, 'mod-mosfet', place());
            const v5 = `${s.mcu.id}:${s.pin5 || s.pin33}`, gnd = `${s.mcu.id}:${s.gndPin}`;
            if (pwmPin) wire(canvas, `${s.mcu.id}:${pwmPin}`, `${f}:SIG`);
            wire(canvas, `${f}:GND`, gnd, '#1f2937'); wire(canvas, `${f}:VCC`, `${s.mcu.id}:${s.pin33 || s.pin5}`, '#e11d48'); wire(canvas, `${f}:VIN`, v5, '#e11d48');
            wire(canvas, ref(pos), `${f}:VIN.2`, '#e11d48'); wire(canvas, ref(neg), `${f}:V-`, '#1f2937');
            return [f];
          },
        });
      }
    }
  }
  return out;
}

/** add the chosen suggestions; returns the ids of the new parts */
export async function applyExtras(canvas, list) {
  const place = placer(canvas), ids = [];
  for (const x of list) { try { ids.push(...(await x.apply(canvas, place))); } catch (e) { console.warn('extra', x.key, e); } }
  if (ids.length) canvas.emit('change', { structural: true });
  return ids;
}
