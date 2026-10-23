import json, pathlib, sys
from playwright.sync_api import sync_playwright
bundle = pathlib.Path("node_modules/@wokwi/elements/dist/wokwi-elements.bundle.js").resolve()
tags = sys.argv[1:]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", args=["--no-sandbox"])
    pg = b.new_page(); pg.set_content("<html><body></body></html>"); pg.add_script_tag(path=str(bundle))
    res = pg.evaluate("""async (tags) => { const out = {}; for (const t of tags) { const el = document.createElement(t); el.style.position='absolute'; document.body.appendChild(el); await el.updateComplete; const r = el.getBoundingClientRect(); out[t] = [Math.round(r.width), Math.round(r.height)]; } return out; }""", tags)
    print(json.dumps(res))
    props = pg.evaluate("""() => { const el = document.createElement('wokwi-arduino-uno'); return Object.keys(el).filter(k=>!k.startsWith('_')).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(el))).join(' ') }""")
    print(props)
    b.close()
