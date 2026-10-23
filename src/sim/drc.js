// Design-rule check ("Periksa Rangkaian"): static wiring checks that also work for boards whose code
// cannot be executed here (ESP32, ESP32-CAM, ESP8266, Raspberry Pi Pico, Mega).
import { Circuit } from './circuit.js';
import { BY_TAG } from '../catalog.js';

const base = (p) => p.split('.')[0];
const POWER_IN = ['VCC', '+', 'V+', 'VIN', '5V', 'VDD', '3V3', '3.3V', '12V'];
const GND_IN = ['GND', '-', 'G', 'VSS', 'AGND', 'IN-'];
const ANALOG = {
  'mod-soil': ['AO'], 'mod-soil-cap': ['AOUT'], 'mod-water-level': ['S'], 'mod-rain': ['AO'], 'mod-mq135': ['AO'], 'mod-pulse': ['S'],
  'mod-acs712': ['OUT'], 'mod-voltage': ['S'], 'mod-tds': ['A'], 'mod-ph': ['Po'], 'mod-tcrt5000': ['AO'], 'wokwi-potentiometer': ['SIG'],
  'wokwi-slide-potentiometer': ['SIG'], 'wokwi-photoresistor-sensor': ['AO'], 'wokwi-ntc-temperature-sensor': ['OUT'], 'wokwi-gas-sensor': ['AOUT'],
  'wokwi-flame-sensor': ['AOUT'], 'wokwi-big-sound-sensor': ['AOUT'], 'wokwi-small-sound-sensor': ['AOUT'], 'wokwi-analog-joystick': ['HORZ', 'VERT'],
};
// pins that must be DRIVEN by the microcontroller (so they cannot sit on an input-only GPIO)
const DRIVEN = (type, pin) => /^(IN\d?|EN[AB]?|TRIG|PWM|DIN|SIG|S|R|G|B|CLK|DIO|CS|CE|CSN|SCK|MOSI)$/.test(base(pin)) && !ANALOG[type]?.includes(base(pin))
  || (type === 'wokwi-led' && pin === 'A') || (type === 'wokwi-buzzer' && pin === '1') || (type === 'mod-npn' && pin === 'B');
const HUNGRY = ['wokwi-servo', 'mod-dc-motor', 'mod-pump', 'mod-fan', 'mod-solenoid', 'mod-relay1', 'mod-relay2', 'mod-relay4', 'wokwi-stepper-motor'];
const ESP32_STRAP = { 0: 'GPIO0 menentukan mode boot (LOW = mode upload)', 2: 'GPIO2 harus LOW/mengambang saat upload', 5: 'GPIO5 adalah pin strapping', 12: 'GPIO12 HIGH saat boot membuat tegangan flash salah (gagal boot)', 15: 'GPIO15 pin strapping (log boot)' };
const ESP8266_STRAP = { 0: 'D3/GPIO0 harus HIGH saat boot', 2: 'D4/GPIO2 harus HIGH saat boot (LED biru)', 15: 'D8/GPIO15 harus LOW saat boot' };
const ESP32_ADC2 = new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27]);
const ESP32_INPUT_ONLY = new Set([34, 35, 36, 39]);

export function checkDesign(model, els) {
  const out = []; const add = (level, text) => out.push({ level, text });
  const parts = model.parts.map((p) => ({ id: p.id, type: p.type, pins: (els.get(p.id)?.pinInfo || []).map((x) => x.name) }));
  const c = new Circuit(parts, model.connections);
  const board = model.parts.find((p) => BY_TAG[p.type]?.board);
  const net = (id, pin) => c.net(id, pin);
  const members = (n) => (n < 0 ? [] : c.members[n]);
  const byId = Object.fromEntries(model.parts.map((p) => [p.id, p]));
  const pinsOf = (id) => (els.get(id)?.pinInfo || []).map((x) => x.name);

  if (!board) add('info', 'Tidak ada mikrokontroler. Rangkaian disimulasikan sebagai rangkaian listrik saja (baterai, saklar, LED, relay, motor).');
  const cat = board ? BY_TAG[board.type] : null;
  const mcu = cat?.board; const gpioMap = cat?.gpio || {}; const power = cat?.power || {};
  const boardNetPins = (n) => members(n).filter((m) => board && m.startsWith(board.id + ':')).map((m) => m.slice(board.id.length + 1));
  const sources = new Map(); // net -> volts (board rails + batteries/regulators)
  if (board) for (const pin of pinsOf(board.id)) { const b = base(pin); const n = net(board.id, pin); if (GND_IN.includes(b)) sources.set(n, 0); else if (power[b]) sources.set(n, power[b]); }
  for (const p of model.parts) {
    const t = p.type, a = p.attrs || {};
    if (t === 'mod-battery9v' || t === 'mod-battery18650') { sources.set(net(p.id, '+'), +(a.voltage ?? (t === 'mod-battery9v' ? 9 : 3.7))); sources.set(net(p.id, '-'), 0); }
    if (t === 'mod-solar') { sources.set(net(p.id, '+'), 6); sources.set(net(p.id, '-'), 0); }
    if (t === 'mod-buck') sources.set(net(p.id, 'OUT+'), +(a.vout ?? 5));
    if (t === 'mod-l298n' && sources.get(net(p.id, '12V')) >= 7) sources.set(net(p.id, '5V'), 5);
  }

  // ---- shorts between supply rails
  const seen = new Map();
  for (const p of model.parts) for (const pin of pinsOf(p.id)) {
    const n = net(p.id, pin); if (!sources.has(n)) continue;
    const ownV = (BY_TAG[p.type]?.board && (GND_IN.includes(base(pin)) ? 0 : power[base(pin)])) ?? null;
    if (ownV === null || ownV === undefined) continue;
    if (seen.has(n) && seen.get(n) !== ownV) add('error', `Korsleting: pin daya ${base(pin)} (${ownV} V) terhubung ke rel ${seen.get(n)} V. Lepaskan kabel ini sebelum menyalakan board.`);
    else seen.set(n, ownV);
  }

  // ---- power for every module
  for (const p of model.parts) {
    const ct = BY_TAG[p.type]; if (!ct || ct.board || ct.breadboard || p.type === 'wokwi-resistor') continue;
    const pins = pinsOf(p.id); const vccPin = pins.find((x) => POWER_IN.includes(base(x)) && !['V+'].includes(base(x)) || base(x) === 'V+' && p.type === 'wokwi-servo');
    const gndPin = pins.find((x) => GND_IN.includes(base(x)));
    if (!vccPin || !gndPin || ['mod-battery9v', 'mod-battery18650', 'mod-solar', 'mod-buck', 'mod-voltage', 'mod-acs712', 'mod-mosfet', 'mod-npn', 'mod-dc-motor', 'mod-pump', 'mod-fan', 'mod-solenoid', 'wokwi-led', 'wokwi-buzzer'].includes(p.type)) continue;
    const anyWired = pins.some((x) => c.isWired(p.id, x)); if (!anyWired) { add('info', `${p.id}: belum dirangkai.`); continue; }
    const vn = net(p.id, vccPin), gn = net(p.id, gndPin);
    if (!sources.has(vn)) add('warn', `${p.id}: pin ${base(vccPin)} tidak mendapat tegangan (hubungkan ke 5V / 3V3 / VIN).`);
    if (sources.get(gn) !== 0) add('warn', `${p.id}: pin ${base(gndPin)} belum ke GND.`);
    const v = sources.get(vn);
    if (v !== undefined && HUNGRY.includes(p.type) && v < 4.5) add('warn', `${p.id}: ${ct.name} butuh 5 V; saat ini diberi ${v} V. Pakai pin 5V/VIN atau catu daya terpisah (GND disatukan).`);
    if (v !== undefined && v > 5.5 && !['mod-l298n', 'mod-mosfet', 'mod-buck'].includes(p.type)) add('error', `${p.id}: diberi ${v} V, padahal modul ini bekerja di 3.3–5 V. Turunkan dengan step-down (LM2596).`);
  }

  if (!board) return out;

  // ---- per-pin checks against the microcontroller
  const isEsp = mcu === 'esp32' || mcu === 'esp8266', is33 = isEsp || mcu === 'rp2040';
  const gpioOf = (pin) => gpioMap[pin] ?? gpioMap[base(pin)];
  // walk through a resistor once so "GPIO -> R -> LED" counts as connected
  const reach = (n) => {
    const res = new Set(members(n));
    for (const m of [...res]) { const [id, pin] = m.split(':'); if (byId[id]?.type === 'wokwi-resistor') for (const x of members(net(id, pin === '1' ? '2' : '1'))) res.add(x); }
    return [...res];
  };
  const analogPins = mcu === 'esp8266' ? new Set(['A0']) : mcu === 'uno' || mcu === 'nano' ? new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']) : null;
  for (const pin of pinsOf(board.id)) {
    const n = net(board.id, pin); if (sources.has(n)) continue;
    const others = reach(n).filter((m) => !m.startsWith(board.id + ':'));
    if (!others.length) continue;
    const g = gpioOf(pin); const label = typeof g === 'number' ? `${base(pin)} (GPIO${g})` : base(pin);
    for (const m of others) {
      const [id, ppin] = m.split(':'); const p = byId[id]; if (!p) continue; const ct = BY_TAG[p.type]; if (!ct || ct.breadboard) continue;
      // 5 V logic output into a 3.3 V GPIO
      if (is33 && ct.logic === 'vcc' && ct.outs?.includes(base(ppin))) {
        const vcc = pinsOf(id).find((x) => POWER_IN.includes(base(x)));
        const vv = vcc ? sources.get(net(id, vcc)) : undefined;
        if (vv && vv > 3.6) add('warn', `${id}.${base(ppin)} → ${label}: modul diberi ${vv} V sehingga sinyalnya bisa ${vv} V, melebihi batas 3.3 V GPIO ${ct.mcu || cat.mcu}. Beri pembagi tegangan (mis. 1 kΩ + 2 kΩ) atau beri modul 3.3 V bila mampu.`);
      }
      // input-only pins
      if (mcu === 'esp32' && ESP32_INPUT_ONLY.has(g) && DRIVEN(p.type, ppin)) add('error', `${label} hanya bisa INPUT, tetapi dipakai untuk mengendalikan ${id}.${base(ppin)}. Pindah ke GPIO lain (mis. 25, 26, 27, 32, 33).`);
      // analog
      if (ANALOG[p.type]?.includes(base(ppin))) {
        if (mcu === 'esp32' && ESP32_ADC2.has(g)) add('warn', `${id}.${base(ppin)} (analog) di ${label}: ADC2 tidak bisa dibaca saat WiFi aktif. Untuk proyek IoT gunakan ADC1: GPIO32–39.`);
        if (mcu === 'esp32' && typeof g === 'number' && !ESP32_ADC2.has(g) && ![32, 33, 34, 35, 36, 39].includes(g)) add('error', `${id}.${base(ppin)} (analog) di ${label}: pin ini tidak punya ADC. Gunakan GPIO32–39.`);
        if (analogPins && !analogPins.has(base(pin))) add('warn', `${id}.${base(ppin)} adalah keluaran analog, tetapi masuk ke ${label} yang bukan pin analog. Gunakan ${mcu === 'esp8266' ? 'A0 (maks. 1 pin analog)' : 'A0–A5'} lalu analogRead().`);
        if (mcu === 'esp8266' && base(pin) === 'A0' && cat.tag === 'mod-d1mini') { /* D1 mini has divider to 3.2 V */ }
      }
      // strapping pins
      if (mcu === 'esp32' && ESP32_STRAP[g] !== undefined && cat.tag !== 'mod-esp32-cam') add('info', `${label}: ${ESP32_STRAP[g]}. Aman untuk output setelah boot, tetapi jangan dipasang pull-up/pull-down kuat.`);
      if (mcu === 'esp8266' && ESP8266_STRAP[g] !== undefined) add('info', `${label}: ${ESP8266_STRAP[g]}.`);
      if (board.type === 'mod-esp32-cam') {
        if (g === 16) add('warn', `${label}: GPIO16 dipakai PSRAM kamera; hindari untuk perangkat lain.`);
        if (g === 4) add('info', `${label}: GPIO4 terhubung ke LED flash; LED akan ikut menyala.`);
        if (g === 1 || g === 3) add('info', `${label}: dipakai Serial/upload. Lepaskan saat upload program.`);
        if (g === 0) add('info', `${label}: GPIO0 ke GND hanya saat upload, lepas saat menjalankan.`);
      }
      // I2C pins
      if (/^(SDA|SCL)$/.test(base(ppin)) && ct.i2c) {
        const want = mcu === 'esp32' ? { SDA: 21, SCL: 22 } : mcu === 'esp8266' ? { SDA: 4, SCL: 5 } : mcu === 'uno' || mcu === 'nano' ? { SDA: 'A4', SCL: 'A5' } : null;
        const w = want?.[base(ppin)];
        if (w !== undefined && w !== g && w !== base(pin)) add('info', `${id}.${base(ppin)} di ${label}; pin I2C bawaan ${base(ppin)} = ${typeof w === 'number' ? 'GPIO' + w : w}. Bila tetap dipakai, panggil Wire.begin(SDA, SCL) dengan pin Anda.`);
      }
    }
  }

  // ---- common ground with external supplies
  for (const p of model.parts) {
    if (!['mod-battery9v', 'mod-battery18650', 'mod-solar'].includes(p.type)) continue;
    const neg = net(p.id, '-'); const boardGnd = pinsOf(board.id).filter((x) => base(x) === 'GND').map((x) => net(board.id, x));
    // only drivers whose logic ground IS the battery ground need a common ground (relay contacts are isolated)
    const feedsLogic = model.parts.some((q) => ['mod-l298n', 'mod-mosfet'].includes(q.type) && pinsOf(q.id).some((x) => base(x) === 'GND' && net(q.id, x) === neg));
    if (feedsLogic && !boardGnd.includes(neg)) add('warn', `${p.id}: kutub (−) baterai belum disatukan dengan GND ${board.id}. Sinyal kendali butuh GND bersama.`);
  }

  if (!out.some((x) => x.level !== 'info')) add('ok', 'Tidak ditemukan kesalahan rangkaian.');
  return out;
}
