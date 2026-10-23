// HD44780 controller emulation (4-bit and 8-bit parallel interface, DDRAM/CGRAM, cursor, blink).
export class HD44780 {
  constructor(cols, rows, font) {
    this.cols = cols; this.rows = rows;
    this.font = new Uint8Array(font);           // private copy: CGRAM writes patch chars 0..7
    this.ddram = new Uint8Array(128).fill(0x20);
    this.cgram = new Uint8Array(64);
    this.addr = 0; this.inCG = false; this.inc = true; this.shift = false;
    this.displayOn = false; this.cursorOn = false; this.blinkOn = false;
    this.fourBit = false; this.nibble = null; this.dl8 = true; this.twoLine = true;
    this.shiftOffset = 0;
    this.dirty = true; this.fontDirty = false;
    this.cmds = 0;
  }
  rowBase(r) { return this.cols === 20 ? [0x00, 0x40, 0x14, 0x54][r] : [0x00, 0x40][r]; }

  // called on the falling edge of E with sampled signals
  clock(rs, d /* 8-bit value if 8-bit interface; high nibble in bits 4..7 for 4-bit */, only4) {
    if (only4) {
      if (!this.fourBit) {
        // still in the power-on 8-bit interface: only the high nibble is wired
        const cmd = d & 0xf0;
        if (cmd === 0x20) { this.fourBit = true; this.nibble = null; this.dl8 = false; }
        return;
      }
      if (this.nibble === null) { this.nibble = d & 0xf0; return; }
      const byte = this.nibble | ((d >> 4) & 0x0f);
      this.nibble = null;
      this._byte(rs, byte);
    } else {
      this._byte(rs, d & 0xff);
    }
  }

  _byte(rs, b) {
    this.cmds++;
    if (rs) { this._data(b); return; }
    if (b === 0x01) { this.ddram.fill(0x20); this.addr = 0; this.inCG = false; this.shiftOffset = 0; this.inc = true; }
    else if ((b & 0xfe) === 0x02) { this.addr = 0; this.inCG = false; this.shiftOffset = 0; }
    else if ((b & 0xfc) === 0x04) { this.inc = !!(b & 2); this.shift = !!(b & 1); }
    else if ((b & 0xf8) === 0x08) { this.displayOn = !!(b & 4); this.cursorOn = !!(b & 2); this.blinkOn = !!(b & 1); }
    else if ((b & 0xf0) === 0x10) {
      const sc = b & 8, right = b & 4;
      if (sc) this.shiftOffset = (this.shiftOffset + (right ? -1 : 1) + 40) % 40;
      else this.addr = (this.addr + (right ? 1 : -1) + 128) % 128;
    }
    else if ((b & 0xe0) === 0x20) { this.twoLine = !!(b & 8); this.dl8 = !!(b & 16); }
    else if ((b & 0xc0) === 0x40) { this.inCG = true; this.addr = b & 0x3f; }
    else if (b & 0x80) { this.inCG = false; this.addr = b & 0x7f; }
    this.dirty = true;
  }

  _data(b) {
    if (this.inCG) {
      this.cgram[this.addr & 0x3f] = b & 0x1f;
      const ch = (this.addr >> 3) & 7;
      this.font[ch * 8 + (this.addr & 7)] = b & 0x1f; this.fontDirty = true;
      this.addr = (this.addr + (this.inc ? 1 : -1)) & 0x3f;
    } else {
      this.ddram[this.addr & 0x7f] = b;
      if (this.shift) this.shiftOffset = (this.shiftOffset + (this.inc ? 1 : -1) + 40) % 40;
      this.addr = (this.addr + (this.inc ? 1 : -1)) & 0x7f;
    }
    this.dirty = true;
  }

  // visible characters as Uint8Array(cols*rows) + cursor position
  snapshot() {
    const out = new Uint8Array(this.cols * this.rows).fill(0x20);
    if (this.displayOn) {
      const rows = this.twoLine ? this.rows : Math.min(this.rows, 1);
      for (let r = 0; r < rows; r++) {
        const base = this.rowBase(r);
        for (let c = 0; c < this.cols; c++) {
          const off = (c + this.shiftOffset + 40) % 40;
          out[r * this.cols + c] = this.ddram[(base + off) & 0x7f];
        }
      }
    }
    let cx = -1, cy = -1;
    for (let r = 0; r < this.rows; r++) {
      const base = this.rowBase(r);
      const rel = this.addr - base;
      if (!this.inCG && rel >= 0 && rel < 40) {
        const col = (rel - this.shiftOffset + 40) % 40;
        if (col < this.cols) { cx = col; cy = r; }
      }
    }
    return { chars: out, cx, cy };
  }
}
