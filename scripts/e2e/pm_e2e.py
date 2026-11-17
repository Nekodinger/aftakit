# UI end-to-end test (Playwright, Python) of the pin table. Run against `npx vite preview --port 4181` (BASE=...), CHROME=/path/chrome optional
import os
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
W = "() => window.__sim.canvas.getModel().connections.filter(c=>c[2]!=='plug').map(c=>c[0]+' '+c[1]).sort()"
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox"])
    pg = b.new_page(viewport={"width":1180,"height":820}, has_touch=True); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1800)
    pg.evaluate("""async () => { const c = window.__sim.canvas; c.clear(true);
      await c.addPart('wokwi-esp32-devkit-v1', 0, 0);
      const t = ['wokwi-dht22','wokwi-ssd1306','wokwi-hc-sr04','mod-mq135','wokwi-led','wokwi-potentiometer','wokwi-servo'];
      let x = 200; for (const k of t) { await c.addPart(k, x, 0); x += 160; } }""")
    pg.wait_for_timeout(400)
    ids = pg.evaluate("() => [...window.__sim.canvas.parts.keys()]"); print(ids)
    pg.click('#tbWireText'); pg.wait_for_timeout(300)
    cols = pg.evaluate("() => document.querySelectorAll('.pm-table thead th').length - 1")
    ok(cols == 7, f"one column per component ({cols})")
    rows = pg.evaluate("() => document.querySelectorAll('.pm-table tbody tr:not(.pm-sec)').length")
    ok(rows == 30, f"one row per ESP32 pin ({rows})")
    ok('I2C SDA' in pg.inner_text('.pm-table') and 'hanya input' in pg.inner_text('.pm-table'), "pin function badges shown")
    pg.click('#pmAutoAll'); pg.wait_for_timeout(300)
    w = pg.evaluate(W); print("\n".join(w))
    def has(a,b2): return any(x == f"{a} {b2}" or x == f"{b2} {a}" for x in w)
    ok(has('esp32:D21','ssd1:DATA') and has('esp32:D22','ssd1:CLK'), "OLED on I2C D21/D22")
    ok(has('esp32:3V3','ssd1:3V3') and not any('ssd1:VIN' in x or 'ssd1:DC' in x for x in w), "OLED one supply pin, no SPI pins")
    ok(has('esp32:VIN','mq1:VCC') and any('mq1:AO' in x and ('D32' in x or 'D33' in x or 'D34' in x or 'D35' in x or 'VP' in x or 'VN' in x) for x in w), "MQ-135 5 V on VIN, AO on an ADC1 pin")
    ok(any('pot1:SIG' in x for x in w) and any('servo1:PWM' in x for x in w) and any('ultrasonic1:TRIG' in x or 'TRIG' in x for x in w), "pot / servo / HC-SR04 mapped")
    ok(any('led1:A' in x for x in w) and any(x.startswith('esp32:GND') and 'led1:C' in x for x in w), "LED anode to GPIO, cathode to GND")
    gp = [x.split()[0] for x in w if not any(k in x for k in ['GND','3V3','VIN','D21','D22'])]
    ok(len(gp) == len(set(gp)), f"signal pins do not share a GPIO: {gp}")
    n = len(w)
    # manual: move DHT data pin to D27 via the cell select
    dht = [i for i in ids if 'dht' in i][0]
    old = [x for x in w if f'{dht}:SDA' in x][0]
    pg.select_option(f'select.pm-sel[data-m="D27"][data-c="{dht}"]', 'SDA'); pg.wait_for_timeout(300)
    w2 = pg.evaluate(W)
    ok(any(x in (f'esp32:D27 {dht}:SDA', f'{dht}:SDA esp32:D27') for x in w2) and old not in w2 and len(w2)==n, f"cell change moves the wire ({old} -> D27)")
    pg.select_option(f'select.pm-sel[data-m="D27"][data-c="{dht}"]', ''); pg.wait_for_timeout(300)
    ok(len(pg.evaluate(W)) == n-1, "choosing — removes the wire")
    pg.evaluate("() => window.__sim.canvas.undo()"); pg.wait_for_timeout(300)
    ok(len(pg.evaluate(W)) == n, "undo restores it")
    pg.screenshot(path="/tmp/pm_table.png")
    # breadboard path is recognised
    pg.evaluate("""async () => { const c = window.__sim.canvas; const bb = await c.addPart('x-breadboard-half', 200, 400); }""")
    pg.wait_for_timeout(300)
    pg.evaluate("""() => { const c = window.__sim.canvas; const bb=[...c.parts.values()].find(p=>/breadboard/.test(p.type)).id;
       for (const w of [...c.wires]) if (!w.plug && (w.a==='dht1:SDA'||w.b==='dht1:SDA')) c._removeWire(w, true);
       c._addWire('esp32:D15', bb+':T5.a', null, true); c._addWire(bb+':T5.e', 'dht1:SDA', null, true); c.emit('change',{structural:true}); }""")
    pg.wait_for_timeout(300)
    via = pg.evaluate("() => [...document.querySelectorAll('.pm-via')].map(e=>e.innerText)")
    ok(any('SDA' in v for v in via), f"connection through breadboard shown: {via}")
    pg.click('[data-pmt=text]'); pg.wait_for_timeout(200)
    ok(pg.is_visible('#wtText') and not pg.is_visible('#pmHost'), "text tab still available")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
