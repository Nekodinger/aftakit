# UI end-to-end test (Playwright, Python). Run against `npx vite preview --port 4181` (BASE=...), e.g. CHROME=/path/chrome python3 wt_e2e.py
from playwright.sync_api import sync_playwright
import os
CH = os.environ.get("CHROME") or None          # path to a Chromium binary (optional)
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")   # vite preview of the built app
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox"])
    pg = b.new_page(viewport={"width":1024,"height":768}); pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
    pg.evaluate("""async () => { const c = window.__sim.canvas; c.clear(true);
      await c.addPart('wokwi-esp32-devkit-v1', 60, 100); await c.addPart('x-breadboard-half', 500, 120); await c.addPart('wokwi-ssd1306', 300, 420);
      await c.addPart('wokwi-led', 900, 420); await c.addPart('wokwi-resistor', 900, 520); }""")
    pg.wait_for_timeout(300)
    ids = pg.evaluate("() => [...window.__sim.canvas.parts.values()].map(p=>p.id+'='+p.type)"); print(ids)
    pg.click('#tbWireText'); pg.wait_for_timeout(200); pg.click('[data-pmt=text]'); pg.wait_for_timeout(100)
    ok(pg.evaluate("document.querySelector('#dlgWires').open"), "dialog opens from toolbar")
    text = """# OLED I2C
esp32:D21 - ssd1:DATA kuning
esp32:GPIO22 -> ssd1:CLK hijau
esp32:3V3 ke ssd1:3V3 merah
esp32:GND to bb1:- hitam
led1:A - bb1:a10
bb1:e10 - r1:1 ; r1:2 - esp32:D2 biru
led1:K ke bb1:TN
foo:X - esp32:D5
esp32:D21 - ssd1:DATA
esp32:D99 - led1:A
"""
    pg.fill('#wtText', text)
    pg.click('#wtApply'); pg.wait_for_timeout(300)
    res = pg.inner_text('#wtResult'); print(res)
    w = pg.evaluate("() => window.__sim.canvas.getModel().connections.filter(c=>c[2]!=='plug').map(c=>c[0]+' '+c[1]+' '+c[2])")
    print("\n".join(w))
    ok(len(w)==8, f"8 wires created ({len(w)})")
    ok(any(x.startswith('esp32:D21 ssd1:DATA #f5a524') for x in w), "colour word applied (kuning)")
    ok(any(x.startswith('esp32:D22 ssd1:CLK') for x in w), "GPIO22 alias resolved to D22")
    ok(any('bb1:TN.' in x or 'bb1:BN.' in x for x in w if x.startswith('esp32:GND')), "GND to rail '-' resolved to nearest rail hole")
    ok(any(x.startswith('led1:A bb1:T10.a') for x in w), "breadboard hole a10 resolved")
    ok(any(x.startswith('led1:C bb1:TN.') for x in w), "K alias -> cathode, TN rail")
    ok('tidak ada di kanvas' in res and 'sudah ada' in res and 'D99' in res, "errors reported per line")
    ok(pg.evaluate("document.querySelector('#dlgWires').open"), "dialog stays open when there are errors")
    pg.click('#wtExport'); t = pg.input_value('#wtText'); print(t)
    ok('bb1:a10' in t and 'kuning' in t and len(t.strip().split('\n'))==8, "export to text uses hole names + colours")
    # round trip: clear wires, re-apply exported text
    pg.evaluate("() => { const c=window.__sim.canvas; for (const w of [...c.wires]) if(!w.plug) c._removeWire(w,true); }")
    pg.click('#wtApply'); pg.wait_for_timeout(300)
    w2 = pg.evaluate("() => window.__sim.canvas.getModel().connections.filter(c=>c[2]!=='plug').map(c=>c[0]+' '+c[1]+' '+c[2])")
    ok(sorted(w2)==sorted(w), f"round trip identical ({len(w2)})")
    ok(not pg.evaluate("document.querySelector('#dlgWires').open"), "dialog closes after clean apply")
    pg.evaluate("() => window.__sim.canvas.undo()"); pg.wait_for_timeout(200)
    n = pg.evaluate("() => window.__sim.canvas.wires.filter(w=>!w.plug).length")
    ok(n==0, f"one undo removes the typed batch ({n})")
    b.close()
print("fails", fails)
