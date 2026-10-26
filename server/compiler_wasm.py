"""Compile Arduino sketches for ESP32 / ESP8266 / RP2040 boards to WebAssembly for the browser simulator.

The sketch is linked against an Arduino-API runtime (esp32rt/) whose hardware calls are imported from the
simulator (GPIO, ADC, PWM, I2C devices, DHT, WiFi/HTTP through the browser, Bluetooth terminal...).
Returns {"wasm": base64|None, "stdout": str, "stderr": str} with errors mapped to sketch.ino line numbers.
"""
import base64, glob, hashlib, os, re, shutil, subprocess, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
import libmgr
from libmgr import USER_LIBS
from compiler import preprocess, _strip

HERE = os.path.dirname(os.path.abspath(__file__))
RT = os.path.join(HERE, "esp32rt")
WASI = os.environ.get("WASI_SDK", "/opt/wasi/wasi-sdk-25.0-x86_64-linux")
WASM_OPT = os.environ.get("WASM_OPT", "/opt/wasi/binaryen-version_123/bin/wasm-opt")
SRC = os.environ.get("ARDUINO_SRC", os.path.join(HERE, "arduino-src"))
CACHE = os.environ.get("BUILD_CACHE", os.path.join(HERE, ".cache"))
CXX = os.path.join(WASI, "bin", "clang++")
CC = os.path.join(WASI, "bin", "clang")
SYSROOT = os.path.join(WASI, "share", "wasi-sysroot")
TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "300"))
# parallel clang processes; set COMPILE_JOBS=1 on small (512 MB) free instances
JOBS = max(1, int(os.environ.get("COMPILE_JOBS", "0")) or (os.cpu_count() or 1))
BOARDS = {"esp32": ["-DESP32", "-DARDUINO_ARCH_ESP32", "-DARDUINO_ESP32_DEV", "-DSIM_BOARD_ESP32"],
          "esp8266": ["-DESP8266", "-DARDUINO_ARCH_ESP8266", "-DARDUINO_ESP8266_NODEMCU", "-DSIM_BOARD_ESP8266", "-I" + os.path.join(os.path.dirname(os.path.abspath(__file__)), "esp32rt", "shim8266")],
          "rp2040": ["-DARDUINO_ARCH_RP2040", "-DARDUINO_RASPBERRY_PI_PICO", "-DSIM_BOARD_RP2040"],
          "nanorp2040": ["-DARDUINO_ARCH_RP2040", "-DARDUINO_NANO_RP2040_CONNECT", "-DSIM_BOARD_NANORP2040"]}
COMMON = ["--target=wasm32-wasip1", "--sysroot=" + SYSROOT, "-O2", "-fno-exceptions", "-fno-rtti", "-D_WASI_EMULATED_SIGNAL",
          "-DARDUINO=10819", "-Wno-everything", "-ffunction-sections", "-fdata-sections"]
CXXFLAGS = ["-std=gnu++17", "-fno-threadsafe-statics"] + COMMON
INC = ["-I" + os.path.join(RT, "core"), "-I" + os.path.join(RT, "shim"), "-I" + os.path.join(RT, "ArduinoJson", "src")]
# real third-party libraries compiled for the simulator (header -> source dir)
LIBS = {
    "MQ135.h": os.path.join(SRC, "MQ135"),
    "MQUnifiedsensor.h": os.path.join(SRC, "MQSensorsLib", "src"),
    "VL53L0X.h": os.path.join(SRC, "vl53l0x-arduino"),
    "Adafruit_VL53L0X.h": os.path.join(SRC, "Adafruit_VL53L0X", "src"),
    "TFMPlus.h": os.path.join(SRC, "TFMini-Plus", "src"),
    "IBusBM.h": os.path.join(SRC, "IBusBM", "src"),
    "Adafruit_MPU6050.h": os.path.join(SRC, "Adafruit_MPU6050"),
    "MPU6050_light.h": os.path.join(SRC, "MPU6050_light", "src"),
    "LiquidCrystal_I2C.h": os.path.join(SRC, "LiquidCrystal_I2C"),
    "Adafruit_GFX.h": os.path.join(SRC, "Adafruit-GFX-Library"),
    "Adafruit_SSD1306.h": os.path.join(SRC, "Adafruit_SSD1306"),
    "Adafruit_I2CDevice.h": os.path.join(SRC, "Adafruit_BusIO"),
    "Adafruit_SPIDevice.h": os.path.join(SRC, "Adafruit_BusIO"),
    "Adafruit_BusIO_Register.h": os.path.join(SRC, "Adafruit_BusIO"),
    "RTClib.h": os.path.join(SRC, "RTClib"),
    "LiquidCrystal.h": os.path.join(SRC, "LiquidCrystal"),
    "OneWire.h": os.path.join(RT, "OneWire"),              # OneWire with the portable pinMode/digitalRead fallback (no ESP32 register access in wasm)
    "DallasTemperature.h": os.path.join(SRC, "Arduino-Temperature-Control-Library"),
    "TM1637Display.h": os.path.join(SRC, "TM1637"),
    "HX711.h": os.path.join(SRC, "HX711", "src"),
    "Adafruit_Sensor.h": os.path.join(SRC, "Adafruit_Sensor"),
    "Adafruit_BMP280.h": os.path.join(SRC, "Adafruit_BMP280_Library"),
    "Adafruit_BME280.h": os.path.join(SRC, "Adafruit_BME280_Library"),
    "MAX30105.h": os.path.join(SRC, "SparkFun_MAX3010x_Sensor_Library", "src"),
    "LedControl.h": os.path.join(SRC, "LedControl", "src"),
    "MD_MAX72xx.h": os.path.join(SRC, "MD_MAX72XX", "src"),
    "MD_Parola.h": os.path.join(SRC, "MD_Parola", "src"),
    "Adafruit_ILI9341.h": os.path.join(SRC, "Adafruit_ILI9341"),
    "MFRC522.h": os.path.join(SRC, "rfid", "src"),
    "RF24.h": os.path.join(SRC, "RF24"),
    "LoRa.h": os.path.join(SRC, "arduino-LoRa", "src"),
    "TinyGPS++.h": os.path.join(SRC, "TinyGPSPlus", "src"),
    "TinyGPSPlus.h": os.path.join(SRC, "TinyGPSPlus", "src"),
    "SD.h": os.path.join(RT, "SD"),                       # Arduino SD with the generic pin map + ESP32 API extras
}
DEPS = {"Adafruit_MPU6050.h": ["Adafruit_Sensor.h", "Adafruit_I2CDevice.h"], "Adafruit_GFX.h": ["Adafruit_I2CDevice.h"], "Adafruit_SSD1306.h": ["Adafruit_GFX.h", "Adafruit_I2CDevice.h"], "RTClib.h": ["Adafruit_I2CDevice.h"], "DallasTemperature.h": ["OneWire.h"], "MD_Parola.h": ["MD_MAX72xx.h"], "Adafruit_ILI9341.h": ["Adafruit_GFX.h", "Adafruit_I2CDevice.h"], "Adafruit_BMP280.h": ["Adafruit_Sensor.h", "Adafruit_I2CDevice.h"], "Adafruit_BME280.h": ["Adafruit_Sensor.h", "Adafruit_I2CDevice.h"]}
ASYNC_IMPORTS = "ard.delay_us,ard.yield_,ard.http,ard.net_open,ard.net_dns"
_lock = threading.RLock()


def _run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    return p.returncode, p.stdout, p.stderr


_SIG = None


def _rt_sig():
    """fingerprint of every runtime source/header, so cached objects are rebuilt when the runtime changes"""
    global _SIG
    if _SIG is None:
        h = hashlib.md5()
        for f in sorted(x for d in ("core", "shim", "shim8266") for x in glob.glob(os.path.join(RT, d, "**"), recursive=True) if os.path.isfile(x)):
            h.update(os.path.relpath(f, RT).encode()); h.update(open(f, "rb").read())
        _SIG = h.hexdigest()[:8]
    return _SIG


def _stable(text):
    """cache keys must not depend on where the toolchain / sources live (build machine vs. serverless runtime)"""
    for root, tok in ((RT, "<rt>"), (SRC, "<src>"), (WASI, "<wasi>"), (HERE, "<here>")):
        text = text.replace(root, tok)
    return text


def _fsig(path):
    """content fingerprint of a source file (mtimes change when files are copied)"""
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


class Pending(Exception):
    """the time budget of this request ran out; finished objects stay cached, the client asks again"""


DEADLINE = None   # set per request by a serverless host (seconds since epoch)


def _compile_one(s, o, flags):
    if DEADLINE and time.time() > DEADLINE:
        raise Pending()
    rc, so, se = _run([CXX if s.endswith((".cpp", ".cc", ".cxx")) else CC, "-c"] + (CXXFLAGS if s.endswith((".cpp", ".cc", ".cxx")) else COMMON) + flags + ["-o", o + ".tmp", s])
    if rc != 0:
        raise RuntimeError(se or so)
    os.replace(o + ".tmp", o)


def _objs(srcs, outdir, flags):
    """compile (in parallel) every source not already in the object cache"""
    os.makedirs(outdir, exist_ok=True); out, todo = [], []
    for s in srcs:
        o = os.path.join(outdir, hashlib.md5((_stable(" ".join(flags)) + _rt_sig() + _fsig(s)).encode()).hexdigest()[:12] + "_" + os.path.basename(s) + ".o")
        out.append(o)
        if not os.path.exists(o):
            todo.append((s, o))
    if todo:
        with ThreadPoolExecutor(max_workers=JOBS) as ex:
            for f in [ex.submit(_compile_one, s, o, flags) for s, o in todo]:
                f.result()
    return out


def runtime_objs(board):
    srcs = sorted(glob.glob(os.path.join(RT, "core", "*.cpp")) + glob.glob(os.path.join(RT, "shim", "*.cpp")))
    return _objs(srcs, os.path.join(CACHE, "wasm_rt_" + board), BOARDS[board] + INC)


# headers that come from the simulator runtime, the C/C++ library, or ESP-IDF internals we do not emulate
_SYS_DIRS = None
def _system_header(h):
    global _SYS_DIRS
    if _SYS_DIRS is None:
        _SYS_DIRS = [os.path.join(RT, "core"), os.path.join(RT, "shim"), os.path.join(RT, "shim8266"), os.path.join(RT, "ArduinoJson", "src"),
                     os.path.join(SYSROOT, "include", "wasm32-wasip1"), os.path.join(SYSROOT, "include")] + glob.glob(os.path.join(WASI, "lib", "clang", "*", "include"))
    return any(os.path.exists(os.path.join(d, h)) for d in _SYS_DIRS)
_NO_INDEX = re.compile(r"^(freertos/|esp_|driver/|soc/|hal/|rom/|sdkconfig|avr/|util/|lwip/|mbedtls/|nvs|sys/|Arduino\.h$|pins_arduino|.*/)")


class MissingHeader(Exception):
    pass


_MISSING = re.compile(r"fatal error: '([^']+)' file not found")


def _find_lib(h, board, chosen, notes):
    """library that provides header h, or None (system / unsupported)"""
    if h in LIBS:
        return libmgr.describe(LIBS[h])
    if _NO_INDEX.match(h):
        return None
    try:
        lib = libmgr.index_lib(h, board)
    except Exception as e:
        notes.append("library untuk <%s> gagal diunduh: %s" % (h, e)); return None
    if lib:
        notes.append("Library Manager: %s %s untuk <%s>" % (lib["name"], lib.get("version", ""), h))
    return lib


_SIM_HEADERS = None


def sim_headers():
    """headers the simulator runtime provides itself (core, shims, ported libraries such as OneWire / SD)"""
    global _SIM_HEADERS
    if _SIM_HEADERS is None:
        hs = {os.path.basename(f) for d in ("core", "shim") for f in glob.glob(os.path.join(RT, d, "*.h*"))}
        hs |= {h for h, path in LIBS.items() if os.path.abspath(path).startswith(os.path.abspath(RT))}
        _SIM_HEADERS = hs
    return _SIM_HEADERS


def resolve_libs(sketch_cpp, board, user_shas=()):
    """Like arduino-cli: preprocess the sketch; for every '#include' that is not found, add the library that
    provides it and try again. Returns (libraries, notes)."""
    chosen, notes, tried = [], [], set()
    for sha in user_shas:
        lib = libmgr.user_lib(sha)
        clash = sorted(h for h in lib.get("headers", []) if "/" not in h and h in sim_headers())
        if clash:      # e.g. OneWire-master.zip: its ESP32 register code cannot run in WebAssembly; the bundled port is used
            notes.append("Library %s dari zip tidak dipakai: simulator sudah menyediakan <%s> versi yang kompatibel." % (lib["name"], ">, <".join(clash)))
            continue
        chosen.append(lib)
    for _ in range(40):
        incs = list(INC) + ["-I" + d for l in chosen for d in l["inc"]]
        rc, so, se = _run([CXX, "-E", "-o", os.devnull] + CXXFLAGS + BOARDS[board] + incs + [sketch_cpp])
        m = _MISSING.search(se or "")
        if rc == 0 or not m:
            break
        h = m.group(1)
        if h in tried:
            break
        tried.add(h)
        lib = _find_lib(h, board, chosen, notes)
        if not lib or any(l["root"] == lib["root"] for l in chosen):
            break
        chosen.append(lib)
    return chosen, notes


def compile_sketch_wasm(sketch, board="esp32", user_libs=()):
    if board not in BOARDS:
        return {"wasm": None, "stdout": "", "stderr": f"sketch.ino:1:1: error: board '{board}' tidak dikenal"}
    if not sketch or not sketch.strip():
        return {"wasm": None, "stdout": "", "stderr": "sketch.ino:1:1: error: sketch is empty"}
    work = tempfile.mkdtemp(prefix="wsk_")
    try:
        body, _ = preprocess(sketch)
        cpp = os.path.join(work, "sketch.cpp"); open(cpp, "w").write(body)
        with _lock:
            rt = runtime_objs(board)
            try:
                libs, notes = resolve_libs(cpp, board, user_libs)
            except FileNotFoundError as e:
                return {"wasm": None, "stdout": "", "stderr": "sketch.ino:1:1: error: " + str(e), "missing_libs": True}
            # each library is compiled against its OWN include closure (its dirs + libraries it needs), so the
            # object cache is shared by every sketch that uses it, whatever other libraries the sketch includes
            lib_o, i = [], 0
            while i < len(libs):
                l = libs[i]; i += 1
                deps = []
                for _ in range(20):
                    lincs = list(INC) + ["-I" + d for d in l["inc"]] + ["-I" + d for dl in deps for d in dl["inc"]]
                    key = hashlib.md5(_stable(l["root"] + "|" + " ".join(lincs)).encode()).hexdigest()[:10]
                    try:
                        lib_o += _objs(l["srcs"], os.path.join(CACHE, "wasm_lib_" + board, re.sub(r"\W", "_", l["name"])[:40] + "_" + key), BOARDS[board] + lincs)
                        break
                    except RuntimeError as e:
                        m = _MISSING.search(str(e)); h = m.group(1) if m else None
                        prov = None
                        if h:
                            prov = next((x for x in libs if h in x["headers"] or os.path.basename(h) in {os.path.basename(y) for y in x["headers"]}), None) or _find_lib(h, board, libs, notes)
                        if not prov or any(d["root"] == prov["root"] for d in deps) or prov["root"] == l["root"]:
                            return {"wasm": None, "stdout": "\n".join(notes), "stderr": "Library %s gagal dikompilasi untuk simulator:\n%s" % (l["name"], _fix(str(e), work)[:4000])}
                        deps.append(prov)
                        if not any(x["root"] == prov["root"] for x in libs):
                            libs.append(prov)
            incs = list(INC) + ["-I" + d for l in libs for d in l["inc"]]
        obj = os.path.join(work, "sketch.o")
        rc, so, se = _run([CXX, "-c"] + CXXFLAGS + BOARDS[board] + incs + ["-o", obj, cpp], cwd=work)
        if rc != 0:
            return {"wasm": None, "stdout": "\n".join(notes), "stderr": _fix(se or so, work)}
        raw = os.path.join(work, "raw.wasm")
        rc, so, se = _run([CXX] + CXXFLAGS + ["-mexec-model=reactor", "-Wl,--gc-sections", "-Wl,-z,stack-size=262144", "-o", raw, obj] + lib_o + rt, cwd=work)
        if rc != 0:
            return {"wasm": None, "stdout": "\n".join(notes), "stderr": _fix(se or so, work)}
        # a library whose header and source disagree on a function signature links into a trap in WebAssembly
        mism = sorted(set(re.findall(r"function signature mismatch: (\S+)", se or "")))
        if mism:
            rc2, dem, _ = _run([os.path.join(WASI, "bin", "llvm-cxxfilt")] + mism)
            if rc2 == 0 and dem.strip():
                mism = [d.split("(")[0] for d in dem.strip().splitlines()]
        for fn in mism:
            notes.append("PERINGATAN: deklarasi dan definisi fungsi %s di library tidak cocok (bug library); program akan berhenti bila fungsi ini dipanggil. Perbarui library-nya (mis. ekspor ulang dari Edge Impulse)." % fn)
        final = os.path.join(work, "sketch.wasm")
        # --log-execution puts a call to ard.log_execution at every loop header: the host uses it as a watchdog so
        # a busy loop such as `for(;;);` can be suspended (page stays responsive) instead of freezing the browser.
        rc, so, se = _run([WASM_OPT, raw, "-O2", "--log-execution", "--asyncify", "--pass-arg=asyncify-imports@" + ASYNC_IMPORTS + ",ard.log_execution", "-O2", "-o", final])
        if rc != 0:
            return {"wasm": None, "stdout": "", "stderr": "wasm-opt: " + (se or so)}
        data = open(final, "rb").read()
        info = "\n".join(notes + ["Sketch (simulator %s) %d byte WebAssembly." % (board.upper(), len(data))])
        return {"wasm": base64.b64encode(data).decode(), "stdout": info, "stderr": ""}
    except Pending:
        return {"wasm": None, "pending": True, "stdout": "Mengompilasi library besar (dilanjutkan)…", "stderr": ""}
    except subprocess.TimeoutExpired:
        return {"wasm": None, "stdout": "", "stderr": "Compilation timed out"}
    except RuntimeError as e:
        return {"wasm": None, "stdout": "", "stderr": "Runtime/library build error: " + str(e)[:3000]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _fix(text, work):
    text = text.replace(work + "/", "")
    text = re.sub(r"[^\s:]*/sketch\.cpp", "sketch.ino", text)
    text = text.replace(RT + "/core/", "<Arduino>/").replace(RT + "/shim/", "<Arduino>/").replace(SRC + "/", "<libraries>/")
    text = text.replace(libmgr.LIB_DIR + "/", "<libraries>/").replace(libmgr.ULIB_DIR + "/", "<library-anda>/")
    text = re.sub(r"fatal error: '([^']+)' file not found", r"fatal error: '\1' file not found (library tidak ditemukan di Arduino Library Manager / belum didukung simulator)", text)
    # linker: undefined symbols -> friendly message
    text = re.sub(r"wasm-ld: error: [^:]*: undefined symbol: (\S+)", r"sketch.ino:1:1: error: fungsi/variabel '\1' tidak tersedia di simulator (library belum didukung)", text)
    return text.strip()


if __name__ == "__main__":
    import sys, json
    r = compile_sketch_wasm(open(sys.argv[1]).read(), sys.argv[2] if len(sys.argv) > 2 else "esp32")
    print(json.dumps({k: (v if k != "wasm" else len(v or "")) for k, v in r.items()}, indent=1))
