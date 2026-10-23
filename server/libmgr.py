"""Library manager for the WebAssembly (ESP32 / ESP8266 / RP2040) compiler.

Headers included by a sketch are resolved, in order, from:
  1. the simulator runtime (WiFi.h, HTTPClient.h, ... in esp32rt/)  -> nothing to do
  2. libraries bundled with the server (LIBS in compiler_wasm.py)
  3. libraries the user uploaded as .zip (e.g. an Edge Impulse "Arduino library" export), by sha256
  4. the official Arduino Library Manager index (like Wokwi / Arduino IDE): downloaded on first use and cached.
     Download from downloads.arduino.cc; falls back to cloning the library's git repository at the release tag.
Each library is described as {name, root, inc: [include dirs], srcs: [sources], deps: [header names]}.
"""
import glob, gzip, json, os, re, shutil, subprocess, threading, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("BUILD_CACHE", os.path.join(HERE, ".cache"))
INDEX_URL = os.environ.get("ARDUINO_LIB_INDEX", "https://downloads.arduino.cc/libraries/library_index.json.gz")
LIB_DIR = os.path.join(CACHE, "arduino-libs")
ULIB_DIR = os.path.join(CACHE, "user-libs-x")
USER_LIBS = os.environ.get("USER_LIBS", os.path.join(CACHE, "user-libs"))
SKIP_DIRS = ("/examples/", "/extras/", "/test/", "/tests/", "/docs/", "/doc/", "/fontconvert/", "/tools/", "/.git/")
_lock = threading.RLock()
_index = None            # header -> [(name, version, url, repo)]
_index_err = None
INCLUDE_RE = re.compile(r'^\s*#\s*include\s*[<"]([^>"]+)[>"]', re.M)


def includes(text):
    return [h for h in INCLUDE_RE.findall(text) if h.endswith((".h", ".hpp"))]


def _vkey(v):
    return [int(x) if x.isdigit() else 0 for x in re.split(r"[.\-+]", v or "0")[:4]]


# ---------------------------------------------------------------- describe a library folder
def describe(root, name=None):
    """Arduino library layout: 1.5 format (src/) or legacy (sources in root + utility/)."""
    src = os.path.join(root, "src")
    if os.path.isdir(src):
        base, files = src, [f for f in glob.glob(src + "/**/*", recursive=True)]
        inc = [src]
    else:
        base = root
        files = glob.glob(root + "/*") + glob.glob(root + "/utility/**/*", recursive=True)
        inc = [root] + ([os.path.join(root, "utility")] if os.path.isdir(os.path.join(root, "utility")) else [])
    files = [f for f in files if os.path.isfile(f) and not any(d in f.replace(base, "", 1) + "/" for d in SKIP_DIRS)]
    srcs = sorted(f for f in files if f.endswith((".c", ".cpp", ".cc", ".cxx")))
    headers = sorted({os.path.relpath(f, base) for f in files if f.endswith((".h", ".hpp"))})
    deps = []
    props = os.path.join(root, "library.properties")
    meta = {}
    if os.path.exists(props):
        for line in open(props, encoding="utf-8", errors="replace"):
            if "=" in line:
                k, v = line.split("=", 1); meta[k.strip()] = v.strip()
    for f in srcs + [os.path.join(base, h) for h in headers]:
        try:
            deps += includes(open(f, encoding="utf-8", errors="replace").read())
        except OSError:
            pass
    return {"name": name or meta.get("name") or os.path.basename(root), "root": root, "inc": inc, "srcs": srcs,
            "headers": headers, "deps": sorted(set(deps)), "arch": meta.get("architectures", "*"),
            "depends": [d.strip().split("(")[0].strip() for d in meta.get("depends", "").split(",") if d.strip()]}


# ---------------------------------------------------------------- user uploaded libraries (.zip)
def user_lib(sha):
    z = os.path.join(USER_LIBS, sha + ".zip")
    if not os.path.exists(z):
        raise FileNotFoundError("library %s… belum diunggah ke server" % sha[:8])
    dest = os.path.join(ULIB_DIR, sha)
    with _lock:
        if not os.path.isdir(dest):
            tmp = dest + ".tmp"; shutil.rmtree(tmp, ignore_errors=True)
            _safe_extract(z, tmp)
            os.replace(tmp, dest)
    return describe(_lib_root(dest))


def _safe_extract(zpath, dest):
    with zipfile.ZipFile(zpath) as zf:
        for m in zf.infolist():
            p = os.path.normpath(os.path.join(dest, m.filename))
            if not p.startswith(os.path.abspath(dest) + os.sep) and p != os.path.abspath(dest):
                raise ValueError("zip berisi path tidak aman")
        zf.extractall(dest)


def _lib_root(d):
    """the folder that contains library.properties / src (zips usually wrap the library in one folder)"""
    for cand in [d] + sorted(glob.glob(d + "/*/")):
        cand = cand.rstrip("/")
        if os.path.exists(os.path.join(cand, "library.properties")) or os.path.isdir(os.path.join(cand, "src")):
            return cand
    subs = [x for x in glob.glob(d + "/*") if os.path.isdir(x)]
    return subs[0] if len(subs) == 1 else d


# ---------------------------------------------------------------- Arduino Library Manager index
def _load_index():
    global _index, _index_err
    if _index is not None:
        return _index
    path = os.path.join(CACHE, "library_index.json")
    try:
        os.makedirs(CACHE, exist_ok=True)
        if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 86400:
            raw = urllib.request.urlopen(INDEX_URL, timeout=30).read()
            if INDEX_URL.endswith(".gz"):
                raw = gzip.decompress(raw)
            open(path + ".tmp", "wb").write(raw); os.replace(path + ".tmp", path)
        data = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        _index_err = str(e)
        if os.path.exists(path):
            data = json.load(open(path, encoding="utf-8"))
        else:
            _index = {}
            return _index
    best = {}
    for lib in data.get("libraries", []):
        n = lib.get("name")
        if not n or (n in best and _vkey(best[n]["version"]) >= _vkey(lib.get("version"))):
            continue
        best[n] = lib
    idx = {}
    for lib in best.values():
        provides = lib.get("providesIncludes") or [lib["name"].replace(" ", "_") + ".h"]
        for h in provides:
            idx.setdefault(h, []).append((lib["name"], lib.get("version", ""), lib.get("url", ""), lib.get("repository", ""), lib.get("architectures", ["*"])))
    _index = idx
    return idx


def _rank(cands, header):
    """prefer the library whose name matches the header, then libraries that support esp32 / any arch"""
    base = os.path.splitext(os.path.basename(header))[0].lower().replace("_", "").replace("-", "")
    def score(c):
        name = c[0].lower().replace(" ", "").replace("_", "").replace("-", "")
        arch = [a.lower() for a in (c[4] or ["*"])]
        return (name == base, "*" in arch or "esp32" in arch, -len(c[0]))
    return sorted(cands, key=score, reverse=True)


ARCH = {"esp32": "esp32", "esp8266": "esp8266", "rp2040": "rp2040"}


def index_lib(header, board="esp32", want=None):
    cands = _load_index().get(header)
    if want:
        cands = [c for c in (cands or []) if c[0] == want]
    if not cands:
        return None
    arch = ARCH.get(board, board)
    ok = [c for c in cands if not c[4] or "*" in c[4] or arch in [a.lower() for a in c[4]]]
    if not ok:
        raise RuntimeError("library %s hanya untuk %s, tidak untuk %s" % (cands[0][0], ",".join(cands[0][4]), board.upper()))
    name, version, url, repo, _ = _rank(ok, header)[0]
    slug = re.sub(r"[^\w.-]", "_", name) + "-" + version
    dest = os.path.join(LIB_DIR, slug)
    with _lock:
        if not os.path.isdir(dest):
            os.makedirs(LIB_DIR, exist_ok=True)
            tmp = dest + ".tmp"; shutil.rmtree(tmp, ignore_errors=True)
            try:
                z = tmp + ".zip"
                urllib.request.urlretrieve(url, z)
                _safe_extract(z, tmp); os.remove(z)
            except Exception:
                shutil.rmtree(tmp, ignore_errors=True)
                if not repo:
                    raise
                ok = False
                for ref in (version, "v" + version, None):
                    cmd = ["git", "clone", "-q", "--depth", "1"] + (["--branch", ref] if ref else []) + [repo, tmp]
                    if subprocess.run(cmd, capture_output=True, timeout=120).returncode == 0:
                        ok = True; break
                    shutil.rmtree(tmp, ignore_errors=True)
                if not ok:
                    raise RuntimeError("gagal mengunduh library %s" % name)
            os.replace(tmp, dest)
    d = describe(_lib_root(dest), name); d["version"] = version
    return d


def library_by_name(name, board="esp32"):
    """resolve a library.properties 'depends=' entry"""
    idx = _load_index()
    for h, cands in idx.items():
        for c in cands:
            if c[0] == name:
                return index_lib(h, board, want=name)
    return None
