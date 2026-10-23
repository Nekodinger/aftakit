// NXP MFRC522 13.56 MHz reader (SPI register interface) with an ISO 14443-A MIFARE Classic 1K card in its field.
// Implements what the MFRC522 Arduino library uses: FIFO, ComIrq / DivIrq, Transceive, CalcCRC, MFAuthent, SoftReset,
// and on the card side REQA / WUPA, anticollision + select (cascade level 1, 4-byte UID), HLTA, authentication with
// key A / key B, 16-byte READ and two-step WRITE.

export function crcA(bytes) {
  let crc = 0x6363;
  for (let b of bytes) { b ^= crc & 0xff; b = (b ^ (b << 4)) & 0xff; crc = ((crc >> 8) ^ (b << 8) ^ (b << 3) ^ (b >> 4)) & 0xffff; }
  return [crc & 0xff, crc >> 8];
}

export class MifareClassic {
  constructor(uid) {
    this.uid = uid; this.state = 'idle'; this.auth = -1;
    this.mem = Array.from({ length: 64 }, () => new Uint8Array(16));
    const bcc = uid.reduce((a, b) => a ^ b, 0);
    this.mem[0].set([...uid, bcc, 0x08, 0x04, 0x00, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69]);
    for (let s = 0; s < 16; s++) this.mem[s * 4 + 3].set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x07, 0x80, 0x69, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }
  get bcc() { return this.uid.reduce((a, b) => a ^ b, 0); }
  // one frame from the reader; bits = number of valid bits in the last byte (0 = 8). Returns { data, bits } or null (no answer)
  frame(d, bits, crypto) {
    const c = d[0];
    if (bits === 7 && d.length === 1) {                              // short frame: REQA / WUPA
      if (c === 0x52 || (c === 0x26 && this.state !== 'halt')) { this.state = 'ready'; this.auth = -1; return { data: [0x04, 0x00], bits: 0 }; }
      if (c === 0x26 && this.state === 'ready') return null;
      if (this.state !== 'halt') this.state = 'idle';
      return null;
    }
    if (c === 0x93 && this.state === 'ready') {
      if (d[1] === 0x20) return { data: [...this.uid, this.bcc], bits: 0 };   // anticollision: whole UID CL1
      if (d[1] === 0x70 && d.length >= 7) {
        if (d.slice(2, 6).every((x, i) => x === this.uid[i])) { this.state = 'active'; return { data: [0x08, ...crcA([0x08])], bits: 0 }; }   // SAK: MIFARE Classic 1K
        return null;
      }
      return null;
    }
    if (this.state !== 'active') { if (this.state === 'ready') this.state = 'idle'; return null; }
    if (c === 0x50 && d[1] === 0x00) { this.state = 'halt'; this.auth = -1; return null; }                  // HLTA: no answer
    if (this.pendingWrite !== undefined) {                             // 2nd step of WRITE: 16 data bytes + CRC
      const blk = this.pendingWrite; this.pendingWrite = undefined;
      if (d.length < 16) return { data: [0x00], bits: 4 };
      if (blk !== 0) this.mem[blk].set(d.slice(0, 16));                // block 0 (manufacturer) is read-only
      return { data: [0x0a], bits: 4 };
    }
    if (c === 0x30) {                                                  // READ block
      const blk = d[1]; if (blk > 63 || !crypto || this.auth !== blk >> 2) { this.state = 'idle'; return { data: [0x04], bits: 4 }; }
      const out = [...this.mem[blk]]; if ((blk & 3) === 3) for (let i = 0; i < 6; i++) out[i] = 0;    // key A is never readable
      return { data: [...out, ...crcA(out)], bits: 0 };
    }
    if (c === 0xa0) {                                                  // WRITE step 1
      const blk = d[1]; if (blk > 63 || !crypto || this.auth !== blk >> 2) return { data: [0x04], bits: 4 };
      this.pendingWrite = blk; return { data: [0x0a], bits: 4 };
    }
    this.state = 'idle'; return null;
  }
  authenticate(cmd, blk, key, uid) {
    if (this.state !== 'active' || blk > 63 || !uid.every((x, i) => x === this.uid[i])) return false;
    const t = this.mem[(blk | 3)], k = cmd === 0x60 ? t.slice(0, 6) : t.slice(10, 16);
    if (!key.every((x, i) => x === k[i])) { this.state = 'idle'; return false; }
    this.auth = blk >> 2; return true;
  }
}

const R = { Command: 0x01, ComIEn: 0x02, DivIEn: 0x03, ComIrq: 0x04, DivIrq: 0x05, Error: 0x06, Status1: 0x07, Status2: 0x08, FIFOData: 0x09, FIFOLevel: 0x0a,
  Control: 0x0c, BitFraming: 0x0d, Coll: 0x0e, TxControl: 0x14, CRCResultH: 0x21, CRCResultL: 0x22, Version: 0x37 };

export class MFRC522 {
  constructor(label, getCard) { this.label = label; this.getCard = getCard; this.reset(); }
  reset() {
    this.reg = new Uint8Array(64); this.fifo = []; this.mode = null; this.pending = 0; this.wreg = -1;
    const r = this.reg; r[R.Command] = 0x20; r[R.ComIEn] = 0x80; r[R.ComIrq] = 0x14; r[R.Status1] = 0x21; r[0x11] = 0x3f; r[R.TxControl] = 0x80; r[0x15] = 0x00;
    r[0x24] = 0x26; r[0x26] = 0x48; r[0x0b] = 0x08; r[R.Version] = 0x92;
  }
  // ---- SPI framing: address byte (bit 7 = read, bits 6..1 = register), then data bytes; a read answers in the next byte
  csChange(low) { if (low) { this.mode = null; this.pending = 0; } }
  transfer(b) {
    const ret = this.pending;
    if (this.mode === 'w') { this._write(this.wreg, b); return 0; }
    const a = (b >> 1) & 0x3f;
    if (b & 0x80) { this.mode = 'r'; this.pending = this._read(a); }
    else if (this.mode === null) { this.mode = 'w'; this.wreg = a; this.pending = 0; }
    else this.pending = 0;                                            // trailing 0x00 of a read burst
    return ret;
  }
  _read(a) {
    const r = this.reg;
    if (a === R.FIFOData) return this.fifo.length ? this.fifo.shift() : 0;
    if (a === R.FIFOLevel) return Math.min(64, this.fifo.length);
    if (a === R.Status1) return (this.fifo.length === 0 ? 0x01 : 0) | 0x20 | (r[R.ComIrq] & r[R.ComIEn] & 0x7f ? 0x10 : 0);
    return r[a];
  }
  _write(a, v) {
    const r = this.reg;
    switch (a) {
      case R.FIFOData: if (this.fifo.length < 64) this.fifo.push(v); else r[R.Error] |= 0x10; return;
      case R.FIFOLevel: if (v & 0x80) { this.fifo = []; r[R.Error] &= ~0x10; } return;
      case R.ComIrq: if (v & 0x80) r[a] |= v & 0x7f; else r[a] &= ~(v & 0x7f); return;
      case R.DivIrq: if (v & 0x80) r[a] |= v & 0x7f; else r[a] &= ~(v & 0x7f); return;
      case R.Command: r[a] = v & 0x2f; this._command(v & 0x0f); return;   // PowerDown (bit 4) clears at once
      case R.BitFraming: r[a] = v & 0x7f; if (v & 0x80 && (r[R.Command] & 0x0f) === 0x0c) this._transceive(); return;
      case R.Status2: r[a] = (r[a] & ~0x08) | (v & 0x08) | (v & 0xc0); return;   // software can clear MFCrypto1On
      case R.Version: case R.Error: case R.Coll: return;
      default: r[a] = v;
    }
  }
  _command(c) {
    const r = this.reg;
    if (c === 0x0f) { const ver = r[R.Version]; this.reset(); r[R.Version] = ver; r[R.Command] = 0x20; return; }     // SoftReset (PowerDown bit cleared at once)
    if (c === 0x03) { const [lo, hi] = crcA(this.fifo); this.fifo = []; r[R.CRCResultL] = lo; r[R.CRCResultH] = hi; r[R.DivIrq] |= 0x04; r[R.Command] &= 0xf0; return; }
    if (c === 0x0e) {                                                  // MFAuthent: FIFO = cmd, block, key[6], uid[4]
      const f = this.fifo; this.fifo = []; const card = this._card();
      if (card && f.length >= 12 && card.authenticate(f[0], f[1], f.slice(2, 8), f.slice(8, 12))) { r[R.Status2] |= 0x08; r[R.ComIrq] |= 0x10; }
      else r[R.ComIrq] |= 0x01;                                        // no answer -> timer runs out
      r[R.Command] &= 0xf0; return;
    }
  }
  _card() { return (this.reg[R.TxControl] & 0x03) === 0x03 ? this.getCard() : null; }   // antenna must be on
  _transceive() {
    const r = this.reg, tx = this.fifo; this.fifo = [];
    const txBits = r[R.BitFraming] & 7;
    r[R.Error] = 0; r[R.Control] &= ~7;
    const card = this._card();
    const ans = card ? card.frame(tx, txBits, (r[R.Status2] & 0x08) !== 0) : null;
    r[R.ComIrq] |= 0x40;                                               // TxIRq
    if (!ans) { r[R.ComIrq] |= 0x01; return; }                         // TimerIRq: no card answered
    this.fifo = ans.data.slice(0, 64); r[R.Control] = (r[R.Control] & ~7) | (ans.bits & 7);
    r[R.ComIrq] |= 0x30;                                               // RxIRq | IdleIRq
  }
}
