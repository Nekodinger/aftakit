# Browser end-to-end: Blynk through the IoT gateway, Telegram bot, Library panel with an Edge Impulse zip,
# ESP32-CAM + Edge Impulse classification. Needs: server.py (test env) on SERVER, scripts/gwtest/fake_services.mjs.
import sys, json, time, urllib.request
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4175/"
SERVER = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:7871"
EIZIP = sys.argv[3]
SHOT = "/tmp/shots"
CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
fails = 0
def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m, flush=True)
    if not c: fails += 1
stats = lambda path="": json.loads(urllib.request.urlopen("http://127.0.0.1:7999/" + path).read())
LOGS = "[...document.querySelectorAll('#logList .log')].map(l => l.className.split(' ')[1] + ': ' + l.querySelector('.msg').textContent)"
def code(pg, src):
    pg.evaluate("s => { window.__sim.editor.value = s; }", src)
def run(pg, wait_ms, cond=None):
    pg.evaluate("document.querySelector('#serialOut').textContent=''; document.querySelector('#logList').textContent=''")
    pg.evaluate("window.__sim.run()")
    t0 = time.time()
    while time.time() - t0 < wait_ms / 1000:
        pg.wait_for_timeout(500)
        if cond and cond(): return True
    return False
serial = lambda pg: pg.evaluate("document.querySelector('#serialOut').textContent")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1366, "height": 1024}, has_touch=True)
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + "#ex=esp32-blink"); pg.wait_for_function("window.__sim && window.__sim.state.exampleId === 'esp32-blink'", timeout=20000)
    pg.evaluate(f"localStorage.setItem('sim.settings.v1', JSON.stringify({{url: '{SERVER}'}}))")
    pg.reload(); pg.wait_for_function("window.__sim && window.__sim.state.exampleId === 'esp32-blink'", timeout=20000)

    # 1. Blynk (original library from the Library Manager) through the gateway
    stats("reset")
    code(pg, """#define BLYNK_TEMPLATE_ID "TMPL6abc"
#define BLYNK_TEMPLATE_NAME "Kelas"
#define BLYNK_AUTH_TOKEN "tokenKelas"
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
BlynkTimer timer;
BLYNK_WRITE(V1) { digitalWrite(23, param.asInt()); Serial.printf("V1=%d\\n", param.asInt()); }
void kirim() { Blynk.virtualWrite(V0, millis() / 1000); }
void setup() { Serial.begin(115200); pinMode(23, OUTPUT); Blynk.begin(BLYNK_AUTH_TOKEN, "Wokwi-GUEST", "", "blynk.test", 8080); timer.setInterval(1000L, kirim); }
void loop() { Blynk.run(); timer.run(); }
""")
    run(pg, 40000, lambda: len(stats()["vw"]) >= 2)
    s = stats(); logs = pg.evaluate(LOGS)
    ok(s["blynkLogin"] == "tokenKelas" and len(s["vw"]) >= 2, f"browser: Blynk logs in through the gateway and sends V0 {s['vw'][:3]}")
    ok(any("Library Manager: Blynk" in l for l in logs) and any("TCP tersambung ke blynk.test:8080" in l for l in logs), "log shows Library Manager + gateway connection")
    stats("blynk/1/1"); pg.wait_for_timeout(1500)
    ok("V1=1" in serial(pg) and pg.evaluate("document.querySelector('wokwi-led').value") is True, "Blynk app button (V1) turns the LED on in the browser")
    pg.screenshot(path=f"{SHOT}/blynk.png")
    pg.evaluate("window.__sim.sim.stop()")

    # 2. Telegram bot
    code(pg, """#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <UniversalTelegramBot.h>
WiFiClientSecure client; UniversalTelegramBot bot("123:ABC", client);
void setup(){ Serial.begin(115200); pinMode(23, OUTPUT); WiFi.begin("Wokwi-GUEST", ""); while (WiFi.status() != WL_CONNECTED) delay(100);
  client.setCACert(TELEGRAM_CERTIFICATE_ROOT); bot.sendMessage("999", "ESP32 kelas online", ""); }
void loop(){ int n = bot.getUpdates(bot.last_message_received + 1);
  for (int i = 0; i < n; i++) if (bot.messages[i].text == "/led_on") { digitalWrite(23, HIGH); bot.sendMessage(bot.messages[i].chat_id, "LED menyala", ""); }
  delay(1000); }
""")
    run(pg, 40000, lambda: "LED menyala" in stats()["tg"])
    s = stats()
    ok(s["tg"][:2] == ["ESP32 kelas online", "LED menyala"], f"browser: Telegram bot sends + receives /led_on: {s['tg']}")
    pg.evaluate("window.__sim.sim.stop()")

    # 3. Library panel: upload an Edge Impulse export, ESP32-CAM classifies the camera image
    pg.evaluate("document.querySelector('[data-ex=\"esp32cam-pir\"]').click()")
    pg.wait_for_function("window.__sim.state.exampleId === 'esp32cam-pir'")
    pg.evaluate("window.__sim.showPanel('libs', true)")
    pg.set_input_files("#libFile", EIZIP); pg.wait_for_timeout(1500)
    item = pg.evaluate("document.querySelector('#libList').textContent")
    ok("Car_Detection_inferencing" in item and "Edge Impulse" in item and "#include <Car_Detection_inferencing.h>" in item, f"Library panel lists the zip: {item.strip()[:90]!r}")
    pg.screenshot(path=f"{SHOT}/libpanel.png")
    code(pg, open("/tmp/claude-0/-home-claude/f9ea25dd-293d-5677-8a16-f4a54a6d1d16/scratchpad/ei2.ino").read())
    run(pg, 240000, lambda: "cars:" in serial(pg))
    out = serial(pg); logs = pg.evaluate(LOGS)
    ok("hasil=0" in out and "cars:" in out and "unknown:" in out, f"ESP32-CAM + Edge Impulse classifies the camera image: {out.strip().splitlines()[-3:]}")
    pg.click("#tabCam"); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{SHOT}/ei_cam.png")
    pg.evaluate("window.__sim.sim.stop()")

    # 4. bundled MQTT example (precompiled) against a broker (broker.hivemq.com mapped to a local broker in tests)
    import subprocess
    sub = subprocess.Popen(["amqtt_sub", "--url", "mqtt://127.0.0.1:1883", "-t", "kelasku/esp32/suhu", "-n", "1"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    pg.evaluate("document.querySelector('[data-ex=\"esp32-mqtt\"]').click()"); pg.wait_for_function("window.__sim.state.exampleId === 'esp32-mqtt'")
    run(pg, 20000, lambda: "Kirim suhu" in serial(pg))
    subprocess.run(["amqtt_pub", "--url", "mqtt://127.0.0.1:1883", "-t", "kelasku/esp32/led", "-m", "ON"], capture_output=True)
    pg.wait_for_timeout(2500)
    try: got = sub.communicate(timeout=10)[0]
    except Exception: sub.kill(); got = ""
    ok("berhasil" in serial(pg) and "29.0" in got and "Pesan [kelasku/esp32/led] ON" in serial(pg) and pg.evaluate("document.querySelector('wokwi-led').value") is True,
       f"MQTT example: broker got {got.strip()!r}, LED command received")
    ok(not errs, f"no console/page errors: {errs[:3]}")
    b.close()
print("\nALL PASS" if not fails else f"\n{fails} FAILED"); sys.exit(1 if fails else 0)
