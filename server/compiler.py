"""Arduino (AVR / ATmega328P) sketch compiler. Pure stdlib + avr-gcc.

Contract (compatible with Wokwi's hexi /build):
    compile_sketch(sketch:str) -> {"hex": str|None, "stdout": str, "stderr": str}
Errors reference the user's own line numbers via #line directives.
"""
import hashlib, os, re, shutil, subprocess, tempfile, threading, glob

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("ARDUINO_SRC", os.path.join(HERE, "arduino-src"))   # contains ArduinoCore-avr + libs
CACHE = os.environ.get("BUILD_CACHE", os.path.join(HERE, ".cache"))
CORE = os.path.join(SRC, "ArduinoCore-avr")
VARIANT = os.path.join(CORE, "variants", "standard")
CORE_DIR = os.path.join(CORE, "cores", "arduino")

# library header -> library source root (dirs added to include path)
LIBS = {
    "Servo.h": os.path.join(SRC, "Servo", "src"),
    "LiquidCrystal.h": os.path.join(SRC, "LiquidCrystal", "src"),
    "Adafruit_NeoPixel.h": os.path.join(SRC, "Adafruit_NeoPixel"),
    "Wire.h": os.path.join(CORE, "libraries", "Wire", "src"),
    "SPI.h": os.path.join(CORE, "libraries", "SPI", "src"),
    "EEPROM.h": os.path.join(CORE, "libraries", "EEPROM", "src"),
    "SoftwareSerial.h": os.path.join(CORE, "libraries", "SoftwareSerial", "src"),
    "LiquidCrystal_I2C.h": os.path.join(SRC, "LiquidCrystal_I2C"),
    "Adafruit_GFX.h": os.path.join(SRC, "Adafruit-GFX-Library"),
    "Adafruit_SSD1306.h": os.path.join(SRC, "Adafruit_SSD1306"),
    "Adafruit_I2CDevice.h": os.path.join(SRC, "Adafruit_BusIO"),
    "DHT.h": os.path.join(SRC, "DHT-sensor-library"),
    "Adafruit_Sensor.h": os.path.join(SRC, "Adafruit_Sensor"),
    "RTClib.h": os.path.join(SRC, "RTClib", "src"),
    "OneWire.h": os.path.join(SRC, "OneWire"),
    "DallasTemperature.h": os.path.join(SRC, "Arduino-Temperature-Control-Library"),
    "TM1637Display.h": os.path.join(SRC, "TM1637"),
    "HX711.h": os.path.join(SRC, "HX711", "src"),
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
    "IRremote.hpp": os.path.join(SRC, "Arduino-IRremote", "src"),      # header-only (v4)
    "IRremote.h": os.path.join(SRC, "Arduino-IRremote", "src"),
    "SD.h": os.path.join(SRC, "SD", "src"),
}
# transitive library dependencies (header -> headers it needs)
DEPS = {
    "LiquidCrystal_I2C.h": ["Wire.h"],
    "Adafruit_GFX.h": ["Adafruit_I2CDevice.h", "SPI.h", "Wire.h"],
    "Adafruit_SSD1306.h": ["Adafruit_GFX.h", "Adafruit_I2CDevice.h", "SPI.h", "Wire.h"],
    "Adafruit_I2CDevice.h": ["Wire.h", "SPI.h"],
    "DHT.h": ["Adafruit_Sensor.h"],
    "RTClib.h": ["Adafruit_I2CDevice.h", "Wire.h", "SPI.h"],
    "DallasTemperature.h": ["OneWire.h"],
    "Adafruit_BMP280.h": ["Adafruit_Sensor.h", "Adafruit_I2CDevice.h", "Wire.h", "SPI.h"],
    "Adafruit_BME280.h": ["Adafruit_Sensor.h", "Adafruit_I2CDevice.h", "Wire.h", "SPI.h"],
    "MAX30105.h": ["Wire.h"],
    "MD_Parola.h": ["MD_MAX72xx.h", "SPI.h"], "Adafruit_ILI9341.h": ["Adafruit_GFX.h", "Adafruit_I2CDevice.h", "SPI.h", "Wire.h"], "MD_MAX72xx.h": ["SPI.h"], "SD.h": ["SPI.h"], "MFRC522.h": ["SPI.h"], "RF24.h": ["SPI.h"], "LoRa.h": ["SPI.h"],
}


def resolve_headers(found, libs=None):
    libs = libs or LIBS
    out, todo = [], list(found)
    while todo:
        h = todo.pop(0)
        if h in out or h not in libs:
            continue
        out.append(h); todo += DEPS.get(h, [])
    return sorted(out)
FCPU = "16000000L"
# AVR boards: -mmcu, Arduino variant folder, board macro, flash / RAM available to sketches
PROFILES = {
    "uno": {"mcu": "atmega328p", "variant": "standard", "board": "ARDUINO_AVR_UNO", "flash": 32256, "ram": 2048},
    "mega": {"mcu": "atmega2560", "variant": "mega", "board": "ARDUINO_AVR_MEGA2560", "flash": 253952, "ram": 8192},
}
TINY = os.path.join(SRC, "ATTinyCore", "avr")
TINY_LIBS = os.path.join(TINY, "libraries")
PROFILES["attiny85"] = {"mcu": "attiny85", "board": "AVR_ATTINYX5", "flash": 8192, "ram": 512,
                        "core": os.path.join(TINY, "cores", "tiny"), "variant_dir": os.path.join(TINY, "variants", "tinyx5"),
                        # ATTinyCore: 16 MHz PLL clock, software Serial (TX = PB0, RX = PB1), USI Wire / SPI
                        "defs": ["-DCLOCK_SOURCE=6", "-DATTINYCORE=\"1.5.2\"", "-DATTINYCORE_MAJOR=1UL", "-DATTINYCORE_MINOR=5UL", "-DATTINYCORE_PATCH=2UL", "-DATTINYCORE_RELEASED=1"],
                        "libs": {"Wire.h": os.path.join(TINY_LIBS, "Wire", "src"), "SPI.h": os.path.join(TINY_LIBS, "SPI"),
                                 "SoftwareSerial.h": os.path.join(TINY_LIBS, "SoftwareSerial"), "EEPROM.h": os.path.join(TINY_LIBS, "EEPROM"),
                                 "Servo.h": os.path.join(TINY_LIBS, "Servo", "src"), "tinyNeoPixel.h": os.path.join(TINY_LIBS, "tinyNeoPixel", "src"),
                                 "tinyNeoPixel_Static.h": os.path.join(TINY_LIBS, "tinyNeoPixel_Static", "src")}}
PROFILES["nano"] = PROFILES["uno"]
MCU = PROFILES["uno"]["mcu"]


def _flags(prof):
    common = ["-mmcu=" + prof["mcu"], "-DF_CPU=" + FCPU, "-DARDUINO=10819", "-D" + prof["board"],
              "-DARDUINO_ARCH_AVR", "-Os", "-w", "-ffunction-sections", "-fdata-sections", "-flto", "-g0"] + prof.get("defs", [])
    cflags = ["-std=gnu11", "-fno-fat-lto-objects"] + common
    cxxflags = ["-std=gnu++11", "-fpermissive", "-fno-exceptions", "-fno-threadsafe-statics",
                "-Wno-error=narrowing", "-fno-fat-lto-objects"] + common
    inc = ["-I" + prof.get("core", CORE_DIR), "-I" + prof.get("variant_dir") if prof.get("variant_dir") else "-I" + os.path.join(CORE, "variants", prof["variant"])]
    return cflags, cxxflags, inc


CFLAGS, CXXFLAGS, INC = _flags(PROFILES["uno"])
_lock = threading.Lock()
TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "60"))


def _run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    return p.returncode, p.stdout, p.stderr


def _compile_obj(src, obj, extra_inc, prof=None):
    prof = prof or PROFILES["uno"]
    cflags, cxxflags, inc = _flags(prof)
    cxx = src.endswith((".cpp", ".cc"))
    if src.endswith(".S"):
        cmd = ["avr-gcc", "-c", "-x", "assembler-with-cpp", "-mmcu=" + prof["mcu"], "-DF_CPU=" + FCPU] + inc + extra_inc + ["-o", obj, src]
    else:
        cmd = ["avr-g++" if cxx else "avr-gcc", "-c"] + (cxxflags if cxx else cflags) + inc + extra_inc + ["-o", obj, src]
    rc, out, err = _run(cmd)
    if rc != 0:
        raise RuntimeError(err or out)


def _build_dir_objs(srcs, outdir, extra_inc, prof=None):
    os.makedirs(outdir, exist_ok=True)
    objs = []
    for s in srcs:
        o = os.path.join(outdir, hashlib.md5(os.path.relpath(s, SRC).encode()).hexdigest()[:10] + "_" + os.path.basename(s) + ".o")  # stable across machines
        if not os.path.exists(o):
            _compile_obj(s, o, extra_inc, prof)
        objs.append(o)
    return objs


def _tag(prof):
    return "" if prof is None or prof["mcu"] == "atmega328p" else "_" + prof["mcu"]   # Uno caches keep their old names


def core_objs(prof=None):
    cd = (prof or {}).get("core", CORE_DIR)
    srcs = sorted(glob.glob(cd + "/*.c") + glob.glob(cd + "/*.cpp") + glob.glob(cd + "/*.S"))
    return _build_dir_objs(srcs, os.path.join(CACHE, "core" + _tag(prof)), [], prof)


def _lib_srcs(header, libs=None):
    root = (libs or LIBS)[header]
    srcs = sorted(glob.glob(root + "/**/*.c", recursive=True) + glob.glob(root + "/**/*.cpp", recursive=True))
    # keep AVR-relevant sources only
    srcs = [s for s in srcs if not re.search(r"/(sam|samd|nrf52|megaavr|esp|stm32|mbed|apollo3|renesas|pic32|rp2040|teensy)/", s.lower())]
    return [s for s in srcs if not re.search(r"/(examples|fontconvert|test|tests|docs|extras|pyRF24|examples_linux|examples_pico)/|/utility/(RPi|SPIDEV|MRAA|wiringPi|pigpio|rp2|LittleWire|ATXMegaD3|Teensy|ATTiny|Template)/", s)]


def lib_incs(header, libs=None):
    root = (libs or LIBS)[header]
    incs = ["-I" + root] + sorted({"-I" + os.path.dirname(s) for s in _lib_srcs(header, libs)})
    if header == "Wire.h":
        incs += ["-I" + os.path.join(root, "utility")]
    return incs


def lib_objs(header, all_incs, prof=None, libs=None):
    return _build_dir_objs(_lib_srcs(header, libs), os.path.join(CACHE, "lib_" + header.replace(".h", "") + _tag(prof)), all_incs, prof)


_DECL = re.compile(r"^[ \t]*((?:(?:static|inline|const|unsigned|signed|volatile|extern)\s+)*[A-Za-z_][\w:<>]*(?:\s*[\*&]+\s*|\s+)(?:[\*&]\s*)*)([A-Za-z_]\w*)\s*\(([^;{}()]*(?:\([^()]*\)[^;{}()]*)*)\)\s*\{", re.M)
_SKIP = {"if", "for", "while", "switch", "return", "else", "do", "sizeof", "catch"}


def _strip(code):
    """blank out comments/strings (keeping newlines) for structural scanning"""
    out, i, n = [], 0, len(code)
    while i < n:
        c = code[i]
        if code.startswith("//", i):
            j = code.find("\n", i); j = n if j < 0 else j
            out.append(" " * (j - i)); i = j
        elif code.startswith("/*", i):
            j = code.find("*/", i + 2); j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", code[i:j])); i = j
        elif c in "\"'":
            j = i + 1
            while j < n and code[j] != c:
                j += 2 if code[j] == "\\" else 1
            out.append(re.sub(r"[^\n]", " ", code[i:j + 1])); i = j + 1
        else:
            out.append(c); i += 1
    return "".join(out)


def preprocess(sketch):
    """.ino -> .cpp : add Arduino.h, generate prototypes, keep user's line numbers."""
    clean = _strip(sketch)
    # top-level declarations only (brace depth 0)
    depth, protos = 0, []
    pos = 0
    for m in re.finditer(r"[{}]|" + _DECL.pattern, clean, re.M):
        if m.group(0) == "{":
            depth += 1; continue
        if m.group(0) == "}":
            depth -= 1; continue
        # a decl match consumed its own "{": account for it after test
        if depth == 0 and m.lastindex:
            name = m.group(2)
            if name not in _SKIP and not re.match(r"\s*(struct|class|enum|union|namespace|typedef)\b", m.group(0)):
                protos.append(re.sub(r"\s+", " ", m.group(1)).strip() + " " + name + "(" + re.sub(r"\s+", " ", m.group(3)).strip() + ");")
        depth += 1  # the "{" that ended the declaration
    # insert prototypes before first non-preprocessor, non-comment code line
    lines = sketch.split("\n")
    stripped = _strip(sketch).split("\n")
    ins = 0
    for i, ln in enumerate(stripped):
        t = ln.strip()
        if t and not t.startswith("#"):
            ins = i; break
        ins = i + 1
    head = "\n".join(lines[:ins])
    tail = "\n".join(lines[ins:])
    return ('#include <Arduino.h>\n' + head + "\n" + "\n".join(dict.fromkeys(protos)) + '\n#line %d "sketch.ino"\n' % (ins + 1) + tail + "\n"), \
           '#line 1 "sketch.ino"\n'


def _fix_errors(text, workdir):
    text = text.replace(workdir + "/", "")
    text = re.sub(r"[^\s:]*/sketch\.cpp", "sketch.ino", text)
    return text.strip()


def compile_sketch(sketch, board="uno"):
    prof = PROFILES.get(str(board or "uno").lower(), PROFILES["uno"])
    _, cxxflags, inc = _flags(prof)
    if not sketch or not sketch.strip():
        return {"hex": None, "stdout": "", "stderr": "sketch.ino:1:1: error: sketch is empty"}
    if len(sketch) > 200_000:
        return {"hex": None, "stdout": "", "stderr": "sketch.ino:1:1: error: sketch too large"}
    work = tempfile.mkdtemp(prefix="sk_")
    try:
        with _lock:   # serialize cache warming; user compile itself is fast
            objs = core_objs(prof)
        libs = dict(LIBS, **prof.get("libs", {}))
        headers = resolve_headers({m for m in re.findall(r'#\s*include\s*[<"]([\w./+-]+\.(?:h|hpp))[>"]', sketch) if m in libs}, libs)
        extra_inc, lib_o = [], []
        for h in headers:
            extra_inc += [i for i in lib_incs(h, libs) if i not in extra_inc]
        for h in headers:
            with _lock:
                lib_o += lib_objs(h, extra_inc, prof, libs)
        cpp = os.path.join(work, "sketch.cpp")
        body, _ = preprocess(sketch)
        open(cpp, "w").write(body)
        obj = os.path.join(work, "sketch.cpp.o")
        rc, out, err = _run(["avr-g++", "-c"] + cxxflags + inc + extra_inc + ["-o", obj, cpp], cwd=work)
        if rc != 0:
            return {"hex": None, "stdout": out, "stderr": _fix_errors(err or out, work)}
        elf = os.path.join(work, "sketch.elf")
        rc, out2, err2 = _run(["avr-gcc", "-w", "-Os", "-g0", "-flto", "-fuse-linker-plugin", "-Wl,--gc-sections",
                               "-mmcu=" + prof["mcu"], "-o", elf, obj] + lib_o + objs + ["-lm"], cwd=work)
        if rc != 0:
            return {"hex": None, "stdout": out2, "stderr": _fix_errors(err2 or out2, work)}
        hexf = os.path.join(work, "sketch.hex")
        rc, _, err3 = _run(["avr-objcopy", "-O", "ihex", "-R", ".eeprom", elf, hexf])
        if rc != 0:
            return {"hex": None, "stdout": "", "stderr": err3}
        _, size_out, _ = _run(["avr-size", "-A", elf])
        used = sum(int(x) for x in re.findall(r"^\.(?:text|data)\s+(\d+)", size_out, re.M))
        ram = sum(int(x) for x in re.findall(r"^\.(?:data|bss)\s+(\d+)", size_out, re.M))
        fl, rm = prof["flash"], prof["ram"]
        if used > fl:
            return {"hex": None, "stdout": "", "stderr": "sketch.ino:1:1: error: Sketch too big: %d bytes (maximum %d bytes)" % (used, fl)}
        info = "Sketch uses %d bytes (%d%%) of program storage space. Maximum is %d bytes.\nGlobal variables use %d bytes (%d%%) of dynamic memory, leaving %d bytes for local variables. Maximum is %d bytes." % (
            used, used * 100 // fl, fl, ram, ram * 100 // rm, rm - ram, rm)
        if ram > rm * 0.9:
            info += "\nPERINGATAN: memori RAM hampir habis (%d%% terpakai); program bisa tidak stabil (stack bertabrakan dengan variabel)." % (ram * 100 // rm)
        return {"hex": open(hexf).read(), "stdout": info, "stderr": ""}
    except subprocess.TimeoutExpired:
        return {"hex": None, "stdout": "", "stderr": "Compilation timed out"}
    except RuntimeError as e:
        return {"hex": None, "stdout": "", "stderr": "Toolchain/core build error: " + str(e)[:2000]}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    import sys, json
    r = compile_sketch(open(sys.argv[1]).read())
    print(json.dumps({k: (v if k != "hex" else (v or "")[:60]) for k, v in r.items()}, indent=1))
