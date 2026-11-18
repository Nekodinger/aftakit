// Collect the example sketches of the Arduino libraries (like Arduino IDE → File → Examples) into a static index:
//   node scripts/collect_examples.mjs <dir with libraries> <out dir> [<arduino-examples repo dir>]
// Writes <out>/index.json  { libs: [{ id, name, arch, examples: [{ name, path, file, size, multi }] }] }
// and <out>/<id>/<path>.ino. Only the .ino is copied: an example whose folder also has .h/.cpp files is marked
// "multi" (the simulator editor holds one file). Run by scripts/vercel-build.sh before the examples are deleted.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const [src, out, builtin] = process.argv.slice(2);
if (!src || !out) { console.error('usage: collect_examples.mjs <libs dir> <out dir> [arduino-examples dir]'); process.exit(2); }
const MAX = 80 * 1024;   // bigger sketches are data dumps, not examples
const SKIP_LIB = /^(ArduinoCore-avr|ATTinyCore)$/;
const props = (dir) => {
  const p = join(dir, 'library.properties'); if (!existsSync(p)) return null;
  const o = {}; for (const l of readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^\s*([\w.]+)\s*=\s*(.*)$/.exec(l); if (m) o[m[1]] = m[2].trim(); }
  return o;
};
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const slug = (s) => s.replace(/[^\w.-]+/g, '_');

function examplesIn(root) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let ents; try { ents = readdirSync(d); } catch { return; }
    const ino = ents.find((f) => f === basename(d) + '.ino') || (ents.filter((f) => f.endsWith('.ino')).length === 1 ? ents.find((f) => f.endsWith('.ino')) : null);
    if (ino) {
      const file = join(d, ino), size = statSync(file).size;
      if (size <= MAX) found.push({ name: basename(d), path: relative(root, d).split('\\').join('/'), file, size, multi: ents.some((f) => /\.(h|hpp|c|cpp)$/.test(f) && !/^(arduino_secrets|secrets|config)\.h$/i.test(f)) });
      return;
    }
    for (const f of ents.sort()) if (isDir(join(d, f)) && !f.startsWith('.')) walk(join(d, f), depth + 1);
  };
  walk(root, 0);
  return found;
}

rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
const libs = [];
function add(id, name, arch, root) {
  const ex = examplesIn(root); if (!ex.length) return;
  const list = [];
  for (const e of ex) {
    const dest = join(out, id, e.path + '.ino'); mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, readFileSync(e.file)); list.push({ name: e.name, path: e.path, size: e.size, ...(e.multi ? { multi: 1 } : {}) });
  }
  libs.push({ id, name, arch, examples: list });
}
// Arduino built-in examples (01.Basics …) first, like the IDE
if (builtin && isDir(join(builtin, 'examples'))) add('builtin', 'Bawaan Arduino', '*', join(builtin, 'examples'));
for (const d of readdirSync(src).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))) {
  const dir = join(src, d); if (!isDir(dir) || SKIP_LIB.test(d)) continue;
  const p = props(dir) || {};
  const exDir = ['examples', 'Examples', 'example'].map((x) => join(dir, x)).find(isDir); if (!exDir) continue;
  add(slug(d), p.name || d, p.architectures || '*', exDir);
}
writeFileSync(join(out, 'index.json'), JSON.stringify({ libs }));
console.log(`library examples: ${libs.length} libraries, ${libs.reduce((a, l) => a + l.examples.length, 0)} sketches -> ${out}`);
