// Phase 3 tests: I2C sensors with the real vendor libraries (BMP280, BME280, MAX30102).
import { make, ok, done, lines, logText } from './testkit.mjs';

const I2C = (id, vcc = 'VCC') => [[`uno:A4`, `${id}:SDA`], [`uno:A5`, `${id}:SCL`], [`${id}:${vcc}`, 'uno:5V'], [`${id}:GND`, 'uno:GND.1']];
// 1. BMP280: temperature and pressure round-trip through the Adafruit library's own compensation maths
{
  const { sim } = make([['b', 'mod-bmp280', ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO'], {}, { temperature: '21.5', pressure: '1002' }]], I2C('b'),
    `#include <Wire.h>
#include <Adafruit_BMP280.h>
Adafruit_BMP280 bmp;
void setup(){ Serial.begin(9600); if(!bmp.begin(0x76)){ Serial.println("NOT FOUND"); return; } }
void loop(){ Serial.print(bmp.readTemperature()); Serial.print(" "); Serial.print(bmp.readPressure()/100.0); Serial.print(" "); Serial.println(bmp.readAltitude(1013.25)); delay(500);}`);
  sim.advance(1500);
  const l = lines(sim).at(-1).split(' ').map(Number);
  ok(!/NOT FOUND/.test(sim.serial), 'BMP280 detected by Adafruit_BMP280.begin(0x76)');
  ok(Math.abs(l[0] - 21.5) < 0.02 && Math.abs(l[1] - 1002) < 0.05, `BMP280 reads ${l[0]} °C, ${l[1]} hPa (expect 21.5 / 1002)`);
  const alt = 44330 * (1 - Math.pow(1002 / 1013.25, 0.1903));
  ok(Math.abs(l[2] - alt) < 0.5, `altitude from pressure ${l[2]} m (theory ${alt.toFixed(1)})`);
}
// 2. BME280: humidity too, address 0x77
{
  const { sim } = make([['b', 'mod-bme280', ['VIN', 'GND', 'SCL', 'SDA'], {}, { temperature: '30', pressure: '990', humidity: '72', address: '0x77' }]], I2C('b', 'VIN'),
    `#include <Wire.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup(){ Serial.begin(9600); if(!bme.begin(0x77)){ Serial.println("NOT FOUND"); return; } }
void loop(){ Serial.print(bme.readTemperature()); Serial.print(" "); Serial.print(bme.readPressure()/100.0); Serial.print(" "); Serial.println(bme.readHumidity()); delay(500);}`);
  sim.advance(1500);
  const l = lines(sim).at(-1).split(' ').map(Number);
  ok(!/NOT FOUND/.test(sim.serial), 'BME280 detected at 0x77');
  ok(Math.abs(l[0] - 30) < 0.02 && Math.abs(l[1] - 990) < 0.05 && Math.abs(l[2] - 72) < 0.1, `BME280 reads ${l.join(' / ')} (expect 30 / 990 / 72)`);
}
// 3. wrong address -> clear warning and the library reports "not found"
{
  const { sim } = make([['b', 'mod-bme280', ['VIN', 'GND', 'SCL', 'SDA'], {}, { address: '0x77' }]], I2C('b', 'VIN'),
    `#include <Wire.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup(){ Serial.begin(9600); Serial.println(bme.begin(0x76) ? "OK" : "NOT FOUND"); }
void loop(){}`);
  sim.advance(500);
  ok(lines(sim)[0] === 'NOT FOUND' && /0x76/.test(logText(sim)), 'sketch uses 0x76 but sensor is at 0x77 -> NOT FOUND + warning');
}
// 4. BME280 library on a BMP280 chip (chip id 0x58) -> not found, as on real hardware
{
  const { sim } = make([['b', 'mod-bmp280', ['VCC', 'GND', 'SCL', 'SDA', 'CSB', 'SDO'], {}, {}]], I2C('b'),
    `#include <Wire.h>
#include <Adafruit_BME280.h>
Adafruit_BME280 bme;
void setup(){ Serial.begin(9600); Serial.println(bme.begin(0x76) ? "OK" : "NOT FOUND"); }
void loop(){}`);
  sim.advance(500);
  ok(lines(sim)[0] === 'NOT FOUND', 'BME280 library does not accept a BMP280 chip id');
}
// 5. MAX30102 with the SparkFun library: part id, finger / no finger, beat detection (heartRate.h) and the Maxim SpO2 algorithm
const mx = (props, body) => make([['m', 'mod-max30102', ['VIN', 'SCL', 'SDA', 'INT', 'IRD', 'RD', 'GND'], {}, props]],
  [['uno:A4', 'm:SDA'], ['uno:A5', 'm:SCL'], ['m:VIN', 'uno:5V'], ['m:GND', 'uno:GND.1']], body);
{
  const { sim } = mx({ bpm: '72', spo2: '97', finger: 'ya' }, `#include <Wire.h>
#include "MAX30105.h"
#include "heartRate.h"
MAX30105 p; long last = 0;
void setup(){ Serial.begin(115200); if(!p.begin(Wire, I2C_SPEED_FAST)){ Serial.println("NOT FOUND"); return; } p.setup(); p.setPulseAmplitudeRed(0x0A); p.setPulseAmplitudeGreen(0); }
void loop(){ long ir = p.getIR(); if (checkForBeat(ir)) { long d = millis() - last; last = millis(); Serial.print("B "); Serial.print(60000.0 / d); Serial.print(" "); Serial.println(ir); } }`);
  sim.advance(14000);
  const beats = lines(sim).filter((x) => x.startsWith('B ')).map((x) => x.split(' ').map(Number)).slice(3);
  ok(!/NOT FOUND/.test(sim.serial), 'MAX30102 found (part id 0x15)');
  const med = beats.map((b) => b[1]).sort((a, b) => a - b)[Math.floor(beats.length / 2)];
  ok(beats.length >= 8 && Math.abs(med - 72) < 4, `heart-rate library: ${beats.length} beats, median ${med && med.toFixed(1)} BPM (set 72)`);
  ok(beats.length && beats[0][2] > 50000, `finger present: IR ~ ${beats[0] && beats[0][2]} (> 50000)`);
}
{
  const { sim } = mx({ finger: 'tidak' }, `#include <Wire.h>
#include "MAX30105.h"
MAX30105 p;
void setup(){ Serial.begin(115200); p.begin(Wire, I2C_SPEED_FAST); p.setup(); }
void loop(){ Serial.println(p.getIR()); delay(200); }`);
  sim.advance(1500);
  const ir = +lines(sim).at(-1);
  ok(ir < 50000, `no finger: IR = ${ir} (< 50000, the library examples print "No finger?")`);
}
// (the Maxim SpO2 algorithm needs ~2 KB of RAM: it is tested on the ESP32 in test_parts3_esp32.mjs; on an Uno it overflows the stack, as on real hardware)
done();
