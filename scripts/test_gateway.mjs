// End-to-end test of the IoT gateway with the ORIGINAL Arduino libraries (fetched by the library manager):
// Blynk, UniversalTelegramBot, PubSubClient (MQTT) + raw WiFiClient HTTP, WiFiUDP and configTime.
// Local stand-ins: fake Blynk server (Blynk binary protocol), fake https://api.telegram.org, amqtt broker, UDP echo.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import dgram from 'node:dgram';
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = () => {};
globalThis.window = { AudioContext: undefined };
const { Simulator } = await import('../src/sim/sim.js');
const root = new URL('..', import.meta.url).pathname, T = root + 'scripts/gwtest/';
const GW_PORT = 7872;
// self-signed test certificate for the fake api.telegram.org (generated, never committed)
import { existsSync } from 'node:fs';
if (!existsSync(T + 'key.pem')) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', T + 'key.pem', '-out', T + 'cert.pem', '-days', '30', '-subj', '/CN=api.telegram.org'], { stdio: 'ignore' }); // ensureCert
const ENV = { ...process.env, PORT: String(GW_PORT), GATEWAY_ALLOW_PRIVATE: '1', GATEWAY_INSECURE_TLS: '1', GATEWAY_HOSTMAP: 'blynk.test=127.0.0.1,api.telegram.org=127.0.0.1,mqtt.test=127.0.0.1,web.test=127.0.0.1,udp.test=127.0.0.1', ARDUINO_LIB_INDEX: 'file://' + T + 'index.json' };
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function compile(src) {
  writeFileSync('/tmp/_g.ino', src);
  const out = execFileSync('python3', ['-c', `import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm
print(json.dumps(compile_sketch_wasm(open('/tmp/_g.ino').read(), 'esp32')))`], { cwd: root, maxBuffer: 1e8, env: ENV });
  const r = JSON.parse(out); if (!r.wasm) throw new Error('compile failed: ' + r.stderr); if (r.stdout) console.log('   ' + r.stdout.split('\n').join('\n   '));
  return Buffer.from(r.wasm, 'base64');
}
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
class Stub { constructor(t, p) { this.tagName = t.toUpperCase(); this.pinInfo = p.map((name) => ({ name })); } addEventListener() {} removeEventListener() {} }
async function make(sketch) {
  const sim = new Simulator(); sim.gatewayUrl = process.env.GW_URL || `ws://127.0.0.1:${GW_PORT}/net`;
  sim.logs = []; sim.on('log', (l) => sim.logs.push(l.level + ': ' + l.text)); sim.serial = ''; sim.on('serial', (b) => (sim.serial += String.fromCharCode(b)));
  sim.build({ parts: [{ id: 'esp', type: 'wokwi-esp32-devkit-v1', attrs: {} }], connections: [] }, new Map([['esp', new Stub('wokwi-esp32-devkit-v1', ESP)]]));
  await sim.loadWasm(compile(sketch)); return sim;
}
// real-time run: 10 ms simulated per 10 ms of wall time, so network replies arrive like in the browser
async function runReal(sim, ms, until) { const t0 = Date.now(); while (Date.now() - t0 < ms) { sim.advance(10); await sleep(10); if (until && until()) return true; } return false; }

// ---------------------------------------------------------------- local services
const gw = spawn('python3', ['server.py'], { cwd: root + 'server', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
gw.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${GW_PORT}/health`); if (r.ok) break; } catch { /* starting */ } await sleep(500); }

// fake Blynk server: Blynk protocol header = [type u8][msg id u16 BE][length u16 BE]
const blynk = { login: null, vw: [], sock: null };
const blynkSrv = net.createServer((s) => {
  blynk.sock = s; let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const type = buf[0], id = buf.readUInt16BE(1), len = buf.readUInt16BE(3);
      if (type === 0) { buf = buf.subarray(5); continue; }                 // response from device
      if (buf.length < 5 + len) break;
      const body = buf.subarray(5, 5 + len).toString('latin1'); buf = buf.subarray(5 + len);
      const ack = () => { const h = Buffer.alloc(5); h[0] = 0; h.writeUInt16BE(id, 1); h.writeUInt16BE(200, 3); s.write(h); };
      if (type === 29 || type === 2) { blynk.login = body; ack(); }      // HW_LOGIN
      else if (type === 20) { const p = body.split('\0'); if (p[0] === 'vw') blynk.vw.push(p.slice(1)); }
      else ack();                                                        // ping, internal, …
    }
  });
}).listen(8080, '127.0.0.1');
const blynkWrite = (pin, val) => { const b = Buffer.from(`vw\0${pin}\0${val}`, 'latin1'); const h = Buffer.alloc(5); h[0] = 20; h.writeUInt16BE(7, 1); h.writeUInt16BE(b.length, 3); blynk.sock.write(Buffer.concat([h, b])); };

// fake Telegram Bot API over HTTPS on 443
const tg = { sent: [], gave: false };
const tgSrv = https.createServer({ key: readFileSync(T + 'key.pem'), cert: readFileSync(T + 'cert.pem') }, (req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const u = new URL(req.url, 'https://api.telegram.org');
    if (u.pathname.endsWith('/sendMessage')) { let j = {}; try { j = JSON.parse(body); } catch { j = Object.fromEntries(u.searchParams); } tg.sent.push(j.text); res.end(JSON.stringify({ ok: true, result: { message_id: tg.sent.length } })); }
    else if (u.pathname.endsWith('/getUpdates')) {
      const result = tg.gave ? [] : [{ update_id: 5001, message: { message_id: 9, from: { id: 999, first_name: 'Afta' }, chat: { id: 999, type: 'private' }, date: 1761200000, text: '/led_on' } }];
      tg.gave = true; res.end(JSON.stringify({ ok: true, result }));
    } else if (u.pathname.endsWith('/getMe')) res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'KelasBot', username: 'kelas_bot' } }));
    else { res.statusCode = 404; res.end('{"ok":false}'); }
  });
}).listen(443, '127.0.0.1');
// plain web server + UDP echo
const webSrv = http.createServer((req, res) => res.end('halo dari server: ' + req.url)).listen(8000, '127.0.0.1');
const udp = dgram.createSocket('udp4'); udp.on('message', (m, r) => udp.send(Buffer.from('ECHO:' + m), r.port, r.address)); udp.bind(5683, '127.0.0.1');
// MQTT broker
const broker = spawn('amqtt', [], { stdio: 'ignore' }); await sleep(2500);

try {
  // 1. raw WiFiClient HTTP + WiFiUDP + DNS + configTime
  {
    const sim = await make(`#include <WiFi.h>
#include <WiFiUdp.h>
#include <time.h>
WiFiClient c; WiFiUDP u;
void setup(){ Serial.begin(115200); WiFi.begin("Wokwi-GUEST", ""); while (WiFi.status() != WL_CONNECTED) delay(100);
  IPAddress ip; Serial.printf("dns=%d %s\\n", WiFi.hostByName("web.test", ip), ip.toString().c_str());
  if (c.connect("web.test", 8000)) { c.print("GET /tes HTTP/1.0\\r\\nHost: web.test\\r\\n\\r\\n"); unsigned long t = millis();
    while (c.connected() && millis() - t < 5000) { while (c.available()) Serial.write(c.read()); } c.stop(); Serial.println(); }
  u.begin(4000); u.beginPacket("udp.test", 5683); u.print("ping"); u.endPacket(); unsigned long t = millis();
  while (millis() - t < 3000) { int n = u.parsePacket(); if (n) { char b[32] = {0}; u.read(b, 31); Serial.printf("udp=%s\\n", b); break; } delay(10); }
  configTime(7 * 3600, 0, "pool.ntp.org"); struct tm ti; getLocalTime(&ti); Serial.printf("year=%d\\n", ti.tm_year + 1900); }
void loop(){ delay(100); }`);
    await runReal(sim, 8000, () => /year=/.test(sim.serial));
    ok(/dns=1 127\.0\.0\.1/.test(sim.serial) && /halo dari server: \/tes/.test(sim.serial), 'WiFiClient raw HTTP over the gateway + hostByName');
    ok(/udp=ECHO:ping/.test(sim.serial), 'WiFiUDP send/receive over the gateway');
    ok(+(/year=(\d+)/.exec(sim.serial)?.[1]) === new Date().getFullYear(), 'configTime/getLocalTime use the real clock: ' + /year=\d+/.exec(sim.serial)?.[0]);
    sim.dispose();
  }
  // 2. Blynk (original library) -> login, virtualWrite, BLYNK_WRITE from the "app"
  {
    const sim = await make(`#define BLYNK_TEMPLATE_ID "TMPL6abc"
#define BLYNK_TEMPLATE_NAME "Kelas"
#define BLYNK_AUTH_TOKEN "tok123"
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
BlynkTimer timer;
BLYNK_WRITE(V1) { int v = param.asInt(); digitalWrite(2, v); Serial.printf("V1=%d\\n", v); }
BLYNK_CONNECTED() { Serial.println("Blynk connected"); }
void kirim() { Blynk.virtualWrite(V0, 31.5); }
void setup() { Serial.begin(115200); pinMode(2, OUTPUT); Blynk.begin(BLYNK_AUTH_TOKEN, "Wokwi-GUEST", "", "blynk.test", 8080); timer.setInterval(1000L, kirim); }
void loop() { Blynk.run(); timer.run(); }`);
    await runReal(sim, 12000, () => blynk.vw.length >= 1);
    ok(blynk.login === 'tok123' && /Blynk connected/.test(sim.serial), `Blynk library logs in with the auth token (server saw ${JSON.stringify(blynk.login)})`);
    ok(blynk.vw.some((v) => v[0] === '0' && parseFloat(v[1]) === 31.5), 'Blynk.virtualWrite(V0, 31.5) reaches the server (double -> 7 decimals, same as a real ESP32): ' + JSON.stringify(blynk.vw.slice(0, 2)));
    blynkWrite(1, 1); await runReal(sim, 2000, () => /V1=1/.test(sim.serial));
    ok(/V1=1/.test(sim.serial) && sim.board.out.D2 === true, 'button in the Blynk app -> BLYNK_WRITE(V1) -> GPIO2 HIGH');
    if (fails) console.log(sim.logs.slice(-8).join('\n'), sim.serial);
    sim.dispose();
  }
  // 3. Telegram bot (UniversalTelegramBot over TLS)
  {
    const sim = await make(`#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <UniversalTelegramBot.h>
#include <ArduinoJson.h>
WiFiClientSecure client; UniversalTelegramBot bot("123:ABC", client);
void setup(){ Serial.begin(115200); pinMode(2, OUTPUT); WiFi.begin("Wokwi-GUEST", ""); while (WiFi.status() != WL_CONNECTED) delay(100);
  client.setCACert(TELEGRAM_CERTIFICATE_ROOT); Serial.println(bot.sendMessage("999", "ESP32 online", "") ? "sent" : "send failed"); }
void loop(){ int n = bot.getUpdates(bot.last_message_received + 1);
  for (int i = 0; i < n; i++) { String t = bot.messages[i].text; Serial.println("cmd " + t);
    if (t == "/led_on") { digitalWrite(2, HIGH); bot.sendMessage(bot.messages[i].chat_id, "LED menyala", ""); } }
  delay(1000); }`);
    await runReal(sim, 15000, () => tg.sent.length >= 2);
    ok(tg.sent[0] === 'ESP32 online' && /sent/.test(sim.serial), 'UniversalTelegramBot.sendMessage over TLS: ' + JSON.stringify(tg.sent));
    ok(/cmd \/led_on/.test(sim.serial) && tg.sent.includes('LED menyala') && sim.board.out.D2 === true, 'Telegram /led_on command -> LED on + reply');
    if (fails) console.log(sim.logs.slice(-8).join('\n'), sim.serial);
    sim.dispose();
  }
  // 4. MQTT (PubSubClient)
  {
    const sim = await make(`#include <WiFi.h>
#include <PubSubClient.h>
WiFiClient wc; PubSubClient mq(wc);
void cb(char *topic, byte *p, unsigned int n) { Serial.printf("msg %s=%.*s\\n", topic, n, (char *)p); }
void setup(){ Serial.begin(115200); WiFi.begin("Wokwi-GUEST", ""); while (WiFi.status() != WL_CONNECTED) delay(100);
  mq.setServer("mqtt.test", 1883); mq.setCallback(cb);
  if (mq.connect("esp32-kelas")) { Serial.println("mqtt ok"); mq.subscribe("kelas/led"); } else Serial.printf("mqtt fail %d\\n", mq.state()); }
void loop(){ mq.loop(); static unsigned long t = 0; if (millis() - t > 1000) { t = millis(); mq.publish("kelas/suhu", "30.5"); } }`);
    await runReal(sim, 6000, () => /mqtt ok/.test(sim.serial));
    const sub = spawn('amqtt_sub', ['--url', 'mqtt://127.0.0.1:1883', '-t', 'kelas/suhu', '-n', '1'], { stdio: ['ignore', 'pipe', 'ignore'] }); let got = '';
    sub.stdout.on('data', (d) => (got += d));
    await runReal(sim, 4000, () => got.includes('30.5'));
    execFileSync('amqtt_pub', ['--url', 'mqtt://127.0.0.1:1883', '-t', 'kelas/led', '-m', 'ON']);
    await runReal(sim, 3000, () => /msg kelas\/led=ON/.test(sim.serial)); sub.kill();
    ok(/mqtt ok/.test(sim.serial) && got.includes('30.5') && /msg kelas\/led=ON/.test(sim.serial), `PubSubClient MQTT publish/subscribe (broker got "${got.trim()}")`);
    if (fails) console.log(sim.logs.slice(-8).join('\n'), sim.serial);
    sim.dispose();
  }
  // 5. gateway policy: private addresses and odd ports are refused
  {
    const sim = await make(`#include <WiFi.h>
WiFiClient c; void setup(){ Serial.begin(115200); WiFi.begin("x"); while (WiFi.status() != WL_CONNECTED) delay(100); Serial.printf("smtp=%d\\n", c.connect("web.test", 25)); }
void loop(){ delay(100); }`);
    await runReal(sim, 4000, () => /smtp=/.test(sim.serial));
    ok(/smtp=0/.test(sim.serial) && sim.logs.some((l) => /port 25 tidak diizinkan/.test(l)), 'gateway refuses port 25 with a clear message');
    sim.dispose();
  }
} finally {
  gw.kill(); broker.kill(); blynkSrv.close(); tgSrv.close(); webSrv.close(); udp.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
