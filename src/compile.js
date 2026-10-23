// Compile client: precompiled-example shortcut -> configured compile server.
//   Uno / Nano      -> POST /build       (avr-gcc, returns Intel HEX)
//   ESP32 / ESP8266 -> POST /build-wasm  (wasi-sdk, returns a WebAssembly module run by the simulator)
import { CONFIG } from './config.js';

const LS = 'sim.settings.v1';
export function loadSettings() {
  try { return { url: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { url: '' }; }
}
export function saveSettings(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* storage blocked */ } }
export function compileBase() { return (loadSettings().url || CONFIG.compileUrl || '').trim().replace(/\/+$/, '').replace(/\/build(-wasm)?$/, ''); }
export function compileEndpoint(board = 'avr') { const b = compileBase(); return b ? b + (board === 'avr' ? '/build' : '/build-wasm') : ''; }

const cache = new Map();
async function hash(s) {
  const b = new TextEncoder().encode(s);
  if (crypto?.subtle) { const d = await crypto.subtle.digest('SHA-256', b); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return String(h);
}

/** Parse gcc output into [{line,col,severity,message}] referencing sketch.ino. */
export function parseDiagnostics(text) {
  const out = [], re = /^sketch\.ino:(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)$/gm; let m;
  while ((m = re.exec(text || ''))) out.push({ line: +m[1], col: m[2] ? +m[2] : 1, severity: m[3] === 'warning' ? 'warn' : 'error', message: m[4] });
  return out;
}

const BOARD_NAME = { avr: 'Arduino Uno/Nano', esp32: 'ESP32', esp8266: 'ESP8266', rp2040: 'Raspberry Pi Pico' };
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** board: 'avr' (default) or a WebAssembly runtime ('esp32' | 'esp8266' | 'rp2040').
 * @returns {Promise<{ok:boolean, hex?:string, wasm?:Uint8Array, stdout?:string, stderr?:string, diagnostics:any[], source:string, error?:string}>} */
// make sure the server has every user library (.zip) of the project; uploads only the missing ones
async function ensureLibs(base, libs, getLib, onProgress) {
  for (const l of libs) {
    const h = await fetch(`${base}/lib/${l.sha}`, { method: 'HEAD' }).catch(() => null);
    if (h && h.ok) continue;
    const blob = await getLib(l.sha);
    if (!blob) throw new Error(`File library "${l.name}" tidak ada di perangkat ini. Unggah ulang .zip-nya di panel Library.`);
    onProgress?.(`Mengunggah library ${l.name} (${(blob.size / 1048576).toFixed(1)} MB)…`);
    const r = await fetch(`${base}/lib/${l.sha}`, { method: 'PUT', body: blob });
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch { /* not json */ } throw new Error(`Gagal mengunggah library ${l.name}: ${m || 'HTTP ' + r.status}`); }
  }
}
// long builds (Edge Impulse, TensorFlow Lite) return a job id: poll until it is done
async function waitJob(base, data, onProgress) {
  const t0 = Date.now();
  while (data && data.pending && Date.now() - t0 < 20 * 60000) {
    onProgress?.(`Mengompilasi library besar… ${Math.round((Date.now() - t0) / 1000)} s (pertama kali bisa 1–3 menit, berikutnya cepat)`);
    await new Promise((r) => setTimeout(r, 3000));
    try { const r = await fetch(`${base}/job/${data.job}`); data = await r.json(); } catch { /* retry */ }
  }
  return data;
}

export async function compile(code, { precompiled, board = 'avr', libs = [], getLib, onProgress } = {}) {
  if (precompiled && precompiled.code === code && precompiled.hex && board === 'avr') {
    return { ok: true, hex: precompiled.hex, stdout: precompiled.info || '', stderr: '', diagnostics: [], source: 'contoh (prakompilasi)' };
  }
  if (precompiled && precompiled.code === code && precompiled.wasm && precompiled.board === board) {
    try { return { ok: true, wasm: await precompiled.wasm(), stdout: '', stderr: '', diagnostics: [], source: 'contoh (prakompilasi)' }; }
    catch (e) { return fail('Gagal memuat program contoh: ' + e.message + '. Periksa koneksi internet lalu coba lagi.', 'network'); }
  }
  const key = board + ':' + libs.map((l) => l.sha).join(',') + ':' + (await hash(code));
  if (cache.has(key)) return { ...cache.get(key), source: 'cache' };

  const ep = compileEndpoint(board);
  if (ep) {
    let res;
    if (libs.length && board !== 'avr') {
      try { await ensureLibs(compileBase(), libs, getLib, onProgress); } catch (e) { return fail(e.message, 'server'); }
    }
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
      res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sketch: code, board, libs: libs.map((l) => l.sha) }), signal: ctl.signal });
      clearTimeout(timer);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Server kompilator tidak menjawab dalam 90 detik (mungkin sedang bangun dari tidur — coba lagi).' : `Tidak dapat menghubungi server kompilator (${ep}). Periksa koneksi, atau URL di Berkas → Pengaturan.`;
      return fail(msg, 'network');
    }
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    if (data?.pending) data = await waitJob(compileBase(), data, onProgress);
    if (data?.pending) return fail('Kompilasi terlalu lama (lebih dari 20 menit). Coba lagi nanti.', 'server');
    if (res.status === 429) return fail('Terlalu banyak permintaan kompilasi. Tunggu sebentar lalu coba lagi.', 'server');
    if (res.status === 404 && board !== 'avr') return fail(`Server kompilator ini belum mendukung ${BOARD_NAME[board]} (versi lama). Perbarui server dengan folder server/ terbaru.`, 'server');
    if (!data) return fail(`Server kompilator membalas dengan status ${res.status} tanpa JSON.`, 'server');
    if (data.wasm) { const r = { ok: true, wasm: b64bytes(data.wasm), stdout: data.stdout || '', stderr: data.stderr || '', diagnostics: parseDiagnostics(data.stderr), source: 'server' }; cache.set(key, r); return r; }
    if (data.hex) { const r = { ok: true, hex: data.hex, stdout: data.stdout || '', stderr: data.stderr || '', diagnostics: parseDiagnostics(data.stderr), source: 'server' }; cache.set(key, r); return r; }
    const err = data.stderr || data.error || 'Kompilasi gagal.';
    return { ok: false, stdout: data.stdout || '', stderr: err, diagnostics: parseDiagnostics(err), source: 'server', error: err };
  }
  return fail(`Server kompilator belum dikonfigurasi. Contoh bawaan tetap bisa dijalankan tanpa diubah. Untuk kode ${BOARD_NAME[board]} sendiri: atur URL kompilator di Berkas → Pengaturan${board === 'avr' ? ', atau unduh .ino lalu muat file .hex lewat Berkas → Jalankan berkas .hex' : ''}.`, 'noserver');
}

function fail(message, source) { return { ok: false, diagnostics: [], stderr: message, error: message, source }; }

/** WebSocket URL of the compile server's IoT gateway (real TCP / TLS / UDP for WiFiClient) */
export function gatewayUrl() { const b = compileBase(); return b ? b.replace(/^http/, 'ws') + '/net' : ''; }

export async function testServer(url) {
  const base = (url || '').trim().replace(/\/+$/, '').replace(/\/build$/, '');
  if (!base) return { ok: false, text: 'URL kosong.' };
  try {
    const r = await fetch(base + '/health', { cache: 'no-store' }); const j = await r.json();
    return { ok: !!j.ok, wasm: !!j.wasm, text: j.ok ? `Terhubung ✓ ${j.toolchain || ''} · board: ${(j.boards || ['uno', 'nano']).join(', ')}${j.wasm ? '' : ' (ESP32 belum didukung server ini)'}${j.gateway ? ' · gateway IoT aktif' : ' · gateway IoT belum ada (server versi lama)'}` : 'Server menjawab tetapi tidak sehat.' };
  } catch (e) { return { ok: false, text: 'Gagal terhubung: ' + e.message + ' (CORS atau server mati?)' }; }
}
