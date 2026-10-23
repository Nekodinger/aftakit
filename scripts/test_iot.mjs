// Headless tests for the extended parts library (IoT sensors, relays, motors, I2C devices, breadboard).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator, IDLE_HEX } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src) {
  writeFileSync('/tmp/_s.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch
print(json.dumps(compile_sketch(open('/tmp/_s.ino').read())))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.hex) throw new Error('compile failed: ' + r.stderr); return r.hex;
}
class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; this.leds = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  fire(e, detail) { (this.l[e] || []).forEach((f) => f({ detail })); }
  setLed(k, on) { this.leds[k] = on; }
  drawFrame(bits) { this.frame = bits; }
}
const UNO = ['A5.2','A4.2','AREF','GND.1','13','12','11','10','9','8','7','6','5','4','3','2','1','0','IOREF','RESET','3.3V','5V','GND.2','GND.3','VIN','A0','A1','A2','A3','A4','A5'];
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function make(def, conns, sketch, { board = true } = {}) {
  const sim = new Simulator();
  const model = { parts: board ? [{ id: 'uno', type: 'wokwi-arduino-uno', attrs: {} }] : [], connections: conns };
  const els = new Map(board ? [['uno', new Stub('wokwi-arduino-uno', UNO)]] : []);
  for (const [id, type, pins, props, attrs] of def) { model.parts.push({ id, type, attrs: attrs || {} }); els.set(id, new Stub(type, pins, props)); }
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  const diag = sim.build(model, els); sim.loadHex(sketch ? compile(sketch) : IDLE_HEX);
  return { sim, els, model, diag };
}
const runMs = (sim, ms) => { for (let t = 0; t < ms; t += 10) sim.advance(10); };

// 1. Relay module (active LOW) switches an LED powered by a 9V battery through COM/NO
{
  const { sim, els } = make([
    ['rel', 'mod-relay1', ['VCC', 'GND', 'IN', 'NO', 'COM', 'NC']],
    ['bat', 'mod-battery9v', ['+', '-']], ['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }],
  ], [['rel:VCC', 'uno:5V'], ['rel:GND', 'uno:GND.1'], ['rel:IN', 'uno:7'], ['bat:+', 'rel:COM'], ['rel:NO', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'bat:-']],
  `void setup(){pinMode(7,OUTPUT);} void loop(){digitalWrite(7,HIGH);delay(500);digitalWrite(7,LOW);delay(500);}`);
  runMs(sim, 250); const a = els.get('led1').value, ra = els.get('rel').leds.ch1;
  runMs(sim, 500); const b = els.get('led1').value, rb = els.get('rel').leds.ch1;
  ok(a === false && ra === false && b === true && rb === true, `relay active-LOW: IN HIGH -> LED off (${a}), IN LOW -> LED on via COM/NO (${b})`);
}
// 2. DHT22 with the real Adafruit DHT library
{
  const { sim } = make([['dht', 'wokwi-dht22', ['VCC', 'SDA', 'NC', 'GND']]], [['dht:VCC', 'uno:5V'], ['dht:GND', 'uno:GND.1'], ['dht:SDA', 'uno:2']],
    `#include <DHT.h>
DHT dht(2, DHT22);
void setup(){Serial.begin(115200); dht.begin();}
void loop(){ delay(2100); float h=dht.readHumidity(); float t=dht.readTemperature(); Serial.print("T="); Serial.print(t,1); Serial.print(" H="); Serial.println(h,1); }`);
  sim.model.parts.find((p) => p.id === 'dht').attrs = { temperature: 31.5, humidity: 72.5 };
  runMs(sim, 2600);
  ok(/T=31\.5 H=72\.5/.test(sim.serial), 'DHT22 (Adafruit DHT lib) reads T=31.5 H=72.5: ' + JSON.stringify(sim.serial.trim()));
}
// 3. DHT11 module, negative-free integer values
{
  const { sim } = make([['d', 'mod-dht11', ['VCC', 'DATA', 'GND']]], [['d:VCC', 'uno:5V'], ['d:GND', 'uno:GND.1'], ['d:DATA', 'uno:4']],
    `#include <DHT.h>
DHT dht(4, DHT11);
void setup(){Serial.begin(115200); dht.begin();}
void loop(){ delay(2100); Serial.print(dht.readTemperature(),0); Serial.print(','); Serial.println(dht.readHumidity(),0); }`);
  sim.model.parts.find((p) => p.id === 'd').attrs = { temperature: 27, humidity: 55 };
  runMs(sim, 2600);
  ok(/27,55/.test(sim.serial), 'DHT11 module reads 27,55: ' + JSON.stringify(sim.serial.trim()));
}
// 4. LCD 16x2 I2C (LiquidCrystal_I2C)
{
  const font = new Uint8Array(256 * 8);
  const { sim, els } = make([['lcd', 'x-lcd1602-i2c', ['GND', 'VCC', 'SDA', 'SCL'], { font, characters: null }]],
    [['lcd:GND', 'uno:GND.1'], ['lcd:VCC', 'uno:5V'], ['lcd:SDA', 'uno:A4'], ['lcd:SCL', 'uno:A5']],
    `#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27,16,2);
void setup(){ lcd.init(); lcd.backlight(); lcd.setCursor(0,0); lcd.print("Halo IoT KBS"); lcd.setCursor(0,1); lcd.print("Suhu: 28.5 C"); }
void loop(){}`);
  sim.model.parts.find((p) => p.id === 'lcd').attrs = { address: '0x27' };
  runMs(sim, 1400); // LiquidCrystal_I2C::begin() waits 1 s after power-up
  const txt = String.fromCharCode(...(els.get('lcd').characters || []));
  ok(txt.startsWith('Halo IoT KBS') && txt.slice(16).startsWith('Suhu: 28.5 C') && els.get('lcd').backlight === true, 'LCD I2C shows text + backlight: ' + JSON.stringify(txt));
}
// 5. OLED SSD1306 I2C with Adafruit library draws pixels
{
  const { sim, els } = make([['o', 'mod-oled-i2c', ['GND', 'VCC', 'SCL', 'SDA']]],
    [['o:GND', 'uno:GND.1'], ['o:VCC', 'uno:5V'], ['o:SDA', 'uno:A4'], ['o:SCL', 'uno:A5']],
    `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 d(128,64,&Wire,-1);
void setup(){ Serial.begin(115200); if(!d.begin(SSD1306_SWITCHCAPVCC,0x3C)) Serial.println("FAIL"); else Serial.println("OK");
 d.clearDisplay(); d.fillRect(0,0,10,5,SSD1306_WHITE); d.drawPixel(127,63,SSD1306_WHITE); d.display(); }
void loop(){}`);
  runMs(sim, 1500);
  const f = els.get('o').frame || [];
  const lit = f.reduce((a, b) => a + b, 0);
  ok(/OK/.test(sim.serial) && lit === 51 && f[0] === 1 && f[9 + 4 * 128] === 1 && f[10] === 0 && f[127 + 63 * 128] === 1, `OLED: begin OK, 51 lit pixels at the right places (lit=${lit})`);
}
// 6. MPU6050 raw registers via Wire
{
  const { sim } = make([['m', 'wokwi-mpu6050', ['INT', 'AD0', 'XCL', 'XDA', 'SDA', 'SCL', 'GND', 'VCC']]],
    [['m:GND', 'uno:GND.1'], ['m:VCC', 'uno:5V'], ['m:SDA', 'uno:A4'], ['m:SCL', 'uno:A5']],
    `#include <Wire.h>
void setup(){ Serial.begin(115200); Wire.begin(); Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();
 Wire.beginTransmission(0x68); Wire.write(0x75); Wire.endTransmission(false); Wire.requestFrom(0x68,1); Serial.print("WHO="); Serial.println(Wire.read(),HEX); }
void loop(){ Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false); Wire.requestFrom(0x68,14);
 int16_t v[7]; for(int i=0;i<7;i++){ v[i]=(Wire.read()<<8)|Wire.read(); }
 Serial.print("AX="); Serial.print(v[0]); Serial.print(" AZ="); Serial.print(v[2]); Serial.print(" GX="); Serial.println(v[4]); delay(200); }`);
  sim.model.parts.find((p) => p.id === 'm').attrs = { ax: 0.5, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 30 };
  runMs(sim, 400);
  ok(/WHO=68/.test(sim.serial) && /AX=8192 AZ=16384/.test(sim.serial), 'MPU6050 WHO_AM_I=0x68, ax=0.5g -> 8192, az=1g -> 16384: ' + JSON.stringify(sim.serial.split('\n').slice(0, 2).join(' | ')));
}
// 7. DS1307 via RTClib returns a plausible current date
{
  const { sim } = make([['rtc', 'wokwi-ds1307', ['GND', '5V', 'SDA', 'SCL', 'SQW']]],
    [['rtc:GND', 'uno:GND.1'], ['rtc:5V', 'uno:5V'], ['rtc:SDA', 'uno:A4'], ['rtc:SCL', 'uno:A5']],
    `#include <RTClib.h>
RTC_DS1307 rtc;
void setup(){ Serial.begin(115200); if(!rtc.begin()) Serial.println("NORTC"); DateTime n=rtc.now(); Serial.print("Y="); Serial.println(n.year()); }
void loop(){}`);
  runMs(sim, 300);
  ok(new RegExp('Y=' + new Date().getFullYear()).test(sim.serial), 'DS1307 (RTClib) year = current year: ' + JSON.stringify(sim.serial.trim()));
}
// 8. Soil moisture analog + digital output
{
  const { sim } = make([['s', 'mod-soil', ['VCC', 'GND', 'DO', 'AO']]], [['s:VCC', 'uno:5V'], ['s:GND', 'uno:GND.1'], ['s:AO', 'uno:A0'], ['s:DO', 'uno:8']],
    `void setup(){Serial.begin(115200);pinMode(8,INPUT);} void loop(){Serial.print(analogRead(A0));Serial.print(',');Serial.println(digitalRead(8));delay(100);}`);
  sim.model.parts.find((p) => p.id === 's').attrs = { level: 80, threshold: 50 };
  runMs(sim, 150);
  const m = [...sim.serial.matchAll(/(\d+),(\d)/g)].pop();
  ok(m && Math.abs(+m[1] - Math.round(1023 * (1 - 0.75 * 0.8))) <= 2 && m[2] === '0', `soil 80% wet -> ADC ${m && m[1]} (expect ~409), DO=${m && m[2]} (LOW = basah)`);
}
// 9. L298N drives a DC motor forward with PWM on ENA
{
  const { sim, els } = make([['drv', 'mod-l298n', ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', '12V', 'GND', '5V']],
    ['bat', 'mod-battery9v', ['+', '-']], ['m', 'mod-dc-motor', ['M+', 'M-'], { angle: 0 }]],
  [['bat:+', 'drv:12V'], ['bat:-', 'drv:GND'], ['drv:GND', 'uno:GND.1'], ['drv:IN1', 'uno:8'], ['drv:IN2', 'uno:7'], ['drv:ENA', 'uno:9'], ['drv:OUT1', 'm:M+'], ['drv:OUT2', 'm:M-']],
  `void setup(){pinMode(8,OUTPUT);pinMode(7,OUTPUT);digitalWrite(8,HIGH);digitalWrite(7,LOW);analogWrite(9,200);} void loop(){}`);
  runMs(sim, 200); const a1 = els.get('m').angle; runMs(sim, 200); const a2 = els.get('m').angle;
  ok(((a2 - a1 + 360) % 360) > 5 && ((a2 - a1 + 360) % 360) < 355, `L298N + motor spins forward (angle ${a1.toFixed(0)} -> ${a2.toFixed(0)})`);
  ok(!sim.logs.some((l) => /langsung ke pin Arduino/.test(l.text)), 'no "motor directly on Arduino pin" warning when using driver');
}
// 10. Motor directly on an Arduino pin -> warning
{
  const { sim } = make([['m', 'mod-dc-motor', ['M+', 'M-'], { angle: 0 }]], [['m:M+', 'uno:9'], ['m:M-', 'uno:GND.1']], `void setup(){} void loop(){}`);
  ok(sim.logs.some((l) => /langsung ke pin Arduino \(9\)/.test(l.text)), 'warns when a motor is connected directly to pin 9');
}
// 11. Breadboard strips join parts (LED via breadboard columns)
{
  const bbPins = []; for (let c = 1; c <= 30; c++) for (const r of 'abcde') bbPins.push(`T${c}.${r}`); for (let c = 1; c <= 30; c++) for (const r of 'fghij') bbPins.push(`B${c}.${r}`);
  const { sim, els } = make([['bb', 'x-breadboard-half', bbPins], ['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:13', 'bb:T5.a'], ['r1:1', 'bb:T5.c'], ['r1:2', 'bb:T10.c'], ['led1:A', 'bb:T10.e'], ['led1:C', 'bb:B10.f'], ['bb:B11.j', 'uno:GND.1']],
    `void setup(){pinMode(13,OUTPUT);digitalWrite(13,HIGH);} void loop(){}`);
  runMs(sim, 50);
  ok(els.get('led1').value === false, 'breadboard: different columns are NOT connected (GND on column 11, LED cathode on 10 -> off)');
  const { sim: s2, els: e2 } = make([['bb', 'x-breadboard-half', bbPins], ['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:13', 'bb:T5.a'], ['r1:1', 'bb:T5.c'], ['r1:2', 'bb:T10.c'], ['led1:A', 'bb:T10.e'], ['led1:C', 'bb:T11.a'], ['bb:T11.d', 'uno:GND.1']],
    `void setup(){pinMode(13,OUTPUT);digitalWrite(13,HIGH);} void loop(){}`);
  runMs(s2, 50);
  ok(e2.get('led1').value === true, 'breadboard: same column a–e is one strip (LED on)');
}
// 12. Board-less circuit: battery + resistor + LED lights up
{
  const { sim, els } = make([['bat', 'mod-battery9v', ['+', '-']], ['r1', 'wokwi-resistor', ['1', '2']], ['led1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['bat:+', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'bat:-']], null, { board: false });
  runMs(sim, 30);
  ok(els.get('led1').value === true, 'board-less circuit: 9V battery lights LED through resistor');
}
// 13. Flow sensor pulse counting (interrupt)
{
  const { sim } = make([['f', 'mod-flow', ['VCC', 'GND', 'SIG'], { angle: 0 }]], [['f:VCC', 'uno:5V'], ['f:GND', 'uno:GND.1'], ['f:SIG', 'uno:2']],
    `volatile unsigned long n=0; void isr(){n++;}
void setup(){Serial.begin(115200);attachInterrupt(digitalPinToInterrupt(2),isr,RISING);}
void loop(){ delay(1000); noInterrupts(); unsigned long c=n; n=0; interrupts(); Serial.print("Hz="); Serial.println(c); }`);
  sim.model.parts.find((p) => p.id === 'f').attrs = { flow: 4 };
  runMs(sim, 2150);
  const m = [...sim.serial.matchAll(/Hz=(\d+)/g)].map((x) => +x[1]);
  ok(m.length >= 2 && Math.abs(m[1] - 30) <= 1, `YF-S201 at 4 L/min -> ${m[1]} Hz (expect 7.5*4 = 30)`);
}
// 14. I2C wiring mistake gets a precise message
{
  const font = new Uint8Array(256 * 8);
  const { sim } = make([['lcd', 'x-lcd1602-i2c', ['GND', 'VCC', 'SDA', 'SCL'], { font }]], [['lcd:GND', 'uno:GND.1'], ['lcd:VCC', 'uno:5V'], ['lcd:SDA', 'uno:A5'], ['lcd:SCL', 'uno:A4']], `void setup(){} void loop(){}`);
  ok(sim.logs.some((l) => /SDA → A4, SCL → A5/.test(l.text)), 'swapped SDA/SCL -> "SDA → A4, SCL → A5" hint');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
