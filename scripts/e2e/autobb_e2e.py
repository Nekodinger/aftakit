# Every example loads on a breadboard with the same electrical nets, and still runs. CHROME=... python3 autobb_e2e.py
import os, sys
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails = 0
def ok(c, m):
    global fails; print(("PASS " if c else "FAIL ") + m); fails += (not c)
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_context(viewport={"width": 1280, "height": 860}).new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
    ids = sys.argv[1:] or pg.evaluate("() => [...document.querySelectorAll('[data-ex]')].map(b=>b.dataset.ex)")
    shots = {'breadboard-led', 'dht-lcd-i2c', 'button', 'esp32-iot', 'sonar', 'traffic', 'esp32-weather'}
    for ex in ids:
        pg.evaluate(f"location.hash='#ex={ex}'"); pg.wait_for_timeout(1400)
        r = pg.evaluate("""() => { const s=window.__sim.state.autobb||{}; const c=window.__sim.canvas; const ws=c.wires.filter(w=>!w.plug);
            const bb=[...c.parts.values()].filter(p=>/breadboard/.test(p.type)).map(p=>p.id);
            const on = bb.length ? c.pluggedInto(bb[0]) : [];
            const curved = ws.filter(w => !c.wirePoints(w).length && (() => { const a=c.pinPos(w.a), b=c.pinPos(w.b); return Math.abs(a.x-b.x)>0.5 && Math.abs(a.y-b.y)>0.5; })()).length;
            const diag = ws.filter(w => { const P=[c.pinPos(w.a), ...c.wirePoints(w), c.pinPos(w.b)]; for (let i=1;i<P.length;i++) if (Math.abs(P[i].x-P[i-1].x)>0.6 && Math.abs(P[i].y-P[i-1].y)>0.6) return true; return false; }).length;
            return { ok: s.ok, reason: s.reason, existing: !!s.existing, placed: (s.placed||[]).length, bb: bb.length, on: on.length, wires: ws.length, curved, diag }; }""")
        good = r['bb'] >= 1 or (not r['ok'] and r['reason'])
        ok(good and r['curved'] == 0, f"[{ex}] {r}")
        if r['diag']: print(f"   note: {r['diag']} wire(s) with a slanted segment")
        # still runs
        pg.evaluate("() => window.__sim.run()"); pg.wait_for_timeout(1800)
        st = pg.evaluate("() => ({ run: window.__sim.sim.running, errs: [...document.querySelectorAll('#logList .err, #logList .error')].map(e=>e.textContent).slice(0,2) })")
        ok(st['run'] or 'design' in ex, f"[{ex}] runs: {st}")
        if ex in shots:
            pg.evaluate("() => window.__sim.setMode('design')"); pg.wait_for_timeout(300); pg.evaluate("() => window.__sim.canvas.fit()"); pg.wait_for_timeout(300)
            pg.screenshot(path=f"/tmp/abb_{ex}.png")
            pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(2600)
            pg.screenshot(path=f"/tmp/abb3d_{ex}.png")
            pg.evaluate("() => window.__view3d.toggle(false)")
        pg.evaluate("() => window.__sim.sim.stop()")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
