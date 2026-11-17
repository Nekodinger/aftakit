# UI end-to-end test (Playwright, Python). Run against `npx vite preview --port 4181` (BASE=...), CHROME=/path/chrome optional
import os, zipfile, io, sys
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width":1400,"height":950}, accept_downloads=True); pg = ctx.new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1800)
    # 1) breadboard example: Uno + LED + resistor on a breadboard -> the breadboard becomes copper
    pg.evaluate("location.hash='#ex=breadboard-led'"); pg.wait_for_timeout(1500)
    pg.evaluate("() => window.__pcb.toggle(true)"); pg.wait_for_timeout(4000)
    st = pg.evaluate("() => { const v = window.__pcb.get(); const b = v.board; return { comps: b.comps.map(c=>c.id+':'+c.kind), nets: b.nets.map(n=>n.name+'('+n.pads.map(q=>q.comp+'.'+q.pad).join(',')+')'), stats: b.stats, w: b.w, h: b.h }; }")
    print(st)
    ok('bb1' not in ' '.join(st['comps']) and len(st['comps']) == 3, "breadboard removed, its strips become nets")
    ok(st['stats'] and st['stats']['failed'] == 0 and st['stats']['nets'] >= 2, f"all nets routed: {st['stats']}")
    ok(any('led1' in n and 'r1' in n for n in st['nets']), "LED-resistor connection (made on the breadboard) is a net")
    pg.locator('#pcbView').screenshot(path="/tmp/pcb_bb.png")
    # 2) ESP32 + modules wired with the pin table
    pg.evaluate("() => window.__pcb.toggle(false)")
    pg.evaluate("""async () => { const c = window.__sim.canvas; c.clear(true); c.pcbLayout = null;
      await c.addPart('wokwi-esp32-devkit-v1', 0, 0); await c.addPart('mod-oled-i2c', 300, -40); await c.addPart('wokwi-hc-sr04', 280, 200); await c.addPart('mod-relay1', -260, 60);
      await c.addPart('wokwi-dht22', -200, 260); await c.addPart('wokwi-led', 160, 330); await c.addPart('wokwi-resistor', 60, 360); await c.addPart('wokwi-servo', -260, -160); }""")
    pg.wait_for_timeout(300)
    pg.click('#tbWireText'); pg.wait_for_timeout(200); pg.click('#pmAutoAll'); pg.wait_for_timeout(200); pg.keyboard.press('Escape')
    pg.evaluate("() => { const c = window.__sim.canvas; for (const w of [...c.wires]) if (w.a==='led1:A'||w.b==='led1:A') c._removeWire(w, true); c._addWire('led1:A','r1:2',null,true); c._addWire('r1:1','esp32:D27',null,true); c.emit('change',{structural:true}); }")
    pg.evaluate("() => window.__pcb.toggle(true)"); pg.wait_for_timeout(9000)
    st2 = pg.evaluate("() => { const b = window.__pcb.get().board; return { stats: b.stats, n: b.comps.length, kinds: b.comps.map(c=>c.id+':'+c.kind), w: b.w, h: b.h, unrouted: b.unrouted }; }")
    print(st2)
    ok(st2['stats'] and st2['stats']['nets'] >= 10, f"ESP32 project nets: {st2['stats']}")
    ok(any(k.startswith('servo1:conn') for k in st2['kinds']), "servo becomes an off-board connector")
    ok(st2['stats']['failed'] <= 1, f"routed (failed {st2['stats']['failed']})")
    drcs = pg.evaluate("() => document.querySelector('.pcb-drc').innerText")
    print('DRC panel:', drcs[:200])
    pg.locator('#pcbView').screenshot(path="/tmp/pcb_esp.png")
    with pg.expect_download() as dl:
        pg.click('[data-p=gerber]')
    d = dl.value; data = open(d.path(), 'rb').read()
    z = zipfile.ZipFile(io.BytesIO(data)); names = z.namelist(); print(names)
    ok(any(n.endswith('.gtl') for n in names) and any(n.endswith('.gbl') for n in names) and any(n.endswith('.drl') for n in names) and any(n.endswith('.gm1') for n in names), "zip has copper, drill and outline files")
    os.makedirs('/tmp/pcbzip', exist_ok=True); [os.remove('/tmp/pcbzip/'+f) for f in os.listdir('/tmp/pcbzip')]; z.extractall('/tmp/pcbzip')
    # persistence of the PCB placement
    m = pg.evaluate("() => window.__sim.canvas.getModel().pcb")
    ok(m and len(m['comps']) == st2['n'], "PCB placement saved in the project")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
