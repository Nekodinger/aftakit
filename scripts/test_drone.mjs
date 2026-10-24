// Motors (brushed + brushless/ESC), LiPo, RC receiver and LIDAR on AVR boards (real libraries, avr-gcc).
import { make, ok, done, lines, logText } from './testkit.mjs';

const ESC = ['BAT+', 'BAT-', 'A', 'B', 'C', 'SIG', '5V', 'GND'];
const LIPO = ['+', '-'];
const bh = (sim, id) => sim.behaviors.find((b) => b._part.id === id);
const run = (sim, ms) => { sim.running = true; for (let t = 0; t < ms; t += 20) sim.advance(20); };

// 1. ESC arming + A2212/1045 on 3S at full throttle: rpm, thrust, current and battery sag close to bench data
{
  const { sim } = make([['esc1', 'mod-esc', ESC], ['m1', 'mod-bldc-a2212', ['A', 'B', 'C']], ['bat', 'mod-lipo', LIPO]],
    [['bat:+', 'esc1:BAT+'], ['bat:-', 'esc1:BAT-'], ['esc1:A', 'm1:A'], ['esc1:B', 'm1:B'], ['esc1:C', 'm1:C'], ['esc1:SIG', 'uno:9'], ['esc1:GND', 'uno:GND.1']],
    `#include <Servo.h>
Servo esc;
void setup(){ esc.attach(9, 1000, 2000); esc.writeMicroseconds(1000); delay(1500); esc.writeMicroseconds(2000); }
void loop(){}`);
  run(sim, 1200);
  const r = bh(sim, 'm1').rotor, b = bh(sim, 'bat');
  ok(Math.abs(r.rpm) < 1 && /ARMED/.test(logText(sim)), `ESC arms on 1000 µs, motor still: ${r.rpm.toFixed(0)} rpm`);
  run(sim, 2500);
  const g = r.thrust / 9.80665 * 1000;
  ok(r.rpm > 7300 && r.rpm < 8200 && g > 800 && g < 1000, `full throttle, fresh 3S (12.6 V open circuit; bench data 7270 rpm / 840 g at 11.1 V): ${r.rpm.toFixed(0)} rpm, ${g.toFixed(0)} g thrust`);
  ok(r.I > 12 && r.I < 17 && b.V < 12.3 && b.V > 10.5, `current ${r.I.toFixed(1)} A, battery under load ${b.V.toFixed(2)} V`);
}
// 2. throttle high at power-up: the ESC refuses to arm (safety)
{
  const { sim } = make([['esc1', 'mod-esc', ESC], ['m1', 'mod-bldc-a2212', ['A', 'B', 'C']], ['bat', 'mod-lipo', LIPO]],
    [['bat:+', 'esc1:BAT+'], ['bat:-', 'esc1:BAT-'], ['esc1:A', 'm1:A'], ['esc1:B', 'm1:B'], ['esc1:C', 'm1:C'], ['esc1:SIG', 'uno:9'], ['esc1:GND', 'uno:GND.1']],
    `#include <Servo.h>
Servo esc; void setup(){ esc.attach(9); esc.writeMicroseconds(1500); } void loop(){}`);
  run(sim, 2500);
  ok(Math.abs(bh(sim, 'm1').rotor.rpm) < 1 && /tidak mau arm/.test(logText(sim)), 'no arming with throttle at 1500 µs on power-up');
}
// 3. coreless 8520 straight on a 1S LiPo; TT motor on a 9 V battery warns about over-voltage
{
  const { sim } = make([['m1', 'mod-motor-coreless', ['+', '-']], ['bat', 'mod-lipo', LIPO, {}, { cells: '1S', capacity: '500' }], ['tt', 'mod-motor-tt', ['+', '-']], ['b9', 'mod-battery9v', ['+', '-']]],
    [['bat:+', 'm1:+'], ['bat:-', 'm1:-'], ['b9:+', 'tt:+'], ['b9:-', 'tt:-']], 'void setup(){} void loop(){}');
  run(sim, 800);
  const r = bh(sim, 'm1').rotor, g = r.thrust / 9.80665 * 1000;
  ok(r.rpm > 17000 && r.rpm < 24000 && g > 25 && g < 42, `coreless 8520 + 65 mm on 1S: ${r.rpm.toFixed(0)} rpm, ${g.toFixed(1)} g, ${r.I.toFixed(2)} A`);
  ok(/melebihi batas motor 6 V/.test(logText(sim)), 'TT motor on 9 V: over-voltage warning');
  ok(bh(sim, 'tt').rotor.rpm > 0, `TT turns: ${(bh(sim, 'tt').rotor.rpm / 48).toFixed(0)} rpm at the gearbox output`);
}
// 4. swapping two phases reverses the motor (reported by the drone frame)
{
  const { sim } = make([['esc1', 'mod-esc', ESC], ['m1', 'mod-bldc-a2212', ['A', 'B', 'C']], ['bat', 'mod-lipo', LIPO]],
    [['bat:+', 'esc1:BAT+'], ['bat:-', 'esc1:BAT-'], ['esc1:A', 'm1:B'], ['esc1:B', 'm1:A'], ['esc1:C', 'm1:C'], ['esc1:SIG', 'uno:9'], ['esc1:GND', 'uno:GND.1']],
    'void setup(){} void loop(){}');
  run(sim, 100);
  const e = sim._phys.rotors[0];
  ok(e.dir() === -1, 'A↔B swapped: reversed rotation detected');
}
// 5. VL53L0X with the Pololu library and with Adafruit_VL53L0X (ST API)
{
  const { sim } = make([['tof', 'mod-vl53l0x', ['VIN', 'GND', 'SCL', 'SDA', 'GPIO1', 'XSHUT'], {}, { distance: '734' }]],
    [['tof:VIN', 'uno:5V'], ['tof:GND', 'uno:GND.1'], ['tof:SDA', 'uno:A4'], ['tof:SCL', 'uno:A5']],
    `#include <Wire.h>
#include <VL53L0X.h>
VL53L0X s;
void setup(){ Serial.begin(115200); Wire.begin(); s.setTimeout(500); Serial.println(s.init() ? "init ok" : "init fail"); }
void loop(){ Serial.println(s.readRangeSingleMillimeters()); delay(100); }`);
  run(sim, 600);
  const l = lines(sim);
  ok(l[0] === 'init ok' && Math.abs(+l[2] - 734) <= 4, `Pololu VL53L0X: ${l.slice(0, 3).join(' | ')}`);
}
{
  const { sim } = make([['tof', 'mod-vl53l0x', ['VIN', 'GND', 'SCL', 'SDA', 'GPIO1', 'XSHUT'], {}, { distance: '412' }]],
    [['tof:VIN', 'uno:5V'], ['tof:GND', 'uno:GND.1'], ['tof:SDA', 'uno:A4'], ['tof:SCL', 'uno:A5']],
    `#include <Adafruit_VL53L0X.h>
Adafruit_VL53L0X lox;
void setup(){ Serial.begin(115200); Serial.println(lox.begin() ? "begin ok" : "begin fail"); }
void loop(){ VL53L0X_RangingMeasurementData_t m; lox.rangingTest(&m, false); Serial.print(m.RangeStatus); Serial.print(" "); Serial.println(m.RangeMilliMeter); delay(100); }`);
  run(sim, 900);
  const l = lines(sim), last = l.at(-1)?.split(' ') || [];
  ok(l[0] === 'begin ok' && last[0] !== '4' && Math.abs(+last[1] - 412) <= 4, `Adafruit VL53L0X: ${l.slice(0, 3).join(' | ')}`);
}
// 6. TF-Luna on Mega Serial1 with TFMPlus, and RC receiver: pulseIn on PWM channels + iBUS on Serial2 (IBusBM)
{
  const { sim } = make([['tf', 'mod-tfluna', ['5V', 'RXD', 'TXD', 'GND'], {}, { distance: '321' }]],
    [['tf:5V', 'uno:5V'], ['tf:GND', 'uno:GND.1'], ['tf:TXD', 'uno:19'], ['tf:RXD', 'uno:18']],
    `#include <TFMPlus.h>
TFMPlus tfm; int16_t d = 0, f = 0, t = 0;
void setup(){ Serial.begin(115200); Serial1.begin(115200); tfm.begin(&Serial1); }
void loop(){ if (tfm.getData(d, f, t)) { Serial.print(d); Serial.print(" "); Serial.println(t); } delay(50); }`, 'mega');
  run(sim, 600);
  const l = lines(sim).at(-1)?.split(' ') || [];
  ok(Math.abs(+l[0] - 321) <= 2 && +l[1] === 40, `TF-Luna via TFMPlus: ${lines(sim).slice(-2).join(' | ')}`);
}
{
  const { sim } = make([['rx', 'mod-rc-rx', ['VCC', 'GND', 'IBUS', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6']]],
    [['rx:VCC', 'uno:5V'], ['rx:GND', 'uno:GND.1'], ['rx:CH1', 'uno:2'], ['rx:CH3', 'uno:3']],
    `void setup(){ Serial.begin(115200); }
void loop(){ unsigned long a = pulseIn(2, HIGH, 30000), c = pulseIn(3, HIGH, 30000); Serial.print(a); Serial.print(" "); Serial.println(c); delay(30); }`);
  sim.rc.ch[0] = 1730; sim.rc.ch[2] = 1250;
  run(sim, 500);
  const l = lines(sim).at(-1)?.split(' ').map(Number) || [];
  ok(Math.abs(l[0] - 1730) < 12 && Math.abs(l[1] - 1250) < 12, `receiver PWM via pulseIn: ${lines(sim).at(-1)}`);
}
{
  const { sim } = make([['rx', 'mod-rc-rx', ['VCC', 'GND', 'IBUS', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6']]],
    [['rx:VCC', 'uno:5V'], ['rx:GND', 'uno:GND.1'], ['rx:IBUS', 'uno:17']],
    `#include <IBusBM.h>
IBusBM ib;
void setup(){ Serial.begin(115200); ib.begin(Serial2); }
void loop(){ for (int i = 0; i < 6; i++) { Serial.print(ib.readChannel(i)); Serial.print(i < 5 ? " " : "\\n"); } delay(50); }`, 'mega');
  sim.rc.ch[0] = 1730; sim.rc.ch[2] = 1250; sim.rc.ch[4] = 2000;
  run(sim, 500);
  ok(lines(sim).at(-1) === '1730 1500 1250 1500 2000 1000', `iBUS on Mega Serial2 (IBusBM): ${lines(sim).at(-1)}`);
}
{
  // PPM on CH1 read with a RISING-edge interrupt (8 channels)
  const { sim } = make([['rx', 'mod-rc-rx', ['VCC', 'GND', 'IBUS', 'CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6'], {}, { mode: 'PPM (8 kanal di CH1)' }]],
    [['rx:VCC', 'uno:5V'], ['rx:GND', 'uno:GND.1'], ['rx:CH1', 'uno:2']],
    `volatile unsigned long last = 0; volatile int idx = 0; volatile unsigned int ch[8];
void isr(){ unsigned long now = micros(), d = now - last; last = now; if (d > 3000) idx = 0; else if (idx < 8) ch[idx++] = d; }
void setup(){ Serial.begin(115200); attachInterrupt(digitalPinToInterrupt(2), isr, RISING); }
void loop(){ noInterrupts(); unsigned int a = ch[0], c = ch[2], e = ch[4]; interrupts(); Serial.print(a); Serial.print(" "); Serial.print(c); Serial.print(" "); Serial.println(e); delay(50); }`);
  sim.rc.ch[0] = 1600; sim.rc.ch[2] = 1100; sim.rc.ch[4] = 1900;
  run(sim, 500);
  const l = lines(sim).at(-1)?.split(' ').map(Number) || [];
  ok(Math.abs(l[0] - 1600) <= 8 && Math.abs(l[1] - 1100) <= 8 && Math.abs(l[2] - 1900) <= 8, `PPM decoded by interrupt: ${lines(sim).at(-1)}`);
}
// 7. mini brushed quadcopter: 4 coreless motors straight on a 1S LiPo lift a 40 g frame; reversed polarity is reported
{
  const parts = [['bat', 'mod-lipo', LIPO, {}, { cells: '1S', capacity: '500' }], ['frame', 'mod-drone-frame', [], {}, { preset: 'Mini brushed (±40 g)' }]];
  const conns = [];
  for (let i = 1; i <= 4; i++) { parts.push([`m${i}`, 'mod-motor-coreless', ['+', '-']]); conns.push(i === 3 ? ['bat:-', `m${i}:+`] : ['bat:+', `m${i}:+`], i === 3 ? ['bat:+', `m${i}:-`] : ['bat:-', `m${i}:-`]); }
  const { sim } = make(parts, conns, 'void setup(){} void loop(){}');
  run(sim, 600);
  const s = sim.drone.state;
  ok(/m3 \(Belakang-Kiri\) berputar terbalik/.test(logText(sim)), 'reversed coreless motor (polarity swapped) is reported');
  ok(s.crashed || s.p[2] > 0 || Math.abs(s.w[0]) + Math.abs(s.w[1]) > 0.5, `unbalanced thrust upsets the mini quad: z=${s.p[2].toFixed(2)} crashed=${s.crashed}`);
}
{
  const parts = [['bat', 'mod-lipo', LIPO, {}, { cells: '1S', capacity: '500' }], ['frame', 'mod-drone-frame', [], {}, { preset: 'Mini brushed (±40 g)' }]];
  const conns = [];
  for (let i = 1; i <= 4; i++) { parts.push([`m${i}`, 'mod-motor-coreless', ['+', '-']]); conns.push(['bat:+', `m${i}:+`], ['bat:-', `m${i}:-`]); }
  const { sim } = make(parts, conns, 'void setup(){} void loop(){}');
  run(sim, 600);
  const s = sim.drone.state;
  ok(s.p[2] > 1 && !s.crashed && Math.abs(s.w[0]) < 0.2, `mini quad on full power climbs straight: z=${s.p[2].toFixed(2)} m, thrust ${(s.thrust / 9.80665 * 1000).toFixed(0)} g vs 40 g`);
}
done();
