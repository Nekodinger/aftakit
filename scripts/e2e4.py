# Compile-server flow in the browser: custom sketch with an error -> clickable error; fixed sketch -> runs.
import sys, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1]; SRV = sys.argv[2]; SHOT = sys.argv[3]
CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
fails = 0
def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m, flush=True); fails += 0 if c else 1
BAD = """#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup() {
  lcd.init();
  lcd.backlight()
  lcd.print("Halo");
}
void loop() {
  suhu = 5;
}
"""
GOOD = """#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
DHT dht(2, DHT22);
void setup() { lcd.init(); lcd.backlight(); dht.begin(); lcd.print("Kode sendiri"); }
void loop() { delay(2000); lcd.setCursor(0, 1); lcd.print(dht.readTemperature(), 1); lcd.print(" C"); }
"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1366, "height": 900})
    pg.goto(BASE + "#ex=dht-lcd-i2c"); pg.wait_for_function("window.__sim && window.__sim.state.exampleId === 'dht-lcd-i2c'", timeout=20000)
    pg.evaluate(f"localStorage.setItem('sim.settings.v1', JSON.stringify({{url: '{SRV}'}}))")
    pg.evaluate(f"window.__sim.editor.value = {json.dumps(BAD)}; window.__sim.state.exampleId = null")
    pg.evaluate("window.__sim.run()"); pg.wait_for_function("!window.__sim.state.busy", timeout=90000); pg.wait_for_timeout(300)
    logs = pg.evaluate("[...document.querySelectorAll('#logList .log')].map(l => l.className.split(' ')[1] + ': ' + l.textContent)")
    errs = [l for l in logs if l.startswith('error')]
    ok(any('sketch.ino:6' in l and 'titik koma kurang' in l for l in errs), "missing ';' reported at line 6 (after lcd.backlight())")
    ok(any('sketch.ino:10' in l and 'suhu' in l and 'was not declared' in l for l in errs), "undeclared 'suhu' reported at line 10")
    ok(any('titik koma' in l for l in errs), "Indonesian fix hint shown")
    ok(not pg.evaluate("window.__sim.sim.running"), "simulation does not start when compile fails")
    marks = pg.evaluate("[...document.querySelectorAll('#gutter div.err')].map(d => d.textContent)")
    ok('6' in marks and '10' in marks, f"editor gutter marks error lines {marks}")
    pg.click("#logList a.jump >> nth=0"); pg.wait_for_timeout(300)
    ok(pg.evaluate("document.querySelector('#workspace').dataset.mode") == 'code', "clicking the error jumps to the code view")
    pg.screenshot(path=f"{SHOT}/compile_error.png")
    pg.evaluate(f"window.__sim.editor.value = {json.dumps(GOOD)}")
    pg.evaluate("window.__sim.run()"); pg.wait_for_function("!window.__sim.state.busy", timeout=90000); pg.wait_for_timeout(4500)
    txt = pg.evaluate("String.fromCharCode(...(window.__sim.canvas.parts.get('lcd1').el.characters||[]))")
    ok(pg.evaluate("window.__sim.sim.running") and txt.startswith("Kode sendiri") and "29.5 C" in txt, f"custom sketch compiled by server runs: {txt!r}")
    pg.screenshot(path=f"{SHOT}/compile_ok.png")
    b.close()
print("\n%d FAILED" % fails if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
