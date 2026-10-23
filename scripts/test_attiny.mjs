// Franzininho / ATtiny85 (ATTinyCore on avr8js): GPIO, software Serial TX on PB0 decoded for the monitor, ADC, PWM on
// timer 0 / timer 1, pin-change interrupts, USI-based Wire talking to I2C modules.
import { make, ok, done, lines, logText } from './testkit.mjs';
const T = (def, conns, sketch) => make(def, conns, sketch, 'attiny85');
const LED = (id) => [id, 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }];
{
  const { sim, els } = T([LED('l')], [['uno:PB3', 'l:A'], ['l:C', 'uno:GND.1']],
    `void setup(){ pinMode(3, OUTPUT); Serial.begin(9600); Serial.println("Halo ATtiny85"); }
void loop(){ digitalWrite(3, HIGH); delay(200); digitalWrite(3, LOW); delay(200); Serial.println(millis()); }`);
  sim.advance(100); const a = els.get('l').value; sim.advance(200); const b = els.get('l').value; sim.advance(500);
  ok(a && !b, `blink on PB3: ${a}/${b}`);
  ok(lines(sim)[0] === 'Halo ATtiny85' && +lines(sim)[1] >= 400 && +lines(sim)[1] <= 420, `Serial (software TX on PB0) decoded: ${lines(sim).slice(0, 2).join(' | ')}`);
}
{
  const { sim, els } = T([['p', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { value: 256, min: 0, max: 1023 }, {}], LED('l')],
    [['p:SIG', 'uno:PB2'], ['p:VCC', 'uno:VCC.1'], ['p:GND', 'uno:GND.1'], ['uno:PB4', 'l:A'], ['l:C', 'uno:GND.2']],
    `void setup(){ Serial.begin(9600); analogWrite(4, 191); } void loop(){ Serial.println(analogRead(A1)); delay(100); }`);
  sim.advance(500);
  ok(Math.abs(+lines(sim).at(-1) - 256) < 12, `analogRead(A1 = PB2): ${lines(sim).at(-1)}`);
  ok(Math.abs(els.get('l').brightness - 0.75) < 0.06, `analogWrite(PB4) on timer 1: brightness ${els.get('l').brightness.toFixed(2)}`);
}
{
  // PB0 is both SDA and the Serial TX pin on an ATtiny85 (like the real chip), so results are shown on LEDs
  const LCDP = ['GND', 'VCC', 'SDA', 'SCL'];
  const { sim, els } = T([['lcd', 'x-lcd1602-i2c', LCDP, { font: new Uint8Array(256 * 8) }, {}], ['m', 'wokwi-mpu6050', ['INT', 'AD0', 'XCL', 'XDA', 'SDA', 'SCL', 'GND', 'VCC'], {}, {}], LED('l1'), LED('l3'), LED('l4')],
    [['uno:PB0', 'lcd:SDA'], ['uno:PB2', 'lcd:SCL'], ['lcd:VCC', 'uno:VCC.1'], ['lcd:GND', 'uno:GND.1'], ['uno:PB0', 'm:SDA'], ['uno:PB2', 'm:SCL'], ['m:VCC', 'uno:VCC.2'], ['m:GND', 'uno:GND.2'],
      ['uno:PB1', 'l1:A'], ['l1:C', 'uno:GND.1'], ['uno:PB3', 'l3:A'], ['l3:C', 'uno:GND.1'], ['uno:PB4', 'l4:A'], ['l4:C', 'uno:GND.1']],
    `#include <Wire.h>
void setup(){ pinMode(1, OUTPUT); pinMode(3, OUTPUT); pinMode(4, OUTPUT); Wire.begin();
  Wire.beginTransmission(0x27); byte e1 = Wire.endTransmission(); Wire.beginTransmission(0x50); byte e2 = Wire.endTransmission();
  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();
  Wire.beginTransmission(0x68); Wire.write(0x75); Wire.endTransmission(); Wire.requestFrom(0x68, 2); byte who = Wire.read(); Wire.read();
  digitalWrite(1, e1 == 0); digitalWrite(3, e2 != 0); digitalWrite(4, who == 0x68); }
void loop(){}`);
  sim.advance(600);
  const v = ['l1', 'l3', 'l4'].map((k) => els.get(k).value);
  ok(v.every(Boolean), `USI Wire: LCD acks ${v[0]}, empty address NACK ${v[1]}, MPU6050 WHO_AM_I read ${v[2]}`);
}
done();
