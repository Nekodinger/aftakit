import { Circuit } from '../src/sim/circuit.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const parts = [
  { id: 'uno', type: 'uno', pins: ['13', '2', 'GND.1', 'GND.2', '5V', 'A0'] },
  { id: 'r1', type: 'resistor', pins: ['1', '2'] },
  { id: 'led1', type: 'led', pins: ['A', 'C'] },
  { id: 'b1', type: 'btn', pins: ['1.l', '2.l', '1.r', '2.r'] },
  { id: 'r2', type: 'resistor', pins: ['1', '2'] },
];
const conns = [['uno:13', 'r1:1'], ['r1:2', 'led1:A'], ['led1:C', 'uno:GND.2'], ['uno:2', 'b1:1.l'], ['b1:2.r', 'uno:GND.1']];
const c = new Circuit(parts, conns);
ok(c.net('uno', 'GND.1') === c.net('uno', 'GND.2'), 'GND.1 and GND.2 united (same prefix)');
ok(c.net('b1', '1.l') === c.net('b1', '1.r'), 'button contacts 1.l/1.r united');
ok(c.net('b1', '1.l') !== c.net('b1', '2.l'), 'button 1 and 2 are separate nets');
const rails = [{ net: c.net('uno', 'GND.1'), value: 0, label: 'GND', rail: true }, { net: c.net('uno', '5V'), value: 1, label: '5V', rail: true }];
// LED via resistor: pin13 HIGH
let s = c.solve({ strong: [...rails, { net: c.net('uno', '13'), value: 1, label: 'pin 13' }], weak: [[c.net('r1', '1'), c.net('r1', '2')]] });
ok(s.v(c.net('led1', 'A')) === 1 && s.v(c.net('led1', 'C')) === 0, 'LED anode=1 cathode=0 through resistor');
ok(!s.strong(c.net('led1', 'A')), 'anode is weak-derived (resistor present)');
// pull-up button
const sw = (pressed) => c.solve({ strong: rails, pullups: [c.net('uno', '2')], switches: pressed ? [[c.net('b1', '1.l'), c.net('b1', '2.l')]] : [] });
ok(sw(false).v(c.net('uno', '2')) === 1, 'INPUT_PULLUP released -> 1');
ok(sw(true).v(c.net('uno', '2')) === 0, 'INPUT_PULLUP pressed -> 0');
// short: pin 13 HIGH directly shorted to GND
const c2 = new Circuit(parts, [['uno:13', 'uno:GND.1']]);
s = c2.solve({ strong: [{ net: c2.net('uno', 'GND.1'), value: 0, label: 'GND', rail: true }, { net: c2.net('uno', '13'), value: 1, label: 'pin 13 (HIGH)' }] });
ok(s.warnings.length === 1 && /Korsleting/.test(s.warnings[0].text), 'short circuit detected: ' + s.warnings[0]?.text);
// pull-down resistor + 5V button
const c3 = new Circuit(parts, [['uno:2', 'b1:1.l'], ['b1:2.l', 'uno:5V'], ['uno:2', 'r2:1'], ['r2:2', 'uno:GND.1']]);
const s3 = (p) => c3.solve({ strong: [{ net: c3.net('uno', 'GND.1'), value: 0, label: 'GND', rail: true }, { net: c3.net('uno', '5V'), value: 1, label: '5V', rail: true }], switches: p ? [[c3.net('b1', '1.l'), c3.net('b1', '2.l')]] : [], weak: [[c3.net('r2', '1'), c3.net('r2', '2')]] });
ok(s3(false).v(c3.net('uno', '2')) === 0, 'pull-down: released -> 0');
ok(s3(true).v(c3.net('uno', '2')) === 1, 'pull-down: pressed -> 1 (strong beats weak)');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
