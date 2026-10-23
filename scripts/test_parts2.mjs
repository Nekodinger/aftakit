// Phase 2 tests: DS18B20 (1-Wire, real OneWire + DallasTemperature libraries), TM1637 display, HX711 load cell (real libraries).
import { make, ok, done, lines, logText, Stub } from './testkit.mjs';

const DS = ['GND', 'DQ', 'VDD'];
const dsWiring = (pull = true) => [['uno:2', 'ds:DQ'], ['ds:GND', 'uno:GND.1'], ['ds:VDD', 'uno:5V'], ...(pull ? [['r4k', 'x']] : [])];

// ---------------------------------------------------------------- 1. DS18B20 reads the slider temperature with a 4.7 k pull-up
{
  const { sim } = make([['ds', 'mod-ds18b20', DS, {}, { temperature: '23.5' }], ['rp', 'wokwi-resistor', ['1', '2'], {}, { value: '4700' }]],
    [['uno:2', 'ds:DQ'], ['ds:GND', 'uno:GND.1'], ['ds:VDD', 'uno:5V'], ['rp:1', 'uno:5V'], ['rp:2', 'uno:2']],
    `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(2); DallasTemperature ds(&ow);
void setup(){ Serial.begin(9600); ds.begin(); Serial.print("n="); Serial.println(ds.getDeviceCount()); }
void loop(){ ds.requestTemperatures(); Serial.println(ds.getTempCByIndex(0)); delay(500);}`);
  sim.advance(3000);
  const l = lines(sim);
  ok(l[0] === 'n=1', `DS18B20 found on the bus (${l[0]})`);
  ok(l.slice(1).some((x) => Math.abs(parseFloat(x) - 23.5) < 0.07), `reads 23.5 °C (${l.slice(1, 4).join(' ')})`);
}
// 2. no pull-up -> device not found + helpful warning
{
  const { sim } = make([['ds', 'mod-ds18b20', DS, {}, { temperature: '23.5' }]],
    [['uno:2', 'ds:DQ'], ['ds:GND', 'uno:GND.1'], ['ds:VDD', 'uno:5V']],
    `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(2); DallasTemperature ds(&ow);
void setup(){ Serial.begin(9600); ds.begin(); Serial.println(ds.getDeviceCount()); }
void loop(){}`);
  sim.running = true; sim.advance(1500); sim.running = false;
  ok(lines(sim)[0] === '0' && /pull-up/.test(logText(sim)), `no pull-up: devices=${lines(sim)[0]}; warning=${/pull-up/.test(logText(sim))}`);
}
// 3. two DS18B20 on one bus: search finds both, match ROM addresses them individually, alarm/resolution registers work
{
  const { sim } = make([['d1', 'mod-ds18b20', DS, {}, { temperature: '10' }], ['d2', 'mod-ds18b20', DS, {}, { temperature: '-12.5' }], ['rp', 'wokwi-resistor', ['1', '2'], {}, { value: '4700' }]],
    [['uno:2', 'd1:DQ'], ['d1:DQ', 'd2:DQ'], ['d1:GND', 'uno:GND.1'], ['d2:GND', 'uno:GND.1'], ['d1:VDD', 'uno:5V'], ['d2:VDD', 'uno:5V'], ['rp:1', 'uno:5V'], ['rp:2', 'uno:2']],
    `#include <OneWire.h>
#include <DallasTemperature.h>
OneWire ow(2); DallasTemperature ds(&ow);
void setup(){ Serial.begin(9600); ds.begin(); ds.setResolution(10); Serial.println(ds.getDeviceCount()); ds.requestTemperatures(); Serial.println(ds.getTempCByIndex(0)); Serial.println(ds.getTempCByIndex(1)); }
void loop(){}`);
  sim.advance(2500);
  const l = lines(sim); const t = [parseFloat(l[1]), parseFloat(l[2])].sort((a, b) => a - b);
  ok(l[0] === '2', `two sensors found (${l[0]})`);
  ok(Math.abs(t[0] + 12.5) < 0.3 && Math.abs(t[1] - 10) < 0.3, `readings ${l[1]} / ${l[2]} (expect 10 and -12.5, 10-bit resolution)`);
}
// 4. TM1637 4-digit display with the real TM1637Display library
{
  const el = new Stub('mod-tm1637', ['CLK', 'DIO', 'VCC', 'GND'], { frames: [], setSeg7(b, br, on) { this.frames.push([Array.from(b), br, on]); } });
  const { sim, els } = make([['tm', 'mod-tm1637', ['CLK', 'DIO', 'VCC', 'GND']]],
    [['uno:2', 'tm:CLK'], ['uno:3', 'tm:DIO'], ['tm:VCC', 'uno:5V'], ['tm:GND', 'uno:GND.1']],
    `#include <TM1637Display.h>
TM1637Display d(2, 3);
void setup(){ d.setBrightness(7); d.showNumberDec(1234); }
void loop(){}`);
  els.get('tm').frames = []; els.get('tm').setSeg7 = function (b, br, on) { this.frames.push([Array.from(b), br, on]); };
  sim.loadHex(sim.hexText); sim.advance(200);
  const f = els.get('tm').frames.at(-1);
  ok(f && f[0].join() === [0x06, 0x5b, 0x4f, 0x66].join() && f[2], `TM1637 shows 1234: ${f && f[0].map((x) => x.toString(16)).join(' ')} on=${f && f[2]} bright=${f && f[1]}`);
}
// 5. HX711 with the real library: raw counts follow the weight (ratiometric, gain 128)
{
  const mk = (w, type = '5kg') => make([['hx', 'wokwi-hx711', ['VCC', 'DT', 'SCK', 'GND'], {}, { weight: String(w), type }]],
    [['uno:3', 'hx:DT'], ['uno:2', 'hx:SCK'], ['hx:VCC', 'uno:5V'], ['hx:GND', 'uno:GND.1']],
    `#include <HX711.h>
HX711 s;
void setup(){ Serial.begin(9600); s.begin(3, 2); }
void loop(){ if (s.is_ready()) { Serial.println(s.read()); } delay(150); }`);
  const a = mk(0), b = mk(1000), c = mk(25000, '50kg');
  for (const x of [a, b, c]) x.sim.advance(1500);
  const r = (x) => +lines(x.sim).at(-1);
  const expect = (w, cap) => (w / cap) * 0.001 * 128 * 16777216;
  ok(Math.abs(r(a) - 40) < 10, `HX711 zero load: ${r(a)} counts`);
  ok(Math.abs(r(b) - expect(1000, 5000) - 40) < 10, `HX711 1000 g / 5 kg: ${r(b)} (theory ${(expect(1000, 5000) + 40).toFixed(0)})`);
  ok(Math.abs(r(c) - expect(25000, 50000) - 40) < 10, `HX711 25 kg / 50 kg: ${r(c)}`);
}
done();
