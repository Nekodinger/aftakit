// Precompile every example: Uno/Nano with avr-gcc -> src/examples/hex.json,
// ESP32 / ESP8266 with wasi-sdk -> public/wasm/<id>.wasm (+ src/examples/wasm.json manifest, fetched on demand)
import { EXAMPLES } from '../src/examples/defs.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { parseHex } from '../src/sim/hex.js';
const items = {}, chunks = [], wasm = {}; let off = 0, bad = 0;
for (const ex of EXAMPLES) {
  if (ex.board === 'design') { console.log('skip (design board)', ex.id); continue; }
  if (['esp32', 'esp8266', 'rp2040'].includes(ex.board)) {
    const py = `import json,sys; sys.path.insert(0,'server'); from compiler_wasm import compile_sketch_wasm; print(json.dumps(compile_sketch_wasm(sys.stdin.read(), '${ex.board}')))`;
    const r = JSON.parse(execFileSync('python3', ['-c', py], { input: ex.code, encoding: 'utf8', maxBuffer: 1 << 26 }));
    if (!r.wasm) { console.error('FAIL', ex.id, r.stderr); bad++; continue; }
    const buf = Buffer.from(r.wasm, 'base64'); const h = createHash('sha256').update(buf).digest('hex').slice(0, 10);
    mkdirSync('public/wasm', { recursive: true }); writeFileSync(`public/wasm/${ex.id}-${h}.wasm`, buf);
    wasm[ex.id] = { file: `wasm/${ex.id}-${h}.wasm`, board: ex.board, bytes: buf.length };
    console.log('ok (wasm)', ex.id, buf.length, 'bytes'); continue;
  }
  const py = `import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch; r=compile_sketch(sys.stdin.read()); print(json.dumps(r))`;
  const r = JSON.parse(execFileSync('python3', ['-c', py], { input: ex.code, encoding: 'utf8', maxBuffer: 1 << 26 }));
  if (!r.hex) { console.error('FAIL', ex.id, r.stderr || r.error); bad++; continue; }
  const { bytes, size } = parseHex(r.hex);
  const buf = Buffer.from(bytes.subarray(0, size)); chunks.push(buf);
  items[ex.id] = { off, len: buf.length, info: (r.stdout || '').trim().split('\n')[0] }; off += buf.length;
  console.log('ok', ex.id, (r.stdout || '').trim().split('\n')[0]);
}
writeFileSync('src/examples/hex.json', JSON.stringify({ z: deflateRawSync(Buffer.concat(chunks), { level: 9 }).toString('base64'), items }));
writeFileSync('src/examples/wasm.json', JSON.stringify(wasm, null, 1));
process.exit(bad ? 1 : 0);
