// FTDI FT232RL USB-serial adapter: computer terminal <-> microcontroller (SoftwareSerial, hardware Serial1, ATtiny85),
// adapter <-> serial module directly (GPS), baud mismatch, DTR auto-reset, power jumper, missing common ground.
import { make, ok, done, lines, logText } from './testkit.mjs';

const F = ['DTR', 'RXD', 'TXD', 'VCC', 'CTS', 'GND'];
const term = (sim) => { const t = {}; sim.on('ftdi', ({ id, b }) => { t[id] = (t[id] || '') + String.fromCharCode(b); }); return t; };

// 1. Uno SoftwareSerial(10, 11) <-> FTDI terminal both ways at 9600
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F]],
    [['ftdi1:TXD', 'uno:10'], ['ftdi1:RXD', 'uno:11'], ['ftdi1:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial pc(10, 11);
void setup(){ Serial.begin(115200); pc.begin(9600); pc.println("Halo PC"); }
void loop(){ static String s; while (pc.available()) { char c = pc.read(); if (c == '\\n') { Serial.print("dari PC: "); Serial.println(s); pc.print("echo "); pc.println(s); s = ""; } else s += c; } }`);
  const t = term(sim); sim.running = true;
  sim.advance(300);
  ok((t.ftdi1 || '').includes('Halo PC'), `FTDI terminal receives SoftwareSerial text: ${JSON.stringify(t.ftdi1)}`);
  sim.ftdiPorts[0].send('LED ON\n'); sim.advance(300);
  ok(lines(sim).includes('dari PC: LED ON'), `Arduino receives text typed on the PC: ${lines(sim).join(' | ')}`);
  ok((t.ftdi1 || '').includes('echo LED ON'), `round trip echo: ${JSON.stringify(t.ftdi1)}`);
  ok(!/FTDI|ftdi1/.test(logText(sim)), `no wiring warnings: ${logText(sim)}`);
}
// 2. Mega Serial1 (TX1 18 / RX1 19) at 115200
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F, {}, { baud: '115200' }]],
    [['ftdi1:RXD', 'uno:18'], ['ftdi1:TXD', 'uno:19'], ['ftdi1:GND', 'uno:GND.1']],
    `void setup(){ Serial.begin(9600); Serial1.begin(115200); Serial1.println("MEGA SERIAL1"); }
void loop(){ while (Serial1.available()) Serial.write(Serial1.read()); }`, 'mega');
  const t = term(sim); sim.advance(200);
  ok((t.ftdi1 || '').includes('MEGA SERIAL1'), `Serial1 -> FTDI: ${JSON.stringify(t.ftdi1)}`);
  sim.ftdiPorts[0].send('ping\n'); sim.advance(100);
  ok(sim.serial.includes('ping'), `FTDI -> Serial1: ${JSON.stringify(sim.serial)}`);
}
// 3. ATtiny85 (no USB): Serial output on PB0 read through the FTDI
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F]],
    [['ftdi1:RXD', 'uno:PB0'], ['ftdi1:GND', 'uno:GND.1'], ['ftdi1:VCC', 'uno:VCC.1']],
    `void setup(){ Serial.begin(9600); } void loop(){ Serial.println(analogRead(A1) >= 0 ? "tiny ok" : "x"); delay(200); }`, 'attiny85');
  const t = term(sim); sim.advance(700);
  ok((t.ftdi1 || '').startsWith('tiny ok'), `ATtiny85 (no boot garbage) software serial -> FTDI: ${JSON.stringify((t.ftdi1 || '').slice(0, 40))}`);
}
// 4. module straight to the adapter: GPS NMEA on the PC terminal, powered by FTDI VCC
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F], ['g', 'mod-gps', ['VCC', 'RX', 'TX', 'GND']]],
    [['ftdi1:RXD', 'g:TX'], ['ftdi1:TXD', 'g:RX'], ['ftdi1:VCC', 'g:VCC'], ['ftdi1:GND', 'g:GND'], ['g:GND', 'uno:GND.1']],
    `void setup(){} void loop(){}`);
  const t = term(sim); sim.running = true; sim.advance(2200);
  ok(/\$GPRMC,.*\*[0-9A-F]{2}/.test(t.ftdi1 || ''), `GPS -> FTDI terminal: ${(t.ftdi1 || '').split('\n')[0]}`);
  ok(!/tidak mendapat daya/.test(logText(sim)), 'GPS powered from the FTDI VCC pin');
}
// 5. wrong terminal baud rate -> warning, garbage not delivered
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F, {}, { baud: '115200' }]],
    [['ftdi1:TXD', 'uno:10'], ['ftdi1:RXD', 'uno:11'], ['ftdi1:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial pc(10, 11); void setup(){ pc.begin(9600); } void loop(){ pc.println("abc"); delay(100); }`);
  const t = term(sim); sim.running = true; sim.advance(400);
  ok(/baud/.test(logText(sim)), `baud mismatch warning: ${logText(sim).slice(0, 160)}`);
}
// 6. DTR auto-reset through a capacitor to RESET; without it the pulse does nothing
{
  const a = make([['ftdi1', 'mod-ftdi', F], ['c1', 'mod-capacitor', ['+', '-'], {}, { capacitance: '1' }]],
    [['ftdi1:DTR', 'c1:-'], ['c1:+', 'uno:RESET'], ['ftdi1:GND', 'uno:GND.1']], 'void setup(){} void loop(){}');
  const b = make([['ftdi1', 'mod-ftdi', F]], [['ftdi1:GND', 'uno:GND.1']], 'void setup(){} void loop(){}');
  ok(a.sim.ftdiPorts[0].pulseDtr() === true && b.sim.ftdiPorts[0].pulseDtr() === false, 'DTR -> capacitor -> RESET detected; unwired DTR is not');
}
// 7. power jumper: 5 V on VCC; 3.3 V jumper tied to the Uno 5V rail = short; GND not shared -> warning
{
  const { sim } = make([['ftdi1', 'mod-ftdi', F], ['ftdi2', 'mod-ftdi', F, {}, { vio: '3.3V' }]],
    [['ftdi1:VCC', 'uno:A0'], ['ftdi2:VCC', 'uno:5V'], ['ftdi2:GND', 'uno:GND.1'], ['ftdi1:RXD', 'uno:1']],
    `void setup(){ Serial.begin(9600); Serial.println(analogRead(A0)); } void loop(){}`);
  sim.running = true; sim.advance(100);
  ok(+lines(sim)[0] >= 1015, `FTDI VCC = 5 V on A0: ${lines(sim)[0]}`);
  ok(/Korsleting/.test(logText(sim)), 'short circuit: 3.3 V jumper on the 5 V rail');
  ok(/GND FTDI belum disatukan/.test(logText(sim)), 'missing common ground warning');
}
done();
