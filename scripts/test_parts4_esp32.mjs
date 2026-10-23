// Headless tests for the WebAssembly ESP32 / ESP8266 runtime: real Arduino sketches compiled with wasi-sdk.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src, board = 'esp32') {
  writeFileSync('/tmp/_w.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_w.ino').read(), '${board}')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); return Buffer.from(r.wasm, 'base64');
}
class Stub {
  constructor(tag, pins, props = {}) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; this.leds = {}; Object.assign(this, props); }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener(e, f) { this.l[e] = (this.l[e] || []).filter((x) => x !== f); }
  fire(e, detail) { (this.l[e] || []).forEach((f) => f({ detail })); }
  setLed(k, on) { this.leds[k] = on; }
  drawFrame(bits) { this.frame = bits; }
}
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
const NODEMCU = 'A0 RSV RSV.2 SD3 SD2 SD1 CMD SD0 CLK GND 3V3 EN RST GND.2 VIN D0 D1 D2 D3 D4 3V3.2 GND.3 D5 D6 D7 D8 RX TX GND.4 3V3.3'.split(' ');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function make(def, conns, sketch, { board = ['esp', 'wokwi-esp32-devkit-v1', ESP], kind = 'esp32' } = {}) {
  const sim = new Simulator();
  const model = { parts: [{ id: board[0], type: board[1], attrs: {} }], connections: conns };
  const els = new Map([[board[0], new Stub(board[1], board[2])]]);
  for (const [id, type, pins, props, attrs] of def) { model.parts.push({ id, type, attrs: attrs || {} }); els.set(id, new Stub(type, pins, props)); }
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  sim.bt = ''; sim.on('bt', (e) => { if (e.type === 'data') sim.bt += Buffer.from(e.bytes).toString(); else sim.btName = e.name; });
  const diag = sim.build(model, els); await sim.loadWasm(compile(sketch, kind));
  return { sim, els, model, diag };
}
const runMs = async (sim, ms) => { for (let t = 0; t < ms; t += 10) { sim.advance(10); if (sim.board.state === 'http' || sim.board.state === 'httpdone') await new Promise((r) => setTimeout(r, 5)); } };
const logs = (sim) => sim.logs.map((l) => l.level + ': ' + l.text).join('\n');

// Phase 4 (SPI) on the WebAssembly ESP32 runtime: ILI9341, microSD, MAX7219 (MD_Parola), SSD1306 SPI.
const lines = (sim) => sim.serial.trim().split(/\r?\n/);
{
  const { sim, els } = await make([['t', 'wokwi-ili9341', ['VCC', 'GND', 'CS', 'RST', 'D/C', 'MOSI', 'SCK', 'LED', 'MISO'], {}]],
    [['esp:D5', 't:CS'], ['esp:D2', 't:D/C'], ['esp:D4', 't:RST'], ['esp:D23', 't:MOSI'], ['esp:D18', 't:SCK'], ['esp:D19', 't:MISO'], ['t:VCC', 'esp:3V3'], ['t:GND', 'esp:GND.1']],
    `#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
Adafruit_ILI9341 tft(5, 2, 4);
void setup(){ Serial.begin(115200); tft.begin(); tft.fillScreen(ILI9341_RED); tft.fillRect(10, 10, 20, 20, ILI9341_GREEN); Serial.println("done"); }
void loop(){}`);
  await runMs(sim, 1500);
  const fb = els.get('t').fb, at = (x, y) => fb && fb[y * 240 + x];
  ok(lines(sim).includes('done') && at(100, 100) === 0xf800 && at(15, 15) === 0x07e0, `ESP32 ILI9341: ${at(100, 100)?.toString(16)} ${at(15, 15)?.toString(16)}`);
}
{
  const { sim } = await make([['sd', 'wokwi-microsd-card', ['CD', 'DO', 'GND', 'SCK', 'VCC', 'DI', 'CS']]],
    [['esp:D5', 'sd:CS'], ['esp:D23', 'sd:DI'], ['esp:D19', 'sd:DO'], ['esp:D18', 'sd:SCK'], ['sd:VCC', 'esp:3V3'], ['sd:GND', 'esp:GND.1']],
    `#include <SPI.h>
#include <SD.h>
void setup(){ Serial.begin(115200); if (!SD.begin(5)) { Serial.println("init failed"); return; }
  File f = SD.open("/esp.txt", FILE_WRITE); f.println("halo ESP32"); f.close();
  f = SD.open("/esp.txt"); while (f.available()) Serial.write(f.read()); f.close(); }
void loop(){}`);
  await runMs(sim, 2000);
  ok(lines(sim)[0] === 'halo ESP32', `ESP32 microSD: ${lines(sim).join(' | ')}`);
}
{
  const { sim, els } = await make([['m', 'mod-max7219-4', ['VCC', 'GND', 'DIN', 'CS', 'CLK', 'VCC.2', 'GND.2', 'DOUT', 'CS.2', 'CLK.2'], { setMatrix(r) { this.last = r; } }]],
    [['esp:D23', 'm:DIN'], ['esp:D18', 'm:CLK'], ['esp:D5', 'm:CS'], ['m:VCC', 'esp:VIN'], ['m:GND', 'esp:GND.1']],
    `#include <MD_Parola.h>
#include <MD_MAX72xx.h>
#include <SPI.h>
MD_Parola P(MD_MAX72XX::FC16_HW, 5, 4);
void setup(){ P.begin(); P.displayText("ABCD", PA_CENTER, 0, 0, PA_PRINT, PA_NO_EFFECT); }
void loop(){ P.displayAnimate(); delay(1); }`);
  await runMs(sim, 600);
  const m = els.get('m').last;
  ok(m && m.every((rows) => rows.some((r) => r)), 'ESP32 MD_Parola: all four matrices show text');
}
{
  const { sim } = await make([['sd', 'wokwi-microsd-card', ['CD', 'DO', 'GND', 'SCK', 'VCC', 'DI', 'CS']]],
    [['esp:D5', 'sd:CS'], ['esp:D23', 'sd:DI'], ['esp:D19', 'sd:DO'], ['esp:D18', 'sd:SCK'], ['sd:VCC', 'esp:3V3'], ['sd:GND', 'esp:GND.1']],
    `#include "FS.h"
#include "SD.h"
#include "SPI.h"
void appendFile(fs::FS &fs, const char *path, const char *msg) { File f = fs.open(path, FILE_APPEND); if (!f) { Serial.println("open failed"); return; } f.print(msg); f.close(); }
void setup(){ Serial.begin(115200); if (!SD.begin()) { Serial.println("Card Mount Failed"); return; }
  Serial.printf("type %d size %lluMB\\n", SD.cardType(), SD.cardSize() / (1024 * 1024));
  appendFile(SD, "/data.txt", "a"); appendFile(SD, "/data.txt", "b");
  File f = SD.open("/data.txt"); while (f.available()) Serial.write(f.read()); f.close(); Serial.println(); }
void loop(){}`);
  await runMs(sim, 2000);
  ok(lines(sim).join('|') === 'type 3 size 64MB|ab', `ESP32 core-style SD sketch (fs::FS, FILE_APPEND, cardType): ${lines(sim).join(' | ')}`);
}
{
  const { sim } = await make([['rc', 'mod-rc522', ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'], {}, { card: 'Kartu 1' }]],
    [['esp:D5', 'rc:SDA'], ['esp:D18', 'rc:SCK'], ['esp:D23', 'rc:MOSI'], ['esp:D19', 'rc:MISO'], ['esp:D4', 'rc:RST'], ['rc:3.3V', 'esp:3V3'], ['rc:GND', 'esp:GND.1']],
    `#include <SPI.h>
#include <MFRC522.h>
MFRC522 rfid(5, 4);
void setup(){ Serial.begin(115200); SPI.begin(); rfid.PCD_Init(); }
void loop(){ if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  for (byte i = 0; i < rfid.uid.size; i++) Serial.printf("%02X", rfid.uid.uidByte[i]); Serial.println(); rfid.PICC_HaltA(); }`);
  await runMs(sim, 600);
  ok(lines(sim)[0] === 'D34F8A1E', `ESP32 RC522 UID: ${lines(sim).join(' | ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
