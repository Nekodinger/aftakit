// MQ-135 (datasheet Rs/R0 curves, load resistor, warm-up, comparator) and flex sensor (resistive divider).
import { make, ok, done, lines, logText } from './testkit.mjs';
const MQ = ['VCC', 'GND', 'DO', 'AO'];
const run = (sim, ms) => { sim.running = true; for (let t = 0; t < ms; t += 50) sim.advance(50); };
const part = (sim, id) => sim.model.parts.find((p) => p.id === id);

// 1. analogRead in clean air: warm-up drift, then Vc·RL/(Rs+RL) with Rs = 3.6·R0
{
  const { sim } = make([['mq', 'mod-mq135', MQ]], [['mq:VCC', 'uno:5V'], ['mq:GND', 'uno:GND.1'], ['mq:AO', 'uno:A0'], ['mq:DO', 'uno:7']],
    `void setup(){ Serial.begin(115200); } void loop(){ Serial.print(analogRead(A0)); Serial.print(" "); Serial.println(digitalRead(7)); delay(1000); }`);
  run(sim, 2500); const cold = +lines(sim).at(-1).split(' ')[0];
  run(sim, 90000); const [warm, d] = lines(sim).at(-1).split(' ').map(Number);
  const expect = 1023 * 10 / (54 + 10);
  ok(cold > warm + 50, `cold sensor reads high while warming up: ${cold} → ${warm}`);
  ok(Math.abs(warm - expect) < 12 && d === 1, `clean air ADC ${warm} (theory ${expect.toFixed(0)} for Rs = 54 kΩ, RL = 10 kΩ), DO HIGH`);
  part(sim, 'mq').attrs.co2 = 2000; run(sim, 2200);
  const [hi, d2] = lines(sim).at(-1).split(' ').map(Number);
  ok(hi > warm * 2.5 && d2 === 0, `2000 ppm CO2: ADC ${hi}, DO LOW (comparator tripped)`);
}
// 2. MQUnifiedsensor: calibrate R0 in clean air, then read CO2 and NH3 with the library's regression
{
  const { sim } = make([['mq', 'mod-mq135', MQ]], [['mq:VCC', 'uno:5V'], ['mq:GND', 'uno:GND.1'], ['mq:AO', 'uno:A0']],
    `#include <MQUnifiedsensor.h>
MQUnifiedsensor mq("Arduino UNO", 5, 10, A0, "MQ-135");
void setup(){ Serial.begin(115200); mq.setRegressionMethod(1); mq.init(); delay(80000);
  float r0 = 0; for (int i = 0; i < 10; i++) { mq.update(); r0 += mq.calibrate(3.6); } mq.setR0(r0 / 10); Serial.println(r0 / 10); }
void loop(){ mq.update(); mq.setA(110.47); mq.setB(-2.862); float co2 = mq.readSensor() + 400; mq.setA(102.2); mq.setB(-2.473); float nh = mq.readSensor();
  Serial.print(co2); Serial.print(" "); Serial.println(nh); delay(500); }`);
  run(sim, 81000);
  const r0 = +lines(sim)[0];
  part(sim, 'mq').attrs.co2 = 1000; run(sim, 1200);
  const co2 = +lines(sim).at(-1).split(' ')[0];
  part(sim, 'mq').attrs.co2 = 400; part(sim, 'mq').attrs.gas = 'NH3 (amonia)'; part(sim, 'mq').attrs.gasppm = 50; run(sim, 1200);
  const nh = +lines(sim).at(-1).split(' ')[1];
  ok(Math.abs(r0 - 15) < 1.2, `calibrated R0 = ${r0} kΩ (model 15 kΩ; library works in kΩ with RL = 10)`);
  ok(Math.abs(co2 - 1000) < 120, `MQUnifiedsensor CO2 at 1000 ppm: ${co2}`);
  ok(Math.abs(nh - 50) < 8, `MQUnifiedsensor NH3 at 50 ppm: ${nh}`);
}
// 3. MQ-135 on 3.3 V: heater warning
{
  const { sim } = make([['mq', 'mod-mq135', MQ]], [['mq:VCC', 'uno:3.3V'], ['mq:GND', 'uno:GND.1'], ['mq:AO', 'uno:A0']], 'void setup(){} void loop(){}');
  run(sim, 300);
  ok(/butuh 5 V/.test(logText(sim)), 'MQ-135 on 3.3 V warns about the heater supply');
}
// 4. flex sensor in a divider with 47 kΩ: flat vs 90°
{
  const { sim } = make([['fx', 'mod-flex', ['1', '2']], ['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '47000' }]],
    [['fx:1', 'uno:5V'], ['fx:2', 'uno:A0'], ['r1:1', 'uno:A0'], ['r1:2', 'uno:GND.1']],
    `void setup(){ Serial.begin(115200); } void loop(){ Serial.println(analogRead(A0)); delay(100); }`);
  run(sim, 300); const flat = +lines(sim).at(-1);
  part(sim, 'fx').attrs.angle = 90; run(sim, 300); const bent = +lines(sim).at(-1);
  const th = (r) => 1023 * 47 / (47 + r);
  ok(Math.abs(flat - th(25)) < 4 && Math.abs(bent - th(25 * (1 + 0.0156 * 90))) < 4, `flex divider: flat ${flat} (theory ${th(25).toFixed(0)}), 90° ${bent} (theory ${th(25 * 2.404).toFixed(0)})`);
}
// 5. flex sensor alone on an analog pin: floating-input warning; with INPUT_PULLUP the internal pull-up forms the divider
{
  const { sim } = make([['fx', 'mod-flex', ['1', '2']]], [['fx:1', 'uno:GND.1'], ['fx:2', 'uno:A0']],
    `void setup(){ Serial.begin(115200); } void loop(){ Serial.println(analogRead(A0)); delay(100); }`);
  run(sim, 300);
  ok(/butuh resistor pembagi/.test(logText(sim)), 'flex without divider resistor: warning');
  const b = make([['fx', 'mod-flex', ['1', '2']]], [['fx:1', 'uno:GND.1'], ['fx:2', 'uno:A0']],
    `void setup(){ Serial.begin(115200); pinMode(A0, INPUT_PULLUP); } void loop(){ Serial.println(analogRead(A0)); delay(100); }`).sim;
  run(b, 300); const v = +lines(b).at(-1);
  ok(Math.abs(v - 1023 * 25 / (25 + 35)) < 6, `INPUT_PULLUP (≈35 kΩ) + flex: ${v}`);
}
done();
