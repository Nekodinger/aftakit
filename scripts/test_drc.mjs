// Design-rule check tests (ESP32 / Uno wiring mistakes students make).
const { checkDesign } = await import('../src/sim/drc.js');
const ESP = 'VIN GND.2 D13 D12 D14 D27 D26 D25 D33 D32 D35 D34 VN VP EN 3V3 GND.1 D15 D2 D4 RX2 TX2 D5 D18 D19 D21 RX0 TX0 D22 D23'.split(' ');
const UNO = ['A5.2','A4.2','AREF','GND.1','13','12','11','10','9','8','7','6','5','4','3','2','1','0','IOREF','RESET','3.3V','5V','GND.2','GND.3','VIN','A0','A1','A2','A3','A4','A5'];
const el = (pins) => ({ pinInfo: pins.map((name) => ({ name })) });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function run(board, bpins, parts, conns) {
  const model = { parts: [{ id: 'b', type: board, attrs: {} }, ...parts.map(([id, type, , attrs]) => ({ id, type, attrs: attrs || {} }))], connections: conns };
  const els = new Map([['b', el(bpins)], ...parts.map(([id, , pins]) => [id, el(pins)])]);
  return checkDesign(model, els);
}
const has = (r, lvl, re) => r.some((x) => x.level === lvl && re.test(x.text));
{
  const r = run('wokwi-esp32-devkit-v1', ESP, [['us', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND']]], [['us:VCC', 'b:VIN'], ['us:GND', 'b:GND.1'], ['us:TRIG', 'b:D5'], ['us:ECHO', 'b:D18']]);
  ok(has(r, 'warn', /us\.ECHO → D18 \(GPIO18\).*5 V/), 'ESP32: HC-SR04 on 5V, ECHO -> GPIO18 warns about 5 V on a 3.3 V pin');
}
{
  const r = run('wokwi-esp32-devkit-v1', ESP, [['r1', 'wokwi-resistor', ['1', '2']], ['led', 'wokwi-led', ['A', 'C']]], [['b:D34', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'b:GND.1']]);
  ok(has(r, 'error', /D34 \(GPIO34\) hanya bisa INPUT/), 'ESP32: LED (through resistor) on GPIO34 -> input-only error');
}
{
  const r = run('wokwi-esp32-devkit-v1', ESP, [['s', 'mod-soil', ['VCC', 'GND', 'DO', 'AO']]], [['s:VCC', 'b:3V3'], ['s:GND', 'b:GND.1'], ['s:AO', 'b:D13']]);
  ok(has(r, 'warn', /ADC2 tidak bisa dibaca saat WiFi/), 'ESP32: analog soil sensor on GPIO13 -> ADC2 + WiFi warning');
  ok(!has(r, 'warn', /melebihi batas 3.3 V/), 'ESP32: soil powered from 3V3 -> no overvoltage warning');
}
{
  const r = run('wokwi-esp32-devkit-v1', ESP, [['rl', 'mod-relay1', ['VCC', 'GND', 'IN', 'NO', 'COM', 'NC']]], [['rl:VCC', 'b:3V3'], ['rl:GND', 'b:GND.1'], ['rl:IN', 'b:D26']]);
  ok(has(r, 'warn', /butuh 5 V; saat ini diberi 3.3 V/), 'ESP32: 5V relay module on 3V3 -> needs 5 V warning');
}
{
  const r = run('wokwi-arduino-uno', UNO, [['p', 'wokwi-potentiometer', ['GND', 'SIG', 'VCC']]], [['p:VCC', 'b:5V'], ['p:GND', 'b:GND.1'], ['p:SIG', 'b:7']]);
  ok(has(r, 'warn', /bukan pin analog/), 'Uno: potentiometer SIG on digital pin 7 -> use A0–A5');
}
{
  const r = run('wokwi-arduino-uno', UNO, [], [['b:5V', 'b:GND.1']]);
  ok(has(r, 'error', /Korsleting/), 'Uno: 5V wired to GND -> short circuit error');
}
{
  const r = run('wokwi-arduino-uno', UNO, [['l', 'mod-l298n', ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', '12V', 'GND', '5V']], ['bat', 'mod-battery9v', ['+', '-']]],
    [['bat:+', 'l:12V'], ['bat:-', 'l:GND'], ['l:IN1', 'b:8']]);
  ok(has(r, 'warn', /belum disatukan dengan GND/), 'Uno + L298N on a 9V battery without common GND -> warning');
}
{
  const r = run('wokwi-arduino-uno', UNO, [['r1', 'wokwi-resistor', ['1', '2']], ['led', 'wokwi-led', ['A', 'C']]], [['b:13', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'b:GND.1']]);
  ok(has(r, 'ok', /Tidak ditemukan kesalahan/), 'Uno: correct blink circuit -> no problems');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
