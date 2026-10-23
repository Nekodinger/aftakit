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
}
# transitive library dependencies (header -> headers it needs)
DEPS = {
    "LiquidCrystal_I2C.h": ["Wire.h"],
    "Adafruit_GFX.h": ["Adafruit_I2CDevice.h", "SPI.h", "Wire.h"],
    "Adafruit_SSD1306.h": ["Adafruit_GFX.h", "Adafruit_I2CDevice.h", "SPI.h", "Wire.h"],
    "Adafruit_I2CDevice.h": ["Wire.h", "SPI.h"],
    "DHT.h": ["Adafruit_Sensor.h"],
    "RTClib.h": ["Adafruit_I2CDevice.h", "Wire.h", "SPI.h"],
}


def resolve_headers(found):
    out, todo = [], list(found)
    while todo:
        h = todo.pop(0)
        if h in out or h not in LIBS:
            continue
        out.append(h); todo += DEPS.get(h, [])
    return sorted(out)
MCU, FCPU = "atmega328p", "16000000L"
COMMON = ["-mmcu=" + MCU, "-DF_CPU=" + FCPU, "-DARDUINO=10819", "-DARDUINO_AVR_UNO",
          "-DARDUINO_ARCH_AVR", "-Os", "-w", "-ffunction-sections", "-fdata-sections",
          "-flto", "-g0"]
CFLAGS = ["-std=gnu11", "-fno-fat-lto-objects"] + COMMON
CXXFLAGS = ["-std=gnu++11", "-fpermissive", "-fno-exceptions", "-fno-threadsafe-statics",
            "-Wno-error=narrowing", "-fno-fat-lto-objects"] + COMMON
INC = ["-I" + CORE_DIR, "-I" + VARIANT]
_lock = threading.Lock()
TIMEOUT = int(os.environ.get("COMPILE_TIMEOUT", "60"))


def _run(cmd, cwd=None):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    return p.returncode, p.stdout, p.stderr


def _compile_obj(src, obj, extra_inc):
    cxx = src.endswith((".cpp", ".cc"))
    if src.endswith(".S"):
        cmd = ["avr-gcc", "-c", "-x", "assembler-with-cpp", "-mmcu=" + MCU, "-DF_CPU=" + FCPU] + INC + extra_inc + ["-o", obj, src]
    else:
        cmd = ["avr-g++" if cxx else "avr-gcc", "-c"] + (CXXFLAGS if cxx else CFLAGS) + INC + extra_inc + ["-o", obj, src]
    rc, out, err = _run(cmd)
    if rc != 0:
        raise RuntimeError(err or out)


def _build_dir_objs(srcs, outdir, extra_inc):
    os.makedirs(outdir, exist_ok=True)
    objs = []
    for s in srcs:
        o = os.path.join(outdir, hashlib.md5(os.path.relpath(s, SRC).encode()).hexdigest()[:10] + "_" + os.path.basename(s) + ".o")  # stable across machines
        if not os.path.exists(o):
            _compile_obj(s, o, extra_inc)
        objs.append(o)
    return objs


def core_objs():
    srcs = sorted(glob.glob(CORE_DIR + "/*.c") + glob.glob(CORE_DIR + "/*.cpp") + glob.glob(CORE_DIR + "/*.S"))
    return _build_dir_objs(srcs, os.path.join(CACHE, "core"), [])


def _lib_srcs(header):
    root = LIBS[header]
    srcs = sorted(glob.glob(root + "/**/*.c", recursive=True) + glob.glob(root + "/**/*.cpp", recursive=True))
    # keep AVR-relevant sources only
    srcs = [s for s in srcs if not re.search(r"/(sam|samd|nrf52|megaavr|esp|stm32|mbed|apollo3|renesas|pic32|rp2040|teensy)/", s.lower())]
    return [s for s in srcs if "/examples/" not in s and "/fontconvert/" not in s]


def lib_incs(header):
    root = LIBS[header]
    incs = ["-I" + root] + sorted({"-I" + os.path.dirname(s) for s in _lib_srcs(header)})
    if header == "Wire.h":
        incs += ["-I" + os.path.join(root, "utility")]
    return incs


def lib_objs(header, all_incs):
    return _build_dir_objs(_lib_srcs(header), os.path.join(CACHE, "lib_" + header.replace(".h", "")), all_incs)


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


def compile_sketch(sketch):
    if not sketch or not sketch.strip():
        return {"hex": None, "stdout": "", "stderr": "sketch.ino:1:1: error: sketch is empty"}
    if len(sketch) > 200_000:
        return {"hex": None, "stdout": "", "stderr": "sketch.ino:1:1: error: sketch too large"}
    work = tempfile.mkdtemp(prefix="sk_")
    try:
        with _lock:   # serialize cache warming; user compile itself is fast
            objs = core_objs()
        headers = resolve_headers({m for m in re.findall(r'#\s*include\s*[<"]([\w./]+\.h)[>"]', sketch) if m in LIBS})
        extra_inc, lib_o = [], []
        for h in headers:
            extra_inc += [i for i in lib_incs(h) if i not in extra_inc]
        for h in headers:
            with _lock:
                lib_o += lib_objs(h, extra_inc)
        cpp = os.path.join(work, "sketch.cpp")
        body, _ = preprocess(sketch)
        open(cpp, "w").write(body)
        obj = os.path.join(work, "sketch.cpp.o")
        rc, out, err = _run(["avr-g++", "-c"] + CXXFLAGS + INC + extra_inc + ["-o", obj, cpp], cwd=work)
        if rc != 0:
            return {"hex": None, "stdout": out, "stderr": _fix_errors(err or out, work)}
        elf = os.path.join(work, "sketch.elf")
        rc, out2, err2 = _run(["avr-gcc", "-w", "-Os", "-g0", "-flto", "-fuse-linker-plugin", "-Wl,--gc-sections",
                               "-mmcu=" + MCU, "-o", elf, obj] + lib_o + objs + ["-lm"], cwd=work)
        if rc != 0:
            return {"hex": None, "stdout": out2, "stderr": _fix_errors(err2 or out2, work)}
        hexf = os.path.join(work, "sketch.hex")
        rc, _, err3 = _run(["avr-objcopy", "-O", "ihex", "-R", ".eeprom", elf, hexf])
        if rc != 0:
            return {"hex": None, "stdout": "", "stderr": err3}
        _, size_out, _ = _run(["avr-size", "-A", elf])
        used = sum(int(x) for x in re.findall(r"^\.(?:text|data)\s+(\d+)", size_out, re.M))
        ram = sum(int(x) for x in re.findall(r"^\.(?:data|bss)\s+(\d+)", size_out, re.M))
        info = "Sketch uses %d bytes (%d%%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use %d bytes (%d%%) of dynamic memory. Maximum is 2048 bytes." % (
            used, used * 100 // 32256, ram, ram * 100 // 2048)
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
