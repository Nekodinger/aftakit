# 3D lab end-to-end test: hand interaction with sensors / inputs, multimeter probes and the fault finder.
# Run against `npx vite preview --port 4181` (BASE=...), with the compile server on VITE_COMPILE_URL, e.g.
#   CHROME=/path/chrome python3 lab3d_e2e.py
import os
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails = 0
def ok(c, m):
    global fails; print(("PASS " if c else "FAIL ") + m); fails += (not c)

# screen position of a model point: part-local (mm, centred) -> world -> canvas pixels
SCR = """([id, lx, ly, lz]) => { const d=window.__view3d.get()._debug(); const it=d.items.get(id); const V=it.group.position.constructor;
  const w=it.group.localToWorld(new V(lx, ly, lz)); const s=d.project(w); const r=document.querySelector('.v3-gl').getBoundingClientRect(); return [r.left+s.x, r.top+s.y]; }"""
PTR = """([type, x, y, id]) => { const c=document.querySelector('.v3-gl'); c.setPointerCapture=()=>{}; c.dispatchEvent(new PointerEvent(type,{bubbles:true,clientX:x,clientY:y,pointerId:id||5,button:0,buttons:type==='pointerup'?0:1,pointerType:'mouse'})); }"""
def ptr(pg, t, x, y): pg.evaluate(PTR, [t, x, y, 5])
def tap(pg, x, y):
    ptr(pg, "pointerdown", x, y); pg.wait_for_timeout(60); ptr(pg, "pointerup", x, y); pg.wait_for_timeout(250)
def drag(pg, x, y, dx, dy, n=8):
    ptr(pg, "pointerdown", x, y)
    for i in range(1, n + 1): ptr(pg, "pointermove", x + dx * i / n, y + dy * i / n); pg.wait_for_timeout(25)
    ptr(pg, "pointerup", x + dx, y + dy); pg.wait_for_timeout(250)
def settle(pg):
    pg.wait_for_function("() => !window.__view3d.get()._debug().animating", timeout=15000); pg.wait_for_timeout(600)
def top_point(pg, pid):
    """screen point on top of the part (bounding box centre, top face)"""
    return pg.evaluate("""(id) => { const d=window.__view3d.get()._debug(); const it=d.items.get(id); const B=it.group.position.constructor;
      const hits=[]; let mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9]; it.group.updateMatrixWorld(true);
      it.group.traverse(o=>{ if(!o.isMesh||!o.geometry) return; o.geometry.computeBoundingBox(); const bb=o.geometry.boundingBox; for (const x of [bb.min.x,bb.max.x]) for (const y of [bb.min.y,bb.max.y]) for (const z of [bb.min.z,bb.max.z]) { const p=o.localToWorld(new B(x,y,z)); mn=[Math.min(mn[0],p.x),Math.min(mn[1],p.y),Math.min(mn[2],p.z)]; mx=[Math.max(mx[0],p.x),Math.max(mx[1],p.y),Math.max(mx[2],p.z)]; } });
      const c=new B((mn[0]+mx[0])/2, mx[1], (mn[2]+mx[2])/2); const s=d.project(c); const r=document.querySelector('.v3-gl').getBoundingClientRect(); return [r.left+s.x, r.top+s.y]; }""", pid)
def pin_point(pg, ref):
    return pg.evaluate("""(ref) => { const d=window.__view3d.get()._debug(); const p=d.contactOf(ref); if(!p) return null;
      const s=d.project(p); const r=document.querySelector('.v3-gl').getBoundingClientRect(); return [r.left+s.x, r.top+s.y]; }""", ref)

with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_context(viewport={"width": 1280, "height": 860}).new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1500)

    # ---------------------------------------------------------------- DHT22 + LCD: drag the sensor, multimeter, diagnosis
    pg.evaluate("location.hash='#ex=dht-lcd-i2c'"); pg.wait_for_timeout(1500)
    pg.evaluate("() => window.__sim.run()"); pg.wait_for_timeout(5000)
    run = pg.evaluate("() => window.__sim.sim.running")
    ok(run, "simulation running (dht-lcd-i2c)")
    pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2500)
    dht = pg.evaluate("() => [...window.__sim.canvas.parts.values()].find(p=>p.type==='wokwi-dht22').id")
    t0 = pg.evaluate(f"() => window.__sim.canvas.parts.get('{dht}').attrs.temperature")
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{dht}')"); settle(pg)
    x, y = top_point(pg, dht)
    drag(pg, x, y, 0, -90)
    t1 = pg.evaluate(f"() => window.__sim.canvas.parts.get('{dht}').attrs.temperature")
    ok(t1 > t0, f"drag DHT22 upward raises temperature {t0} -> {t1}")
    card = pg.evaluate("() => { const i=document.querySelector('.v3-info'); return !i.hidden && i.innerText; }")
    ok(card and 'Kontrol' in card, f"info card with Kontrol tab after the gesture: {str(card)[:90]!r}")
    # slider in the card
    pg.evaluate("""() => { const s=document.querySelector('.v3-info input[data-k=humidity]'); s.value=77; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); }""")
    hum = pg.evaluate(f"() => window.__sim.canvas.parts.get('{dht}').attrs.humidity")
    ok(hum == 77, f"Kontrol slider sets humidity = {hum}")
    pg.wait_for_timeout(3500)
    lcd = pg.evaluate("() => { const p=[...window.__sim.canvas.parts.values()].find(p=>/lcd/.test(p.type)); try { return (p.el.text||'') } catch(e) { return '' } }")
    lbl = pg.evaluate(f"() => [...document.querySelectorAll('.v3-label')].find(l=>l.textContent.startsWith('{dht}'))?.textContent")
    ok(lbl and '77' in lbl, f"3D label shows live reading: {lbl!r}")
    for _ in range(16):
        if '77' in lcd: break
        pg.wait_for_timeout(1000); lcd = pg.evaluate("() => { const p=[...window.__sim.canvas.parts.values()].find(p=>/lcd/.test(p.type)); try { return (p.el.text||'') } catch(e) { return '' } }")
    ok('77' in lcd, f"program reads the new sensor value (LCD): {lcd!r}")
    pg.screenshot(path="/tmp/lab_dht.png")

    # multimeter: probe DHT VCC and GND
    pg.evaluate("() => document.querySelector('[data-v=probe]').click()"); pg.wait_for_timeout(300)
    pins = pg.evaluate(f"() => window.__sim.canvas.parts.get('{dht}').pinInfo.map(p=>p.name)")
    vcc = next(n for n in pins if n.startswith('VCC')); gnd = next(n for n in pins if n.startswith('GND'))
    for ref in [f"{dht}:{vcc}", f"{dht}:{gnd}"]:
        q = pin_point(pg, ref)
        if q: tap(pg, q[0], q[1])
    pr = pg.evaluate("() => window.__view3d.get()._debug().probes.map(p=>p.ref)")
    if len(pr) < 2:                                   # contact hidden behind the model at this angle: use the card's pin table
        for ref in [f"{dht}:{vcc}", f"{dht}:{gnd}"]:
            if ref not in pr: pg.evaluate("(r) => window.__view3d.get()._debug().toggleProbe(r)", ref)
        print("   (probes placed via pin table fallback)", pr)
    pg.wait_for_timeout(800)
    meter = pg.evaluate("() => document.querySelector('.v3-meter').innerText")
    ok('5.00 V' in meter and '0.00 V' in meter and 'Beda tegangan' in meter, f"multimeter reads VCC 5 V, GND 0 V and the difference: {meter[:200]!r}")
    pg.screenshot(path="/tmp/lab_probe.png")
    # hover tooltip
    hole = pg.evaluate(f"() => (window.__sim.canvas.wires.find(w=>w.plug&&w.a==='{dht}:{vcc}')||{{}}).b")
    tip = False
    for attempt in range(3):
        settle(pg); q = pin_point(pg, hole or f"{dht}:{vcc}")
        pg.evaluate("""([x,y]) => document.querySelector('.v3-gl').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x,clientY:y,pointerId:5,buttons:0,pointerType:'mouse'}))""", q)
        pg.wait_for_timeout(900)
        tip = pg.evaluate("() => { const t=document.querySelector('.v3-tip'); return !t.hidden && t.innerText; }")
        if tip: break
    ok(tip and 'V' in tip, f"hover tooltip on a pin: {tip!r}")

    # diagnosis: cut the VCC wire of the DHT22, run again -> fault found, part flagged
    pg.evaluate("() => document.querySelector('[data-v=probe]').click()")
    pg.evaluate("() => window.__view3d.toggle(false)"); pg.wait_for_timeout(200)
    pg.evaluate(f"""() => {{ const c=window.__sim.canvas; const pl=c.wires.find(w=>w.plug&&w.a.startsWith('{dht}:VCC')); const strip=pl? pl.b.split('.')[0]+'.' : null;
        const w=c.wires.find(w=>!w.plug&&(w.a.startsWith('{dht}:VCC')||w.b.startsWith('{dht}:VCC')||(strip&&(w.a.startsWith(strip)||w.b.startsWith(strip))))); if (w) {{ c.select({{kind:'wire',id:w.id}}); c.deleteSelected(); }} return !!w; }}""")
    pg.evaluate("() => window.__sim.run()"); pg.wait_for_timeout(4500)
    pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2000)
    pg.evaluate("() => document.querySelector('[data-v=diag]').click()"); pg.wait_for_timeout(1200)
    dg = pg.evaluate("() => document.querySelector('.v3-diag').innerText")
    flagged = pg.evaluate(f"() => [...document.querySelectorAll('.v3-label.err, .v3-label.warn')].map(l=>l.textContent.split(/\\s/)[0])")
    ok(dht in dg and any(f.startswith(dht) for f in flagged), f"diagnosis names {dht} and flags its label: {dg[:220]!r} flagged={flagged}")
    cnt = pg.evaluate("() => document.querySelector('.v3-cnt').textContent")
    halos = pg.evaluate("() => window.__view3d.get()._debug().scene.children.flatMap(o=>o.children||[]).filter(o=>o.type==='Box3Helper').length")
    ok(int(cnt or 0) > 0 and halos > 0, f"diagnosis badge count {cnt}, highlight boxes {halos}")
    pg.evaluate("() => document.querySelector('.v3-di')?.click()"); pg.wait_for_timeout(700)
    ok(pg.evaluate("() => window.__view3d.get()._debug().probes.length") >= 1, "tapping a measured fault attaches a probe to the faulty pin")
    pg.evaluate("() => window.__view3d.get()._debug().setProbeMode(false)")
    pg.screenshot(path="/tmp/lab_diag.png")
    pg.evaluate("() => document.querySelector('[data-v=diag]').click()")
    pg.evaluate("() => window.__view3d.toggle(false)"); pg.evaluate("() => window.__sim.sim.stop()")

    # ---------------------------------------------------------------- keypad: tap a key on the 3D model
    pg.evaluate("location.hash='#ex=keypad'"); pg.wait_for_timeout(1500)
    pg.evaluate("() => window.__sim.run()"); pg.wait_for_timeout(4000)
    pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2500)
    kp = pg.evaluate("() => [...window.__sim.canvas.parts.values()].find(p=>p.type==='wokwi-membrane-keypad').id")
    pg.evaluate(f"""() => {{ window.__keys=[]; window.__sim.canvas.parts.get('{kp}').el.addEventListener('button-press', e=>window.__keys.push(e.detail.key)); }}""")
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{kp}')"); settle(pg)
    # local position of key "5" from the 2D artwork -> 3D local -> screen
    loc = pg.evaluate(f"""() => {{ const part=window.__sim.canvas.parts.get('{kp}'); const r=part.el.shadowRoot; const k=[...r.querySelectorAll('text')].find(t=>t.textContent.trim()==='5');
        const er=part.el.getBoundingClientRect(), kr=k.getBoundingClientRect(), z=window.__sim.canvas.zoom||1;
        return [ (kr.left+kr.width/2-(er.left+er.width/2))/z, (kr.top+kr.height/2-(er.top+er.height/2))/z ]; }}""")
    MM = 1 / 3.7795
    top_y = pg.evaluate(f"() => {{ const d=window.__view3d.get()._debug(); const it=d.items.get('{kp}'); let y=0; it.group.traverse(o=>{{ if(o.isMesh){{o.geometry.computeBoundingBox(); y=Math.max(y,o.geometry.boundingBox.max.y+o.position.y);}} }}); return y; }}")
    sx, sy = pg.evaluate(SCR, [kp, loc[0] * MM, top_y, loc[1] * MM])
    tap(pg, sx, sy); pg.wait_for_timeout(400)
    keys = pg.evaluate("() => window.__keys")
    ok('5' in keys, f"tapping key 5 on the 3D keypad presses it: {keys}")
    pg.screenshot(path="/tmp/lab_keypad.png")
    pg.evaluate("() => window.__view3d.toggle(false)"); pg.evaluate("() => window.__sim.sim.stop()")

    # ---------------------------------------------------------------- joystick, slide switch, PIR, encoder added to a project
    pg.evaluate("location.hash='#ex=breadboard-led'"); pg.wait_for_timeout(1500)
    ids = pg.evaluate("""async () => { const c=window.__sim.canvas; const out={};
        for (const [t,x,y] of [['wokwi-analog-joystick',520,40],['wokwi-slide-switch',700,60],['wokwi-pir-motion-sensor',820,40],['wokwi-ky-040',980,60]]) out[t]=await c.addPart(t,x,y);
        return out; }""")
    pg.wait_for_timeout(600)
    pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2500)
    kinds = pg.evaluate("(ids) => Object.fromEntries(Object.values(ids).map(id => [id, window.__view3d.get()._debug().interactKind(window.__view3d.get()._debug().items.get(id))]))", ids)
    print("   kinds:", kinds)
    js = ids['wokwi-analog-joystick']
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{js}')"); settle(pg)
    x, y = top_point(pg, js)
    ptr(pg, "pointerdown", x, y)
    for i in range(1, 7): ptr(pg, "pointermove", x + 10 * i, y); pg.wait_for_timeout(20)
    xv = pg.evaluate(f"() => window.__sim.canvas.parts.get('{js}').el.xValue")
    ptr(pg, "pointerup", x + 60, y); pg.wait_for_timeout(200)
    xv2 = pg.evaluate(f"() => window.__sim.canvas.parts.get('{js}').el.xValue")
    ok(xv is not None and abs(xv) > 0.5 and xv2 == 0, f"joystick follows the drag (x={xv}) and springs back ({xv2})")
    sw = ids['wokwi-slide-switch']
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{sw}')"); settle(pg)
    v0 = pg.evaluate(f"() => window.__sim.canvas.parts.get('{sw}').el.value")
    x, y = top_point(pg, sw); tap(pg, x, y)
    v1 = pg.evaluate(f"() => window.__sim.canvas.parts.get('{sw}').el.value")
    ok(v0 != v1, f"tap toggles the slide switch {v0} -> {v1}")
    pir = ids['wokwi-pir-motion-sensor']
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{pir}')"); settle(pg)
    m0 = pg.evaluate(f"() => !!window.__sim.canvas.parts.get('{pir}').attrs.motion")
    x, y = top_point(pg, pir); tap(pg, x, y)
    m1 = pg.evaluate(f"() => !!window.__sim.canvas.parts.get('{pir}').attrs.motion")
    ok(m0 != m1, f"tap on the PIR sensor triggers motion {m0} -> {m1}")
    enc = ids['wokwi-ky-040']
    pg.evaluate(f"() => window.__view3d.get()._debug().focusPart('{enc}')"); settle(pg)
    pg.evaluate(f"() => {{ window.__rot=0; window.__sim.canvas.parts.get('{enc}').el.addEventListener('rotate-cw', ()=>window.__rot++); }}")
    x, y = top_point(pg, enc); drag(pg, x, y, 70, 0)
    rot = pg.evaluate("() => window.__rot")
    ok(rot >= 3, f"dragging the encoder sends rotate-cw steps: {rot}")
    pg.screenshot(path="/tmp/lab_inputs.png")
    pg.evaluate("() => window.__view3d.toggle(false)")

    bad = [e for e in errs if 'favicon' not in e and 'net::' not in e and 'PointerCapture' not in e]
    ok(not bad, f"no page errors: {bad[:5]}")
    b.close()
print("fails", fails)
