// microSD card in SPI mode (SDHC, block addressing) holding a FAT16-formatted 64 MiB volume.
// Unwritten sectors are generated on demand (MBR, boot sector, empty FATs / root directory), written sectors are kept
// in a sparse map so the card keeps its files across sketch restarts.
const SECTORS = 131072, PART = 2048, SPC = 4, RESERVED = 4, NFATS = 2, ROOT_ENTRIES = 512;
const PSECT = SECTORS - PART;
const ROOT_SECT = (ROOT_ENTRIES * 32) / 512;
const FATSZ = (() => { let f = 1; for (let i = 0; i < 8; i++) { const cl = Math.floor((PSECT - RESERVED - ROOT_SECT - NFATS * f) / SPC); f = Math.ceil(((cl + 2) * 2) / 512); } return f; })();
const FAT0 = PART + RESERVED, ROOT0 = FAT0 + NFATS * FATSZ, DATA0 = ROOT0 + ROOT_SECT;

function blank(lba) {
  const b = new Uint8Array(512);
  const w16 = (o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };
  const w32 = (o, v) => { w16(o, v & 0xffff); w16(o + 2, v >>> 16); };
  if (lba === 0) {                                                  // MBR with one FAT16 (LBA) partition
    const e = 446; b[e] = 0; b[e + 1] = 0xfe; b[e + 2] = 0xff; b[e + 3] = 0xff; b[e + 4] = 0x06; b[e + 5] = 0xfe; b[e + 6] = 0xff; b[e + 7] = 0xff;
    w32(e + 8, PART); w32(e + 12, PSECT); b[510] = 0x55; b[511] = 0xaa;
  } else if (lba === PART) {                                        // FAT16 boot sector / BPB
    b.set([0xeb, 0x3c, 0x90], 0); 'MSDOS5.0'.split('').forEach((c, i) => (b[3 + i] = c.charCodeAt(0)));
    w16(11, 512); b[13] = SPC; w16(14, RESERVED); b[16] = NFATS; w16(17, ROOT_ENTRIES); w16(19, 0); b[21] = 0xf8; w16(22, FATSZ);
    w16(24, 63); w16(26, 255); w32(28, PART); w32(32, PSECT); b[36] = 0x80; b[38] = 0x29; w32(39, 0x5ad1c0de);
    'SIMULATOR  '.split('').forEach((c, i) => (b[43 + i] = c.charCodeAt(0))); 'FAT16   '.split('').forEach((c, i) => (b[54 + i] = c.charCodeAt(0)));
    b[510] = 0x55; b[511] = 0xaa;
  } else if (lba === FAT0 || lba === FAT0 + FATSZ) { b.set([0xf8, 0xff, 0xff, 0xff]); }
  else if (lba === ROOT0) { 'SIMULATOR  '.split('').forEach((c, i) => (b[i] = c.charCodeAt(0))); b[11] = 0x08; }   // volume label entry
  return b;
}

export class SDCard {
  constructor(store) { this.store = store || new Map(); this.reset(); }
  reset() { this.out = []; this.cmd = []; this.state = 'cmd'; this.idle = true; this.app = false; this.buf = null; this.n = 0; this.multi = 0; this.addr = 0; this.inserted = true; }
  read(lba) { return this.store.get(lba) || blank(lba); }
  csChange(low) { if (!low && this.state === 'cmd') this.cmd = []; }
  _r(...bytes) { this.out.push(0xff, ...bytes); }                 // one byte of NCR delay, then the response
  _block(lba) { const d = this.read(lba); this.out.push(0xff, 0xfe, ...d, 0xff, 0xff); }
  transfer(b) {
    const ret = this.out.length ? this.out.shift() : 0xff;
    if (!this.inserted) return 0xff;
    switch (this.state) {
      case 'cmd':
        if (!this.cmd.length && (b & 0xc0) !== 0x40) break;
        this.cmd.push(b);
        if (this.cmd.length === 6) { const c = this.cmd; this.cmd = []; this._command(c[0] & 0x3f, ((c[1] << 24) | (c[2] << 16) | (c[3] << 8) | c[4]) >>> 0); }
        break;
      case 'wtoken':                                                // waiting for the data token of a write
        if (b === 0xfe || (this.multi && b === 0xfc)) { this.state = 'wdata'; this.buf = new Uint8Array(512); this.n = 0; }
        else if (this.multi && b === 0xfd) { this.state = 'cmd'; this.multi = 0; this.out.push(0xff, 0x00, 0x00); }   // stop tran + busy
        break;
      case 'wdata':
        if (this.n < 512) this.buf[this.n] = b;
        if (++this.n === 514) {                                     // 512 data bytes + CRC16
          if (this.addr < SECTORS) this.store.set(this.addr, this.buf);
          this.out.push(0x05, 0x00, 0x00);                          // data accepted, then busy
          if (this.multi) { this.addr++; this.state = 'wtoken'; } else this.state = 'cmd';
        }
        break;
      case 'rmulti':                                                // CMD18: stream blocks until CMD12
        this.cmd.push(b);
        if (this.cmd.length === 1 && (b & 0xc0) !== 0x40) this.cmd = [];
        if (this.cmd.length === 6) { const c = this.cmd; this.cmd = []; if ((c[0] & 0x3f) === 12) { this.out = []; this.state = 'cmd'; this._r(0xff, 0x00); } }
        else if (this.out.length < 8) this._block(++this.addr);
        break;
    }
    return ret;
  }
  _command(c, arg) {
    const r1 = this.idle ? 1 : 0;
    if (this.app) { this.app = false; if (c === 41) { this.idle = false; this._r(0x00); return; } if (c === 23) { this._r(0); return; } }
    switch (c) {
      case 0: this.idle = true; this.out = []; this._r(0x01); break;
      case 8: this._r(0x01, 0x00, 0x00, (arg >> 8) & 15, arg & 255); break;
      case 55: this.app = true; this._r(r1); break;
      case 58: this._r(r1, 0xc0, 0xff, 0x80, 0x00); break;          // OCR: powered up, CCS = 1 (SDHC)
      case 59: case 16: this._r(r1); break;
      case 9: {                                                     // CSD v2.0: C_SIZE = SECTORS/1024 - 1
        const cs = SECTORS / 1024 - 1;
        const csd = [0x40, 0x0e, 0x00, 0x32, 0x5b, 0x59, 0x00, (cs >> 16) & 0x3f, (cs >> 8) & 255, cs & 255, 0x7f, 0x80, 0x0a, 0x40, 0x00, 0x01];
        this._r(0x00, 0xff, 0xfe, ...csd, 0xff, 0xff); break;
      }
      case 10: this._r(0x00, 0xff, 0xfe, 0x03, 0x53, 0x44, 0x53, 0x49, 0x4d, 0x30, 0x31, 0x10, 0x12, 0x34, 0x56, 0x78, 0x01, 0x6a, 0x01, 0xff, 0xff); break;
      case 13: this._r(0x00, 0x00); break;
      case 17: this.out.push(0xff, 0x00); this._block(arg); break;
      case 18: this.out.push(0xff, 0x00); this.addr = arg; this._block(arg); this.state = 'rmulti'; break;
      case 24: this._r(0x00); this.addr = arg; this.multi = 0; this.state = 'wtoken'; break;
      case 25: this._r(0x00); this.addr = arg; this.multi = 1; this.state = 'wtoken'; break;
      case 12: this._r(0xff, 0x00); break;
      case 32: case 33: case 38: this._r(0x00, 0x00); break;
      default: this._r(0x04 | r1);                                  // illegal command
    }
  }
  // ---- FAT16 reader for the UI (list and read files written by the sketch)
  files() {
    const sec = (l) => this.read(l), fat = (cl) => { const o = cl * 2, b = sec(FAT0 + (o >> 9)); return b[o & 511] | (b[(o & 511) + 1] << 8); };
    const chain = (cl, size) => { const out = []; let n = 0; while (cl >= 2 && cl < 0xfff8 && n < 65536) { for (let i = 0; i < SPC; i++) out.push(...sec(DATA0 + (cl - 2) * SPC + i)); cl = fat(cl); n++; } return new Uint8Array(out.slice(0, size)); };
    const list = [];
    const walk = (entries, path, depth) => {
      for (let o = 0; o + 32 <= entries.length; o += 32) {
        const e = entries.subarray(o, o + 32); if (e[0] === 0) break; if (e[0] === 0xe5 || e[11] === 0x0f || e[11] & 0x08) continue;
        const name = String.fromCharCode(...e.subarray(0, 8)).trim(), ext = String.fromCharCode(...e.subarray(8, 11)).trim();
        if (name === '.' || name === '..') continue;
        const full = path + name + (ext ? '.' + ext : ''), cl = e[26] | (e[27] << 8), size = e[28] | (e[29] << 8) | (e[30] << 16) | (e[31] << 24);
        if (e[11] & 0x10) { if (depth < 4) walk(chain(cl, 1 << 20), full + '/', depth + 1); } else list.push({ name: full, size, data: () => chain(cl, size) });
      }
    };
    const root = []; for (let i = 0; i < ROOT_SECT; i++) root.push(...sec(ROOT0 + i));
    walk(new Uint8Array(root), '/', 0);
    return list;
  }
}
