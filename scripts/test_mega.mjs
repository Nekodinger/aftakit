// Arduino Mega 2560 (ATmega2560 on avr8js): pins 0-53 / A0-A15, timers 0-5 (PWM, Servo on timer 5), Serial1-3,
// external interrupts INT0-5, pin-change interrupts, I2C on 20/21 (and the SDA/SCL header), SPI on 50-52.
import { make, ok, done, lines, logText } from './testkit.mjs';
const M = (def, conns, sketch) => make(def, conns, sketch, 'mega');
const LED = (id) => [id, 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }];
// 1. blink on 13 + digital I/O on high pins + millis accuracy
{
  const { sim, els } = M([LED('l1'), LED('l2')], [['uno:13', 'l1:A'], ['l1:C', 'uno:GND.1'], ['uno:53', 'l2:A'], ['l2:C', 'uno:GND.2']],
    `void setup(){ Serial.begin(115200); pinMode(13, OUTPUT); pinMode(53, OUTPUT); digitalWrite(53, HIGH); }
void loop(){ digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250); static int n = 0; if (++n == 4) Serial.println(millis()); }`);
  sim.advance(120); const a = els.get('l1').value; sim.advance(250); const b = els.get('l1').value; sim.advance(1800);
  ok(a && !b && els.get('l2').value, `blink 13 (${a}/${b}) and pin 53 HIGH (${els.get('l2').value})`);
  ok(Math.abs(+lines(sim)[0] - 2000) <= 2, `millis() after 4 cycles: ${lines(sim)[0]} (timer0 overflow vector of the 2560)`);
}
// 2. analogRead on A15 (MUX5) and A0, analogWrite on timer 5 (pin 46) and timer 3 (pin 5)
{
  const { sim, els } = M([['p1', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC'], { value: 0, min: 0, max: 1023 }, {}], LED('l1'), LED('l2')],
    [['p1:SIG', 'uno:A15'], ['p1:VCC', 'uno:5V'], ['p1:GND', 'uno:GND.1'], ['uno:46', 'l1:A'], ['l1:C', 'uno:GND.2'], ['uno:5', 'l2:A'], ['l2:C', 'uno:GND.3']],
    `void setup(){ Serial.begin(115200); analogWrite(46, 64); analogWrite(5, 192); }
void loop(){ Serial.print(analogRead(A15)); Serial.print(" "); Serial.println(analogRead(A0)); delay(100); }`);
  const pot = els.get('p1'); pot.value = 512; pot.fire('input');
  sim.advance(600);
  const [a15, a0] = lines(sim).at(-1).split(' ').map(Number);
  ok(Math.abs(a15 - 512) < 20 && a0 >= 0, `A15 (ADC channel 15) = ${a15}`);
  const b1 = els.get('l1').brightness, b2 = els.get('l2').brightness;
  ok(Math.abs(b1 - 0.25) < 0.05 && Math.abs(b2 - 0.75) < 0.05, `PWM: pin 46 (timer 5) ${b1.toFixed(2)}, pin 5 (timer 3) ${b2.toFixed(2)}`);
}
// 3. Servo library on the Mega (timer 5)
{
  const { sim, els } = M([['s', 'wokwi-servo', ['GND', 'V+', 'PWM'], { angle: 0 }]], [['uno:9', 's:PWM'], ['s:V+', 'uno:5V'], ['s:GND', 'uno:GND.1']],
    `#include <Servo.h>
Servo sv; void setup(){ sv.attach(9); sv.write(135); } void loop(){}`);
  sim.advance(500);
  ok(Math.abs(els.get('s').angle - 135) < 3, `Servo on pin 9 -> ${els.get('s').angle}°`);
}
// 4. external interrupt INT5 on pin 3 and pin-change interrupt on PCINT (pin 10 = PB4)
{
  const { sim, els } = M([['b1', 'wokwi-pushbutton', ['1.l', '2.l', '1.r', '2.r'], { pressed: false }], ['b2', 'wokwi-pushbutton', ['1.l', '2.l', '1.r', '2.r'], { pressed: false }]],
    [['uno:3', 'b1:1.l'], ['b1:2.l', 'uno:GND.1'], ['uno:10', 'b2:1.l'], ['b2:2.l', 'uno:GND.2']],
    `volatile int n3 = 0, nPc = 0; void isr3(){ n3++; } ISR(PCINT0_vect){ nPc++; }
void setup(){ Serial.begin(115200); pinMode(3, INPUT_PULLUP); pinMode(10, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(3), isr3, FALLING); PCICR |= 1; PCMSK0 |= (1 << PCINT4); }
void loop(){ static unsigned long t = 0; if (millis() - t > 400) { t = millis(); Serial.print(n3); Serial.print(" "); Serial.println(nPc); } }`);
  sim.advance(100);
  for (let i = 0; i < 3; i++) { const b = els.get('b1'); b.pressed = true; b.fire('button-press'); sim.advance(30); b.pressed = false; b.fire('button-release'); sim.advance(30); }
  const c = els.get('b2'); c.pressed = true; c.fire('button-press'); sim.advance(30); c.pressed = false; c.fire('button-release'); sim.advance(400);
  ok(lines(sim).at(-1) === '3 2', `INT5 falling edges = 3, PCINT changes = 2: ${lines(sim).at(-1)}`);
}
// 5. Serial1 (pins 18/19) talks to a GPS module, Serial monitor stays on Serial
{
  const { sim } = M([['g', 'mod-gps', ['VCC', 'RX', 'TX', 'GND']]], [['g:TX', 'uno:19'], ['g:RX', 'uno:18'], ['g:VCC', 'uno:5V'], ['g:GND', 'uno:GND.1']],
    `void setup(){ Serial.begin(115200); Serial1.begin(9600); }
void loop(){ static String s; while (Serial1.available()) { char c = Serial1.read(); if (c == '\\n') { if (s.startsWith("$GPGGA")) Serial.println("GGA via Serial1"); s = ""; } else s += c; } }`);
  sim.advance(2300);
  ok(lines(sim).includes('GGA via Serial1'), `Serial1 RX from GPS: ${lines(sim).slice(0, 2).join(' | ')}`);
}
// 6. I2C on pins 20/21 and on the SDA/SCL header (LCD 16x2 I2C)
{
  const LCDP = ['GND', 'VCC', 'SDA', 'SCL'];
  for (const [sda, scl] of [['20', '21'], ['SDA', 'SCL']]) {
    const { sim } = M([['lcd', 'x-lcd1602-i2c', LCDP, { font: new Uint8Array(256 * 8) }, {}]], [[`uno:${sda}`, 'lcd:SDA'], [`uno:${scl}`, 'lcd:SCL'], ['lcd:VCC', 'uno:5V'], ['lcd:GND', 'uno:GND.1']],
      `#include <Wire.h>
void setup(){ Serial.begin(115200); Wire.begin(); Wire.beginTransmission(0x27); Serial.println(Wire.endTransmission()); } void loop(){}`);
    sim.advance(200);
    ok(lines(sim)[0] === '0' && !/jalur I2C belum benar/.test(logText(sim)), `I2C device found via ${sda}/${scl}: endTransmission = ${lines(sim)[0]}`);
  }
}
// 7. SPI on 50/51/52 (MAX7219 via SPI.transfer, CS on 53)
{
  const MX = ['VCC', 'GND', 'DIN', 'CS', 'CLK', 'VCC.2', 'GND.2', 'DOUT', 'CS.2', 'CLK.2'];
  const { sim, els } = M([['m', 'mod-max7219', MX, { setMatrix(r) { this.last = r; } }]], [['uno:51', 'm:DIN'], ['uno:52', 'm:CLK'], ['uno:53', 'm:CS'], ['m:VCC', 'uno:5V'], ['m:GND', 'uno:GND.1']],
    `#include <SPI.h>
void w(byte a, byte d){ digitalWrite(53, LOW); SPI.transfer(a); SPI.transfer(d); digitalWrite(53, HIGH); }
void setup(){ pinMode(53, OUTPUT); SPI.begin(); w(0x0C, 1); w(0x0B, 7); w(1, 0xAA); }
void loop(){}`);
  sim.advance(200);
  ok(els.get('m').last?.[0]?.[0] === 0xaa, `hardware SPI on the Mega: row 0 = ${els.get('m').last?.[0]?.[0]?.toString(16)}`);
}
// 8. big RAM: 6 KB array works on the Mega (would not fit an Uno)
{
  const { sim } = M([], [], `byte buf[6000]; void setup(){ Serial.begin(115200); for (int i = 0; i < 6000; i++) buf[i] = i * 7; long s = 0; for (int i = 0; i < 6000; i++) s += buf[i]; Serial.println(s); } void loop(){}`);
  sim.advance(200);
  let e = 0; for (let i = 0; i < 6000; i++) e += (i * 7) & 255;
  ok(+lines(sim)[0] === e, `6000-byte array checksum ${lines(sim)[0]} (expect ${e})`);
}
done();
