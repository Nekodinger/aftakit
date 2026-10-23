# Browser end-to-end for the ESP32 / ESP8266 runtime (WebAssembly): examples, internet (mocked), Bluetooth,
# ESP32-CAM with a (fake) device camera, and compiling the student's own code through the compile server.
import sys, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4175/"
SHOT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots"
SERVER = sys.argv[3] if len(sys.argv) > 3 else "http://localhost:7871"
CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
fails = 0
def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m, flush=True)
    if not c: fails += 1
LOGS = "[...document.querySelectorAll('#logList .log')].map(l => l.className.split(' ')[1] + ': ' + l.querySelector('.msg').textContent)"
def load(pg, ex):
    pg.evaluate(f"document.querySelector('[data-ex=\"{ex}\"]').click()")
    pg.wait_for_function(f"window.__sim.state.exampleId === '{ex}'", timeout=10000)
    pg.evaluate("document.querySelector('#logList').textContent=''")
def lcd(pg, id, cols=16):
    return pg.evaluate(f"(() => {{ const d = window.__sim.sim.behaviors.find(b => b._part.id === '{id}').dev(); const c = d.hd.snapshot().chars; return [0,1].map(r => String.fromCharCode(...c.slice(r*{cols}, r*{cols}+{cols})).trim()); }})()")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
    ctx = b.new_context(viewport={"width": 1366, "height": 1024}, has_touch=True, is_mobile=False, permissions=["camera"])
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    # internet: answer Open-Meteo like the real API does (CORS header included)
    pg.route("https://api.open-meteo.com/**", lambda r: r.fulfill(status=200, headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"},
             body=json.dumps({"current": {"time": "2026-10-23T12:00", "temperature_2m": 31.4, "relative_humidity_2m": 66, "wind_speed_10m": 9.7}})))
    pg.goto(BASE + "#ex=esp32-blink"); pg.wait_for_function("window.__sim && window.__sim.state.exampleId === 'esp32-blink'", timeout=20000)
    pg.wait_for_timeout(500)

    # 1. blink
    load(pg, "esp32-blink"); pg.evaluate("window.__sim.run()"); pg.wait_for_function("window.__sim.sim.running", timeout=15000)
    seen = set()
    for _ in range(14):
        pg.wait_for_timeout(100); seen.add(pg.evaluate("[document.querySelector('#parts [data-id=led1] wokwi-led, wokwi-led')?.value, window.__sim.state.boardEl?.led1].join()"))
    serial = pg.evaluate("document.querySelector('#serialOut').textContent")
    ok(len(seen) >= 2 and "ESP32 siap" in serial, f"ESP32 blink runs in the browser: states {sorted(seen)}, serial {serial[:40]!r}")
    pg.screenshot(path=f"{SHOT}/esp32_blink.png")

    # 2. weather over the (mocked) internet -> LCD
    load(pg, "esp32-weather"); pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(3500)
    rows = lcd(pg, "lcd1"); logs = pg.evaluate(LOGS)
    ok(rows[0].startswith("Jakarta 31.4") and any("api.open-meteo.com" in l for l in logs), f"ESP32 weather: LCD {rows}, net log {[l for l in logs if 'GET' in l][:1]}")
    pg.screenshot(path=f"{SHOT}/esp32_weather.png")

    # 3. Bluetooth terminal
    load(pg, "esp32-bluetooth"); pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(600)
    vis = pg.evaluate("!document.querySelector('#tabBt').hidden")
    pg.click("#tabBt"); pg.fill("#btIn", "on"); pg.press("#btIn", "Enter"); pg.wait_for_timeout(500)
    out = pg.evaluate("document.querySelector('#btOut').textContent"); led = pg.evaluate("document.querySelector('wokwi-led').value")
    ok(vis and "LED menyala" in out and led is True, f"Bluetooth tab: visible={vis}, LED={led}, terminal={out!r}")
    pg.screenshot(path=f"{SHOT}/esp32_bluetooth.png")

    # 4. ESP32-CAM: PIR motion -> photo from the device camera (Chromium fake camera)
    load(pg, "esp32cam-pir"); pg.click("[data-tab=log]")
    pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(500)
    pg.evaluate("document.querySelector('#tabCam').click()")
    pg.check("input[name=camSrc][value=device]"); pg.wait_for_timeout(1500)
    st = pg.evaluate("document.querySelector('#camStatus').textContent")
    pg.evaluate("window.__sim.sim.model.parts.find(p => p.id === 'pir1').attrs.motion = true"); pg.wait_for_timeout(800)
    serial = pg.evaluate("document.querySelector('#serialOut').textContent"); shot = pg.evaluate("document.querySelector('#camShot').src")
    ok("Gerakan! Foto 320x240" in serial and "3808 byte" not in serial and shot.startswith("blob:"), f"ESP32-CAM uses the device camera: {st!r} / {serial.strip().splitlines()[-1]!r}")
    pg.screenshot(path=f"{SHOT}/esp32_cam.png")

    # 5. student's own code: compile error with line number, then fixed code runs (compile server)
    pg.evaluate(f"localStorage.setItem('sim.settings.v1', JSON.stringify({{url: '{SERVER}'}}))")
    load(pg, "esp32-blink")
    pg.evaluate("window.__sim.editor.value = 'void setup(){\\n  pinMode(23, OUTPUT)\\n}\\nvoid loop(){ digitalWrit(23, HIGH); delay(100); }\\n'")
    pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(6000)
    logs = pg.evaluate(LOGS); errl = [l for l in logs if l.startswith("error")]
    ok(any("sketch.ino:2" in l for l in errl) and any("digitalWrite" in l for l in errl) and not pg.evaluate("window.__sim.sim.running"), f"compile errors shown with lines: {errl[:2]}")
    pg.evaluate("window.__sim.editor.value = 'void setup(){ Serial.begin(115200); pinMode(23, OUTPUT); }\\nvoid loop(){ digitalWrite(23, !digitalRead(23)); Serial.println(millis()); delay(200); }\\n'")
    pg.evaluate("document.querySelector('#serialOut').textContent=''"); pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(5000)
    serial = pg.evaluate("document.querySelector('#serialOut').textContent")
    ok(pg.evaluate("window.__sim.sim.running") and len(serial.split()) >= 3, f"own ESP32 code compiled by server and runs: {serial.split()[:4]}")
    # 6. NodeMCU (ESP8266) own code runs too
    load(pg, "nodemcu-button")
    pg.evaluate("window.__sim.editor.value = 'void setup(){ Serial.begin(115200); Serial.println(\"halo 8266\"); }\\nvoid loop(){ delay(1000); }\\n'")
    pg.evaluate("document.querySelector('#serialOut').textContent=''"); pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(5000)
    ok("halo 8266" in pg.evaluate("document.querySelector('#serialOut').textContent"), "own NodeMCU code compiled (esp8266) and runs")
    ok(not errs, f"no console/page errors: {errs[:3]}")
    b.close()
print("\nALL PASS" if not fails else f"\n{fails} FAILED"); sys.exit(1 if fails else 0)
