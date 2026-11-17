// Circuits produced by "Saran komponen tambahan" (suggested extra parts) must still work electrically:
// HC-SR04 ECHO through a 1k/2k divider into an ESP32, LED through 220 ohm, NeoPixel ring through 330 ohm (AVR),
// bare relay coil through NPN + 1k + flyback diode, pump through an IRF520 MOSFET module, DS18B20 with its pull-up.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const { checkDesign } = await import('../src/sim/drc.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src, esp) {
  writeFileSync('/tmp/_extras.ino', src);
  const py = esp ? `from compiler_wasm import compile_sketch_wasm as f; r=f(open('/tmp/_extras.ino').read(),'esp32')` : `from compiler import compile_sketch as f; r=f(open('/tmp/_extras.ino').read())`;
  const r = JSON.parse(execFileSync('python3', ['-c', `import json,sys; sys.path.insert(0,'server'); ${py}; print(json.dumps(r))`], { cwd: root, maxBuffer: 1e8 }));
  const out = esp ? r.wasm && Buffer.from(r.wasm, 'base64') : r.hex; if (!out) throw new Error('compile failed: ' + (r.stderr || JSON.stringify(r.errors))); return out;
}
class Stub {
  constructor(tag, pins) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; this.lit = 0; }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener() {}
  setLed() {} setText() {} setRotor() {} setPixel(i, c) { if (c && (c.r || c.g || c.b)) this.lit++; }
}
const PINS = {
  'wokwi-esp32-devkit-v1': 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' '),
  'wokwi-arduino-uno': ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', 'GND.1', 'GND.2', 'GND.3', '5V', '3.3V', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'IOREF', 'RESET', 'AREF'],
  'wokwi-hc-sr04': ['VCC', 'TRIG', 'ECHO', 'GND'], 'wokwi-resistor': ['1', '2'], 'wokwi-led': ['A', 'C'], 'wokwi-led-ring': ['GND', 'VCC', 'DIN', 'DOUT'],
  'mod-capacitor': ['+', '-'], 'wokwi-ks2e-m-dc5': ['NO2', 'NC2', 'P2', 'COIL2', 'NO1', 'NC1', 'P1', 'COIL1'], 'mod-npn': ['C', 'B', 'E'], 'mod-diode': ['A', 'K'],
  'mod-mosfet': ['SIG', 'VCC', 'GND', 'VIN', 'GND.2', 'VIN.2', 'V-'], 'mod-pump': ['+', '-'], 'mod-ds18b20': ['GND', 'DQ', 'VDD'],
};
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function make(parts, connections, sketch, esp) {
  const sim = new Simulator(), els = new Map(), model = { parts: [], connections };
  for (const [id, type, attrs = {}] of parts) { model.parts.push({ id, type, attrs, left: 0, top: 0 }); els.set(id, new Stub(type, PINS[type])); }
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l.text)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  const d = sim.build(model, els); if (d.errors.length) throw new Error(d.errors.join('; '));
  const prog = compile(sketch, esp); if (esp) await sim.loadWasm(prog); else sim.loadHex(prog);
  sim.running = true; return { sim, els, model };
}
const run = (sim, ms, each) => { for (let t = 0; t < ms; t += 20) { sim.advance(20); each?.(); } };
const { BY_TAG } = await import('../src/catalog.js');
const drc = (model) => checkDesign(model, new Map(model.parts.map((p) => [p.id, new Stub(p.type, PINS[p.type])])));

// 1. ESP32 + HC-SR04 with the ECHO divider: distance still measured, GPIO sits at 2/3 of 5 V, no 5 V warning
{
  const parts = [['esp', 'wokwi-esp32-devkit-v1'], ['s', 'wokwi-hc-sr04', { distance: 57 }], ['r1', 'wokwi-resistor', { value: '1000' }], ['r2', 'wokwi-resistor', { value: '2000' }]];
  const W = [['s:VCC', 'esp:VIN'], ['s:GND', 'esp:GND.1'], ['s:TRIG', 'esp:D4'], ['s:ECHO', 'r1:1'], ['r1:2', 'esp:D13'], ['r2:1', 'esp:D13'], ['r2:2', 'esp:GND.2']];
  const { sim } = await make(parts, W, `void setup(){Serial.begin(115200);pinMode(4,OUTPUT);pinMode(13,INPUT);}
void loop(){digitalWrite(4,LOW);delayMicroseconds(2);digitalWrite(4,HIGH);delayMicroseconds(10);digitalWrite(4,LOW);
long us=pulseIn(13,HIGH,30000);Serial.print("cm=");Serial.println(us/58.0);delay(200);}`, true);
  run(sim, 1200);
  const cm = +(sim.serial.match(/cm=([\d.]+)/g) || []).pop()?.slice(3);
  ok(Math.abs(cm - 57) < 1.5, `HC-SR04 through 1k/2k divider reads ${cm} cm (57 set)`);
  const s = sim.circuit.solve({ strong: [...sim.rails, { net: sim.circuit.net('s', 'ECHO'), value: 1, label: 'echo' }], weak: sim.behaviors.flatMap((b) => b.weak?.() || []) });
  const v = s.v(sim.circuit.net('esp', 'D13')) * 5;
  ok(Math.abs(v - 3.33) < 0.05, `divided ECHO level at the GPIO = ${v.toFixed(2)} V (expected 3.33 V)`);
  const direct = [['s:VCC', 'esp:VIN'], ['s:GND', 'esp:GND.1'], ['s:TRIG', 'esp:D4'], ['s:ECHO', 'esp:D13']];
  ok(drc({ parts: parts.slice(0, 2).map(([id, type, attrs]) => ({ id, type, attrs })), connections: direct }).some((r) => /3,3 V|3\.3 V/.test(r.text) && r.level !== 'info'), 'DRC warns when ECHO goes straight into the ESP32');
  ok(!drc({ parts: parts.map(([id, type, attrs]) => ({ id, type, attrs })), connections: W }).some((r) => /5 V|3,3 V|3\.3 V/.test(r.text) && r.level !== 'info'), 'DRC accepts the divided ECHO line');
}
// 2. Uno + LED through 220 ohm blinks; ring through 330 ohm DIN lights (AVR bit-banged NeoPixel)
{
  const parts = [['uno', 'wokwi-arduino-uno'], ['led', 'wokwi-led'], ['r', 'wokwi-resistor', { value: '220' }], ['ring', 'wokwi-led-ring', { pixels: 16 }], ['rd', 'wokwi-resistor', { value: '330' }], ['c', 'mod-capacitor', { value: '1000' }]];
  const W = [['uno:3', 'r:1'], ['r:2', 'led:A'], ['led:C', 'uno:GND.1'], ['uno:6', 'rd:1'], ['rd:2', 'ring:DIN'], ['ring:VCC', 'uno:5V'], ['ring:GND', 'uno:GND.2'], ['c:+', 'uno:5V'], ['c:-', 'uno:GND.3']];
  const { sim, els } = await make(parts, W, `#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel ring(16, 6, NEO_GRB + NEO_KHZ800);
void setup(){pinMode(3,OUTPUT);ring.begin();}
void loop(){digitalWrite(3,(millis()/250)%2);for(int i=0;i<16;i++)ring.setPixelColor(i,ring.Color(0,40,0));ring.show();delay(50);}`, false);
  const seen = new Set(); run(sim, 1500, () => seen.add(!!els.get('led').value));
  ok(seen.has(true) && seen.has(false), 'LED behind 220 ohm blinks');
  ok(els.get('ring').lit > 0, `NeoPixel ring behind 330 ohm on DIN receives data (${els.get('ring').lit} pixel writes)`);
}
// 3. bare KS2E relay: coil switched by NPN (base through 1k), flyback diode across the coil
{
  const parts = [['uno', 'wokwi-arduino-uno'], ['k', 'wokwi-ks2e-m-dc5'], ['q', 'mod-npn'], ['rb', 'wokwi-resistor', { value: '1000' }], ['d', 'mod-diode']];
  const W = [['k:COIL1', 'uno:5V'], ['k:COIL2', 'q:C'], ['q:E', 'uno:GND.1'], ['uno:8', 'rb:1'], ['rb:2', 'q:B'], ['d:K', 'k:COIL1'], ['d:A', 'k:COIL2']];
  const { sim } = await make(parts, W, 'void setup(){pinMode(8,OUTPUT);} void loop(){digitalWrite(8,(millis()/500)%2);delay(10);}', false);
  const kb = sim.behaviors.find((b) => b._part.id === 'k'), states = new Set();
  run(sim, 2000, () => states.add(kb.switches()[0][1] === sim.circuit.net('k', 'NO1')));
  ok(states.has(true) && states.has(false), 'relay coil driven through NPN + 1k toggles NO/NC');
  ok(!sim.logs.some((t) => /langsung ke pin/.test(t)), 'no "coil connected directly to a pin" warning');
}
// 4. pump through the IRF520 MOSFET module on a PWM pin
{
  const parts = [['esp', 'wokwi-esp32-devkit-v1'], ['f', 'mod-mosfet'], ['p', 'mod-pump']];
  const W = [['f:SIG', 'esp:D25'], ['f:GND', 'esp:GND.1'], ['f:VCC', 'esp:3V3'], ['f:VIN', 'esp:VIN'], ['p:+', 'esp:VIN'], ['p:-', 'f:V-']];
  const { sim, els } = await make(parts, W, 'void setup(){pinMode(25,OUTPUT);} void loop(){analogWrite(25,200);delay(10);}', true);
  run(sim, 1500);
  ok((els.get('p').angle || 0) > 30, `pump driven by MOSFET module turns (angle ${Math.round(els.get('p').angle || 0)}°)`);
  ok(!sim.logs.some((t) => /langsung ke pin/.test(t)), 'no "motor connected directly to a pin" warning');
}
// 5. the suggestion rules: each case proposes the right parts (pure function on a fake canvas)
{
  const { suggestExtras } = await import('../src/learn/extras.js');
  const fake = (parts, wires) => ({
    parts: new Map(parts.map(([id, type, attrs = {}]) => [id, { id, type, attrs, x: 0, y: 0, pinInfo: (PINS[type] || []).map((name) => ({ name })) }])),
    wires: wires.map(([a, b]) => ({ a, b })),
  });
  const BYT = BY_TAG;
  try {
    const s1 = suggestExtras(fake([['esp', 'wokwi-esp32-devkit-v1'], ['s', 'wokwi-hc-sr04']], [['s:VCC', 'esp:VIN'], ['s:GND', 'esp:GND.1'], ['s:TRIG', 'esp:D4'], ['s:ECHO', 'esp:D13']]), BYT);
    ok(s1.some((x) => /pembagi/.test(x.title)), 'HC-SR04 ECHO straight into ESP32 → divider suggested');
    const s2 = suggestExtras(fake([['uno', 'wokwi-arduino-uno'], ['led', 'wokwi-led']], [['led:A', 'uno:3'], ['led:C', 'uno:GND.1']]), BYT);
    ok(s2.some((x) => /220/.test(x.title)), 'LED straight on a pin → 220 ohm suggested');
    const s3 = suggestExtras(fake([['uno', 'wokwi-arduino-uno'], ['led', 'wokwi-led'], ['r', 'wokwi-resistor', { value: '220' }]], [['uno:3', 'r:1'], ['r:2', 'led:A'], ['led:C', 'uno:GND.1']]), BYT);
    ok(!s3.length, 'LED that already has its resistor → nothing suggested');
  } catch (e) { ok(false, 'suggestExtras on a fake canvas: ' + e.message); }
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
