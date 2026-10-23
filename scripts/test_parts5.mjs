// Phase 5 tests: radios. nRF24L01 (RF24 library) and LoRa SX1278 (LoRa library by Sandeep Mistry).
import { make, ok, done, lines, logText } from './testkit.mjs';

const NRF = ['GND', 'CE', 'SCK', 'MISO', 'VCC', 'CSN', 'MOSI', 'IRQ'];
const nrfW = (id, ce, csn) => [[`uno:${ce}`, `${id}:CE`], [`uno:${csn}`, `${id}:CSN`], ['uno:13', `${id}:SCK`], ['uno:11', `${id}:MOSI`], ['uno:12', `${id}:MISO`], [`${id}:VCC`, 'uno:3.3V'], [`${id}:GND`, 'uno:GND.1']];
const TX = (extra = '') => `#include <SPI.h>
#include <RF24.h>
RF24 radio(9, 10); const byte addr[6] = "00001";
void setup(){ Serial.begin(115200); Serial.println(radio.begin() ? "begin ok" : "begin fail"); Serial.println(radio.isChipConnected() ? "chip ok" : "no chip");
  radio.openWritingPipe(addr); radio.setPALevel(RF24_PA_MIN); radio.stopListening(); ${extra} }
void loop(){ const char t[] = "Halo"; Serial.println(radio.write(&t, sizeof(t)) ? "sent ok" : "sent fail"); delay(300); }`;
// 1. single radio, virtual receiver acknowledges
{
  const { sim } = make([['r', 'mod-nrf24', NRF, {}, { peer: 'penerima virtual' }]], nrfW('r', 9, 10), TX());
  sim.advance(1000);
  const l = lines(sim);
  ok(l[0] === 'begin ok' && l[1] === 'chip ok', `RF24 begin / isChipConnected: ${l.slice(0, 2).join(' | ')}`);
  ok(l.slice(2).length >= 3 && l.slice(2).every((x) => x === 'sent ok'), `write() acknowledged: ${l.slice(2).join(' | ')}`);
  ok(/kirim → alamat "00001", kanal 76: "Halo"/.test(logText(sim)), `traffic log: ${logText(sim).slice(0, 120)}`);
}
// 2. nobody listening -> write() fails after the auto-retransmits (MAX_RT)
{
  const { sim } = make([['r', 'mod-nrf24', NRF, {}, { peer: 'tidak ada' }]], nrfW('r', 9, 10), TX());
  sim.advance(800);
  ok(lines(sim).slice(2).every((x) => x === 'sent fail') && lines(sim).length > 2, `no receiver: ${lines(sim).slice(2).join(' | ')}`);
}
// 3. no power on VCC -> begin fails
{
  const { sim } = make([['r', 'mod-nrf24', NRF]], nrfW('r', 9, 10).filter((w) => w[0] !== 'r:VCC'), TX());
  sim.advance(300);
  ok(lines(sim)[0] === 'begin fail', `unpowered module: ${lines(sim)[0]}`);
}
// 4. two radios on one board: radio A sends, radio B (other CE/CSN) receives on the same address
{
  const { sim } = make([['a', 'mod-nrf24', NRF, {}, { peer: 'tidak ada' }], ['b', 'mod-nrf24', NRF, {}, { peer: 'tidak ada' }]], [...nrfW('a', 9, 10), ...nrfW('b', 7, 8)],
    `#include <SPI.h>
#include <RF24.h>
RF24 tx(9, 10), rx(7, 8); const byte addr[6] = "NODE1";
void setup(){ Serial.begin(115200); tx.begin(); rx.begin(); tx.openWritingPipe(addr); tx.stopListening(); rx.openReadingPipe(1, addr); rx.startListening(); }
void loop(){ static int n = 0; char m[16]; sprintf(m, "pesan %d", n++); bool ok = tx.write(m, sizeof(m)); byte pipe; if (rx.available(&pipe)) { char in[16]; rx.read(in, sizeof(in)); Serial.print(ok ? "ack " : "noack "); Serial.print(pipe); Serial.print(" "); Serial.println(in); } delay(200); }`);
  sim.advance(1000);
  const l = lines(sim);
  ok(l.length >= 3 && l[0] === 'ack 1 pesan 0' && l[1] === 'ack 1 pesan 1', `radio-to-radio with auto-ack: ${l.join(' | ')}`);
}
// 5. echo peer: ping-pong round trip
{
  const { sim } = make([['r', 'mod-nrf24', NRF, {}, { peer: 'gema (kirim balik)' }]], nrfW('r', 9, 10),
    `#include <SPI.h>
#include <RF24.h>
RF24 radio(9, 10); const byte a[6] = "PING1", b[6] = "PONG1";
void setup(){ Serial.begin(115200); radio.begin(); radio.openWritingPipe(a); radio.openReadingPipe(1, b); }
void loop(){ radio.stopListening(); unsigned long t = micros(); radio.write(&t, sizeof(t)); radio.startListening(); unsigned long s = millis();
  while (!radio.available()) if (millis() - s > 200) { Serial.println("timeout"); return; }
  unsigned long got; radio.read(&got, sizeof(got)); Serial.println(got == t ? "pong ok" : "pong bad"); delay(300); }`);
  sim.advance(1200);
  ok(lines(sim).length >= 2 && lines(sim).every((x) => x === 'pong ok'), `echo round trip: ${lines(sim).join(' | ')}`);
}
// 6. LoRa: begin, send (TxDone after the real time-on-air), echo peer answers, parsePacket + RSSI
const LORA = ['GND', '3.3V', 'RST', 'DIO0', 'NSS', 'MOSI', 'MISO', 'SCK'];
const loraW = (id, nss, rst, dio) => [[`uno:${nss}`, `${id}:NSS`], [`uno:${rst}`, `${id}:RST`], [`uno:${dio}`, `${id}:DIO0`], ['uno:13', `${id}:SCK`], ['uno:11', `${id}:MOSI`], ['uno:12', `${id}:MISO`], [`${id}:3.3V`, 'uno:3.3V'], [`${id}:GND`, 'uno:GND.1']];
{
  const { sim } = make([['l', 'mod-lora', LORA, {}, { peer: 'gema (kirim balik)' }]], loraW('l', 10, 9, 2),
    `#include <SPI.h>
#include <LoRa.h>
void setup(){ Serial.begin(115200); LoRa.setPins(10, 9, 2); if (!LoRa.begin(433E6)) { Serial.println("LoRa fail"); while (1); } Serial.println("LoRa ok");
  unsigned long t = millis(); LoRa.beginPacket(); LoRa.print("suhu=27"); LoRa.endPacket(); Serial.println(millis() - t); }
void loop(){ int n = LoRa.parsePacket(); if (n) { String s; while (LoRa.available()) s += (char)LoRa.read(); Serial.print("rx "); Serial.print(s); Serial.print(" rssi "); Serial.println(LoRa.packetRssi()); } }`);
  sim.advance(1500);
  const l = lines(sim);
  ok(l[0] === 'LoRa ok', `LoRa.begin(433E6): ${l[0]}`);
  const toa = +l[1];
  ok(toa >= 30 && toa <= 34, `endPacket waits for the time on air: ${toa} ms (SF7, 125 kHz, CR 4/5, no CRC, 7 bytes: 31.0 ms)`);
  ok(l[2] === 'rx suhu=27 rssi -72', `echo peer answers: ${l[2]}`);
}
// 7. two LoRa modules (polled receiver): only matching spreading factors are heard
{
  const { sim } = make([['a', 'mod-lora', LORA], ['b', 'mod-lora', LORA]], [...loraW('a', 10, 9, 3), ...loraW('b', 8, 7, 2)],
    `#include <SPI.h>
#include <LoRa.h>
LoRaClass rx;
void setup(){ Serial.begin(115200);
  rx.setPins(8, 7, 2); rx.begin(915E6); rx.setSpreadingFactor(9);
  LoRa.setPins(10, 9, 3); LoRa.begin(915E6);
  rx.parsePacket();                                                              // enter RX single mode
  LoRa.beginPacket(); LoRa.print("SF salah"); LoRa.endPacket();                // SF7: not heard by the SF9 receiver
  LoRa.setSpreadingFactor(9); LoRa.beginPacket(); LoRa.print("halo node B"); LoRa.endPacket(); }
void loop(){ int n = rx.parsePacket(); if (n) { Serial.print(n); Serial.print(" "); while (rx.available()) Serial.write(rx.read()); Serial.println(); } }`);
  sim.advance(1500);
  ok(lines(sim).join('|') === '11 halo node B', `radio-to-radio + SF filtering: ${lines(sim).join(' | ')}`);
}
// 8. interrupt-driven receive (onReceive on DIO0 -> INT0) of the echo peer's answer
{
  const { sim } = make([['l', 'mod-lora', LORA, {}, { peer: 'gema (kirim balik)' }]], loraW('l', 10, 9, 2),
    `#include <SPI.h>
#include <LoRa.h>
volatile int got = 0; char buf[32];
void onRx(int n){ int i = 0; while (LoRa.available() && i < 31) buf[i++] = LoRa.read(); buf[i] = 0; got = n; }
void setup(){ Serial.begin(115200); LoRa.setPins(10, 9, 2); LoRa.begin(868E6); LoRa.onReceive(onRx);
  LoRa.beginPacket(); LoRa.print("ping"); LoRa.endPacket(); LoRa.receive(); }
void loop(){ if (got) { Serial.print(got); Serial.print(" "); Serial.print(buf); Serial.print(" "); Serial.println(LoRa.packetRssi()); got = 0; } }`);
  sim.advance(1000);
  ok(lines(sim).join('|') === '4 ping -72', `DIO0 interrupt (RxDone): ${lines(sim).join(' | ')}`);
}
done();
