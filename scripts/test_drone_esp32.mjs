// Quadcopter flight on the ESP32 runtime: a real angle-mode flight controller (scripts/fc_esp32.ino) with MPU6050,
// iBUS receiver, 4 ESC + A2212/1045 on a 3S LiPo, F450 frame, TF-Luna altitude and BMP280.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const { euler } = await import('../src/sim/drone.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src, board = 'esp32') {
  writeFileSync('/tmp/_d.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_d.ino').read(), '${board}')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); return Buffer.from(r.wasm, 'base64');
}
class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
}
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ESCP = ['BAT+', 'BAT-', 'A', 'B', 'C', 'SIG', '5V', 'GND'];

export async function buildDrone(sketch, extra = {}) {
  const parts = [['mpu', 'wokwi-mpu6050', ['INT', 'AD0', 'XCL', 'XDA', 'SDA', 'SCL', 'GND', 'VCC']], ['bat', 'mod-lipo', ['+', '-']], ['frame', 'mod-drone-frame', []],
    ['rx', 'mod-rc-rx', ['VCC', 'GND', 'IBUS', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6']], ['tf', 'mod-tfluna', ['5V', 'RXD', 'TXD', 'GND']], ['baro', 'mod-bmp280', ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO']]];
  const conns = [['mpu:VCC', 'esp:3V3'], ['mpu:GND', 'esp:GND.1'], ['mpu:SDA', 'esp:D21'], ['mpu:SCL', 'esp:D22'], ['baro:VCC', 'esp:3V3'], ['baro:GND', 'esp:GND.1'], ['baro:SDA', 'esp:D21'], ['baro:SCL', 'esp:D22'],
    ['rx:VCC', 'esp:VIN'], ['rx:GND', 'esp:GND.1'], ['rx:IBUS', 'esp:RX2'], ['tf:5V', 'esp:VIN'], ['tf:GND', 'esp:GND.1'], ['tf:TXD', 'esp:D4']];
  const pins = ['D13', 'D12', 'D14', 'D27'];
  for (let i = 1; i <= 4; i++) {
    parts.push([`esc${i}`, 'mod-esc', ESCP], [`m${i}`, 'mod-bldc-a2212', ['A', 'B', 'C']]);
    conns.push([`bat:+`, `esc${i}:BAT+`], [`bat:-`, `esc${i}:BAT-`], [`esc${i}:A`, `m${i}:A`], [`esc${i}:B`, `m${i}:B`], [`esc${i}:C`, `m${i}:C`], [`esc${i}:SIG`, `esp:${pins[i - 1]}`], [`esc${i}:GND`, 'esp:GND.1']);
  }
  conns.push(['esc1:5V', 'esp:VIN']);
  const sim = new Simulator();
  const model = { parts: [{ id: 'esp', type: 'wokwi-esp32-devkit-v1', attrs: {} }, ...parts.map(([id, type, , attrs]) => ({ id, type, attrs: { ...(attrs || {}), ...(extra[id] || {}) } }))], connections: conns };
  const els = new Map([['esp', new Stub('wokwi-esp32-devkit-v1', ESP)], ...parts.map(([id, type, p]) => [id, new Stub(type, p)])]);
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  sim.build(model, els); await sim.loadWasm(compile(sketch));
  return sim;
}
const runS = (sim, s) => { sim.running = true; for (let t = 0; t < s * 1000; t += 20) sim.advance(20); };
const st = (sim) => { const s = sim.drone.state, e = euler(s.q); return { z: s.p[2], x: s.p[0], y: s.p[1], roll: e[0], pitch: e[1], yaw: e[2], crashed: s.crashed }; };
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(' ');

if (process.argv[1].endsWith('test_drone_esp32.mjs')) {
  const sim = await buildDrone(readFileSync(new URL('./fc_esp32.ino', import.meta.url), 'utf8'));
  const rc = sim.rc.ch;
  runS(sim, 4);                                        // gyro calibration + ESC arming
  ok(/Siap/.test(sim.serial) && sim.logs.filter((l) => /ARMED/.test(l.text)).length === 4, `4 ESC armed, FC ready: ${sim.serial.split('\n').slice(0, 3).join(' | ')}`);
  rc[4] = 2000; runS(sim, 0.5);
  ok(/ARMED/.test(sim.serial), 'flight controller armed by CH5');
  rc[2] = 1480; runS(sim, 2);
  let s = st(sim);
  ok(s.z > 1 && !s.crashed && Math.abs(s.roll) < 3 && Math.abs(s.pitch) < 3, `take-off at 1480 µs, level climb: ${fmt(s)}`);
  rc[2] = 1442; runS(sim, 3); s = st(sim);
  ok(!s.crashed && Math.abs(s.roll) < 3 && Math.abs(s.pitch) < 3 && Math.abs(sim.drone.state.v[2]) < 0.5, `hover near 1442 µs: ${fmt(s)} vz=${sim.drone.state.v[2].toFixed(2)}`);
  { const h = sim.drone.range(), z = st(sim).z;
  ok(h > 0.3 && Math.abs(h - z - sim.drone.frame.h) < 0.2, `downward LIDAR range ${h.toFixed(2)} m at height ${z.toFixed(2)} m`); }
  rc[2] = 1470; const y0 = s.y; rc[0] = 1700; runS(sim, 1.2); s = st(sim);
  ok(s.roll > 6 && s.y < y0 - 0.3, `roll right stick: banks right and drifts right: ${fmt(s)}`);
  rc[0] = 1500; runS(sim, 1.5); s = st(sim);
  ok(Math.abs(s.roll) < 4, `stick centred: levels out again: ${fmt(s)}`);
  const x0 = s.x; rc[1] = 1700; runS(sim, 1.2); s = st(sim);
  ok(s.pitch > 6 && s.x > x0 + 0.3, `pitch forward stick: nose down, flies forward: ${fmt(s)}`);
  rc[1] = 1500; runS(sim, 1.5); const yaw0 = st(sim).yaw; rc[3] = 1700; runS(sim, 1); s = st(sim);
  const dyaw = ((s.yaw - yaw0 + 540) % 360) - 180;
  ok(dyaw < -20, `yaw right stick: heading turns clockwise ${dyaw.toFixed(0)}°`);
  rc[3] = 1500; runS(sim, 1);
  rc[2] = 1400; runS(sim, 6); s = st(sim);
  ok(s.z < 0.01 && !s.crashed, `landing at 1400 µs without crash: ${fmt(s)}`);
  rc[4] = 1000; runS(sim, 0.3);
  ok(/DISARMED/.test(sim.serial), 'disarm');
  const bat = sim.behaviors.find((b) => b._part.id === 'bat');
  ok(bat.soc < 0.995 && bat.soc > 0.9, `battery used: ${(100 - bat.soc * 100).toFixed(1)} % of 2200 mAh`);
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
}
