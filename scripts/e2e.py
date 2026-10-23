import sys, json, time, subprocess, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173"
COMPILE = sys.argv[2] if len(sys.argv) > 2 else ""
CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra and not cond else ""))
    if not cond: fails.append(name)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1500, "height": 900}); pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    if COMPILE: pg.add_init_script(f"localStorage.setItem('sim.settings.v1', JSON.stringify({{url:'{COMPILE}'}}))")
    pg.goto(BASE + "/#ex=blink"); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0", timeout=20000)
    time.sleep(1)
    check("blink parts rendered", pg.evaluate("window.__sim.canvas.parts.size") == 3)
    check("blink wires", pg.evaluate("window.__sim.canvas.wires.length") == 3)
    check("pins hotspots exist", pg.evaluate("document.querySelectorAll('.pin').length") > 20)
    pg.screenshot(path="/tmp/e2e_blink_idle.png")
    pg.click("#btnRun"); time.sleep(2.5)
    ser = pg.inner_text("#serialOut")
    check("blink serial", "LED ON" in ser and "LED OFF" in ser, ser[:200])
    check("status running", "Berjalan" in pg.inner_text("#simText"))
    led = pg.evaluate("[...window.__sim.canvas.parts.values()].find(p=>p.id==='led1').el.value")
    check("led value is boolean", led in (True, False), led)
    pg.screenshot(path="/tmp/e2e_blink_run.png")
    pg.click("#btnStop"); time.sleep(.3)
    check("stopped", "Berhenti" in pg.inner_text("#simText"))
    def runex(id, secs, fn):
        pg.evaluate(f"location.hash='#ex={id}'"); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0", timeout=20000); time.sleep(.8)
        pg.click("#btnRun"); time.sleep(secs); r = fn(); pg.screenshot(path=f"/tmp/e2e_{id}.png"); pg.click("#btnStop"); return r
    part = lambda i, prop: pg.evaluate(f"window.__sim.canvas.parts.get('{i}').el.{prop}")
    r = runex("button", 1.5, lambda: part("led1", "value")); check("button: LED off at start", r is False, r)
    # press button
    pg.evaluate("location.hash='#ex=button'"); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0"); time.sleep(.8); pg.click("#btnRun"); time.sleep(1)
    pg.evaluate("window.__sim.canvas.parts.get('btn1').el.dispatchEvent(new CustomEvent('button-press'))"); time.sleep(.7)
    check("button: LED on when pressed", part("led1", "value") is True, part("led1", "value"))
    check("button: serial msg", "Tombol ditekan" in pg.inner_text("#serialOut"), pg.inner_text("#serialOut"))
    pg.evaluate("window.__sim.canvas.parts.get('btn1').el.dispatchEvent(new CustomEvent('button-release'))"); time.sleep(.7)
    check("button: LED off after release", part("led1", "value") is False)
    pg.click("#btnStop")
    r = runex("lcd", 2.5, lambda: part("lcd1", "characters") is not None); check("lcd renders", r)
    chars = pg.evaluate("Array.from(window.__sim.canvas.parts.get('lcd1').el.characters||[]).slice(0,12).map(c=>String.fromCharCode(c)).join('')")
    check("lcd text 'Halo, Dunia!'", "Halo, Dunia!" in chars, chars)
    r = runex("sonar", 3, lambda: pg.inner_text("#serialOut")); check("sonar distance ~80", "Jarak: 8" in r or "Jarak: 7" in r, r[:120])
    r = runex("ntc-lcd", 2.5, lambda: pg.inner_text("#serialOut")); check("ntc ~24C", "T=2" in r, r[:120])
    r = runex("servo", 2, lambda: part("servo1", "angle")); check("servo angle ~45 (pot 25%)", r is not None and 35 <= r <= 55, r)
    r = runex("neopixel", 2, lambda: pg.evaluate("window.__sim.sim.log.length")); check("neopixel no error logs", "✕" not in pg.inner_text("#logList"), pg.inner_text("#logList")[:200])
    r = runex("7seg", 2, lambda: part("seg1", "values")); check("7seg values set", r is not None, r)
    r = runex("rgb", 2, lambda: [part("rgb1", "ledRed"), part("rgb1", "ledGreen"), part("rgb1", "ledBlue")]); check("rgb driven", r is not None and any((x or 0) > 0 for x in r), r)
    for ex in ["pot-pwm", "traffic", "melody", "keypad"]:
        runex(ex, 1.5, lambda: None); lg = pg.inner_text("#logList"); check(f"{ex}: no error logs", "✕" not in lg, lg[:200])
    # error display via compile server
    if COMPILE:
        pg.evaluate("location.hash='#ex=blink'"); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0"); time.sleep(.5)
        pg.fill("#code", "void setup() {\n  pinMode(13, OUTPUT)\n  foo(1);\n}\nvoid loop() {}\n"); pg.dispatch_event("#code", "input")
        pg.click("#btnRun"); time.sleep(8)
        lg = pg.inner_text("#logList"); check("compile error shown in log", "sketch.ino:" in lg and "expected" in lg, lg[:300])
        check("error line marked in editor", pg.evaluate("document.querySelectorAll('#hl .ln.err').length") >= 1)
        check("not running after error", "Berhenti" in pg.inner_text("#simText") or "gagal" in pg.inner_text("#simText"))
        pg.screenshot(path="/tmp/e2e_error.png")
        pg.fill("#code", "void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(100); digitalWrite(13, LOW); delay(100); }\n"); pg.dispatch_event("#code", "input")
        pg.click("#btnRun"); time.sleep(6); check("custom code compiles + runs", "Berjalan" in pg.inner_text("#simText"), pg.inner_text("#simText")+pg.inner_text("#logList")[:200])
    else:
        pg.fill("#code", "void setup(){}\nvoid loop(){}\n"); pg.dispatch_event("#code", "input"); pg.click("#btnRun"); time.sleep(1.5)
        check("no-server message", "belum dikonfigurasi" in pg.inner_text("#logList"), pg.inner_text("#logList")[:200])
    # wiring interaction: add LED and connect by clicking pins
    pg.evaluate("location.hash='#ex=blink'"); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0"); time.sleep(.6)
    pg.evaluate("window.__sim.canvas.addPart('wokwi-led', 400, -100)"); time.sleep(.5)
    n0 = pg.evaluate("window.__sim.canvas.wires.length")
    pg.locator(".pin[data-pid='uno'][data-pin='12']").dispatch_event("pointerdown", {"button": 0, "bubbles": True})
    pg.locator(".pin[data-pid='led2'][data-pin='A']").dispatch_event("pointerdown", {"button": 0, "bubbles": True})
    check("wire created by 2 pin clicks", pg.evaluate("window.__sim.canvas.wires.length") == n0 + 1, pg.evaluate("window.__sim.canvas.wires.length"))
    # share fallback (no DB): URL hash
    pg.click("#btnShare"); time.sleep(.8); url = pg.input_value("#shareUrl"); check("share link generated", "#d=" in url or "?p=" in url, url[:80])
    pg2 = ctx.new_page(); pg2.goto(url); pg2.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0", timeout=15000); time.sleep(.5)
    check("share link reload restores parts", pg2.evaluate("window.__sim.canvas.parts.size") == 4, pg2.evaluate("window.__sim.canvas.parts.size"))
    check("no page errors", not [e for e in errs if "favicon" not in e], errs[:5])
    b.close()
print("\nFAILED:", fails if fails else "none"); sys.exit(1 if fails else 0)
