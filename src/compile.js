// Compile client: precompiled-example shortcut -> configured compile server (own avr-gcc backend).
import { CONFIG } from './config.js';

const LS = 'sim.settings.v1';
export function loadSettings() {
  try { return { url: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { url: '' }; }
}
export function saveSettings(s) { try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* storage blocked */ } }
export function compileEndpoint() { const u = (loadSettings().url || CONFIG.compileUrl || '').trim().replace(/\/+$/, ''); return u ? (/\/build$/.test(u) ? u : u + '/build') : ''; }

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

/** @returns {Promise<{ok:boolean, hex?:string, stdout?:string, stderr?:string, diagnostics:any[], source:string, error?:string}>} */
export async function compile(code, { precompiled } = {}) {
  if (precompiled && precompiled.code === code && precompiled.hex) {
    return { ok: true, hex: precompiled.hex, stdout: precompiled.info || '', stderr: '', diagnostics: [], source: 'contoh (prakompilasi)' };
  }
  const key = await hash(code);
  if (cache.has(key)) return { ...cache.get(key), source: 'cache' };

  const ep = compileEndpoint();
  if (ep) {
    let res;
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 90000);
      res = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sketch: code }), signal: ctl.signal });
      clearTimeout(timer);
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Server kompilator tidak menjawab dalam 90 detik (mungkin sedang bangun dari tidur — coba lagi).' : `Tidak dapat menghubungi server kompilator (${ep}). Periksa koneksi, atau URL di Berkas → Pengaturan.`;
      return fail(msg, 'network');
    }
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    if (res.status === 429) return fail('Terlalu banyak permintaan kompilasi. Tunggu sebentar lalu coba lagi.', 'server');
    if (!data) return fail(`Server kompilator membalas dengan status ${res.status} tanpa JSON.`, 'server');
    if (data.hex) { const r = { ok: true, hex: data.hex, stdout: data.stdout || '', stderr: data.stderr || '', diagnostics: parseDiagnostics(data.stderr), source: 'server' }; cache.set(key, r); return r; }
    const err = data.stderr || data.error || 'Kompilasi gagal.';
    return { ok: false, stdout: data.stdout || '', stderr: err, diagnostics: parseDiagnostics(err), source: 'server', error: err };
  }
  return fail('Server kompilator belum dikonfigurasi. Contoh bawaan tetap bisa dijalankan tanpa diubah. Untuk kode sendiri: atur URL kompilator di Berkas → Pengaturan, atau unduh .ino lalu muat file .hex lewat Berkas → Jalankan berkas .hex.', 'noserver');
}

function fail(message, source) { return { ok: false, diagnostics: [], stderr: message, error: message, source }; }

export async function testServer(url) {
  const base = (url || '').trim().replace(/\/+$/, '').replace(/\/build$/, '');
  if (!base) return { ok: false, text: 'URL kosong.' };
  try {
    const r = await fetch(base + '/health', { cache: 'no-store' }); const j = await r.json();
    return { ok: !!j.ok, text: j.ok ? `Terhubung ✓ ${j.toolchain || ''}`.trim() : 'Server menjawab tetapi tidak sehat.' };
  } catch (e) { return { ok: false, text: 'Gagal terhubung: ' + e.message + ' (CORS atau server mati?)' }; }
}
