// "Kode otomatis": generated sketches compile for the Uno (avr-gcc) and the ESP32 (WebAssembly runtime),
// and behave in the simulator (HC-SR04 distance, DHT22 temperature, button).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { make, ok, done, lines, compile } from './testkit.mjs';
const { generateSketch } = await import('../src/learn/autocode.js');
const root = new URL('..', import.meta.url).pathname;
const esp32 = (src) => { writeFileSync('/tmp/_ac.ino', src); const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
r=compile_sketch_wasm(open('/tmp/_ac.ino').read(), 'esp32'); print(json.dumps({'ok': bool(r.get('wasm')), 'err': (r.get('stderr') or '')[-1500:]}))`], { cwd: root, maxBuffer: 1e8 }); return JSON.parse(out); };
const it = (id, type, pins, attrs = {}) => ({ id, type, name: type, attrs, pins, allPins: Object.keys(pins) });
const UNO = { name: 'Arduino Uno', board: 'uno' }, ESP = { name: 'ESP32', board: 'esp32' };
const groups = {
  sensors: (b) => [it('led1', 'wokwi-led', { A: b ? '13' : '2' }), it('rgb1', 'wokwi-rgb-led', { R: b ? '9' : '25', G: b ? '10' : '26', B: b ? '11' : '27' }), it('bz1', 'wokwi-buzzer', { 1: b ? '8' : '18' }),
    it('btn1', 'wokwi-pushbutton', { 1: b ? '2' : '4' }), it('sw1', 'wokwi-slide-switch', { 2: b ? '4' : '5' }), it('pot1', 'wokwi-potentiometer', { SIG: b ? 'A0' : '34' }),
    it('js1', 'wokwi-analog-joystick', { HORZ: b ? 'A1' : '35', VERT: b ? 'A2' : '32', SEL: b ? '7' : '13' }), it('sonar1', 'wokwi-hc-sr04', { TRIG: b ? '12' : '14', ECHO: b ? '5' : '12' }),
    it('dht1', 'wokwi-dht22', { SDA: b ? '3' : '15' }), it('ldr1', 'wokwi-photoresistor-sensor', { AO: b ? 'A3' : '33' }), it('pir1', 'wokwi-pir-motion-sensor', { OUT: b ? '6' : '19' }),
    it('soil1', 'mod-soil', { AO: b ? 'A0' : '36' }), it('mq1', 'mod-mq135', { AO: b ? 'A1' : '39' }), it('relay1', 'mod-relay1', { IN: b ? '7' : '23' }), it('enc1', 'wokwi-ky-040', { CLK: b ? '2' : '16', DT: b ? '3' : '17' })],
  displays: (b) => [it('lcd1', 'x-lcd1602-i2c', { SDA: b ? 'A4' : '21', SCL: b ? 'A5' : '22' }), it('oled1', 'wokwi-ssd1306', { SDA: b ? 'A4' : '21', SCL: b ? 'A5' : '22' }),
    it('rtc1', 'wokwi-ds1307', { SDA: b ? 'A4' : '21', SCL: b ? 'A5' : '22' }), it('bmp1', 'mod-bmp280', { SDA: b ? 'A4' : '21', SCL: b ? 'A5' : '22' }), it('mpu1', 'wokwi-mpu6050', { SDA: b ? 'A4' : '21', SCL: b ? 'A5' : '22' }),
    it('tm1', 'mod-tm1637', { CLK: b ? '2' : '18', DIO: b ? '3' : '19' })],
  misc: (b) => [it('servo1', 'wokwi-servo', { PWM: b ? '9' : '13' }), it('px1', 'wokwi-led-ring', { DIN: b ? '6' : '27' }, { pixels: 12 }), it('ds1', 'mod-ds18b20', { DQ: b ? '2' : '4' }),
    it('kp1', 'wokwi-membrane-keypad', b ? { R1: '9', R2: '8', R3: '7', R4: '6', C1: '5', C2: '4', C3: '3', C4: '2' } : { R1: '13', R2: '12', R3: '14', R4: '27', C1: '26', C2: '25', C3: '33', C4: '32' }),
    it('hx1', 'wokwi-hx711', { DT: b ? 'A1' : '16', SCK: b ? 'A0' : '17' }), it('dht2', 'mod-dht11', { DATA: b ? 'A2' : '15' })],
  ir: (b) => [it('ir1', 'wokwi-ir-receiver', { DAT: b ? '11' : '15' })],
};
for (const [g, mk] of Object.entries(groups)) {
  const u = generateSketch({ cat: UNO, items: mk(true) });
  let uok = true; try { compile(u.code, 'uno'); } catch (e) { uok = false; console.log(u.code.slice(0, 3000), '\n', String(e.message).slice(0, 1500)); }
  ok(uok && !u.unknown.length, `Uno: generated sketch "${g}" (${mk(true).length} parts) compiles`);
  const e = generateSketch({ cat: ESP, items: mk(false) });
  const r = esp32(e.code); if (!r.ok) console.log(e.code.slice(0, 2500), '\n', r.err);
  ok(r.ok, `ESP32: generated sketch "${g}" compiles`);
}
// behaviour: HC-SR04 + DHT22 + button on the Uno
{
  const g = generateSketch({ cat: UNO, items: [it('us', 'wokwi-hc-sr04', { TRIG: '12', ECHO: '11' }), it('dht', 'wokwi-dht22', { SDA: '2' }), it('b', 'wokwi-pushbutton', { 1: '4' })] });
  const { sim } = make([['us', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND'], {}, { distance: '120' }], ['dht', 'wokwi-dht22', ['VCC', 'SDA', 'NC', 'GND'], {}, { temperature: 31.5, humidity: 44 }]],
    [['us:VCC', 'uno:5V'], ['us:GND', 'uno:GND.1'], ['us:TRIG', 'uno:12'], ['us:ECHO', 'uno:11'], ['dht:VCC', 'uno:5V'], ['dht:GND', 'uno:GND.2'], ['dht:SDA', 'uno:2']], g.code);
  sim.running = true; for (let t = 0; t < 4500; t += 20) sim.advance(20);
  const out = lines(sim).join('\n');
  const cm = +(/Jarak us: ([\d.]+)/.exec(out) || [])[1], tc = +(/Suhu dht: ([\d.]+)/.exec(out) || [])[1];
  ok(Math.abs(cm - 120) < 3, `HC-SR04 code reads ${cm} cm (set 120)`);
  ok(Math.abs(tc - 31.5) < 0.2, `DHT22 code reads ${tc} °C (set 31.5)`);
}
done();
