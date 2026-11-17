# Every catalogue part builds a 3D model without errors (one microcontroller per scene, the rest in batches).
import json, os, sys
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails = 0
def ok(c, m):
    global fails; print(("PASS " if c else "FAIL ") + m); fails += (not c)
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 1300, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(2000)
    tags = pg.evaluate("() => [...document.querySelectorAll('.card[data-tag]')].map(e => e.dataset.tag)")
    tags = [t for t in dict.fromkeys(tags) if 'breadboard' not in t]
    mcus = pg.evaluate("(ts) => ts.filter(t => /arduino|esp32-devkit|franzininho|esp32-cam|nodemcu|d1mini|pico|rp2040/.test(t))", tags)
    rest = [t for t in tags if t not in mcus]
    batches = [[m] for m in mcus] + [rest[i:i + 8] for i in range(0, len(rest), 8)]
    built = 0
    for bt in batches:
        pg.evaluate("""async (ts) => { const c = window.__sim.canvas; c.clear(true); let x = 0; for (const t of ts) { await c.addPart(t, x, 0); x += 260; } }""", bt)
        pg.wait_for_timeout(300)
        pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(1200)
        n = pg.evaluate("() => [...window.__view3d.get()._debug().items.values()].filter(i => i.group.children.length > 0).length")
        built += n
        pg.evaluate("() => window.__view3d.toggle(false)")
    ok(built == len(tags), f"3D model built for every part: {built}/{len(tags)}")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
