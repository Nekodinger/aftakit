"""Compile server + IoT network gateway for the browser circuit simulator.

POST /build        {"sketch"}                         -> {"hex","stdout","stderr"}   Arduino Uno / Nano (avr-gcc)
POST /build-wasm   {"sketch","board","libs":[sha]}    -> {"wasm","stdout","stderr"}  ESP32 / ESP8266 / RP2040 (WebAssembly)
PUT  /lib/<sha256> (zip body)                         -> {"ok"}   user library (e.g. Edge Impulse export)
HEAD /lib/<sha256>                                    -> 200 if the server already has it
GET  /health
WS   /net          IoT gateway: the simulated board's WiFiClient / WiFiClientSecure / WiFiUDP become real
                   TCP / TLS / UDP connections (like Wokwi's public gateway: outgoing only, monitored limits).
"""
import asyncio, collections, hashlib, ipaddress, json, os, socket, ssl, struct, time
from aiohttp import web, WSMsgType
from compiler import compile_sketch, core_objs
try:
    from compiler_wasm import compile_sketch_wasm, runtime_objs, USER_LIBS
except Exception as e:  # toolchain not installed: AVR-only server
    print("wasm toolchain unavailable:", e, flush=True)
    compile_sketch_wasm = runtime_objs = None; USER_LIBS = None

ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]
RATE = int(os.environ.get("RATE_PER_MIN", "30"))
hits = collections.defaultdict(list)

# ---------------------------------------------------------------- gateway policy
TCP_PORTS = {80, 443, 1883, 8883, 8080, 8443, 8000, 8001, 8081, 8883, 9443, 5683}  # web, MQTT, Blynk, …
UDP_PORTS = {53, 123, 5683, 1900}                                                  # DNS, NTP, CoAP
MAX_SOCKS = 8            # per browser tab
MAX_WS_PER_IP = 6
IDLE_S = 180
MAX_BYTES = 20 << 20     # per tab (both directions)
ws_per_ip = collections.Counter()


def _cors(req, resp):
    origin = req.headers.get("Origin", "")
    resp.headers["Access-Control-Allow-Origin"] = "*" if "*" in ORIGINS else (origin if origin in ORIGINS else ORIGINS[0])
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, PUT, HEAD, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def _json(req, obj, status=200):
    return _cors(req, web.json_response(obj, status=status))


def _ip(req):
    return (req.headers.get("X-Forwarded-For") or req.remote or "?").split(",")[0].strip()


def _limited(req):
    ip, now = _ip(req), time.time()
    hits[ip] = [t for t in hits[ip] if now - t < 60]
    if len(hits[ip]) >= RATE:
        return True
    hits[ip].append(now)
    return False


async def options(req):
    return _cors(req, web.Response(status=204))


async def health(req):
    return _json(req, {"ok": True, "service": "arduino-compile", "wasm": bool(compile_sketch_wasm), "gateway": True,
                       "boards": ["uno", "nano"] + (["esp32", "esp8266", "rp2040"] if compile_sketch_wasm else []),
                       "toolchain": "avr-gcc" + (" + wasi-sdk" if compile_sketch_wasm else "")})


async def build(req):
    wasm = req.path == "/build-wasm"
    if wasm and not compile_sketch_wasm:
        return _json(req, {"wasm": None, "stdout": "", "stderr": "Server ini belum mendukung ESP32 (toolchain WebAssembly tidak terpasang)."}, 501)
    if _limited(req):
        return _json(req, {"hex": None, "stdout": "", "stderr": "Terlalu banyak permintaan kompilasi, coba lagi sebentar."}, 429)
    if (req.content_length or 0) > 300_000:
        return _json(req, {"hex": None, "stdout": "", "stderr": "Sketch terlalu besar"}, 413)
    try:
        data = await req.json()
    except Exception:
        return _json(req, {"hex": None, "stdout": "", "stderr": "Permintaan tidak valid"}, 400)
    loop = asyncio.get_running_loop()
    if wasm:
        libs = [str(x) for x in (data.get("libs") or []) if isinstance(x, str)][:8]
        fut = loop.run_in_executor(None, lambda: compile_sketch_wasm(str(data.get("sketch", "")), str(data.get("board", "esp32")), libs))
    else:
        fut = loop.run_in_executor(None, lambda: compile_sketch(str(data.get("sketch", ""))))
    try:
        # big libraries (Edge Impulse, TFLite) take minutes the first time: answer with a job id and let the
        # browser poll /job/<id> instead of hitting proxy timeouts
        r = await asyncio.wait_for(asyncio.shield(fut), 45)
        return _json(req, r)
    except asyncio.TimeoutError:
        jid = hashlib.sha1(os.urandom(16)).hexdigest()[:16]
        jobs[jid] = {"fut": fut, "t": time.time()}
        return _json(req, {"pending": True, "job": jid, "stdout": "Mengompilasi library besar (pertama kali bisa 1-3 menit)…", "stderr": ""})
    except Exception as e:  # never leak a stack trace, but report clearly
        return _json(req, {"hex": None, "wasm": None, "stdout": "", "stderr": "Server error: %s" % e}, 500)


jobs = {}


async def job(req):
    j = jobs.get(req.match_info["id"])
    for k in [k for k, v in jobs.items() if time.time() - v["t"] > 1800]:
        jobs.pop(k, None)
    if not j:
        return _json(req, {"pending": False, "wasm": None, "hex": None, "stdout": "", "stderr": "Pekerjaan kompilasi tidak ditemukan (server mungkin restart). Tekan Kompilasi lagi."}, 404)
    if not j["fut"].done():
        return _json(req, {"pending": True, "job": req.match_info["id"], "elapsed": round(time.time() - j["t"])})
    jobs.pop(req.match_info["id"], None)
    try:
        return _json(req, j["fut"].result())
    except Exception as e:
        return _json(req, {"hex": None, "wasm": None, "stdout": "", "stderr": "Server error: %s" % e}, 500)


async def lib(req):
    sha = req.match_info["sha"]
    if not USER_LIBS or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        return _json(req, {"ok": False, "error": "sha256 tidak valid"}, 400)
    path = os.path.join(USER_LIBS, sha + ".zip")
    if req.method == "HEAD":
        return _cors(req, web.Response(status=200 if os.path.exists(path) else 404))
    body = await req.read()
    if len(body) > 60 << 20:
        return _json(req, {"ok": False, "error": "zip terlalu besar (maks 60 MB)"}, 413)
    if hashlib.sha256(body).hexdigest() != sha:
        return _json(req, {"ok": False, "error": "isi tidak cocok dengan sha256"}, 400)
    os.makedirs(USER_LIBS, exist_ok=True)
    with open(path + ".tmp", "wb") as f:
        f.write(body)
    os.replace(path + ".tmp", path)
    return _json(req, {"ok": True})


# ---------------------------------------------------------------- IoT gateway
def _public(ip):
    a = ipaddress.ip_address(ip)
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified)


_HOSTMAP = dict(x.split("=", 1) for x in os.environ.get("GATEWAY_HOSTMAP", "").split(",") if "=" in x)  # tests only


async def _resolve(host, port, kind):
    host = _HOSTMAP.get(host, host)
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM)
    for fam, _, _, _, addr in infos:
        if fam == socket.AF_INET and (_public(addr[0]) or os.environ.get("GATEWAY_ALLOW_PRIVATE") == "1"):
            return addr[0]
    raise OSError("alamat %s tidak diizinkan / tidak ditemukan" % host)


class _Udp(asyncio.DatagramProtocol):
    def __init__(self, cb):
        self.cb = cb

    def datagram_received(self, data, addr):
        self.cb(data, addr)


async def net(req):
    ip = _ip(req)
    if ws_per_ip[ip] >= MAX_WS_PER_IP:
        return web.Response(status=429, text="terlalu banyak koneksi gateway")
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=1 << 20)
    await ws.prepare(req)
    ws_per_ip[ip] += 1
    socks, used, last = {}, [0], [time.time()]
    tls_ctx = ssl.create_default_context()
    if os.environ.get("GATEWAY_INSECURE_TLS") == "1":  # tests with self-signed local servers only
        tls_ctx.check_hostname = False; tls_ctx.verify_mode = ssl.CERT_NONE

    async def send_json(o):
        if not ws.closed:
            await ws.send_str(json.dumps(o))

    async def send_data(sid, data):
        used[0] += len(data)
        if not ws.closed:
            await ws.send_bytes(struct.pack("<H", sid) + data)

    async def pump(sid, reader):
        try:
            while True:
                data = await reader.read(16384)
                if not data:
                    break
                last[0] = time.time()
                await send_data(sid, data)
        except Exception:
            pass
        s = socks.pop(sid, None)
        if s:
            try: s["w"].close()
            except Exception: pass
        await send_json({"op": "closed", "id": sid})

    async def connect(m):
        sid, host, port, tls = int(m["id"]), str(m["host"])[:253], int(m["port"]), bool(m.get("tls"))
        if len(socks) >= MAX_SOCKS:
            return await send_json({"op": "connected", "id": sid, "ok": False, "err": "terlalu banyak koneksi terbuka (maks %d)" % MAX_SOCKS})
        if port not in TCP_PORTS:
            return await send_json({"op": "connected", "id": sid, "ok": False, "err": "port %d tidak diizinkan gateway" % port})
        try:
            addr = await _resolve(host, port, "tcp")
            r, w = await asyncio.wait_for(asyncio.open_connection(addr, port, ssl=tls_ctx if tls else None, server_hostname=host if tls else None), 10)
        except Exception as e:
            return await send_json({"op": "connected", "id": sid, "ok": False, "err": str(e)[:200]})
        socks[sid] = {"w": w, "kind": "tcp"}
        await send_json({"op": "connected", "id": sid, "ok": True, "ip": addr})
        socks[sid]["task"] = asyncio.create_task(pump(sid, r))

    async def udp(m):
        sid, host, port = int(m["id"]), str(m["host"])[:253], int(m["port"])
        if port not in UDP_PORTS:
            return await send_json({"op": "udperr", "id": sid, "err": "port UDP %d tidak diizinkan gateway" % port})
        try:
            addr = await _resolve(host, port, "udp")
            s = socks.get(sid)
            if not s:
                loop = asyncio.get_running_loop()
                tr, _ = await loop.create_datagram_endpoint(lambda: _Udp(lambda d, a: asyncio.ensure_future(send_json({"op": "udp", "id": sid, "from": a[0], "port": a[1], "data": d.hex()}))), family=socket.AF_INET)
                s = socks[sid] = {"w": tr, "kind": "udp"}
            data = bytes.fromhex(m.get("data", ""))[:1500]
            used[0] += len(data); s["w"].sendto(data, (addr, port))
        except Exception as e:
            await send_json({"op": "udperr", "id": sid, "err": str(e)[:200]})

    async def dns(m):
        try:
            addr = await _resolve(str(m["host"])[:253], 80, "tcp")
            await send_json({"op": "dns", "id": m["id"], "ip": addr})
        except Exception as e:
            await send_json({"op": "dns", "id": m["id"], "ip": None, "err": str(e)[:200]})

    async def idle_watch():
        while not ws.closed:
            await asyncio.sleep(10)
            if time.time() - last[0] > IDLE_S or used[0] > MAX_BYTES:
                await send_json({"op": "bye", "reason": "idle" if used[0] <= MAX_BYTES else "kuota data gateway habis"})
                await ws.close(); break

    watcher = asyncio.create_task(idle_watch())
    try:
        async for msg in ws:
            last[0] = time.time()
            if msg.type == WSMsgType.TEXT:
                try: m = json.loads(msg.data)
                except Exception: continue
                op = m.get("op")
                if op == "connect": asyncio.create_task(connect(m))
                elif op == "udp": asyncio.create_task(udp(m))
                elif op == "dns": asyncio.create_task(dns(m))
                elif op == "close":
                    s = socks.pop(int(m.get("id", -1)), None)
                    if s:
                        try: s["w"].close()
                        except Exception: pass
            elif msg.type == WSMsgType.BINARY and len(msg.data) >= 2:
                sid = struct.unpack("<H", msg.data[:2])[0]; s = socks.get(sid)
                if s and s["kind"] == "tcp":
                    used[0] += len(msg.data) - 2
                    s["w"].write(msg.data[2:])
                    try: await asyncio.wait_for(s["w"].drain(), 10)
                    except Exception: pass
                if used[0] > MAX_BYTES:
                    await send_json({"op": "bye", "reason": "kuota data gateway habis"}); break
    finally:
        watcher.cancel(); ws_per_ip[ip] -= 1
        for s in socks.values():
            try: s["w"].close()
            except Exception: pass
    return ws


def make_app():
    app = web.Application(client_max_size=64 << 20)
    app.router.add_get("/", health); app.router.add_get("/health", health)
    app.router.add_post("/build", build); app.router.add_post("/build-wasm", build)
    app.router.add_route("PUT", "/lib/{sha}", lib); app.router.add_route("HEAD", "/lib/{sha}", lib)
    app.router.add_get("/net", net)
    app.router.add_get("/job/{id}", job)
    app.router.add_route("OPTIONS", "/{tail:.*}", options)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    core_objs()  # warm the core cache so the first user compile is fast
    if runtime_objs:
        for b in ("esp32", "esp8266", "rp2040"):
            try: runtime_objs(b)
            except Exception as e: print("wasm runtime warmup failed for", b, e, flush=True)
    print("arduino-compile + gateway listening on :%d" % port, flush=True)
    web.run_app(make_app(), host="0.0.0.0", port=port, print=None)
