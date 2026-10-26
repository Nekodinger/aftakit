"""Compile the examples of every bundled library for the Uno (avr-gcc) and the ESP32 simulator (wasm) and report failures.
Usage: python3 scripts/lib_sweep.py [max_examples_per_lib] [lib-filter]
Run from the repo root with WASI_SDK / WASM_OPT set (as for the tests)."""
import glob, json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "server", "arduino-src")
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 3
FILT = sys.argv[2] if len(sys.argv) > 2 else ""
SKIP_LIBS = {"ArduinoCore-avr", "ATTinyCore"}
# example folders that need hardware the simulator does not model (other MCUs, Ethernet shields, ...)
SKIP_EX = re.compile(r"(?i)/(teensy|samd|stm32|nrf5|esp8266(?!wifi)|ethernet|gsm_?shield|wifi101|mkr|portenta|nano33|due|zero|leonardo|attiny|arduino_?yun|particle|rp2040|pico|linux|rpi|mbed|apollo|renesas|ble|webusb|wire_?less_?shield|cc3000|lilygo|m5stack|seeed|giga|uno_?r4|feather|esp_?now|async|ota|spiffs|littlefs|deepsleep|tests?)/")


def arch_ok(lib, arch):
    p = os.path.join(SRC, lib, "library.properties")
    if not os.path.exists(p):
        return True
    a = next((l.split("=", 1)[1] for l in open(p, errors="replace") if l.startswith("architectures")), "*").lower()
    return "*" in a or any(x.strip() in (arch, "esp32" if arch == "esp32" else "avr") for x in a.split(","))


def job(args):
    lib, ino, target = args
    code = open(ino, errors="replace").read()
    if target == "uno":
        py = "import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch; print(json.dumps(compile_sketch(sys.stdin.read())))"
    else:
        py = "import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm; r=compile_sketch_wasm(sys.stdin.read(),'esp32'); r['ok']=bool(r.pop('wasm', None)); print(json.dumps(r))"
    try:
        out = subprocess.run([sys.executable, "-c", py], input=code, capture_output=True, text=True, cwd=ROOT, timeout=600)
        r = json.loads(out.stdout or "{}")
    except Exception as e:
        return lib, ino, target, False, str(e)
    ok = bool(r.get("hex")) if target == "uno" else r.get("ok", False)
    return lib, ino, target, ok, (r.get("stderr") or r.get("error") or "")[:900]


def main():
    jobs = []
    for lib in sorted(os.listdir(SRC)):
        if lib in SKIP_LIBS or not os.path.isdir(os.path.join(SRC, lib)) or (FILT and FILT.lower() not in lib.lower()):
            continue
        exs = sorted(e for e in glob.glob(os.path.join(SRC, lib, "**", "examples", "**", "*.ino"), recursive=True) if not SKIP_EX.search(e.replace(SRC, "")))
        for target in ("uno", "esp32"):
            if not arch_ok(lib, "esp32" if target == "esp32" else "avr"):
                continue
            pick = [e for e in exs if target == "esp32" or not re.search(r"(?i)esp32|wifi|blynk|telegram|esp", os.path.relpath(e, SRC))][:MAX]
            jobs += [(lib, e, target) for e in pick]
    print(f"{len(jobs)} compiles", flush=True)
    fails = []
    with ThreadPoolExecutor(int(os.environ.get("JOBS", "6"))) as ex:
        for lib, ino, target, ok, err in ex.map(job, jobs):
            rel = os.path.relpath(ino, SRC)
            print(("ok   " if ok else "FAIL ") + f"{target:5} {rel}", flush=True)
            if not ok:
                fails.append({"lib": lib, "ex": rel, "target": target, "err": err})
    if fails:                                               # re-check failures one at a time (parallel cache warm-up races)
        again = []
        for f in fails:
            lib, ino, target, ok, err = job((f["lib"], os.path.join(SRC, f["ex"]), f["target"]))
            if not ok:
                again.append({"lib": lib, "ex": f["ex"], "target": target, "err": err})
        fails = again
    json.dump(fails, open("/tmp/lib_sweep.json", "w"), indent=1)
    print(f"\n{len(fails)} failures of {len(jobs)} (details: /tmp/lib_sweep.json)")


if __name__ == "__main__":
    main()
