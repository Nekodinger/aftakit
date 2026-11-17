// 2WD robot car: ESP32 + L298N + TT motors on the chassis, driving physics, arena, HC-SR04 / TCRT5000 on the car.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src) {
  writeFileSync('/tmp/_car.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_car.ino').read(), 'esp32')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); return Buffer.from(r.wasm, 'base64');
}
class Stub { constructor(tag, pins) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; this.text = {}; } addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener() {} setLed() {} setText(k, t) { this.text[k] = t; } setRotor() {} }
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
const L298 = ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', '12V', 'GND', '5V'];
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const DRIVER = [['drv', 'mod-l298n', L298, {}, 400, 380], ['bat', 'mod-lipo', ['+', '-'], { cells: '2S' }, 230, 470]];
const WIRES = [['bat:+', 'drv:12V'], ['bat:-', 'drv:GND'], ['drv:GND', 'esp:GND.1'], ['drv:OUT1', 'car:ML+'], ['drv:OUT2', 'car:ML-'], ['drv:OUT3', 'car:MR+'], ['drv:OUT4', 'car:MR-'],
  ['drv:IN1', 'esp:D26'], ['drv:IN2', 'esp:D27'], ['drv:IN3', 'esp:D14'], ['drv:IN4', 'esp:D12']];
async function make(arena, extra, extraWires, sketch) {
  const sim = new Simulator();
  const parts = [['esp', 'wokwi-esp32-devkit-v1', ESP, {}, 250, 200, [100, 200]], ['car', 'mod-car-chassis', ['ML+', 'ML-', 'MR+', 'MR-'], { arena, mass: 600 }, 0, 0, [600, 700]], ...DRIVER, ...extra];
  const model = { parts: [], connections: [...WIRES, ...extraWires] }, els = new Map();
  for (const [id, type, pins, attrs = {}, left = 0, top = 0, size = [60, 60], rot = 0] of parts) { model.parts.push({ id, type, attrs: { ...attrs }, left, top, size, rot }); els.set(id, new Stub(type, pins)); }
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  const d = sim.build(model, els); if (d.errors.length) throw new Error(d.errors.join('; '));
  await sim.loadWasm(compile(sketch)); sim.running = true;
  return sim;
}
const run = (sim, ms) => { for (let t = 0; t < ms; t += 20) sim.advance(20); };
const car = (sim) => sim.behaviors.find((b) => b._part.id === 'car').car.pose;
const MOTOR_FN = `const int IN1 = 26, IN2 = 27, IN3 = 14, IN4 = 12;
void motors(int l, int r) { digitalWrite(IN1, l > 0); digitalWrite(IN2, l < 0); digitalWrite(IN3, r > 0); digitalWrite(IN4, r < 0); }
void initMotors() { pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT); pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT); }`;

// 1. both motors forward for 1.5 s, then stop: the car drives straight ahead and coasts to a halt
{
  const sim = await make('Lantai bebas', [], [], `${MOTOR_FN}
void setup() { initMotors(); motors(1, 1); delay(1500); motors(0, 0); }
void loop() { delay(10); }`);
  run(sim, 800); const v = car(sim).v;
  run(sim, 1700); const p = car(sim);
  ok(v > 0.4 && v < 0.75, `top speed with 2S LiPo through L298N: ${v.toFixed(2)} m/s (TT 1:48, 65 mm wheels)`);
  ok(p.z < -0.6 && p.z > -1.2 && Math.abs(p.x) < 0.01 && Math.abs(p.th) < 0.01 && Math.abs(p.v) < 0.02, `straight run then stop: x ${p.x.toFixed(3)} y ${(-p.z).toFixed(3)} m, heading ${(p.th * 57.3).toFixed(1)}°, v ${p.v.toFixed(3)}`);
  ok(/posisi 0\.00, 0\.[6-9]\d m/.test(sim.els.get('car').text.pose || '') || /posisi -?0\.00, 1\.\d\d m/.test(sim.els.get('car').text.pose || ''), `2D readout: ${sim.els.get('car').text.pose}`);
}
// 2. spin on the spot: left forward, right backward = clockwise turn, position unchanged
{
  const sim = await make('Lantai bebas', [], [], `${MOTOR_FN}
void setup() { initMotors(); motors(1, -1); delay(600); motors(0, 0); }
void loop() { delay(10); }`);
  run(sim, 1200); const p = car(sim);
  ok(p.th > 1.5 && Math.hypot(p.x, p.z) < 0.01, `pivot turn clockwise: heading ${(p.th * 57.3).toFixed(0)}°, moved ${(Math.hypot(p.x, p.z) * 1000).toFixed(1)} mm`);
}
// 3. obstacle avoidance: HC-SR04 at the front of the chassis reads the arena, the car stops ~20 cm before the wall
{
  const SONAR = [['sonar', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND'], {}, 210, 20, [180, 100], 2]];
  const sim = await make('Arena + rintangan', SONAR, [['sonar:TRIG', 'esp:D5'], ['sonar:ECHO', 'esp:D18'], ['sonar:VCC', 'drv:5V'], ['sonar:GND', 'esp:GND.1']], `${MOTOR_FN}
const int TRIG = 5, ECHO = 18;
long cm() { digitalWrite(TRIG, LOW); delayMicroseconds(2); digitalWrite(TRIG, HIGH); delayMicroseconds(10); digitalWrite(TRIG, LOW); return pulseIn(ECHO, HIGH, 30000) / 58; }
void setup() { Serial.begin(115200); initMotors(); pinMode(TRIG, OUTPUT); pinMode(ECHO, INPUT); Serial.printf("start %ld\\n", cm()); }
void loop() { long d = cm(); if (d > 20) motors(1, 1); else motors(0, 0); Serial.printf("d=%ld\\n", d); delay(40); }`);
  run(sim, 200);
  const first = +(sim.serial.match(/start (\d+)/) || [])[1];
  ok(Math.abs(first - 50) <= 2, `sonar on the car sees the red wall 50 cm ahead: ${first} cm (attr ${sim.model.parts.find((p) => p.id === 'sonar').attrs.distance})`);
  run(sim, 3000); const p = car(sim), last = +[...sim.serial.matchAll(/d=(\d+)/g)].pop()[1];
  ok(last >= 12 && last <= 21 && Math.abs(p.v) < 0.02 && !p.bumped, `drives up and stops before the obstacle: last reading ${last} cm, v ${p.v.toFixed(2)}, bumped ${p.bumped}`);
}
// 4. line track: TCRT5000 under the front-left of the car sits on the black line at the start pose
{
  const LINE = [['ln', 'mod-tcrt5000', ['VCC', 'GND', 'DO', 'AO'], {}, 260, 60, [40, 60]]];
  const sim = await make('Lintasan garis hitam', LINE, [['ln:DO', 'esp:D33'], ['ln:VCC', 'esp:3V3'], ['ln:GND', 'esp:GND.1']], `void setup() { Serial.begin(115200); pinMode(33, INPUT); }
void loop() { Serial.println(digitalRead(33)); delay(50); }`);
  run(sim, 200);
  ok(sim.model.parts.find((p) => p.id === 'ln').attrs.black === true && /1\s*$/.test(sim.serial), `TCRT5000 over the black line reads HIGH (black=${sim.model.parts.find((p) => p.id === 'ln').attrs.black})`);
}
// 5. pushing into a wall: the car stays inside the arena
{
  const sim = await make('Arena 2×2 m', [], [], `${MOTOR_FN}
void setup() { initMotors(); motors(1, 1); }
void loop() { delay(10); }`);
  run(sim, 4500); const p = car(sim);
  ok(Math.abs(p.z + 1.0 - 0.093) < 0.003 && p.bumped && /menabrak/.test(sim.logs.map((l) => l.text).join('\n')), `stops at the wall: y ${(-p.z).toFixed(3)} m, bumped ${p.bumped}`);
}
// 6. the three robot examples, as they are shipped (sizes of the 2D artwork as in the browser)
{
  const { EXAMPLES } = await import('../src/examples/defs.js');
  const SIZE = { 'mod-car-chassis': [600, 700], 'wokwi-esp32-devkit-v1': [107, 210], 'mod-l298n': [136, 136], 'mod-lipo': [160, 64], 'wokwi-hc-sr04': [170, 100], 'mod-tcrt5000': [52, 84] };
  const PINS = { 'mod-car-chassis': ['ML+', 'ML-', 'MR+', 'MR-'], 'wokwi-esp32-devkit-v1': ESP, 'mod-l298n': L298, 'mod-lipo': ['+', '-'], 'wokwi-hc-sr04': ['VCC', 'TRIG', 'ECHO', 'GND'], 'mod-tcrt5000': ['VCC', 'GND', 'DO', 'AO'] };
  const load = async (id) => {
    const ex = EXAMPLES.find((e) => e.id === id), sim = new Simulator(), els = new Map();
    const model = { parts: ex.parts.map((p) => ({ ...p, attrs: { ...p.attrs }, rot: ((p.rotate || 0) / 90) & 3, size: SIZE[p.type] })), connections: ex.wires };
    for (const p of model.parts) els.set(p.id, new Stub(p.type, PINS[p.type]));
    sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
    const d = sim.build(model, els); if (d.errors.length) throw new Error(d.errors.join('; '));
    await sim.loadWasm(compile(ex.code)); sim.running = true; return sim;
  };
  {
    const sim = await load('car-espnow');
    run(sim, 300); const p0 = { ...car(sim) };
    for (let i = 0; i < 5; i++) { sim.espnowSend([0x24, 0x6f, 0x28, 0xaa, 0xbb, 0xcc], [70]); run(sim, 200); }   // hold "maju" for 1 s
    const p1 = { ...car(sim) }; run(sim, 1200); const p2 = car(sim);
    ok(sim.espnowActive && /MAC mobil: 24:A1:60:2E:3C:10/.test(sim.serial), 'car-espnow boots, prints its MAC, ESP-NOW active');
    ok(p0.z === 0 && p1.z < -0.25 && p1.z > -0.47 && Math.abs(p1.x) < 0.02, `remote "F" held for 1 s drives the car forward ${(-p1.z).toFixed(2)} m (PWM 220/255)`);
    ok(Math.abs(p2.v) < 0.02 && /Perintah: F[\s\S]*Perintah: S/.test(sim.serial), `failsafe stops the car 0.5 s after the last packet (v ${p2.v.toFixed(3)})`);
  }
  {
    const sim = await load('car-avoid');
    let bumps = 0, minD = 999; const t0 = Date.now();
    for (let i = 0; i < 300; i++) { run(sim, 40); if (car(sim).bumped) bumps++; const d = +sim.model.parts.find((p) => p.id === 'sonar').attrs.distance; minD = Math.min(minD, d); }
    const p = car(sim), travelled = Math.hypot(p.x, p.z);
    ok(bumps === 0 && minD < 30 && travelled > 0.15, `car-avoid drives 12 s in the obstacle arena without hitting anything (closest ${minD} cm, ${travelled.toFixed(2)} m from start, ${(Date.now() - t0) / 1000}s wall)`);
  }
  {
    const sim = await load('car-line');
    const { arenaOf } = await import('../src/sim/car.js'); const t = arenaOf('Lintasan garis hitam').track;
    let worst = 0, path = 0, last = { ...car(sim) };
    for (let i = 0; i < 250; i++) {
      run(sim, 40); const p = car(sim); path += Math.hypot(p.x - last.x, p.z - last.z); last = { ...p };
      const cz = Math.max(-t.half, Math.min(t.half, p.z)); worst = Math.max(worst, Math.abs(Math.hypot(p.x, p.z - cz) - t.r));
    }
    ok(path > 1.5 && worst < 0.05, `car-line follows the oval: ${path.toFixed(2)} m driven in 10 s, farthest ${(worst * 1000).toFixed(0)} mm from the line`);
  }
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
