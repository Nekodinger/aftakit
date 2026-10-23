// Intel HEX -> Uint8Array. Throws Error with a readable message on malformed input.
export function parseHex(text, flash = 32 * 1024) {
  const bytes = new Uint8Array(flash).fill(0xff);
  let ext = 0, max = 0, lines = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    if (line[0] !== ':') throw new Error(`HEX tidak valid: baris ${lines} tidak diawali ':'`);
    const len = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);
    if (line.length < 11 + len * 2) throw new Error(`HEX tidak valid: baris ${lines} terpotong`);
    let sum = 0;
    for (let i = 1; i < 11 + len * 2; i += 2) sum = (sum + parseInt(line.substr(i, 2), 16)) & 0xff;
    if (sum !== 0) throw new Error(`HEX tidak valid: checksum salah di baris ${lines}`);
    if (type === 0) {
      for (let i = 0; i < len; i++) {
        const a = ext + addr + i;
        if (a >= bytes.length) throw new Error(`Program melebihi ${flash / 1024} KB flash mikrokontroler ini`);
        bytes[a] = parseInt(line.substr(9 + i * 2, 2), 16);
        if (a + 1 > max) max = a + 1;
      }
    } else if (type === 2) ext = parseInt(line.substr(9, 4), 16) << 4;
    else if (type === 4) ext = parseInt(line.substr(9, 4), 16) << 16;
    else if (type === 1) break;
  }
  if (max === 0) throw new Error('File HEX kosong (tidak ada data program)');
  return { bytes, size: max };
}

export function toProgMem(bytes) {
  const words = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  return new Uint16Array(words); // copy, little-endian host assumed (all browsers on x86/ARM LE)
}

/** base64 of raw flash bytes -> Intel HEX text (inverse of parseHex; used for compact precompiled examples). */
export function b64ToHex(b64) {
  const bin = atob(b64), n = bin.length, out = [];
  for (let a = 0; a < n; a += 16) {
    const len = Math.min(16, n - a), rec = [len, (a >> 8) & 255, a & 255, 0];
    for (let i = 0; i < len; i++) rec.push(bin.charCodeAt(a + i));
    rec.push((256 - (rec.reduce((s, x) => s + x, 0) & 255)) & 255);
    out.push(':' + rec.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase());
  }
  out.push(':00000001FF');
  return out.join('\n') + '\n';
}
