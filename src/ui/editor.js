// Lightweight Arduino/C++ editor: textarea + highlighted overlay, gutter, error lines.
const KW = new Set('if else for while do switch case break continue return goto default const static volatile unsigned signed void struct class enum typedef sizeof new delete true false HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN public private protected'.split(' '));
const TY = new Set('int long short char byte word bool boolean float double String uint8_t uint16_t uint32_t int8_t int16_t int32_t size_t Servo LiquidCrystal Adafruit_NeoPixel Serial Wire SPI EEPROM'.split(' '));
const FN = new Set('pinMode digitalWrite digitalRead analogRead analogWrite delay delayMicroseconds millis micros tone noTone pulseIn map constrain min max abs random randomSeed attachInterrupt detachInterrupt shiftOut shiftIn setup loop begin print println write read available attach detach setCursor clear show setPixelColor setBrightness Color'.split(' '));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlightLine(s, st) {
  let out = '', i = 0;
  while (i < s.length) {
    if (st.block) { const e = s.indexOf('*/', i); if (e < 0) { out += `<span class="tk-c">${esc(s.slice(i))}</span>`; return out; } out += `<span class="tk-c">${esc(s.slice(i, e + 2))}</span>`; i = e + 2; st.block = false; continue; }
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { out += `<span class="tk-c">${esc(s.slice(i))}</span>`; return out; }
    if (c === '/' && d === '*') { st.block = true; { const e = s.indexOf('*/', i + 2); if (e >= 0) { out += `<span class="tk-c">${esc(s.slice(i, e + 2))}</span>`; i = e + 2; st.block = false; } else { out += `<span class="tk-c">${esc(s.slice(i))}</span>`; return out; } } continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } out += `<span class="tk-s">${esc(s.slice(i, j + 1))}</span>`; i = j + 1; continue; }
    if (c === '#' && /^\s*$/.test(s.slice(0, i))) { out += `<span class="tk-p">${esc(s.slice(i))}</span>`; return out; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) { const m = /^(0x[0-9a-fA-F]+|0b[01]+|\d*\.?\d+(?:[eE][+-]?\d+)?[uUlLfF]*)/.exec(s.slice(i)); const t = m ? m[0] : c; out += `<span class="tk-n">${esc(t)}</span>`; i += t.length; continue; }
    if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_]\w*/.exec(s.slice(i))[0]; const cls = KW.has(m) ? 'tk-k' : TY.has(m) ? 'tk-t' : FN.has(m) || /^\s*\(/.test(s.slice(i + m.length)) ? 'tk-f' : /^[A-Z][A-Z0-9_]{2,}$/.test(m) ? 'tk-n' : ''; out += cls ? `<span class="${cls}">${m}</span>` : m; i += m.length; continue; }
    out += esc(c); i++;
  }
  return out;
}

export class Editor {
  constructor({ ta, hl, gutter, pos, onChange, onRun }) {
    Object.assign(this, { ta, hl, gutter, pos, onChange, onRun }); this.marks = new Map();
    ta.addEventListener('input', () => { this.marks.clear(); this.render(); this.onChange?.(); });
    ta.addEventListener('scroll', () => this._sync());
    ta.addEventListener('keyup', () => this._pos()); ta.addEventListener('click', () => this._pos());
    ta.addEventListener('keydown', (e) => this._key(e));
  }
  get value() { return this.ta.value; }
  set value(v) { this.ta.value = v; this.marks.clear(); this.render(); }
  setMarks(list) { this.marks = new Map(); for (const d of list) if (!this.marks.has(d.line) || d.severity === 'error') this.marks.set(d.line, d.severity); this.render(); }
  goto(line, col = 1) {
    const lines = this.ta.value.split('\n'); let off = 0; for (let i = 0; i < Math.min(line - 1, lines.length); i++) off += lines[i].length + 1;
    off += Math.min(col - 1, (lines[line - 1] || '').length);
    this.ta.focus(); this.ta.setSelectionRange(off, off);
    this.ta.scrollTop = Math.max(0, (line - 4) * 20); this._sync(); this._pos();
  }
  render() {
    const cls = (n) => ({ error: 'err', warn: 'warn' }[this.marks.get(n)] || '');
    const lines = this.ta.value.split('\n'), st = { block: false };
    this.hl.innerHTML = lines.map((l, i) => `<span class="ln ${cls(i + 1)}">${highlightLine(l, st) || ' '}</span>`).join('');
    this.gutter.innerHTML = lines.map((_, i) => `<div class="${cls(i + 1)}">${i + 1}</div>`).join('');
    this._sync();
  }
  _sync() { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; this.gutter.scrollTop = this.ta.scrollTop; }
  _pos() { const v = this.ta.value.slice(0, this.ta.selectionStart).split('\n'); this.pos.textContent = `Baris ${v.length}, Kolom ${v[v.length - 1].length + 1}`; }
  _key(e) {
    const ta = this.ta;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.onRun?.(); return; }
    if (e.key === 'Tab') {
      e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd;
      if (s === en && !e.shiftKey) { this._ins('  '); return; }
      const v = ta.value, ls = v.lastIndexOf('\n', s - 1) + 1, block = v.slice(ls, en), lines = block.split('\n');
      const nb = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l)).join('\n');
      ta.setSelectionRange(ls, en); this._ins(nb); ta.setSelectionRange(ls, ls + nb.length); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault(); const v = ta.value, s = ta.selectionStart, ls = v.lastIndexOf('\n', s - 1) + 1; let ind = /^[ \t]*/.exec(v.slice(ls, s))[0];
      const before = v.slice(ls, s).trimEnd(); if (before.endsWith('{')) ind += '  ';
      if (v[s] === '}' && before.endsWith('{')) { const rest = ind.slice(0, -2); this._ins('\n' + ind + '\n' + rest); const p = s + 1 + ind.length; ta.setSelectionRange(p, p); } else this._ins('\n' + ind);
      return;
    }
    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"' };
    if (pairs[e.key] && ta.selectionStart === ta.selectionEnd) { const nxt = ta.value[ta.selectionStart]; if (e.key === '"' && nxt === '"') { e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1); return; } e.preventDefault(); this._ins(e.key + pairs[e.key]); ta.setSelectionRange(ta.selectionStart - 1, ta.selectionStart - 1); return; }
    if ([')', ']', '}'].includes(e.key) && ta.value[ta.selectionStart] === e.key) { e.preventDefault(); ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1); }
  }
  _ins(text) { this.ta.focus(); if (!document.execCommand('insertText', false, text)) { const { selectionStart: s, selectionEnd: e, value: v } = this.ta; this.ta.value = v.slice(0, s) + text + v.slice(e); this.ta.setSelectionRange(s + text.length, s + text.length); this.ta.dispatchEvent(new Event('input')); } }
}
