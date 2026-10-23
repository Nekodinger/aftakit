"""Vercel Function: Arduino compile service (same code as server/, no separate server needed).

  GET  /api/cc/health
  POST /api/cc/build        {"sketch"}                        -> {"hex", ...}   Arduino Uno / Nano (avr-gcc)
  POST /api/cc/build-wasm   {"sketch", "board", "libs": [sha]} -> {"wasm", ...}  ESP32 / ESP8266 / Pico
User libraries (.zip, e.g. Edge Impulse) are stored in Supabase Storage (bucket "libs", <sha256>.zip) by the browser
and fetched here by hash. Toolchains (avr-gcc, wasi-sdk, binaryen) and a warm object cache are prepared at build time
by scripts/vercel-build.sh. Long builds stop before the 300 s limit and answer {"pending": true}; the browser repeats
the request and compilation continues from the cache.
"""
import hashlib, json, os, shutil, sys, time, urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
TC, SERVER, CACHE = os.path.join(ROOT, "tc"), os.path.join(ROOT, "server"), "/tmp/cache"
os.environ.update({
    "BUILD_CACHE": CACHE, "USER_LIBS": os.path.join(CACHE, "user-libs"),
    "ARDUINO_SRC": os.path.join(SERVER, "arduino-src"),
    "WASI_SDK": os.path.join(TC, "wasi-sdk-25.0-x86_64-linux"),
    "WASM_OPT": os.path.join(TC, "binaryen", "bin", "wasm-opt"),
    "PATH": os.path.join(TC, "avr", "bin") + os.pathsep + os.environ.get("PATH", ""),
})
os.environ.setdefault("COMPILE_JOBS", "2")
# seed the writable cache with the objects compiled at build time (cores, runtime, popular libraries)
_pre = os.path.join(SERVER, "_cache")
if os.path.isdir(_pre) and not os.path.exists(os.path.join(CACHE, ".seeded")):
    shutil.copytree(_pre, CACHE, dirs_exist_ok=True)
    open(os.path.join(CACHE, ".seeded"), "w").close()
sys.path.insert(0, SERVER)
import compiler, compiler_wasm  # noqa: E402

BUDGET = 240  # seconds of compiling per request (Hobby functions stop at 300 s)
LIB_BASE = (os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL") or "").rstrip("/")


def fetch_lib(sha):
    """download a user library zip from Supabase Storage (content-addressed: <sha256>.zip) and verify it"""
    path = os.path.join(os.environ["USER_LIBS"], sha + ".zip")
    if os.path.exists(path):
        return
    if not LIB_BASE:
        raise RuntimeError("penyimpanan library belum diatur")
    with urllib.request.urlopen("%s/storage/v1/object/public/libs/%s.zip" % (LIB_BASE, sha), timeout=60) as r:
        data = r.read(64 << 20)
    if hashlib.sha256(data).hexdigest() != sha:
        raise RuntimeError("isi library tidak cocok dengan sha256")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers(); self.wfile.write(b)

    def _route(self):
        q = parse_qs(urlparse(self.path).query)
        return (q.get("p") or [urlparse(self.path).path.rsplit("/", 1)[-1]])[0].strip("/")

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        self._send(200, {"ok": True, "service": "arduino-compile (vercel)", "wasm": True, "gateway": True, "libs": bool(LIB_BASE),
                         "boards": ["uno", "nano", "esp32", "esp8266", "rp2040"], "toolchain": "avr-gcc + wasi-sdk"})

    def do_POST(self):
        route = self._route()
        if route not in ("build", "build-wasm"):
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > 300_000:
            return self._send(413, {"hex": None, "wasm": None, "stdout": "", "stderr": "Sketch terlalu besar"})
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"hex": None, "wasm": None, "stdout": "", "stderr": "Permintaan tidak valid"})
        try:
            if route == "build":
                return self._send(200, compiler.compile_sketch(str(data.get("sketch", ""))))
            libs = [str(x) for x in (data.get("libs") or []) if isinstance(x, str) and len(x) == 64][:8]
            for sha in libs:
                try:
                    fetch_lib(sha)
                except Exception as e:
                    return self._send(200, {"wasm": None, "stdout": "", "stderr": "sketch.ino:1:1: error: library %s… tidak bisa diambil: %s. Unggah ulang .zip-nya di panel Library." % (sha[:8], e)})
            compiler_wasm.DEADLINE = time.time() + BUDGET
            try:
                r = compiler_wasm.compile_sketch_wasm(str(data.get("sketch", "")), str(data.get("board", "esp32")), libs)
            finally:
                compiler_wasm.DEADLINE = None
            return self._send(200, r)
        except Exception as e:  # never leak a stack trace, but report clearly
            return self._send(500, {"hex": None, "wasm": None, "stdout": "", "stderr": "Server error: %s" % e})
