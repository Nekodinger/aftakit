// Phase 4 tests (SPI): MAX7219 matrices (LedControl bit-bang, raw hardware SPI, MD_Parola on a 4-in-1), SSD1306 over SPI.
import { make, ok, done, lines, logText, Stub } from './testkit.mjs';

const MX = ['VCC', 'GND', 'DIN', 'CS', 'CLK', 'VCC.2', 'GND.2', 'DOUT', 'CS.2', 'CLK.2'];
const mxEl = () => ({ frames: [], setMatrix(rows, br) { this.last = rows.map((r) => Array.from(r)); this.br = br; } });
const pw = (id) => [[`${id}:VCC`, 'uno:5V'], [`${id}:GND`, 'uno:GND.1']];
// 1. LedControl (shiftOut bit-bang) on an 8x8 module
{
  const { sim, els } = make([['m', 'mod-max7219', MX, mxEl()]], [['uno:12', 'm:DIN'], ['uno:11', 'm:CLK'], ['uno:10', 'm:CS'], ...pw('m')],
    `#include <LedControl.h>
LedControl lc(12, 11, 10, 1);
void setup(){ lc.shutdown(0, false); lc.setIntensity(0, 8); lc.clearDisplay(0); lc.setRow(0, 0, B10100101); lc.setLed(0, 7, 7, true); lc.setColumn(0, 3, B11110000); }
void loop(){}`);
  sim.advance(300);
  const r = els.get('m').last[0];
  ok(r[0] === 0b10110101 && r[7] === 0b00000001 && r[1] === 0b00010000 && r[3] === 0b00010000 && r[4] === 0, `LedControl rows: ${r.map((x) => x.toString(2).padStart(8, '0')).join(' ')}`);
  ok(Math.abs(els.get('m').br - 9 / 16) < 1e-9, `intensity 8 -> brightness ${els.get('m').br}`);
}
// 2. raw hardware SPI (SPI.transfer) and the power-on shutdown state
{
  const { sim, els } = make([['m', 'mod-max7219', MX, mxEl()]], [['uno:11', 'm:DIN'], ['uno:13', 'm:CLK'], ['uno:10', 'm:CS'], ...pw('m')],
    `#include <SPI.h>
void w(byte a, byte d){ digitalWrite(10, LOW); SPI.transfer(a); SPI.transfer(d); digitalWrite(10, HIGH); }
void setup(){ pinMode(10, OUTPUT); digitalWrite(10, HIGH); SPI.begin(); w(0x0B, 7); w(0x09, 0); w(0x0A, 3); for (byte i = 1; i <= 8; i++) w(i, 1 << (i - 1)); delay(100); w(0x0C, 1); }
void loop(){}`);
  sim.advance(50);
  const before = els.get('m').last[0].every((x) => x === 0);
  sim.advance(200);
  const r = els.get('m').last[0];
  ok(before && r.every((x, i) => x === 1 << i), `hardware SPI: dark while in shutdown (${before}), then diagonal ${r.join(',')}`);
}
// 3. MD_Parola on a 4-in-1 FC-16 module: static text is drawn across the four devices
{
  const { sim, els } = make([['m', 'mod-max7219-4', MX, mxEl()]], [['uno:11', 'm:DIN'], ['uno:13', 'm:CLK'], ['uno:10', 'm:CS'], ...pw('m')],
    `#include <MD_Parola.h>
#include <MD_MAX72xx.h>
#include <SPI.h>
MD_Parola P(MD_MAX72XX::FC16_HW, 10, 4);
void setup(){ P.begin(); P.setIntensity(2); P.displayText("8888", PA_CENTER, 0, 0, PA_PRINT, PA_NO_EFFECT); }
void loop(){ P.displayAnimate(); }`);
  sim.advance(600);
  const m = els.get('m').last; const lit = m.map((rows) => rows.reduce((a, r) => a + r.toString(2).split('1').length - 1, 0));
  ok(lit.every((n) => n > 8), `Parola "8888": lit LEDs per device ${lit.join(' ')}`);
  // an '8' is left-right symmetric only roughly; check that row 0 (top) and row 7 (bottom, descender row) differ as text should
  ok(m.some((rows) => rows[7] === 0), 'bottom row stays dark under the digits (correct row orientation)');
}
// 4. SSD1306 over hardware SPI with Adafruit_SSD1306
const OLED = ['DATA', 'CLK', 'DC', 'RST', 'CS', '3V3', 'VIN', 'GND'];
const oledEl = () => ({ imageData: { data: new Uint8ClampedArray(128 * 64 * 4) }, redraw() { this.n = (this.n || 0) + 1; } });
const px = (el, x, y) => el.imageData.data[(y * 128 + x) * 4 + 1] > 0;
{
  const { sim, els } = make([['o', 'wokwi-ssd1306', OLED, oledEl()]],
    [['uno:11', 'o:DATA'], ['uno:13', 'o:CLK'], ['uno:9', 'o:DC'], ['uno:8', 'o:RST'], ['uno:10', 'o:CS'], ['o:VIN', 'uno:5V'], ['o:GND', 'uno:GND.1']],
    `#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 d(128, 64, &SPI, 9, 8, 10);
void setup(){ Serial.begin(9600); if(!d.begin(SSD1306_SWITCHCAPVCC)){ Serial.println("FAIL"); return; } d.clearDisplay(); d.fillRect(10, 20, 5, 3, SSD1306_WHITE); d.drawPixel(127, 63, SSD1306_WHITE); d.display(); Serial.println("OK"); }
void loop(){}`);
  sim.advance(500);
  const el = els.get('o');
  ok(lines(sim)[0] === 'OK' && px(el, 10, 20) && px(el, 14, 22) && !px(el, 15, 20) && px(el, 127, 63) && !px(el, 0, 0), `SSD1306 SPI (hardware): rectangle + corner pixel drawn (serial ${lines(sim)[0]})`);
}
// 5. SSD1306 over software SPI (any pins)
{
  const { sim, els } = make([['o', 'wokwi-ssd1306', OLED, oledEl()]],
    [['uno:6', 'o:DATA'], ['uno:7', 'o:CLK'], ['uno:5', 'o:DC'], ['uno:4', 'o:RST'], ['uno:3', 'o:CS'], ['o:3V3', 'uno:3.3V'], ['o:GND', 'uno:GND.1']],
    `#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 d(128, 64, 6, 7, 5, 4, 3);
void setup(){ d.begin(SSD1306_SWITCHCAPVCC); d.clearDisplay(); d.drawLine(0, 0, 63, 0, SSD1306_WHITE); d.display(); }
void loop(){}`);
  sim.advance(800);
  const el = els.get('o');
  ok(px(el, 0, 0) && px(el, 63, 0) && !px(el, 64, 0), 'SSD1306 software SPI on pins 3-7, powered from 3V3');
}
// 6. ILI9341 TFT with Adafruit_ILI9341 (hardware SPI): colours, rotation, text
const TFT = ['VCC', 'GND', 'CS', 'RST', 'D/C', 'MOSI', 'SCK', 'LED', 'MISO'];
const tftWires = [['uno:10', 't:CS'], ['uno:9', 't:D/C'], ['uno:8', 't:RST'], ['uno:11', 't:MOSI'], ['uno:13', 't:SCK'], ['uno:12', 't:MISO'], ['t:VCC', 'uno:5V'], ['t:GND', 'uno:GND.1'], ['t:LED', 'uno:5V']];
{
  const { sim, els } = make([['t', 'wokwi-ili9341', TFT, {}]], tftWires,
    `#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
Adafruit_ILI9341 tft(10, 9, 8);
void setup(){ Serial.begin(9600); tft.begin(); Serial.println(tft.readcommand8(ILI9341_RDMODE), HEX);
  tft.fillScreen(ILI9341_BLUE); tft.drawPixel(0, 0, ILI9341_RED); tft.fillRect(100, 200, 10, 10, ILI9341_GREEN);
  tft.setRotation(1); tft.drawPixel(0, 0, ILI9341_WHITE); tft.drawPixel(319, 239, ILI9341_YELLOW); Serial.println("done"); }
void loop(){}`);
  sim.advance(3000);
  const fb = els.get('t').fb, at = (x, y) => fb && fb[y * 240 + x];
  ok(lines(sim).includes('done'), `sketch finished (${lines(sim).join(' | ')})`);
  ok(at(0, 0) === 0xf800 && at(120, 160) === 0x001f && at(105, 205) === 0x07e0 && at(110, 205) === 0x001f, `rotation 0: red corner, blue fill, green square (${[at(0, 0), at(120, 160), at(105, 205)].map((x) => x?.toString(16)).join(' ')})`);
  ok(at(239, 0) === 0xffff && at(0, 319) === 0xffe0, `rotation 1 (landscape): (0,0) -> top-right, (319,239) -> bottom-left (${at(239, 0)?.toString(16)} ${at(0, 319)?.toString(16)})`);
  ok(lines(sim)[0] === '9C', `read power mode over MISO: 0x${lines(sim)[0]} (expect 9C)`);
}
// 7. microSD with the Arduino SD library: mount the FAT16 card, write, append, read back, list, and the UI file reader
const SDP = ['CD', 'DO', 'GND', 'SCK', 'VCC', 'DI', 'CS'];
const sdW = [['uno:10', 'sd:CS'], ['uno:11', 'sd:DI'], ['uno:12', 'sd:DO'], ['uno:13', 'sd:SCK'], ['sd:VCC', 'uno:5V'], ['sd:GND', 'uno:GND.1']];
{
  const { sim } = make([['sd', 'wokwi-microsd-card', SDP]], sdW,
    `#include <SPI.h>
#include <SD.h>
void setup(){ Serial.begin(115200);
  if (!SD.begin(10)) { Serial.println("init failed"); return; }
  Serial.println("init ok");
  File f = SD.open("log.txt", FILE_WRITE); f.println("suhu,28.5"); f.close();
  f = SD.open("log.txt", FILE_WRITE); f.println("suhu,29.0"); f.close();
  SD.mkdir("data"); f = SD.open("data/a.csv", FILE_WRITE); for (int i = 0; i < 300; i++) f.println(i); f.close();
  f = SD.open("log.txt"); while (f.available()) Serial.write(f.read()); f.close();
  File r = SD.open("/"); while (true) { File e = r.openNextFile(); if (!e) break; Serial.print(e.name()); Serial.print(" "); Serial.println(e.size()); e.close(); }
  Serial.println(SD.exists("data/a.csv") ? "exists" : "missing");
}
void loop(){}`);
  sim.advance(3000);
  const l = lines(sim);
  ok(l[0] === 'init ok', `SD.begin: ${l[0]}`);
  ok(l[1] === 'suhu,28.5' && l[2] === 'suhu,29.0', `write + append + read back: ${l.slice(1, 3).join(' | ')}`);
  ok(l.some((x) => /^LOG\.TXT 22$/.test(x)) && l.some((x) => /^DATA \d+$/.test(x)) && l.includes('exists'), `directory listing: ${l.slice(3).join(' | ')}`);
  const files = sim.behaviors.find((b) => b.files).files();
  const csv = files.find((f) => f.name === '/DATA/A.CSV');
  const txt = csv && new TextDecoder().decode(csv.data());
  ok(files.some((f) => f.name === '/LOG.TXT' && f.size === 22) && txt && txt.split(/\r?\n/)[299] === '299', `UI reader sees ${files.map((f) => f.name + ':' + f.size).join(', ')}`);
  // the card keeps its files when the sketch is reloaded
  const s2 = sim; s2.loadHex(s2.hexText); s2.serial = ''; s2.advance(2500);
  ok(/suhu,28\.5\r?\nsuhu,29\.0\r?\nsuhu,28\.5/.test(s2.serial), 'files persist across a sketch restart (log grows)');
}
{
  const { sim } = make([['sd', 'wokwi-microsd-card', SDP, {}, { inserted: 'tidak' }]], sdW,
    `#include <SPI.h>
#include <SD.h>
void setup(){ Serial.begin(115200); Serial.println(SD.begin(10) ? "init ok" : "init failed"); }
void loop(){}`);
  sim.advance(2500);
  ok(lines(sim)[0] === 'init failed', 'no card inserted -> SD.begin fails');
}
// 8. RC522 + MIFARE Classic with the MFRC522 library: firmware version, tap / remove, UID, halt, auth + write + read
const RC = ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'];
const rcW = [['uno:10', 'rc:SDA'], ['uno:13', 'rc:SCK'], ['uno:11', 'rc:MOSI'], ['uno:12', 'rc:MISO'], ['uno:9', 'rc:RST'], ['rc:3.3V', 'uno:3.3V'], ['rc:GND', 'uno:GND.1']];
{
  const { sim, diag } = make([['rc', 'mod-rc522', RC, {}, { card: 'tidak ada' }]], rcW,
    `#include <SPI.h>
#include <MFRC522.h>
MFRC522 rfid(10, 9);
void setup(){ Serial.begin(115200); SPI.begin(); rfid.PCD_Init(); Serial.print("ver "); Serial.println(rfid.PCD_ReadRegister(MFRC522::VersionReg), HEX); }
void loop(){
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  Serial.print("UID");
  for (byte i = 0; i < rfid.uid.size; i++) { Serial.print(rfid.uid.uidByte[i] < 0x10 ? " 0" : " "); Serial.print(rfid.uid.uidByte[i], HEX); }
  Serial.print(" "); Serial.println(rfid.PICC_GetTypeName(rfid.PICC_GetType(rfid.uid.sak)));
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
}`);
  const part = sim.model.parts.find((p) => p.id === 'rc');
  sim.advance(400);
  part.attrs.card = 'Kartu 1'; sim.advance(500);
  part.attrs.card = 'tidak ada'; sim.advance(300);
  part.attrs.card = 'Gantungan kunci'; sim.advance(500);
  const l = lines(sim);
  ok(l[0] === 'ver 92', `firmware version register: ${l[0]}`);
  const uids = l.filter((x) => x.startsWith('UID'));
  ok(uids.length === 2 && uids[0] === 'UID D3 4F 8A 1E MIFARE 1KB' && uids[1] === 'UID 83 A5 11 0C MIFARE 1KB', `each tap is read once (halted afterwards): ${uids.join(' | ')}`);
}
{
  const { sim } = make([['rc', 'mod-rc522', RC, {}, { card: 'Kartu 2' }]], rcW,
    `#include <SPI.h>
#include <MFRC522.h>
MFRC522 rfid(10, 9); MFRC522::MIFARE_Key key;
void setup(){ Serial.begin(115200); SPI.begin(); rfid.PCD_Init(); for (byte i = 0; i < 6; i++) key.keyByte[i] = 0xFF;
  while (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) delay(10);
  byte st = rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 7, &key, &rfid.uid); Serial.println(rfid.GetStatusCodeName((MFRC522::StatusCode)st));
  byte data[16] = "Budi Santoso 7A"; st = rfid.MIFARE_Write(4, data, 16); Serial.println(rfid.GetStatusCodeName((MFRC522::StatusCode)st));
  byte buf[18]; byte n = sizeof(buf); st = rfid.MIFARE_Read(4, buf, &n); Serial.println(rfid.GetStatusCodeName((MFRC522::StatusCode)st)); Serial.println((char*)buf);
  rfid.PICC_HaltA(); rfid.PCD_StopCrypto1();
  // wrong key on another sector must fail
  MFRC522::MIFARE_Key bad; for (byte i = 0; i < 6; i++) bad.keyByte[i] = i;
  rfid.PICC_WakeupA(buf, &n); rfid.PICC_Select(&rfid.uid);
  st = rfid.PCD_Authenticate(MFRC522::PICC_CMD_MF_AUTH_KEY_A, 11, &bad, &rfid.uid); Serial.println(rfid.GetStatusCodeName((MFRC522::StatusCode)st)); }
void loop(){}`);
  sim.advance(1500);
  const l = lines(sim);
  ok(l[0] === 'Success.' && l[1] === 'Success.' && l[2] === 'Success.' && l[3] === 'Budi Santoso 7A', `auth / write / read block 4: ${l.slice(0, 4).join(' | ')}`);
  ok(l[4] && l[4] !== 'Success.', `wrong key is rejected: ${l[4]}`);
}
// 9. regression: the Uno's "3.3V" header pin is its own rail, not digital pin 3 with a ".3V" suffix
{
  const { sim, els } = make([['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }], ['led', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:3.3V', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'uno:GND.1']],
    'void setup(){ pinMode(3, OUTPUT); digitalWrite(3, LOW); } void loop(){}');
  sim.advance(50);
  const v = sim.last.v(sim.circuit.net('uno', '3.3V')), d3 = sim.last.v(sim.circuit.net('uno', '3'));
  ok(els.get('led').value && Math.abs(v * 5 - 3.3) < 0.01 && d3 === 0, `3.3V rail = ${(v * 5).toFixed(2)} V, D3 = ${d3} (LED on 3.3V lit: ${els.get('led').value})`);
}
done();
