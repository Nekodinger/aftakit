"""HTTP wrapper. POST /build {"sketch": "..."} -> {"hex","stdout","stderr"}   GET /health"""
import json, os, time, collections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from compiler import compile_sketch, core_objs

ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]
RATE = int(os.environ.get("RATE_PER_MIN", "30"))
hits = collections.defaultdict(list)


class H(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        allow = "*" if "*" in ORIGINS else (origin if origin in ORIGINS else ORIGINS[0])
        self.send_header("Access-Control-Allow-Origin", allow)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path in ("/", "/health"):
            return self._json(200, {"ok": True, "service": "avr-compile", "mcu": "atmega328p"})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/build":
            return self._json(404, {"error": "not found"})
        ip = self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        now = time.time(); hits[ip] = [t for t in hits[ip] if now - t < 60]
        if len(hits[ip]) >= RATE:
            return self._json(429, {"hex": None, "stdout": "", "stderr": "Terlalu banyak permintaan kompilasi, coba lagi sebentar."})
        hits[ip].append(now)
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 300_000:
                return self._json(413, {"hex": None, "stdout": "", "stderr": "Sketch terlalu besar"})
            data = json.loads(self.rfile.read(n) or b"{}")
            self._json(200, compile_sketch(str(data.get("sketch", ""))))
        except Exception as e:  # never leak a stack trace, but report clearly
            self._json(500, {"hex": None, "stdout": "", "stderr": "Server error: %s" % e})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    core_objs()  # warm the core cache so the first user compile is fast
    print("avr-compile listening on :%d" % port, flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
