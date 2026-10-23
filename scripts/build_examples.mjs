// Precompile every example with the real avr-gcc toolchain -> src/examples/hex.json
import { EXAMPLES } from '../src/examples/defs.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { parseHex } from '../src/sim/hex.js';
const items = {}, chunks = []; let off = 0, bad = 0;
for (const ex of EXAMPLES) {
  const py = `import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch; r=compile_sketch(sys.stdin.read()); print(json.dumps(r))`;
  const r = JSON.parse(execFileSync('python3', ['-c', py], { input: ex.code, encoding: 'utf8', maxBuffer: 1 << 26 }));
  if (!r.hex) { console.error('FAIL', ex.id, r.stderr || r.error); bad++; continue; }
  const { bytes, size } = parseHex(r.hex);
  const buf = Buffer.from(bytes.subarray(0, size)); chunks.push(buf);
  items[ex.id] = { off, len: buf.length, info: (r.stdout || '').trim().split('\n')[0] }; off += buf.length;
  console.log('ok', ex.id, (r.stdout || '').trim().split('\n')[0]);
}
writeFileSync('src/examples/hex.json', JSON.stringify({ z: deflateRawSync(Buffer.concat(chunks), { level: 9 }).toString('base64'), items }));
process.exit(bad ? 1 : 0);
