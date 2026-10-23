// IoT network gateway client. The simulated board's WiFiClient / WiFiClientSecure / WiFiUDP sockets are carried
// over ONE WebSocket to the compile server's /net endpoint, which opens the real TCP / TLS / UDP connections
// (the same idea as Wokwi's public IoT gateway). Binary frames: [u16 socket id][payload]. Control: JSON text.
export class NetGateway {
  constructor(url, log) {
    this.url = url;            // wss://…/net (empty = no gateway configured)
    this.log = log || (() => {});
    this.ws = null; this.ready = null; this.socks = new Map(); this.pending = new Map(); this.nextId = 1; this.bytes = 0;
  }
  _open() {
    if (this.ready) return this.ready;
    if (!this.url) return (this.ready = Promise.reject(new Error('gateway jaringan belum diatur')));
    if (Date.now() < (this.retryAt || 0)) return Promise.reject(new Error('gateway belum bisa dihubungi, mencoba lagi sebentar lagi'));
    this.ready = new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      ws.binaryType = 'arraybuffer';
      const t = setTimeout(() => { reject(new Error('gateway tidak menjawab (server mungkin sedang bangun, coba lagi)')); try { ws.close(); } catch { /* ignore */ } }, 20000);
      ws.onopen = () => { clearTimeout(t); this.ws = ws; this.backoff = 0; resolve(ws); };
      ws.onerror = () => { clearTimeout(t); this.retryAt = Date.now() + (this.backoff = Math.min(30000, (this.backoff || 2500) * 2)); reject(new Error('tidak bisa tersambung ke gateway')); };
      ws.onclose = () => {
        clearTimeout(t); this.ws = null; this.ready = null;
        for (const s of this.socks.values()) s.closed = true;
        for (const [, p] of this.pending) p({ ok: false, err: 'koneksi gateway terputus' });
        this.pending.clear();
      };
      ws.onmessage = (ev) => this._msg(ev.data);
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }
  _msg(data) {
    if (typeof data !== 'string') {
      const u8 = new Uint8Array(data); const id = u8[0] | (u8[1] << 8); const s = this.socks.get(id);
      if (s) { s.chunks.push(u8.subarray(2)); s.avail += u8.length - 2; this.bytes += u8.length - 2; }
      return;
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.op === 'connected' || m.op === 'dns') { const p = this.pending.get((m.op === 'dns' ? 'd' : 's') + m.id); if (p) { this.pending.delete((m.op === 'dns' ? 'd' : 's') + m.id); p(m); } }
    else if (m.op === 'closed') { const s = this.socks.get(m.id); if (s) s.closed = true; }
    else if (m.op === 'udp') { const s = this.socks.get(m.id); if (s) s.packets.push({ from: m.from, port: m.port, data: hex(m.data) }); }
    else if (m.op === 'udperr') this.log('warn', `UDP: ${m.err}`);
    else if (m.op === 'bye') this.log('warn', `Gateway menutup koneksi: ${m.reason}`);
  }
  _send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(typeof o === 'string' ? o : o instanceof Uint8Array ? o : JSON.stringify(o)); return true; } return false; }

  /** @returns {Promise<number>} socket id (>0) or -1 */
  async open(host, port, tls) {
    try { await this._open(); } catch (e) { this.log('warn', `WiFiClient.connect("${host}", ${port}) gagal: ${e.message}.`); return -1; }
    const id = this.nextId++ & 0xffff || this.nextId++;
    const s = { id, host, port, chunks: [], avail: 0, closed: false, packets: [] };
    this.socks.set(id, s);
    const r = await new Promise((res) => { this.pending.set('s' + id, res); this._send({ op: 'connect', id, host, port, tls: !!tls }); setTimeout(() => { if (this.pending.delete('s' + id)) res({ ok: false, err: 'waktu habis' }); }, 15000); });
    if (!r.ok) { this.socks.delete(id); this.log('warn', `${tls ? 'TLS' : 'TCP'} ${host}:${port} gagal: ${r.err}`); return -1; }
    this.log('info', `🔌 ${tls ? 'TLS' : 'TCP'} tersambung ke ${host}:${port} lewat gateway`);
    return id;
  }
  async dns(host) {
    try { await this._open(); } catch (e) { this.log('warn', `DNS ${host}: ${e.message}`); return null; }
    const id = this.nextId++;
    const r = await new Promise((res) => { this.pending.set('d' + id, res); this._send({ op: 'dns', id, host }); setTimeout(() => { if (this.pending.delete('d' + id)) res({ ip: null }); }, 10000); });
    return r.ip || null;
  }
  avail(id) { const s = this.socks.get(id); if (!s) return -1; return s.avail === 0 && s.closed ? -1 : s.avail; }
  read(id, n) {
    const s = this.socks.get(id); if (!s || !s.avail) return new Uint8Array(0);
    const out = new Uint8Array(Math.min(n, s.avail)); let k = 0;
    while (k < out.length) { const c = s.chunks[0]; const take = Math.min(c.length, out.length - k); out.set(c.subarray(0, take), k); k += take; if (take === c.length) s.chunks.shift(); else s.chunks[0] = c.subarray(take); }
    s.avail -= k; return out;
  }
  write(id, bytes) {
    const s = this.socks.get(id); if (!s || s.closed) return -1;
    const f = new Uint8Array(bytes.length + 2); f[0] = id & 255; f[1] = id >> 8; f.set(bytes, 2);
    return this._send(f) ? bytes.length : -1;
  }
  close(id) { if (this.socks.delete(id)) this._send({ op: 'close', id }); }
  udpSend(id, host, port, bytes) {
    if (!this.socks.has(id)) this.socks.set(id, { id, chunks: [], avail: 0, closed: false, packets: [] });
    this._open().then(() => this._send({ op: 'udp', id, host, port, data: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') }), (e) => this.log('warn', `UDP ${host}:${port}: ${e.message}`));
    return bytes.length;
  }
  udpRecv(id) { const s = this.socks.get(id); return s && s.packets.length ? s.packets.shift() : null; }
  dispose() { try { this.ws?.close(); } catch { /* ignore */ } this.socks.clear(); this.ws = null; this.ready = null; }
}
const hex = (h) => { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; };
