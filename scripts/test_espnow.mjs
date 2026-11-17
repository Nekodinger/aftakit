// ESP-NOW on the WebAssembly runtime: receiver (2.x and 3.x callback styles), sender with send callback, ESP8266 API.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname;
function compile(src, board = 'esp32') {
  writeFileSync('/tmp/_now.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_now.ino').read(), '${board}')))`], { cwd: root, maxBuffer: 1e8 });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); return Buffer.from(r.wasm, 'base64');
}
class Stub { constructor(tag, pins) { this.tagName = tag.toUpperCase(); this.pinInfo = pins.map((n) => ({ name: n })); this.l = {}; } addEventListener(e, f) { (this.l[e] ||= []).push(f); } removeEventListener() {} setLed() {} }
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
const NODEMCU = 'A0 RSV RSV.2 SD3 SD2 SD1 CMD SD0 CLK GND 3V3 EN RST GND.2 VIN D0 D1 D2 D3 D4 3V3.2 GND.3 D5 D6 D7 D8 RX TX GND.4 3V3.3'.split(' ');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function make(sketch, board = ['esp', 'wokwi-esp32-devkit-v1', ESP], kind = 'esp32') {
  const sim = new Simulator();
  const model = { parts: [{ id: board[0], type: board[1], attrs: {} }], connections: [] };
  const els = new Map([[board[0], new Stub(board[1], board[2])]]);
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  sim.now = []; sim.on('espnow', (e) => sim.now.push(e));
  sim.build(model, els); await sim.loadWasm(compile(sketch, kind));
  return sim;
}
const runMs = (sim, ms) => { for (let t = 0; t < ms; t += 10) sim.advance(10); };
const REMOTE = [0x24, 0x6f, 0x28, 0xaa, 0xbb, 0xcc];

// 1. receiver, Arduino-ESP32 3.x callback (esp_now_recv_info_t) + struct payload
{
  const sim = await make(`#include <esp_now.h>
#include <WiFi.h>
typedef struct { int x; int y; bool btn; } Msg;
Msg m;
void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  memcpy(&m, data, sizeof m);
  Serial.printf("from %02X:%02X len=%d x=%d y=%d b=%d\\n", info->src_addr[0], info->src_addr[5], len, m.x, m.y, m.btn);
}
void setup() { Serial.begin(115200); WiFi.mode(WIFI_STA); Serial.println(WiFi.macAddress());
  if (esp_now_init() != ESP_OK) { Serial.println("init fail"); return; }
  esp_now_register_recv_cb(onRecv); }
void loop() { delay(20); }`);
  runMs(sim, 100);
  ok(sim.espnowActive && sim.now.some((e) => e.type === 'init'), 'esp_now_init() reported to the simulator');
  const buf = new Uint8Array(12); const dv = new DataView(buf.buffer); dv.setInt32(0, -57, true); dv.setInt32(4, 100, true); buf[8] = 1;
  ok(sim.espnowSend(REMOTE, buf), 'packet queued for the sketch');
  runMs(sim, 100);
  ok(/24:A1:60:2E:3C:10/.test(sim.serial), 'WiFi.macAddress() prints the board MAC');
  ok(/from 24:CC len=12 x=-57 y=100 b=1/.test(sim.serial), `3.x receive callback decodes the struct: ${JSON.stringify(sim.serial.trim().split('\n').pop())}`);
}
// 2. receiver, 2.x callback (mac first) with a cast as in many tutorials + char commands driving a GPIO
{
  const sim = await make(`#include <esp_now.h>
#include <WiFi.h>
volatile char cmd = 'S';
void OnDataRecv(const uint8_t * mac, const uint8_t *incomingData, int len) { cmd = incomingData[0]; }
void setup() { Serial.begin(115200); pinMode(2, OUTPUT); WiFi.mode(WIFI_STA); esp_now_init(); esp_now_register_recv_cb(OnDataRecv); }
void loop() { digitalWrite(2, cmd == 'F'); static char last = 0; if (cmd != last) { last = cmd; Serial.print("cmd="); Serial.println(cmd); } delay(5); }`);
  runMs(sim, 50); sim.espnowSend(REMOTE, [70]); runMs(sim, 60);
  const on = sim.board.pins.D2.level; sim.espnowSend(REMOTE, [83]); runMs(sim, 60);
  ok(on === 1 && sim.board.pins.D2.level === 0 && /cmd=F[\s\S]*cmd=S/.test(sim.serial), `2.x callback: 'F' -> GPIO2 HIGH, 'S' -> LOW (${on}, ${sim.board.pins.D2.level})`);
}
// 3. sender with peer + send callback (2.x and 3.x signatures compile; status reported)
{
  const sim = await make(`#include <esp_now.h>
#include <WiFi.h>
uint8_t peer[] = {0x24, 0x6F, 0x28, 0xAA, 0xBB, 0xCC};
esp_now_peer_info_t pi;
void onSent(const uint8_t *mac, esp_now_send_status_t st) { Serial.println(st == ESP_NOW_SEND_SUCCESS ? "ok" : "fail"); }
void setup() { Serial.begin(115200); WiFi.mode(WIFI_STA); esp_now_init(); esp_now_register_send_cb(onSent);
  memcpy(pi.peer_addr, peer, 6); pi.channel = 0; pi.encrypt = false;
  Serial.println(esp_now_add_peer(&pi) == ESP_OK ? "peer" : "nopeer");
  uint8_t other[] = {1,2,3,4,5,6}; Serial.println(esp_now_send(other, (uint8_t*)"x", 1) == ESP_OK ? "sent?" : "notfound"); }
void loop() { const char *t = "hello"; esp_now_send(peer, (const uint8_t*)t, 5); delay(100); }`);
  runMs(sim, 250);
  const sent = sim.now.filter((e) => e.type === 'send');
  ok(sent.length >= 2 && Buffer.from(sent[0].data).toString() === 'hello' && sent[0].mac[5] === 0xcc, `esp_now_send delivers to the virtual partner (${sent.length} packets)`);
  ok(/peer[\s\S]*notfound[\s\S]*ok/.test(sim.serial), `add_peer OK, unknown peer rejected, send callback SUCCESS: ${JSON.stringify(sim.serial.replace(/\s+/g, ' '))}`);
}
{
  const sim = await make(`#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
uint8_t bc[] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
void onSent(const wifi_tx_info_t *info, esp_now_send_status_t st) { Serial.printf("sent %02X %d\\n", info->des_addr[0], st); }
void setup() { Serial.begin(115200); WiFi.mode(WIFI_STA); esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE); uint8_t mac[6]; esp_wifi_get_mac(WIFI_IF_STA, mac); Serial.printf("mac %02X\\n", mac[5]);
  esp_now_init(); esp_now_register_send_cb(onSent); esp_now_send(bc, (const uint8_t*)"B", 1); }
void loop() { delay(50); }`);
  runMs(sim, 100);
  ok(/mac 10[\s\S]*sent FF 0/.test(sim.serial), `3.3 send callback (wifi_tx_info_t), broadcast, esp_wifi.h: ${JSON.stringify(sim.serial.replace(/\s+/g, ' '))}`);
}
// 4. ESP8266 espnow.h
{
  const sim = await make(`#include <ESP8266WiFi.h>
#include <espnow.h>
void OnDataRecv(uint8_t *mac, uint8_t *data, uint8_t len) { Serial.printf("got %d %c\\n", len, data[0]); }
void setup() { Serial.begin(115200); WiFi.mode(WIFI_STA); if (esp_now_init() != 0) Serial.println("fail");
  esp_now_set_self_role(ESP_NOW_ROLE_SLAVE); esp_now_register_recv_cb(OnDataRecv); }
void loop() { delay(10); }`, ['mcu', 'mod-nodemcu', NODEMCU], 'esp8266');
  runMs(sim, 50); sim.espnowSend(REMOTE, [76, 1]); runMs(sim, 50);
  ok(/got 2 L/.test(sim.serial), `ESP8266 espnow.h receive: ${JSON.stringify(sim.serial.trim())}`);
}
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
