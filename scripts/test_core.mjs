// Headless core test: compile -> run on avr8js -> check pin toggling + serial + millis.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { AvrBoard, CLOCK_HZ } from '../src/sim/avr.js';

function compile(src) {
  writeFileSync('/tmp/_t.ino', src);
  const out = execFileSync('python3', ['-c', `
import json,sys; sys.path.insert(0,'server'); from compiler import compile_sketch
print(json.dumps(compile_sketch(open('/tmp/_t.ino').read())))`], { cwd: new URL('..', import.meta.url).pathname, maxBuffer: 1e8 });
  return JSON.parse(out);
}
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const r = compile(`void setup(){pinMode(13,OUTPUT);pinMode(9,OUTPUT);Serial.begin(9600);Serial.println("hello");}
void loop(){digitalWrite(13,HIGH);delay(100);digitalWrite(13,LOW);delay(100);analogWrite(9,64);}`);
ok(!!r.hex, 'compile ok: ' + r.stdout.split('\n')[0]);
const b = new AvrBoard(); b.loadHex(r.hex);
let serial = ''; b.serialListeners.push((c) => (serial += String.fromCharCode(c)));
let edges = 0; b.onEdge('13', () => edges++);
b.run(CLOCK_HZ); // 1 s warm-up (PWM starts after the first 200 ms)
b.sampleWindow();
const edges1s = edges;
b.run(CLOCK_HZ / 2); b.sampleWindow(); // measure a clean 0.5 s window
ok(serial.includes('hello'), 'serial printed: ' + JSON.stringify(serial));
ok(edges1s >= 9 && edges1s <= 11, 'pin13 edges in 1s (expect ~10): ' + edges1s);
ok(b.pins['9'].duty !== null && Math.abs(b.pins['9'].duty - 0.25) < 0.06, 'pin9 PWM duty ~0.25: ' + b.pins['9'].duty?.toFixed(3));
ok(b.pins['9'].freq > 400 && b.pins['9'].freq < 520, 'pin9 PWM freq ~490Hz: ' + b.pins['9'].freq.toFixed(0));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
