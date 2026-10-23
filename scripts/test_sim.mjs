// End-to-end headless test of the simulator logic with stub DOM elements and REAL compiled sketches.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;

function compile(src) {
  writeFileSync('/tmp/_s.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch
print(json.dumps(compile_sketch(open('/tmp/_s.ino').read())))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.hex) throw new Error('compile failed: ' + r.stderr); return r.hex;
}
class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  fire(e, detail) { (this.l[e] || []).forEach((f) => f({ detail })); }
}
const UNO = ['A5.2','A4.2','AREF','GND.1','13','12','11','10','9','8','7','6','5','4','3','2','1','0','IOREF','RESET','3.3V','5V','GND.2','GND.3','VIN','A0','A1','A2','A3','A4','A5'];
const fakeFont = new Uint8Array(256 * 8).fill(0);
function circuit(partsDef, conns) {
  const model = { parts: [{ id: 'uno', type: 'wokwi-arduino-uno', attrs: {} }], connections: conns };
  const els = new Map([['uno', new Stub('wokwi-arduino-uno', UNO)]]);
  for (const [id, type, pins, props, attrs] of partsDef) { model.parts.push({ id, type, attrs: attrs || {} }); els.set(id, new Stub(type, pins, props)); }
  return { model, els };
}
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const make = (def, conns, sketch, opts = {}) => {
  const sim = new Simulator(); const { model, els } = circuit(def, conns);
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  const diag = sim.build(model, els); sim.loadHex(compile(sketch));
  return { sim, els, diag };
};

// 1. LED blink through a resistor
{
  const { sim, els } = make([['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'uno:GND.1']],
    'void setup(){pinMode(13,OUTPUT);} void loop(){digitalWrite(13,HIGH);delay(500);digitalWrite(13,LOW);delay(500);}');
  const led = els.get('led1'); const seen = [];
  for (let i = 0; i < 40; i++) { sim.advance(50); seen.push(led.value); }
  const flips = seen.filter((v, i) => i && v !== seen[i - 1]).length;
  ok(flips >= 3 && flips <= 5 && seen.includes(true) && seen.includes(false), `LED blinks ~1 Hz via resistor (flips in 2s: ${flips})`);
  ok(!sim.logs.some((l) => /resistor pembatas/.test(l.text)), 'no false "LED without resistor" warning');
}
// 2. LED without resistor -> warning
{
  const { sim } = make([['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]], [['uno:13', 'led1:A'], ['led1:C', 'uno:GND.1']],
    'void setup(){pinMode(13,OUTPUT);digitalWrite(13,HIGH);} void loop(){}');
  sim.advance(50);
  ok(sim.logs.some((l) => /resistor pembatas/.test(l.text)), 'warns when LED has no series resistor');
}
// 3. Pushbutton INPUT_PULLUP -> Serial
{
  const { sim, els } = make([['b1', 'wokwi-pushbutton', ['1.l', '2.l', '1.r', '2.r']]], [['uno:2', 'b1:1.l'], ['b1:2.r', 'uno:GND.1']],
    'void setup(){Serial.begin(9600);pinMode(2,INPUT_PULLUP);} int last=-1; void loop(){int s=digitalRead(2); if(s!=last){Serial.print(s);Serial.print(\' \');last=s;} delay(5);}');
  sim.advance(100); els.get('b1').fire('button-press'); sim.advance(100); els.get('b1').fire('button-release'); sim.advance(100);
  ok(sim.serial.trim() === '1 0 1', 'pull-up button reads 1, 0 (pressed), 1: ' + JSON.stringify(sim.serial));
}
// 4. Potentiometer -> analogRead
{
  const pot = new Stub('wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { min: 0, max: 1023, value: 256 });
  const { sim } = make([['p1', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { min: 0, max: 1023, value: 256 }, { value: 25 }]],
    [['p1:VCC', 'uno:5V'], ['p1:GND', 'uno:GND.2'], ['p1:SIG', 'uno:A0']],
    'void setup(){Serial.begin(9600);} void loop(){Serial.println(analogRead(A0));delay(50);}');
  sim.advance(200);
  const vals = sim.serial.trim().split(/\r?\n/).map(Number);
  const v = vals[vals.length - 1];
  ok(Math.abs(v - 256) <= 2, `analogRead(A0) with pot at 256/1023 -> ${v}`);
}
// 5. HC-SR04 distance
{
  const { sim } = make([['u1', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND'], {}, { distance: 100 }]],
    [['u1:VCC', 'uno:5V'], ['u1:GND', 'uno:GND.1'], ['u1:TRIG', 'uno:9'], ['u1:ECHO', 'uno:10']],
    'void setup(){Serial.begin(9600);pinMode(9,OUTPUT);pinMode(10,INPUT);} void loop(){digitalWrite(9,LOW);delayMicroseconds(2);digitalWrite(9,HIGH);delayMicroseconds(10);digitalWrite(9,LOW);long d=pulseIn(10,HIGH,30000);Serial.println(d/58);delay(100);}');
  sim.advance(500);
  const vals = sim.serial.trim().split(/\r?\n/).map(Number); const v = vals[vals.length - 1];
  ok(Math.abs(v - 100) <= 2, `HC-SR04 at 100 cm -> Arduino measures ${v} cm`);
}
// 6. Servo
{
  const { sim, els } = make([['s1', 'wokwi-servo', ['GND', 'V+', 'PWM'], { angle: 0 }]],
    [['s1:GND', 'uno:GND.1'], ['s1:V+', 'uno:5V'], ['s1:PWM', 'uno:9']],
    '#include <Servo.h>\nServo s; void setup(){s.attach(9);s.write(135);} void loop(){}');
  sim.advance(300);
  ok(Math.abs(els.get('s1').angle - 135) <= 2, `Servo.write(135) -> element angle ${els.get('s1').angle.toFixed(1)}`);
}
// 7. LCD 16x2 via LiquidCrystal
{
  const pins = ['VSS','VDD','V0','RS','RW','E','D0','D1','D2','D3','D4','D5','D6','D7','A','K'];
  const { sim, els, diag } = make([['lcd', 'wokwi-lcd1602', pins, { font: fakeFont, characters: [], cursor: false, blink: false }]],
    [['lcd:VSS', 'uno:GND.1'], ['lcd:VDD', 'uno:5V'], ['lcd:RW', 'uno:GND.2'], ['lcd:RS', 'uno:12'], ['lcd:E', 'uno:11'],
     ['lcd:D4', 'uno:5'], ['lcd:D5', 'uno:4'], ['lcd:D6', 'uno:3'], ['lcd:D7', 'uno:2']],
    '#include <LiquidCrystal.h>\nLiquidCrystal lcd(12,11,5,4,3,2); void setup(){lcd.begin(16,2);lcd.print("Hello, Afta!");lcd.setCursor(0,1);lcd.print("Line two 123");} void loop(){}');
  sim.advance(300);
  const chars = Array.from(els.get('lcd').characters).map((c) => String.fromCharCode(c)).join('');
  ok(chars.slice(0, 16).trim() === 'Hello, Afta!' && chars.slice(16).trim() === 'Line two 123', 'LCD shows both lines: ' + JSON.stringify(chars));
}
// 8. LCD with a missing wire -> warning
{
  const pins = ['VSS','VDD','V0','RS','RW','E','D0','D1','D2','D3','D4','D5','D6','D7','A','K'];
  const { sim } = make([['lcd', 'wokwi-lcd1602', pins, { font: fakeFont, characters: [] }]], [['lcd:RS', 'uno:12'], ['lcd:E', 'uno:11']],
    '#include <LiquidCrystal.h>\nLiquidCrystal lcd(12,11,5,4,3,2); void setup(){lcd.begin(16,2);lcd.print("x");} void loop(){}');
  sim.advance(50);
  const msg = sim.logs.map((l) => l.text).join('|');
  ok(/lcd: pin D4, D5, D6, D7 belum terhubung ke Arduino/.test(msg), 'LCD missing-pin warning names the exact pins: ' + (sim.logs.find((l) => /lcd/.test(l.text))?.text ?? 'none'));
}
// 9. NeoPixel red
{
  const { sim, els } = make([['px', 'wokwi-neopixel', ['VDD', 'DOUT', 'VSS', 'DIN'], { r: 0, g: 0, b: 0 }]],
    [['px:DIN', 'uno:6']],
    '#include <Adafruit_NeoPixel.h>\nAdafruit_NeoPixel p(1,6,NEO_GRB+NEO_KHZ800); void setup(){p.begin();p.setPixelColor(0,p.Color(255,0,0));p.show();} void loop(){}');
  sim.advance(200); const e = els.get('px');
  ok(e.r > 0.95 && e.g < 0.05 && e.b < 0.05, `NeoPixel red -> r=${e.r} g=${e.g} b=${e.b}`);
}
// 10. Buzzer tone
{
  const { sim, els } = make([['bz', 'wokwi-buzzer', ['1', '2'], { hasSignal: false }]], [['bz:1', 'uno:8'], ['bz:2', 'uno:GND.1']],
    'void setup(){tone(8,440);} void loop(){}');
  let tones = []; sim.audio.tone = (id, f) => tones.push(f); sim.audio.off = () => {};
  sim.advance(300);
  ok(els.get('bz').hasSignal === true && Math.abs(tones[tones.length - 1] - 440) < 6, `tone(8,440) -> hasSignal ${els.get('bz').hasSignal}, ${tones[tones.length - 1]?.toFixed(0)} Hz`);
}
// 11. Short circuit
{
  const { sim } = make([], [['uno:13', 'uno:GND.1']], 'void setup(){pinMode(13,OUTPUT);digitalWrite(13,HIGH);} void loop(){}');
  sim.advance(50);
  ok(sim.logs.some((l) => /Korsleting/.test(l.text)), 'short circuit warning: ' + (sim.logs.find((l) => /Korsleting/.test(l.text))?.text ?? 'none'));
}
// 12. No board
{
  const sim = new Simulator(); const model = { parts: [{ id: 'led1', type: 'wokwi-led', attrs: {} }], connections: [] };
  const diag = sim.build(model, new Map([['led1', new Stub('wokwi-led', ['A', 'C'])]]));
  ok(diag.errors.length === 1 && /board/i.test(diag.errors[0]), 'no board -> error: ' + diag.errors[0]);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
