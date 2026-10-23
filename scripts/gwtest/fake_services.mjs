// Local stand-ins for IoT services used by the gateway tests: Blynk (binary protocol) on 8080, Telegram Bot API
// over HTTPS on 443, a web server on 8000, UDP echo on 5683. Control/stats: http://127.0.0.1:7999/
import net from 'node:net'; import https from 'node:https'; import http from 'node:http'; import dgram from 'node:dgram'; import { readFileSync } from 'node:fs';
const T = new URL('.', import.meta.url).pathname;
import { existsSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
if (!existsSync(T + 'key.pem')) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', T + 'key.pem', '-out', T + 'cert.pem', '-days', '30', '-subj', '/CN=api.telegram.org'], { stdio: 'ignore' }); // ensureCert
const st = { blynkLogin: null, vw: [], tg: [] }; let bsock = null;
net.createServer((s) => {
  bsock = s; let buf = Buffer.alloc(0);
  s.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 5) {
      const type = buf[0], id = buf.readUInt16BE(1), len = buf.readUInt16BE(3);
      if (type === 0) { buf = buf.subarray(5); continue; }
      if (buf.length < 5 + len) break;
      const body = buf.subarray(5, 5 + len).toString('latin1'); buf = buf.subarray(5 + len);
      const ack = () => { const h = Buffer.alloc(5); h.writeUInt16BE(id, 1); h.writeUInt16BE(200, 3); s.write(h); };
      if (type === 29 || type === 2) { st.blynkLogin = body; ack(); } else if (type === 20) { const p = body.split('\0'); if (p[0] === 'vw') st.vw.push(p.slice(1)); } else ack();
    }
  });
  s.on('error', () => {});
}).listen(8080, '127.0.0.1');
let gave = false;
https.createServer({ key: readFileSync(T + 'key.pem'), cert: readFileSync(T + 'cert.pem') }, (req, res) => {
  let body = ''; req.on('data', (d) => (body += d)); req.on('end', () => {
    const u = new URL(req.url, 'https://x');
    if (u.pathname.endsWith('/sendMessage')) { let j = {}; try { j = JSON.parse(body); } catch { j = Object.fromEntries(u.searchParams); } st.tg.push(j.text); res.end('{"ok":true,"result":{"message_id":1}}'); }
    else if (u.pathname.endsWith('/getUpdates')) { const r = gave ? [] : [{ update_id: 5001, message: { message_id: 9, from: { id: 999, first_name: 'Afta' }, chat: { id: 999, type: 'private' }, date: 1761200000, text: '/led_on' } }]; gave = true; res.end(JSON.stringify({ ok: true, result: r })); }
    else res.end('{"ok":true,"result":{}}');
  });
}).listen(443, '127.0.0.1');
http.createServer((req, res) => res.end('halo dari server: ' + req.url)).listen(8000, '127.0.0.1');
const udp = dgram.createSocket('udp4'); udp.on('message', (m, r) => udp.send(Buffer.from('ECHO:' + m), r.port, r.address)); udp.bind(5683, '127.0.0.1');
http.createServer((req, res) => {
  if (req.url === '/reset') { st.blynkLogin = null; st.vw = []; st.tg = []; gave = false; }
  if (req.url.startsWith('/blynk/')) { const [, , pin, val] = req.url.split('/'); const b = Buffer.from(`vw\0${pin}\0${val}`, 'latin1'); const h = Buffer.alloc(5); h[0] = 20; h.writeUInt16BE(7, 1); h.writeUInt16BE(b.length, 3); bsock?.write(Buffer.concat([h, b])); }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(st));
}).listen(7999, '127.0.0.1');
console.log('fake services ready');
