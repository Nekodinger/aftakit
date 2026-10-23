import json, sys, pathlib
from playwright.sync_api import sync_playwright
bundle = pathlib.Path("node_modules/@wokwi/elements/dist/wokwi-elements.bundle.js").resolve()
tags = sys.argv[1:]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args=["--no-sandbox"])
    pg = b.new_page()
    pg.set_content("<html><body></body></html>")
    pg.add_script_tag(path=str(bundle))
    res = pg.evaluate("""(tags) => { const out = {}; for (const t of tags) { const el = document.createElement(t); document.body.appendChild(el);
      let pins = []; try { pins = el.pinInfo.map(p => p.name + '@' + Math.round(p.x) + ',' + Math.round(p.y)); } catch(e) { pins = ['ERR ' + e.message]; }
      out[t] = {defined: !!customElements.get(t), pins}; } return out; }""", tags)
    for t, v in res.items():
        print(t, "defined" if v["defined"] else "UNDEFINED", len(v["pins"])); print("   ", " ".join(v["pins"]))
    b.close()
