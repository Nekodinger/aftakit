// UART modules: GPS NEO-6M (NMEA), Bluetooth HC-05 (bridged to the Bluetooth terminal), GSM SIM800L and
// ESP-01 (ESP8266 AT firmware with real HTTP through the browser).
import { H } from './behaviors2.js';
import { uartLink, nmea } from './uart.js';

const { live, attr } = H;
const US = 16;
const te = new TextEncoder(), td = new TextDecoder();
const vAcross = (ctx, v, hiPin, loPin = 'GND') => { const a = v(ctx.n(hiPin)), b = v(ctx.n(loPin)); return live(a) && live(b) && b < 0.25 ? (a - b) * 5 : 0; };

// AT command line splitter: collects bytes until CR / LF
function lineReader(onLine, { echo } = {}) {
  let buf = '';
  return (b) => {
    if (echo?.()) echo.send(String.fromCharCode(b));
    if (b === 13 || b === 10) { const l = buf; buf = ''; if (l.length) onLine(l); return; }
    if (b === 8 && buf.length) { buf = buf.slice(0, -1); return; }
    if (buf.length < 600) buf += String.fromCharCode(b);
  };
}

// ------------------------------------------------------------------ GPS NEO-6M: RMC + GGA + GSA + GSV once per second
const gps = (ctx) => {
  let link = null, pw = 0, t0 = 0, timer = 0, gen = 0;
  const pad = (n, w) => String(Math.floor(n)).padStart(w, '0');
  const deg = (x, w) => { const a = Math.abs(x), d = Math.floor(a), m = (a - d) * 60; return pad(d, w) + m.toFixed(5).padStart(8, '0'); };
  const sentences = () => {
    const now = new Date(t0 + ctx.sim.board.cpu.cycles / 16000);
    const hh = pad(now.getUTCHours(), 2) + pad(now.getUTCMinutes(), 2) + pad(now.getUTCSeconds(), 2) + '.00';
    const date = pad(now.getUTCDate(), 2) + pad(now.getUTCMonth() + 1, 2) + pad(now.getUTCFullYear() % 100, 2);
    const fix = attr(ctx, 'fix', 'ya') !== 'tidak';
    const lat = +attr(ctx, 'lat', -6.2), lng = +attr(ctx, 'lng', 106.816666), alt = +attr(ctx, 'alt', 8), kmh = +attr(ctx, 'speed', 0), sats = fix ? +attr(ctx, 'sats', 8) : 0;
    const la = deg(lat, 2), ns = lat < 0 ? 'S' : 'N', lo = deg(lng, 3), ew = lng < 0 ? 'W' : 'E', kn = (kmh / 1.852).toFixed(3);
    if (!fix) return [nmea(`GPRMC,${hh},V,,,,,,,${date},,,N`), nmea(`GPGGA,${hh},,,,,0,00,99.99,,,,,,`), nmea('GPGSA,A,1,,,,,,,,,,,,,99.99,99.99,99.99'), nmea('GPGSV,1,1,00')];
    const ids = [2, 5, 7, 9, 13, 15, 20, 24, 28, 30, 31, 32].slice(0, Math.max(0, Math.min(12, sats)));
    const gsv = [];
    for (let i = 0; i < ids.length; i += 4) gsv.push(nmea(`GPGSV,${Math.ceil(ids.length / 4)},${i / 4 + 1},${pad(ids.length, 2)},` + ids.slice(i, i + 4).map((id, k) => `${pad(id, 2)},${pad(20 + ((id * 7) % 60), 2)},${pad((id * 37) % 360, 3)},${30 + ((id + k) % 15)}`).join(',')));
    return [
      nmea(`GPRMC,${hh},A,${la},${ns},${lo},${ew},${kn},${(+attr(ctx, 'course', 0)).toFixed(2)},${date},,,A`),
      nmea(`GPVTG,${(+attr(ctx, 'course', 0)).toFixed(2)},T,,M,${kn},N,${kmh.toFixed(3)},K,A`),
      nmea(`GPGGA,${hh},${la},${ns},${lo},${ew},1,${pad(sats, 2)},0.92,${alt.toFixed(1)},M,4.0,M,,`),
      nmea(`GPGSA,A,3,${ids.map((i) => pad(i, 2)).concat(Array(12 - ids.length).fill('')).join(',')},1.65,0.92,1.37`),
      ...gsv,
      nmea(`GPGLL,${la},${ns},${lo},${ew},${hh},A,A`),
    ];
  };
  const tick = (my) => {
    if (my !== gen) return;
    if (pw >= 2.7) link.send(sentences().join(''));
    ctx.sim.after(16e6, () => tick(my));
  };
  return {
    attach() {
      link = uartLink(ctx, { rx: 'RX', tx: 'TX' }, { baud: () => +attr(ctx, 'baud', 9600), onByte() {} });
      if (!ctx.sim.arduinoPinsOnNet(ctx.n('TX')).length) ctx.sim.warn(`gps-tx-${ctx.part.id}`, `${ctx.label}: pin TX GPS belum terhubung ke pin RX Arduino/ESP32 (TX modul → RX mikrokontroler).`);
    },
    drivers1: () => (pw >= 2.7 ? link.drivers(pw / 5) : []),
    drivers2(v) { pw = vAcross(ctx, v, 'VCC'); return []; },
    render() { if (pw < 2.7 && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VCC ke 5V/3.3V dan GND ke GND.`); },
    reset() { gen++; link?.reset(); t0 = Date.now(); const my = gen; ctx.sim.after(16e6 * 0.5, () => tick(my)); },
  };
};

// ------------------------------------------------------------------ HC-05: transparent serial <-> Bluetooth terminal; AT mode with EN/KEY high
const hc05 = (ctx) => {
  let link = null, pw = 0, at = false, name = 'HC-05', pin = '1234', baud = 9600, connected = false, reader = null, role = 0;
  const reply = (s) => ctx.sim.after(3 * 1000 * US, () => link.send(s + '\r\n'));      // ~3 ms processing time
  const cmd = (l) => {
    const u = l.trim(), U = u.toUpperCase();
    if (U === 'AT') return reply('OK');
    if (U === 'AT+NAME?' || U === 'AT+NAME') return reply(`+NAME:${name}\r\nOK`);
    if (U.startsWith('AT+NAME=')) { name = u.slice(8) || name; return reply('OK'); }
    if (U === 'AT+VERSION?' || U === 'AT+VERSION') return reply('+VERSION:3.0-20170601\r\nOK');
    if (U === 'AT+ADDR?') return reply('+ADDR:98d3:31:fb1a2c\r\nOK');
    if (U === 'AT+PSWD?' || U === 'AT+PIN?') return reply(`+PIN:"${pin}"\r\nOK`);
    if (U.startsWith('AT+PSWD=') || U.startsWith('AT+PIN=')) { pin = u.split('=')[1].replace(/"/g, ''); return reply('OK'); }
    if (U === 'AT+UART?') return reply(`+UART:${baud},0,0\r\nOK`);
    if (U.startsWith('AT+UART=')) { const b = parseInt(u.slice(8)); if (b) baud = b; return reply('OK'); }
    if (U === 'AT+ROLE?') return reply(`+ROLE:${role}\r\nOK`);
    if (U.startsWith('AT+ROLE=')) { role = +u.slice(8) || 0; return reply('OK'); }
    if (U === 'AT+STATE?') return reply('+STATE:INITIALIZED\r\nOK');
    if (U === 'AT+RESET') return reply('OK');
    if (U === 'AT+ORGL') { name = 'HC-05'; pin = '1234'; baud = 9600; return reply('OK'); }
    if (U.startsWith('AT+')) return reply('OK');
    return reply('ERROR:(0)');
  };
  return {
    attach() {
      const sim = ctx.sim;
      reader = lineReader(cmd);
      link = uartLink(ctx, { rx: 'RXD', tx: 'TXD' }, {
        baud: () => (at ? 38400 : baud),
        onByte(b) { if (at) reader(b); else { sim.emit('bt', { type: 'data', bytes: new Uint8Array([b]) }); } },
      });
      (sim.btModules ||= []).push((text) => { if (pw >= 3 && !at) { connected = true; sim.resolveNow(); link.send(te.encode(text)); } });
    },
    drivers1: () => (pw >= 3 ? [...link.drivers(Math.min(pw, 3.3) / 5), { net: ctx.n('STATE'), value: connected ? 3.3 / 5 : 0, label: ctx.label }] : []),
    drivers2(v) {
      const was = pw; pw = vAcross(ctx, v, 'VCC');
      if (was < 3 && pw >= 3) {                                                      // power-up: EN/KEY high -> AT mode at 38400 baud
        at = vAcross(ctx, v, 'EN') > 2; connected = false;
        if (!at) ctx.sim.emit('bt', { type: 'begin', name });
      }
      return [];
    },
    render() { if (pw < 3 && ctx.sim.running) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan VCC ke 5V dan GND ke GND.`); },
    reset() { link?.reset(); pw = 0; connected = false; },
  };
};

// ------------------------------------------------------------------ FTDI FT232RL USB-serial adapter: a serial terminal on the computer
// Bytes arriving on RXD are shown in the "USB-Serial" console tab; text typed there leaves on TXD at the terminal's baud rate.
// VCC is an output powered by USB (5 V or 3.3 V jumper, which also sets the TXD/DTR logic level). DTR idles HIGH and is
// pulsed LOW by the terminal's reset button: wired to RESET (directly or through a capacitor) it restarts the program.
const ftdi = (ctx) => {
  const sim = ctx.sim;
  let link = null, dtrLow = false, lastTx = -1e12, lastRx = -1e12, checked = false;
  const vio = () => (attr(ctx, 'vio', '5V') === '3.3V' ? 3.3 : 5);
  const now = () => sim.board.cpu.cycles;
  const dtrResets = () => {
    const bp = sim.boardPart; if (!bp) return false;
    const r = sim.circuit.net(bp.id, 'RESET'), d = ctx.n('DTR');
    if (r < 0 || d < 0) return false;
    if (r === d) return true;
    return sim.model.parts.some((p) => p.type === 'mod-capacitor' && [sim.circuit.net(p.id, '+'), sim.circuit.net(p.id, '-')].sort().join() === [r, d].sort().join());
  };
  return {
    attach() {
      link = uartLink(ctx, { rx: 'RXD', tx: 'TXD' }, {
        baud: () => +attr(ctx, 'baud', 9600),
        onByte(b) { lastRx = now(); sim.emit('ftdi', { id: ctx.part.id, b }); },
      });
      (sim.ftdiPorts ||= []).push({
        id: ctx.part.id, label: ctx.label,
        send(data) { lastTx = now(); link.send(data); },
        pulseDtr() {
          dtrLow = true; sim.resolveNow();
          sim.after(1000 * US, () => { dtrLow = false; sim.resolveNow(); });
          return dtrResets();
        },
      });
    },
    drivers1: () => [
      { net: ctx.n('VCC'), value: vio() / 5, label: ctx.label + ' VCC (USB)', rail: true },
      { net: ctx.n('GND'), value: 0, label: ctx.label + ' GND', rail: true },
      ...link.drivers(vio() / 5),
      { net: ctx.n('DTR'), value: dtrLow ? 0 : vio() / 5, label: ctx.label + ' DTR' },
    ],
    render() {
      if (!checked && sim.running) {                                   // wiring checks once all modules are attached
        checked = true;
        const rx = ctx.n('RXD'), tx = ctx.n('TXD'), used = (n) => n >= 0 && (sim.arduinoPinsOnNet(n).length || sim.uart.links.some((l) => l.label !== ctx.label && (l.rxNet === n || l.txNet === n)));
        if (!used(rx) && !used(tx)) sim.warn(`ftdi-io-${ctx.part.id}`, `${ctx.label}: RXD/TXD belum terhubung. Silangkan: TXD FTDI → RX mikrokontroler/modul, RXD FTDI → TX.`);
        const gnd = ctx.n('GND'), boardGnd = sim.rails.filter((r) => r.value === 0).map((r) => r.net);
        if (boardGnd.length && !boardGnd.includes(gnd)) sim.warn(`ftdi-gnd-${ctx.part.id}`, `${ctx.label}: GND FTDI belum disatukan dengan GND board. Tanpa ground bersama, data serial tidak terbaca.`);
      }
      const t = now(), win = 16e6 * 0.04;
      ctx.el.setLed?.('pwr', true);
      ctx.el.setLed?.('tx', link?.busy() || t - lastTx < win);
      ctx.el.setLed?.('rx', t - lastRx < win);
    },
    reset() { link?.reset(); dtrLow = false; lastTx = lastRx = -1e12; checked = false; },
  };
};

// ------------------------------------------------------------------ SIM800L GSM modem (AT commands, SMS, calls)
const sim800 = (ctx) => {
  let skipLF = false;
  let link = null, pw = 0, on = false, echo = true, textMode = false, reader = null, smsTo = null, smsBuf = '', baud = 9600, ready = false, n = 0;
  const reply = (s) => ctx.sim.after(5 * 1000 * US, () => link.send('\r\n' + s + '\r\n'));   // ~5 ms processing time
  const ok = () => reply('OK');
  const info = (t) => ctx.sim.info('📱 ' + t);
  const cmd = (l) => {
    const u = l.trim(), U = u.toUpperCase();
    if (!U.startsWith('AT')) return;
    if (!ready) return;                                                             // still booting
    if (U === 'AT' || U === 'AT&W' || U.startsWith('AT+CNMI') || U.startsWith('AT+CSCS') || U.startsWith('AT+CLIP') || U.startsWith('AT+CFUN=') || U.startsWith('AT+IPR') || U.startsWith('AT+CMEE') || U.startsWith('AT+CSMP') || U.startsWith('AT+CMGD') || U.startsWith('AT+CSCLK')) return ok();
    if (U === 'ATE0') { echo = false; return ok(); }
    if (U === 'ATE1') { echo = true; return ok(); }
    if (U === 'ATI') return reply('SIM800 R14.18\r\n\r\nOK');
    if (U === 'AT+CGMI') return reply('SIMCOM_Ltd\r\n\r\nOK');
    if (U === 'AT+CGMM') return reply('SIMCOM_SIM800L\r\n\r\nOK');
    if (U === 'AT+GSN' || U === 'AT+CGSN') return reply('867856030000017\r\n\r\nOK');
    if (U === 'AT+CIMI') return reply('510100000000017\r\n\r\nOK');
    if (U === 'AT+CCID') return reply('8962100000000000017f\r\n\r\nOK');
    if (U === 'AT+CPIN?') return reply('+CPIN: READY\r\n\r\nOK');
    if (U === 'AT+CSQ') return reply(`+CSQ: ${+attr(ctx, 'signal', 20)},0\r\n\r\nOK`);
    if (U === 'AT+CREG?') return reply(`+CREG: 0,${+attr(ctx, 'signal', 20) > 0 ? 1 : 2}\r\n\r\nOK`);
    if (U === 'AT+COPS?') return reply(`+COPS: 0,0,"${attr(ctx, 'operator', 'TELKOMSEL')}"\r\n\r\nOK`);
    if (U === 'AT+CBC') return reply('+CBC: 0,85,4012\r\n\r\nOK');
    if (U === 'AT+CCLK?') { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return reply(`+CCLK: "${p(d.getFullYear() % 100)}/${p(d.getMonth() + 1)}/${p(d.getDate())},${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+28"\r\n\r\nOK`); }
    if (U === 'AT+CMGF=1') { textMode = true; return ok(); }
    if (U === 'AT+CMGF=0') { textMode = false; return ok(); }
    if (U === 'AT+CMGF?') return reply(`+CMGF: ${textMode ? 1 : 0}\r\n\r\nOK`);
    if (U.startsWith('AT+CMGS=')) {
      if (!textMode) return reply('+CMS ERROR: 304');
      smsTo = u.slice(8).replace(/"/g, ''); smsBuf = ''; skipLF = true; ctx.sim.after(5 * 1000 * US, () => link.send('\r\n> ')); return;
    }
    if (U.startsWith('AT+CMGL') || U.startsWith('AT+CMGR')) return ok();
    if (U.startsWith('ATD')) { const num = u.slice(3).replace(/;$/, ''); info(`${ctx.label} menelepon ${num}`); return ok(); }
    if (U === 'ATH' || U === 'ATH0') { info(`${ctx.label} menutup telepon`); return ok(); }
    if (U === 'ATA') return ok();
    if (U.startsWith('AT+')) return ok();
    return reply('ERROR');
  };
  return {
    attach() {
      reader = lineReader(cmd);
      link = uartLink(ctx, { rx: 'RXD', tx: 'TXD' }, {
        baud: () => baud, autoBaud: true, setBaud: (b) => { baud = b; },
        onByte(b) {
          if (!on) return;
          if (smsTo !== null) {                                                   // SMS body until Ctrl-Z (send) or ESC (cancel)
            if (skipLF && b === 10) { skipLF = false; return; }                     // LF that ended the AT+CMGS line
            skipLF = false;
            if (b === 0x1a) { const to = smsTo; smsTo = null; info(`${ctx.label} mengirim SMS ke ${to}: "${smsBuf}"`); n++; ctx.sim.after(16e6 * 1.5, () => reply(`+CMGS: ${n}\r\n\r\nOK`)); return; }
            if (b === 0x1b) { smsTo = null; return; }
            if (echo) link.send(String.fromCharCode(b));
            smsBuf += String.fromCharCode(b); return;
          }
          if (echo) link.send(String.fromCharCode(b));
          reader(b);
        },
      });
    },
    drivers1: () => (on ? link.drivers(2.8 / 5) : []),
    drivers2(v) {
      const was = on; pw = vAcross(ctx, v, 'VCC'); on = pw >= 3.4;
      if (on && !was) {                                                              // boot messages ~3 s after power-up
        ready = false; echo = true; textMode = false;
        ctx.sim.after(16e6 * 0.3, () => { ready = true; });
        ctx.sim.after(16e6 * 3, () => { if (on) link.send('\r\nRDY\r\n\r\n+CFUN: 1\r\n\r\n+CPIN: READY\r\n\r\nCall Ready\r\n\r\nSMS Ready\r\n'); });
      }
      return [];
    },
    render() {
      if (!ctx.sim.running) return;
      if (pw > 4.5) ctx.sim.warn(`sim800-v-${ctx.part.id}`, `${ctx.label}: VCC ${pw.toFixed(1)} V. SIM800L butuh 3,4–4,4 V dengan arus puncak 2 A; pada modul asli pakai regulator/buck 4 V atau baterai Li-ion (disimulasikan tetap bekerja).`);
      else if (pw < 3.4) ctx.sim.warn(`sim800-low-${ctx.part.id}`, `${ctx.label}: tegangan ${pw.toFixed(1)} V terlalu rendah (butuh 3,4–4,4 V); modul tidak menyala. 3,3 V dari Arduino tidak cukup.`);
    },
    reset() { link?.reset(); on = false; smsTo = null; },
  };
};

// ------------------------------------------------------------------ ESP-01 with the Espressif AT firmware
const esp01 = (ctx) => {
  let afterCmd = false;
  let link = null, pw = 0, on = false, echo = true, reader = null, baud = 115200, joined = '', sendLen = 0, sendBuf = [], sock = null, mux = 0, cwmode = 1;
  const reply = (s) => ctx.sim.after(3 * 1000 * US, () => link.send(s + '\r\n'));
  const host = () => ctx.sim._hostSvc ||= ctx.sim._wasmHost();
  const tcpSend = async (bytes) => {
    const req = td.decode(new Uint8Array(bytes));
    const m = /^(GET|POST|PUT|DELETE|PATCH|HEAD)\s+(\S+)\s+HTTP\/1\.[01]\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(req);
    if (!sock || !m) return;
    const headers = m[3].split(/\r?\n/).filter((h) => !/^(host|connection|content-length):/i.test(h)).join('\n');
    const url = (sock.port === 443 ? 'https://' : 'http://') + sock.host + (sock.port !== 80 && sock.port !== 443 ? ':' + sock.port : '') + m[2];
    const r = await host().http(m[1], url, headers, m[4], 8000);
    const body = td.decode(r.bytes);
    const status = r.status > 0 ? r.status : 502;
    const resp = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : ''}\r\nContent-Type: text/plain\r\nContent-Length: ${te.encode(body).length}\r\nConnection: close\r\n\r\n${body}`;
    const rb = te.encode(resp);
    link.send(`\r\n+IPD,${mux ? sock.id + ',' : ''}${rb.length}:`); link.send(rb); link.send(`${mux ? sock.id + ',' : ''}CLOSED\r\n`);
    sock = null;
  };
  const cmd = (l) => {
    const u = l.trim(), U = u.toUpperCase();
    if (U === 'AT') return reply('\r\nOK');
    if (U === 'ATE0') { echo = false; return reply('\r\nOK'); }
    if (U === 'ATE1') { echo = true; return reply('\r\nOK'); }
    if (U === 'AT+RST') { reply('\r\nOK'); joined = ''; ctx.sim.after(16e6 * 0.5, () => link.send('\r\n ets Jan  8 2013,rst cause:2, boot mode:(3,7)\r\n\r\nready\r\n')); return; }
    if (U === 'AT+GMR') return reply('AT version:1.7.4.0(May 11 2020 19:13:04)\r\nSDK version:3.0.4(9532ceb)\r\ncompile time:May 27 2020 10:12:17\r\nBin version(Wroom 02):1.7.4\r\nOK');
    if (U.startsWith('AT+CWMODE')) { if (U.includes('?')) return reply(`+CWMODE:${cwmode}\r\n\r\nOK`); cwmode = +u.split('=')[1] || 1; return reply('\r\nOK'); }
    if (U.startsWith('AT+CWJAP')) {
      if (U.includes('?')) return reply(joined ? `+CWJAP:"${joined}","aa:bb:cc:dd:ee:ff",6,-55\r\n\r\nOK` : 'No AP\r\n\r\nOK');
      const m = /="([^"]*)"/.exec(u); joined = m ? m[1] : 'Wokwi-GUEST';
      ctx.sim.after(16e6 * 1.2, () => reply('WIFI CONNECTED')); ctx.sim.after(16e6 * 2, () => reply('WIFI GOT IP\r\n\r\nOK'));
      ctx.sim.info(`📶 ${ctx.label} terhubung ke WiFi "${joined}" (simulasi; akses internet lewat browser)`);
      return;
    }
    if (U === 'AT+CWQAP') { joined = ''; return reply('\r\nOK\r\nWIFI DISCONNECT'); }
    if (U.startsWith('AT+CWLAP')) return reply('+CWLAP:(3,"Wokwi-GUEST",-50,"aa:bb:cc:dd:ee:ff",6)\r\n+CWLAP:(4,"Sekolah-WiFi",-67,"11:22:33:44:55:66",11)\r\n\r\nOK');
    if (U === 'AT+CIFSR') return reply(`+CIFSR:STAIP,"${joined ? '10.10.0.2' : '0.0.0.0'}"\r\n+CIFSR:STAMAC,"5c:cf:7f:00:00:01"\r\n\r\nOK`);
    if (U.startsWith('AT+CIPMUX')) { mux = +u.split('=')[1] || 0; return reply('\r\nOK'); }
    if (U.startsWith('AT+CIPSTART')) {
      const m = /=\s*(?:(\d+)\s*,\s*)?"(TCP|UDP|SSL)"\s*,\s*"([^"]+)"\s*,\s*(\d+)/i.exec(u);
      if (!m) return reply('\r\nERROR');
      if (!joined) return reply('\r\nno ip\r\n\r\nERROR');
      sock = { id: +(m[1] || 0), host: m[3], port: +m[4], proto: m[2].toUpperCase() };
      return reply(`${mux ? sock.id + ',' : ''}CONNECT\r\n\r\nOK`);
    }
    if (U.startsWith('AT+CIPSEND')) {
      const p = u.split('=')[1]?.split(',') || []; sendLen = +(p.length > 1 ? p[1] : p[0]) || 0;
      if (!sock) return reply('link is not valid\r\n\r\nERROR');
      sendBuf = []; afterCmd = true; reply('\r\nOK'); ctx.sim.after(4 * 1000 * US, () => link.send('> ')); return;
    }
    if (U.startsWith('AT+CIPCLOSE')) { sock = null; return reply('CLOSED\r\n\r\nOK'); }
    if (U === 'AT+CIPSTATUS') return reply(`STATUS:${sock ? 3 : joined ? 2 : 5}\r\n\r\nOK`);
    if (U.startsWith('AT+')) return reply('\r\nOK');
    return reply('\r\nERROR');
  };
  return {
    attach() {
      reader = lineReader(cmd);
      link = uartLink(ctx, { rx: 'RX', tx: 'TX' }, {
        baud: () => baud,
        onByte(b) {
          if (!on) return;
          if (sendLen > 0 && afterCmd && b === 10) { afterCmd = false; return; }   // LF of the AT+CIPSEND line
          afterCmd = false;
          if (sendLen > 0) { sendBuf.push(b); if (sendBuf.length >= sendLen) { const data = sendBuf; sendLen = 0; sendBuf = []; reply(`\r\nRecv ${data.length} bytes\r\n\r\nSEND OK`); tcpSend(data); } return; }
          if (echo) link.send(String.fromCharCode(b));
          reader(b);
        },
      });
    },
    drivers1: () => (on ? link.drivers(3.3 / 5) : []),
    drivers2(v) {
      const was = on; pw = vAcross(ctx, v, '3V3');
      const en = vAcross(ctx, v, 'EN') > 2;                                       // CH_PD must be pulled to 3.3 V
      on = pw >= 2.8 && en;
      if (on && !was) { echo = true; joined = ''; sock = null; baud = +attr(ctx, 'baud', 115200); ctx.sim.after(16e6 * 0.4, () => { if (on) link.send('\r\nready\r\n'); }); }
      return [];
    },
    render(v) {
      if (!ctx.sim.running) return;
      if (pw > 3.8) ctx.sim.warn(`esp01-v-${ctx.part.id}`, `${ctx.label}: pin 3V3 diberi ${pw.toFixed(1)} V. ESP-01 hanya tahan 3,6 V; pakai 3,3 V (regulator AMS1117 bila arusnya kurang).`);
      if (pw >= 2.8 && !on) ctx.sim.warn(`esp01-en-${ctx.part.id}`, `${ctx.label}: pin EN (CH_PD) harus dihubungkan ke 3,3 V agar ESP-01 menyala.`);
      if (pw < 2.8) ctx.sim.warn(`power-${ctx.part.id}`, `${ctx.label}: tidak mendapat daya. Hubungkan 3V3 dan EN ke 3,3 V, GND ke GND.`);
    },
    reset() { link?.reset(); on = false; sock = null; sendLen = 0; },
  };
};

export const BEHAVIORS6 = {
  'mod-gps': gps,
  'mod-hc05': hc05,
  'mod-ftdi': ftdi,
  'mod-sim800l': sim800,
  'mod-esp01': esp01,
};
