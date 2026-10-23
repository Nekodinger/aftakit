# Browser end-to-end: desktop + iPad (touch) emulation against the built app.
import sys, json, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4175/"
SHOT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots"
CH = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"
fails = 0
def ok(c, m):
    global fails
    print(("PASS " if c else "FAIL ") + m, flush=True)
    if not c: fails += 1

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CH, args=["--no-sandbox"])
    # ---------------------------------------------------------------- desktop
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(BASE); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size > 0", timeout=20000)
    pg.wait_for_timeout(800)
    ncards = pg.locator(".card").count()
    ok(ncards >= 100, f"palette shows {ncards} part cards")
    thumbs = pg.evaluate("[...document.querySelectorAll('.card .thumb')].filter(t => t.children.length).length")
    ok(thumbs >= 15, f"visible cards render live thumbnails ({thumbs})")
    pg.screenshot(path=f"{SHOT}/desktop_design.png")
    # every example: load + run, collect error logs
    exs = pg.evaluate("[...document.querySelectorAll('[data-ex]')].map(b => b.dataset.ex)")
    ok(len(exs) == 32, f"{len(exs)} examples listed")
    bad = []
    for ex in exs:
        pg.evaluate(f"location.hash = '#ex={ex}'")
        pg.evaluate(f"document.querySelector('[data-ex=\"{ex}\"]').click()")
        pg.wait_for_function(f"window.__sim.state.exampleId === '{ex}'", timeout=10000)
        pg.evaluate("document.querySelector('#logList').textContent=''")
        pg.evaluate("window.__sim.run()")
        pg.wait_for_timeout(1800)
        logs = pg.evaluate("[...document.querySelectorAll('#logList .log')].map(l => l.className.split(' ')[1] + ': ' + l.querySelector('.msg').textContent)")
        errors = [l for l in logs if l.startswith('error')]
        running = pg.evaluate("window.__sim.sim.running")
        if errors or not running: bad.append((ex, running, errors[:2], logs[:3]))
        if ex in ("dht-lcd-i2c", "oled", "irrigation", "esp32-iot", "breadboard-led", "motor-l298n", "relay-lamp"):
            pg.wait_for_timeout(1500 if ex in ("dht-lcd-i2c", "rtc-clock") else 200)
            pg.screenshot(path=f"{SHOT}/ex_{ex}.png")
        pg.evaluate("window.__sim.sim.stop()")
    ok(not bad, "all examples run without error logs" + ("" if not bad else ": " + json.dumps(bad)[:1500]))
    # DHT + LCD I2C really shows text
    pg.evaluate("document.querySelector('[data-ex=\"dht-lcd-i2c\"]').click()"); pg.wait_for_function("window.__sim.state.exampleId === 'dht-lcd-i2c'")
    pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(4500)
    txt = pg.evaluate("String.fromCharCode(...(window.__sim.canvas.parts.get('lcd1').el.characters||[]))")
    ok("Suhu: 29.5" in txt and "RH  : 70.0" in txt, f"DHT22 + LCD I2C live text: {txt!r}")
    ser = pg.evaluate("document.querySelector('#serialOut').textContent")
    ok("Suhu=29.50" in ser, f"serial monitor shows readings: {ser[:60]!r}")
    pg.evaluate("window.__sim.sim.stop()")
    # OLED pixels
    pg.evaluate("document.querySelector('[data-ex=\"oled\"]').click()"); pg.wait_for_function("window.__sim.state.exampleId === 'oled'")
    pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(2500)
    lit = pg.evaluate("""(() => { const c = window.__sim.canvas.parts.get('oled1').el.shadowRoot.querySelector('canvas'); const d = c.getContext('2d').getImageData(0,0,128,64).data; let n=0; for (let i=0;i<d.length;i+=4) if (d[i+2]>100) n++; return n; })()""")
    ok(lit > 300, f"OLED canvas has {lit} lit pixels")
    pg.screenshot(path=f"{SHOT}/desktop_oled_running.png")
    pg.evaluate("window.__sim.sim.stop()")
    # code mode + compile error display via fake server path is covered elsewhere; check code view renders
    pg.click(".mode[data-mode=code]"); pg.wait_for_timeout(300)
    ok(pg.locator("#codeView").is_visible() and not pg.locator("#stage").is_visible(), "Code mode shows editor full width")
    pg.screenshot(path=f"{SHOT}/desktop_code.png")
    pg.click(".mode[data-mode=build]"); pg.wait_for_timeout(200); pg.screenshot(path=f"{SHOT}/desktop_build.png")
    pg.click(".mode[data-mode=design]")
    # ESP32 example: design check
    pg.evaluate("document.querySelector('[data-ex=\"esp32-iot\"]').click()"); pg.wait_for_function("window.__sim.state.exampleId === 'esp32-iot'")
    pg.evaluate("window.__sim.showPanel('check', true)"); pg.wait_for_timeout(300)
    chk = pg.evaluate("[...document.querySelectorAll('#checkList .chk')].map(c => c.className.split(' ')[1] + ': ' + c.textContent)")
    ok(not any(c.startswith('error') for c in chk), "ESP32 IoT example has no wiring errors: " + json.dumps(chk)[:300])
    pg.screenshot(path=f"{SHOT}/desktop_esp32_check.png")
    ok(not errs, "no console/page errors on desktop" + ("" if not errs else ": " + " | ".join(errs[:5])))
    pg.close()

    # ---------------------------------------------------------------- iPad landscape (touch)
    ipad = p.devices["iPad Pro 11"]
    for orient, vp in (("landscape", {"width": 1194, "height": 834}), ("portrait", {"width": 834, "height": 1194})):
        ctx = b.new_context(viewport=vp, user_agent=ipad["user_agent"], device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = ctx.new_page(); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE + "#ex=blink"); pg.wait_for_function("window.__sim && window.__sim.canvas.parts.size > 0", timeout=20000); pg.wait_for_timeout(600)
        pg.screenshot(path=f"{SHOT}/ipad_{orient}_start.png")
        ok(pg.evaluate("matchMedia('(pointer: coarse)').matches"), f"[{orient}] touch device detected (coarse pointer)")
        cdp = ctx.new_cdp_session(pg)
        def touch(kind, pts):
            cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
        def tap(x, y):
            touch("touchStart", [(x, y)]); pg.wait_for_timeout(60); touch("touchEnd", []); pg.wait_for_timeout(350)
        # open parts panel (closed by default in portrait)
        if orient == "portrait":
            r = pg.locator(".rail-btn[data-panel=parts]").bounding_box(); tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); pg.wait_for_timeout(300)
        # tap a card: LED -> added
        before = pg.evaluate("window.__sim.canvas.parts.size")
        pg.fill("#partSearch", "relay 1"); pg.wait_for_timeout(300)
        card = pg.locator(".card[data-tag='mod-relay1']").bounding_box()
        tap(card["x"] + card["width"] / 2, card["y"] + card["height"] / 2); pg.wait_for_timeout(600)
        after = pg.evaluate("window.__sim.canvas.parts.size")
        ok(after == before + 1, f"[{orient}] tapping a part card adds it ({before} -> {after})")
        # long-press drag a card onto the canvas
        if orient == "portrait":
            r = pg.locator(".rail-btn[data-panel=parts]").bounding_box(); tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); pg.wait_for_timeout(300)
        pg.fill("#partSearch", "dht11"); pg.wait_for_timeout(300)
        card = pg.locator(".card[data-tag='mod-dht11']").bounding_box(); vpbox = pg.locator("#viewport").bounding_box()
        sx, sy = card["x"] + card["width"] / 2, card["y"] + card["height"] / 2
        tx, ty = vpbox["x"] + vpbox["width"] - 150, vpbox["y"] + vpbox["height"] - 200
        touch("touchStart", [(sx, sy)]); pg.wait_for_timeout(400)
        for k in range(1, 11): touch("touchMove", [(sx + (tx - sx) * k / 10, sy + (ty - sy) * k / 10)]); pg.wait_for_timeout(16)
        touch("touchEnd", []); pg.wait_for_timeout(500)
        has = pg.evaluate("[...window.__sim.canvas.parts.values()].some(p => p.type === 'mod-dht11')")
        ok(has, f"[{orient}] long-press + drag from palette drops DHT11 on the canvas")
        # tap pin -> tap pin creates a wire
        nw = pg.evaluate("window.__sim.canvas.wires.length")
        def pin_xy(ref):
            return pg.evaluate(f"""(() => {{ const [id, pin] = '{ref}'.split(':'); const d = [...document.querySelectorAll('.pin')].find(e => e.dataset.pid === id && e.dataset.pin === pin); const r = d.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }})()""")
        pg.evaluate("window.__sim.canvas.fit()"); pg.wait_for_timeout(200)
        rid = pg.evaluate("[...window.__sim.canvas.parts.values()].find(p => p.type === 'mod-relay1').id")
        a = pin_xy("uno:7"); bpt = pin_xy(rid + ":IN")
        tap(*a); pg.wait_for_timeout(150); tap(*bpt); pg.wait_for_timeout(300)
        nw2 = pg.evaluate("window.__sim.canvas.wires.length")
        ok(nw2 == nw + 1, f"[{orient}] tap pin, tap pin -> wire created ({nw} -> {nw2})" + ("" if nw2 == nw + 1 else " pts=%s %s pending=%s top=%s" % (a, bpt, pg.evaluate("JSON.stringify(window.__sim.canvas.pending)"), pg.evaluate(f"document.elementFromPoint({bpt[0]},{bpt[1]}).className"))))
        # pinch zoom
        z0 = pg.evaluate("window.__sim.canvas.zoom")
        cx, cy = vpbox["x"] + vpbox["width"] / 2, vpbox["y"] + vpbox["height"] / 2
        touch("touchStart", [(cx - 40, cy), (cx + 40, cy)])
        for k in range(1, 9): touch("touchMove", [(cx - 40 - k * 15, cy), (cx + 40 + k * 15, cy)]); pg.wait_for_timeout(16)
        touch("touchEnd", []); pg.wait_for_timeout(200)
        z1 = pg.evaluate("window.__sim.canvas.zoom")
        ok(z1 > z0 * 1.8, f"[{orient}] two-finger pinch zooms in ({z0:.2f} -> {z1:.2f})")
        # one-finger pan on empty canvas
        pg.evaluate("window.__sim.canvas.fit()"); pg.wait_for_timeout(100)
        pan0 = pg.evaluate("({...window.__sim.canvas.pan})")
        ex0, ey0 = pg.evaluate("""(() => { const r = document.getElementById('viewport').getBoundingClientRect(); for (let y = r.bottom - 80; y > r.top + 120; y -= 23) for (let x = r.left + 20; x < r.right - 140; x += 31) { const e = document.elementFromPoint(x, y), e2 = document.elementFromPoint(x + 100, y - 50); if (e && e.id === 'viewport' && e2 && e2.id === 'viewport' && !window.__sim.canvas._nearestPinEl(x, y, 24)) return [x, y]; } return [r.left + 20, r.bottom - 80]; })()""")
        pg.evaluate("""window.__pe=[]; ['pointerdown','pointermove','pointerup','pointercancel'].forEach(t => document.getElementById('viewport').addEventListener(t, e => window.__pe.push(t+':'+e.pointerId+':'+(e.target.className||e.target.id)), true))""")
        touch("touchStart", [(ex0, ey0)])
        for k in range(1, 6): touch("touchMove", [(ex0 + k * 20, ey0 - k * 10)]); pg.wait_for_timeout(16)
        touch("touchEnd", []); pg.wait_for_timeout(150)
        pan1 = pg.evaluate("({...window.__sim.canvas.pan})")
        print("   events", pg.evaluate("window.__pe.slice(0,8)")); print("   pan dbg", ex0, ey0, pg.evaluate("window.__sim.canvas.zoom"), pg.evaluate(f"document.elementFromPoint({ex0},{ey0}).id"))
        ok(abs(pan1["x"] - pan0["x"] - 100) < 2 and abs(pan1["y"] - pan0["y"] + 50) < 2, f"[{orient}] one-finger drag on empty canvas pans ({pan1['x']-pan0['x']:.0f},{pan1['y']-pan0['y']:.0f})")
        # run with touch: tap Jalankan
        pg.evaluate("window.__sim.canvas.fit()")
        r = pg.locator("#btnRun").bounding_box()
        print("   run btn", r, pg.evaluate(f"document.elementFromPoint({r['x']+r['width']/2},{r['y']+r['height']/2})?.outerHTML.slice(0,90)"), pg.evaluate("[document.querySelector('#btnRun').disabled, window.__sim.state.busy]"))
        pg.evaluate("""window.__ev = []; ['pointerdown','pointerup','pointercancel','click'].forEach(t => document.addEventListener(t, e => window.__ev.push(t + ':' + (e.target.id || e.target.tagName)), true))""")
        tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); pg.wait_for_timeout(1500)
        print("   events", pg.evaluate("window.__ev"))
        ok(pg.evaluate("window.__sim.sim.running"), f"[{orient}] tapping Jalankan runs the simulation" + ("" if pg.evaluate("window.__sim.sim.running") else " logs=" + json.dumps(pg.evaluate("[...document.querySelectorAll('#logList .log')].slice(-4).map(l=>l.textContent)"))))
        pg.screenshot(path=f"{SHOT}/ipad_{orient}_running.png")
        # code view on iPad + key bar
        r = pg.locator(".mode[data-mode=code]").bounding_box(); tap(r["x"] + r["width"] / 2, r["y"] + r["height"] / 2); pg.wait_for_timeout(300)
        ok(pg.locator("#keyBar").is_visible(), f"[{orient}] code view shows symbol key bar")
        pg.screenshot(path=f"{SHOT}/ipad_{orient}_code.png")
        ok(not errs, f"[{orient}] no page errors" + ("" if not errs else ": " + " | ".join(errs[:3])))
        ctx.close()

    # ---------------------------------------------------------------- breadboard snapping
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "#ex=breadboard-led"); pg.wait_for_function("window.__sim && window.__sim.state.exampleId === 'breadboard-led'", timeout=20000); pg.wait_for_timeout(500)
    plugs = pg.evaluate("window.__sim.canvas.wires.filter(w => w.plug).map(w => w.a + '>' + w.b)")
    ok(len(plugs) == 4, f"breadboard example: LED + resistor legs plugged automatically: {plugs}")
    pg.evaluate("window.__sim.run()"); pg.wait_for_timeout(1500)
    on = pg.evaluate("(() => { const s = []; for (let i=0;i<8;i++) {} return window.__sim.canvas.parts.get('led1').el.brightness; })()")
    pg.screenshot(path=f"{SHOT}/breadboard_running.png")
    # move LED off the breadboard -> plugs removed
    pg.evaluate("(() => { const c = window.__sim.canvas, p = c.parts.get('led1'); p.left += 300; c._place(p); c._plug(p, true); })()")
    plugs2 = pg.evaluate("window.__sim.canvas.wires.filter(w => w.plug && w.a.startsWith('led1:')).length")
    ok(plugs2 == 0, "moving the LED off the breadboard unplugs it")
    b.close()
print("\n%d FAILED" % fails if fails else "\nALL PASS"); sys.exit(1 if fails else 0)
