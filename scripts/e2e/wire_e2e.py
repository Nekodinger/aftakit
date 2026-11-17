# UI end-to-end test (Playwright, Python). Run against `npx vite preview --port 4181` (BASE=...), e.g. CHROME=/path/chrome python3 wire_e2e.py
from playwright.sync_api import sync_playwright
import os
CH = os.environ.get("CHROME") or None          # path to a Chromium binary (optional)
BASE = os.environ.get("BASE", "http://localhost:4181").rstrip("/")   # vite preview of the built app
fails=0
def ok(c,m):
    global fails; print(("PASS " if c else "FAIL ")+m); fails += (not c)
FIRE = '''([evs]) => { const vp=document.querySelector('#viewport'); vp.setPointerCapture=()=>{};
  for (const [type,X,Y,id,tgt] of evs) { const t = tgt==='vp' ? vp : (document.elementFromPoint(X,Y)||vp);
    t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:id,pointerType:'touch',isPrimary:id===1,button:0,clientX:X,clientY:Y})); } }'''
with sync_playwright() as p:
    b = p.chromium.launch(**({"executable_path": CH} if CH else {}), args=["--no-sandbox"])
    for touch in (False, True):
        ctx = b.new_context(viewport={"width":1024,"height":768}, has_touch=touch)
        pg = ctx.new_page(); pg.goto(BASE + "/"); pg.wait_for_timeout(1500)
        pg.evaluate("""async () => { const c = window.__sim.canvas; c.clear(true);
          await c.addPart('wokwi-esp32-devkit-v1', 60, 100); await c.addPart('x-breadboard-half', 900, 120);
          c.zoom=0.8; c.pan={x:0,y:0}; c._applyView(); }""")
        pg.wait_for_timeout(500)
        ids = pg.evaluate("() => [...window.__sim.canvas.parts.values()].map(p=>p.id)")
        esp, bb = ids
        def scr(ref):
            return pg.evaluate("(r) => { const c=window.__sim.canvas; const q=c.pinPos(r); const v=c.viewport.getBoundingClientRect(); return [v.left+c.pan.x+q.x*c.zoom, v.top+c.pan.y+q.y*c.zoom]; }", ref)
        def ev(seq):
            if touch: pg.evaluate(FIRE, [seq])
            else:
                for t,x,y,_,__ in seq:
                    if t=='pointerdown': pg.mouse.move(x,y); pg.mouse.down()
                    elif t=='pointermove': pg.mouse.move(x,y)
                    else: pg.mouse.move(x,y); pg.mouse.up()
            pg.wait_for_timeout(120)
        def tap(x,y): ev([('pointerdown',x,y,1,None),('pointerup',x,y,1,'vp')])
        def drag(x,y,dx,dy,start=None):
            ev([('pointerdown',x,y,1,start)] + [('pointermove',x+dx*i/12,y+dy*i/12,1,'vp') for i in range(1,13)] + [('pointerup',x+dx,y+dy,1,'vp')])
        pend = lambda: pg.evaluate("() => { const p=window.__sim.canvas.pending; return p ? {ref:p.ref, pts:(p.pts||[]).length, dragging:p.dragging} : null; }")
        T=f"[touch={touch}]"
        # 1) start at ESP32 D21 by tapping, pan the view by dragging empty space -> wire must survive
        x,y = scr(f"{esp}:D21"); tap(x,y)
        ok(pend() and pend()['ref']==f"{esp}:D21", f"{T} wire started at D21: {pend()}")
        pan0 = pg.evaluate("({...window.__sim.canvas.pan})")
        drag(650,500,-250,0)
        pan1 = pg.evaluate("({...window.__sim.canvas.pan})")
        ok(pend() is not None and pend()['pts']==0, f"{T} panning while wiring keeps wire: pan {pan0['x']:.0f}->{pan1['x']:.0f} pending={pend()}")
        ok(abs(pan1['x']-pan0['x']+250) < 2, f"{T} view panned by 250 px")
        # 2) tap empty space -> bend point
        tap(700,530)
        ok(pend() and pend()['pts']==1, f"{T} tap empty adds bend: {pend()}")
        # 3) pinch zoom (touch) keeps the wire
        if touch:
            pg.evaluate(FIRE, [[("pointerdown",600,450,1,"vp"),("pointerdown",700,450,2,"vp"),("pointermove",580,450,1,"vp"),("pointermove",740,450,2,"vp"),("pointerup",580,450,1,"vp"),("pointerup",740,450,2,"vp")]])
            pg.wait_for_timeout(100)
            ok(pend() is not None, f"{T} pinch keeps the wire, zoom={pg.evaluate('window.__sim.canvas.zoom'):.2f}")
        pg.evaluate("(r) => { const c=window.__sim.canvas; const q=c.pinPos(r); c.pan={x:600-68-q.x*c.zoom, y:300-60-q.y*c.zoom}; c._applyView(); }", f"{bb}:T10.a")
        # 4) tap a breadboard hole -> wire completes with bend point
        x,y = scr(f"{bb}:T10.a")
        ok(0<x<1024 and 0<y<768, f"{T} target hole on screen at {x:.0f},{y:.0f}")
        tap(x,y)
        w = pg.evaluate("() => window.__sim.canvas.getModel().connections.filter(c=>c[2]!=='plug')")
        ok(pend() is None and len(w)==1 and len(w[0])==4 and len(w[0][3])==1 and {w[0][0],w[0][1]}=={f"{esp}:D21",f"{bb}:T10.a"}, f"{T} wire made with bend: {w}")
        # 5) drag-from-pin to far edge auto-pans, release on empty space keeps wire, then cancel button
        pg.evaluate("() => { const c=window.__sim.canvas; c.zoom=0.8; c.pan={x:0,y:0}; c._applyView(); }")
        x,y = scr(f"{esp}:D22")
        p0 = pg.evaluate("window.__sim.canvas.pan.x")
        seq=[('pointerdown',x,y,1,None)]+[('pointermove',x+(1015-x)*i/10,y,1,'vp') for i in range(1,11)]
        ev(seq); pg.wait_for_timeout(600)
        p1 = pg.evaluate("window.__sim.canvas.pan.x")
        ok(p1 < p0-50, f"{T} edge auto-pan while dragging wire: pan.x {p0:.0f} -> {p1:.0f}")
        ev([('pointerup',600,400,1,'vp')]) if touch else (pg.mouse.move(600,400), pg.mouse.up())
        pg.wait_for_timeout(100)
        ok(pend() is not None and not pend()['dragging'], f"{T} release on empty keeps wire open: {pend()} wires={pg.evaluate('window.__sim.canvas.getModel().connections.filter(c=>c[2]!==`plug`).map(c=>c[0]+`-`+c[1])')} el={pg.evaluate('document.elementFromPoint(600,400)?.className')}")
        pg.click('#wireCancel') if not touch else pg.tap('#wireCancel')
        ok(pend() is None, f"{T} cancel button cancels")
        # 6) tidy + bends survive save/load
        pg.evaluate("() => window.__sim.canvas.tidyWires()")
        m = pg.evaluate("() => window.__sim.canvas.getModel()")
        pg.evaluate("async (m) => { await window.__sim.canvas.setModel(m); }", m)
        m2 = pg.evaluate("() => window.__sim.canvas.getModel().connections.filter(c=>c[2]!=='plug')")
        ok(len(m2)==1 and len(m2[0])==4 and len(m2[0][3])>=1, f"{T} tidy route survives save/load: {m2}")
        # 7) select wire -> handles + props buttons
        pg.evaluate("() => document.querySelector('.rail-btn[data-panel=props]').click()")
        pg.evaluate("() => { const c=window.__sim.canvas; c.select({kind:'wire', id:c.wires.find(w=>!w.plug).id}); }")
        pg.wait_for_timeout(100)
        nh = pg.evaluate("document.querySelectorAll('.wire-handles .wh').length")
        ok(nh>=2 and pg.locator('#tidyWire').count()==1, f"{T} handles shown ({nh}) and props buttons present")
        pg.evaluate("() => document.querySelector('#bendClear').click()")
        nb = pg.evaluate("() => window.__sim.canvas.wires.find(w=>!w.plug).pts.length")
        ok(nb==0, f"{T} 'Hapus belokan' clears bends")
        pg.evaluate("() => document.querySelector('#tidyWire').click()")
        nb = pg.evaluate("() => window.__sim.canvas.wires.find(w=>!w.plug).pts.length")
        ok(nb>=1, f"{T} 'Rapikan kabel ini' adds orthogonal route ({nb} bends)")
        pg.screenshot(path=f"/tmp/wire_{touch}.png")
        ctx.close()
    b.close()
print("fails", fails)
