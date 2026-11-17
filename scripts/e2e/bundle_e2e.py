# UI end-to-end test (Playwright, Python). Run against `npx vite preview --port 4181` (BASE=...), CHROME=/path/chrome optional
import os
from playwright.sync_api import sync_playwright
CH = os.environ.get("CHROME") or None
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width":1400,"height":950}); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "/"); pg.wait_for_timeout(1800)
    pg.evaluate("""async () => { const c = window.__sim.canvas; c.clear(true);
      await c.addPart('wokwi-esp32-devkit-v1', 0, 0); await c.addPart('mod-oled-i2c', 300, -40); await c.addPart('wokwi-hc-sr04', 280, 200); await c.addPart('mod-relay1', -260, 60); }""")
    pg.wait_for_timeout(300)
    pg.click('#tbWireText'); pg.wait_for_timeout(200); pg.click('#pmAutoAll'); pg.wait_for_timeout(200); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    n0 = pg.evaluate("() => window.__sim.canvas.wires.filter(w=>!w.plug).length")
    pg.evaluate("() => window.__sim.canvas.fit()"); pg.wait_for_timeout(200)
    pg.screenshot(path="/tmp/bundle_before.png")
    exp = pg.evaluate("() => [...window.__sim.canvas._wireGroups().values()].filter(g=>g.length>1).reduce((t,g)=>t+g.length,0)")
    n = pg.evaluate("() => window.__sim.canvas.bundleWires()")
    ok(n == exp and n >= n0 - 3, f"wires in groups of 2+ (same parts, same pin sides) bundled: {n}/{n0}")
    st = pg.evaluate("""() => { const c = window.__sim.canvas; const ws = c.wires.filter(w=>!w.plug);
      const segs = []; for (const w of ws) { const P=[c.pinPos(w.a), ...w.pts, c.pinPos(w.b)]; for (let i=0;i<P.length-1;i++) segs.push([w.id, P[i], P[i+1]]); }
      const orth = ws.every(w => { const P=[...w.pts]; for (let i=0;i<P.length-1;i++) if (Math.abs(P[i].x-P[i+1].x)>0.6 && Math.abs(P[i].y-P[i+1].y)>0.6) return false; return true; });
      // crossings between wires of the same bundle (a swap right at the connector is unavoidable when the two pin rows are in opposite order)
      const X = (a,b,c2,d) => { const o=(p,q,r)=>Math.sign((q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)); return o(a,b,c2)*o(a,b,d)<0 && o(c2,d,a)*o(c2,d,b)<0; };
      let cross = 0; for (let i=0;i<segs.length;i++) for (let j=i+1;j<segs.length;j++) { const A=segs[i], B=segs[j]; if (A[0]===B[0]) continue;
        const wa = ws.find(w=>w.id===A[0]), wb = ws.find(w=>w.id===B[0]); if (!wa.bundle || wa.bundle!==wb.bundle) continue; if (X(A[1],A[2],B[1],B[2])) { const ends=[wa,wb].flatMap(w=>[c.pinPos(w.a),c.pinPos(w.b)]); const near=(q)=>ends.some(e=>Math.hypot(e.x-q.x,e.y-q.y)<20); if (!(near(A[1])||near(A[2])||near(B[1])||near(B[2]))) cross++; } }
      return { orth, cross, ties: c.bundleTies().length, bundles: new Set(ws.filter(w=>w.bundle).map(w=>w.bundle)).size, saved: (c.getModel().bundles||[]).length }; }""")
    ok(st['orth'], "bundle routes are orthogonal")
    ok(st['cross'] == 0, f"no crossings inside a bundle ({st['cross']})")
    ok(st['ties'] >= st['bundles'] and st['saved'] == st['bundles'], f"cable ties drawn and bundles saved: {st}")
    pg.screenshot(path="/tmp/bundle_after.png")
    # save/load keeps bundles
    m = pg.evaluate("() => window.__sim.canvas.getModel()")
    pg.evaluate("async (m) => { await window.__sim.canvas.setModel(m); }", m); pg.wait_for_timeout(300)
    t2 = pg.evaluate("() => window.__sim.canvas.bundleTies().length")
    ok(t2 == st['ties'], f"bundles survive save/load ({t2})")
    # move a part: bundle re-routed
    pg.evaluate("""() => { const c = window.__sim.canvas; const p = c.parts.get('relay1'); p.top += 120; c._place(p); c._rerouteBundles('relay1'); c._redrawWires(); }""")
    st2 = pg.evaluate("""() => { const c=window.__sim.canvas; const w=c.wires.find(w=>w.bundle && (w.a.startsWith('relay1:')||w.b.startsWith('relay1:'))); const P=[c.pinPos(w.a), ...w.pts, c.pinPos(w.b)]; let mx=0; for (let i=0;i<P.length-1;i++) mx=Math.max(mx, Math.min(Math.abs(P[i].x-P[i+1].x), Math.abs(P[i].y-P[i+1].y))); return mx; }""")
    ok(st2 < 0.6, f"bundle follows a moved part (still orthogonal, max skew {st2})")
    pg.evaluate("() => window.__view3d.toggle(true)"); pg.wait_for_timeout(3000)
    ties3d = pg.evaluate("() => window.__view3d.get()._debug().scene.children.length")
    pg.locator('#view3d').screenshot(path="/tmp/bundle_3d.png")
    ok(not errs, f"no page errors {errs[:3]}")
    b.close()
print("fails", fails)
