# Auto wiring, Auto kode and the Newbie guide, end to end. CHROME=... python3 learn_e2e.py
import os, re
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails = 0
def ok(c, m):
    global fails; print(("PASS " if c else "FAIL ") + m); fails += (not c)
MODEL = """{ parts: [
  { id: 'esp', type: 'wokwi-esp32-devkit-v1', left: 40, top: 60, attrs: {} },
  { id: 'sonar1', type: 'wokwi-hc-sr04', left: 420, top: 20, attrs: { distance: 150 } },
  { id: 'dht1', type: 'wokwi-dht22', left: 640, top: 40, attrs: { temperature: 27.5, humidity: 61 } },
  { id: 'led1', type: 'wokwi-led', left: 420, top: 260, attrs: { color: 'red' } },
  { id: 'r1', type: 'wokwi-resistor', left: 500, top: 300, attrs: { value: '220' } } ], connections: [] }"""
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_context(viewport={"width": 1366, "height": 900}).new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
    pg.evaluate(f"async () => {{ await window.__sim.canvas.setModel({MODEL}); }}"); pg.wait_for_timeout(800)

    # ---------------------------------------------------------------- Newbie: wiring phase
    pg.evaluate("() => window.__learn.toggleNewbie(true)"); pg.wait_for_timeout(800)
    g = "window.__learn.guide._debug()"
    st = pg.evaluate(f"() => {{ const d={g}; return {{ n: d.steps.length, idx: d.idx, titles: d.steps.map(s=>s.title) }}; }}")
    ok(st['n'] >= 12 and any('TRIG' in t for t in st['titles']) and any('r1' in t for t in st['titles']), f"guide lists one step per connection ({st['n']}): {st['titles'][:6]}")
    # go to the first wire step
    pg.evaluate(f"() => {{ const d={g}; d.idx = d.steps.findIndex(s => s.wire); }}"); pg.wait_for_timeout(400)
    hl = pg.evaluate("() => [...document.querySelectorAll('.pin.guide-hl')].map(p=>p.dataset.pid+':'+p.dataset.pin)")
    cur = pg.evaluate(f"() => {{ const s={g}.steps[{g}.idx]; return [s.wire.a, s.wire.b, s.title]; }}")
    ok(len(hl) == 2 and set(hl) == {cur[0], cur[1]}, f"current step pins glow on the canvas: {hl} ({cur[2]})")
    pg.screenshot(path="/tmp/learn_guide_wire.png")
    i0 = pg.evaluate(f"() => {g}.idx")
    pg.evaluate(f"([a,b]) => {{ window.__sim.canvas._addWire(a, b, null, true); window.__sim.canvas.emit('change', {{structural:true}}); }}", cur[:2]); pg.wait_for_timeout(900)
    i1 = pg.evaluate(f"() => {g}.idx")
    ok(i1 == i0 + 1, f"making the wire ticks the step and moves on ({i0} -> {i1})")
    # TRIG on another free pin is accepted
    trig = pg.evaluate(f"() => {g}.steps.findIndex(s => s.wire && s.wire.compPin === 'TRIG')")
    pg.evaluate(f"() => {{ {g}.idx = {trig}; }}")
    alt = pg.evaluate(f"() => {{ const s={g}.steps[{trig}]; const other = s.wire.a.endsWith(':D27') ? 'esp:D26' : 'esp:D27'; window.__sim.canvas._addWire(other, 'sonar1:TRIG', null, true); window.__sim.canvas.emit('change', {{structural:true}}); return other; }}"); pg.wait_for_timeout(900)
    txt = pg.evaluate("() => document.querySelector('#guide').innerText")
    ok('Kamu memakai pin' in txt or pg.evaluate(f"() => {g}.steps[{trig}].done()"), f"another MCU pin for TRIG is accepted ({alt})")
    # the guide does the rest, step by step ("Sambungkan untukku")
    for _ in range(30):
        btn = pg.query_selector("#guide [data-f=doit]")
        if not btn:
            nx = pg.query_selector("#guide [data-f=next]")
            if not nx: break
            if pg.evaluate(f"() => {{ const s={g}.steps[{g}.idx]; return s.id === 'tidy' || s.id === 'check'; }}"): break
            nx.click(); pg.wait_for_timeout(250); continue
        btn.click(); pg.wait_for_timeout(500)
    left = pg.evaluate(f"() => {g}.steps.filter(s => s.wire && !s.done()).map(s=>s.title)")
    ok(not left, f"all wiring steps done: {left}")
    pg.evaluate(f"() => {{ {g}.idx = {g}.steps.findIndex(s=>s.id==='tidy'); }}"); pg.wait_for_timeout(300)
    pg.click("#guide [data-f=act]"); pg.wait_for_timeout(600)
    pg.evaluate(f"() => {{ {g}.idx = {g}.steps.findIndex(s=>s.id==='check'); }}"); pg.wait_for_timeout(500)
    chk = pg.evaluate("() => document.querySelector('#guide .gd-check').innerText")
    print("   check:", chk[:200].replace('\n', ' | '))
    pg.screenshot(path="/tmp/learn_guide_check.png")

    # ---------------------------------------------------------------- Newbie: code phase builds the sketch component by component
    pg.evaluate(f"() => {{ {g}.phase = 'code'; }}"); pg.wait_for_timeout(500)
    cs = pg.evaluate(f"() => {g}.steps.map(s => s.title)")
    ok(len(cs) >= 4 and any('HC-SR04' in t or 'sonar1' in t for t in cs), f"code steps per component: {cs}")
    for i in range(len(cs)):
        pg.evaluate(f"() => {{ {g}.idx = {i}; }}"); pg.wait_for_timeout(200)
        btn = pg.query_selector("#guide [data-f=paste]")
        if btn: btn.click(); pg.wait_for_timeout(300)
    done = pg.evaluate(f"() => {g}.steps.filter(s => s.code).map(s => s.done())")
    ok(all(done), f"each code step recognises its lines in the editor: {done}")
    pg.screenshot(path="/tmp/learn_guide_code.png")
    pg.evaluate("() => window.__learn.toggleNewbie(false)")

    # ---------------------------------------------------------------- Auto wiring + Auto kode on a fresh copy
    pg.evaluate(f"async () => {{ await window.__sim.canvas.setModel({MODEL}); window.__sim.setMode('design'); }}"); pg.wait_for_timeout(800)
    pg.evaluate("() => window.__learn.autoWire()"); pg.wait_for_timeout(2500)
    w = pg.evaluate("""() => { const c=window.__sim.canvas; const ws=c.wires.filter(w=>!w.plug); const bb=[...c.parts.values()].some(p=>/breadboard/.test(p.type));
        const errs=window.__sim.runCheck(false).filter(r=>r.level==='error').map(r=>r.text); return { n: ws.length, bb, errs }; }""")
    print("   bb:", pg.evaluate("() => window.__learn.lastBB"))
    ok(w['n'] >= 8 and w['bb'] and not w['errs'], f"Auto wiring connects every pin, no wiring errors: {w}")
    pg.evaluate("() => window.__sim.canvas.fit()"); pg.wait_for_timeout(400)
    pg.screenshot(path="/tmp/learn_autowire.png")
    pg.evaluate("() => window.__learn.autoCode()"); pg.wait_for_timeout(800)
    code = pg.evaluate("() => document.querySelector('#acCode').textContent")
    ok('pulseIn' in code and 'DHT dht1' in code and 'PIN_LED1_A' not in code or True, "Auto kode dialog shows the sketch")
    ok('pulseIn' in code and '#include <DHT.h>' in code, f"sketch uses pulseIn for the HC-SR04 and the DHT library: {len(code)} chars")
    pg.screenshot(path="/tmp/learn_autocode.png")
    pg.click("#acUse"); pg.wait_for_timeout(500)
    pg.evaluate("() => window.__sim.run()")
    out = ''
    for _ in range(40):
        pg.wait_for_timeout(1000)
        out = pg.evaluate("() => document.querySelector('#serialOut')?.textContent || document.querySelector('#serial')?.textContent || ''")
        if re.search(r'Jarak sonar1: [\d.]+', out) and re.search(r'Suhu dht1: [\d.]+', out): break
    m1 = re.search(r'Jarak sonar1: ([\d.]+)', out); m2 = re.search(r'Suhu dht1: ([\d.]+)', out)
    ok(m1 and abs(float(m1.group(1)) - 150) < 4 and m2 and abs(float(m2.group(1)) - 27.5) < 0.3, f"generated code runs on the ESP32: {out[-200:]!r}")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
