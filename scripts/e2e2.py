import sys, time
from playwright.sync_api import sync_playwright
BASE = "http://localhost:4174"; CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"; fails = []
def check(n, c, x=""):
    print(("PASS " if c else "FAIL ") + n + ("" if c else " :: " + str(x)));
    if not c: fails.append(n)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox"]); pg = b.new_page(viewport={"width": 1500, "height": 900}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    def load(id):
        pg.goto(BASE + "/#ex=" + id); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0"); time.sleep(.6)
    ev = lambda js: pg.evaluate(js)
    load("blink"); check("empty hint hidden", ev("document.getElementById('emptyHint').offsetParent===null"))
    pg.click("#btnRun"); seen = set()
    for _ in range(24): seen.add(ev("window.__sim.canvas.parts.get('led1').el.value")); time.sleep(.1)
    check("blink: LED toggles on and off", seen == {True, False}, seen)
    check("blink: board LED13 follows", ev("typeof window.__sim.state.boardEl.led13") == "boolean")
    pg.click("#btnStop")
    load("neopixel"); ev("(()=>{const e=window.__sim.canvas.parts.get('ring1').el; window.__lit={}; const o=e.setPixel.bind(e); e.setPixel=(i,c)=>{window.__lit[i]=c; o(i,c)}})()"); pg.click("#btnRun"); time.sleep(1.5)
    lit = ev("(()=>{const o=window.__lit; return Object.keys(o).filter(k=>o[k].r||o[k].g||o[k].b).length})()"); tot = ev("Object.keys(window.__lit).length")
    check("neopixel: pixels written, some lit, some dark", tot == 16 and 3 <= lit <= 8, (tot, lit)); pg.click("#btnStop")
    load("7seg"); pg.click("#btnRun"); time.sleep(1.0); v1 = ev("window.__sim.canvas.parts.get('seg1').el.values.slice()"); time.sleep(1.0); v2 = ev("window.__sim.canvas.parts.get('seg1').el.values.slice()")
    check("7seg: pattern changes over time", v1 != v2 and any(v1), (v1, v2)); pg.click("#btnStop")
    load("pot-pwm"); pg.click("#btnRun"); time.sleep(1.2); b1 = ev("window.__sim.canvas.parts.get('led1').el.brightness"); 
    pg.click("#viewport"); pg.evaluate("window.__sim.canvas.select({kind:'part',id:'pot1'})"); pg.click("[data-side=props]")
    pg.evaluate("(()=>{const i=document.querySelector('#propsBody input[type=range]'); i.value=100; i.dispatchEvent(new Event('input'))})()"); time.sleep(1.0)
    b2 = ev("window.__sim.canvas.parts.get('led1').el.brightness"); ser = pg.inner_text("#serialOut")
    check("pot-pwm: brightness follows pot (50%->100%)", b2 is not None and b1 is not None and b2 > b1 + .2, (b1, b2)); check("pot-pwm: serial ADC=1023", "ADC=1023" in ser, ser[-80:]); pg.click("#btnStop")
    load("keypad"); pg.click("#btnRun"); time.sleep(1)
    ev("(()=>{const e=window.__sim.canvas.parts.get('kp1').el; e.dispatchEvent(new CustomEvent('button-press',{detail:{key:'5'}}));})()"); time.sleep(.5)
    ev("(()=>{const e=window.__sim.canvas.parts.get('kp1').el; e.dispatchEvent(new CustomEvent('button-release',{detail:{key:'5'}}));})()"); time.sleep(.3)
    s = pg.inner_text("#serialOut"); check("keypad: key 5 read", "Tombol: 5" in s, s[-100:]); pg.click("#btnStop")
    load("melody"); pg.click("#btnRun"); time.sleep(1.2); s = pg.inner_text("#serialOut"); check("melody serial Do/Re", "Do" in s and "Re" in s, s); pg.click("#btnStop")
    load("sonar"); pg.click("#btnRun"); time.sleep(1.5)
    pg.evaluate("window.__sim.canvas.select({kind:'part',id:'sonar1'})"); pg.click("[data-side=props]")
    pg.evaluate("(()=>{const i=document.querySelector('#propsBody input[type=range]'); i.value=25; i.dispatchEvent(new Event('input'))})()"); time.sleep(1.5)
    s = pg.inner_text("#serialOut"); check("sonar: live distance change to 25cm", "Jarak: 25" in s or "Jarak: 24" in s, s[-120:]); pg.click("#btnStop")
    # floating-part warning + short-circuit error display
    load("blink"); pg.evaluate("window.__sim.canvas.addPart('wokwi-led', 400, -100)"); time.sleep(.4); pg.click("#btnRun"); time.sleep(1)
    lg = pg.inner_text("#logList"); check("warns about unwired LED", "led2" in lg and "belum ada kabel" in lg, lg[:300]); pg.click("#btnStop")
    pg.evaluate("window.__sim.canvas._addWire('uno:5V','uno:GND.2')"); pg.click("#btnRun"); time.sleep(1)
    lg = pg.inner_text("#logList"); check("short circuit warned", "Korsleting" in lg, lg[-300:]); pg.click("#btnStop")
    # Uno-less circuit
    pg.goto(BASE + "/#ex=blink"); pg.reload(); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size>0"); time.sleep(.5)
    pg.evaluate("window.__sim.canvas.removePart('uno')"); pg.click("#btnRun"); time.sleep(.8); lg = pg.inner_text("#logList"); check("no-board error", "Belum ada board" in lg, lg[-200:])
    check("no page errors", not errs, errs[:3]); b.close()
print("FAILED:", fails or "none")
