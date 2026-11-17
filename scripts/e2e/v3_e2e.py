# UI end-to-end test (Playwright, Python). Run against `npx vite preview --port 4181` (BASE=...), e.g. CHROME=/path/chrome python3 v3_e2e.py
import sys
from playwright.sync_api import sync_playwright
import os
CH = os.environ.get("CHROME") or None          # path to a Chromium binary (optional)
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")   # vite preview of the built app
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
exs = sys.argv[1:] or ['breadboard-led','oled','button','pot-pwm','servo','neopixel','esp32-weather']
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={"width":1180,"height":820}, has_touch=True)
    pg = ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type=="error" and errs.append(m.text))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
    for ex in exs:
        pg.evaluate(f"location.hash='#ex={ex}'"); pg.wait_for_timeout(1500)
        pg.evaluate("() => window.__sim.run()"); pg.wait_for_timeout(2500)
        pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2500)
        st = pg.evaluate("""() => { const v=window.__view3d.get(); const d=v._debug(); const it=[...d.items.values()];
           return {open:v.isOpen, n:it.length, kinds: it.map(i=>i.part.id+':'+i.kind+(i.top&&i.top.material.map?'+tex':'')), labels: document.querySelectorAll('.v3-label').length}; }""")
        ok(st['open'] and st['n']>0, f"[{ex}] 3D open: {st}")
        pg.screenshot(path=f"/tmp/v3_{ex}.png")
        if ex=='breadboard-led':
            lit = pg.evaluate("() => [...window.__view3d.get()._debug().items.values()].filter(i=>i.kind==='led').map(i=>i.model.kind)")
            ok(len(lit)==1, f"[{ex}] LED model present, glow {lit}")
        if ex=='button':
            # press the 3D button cap via pointer events
            pos = pg.evaluate("""() => { const d=window.__view3d.get()._debug(); const it=[...d.items.values()].find(i=>i.kind==='button'); const v=it.model.pick.getWorldPosition(new it.model.pick.position.constructor()); v.project(d.camera);
               const r=document.querySelector('.v3-gl').getBoundingClientRect(); return [r.left+(v.x+1)/2*r.width, r.top+(1-v.y)/2*r.height, it.part.id]; }""")
            pg.evaluate("""([x,y]) => { const c=document.querySelector('.v3-gl'); c.setPointerCapture=()=>{}; c.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y,pointerId:3,button:0,pointerType:'mouse'})); }""", pos[:2])
            pg.wait_for_timeout(400)
            pressed = pg.evaluate(f"() => window.__sim.canvas.parts.get('{pos[2]}').el.pressed")
            pg.screenshot(path=f"/tmp/v3_button_pressed.png")
            pg.evaluate("""([x,y]) => { const c=document.querySelector('.v3-gl'); c.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x,clientY:y,pointerId:3,button:0,pointerType:'mouse'})); }""", pos[:2])
            pg.wait_for_timeout(200)
            rel = pg.evaluate(f"() => window.__sim.canvas.parts.get('{pos[2]}').el.pressed")
            info = pg.evaluate("() => !document.querySelector('.v3-info').hidden && document.querySelector('.v3-info').innerText.slice(0,80)")
            ok(pressed and not rel, f"[{ex}] 3D button press/release reaches the part ({pressed}->{rel}); info card: {info!r}")
        pg.evaluate("() => window.__view3d.toggle(false)"); pg.wait_for_timeout(300)
        pg.evaluate("() => window.__sim.stop ? window.__sim.stop() : document.querySelector('#btnRun').click()")
    ok(not [e for e in errs if 'favicon' not in e and 'net::' not in e and 'setPointerCapture' not in e], f"no page errors: {errs[:5]}")
    b.close()
print("fails", fails)
