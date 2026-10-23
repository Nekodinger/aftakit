// Compile client: precompiled-example shortcut -> configured compile server.
//   Uno / Nano      -> POST /build       (avr-gcc, returns Intel HEX)
//   ESP32 / ESP8266 -> POST /build-wasm  (wasi-sdk, returns a WebAssembly module run by the simulator)
import { CONFIG } from './config.js';

const LS = 'sim.settings.v1';
export function loadSettings() {
  try { return { url: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { url: '' }; }
}
export function saveSettings(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* storage blocked */ } }
// Default: the compile service built into this site (Vercel Function at /api/cc). A custom server URL can be set in
// Berkas -> Pengaturan (e.g. a self-hosted Docker server from the server/ folder).
export const BUILTIN_BASE = '/api/cc';
export function compileBase() { return (loadSettings().url || CONFIG.compileUrl || BUILTIN_BASE).trim().replace(/\/+$/, '').replace(/\/build(-wasm)?$/, ''); }
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

const BOARD_NAME = { avr: 'Arduino Uno/Nano/Mega', esp32: 'ESP32', esp8266: 'ESP8266', rp2040: 'Raspberry Pi Pico', nanorp2040: 'Arduino Nano RP2040 Connect' };
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** board: 'avr' (default) or a WebAssembly runtime ('esp32' | 'esp8266' | 'rp2040').
 * @returns {Promise<{ok:boolean, hex?:string, wasm?:Uint8Array, stdout?:string, stderr?:string, diagnostics:any[], source:string, error?:string}>} */
// make sure the server has every user library (.zip) of the project; uploads only the missing ones
async function ensureLibs(base, libs, getLib, onProgress) {
  // built-in (Vercel) service: libraries live in Supabase Storage as <sha256>.zip, the function fetches them by hash
  if (CONFIG.supabaseUrl && CONFIG.supabaseKey && base === BUILTIN_BASE) {
    const sb = CONFIG.supabaseUrl.replace(/\/+$/, '');
    for (const l of libs) {
      const h = await fetch(`${sb}/storage/v1/object/public/libs/${l.sha}.zip`, { method: 'HEAD' }).catch(() => null);
      if (h && h.ok) continue;
      const blob = await getLib(l.sha);
      if (!blob) throw new Error(`File library "${l.name}" tidak ada di perangkat ini. Unggah ulang .zip-nya di panel Library.`);
      if (blob.size > 50 * 1048576) throw new Error(`Library ${l.name} lebih dari 50 MB (batas penyimpanan gratis).`);
      onProgress?.(`Mengunggah library ${l.name} (${(blob.size / 1048576).toFixed(1)} MB)…`);
      const r = await fetch(`${sb}/storage/v1/object/libs/${l.sha}.zip`, { method: 'POST', body: blob, headers: { apikey: CONFIG.supabaseKey, Authorization: 'Bearer ' + CONFIG.supabaseKey, 'Content-Type': 'application/zip', 'x-upsert': 'false' } });
      if (!r.ok && r.status !== 409) { let m = ''; try { m = (await r.json()).message; } catch { /* not json */ } if (!/exists|Duplicate/i.test(m)) throw new Error(`Gagal mengunggah library ${l.name}: ${m || 'HTTP ' + r.status}`); }
    }
    return;
  }
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
// long builds (Edge Impulse, TensorFlow Lite): a self-hosted server returns a job id to poll; the serverless
// service compiles in slices of ~4 minutes and answers {pending} -> send the same request again to continue
async function waitJob(base, data, onProgress, again) {
  const t0 = Date.now();
  while (data && data.pending && Date.now() - t0 < 20 * 60000) {
    onProgress?.(`Mengompilasi library besar… ${Math.round((Date.now() - t0) / 1000)} s (pertama kali bisa beberapa menit, berikutnya cepat)`);
    try {
      if (data.job) { await new Promise((r) => setTimeout(r, 3000)); data = await (await fetch(`${base}/job/${data.job}`)).json(); }
      else data = await (await again()).json();
    } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
  return data;
}

export async function compile(code, { precompiled, board = 'avr', mcu = 'uno', libs = [], getLib, onProgress } = {}) {
  if (precompiled && precompiled.code === code && precompiled.hex && board === 'avr') {
    return { ok: true, hex: precompiled.hex, stdout: precompiled.info || '', stderr: '', diagnostics: [], source: 'contoh (prakompilasi)' };
  }
  if (precompiled && precompiled.code === code && precompiled.wasm && precompiled.board === board) {
    try { return { ok: true, wasm: await precompiled.wasm(), stdout: '', stderr: '', diagnostics: [], source: 'contoh (prakompilasi)' }; }
    catch (e) { return fail('Gagal memuat program contoh: ' + e.message + '. Periksa koneksi internet lalu coba lagi.', 'network'); }
  }
  const key = board + (board === 'avr' ? '/' + mcu : '') + ':' + libs.map((l) => l.sha).join(',') + ':' + (await hash(code));
  if (cache.has(key)) return { ...cache.get(key), source: 'cache' };

  const ep = compileEndpoint(board);
  if (ep) {
    let res;
    const post = () => fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sketch: code, board, mcu, libs: libs.map((l) => l.sha) }), signal: AbortSignal.timeout(320000) });
    if (libs.length && board !== 'avr') {
      try { await ensureLibs(compileBase(), libs, getLib, onProgress); } catch (e) { return fail(e.message, 'server'); }
    }
    try {
      res = await post();
    } catch (e) {
      const msg = (e.name === 'AbortError' || e.name === 'TimeoutError') ? 'Server kompilator tidak menjawab dalam 5 menit (mungkin sedang bangun dari tidur — coba lagi).' : `Tidak dapat menghubungi server kompilator (${ep}). Periksa koneksi, atau URL di Berkas → Pengaturan.`;
      return fail(msg, 'network');
    }
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    if (data?.pending) data = await waitJob(compileBase(), data, onProgress, post);
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
export function gatewayUrl() {
  let b = compileBase(); if (!b) return '';
  if (b === BUILTIN_BASE) return location.origin.replace(/^http/, 'ws') + '/api/net';   // Vercel WebSocket function
  if (b.startsWith('/')) b = location.origin + b;
  return b.replace(/^http/, 'ws') + '/net';
}

export async function testServer(url) {
  const base = (url || '').trim().replace(/\/+$/, '').replace(/\/build$/, '');
  if (!base) return { ok: false, text: 'URL kosong.' };
  try {
    const r = await fetch(base + '/health', { cache: 'no-store' }); const j = await r.json();
    return { ok: !!j.ok, wasm: !!j.wasm, text: j.ok ? `Terhubung ✓ ${j.toolchain || ''} · board: ${(j.boards || ['uno', 'nano']).join(', ')}${j.wasm ? '' : ' (ESP32 belum didukung server ini)'}${j.gateway ? ' · gateway IoT aktif' : ' · gateway IoT belum ada (server versi lama)'}` : 'Server menjawab tetapi tidak sehat.' };
  } catch (e) { return { ok: false, text: 'Gagal terhubung: ' + e.message + ' (CORS atau server mati?)' }; }
}
