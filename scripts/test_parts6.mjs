// Phase 5b tests: UART modules — GPS NEO-6M (TinyGPS++), HC-05 Bluetooth, SIM800L, ESP-01 AT firmware.
import { make, ok, done, lines, logText } from './testkit.mjs';

const GPS = ['VCC', 'RX', 'TX', 'GND'];
// 1. GPS on SoftwareSerial (bit-banged on pins 4/3) parsed by TinyGPS++
{
  const { sim } = make([['g', 'mod-gps', GPS, {}, { lat: '-7.2575', lng: '112.7521', alt: '12', speed: '36', sats: '9' }]],
    [['g:TX', 'uno:4'], ['g:RX', 'uno:3'], ['g:VCC', 'uno:5V'], ['g:GND', 'uno:GND.1']],
    `#include <TinyGPS++.h>
#include <SoftwareSerial.h>
TinyGPSPlus gps; SoftwareSerial ss(4, 3);
void setup(){ Serial.begin(115200); ss.begin(9600); }
void loop(){ while (ss.available()) gps.encode(ss.read());
  static unsigned long t = 0; if (millis() - t > 1000 && gps.location.isUpdated()) { t = millis();
    Serial.print(gps.location.lat(), 4); Serial.print(" "); Serial.print(gps.location.lng(), 4); Serial.print(" "); Serial.print(gps.altitude.meters(), 1);
    Serial.print(" "); Serial.print(gps.speed.kmph(), 1); Serial.print(" "); Serial.print(gps.satellites.value()); Serial.print(" "); Serial.print(gps.date.year()); Serial.print(" "); Serial.println(gps.failedChecksum()); } }`);
  sim.advance(3500);
  const l = lines(sim).at(-1)?.split(' ') || [];
  ok(l[0] === '-7.2575' && l[1] === '112.7521' && l[2] === '12.0' && Math.abs(+l[3] - 36) < 0.1 && l[4] === '9' && +l[5] >= 2026 && l[6] === '0', `TinyGPS++ via SoftwareSerial: ${lines(sim).at(-1)}`);
}
// 2. no fix -> location invalid, and wrong baud -> warning
{
  const { sim } = make([['g', 'mod-gps', GPS, {}, { fix: 'tidak' }]], [['g:TX', 'uno:4'], ['g:RX', 'uno:3'], ['g:VCC', 'uno:5V'], ['g:GND', 'uno:GND.1']],
    `#include <TinyGPS++.h>
#include <SoftwareSerial.h>
TinyGPSPlus gps; SoftwareSerial ss(4, 3);
void setup(){ Serial.begin(115200); ss.begin(9600); }
void loop(){ while (ss.available()) gps.encode(ss.read()); static unsigned long t = 0; if (millis() - t > 2500) { t = millis(); Serial.print(gps.location.isValid()); Serial.print(" "); Serial.println(gps.sentencesWithFix()); } }`);
  sim.advance(2600);
  ok(lines(sim).at(-1) === '0 0', `no satellite fix: valid/withFix = ${lines(sim).at(-1)}`);
}
// 3. GPS on the hardware serial port (TX -> pin 0)
{
  const { sim } = make([['g', 'mod-gps', GPS]], [['g:TX', 'uno:0'], ['g:VCC', 'uno:5V'], ['g:GND', 'uno:GND.1']],
    `void setup(){ Serial.begin(9600); } void loop(){ static String s; while (Serial.available()) { char c = Serial.read(); if (c == '\\n') { if (s.startsWith("$GPGGA")) { Serial.print("GGA OK "); Serial.println(s.length()); } s = ""; } else s += c; } }`);
  sim.advance(2500);
  ok(lines(sim).some((x) => x.startsWith('GGA OK')), `hardware Serial receives NMEA: ${lines(sim).filter((x) => x.startsWith('GGA')).join(' | ')}`);
}
// 4. HC-05: Arduino <-> Bluetooth terminal, STATE pin, AT mode with EN high
const HC = ['STATE', 'RXD', 'TXD', 'GND', 'VCC', 'EN'];
{
  const { sim } = make([['bt', 'mod-hc05', HC]], [['bt:TXD', 'uno:10'], ['bt:RXD', 'uno:11'], ['bt:STATE', 'uno:7'], ['bt:VCC', 'uno:5V'], ['bt:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial bt(10, 11);
void setup(){ Serial.begin(115200); bt.begin(9600); bt.println("siap"); }
void loop(){ if (bt.available()) { String s = bt.readStringUntil('\\n'); Serial.print("dari HP: "); Serial.print(s); Serial.print(" state="); Serial.println(digitalRead(7)); bt.print("ok "); bt.println(s); } }`);
  let phone = ''; let began = null;
  sim.on('bt', (e) => { if (e.type === 'data') phone += String.fromCharCode(...e.bytes); else began = e.name; });
  sim.loadHex(sim.hexText); sim.serial = '';
  sim.advance(300); sim.btWrite('LED ON\n'); sim.advance(800);
  ok(began === 'HC-05', `Bluetooth terminal opened for ${began}`);
  ok(phone === 'siap\r\nok LED ON\r\n', `phone receives: ${JSON.stringify(phone)}`);
  ok(lines(sim)[0] === 'dari HP: LED ON state=1', `Arduino receives: ${lines(sim)[0]}`);
}
{
  const { sim } = make([['bt', 'mod-hc05', HC]], [['bt:TXD', 'uno:10'], ['bt:RXD', 'uno:11'], ['bt:EN', 'uno:5V'], ['bt:VCC', 'uno:5V'], ['bt:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial bt(10, 11);
void setup(){ Serial.begin(115200); bt.begin(38400); bt.print("AT\\r\\n"); delay(100); bt.print("AT+NAME?\\r\\n"); }
void loop(){ while (bt.available()) Serial.write(bt.read()); }`);
  sim.advance(500);
  ok(lines(sim).join('|') === 'OK|+NAME:HC-05|OK', `AT mode (EN high, 38400): ${lines(sim).join(' | ')}`);
}
// 5. SIM800L: boot, AT, signal, SMS
const SIMP = ['NET', 'VCC', 'RST', 'RXD', 'TXD', 'GND'];
{
  const { sim } = make([['g', 'mod-sim800l', SIMP]], [['g:TXD', 'uno:2'], ['g:RXD', 'uno:3'], ['g:VCC', 'uno:5V'], ['g:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial gsm(2, 3);
void cmd(const char *c, int w = 300) { gsm.println(c); delay(w); while (gsm.available()) Serial.write(gsm.read()); }
void setup(){ Serial.begin(115200); gsm.begin(9600); delay(4000); while (gsm.available()) Serial.write(gsm.read());
  cmd("ATE0"); cmd("AT+CSQ"); cmd("AT+CMGF=1"); gsm.println("AT+CMGS=\\"+6281234567890\\""); delay(300); gsm.print("Suhu 31C"); gsm.write(26); delay(2500); while (gsm.available()) Serial.write(gsm.read()); }
void loop(){}`);
  sim.running = true; sim.advance(9000); sim.running = false;
  const t = sim.serial;
  ok(/SMS Ready/.test(t) && /\+CSQ: 20,0/.test(t) && /\+CMGS: 1/.test(t), `SIM800L dialogue: ${JSON.stringify(t.replace(/\r?\n+/g, ' '))}`);
  ok(/mengirim SMS ke \+6281234567890: "Suhu 31C"/.test(logText(sim)) && /SIM800L butuh 3,4/.test(logText(sim)), 'SMS logged + 5 V supply warning');
}
// 6. ESP-01 AT firmware: join WiFi, TCP + HTTP GET through the browser fetch
{
  const seen = [];
  globalThis.fetch = async (url, o) => { seen.push([o.method, url]); return { status: 200, arrayBuffer: async () => new TextEncoder().encode('0').buffer }; };
  const ESP = ['GND', 'IO2', 'IO0', 'RX', 'TX', 'EN', 'RST', '3V3'];
  const { sim } = make([['e', 'mod-esp01', ESP, {}, { baud: '9600' }]], [['e:TX', 'uno:2'], ['e:RX', 'uno:3'], ['e:3V3', 'uno:3.3V'], ['e:EN', 'uno:3.3V'], ['e:GND', 'uno:GND.1']],
    `#include <SoftwareSerial.h>
SoftwareSerial esp(2, 3);
void cmd(const char *c, int w) { esp.println(c); unsigned long t = millis(); while (millis() - t < w) while (esp.available()) Serial.write(esp.read()); }
void setup(){ Serial.begin(115200); esp.begin(9600); delay(600); while (esp.available()) esp.read();
  cmd("AT", 300); cmd("AT+CWMODE=1", 300); cmd("AT+CWJAP=\\"Sekolah\\",\\"rahasia\\"", 3000); cmd("AT+CIPSTART=\\"TCP\\",\\"api.thingspeak.com\\",80", 500);
  String req = "GET /update?api_key=ABC&field1=27 HTTP/1.1\\r\\nHost: api.thingspeak.com\\r\\n\\r\\n";
  esp.print("AT+CIPSEND="); esp.println(req.length()); delay(300); esp.print(req);
  unsigned long t = millis(); while (millis() - t < 3000) while (esp.available()) Serial.write(esp.read()); }
void loop(){}`);
  for (let i = 0; i < 100; i++) { sim.advance(100); await new Promise((r) => setTimeout(r, 1)); }   // let the browser fetch resolve between slices
  const t = sim.serial.replace(/\r?\n+/g, ' ');
  ok(/WIFI GOT IP/.test(t) && /CONNECT/.test(t) && /SEND OK/.test(t), `AT dialogue: ${t.slice(0, 260)}`);
  ok(seen.length === 1 && seen[0][0] === 'GET' && seen[0][1] === 'http://api.thingspeak.com/update?api_key=ABC&field1=27', `HTTP request made: ${JSON.stringify(seen)}`);
  ok(/\+IPD,\d+:HTTP\/1\.1 200 OK[\s\S]*0 ?CLOSED/.test(t), `response delivered as +IPD then CLOSED: ${t.slice(-160)}`);
}
done();
