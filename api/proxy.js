// CORS relay for simulated ESP32 HTTP requests. Many IoT services (Google Apps Script, Telegram Bot API,
// ThingSpeak, Blynk HTTP API, Firebase…) do not send CORS headers, so a browser cannot call them directly.
// Only an allow-list of IoT / education hosts is relayed; no cookies or credentials are forwarded.
export const config = { runtime: 'edge' };

const ALLOW = [
  'script.google.com', 'script.googleusercontent.com',            // Google Apps Script web apps (Sheets logging)
  'api.telegram.org',                                             // Telegram bot: sendMessage / getUpdates
  'api.thingspeak.com', 'thingspeak.com',
  'blynk.cloud', '.blynk.cloud',                                  // Blynk IoT HTTP API (sgp1.blynk.cloud, …)
  '.firebaseio.com', '.firebasedatabase.app',                     // Firebase Realtime Database REST
  'io.adafruit.com', 'maker.ifttt.com', 'api.callmebot.com', 'ntfy.sh',
  'api.open-meteo.com', 'worldtimeapi.org', 'timeapi.io', 'api.openweathermap.org', 'httpbin.org', 'jsonplaceholder.typicode.com',
];
const okHost = (h) => ALLOW.some((a) => (a.startsWith('.') ? h.endsWith(a) : h === a));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };
const MAX = 1 << 20; // 1 MB each way

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const target = new URL(req.url).searchParams.get('url') || '';
  let u;
  try { u = new URL(target); } catch { return new Response('url tidak valid', { status: 400, headers: CORS }); }
  if (!/^https?:$/.test(u.protocol) || !okHost(u.hostname)) return new Response(`Host ${u.hostname} tidak ada di daftar yang diizinkan proxy simulator.`, { status: 403, headers: CORS });
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer();
  if (body && body.byteLength > MAX) return new Response('body terlalu besar', { status: 413, headers: CORS });
  const headers = {};
  for (const k of ['content-type', 'authorization']) { const v = req.headers.get(k); if (v) headers[k] = v; }
  let r;
  try { r = await fetch(u, { method: req.method, headers, body, redirect: 'follow' }); }
  catch (e) { return new Response('Gagal menghubungi ' + u.hostname + ': ' + e.message, { status: 502, headers: CORS }); }
  const buf = await r.arrayBuffer();
  return new Response(buf.byteLength > MAX ? buf.slice(0, MAX) : buf, { status: r.status, headers: { ...CORS, 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' } });
}
