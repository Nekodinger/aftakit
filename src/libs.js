// User libraries (.zip, e.g. an Edge Impulse "Arduino library" export): kept in this browser (IndexedDB),
// referenced by the project as {name, sha, size, include}, and uploaded to the compile server only once.
const DB = 'sim-libs', STORE = 'zips';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); });
}
export const putZip = (sha, blob) => tx('readwrite', (s) => s.put(blob, sha));
export const getZip = (sha) => tx('readonly', (s) => s.get(sha)).catch(() => null);

export async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** file names inside a zip (reads only the central directory, no decompression) */
export function zipNames(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf); const names = [];
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('bukan file .zip yang valid');
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true); const td = new TextDecoder();
  for (let k = 0; k < n && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    names.push(td.decode(u8.subarray(p + 46, p + 46 + fl))); p += 46 + fl + xl + cl;
  }
  return names;
}

/** describe an Arduino library zip: its name and the header(s) a sketch should #include */
export function describeZip(fileName, buf) {
  const names = zipNames(buf);
  const props = names.find((x) => /(^|\/)library\.properties$/.test(x));
  const base = props ? props.replace(/library\.properties$/, '') : '';
  const hdrs = names.filter((x) => x.startsWith(base + 'src/') && /^[^/]+\.h$/.test(x.slice((base + 'src/').length))).map((x) => x.slice((base + 'src/').length));
  const legacy = hdrs.length ? [] : names.filter((x) => x.startsWith(base) && /^[^/]+\.h$/.test(x.slice(base.length))).map((x) => x.slice(base.length));
  const name = (base.replace(/\/$/, '').split('/').pop()) || fileName.replace(/\.zip$/i, '');
  if (!props && !names.some((x) => /\.(h|hpp)$/.test(x))) throw new Error('zip ini tidak berisi library Arduino (tidak ada file .h)');
  const include = [...hdrs, ...legacy].sort((a, b) => (/_inferencing\.h$/.test(b) ? 1 : 0) - (/_inferencing\.h$/.test(a) ? 1 : 0) || a.length - b.length)[0] || '';
  return { name, include, edgeImpulse: names.some((x) => x.includes('edge-impulse-sdk/')) };
}
