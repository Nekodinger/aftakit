// IoT network gateway (WebSocket) for the simulator: the simulated board's WiFiClient / WiFiClientSecure / WiFiUDP
// become real outgoing TCP / TLS / UDP connections, like Wokwi's public IoT gateway. Same protocol and limits as
// server/server.py: binary frames [u16 socket id][payload]; JSON control messages {op: connect|close|dns|udp}.
// Vercel closes a WebSocket at the function's max duration (300 s on Hobby): the browser reconnects and the
// sketch's libraries (Blynk, PubSubClient, …) reconnect their sockets, exactly as after a WiFi drop.
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { WebSocketServer } from 'ws';

const TCP_PORTS = new Set([80, 443, 1883, 8883, 8080, 8443, 8000, 8001, 8081, 9443, 5683]);
const UDP_PORTS = new Set([53, 123, 5683, 1900]);
const MAX_SOCKS = 8, IDLE_MS = 180000, MAX_BYTES = 20 << 20;

function isPublic(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return false;
  const [a, b] = p;
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
}
// tests only: map hostnames to local stand-ins and allow private addresses
const HOSTMAP = Object.fromEntries((process.env.GATEWAY_HOSTMAP || '').split(',').filter((x) => x.includes('=')).map((x) => x.split('=')));
const ALLOW_PRIVATE = process.env.GATEWAY_ALLOW_PRIVATE === '1', INSECURE_TLS = process.env.GATEWAY_INSECURE_TLS === '1';
async function resolve(host) {
  host = HOSTMAP[host] || host;
  const ip = net.isIP(host) === 4 ? host : (await dns.lookup(host, { family: 4 })).address;
  if (!isPublic(ip) && !ALLOW_PRIVATE) throw new Error(`alamat ${host} tidak diizinkan`);
  return ip;
}

const server = http.createServer((req, res) => { res.writeHead(426, { 'Content-Type': 'text/plain' }); res.end('WebSocket only'); });
const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });

wss.on('connection', (ws) => {
  const socks = new Map(); let used = 0, last = Date.now();
  const sendJson = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const sendData = (id, buf) => { used += buf.length; if (ws.readyState === 1) { const f = Buffer.allocUnsafe(buf.length + 2); f.writeUInt16LE(id, 0); buf.copy(f, 2); ws.send(f); } };
  const closeAll = () => { for (const s of socks.values()) { try { s.kind === 'udp' ? s.sock.close() : s.sock.destroy(); } catch { /* ignore */ } } socks.clear(); };
  const idle = setInterval(() => {
    if (Date.now() - last > IDLE_MS || used > MAX_BYTES) { sendJson({ op: 'bye', reason: used > MAX_BYTES ? 'kuota data gateway habis' : 'idle' }); ws.close(); }
  }, 10000);

  async function connect(m) {
    const id = m.id | 0, host = String(m.host).slice(0, 253), port = m.port | 0, secure = !!m.tls;
    if (socks.size >= MAX_SOCKS) return sendJson({ op: 'connected', id, ok: false, err: `terlalu banyak koneksi terbuka (maks ${MAX_SOCKS})` });
    if (!TCP_PORTS.has(port)) return sendJson({ op: 'connected', id, ok: false, err: `port ${port} tidak diizinkan gateway` });
    let ip;
    try { ip = await resolve(host); } catch (e) { return sendJson({ op: 'connected', id, ok: false, err: e.message }); }
    const sock = secure ? tls.connect({ host: ip, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !INSECURE_TLS }) : net.connect({ host: ip, port });
    const timer = setTimeout(() => sock.destroy(new Error('waktu habis')), 10000);
    let opened = false;
    sock.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); opened = true; socks.set(id, { kind: 'tcp', sock }); sendJson({ op: 'connected', id, ok: true, ip }); });
    sock.on('data', (d) => { last = Date.now(); sendData(id, d); });
    sock.on('error', (e) => { if (!opened) { clearTimeout(timer); sendJson({ op: 'connected', id, ok: false, err: e.message }); } });
    sock.on('close', () => { if (opened) { socks.delete(id); sendJson({ op: 'closed', id }); } });
  }
  async function udp(m) {
    const id = m.id | 0, port = m.port | 0;
    if (!UDP_PORTS.has(port)) return sendJson({ op: 'udperr', id, err: `port UDP ${port} tidak diizinkan gateway` });
    try {
      const ip = await resolve(String(m.host).slice(0, 253));
      let s = socks.get(id);
      if (!s) {
        const sock = dgram.createSocket('udp4');
        sock.on('message', (d, r) => { last = Date.now(); used += d.length; sendJson({ op: 'udp', id, from: r.address, port: r.port, data: d.toString('hex') }); });
        sock.on('error', () => {});
        s = { kind: 'udp', sock }; socks.set(id, s);
      }
      const data = Buffer.from(String(m.data || ''), 'hex').subarray(0, 1500); used += data.length;
      s.sock.send(data, port, ip);
    } catch (e) { sendJson({ op: 'udperr', id, err: e.message }); }
  }
  async function lookup(m) {
    try { sendJson({ op: 'dns', id: m.id, ip: await resolve(String(m.host).slice(0, 253)) }); }
    catch (e) { sendJson({ op: 'dns', id: m.id, ip: null, err: e.message }); }
  }

  ws.on('message', (data, isBinary) => {
    last = Date.now();
    if (isBinary) {
      const buf = Buffer.from(data); if (buf.length < 2) return;
      const s = socks.get(buf.readUInt16LE(0));
      if (s && s.kind === 'tcp') { used += buf.length - 2; s.sock.write(buf.subarray(2)); }
      if (used > MAX_BYTES) { sendJson({ op: 'bye', reason: 'kuota data gateway habis' }); ws.close(); }
      return;
    }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.op === 'connect') connect(m);
    else if (m.op === 'udp') udp(m);
    else if (m.op === 'dns') lookup(m);
    else if (m.op === 'close') { const s = socks.get(m.id | 0); if (s) { socks.delete(m.id | 0); try { s.kind === 'udp' ? s.sock.close() : s.sock.destroy(); } catch { /* ignore */ } } }
  });
  ws.on('close', () => { clearInterval(idle); closeAll(); });
  ws.on('error', () => {});
});

export default server;
