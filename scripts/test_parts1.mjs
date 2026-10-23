// Tests for parts that used to be drawing-only (phase 1): capacitor, diode, KS2E relay, stepper, rotary dialer, IR, heart-beat.
import { make, ok, done, lines, logText, Stub } from './testkit.mjs';

// ---------------------------------------------------------------- 1. RC charge / discharge (R = 1 kΩ, C = 100 µF -> tau = 100 ms)
{
  const { sim } = make([['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '1000' }], ['c1', 'mod-capacitor', ['+', '-'], {}, { capacitance: '100' }]],
    [['uno:9', 'r1:1'], ['r1:2', 'c1:+'], ['r1:2', 'uno:A0'], ['c1:-', 'uno:GND.1']],
    'void setup(){Serial.begin(115200);pinMode(9,OUTPUT);digitalWrite(9,HIGH);} void loop(){ if(millis()>700) digitalWrite(9,LOW); Serial.print(millis());Serial.print(" ");Serial.println(analogRead(A0));delay(10);}');
  sim.advance(1200);
  const rows = lines(sim).map((l) => l.split(' ').map(Number)).filter((r) => r.length === 2);
  const at = (ms) => rows.find((r) => r[0] >= ms);
  const expect = (t) => 1023 * (1 - Math.exp(-t / 100));
  for (const t of [50, 100, 200, 400]) { const r = at(t); ok(Math.abs(r[1] - expect(r[0])) < 40, `RC charge at ${r[0]} ms: ADC ${r[1]} (theory ${expect(r[0]).toFixed(0)})`); }
  const full = at(690)[1]; const r = at(800);
  const dis = full * Math.exp(-(r[0] - 706) / 100);   // the pin goes LOW on the first pass after 700 ms
  ok(Math.abs(r[1] - dis) < 45, `RC discharge at ${r[0]} ms: ADC ${r[1]} (theory ${dis.toFixed(0)})`);
}
// 2. capacitor holds charge and lights an LED after the source is cut (22 ms time constant with 220 Ω)
{
  const { sim, els } = make([['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }], ['c1', 'mod-capacitor', ['+', '-'], {}, { capacitance: '100' }],
    ['led', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
  [['uno:9', 'c1:+'], ['c1:+', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'uno:GND.1'], ['c1:-', 'uno:GND.2']],
  'void setup(){pinMode(9,OUTPUT);digitalWrite(9,HIGH);delay(300);pinMode(9,INPUT);} void loop(){}');
  const led = els.get('led'); const b = [];
  for (let i = 0; i < 30; i++) { sim.advance(20); b.push(+led.brightness.toFixed(2)); }
  const i0 = b.findIndex((x, i) => i > 10 && x < 0.99 && b[i - 1] >= 0.99) || 0;
  ok(b[14] > 0.9, `LED lit while pin drives (${b[14]})`);
  ok(b.slice(15).some((x) => x > 0.1 && x < 0.9) && b[b.length - 1] < b[15], `LED fades after the pin is released: ${b.slice(14, 26).join(', ')}`);
}
// 3. capacitor misuse warnings: reversed polarity
{
  const { sim } = make([['c1', 'mod-capacitor', ['+', '-'], {}, { capacitance: '100', rating: '16' }]], [['uno:5V', 'c1:-'], ['uno:GND.1', 'c1:+']], 'void setup(){} void loop(){}');
  sim.advance(50);
  ok(/polaritas terbalik/.test(logText(sim)), 'reversed electrolytic capacitor -> warning');
}
// 4. diode: forward drop and blocking
{
  const f = make([['d1', 'mod-diode', ['A', 'K'], {}, { vf: '0.7' }], ['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }], ['led', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:9', 'd1:A'], ['d1:K', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'uno:GND.1']], 'void setup(){pinMode(9,OUTPUT);digitalWrite(9,HIGH);} void loop(){}');
  f.sim.advance(50);
  ok(Math.abs(f.els.get('led').brightness - 0.86) < 0.03, `forward diode: LED brightness ${f.els.get('led').brightness.toFixed(2)} (5 V - 0.7 V = 0.86)`);
  const r = make([['d1', 'mod-diode', ['A', 'K'], {}, { vf: '0.7' }], ['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }], ['led', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
    [['uno:9', 'd1:K'], ['d1:A', 'r1:1'], ['r1:2', 'led:A'], ['led:C', 'uno:GND.1']], 'void setup(){pinMode(9,OUTPUT);digitalWrite(9,HIGH);} void loop(){}');
  r.sim.advance(50);
  ok(r.els.get('led').brightness === 0 && !r.els.get('led').value, 'reverse diode blocks: LED stays off');
}
// 5. KS2E relay: coil on pin 8 (direct: warns), contacts switch two LEDs
{
  const KS = ['NO2', 'NC2', 'P2', 'COIL2', 'NO1', 'NC1', 'P1', 'COIL1'];
  const { sim, els } = make([['ks', 'wokwi-ks2e-m-dc5', KS], ['r1', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }], ['r2', 'wokwi-resistor', ['1', '2'], {}, { value: '220' }],
    ['l1', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }], ['l2', 'wokwi-led', ['A', 'C'], { value: false, brightness: 0 }]],
  [['uno:8', 'ks:COIL1'], ['ks:COIL2', 'uno:GND.1'], ['ks:P1', 'uno:5V'], ['ks:NO1', 'r1:1'], ['r1:2', 'l1:A'], ['l1:C', 'uno:GND.2'], ['ks:NC1', 'r2:1'], ['r2:2', 'l2:A'], ['l2:C', 'uno:GND.3']],
  'void setup(){pinMode(8,OUTPUT);} void loop(){digitalWrite(8,HIGH);delay(500);digitalWrite(8,LOW);delay(500);}');
  const seen = [];
  for (let i = 0; i < 30; i++) { sim.advance(50); seen.push([els.get('l1').value, els.get('l2').value]); }
  ok(seen.some((s) => s[0] && !s[1]) && seen.some((s) => !s[0] && s[1]) && seen.every((s) => s[0] !== s[1]), 'relay toggles NO/NC LEDs exclusively');
  ok(/koil terhubung langsung/.test(logText(sim)), 'warns when the coil is wired straight to an Arduino pin');
}
// 6. stepper through an L298N: 200 full steps = one revolution, 2 ms per step (faster than the 4 ms solver slice)
{
  const L = ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', '12V', 'GND', '5V'];
  const { sim, els } = make([['bat', 'mod-battery9v', ['+', '-'], {}, { voltage: 9 }], ['l', 'mod-l298n', L], ['st', 'wokwi-stepper-motor', ['A-', 'A+', 'B+', 'B-'], { angle: 0, value: '', units: '' }, { stepDeg: '1.8' }]],
    [['bat:+', 'l:12V'], ['bat:-', 'l:GND'], ['l:GND', 'uno:GND.1'], ['uno:8', 'l:IN1'], ['uno:9', 'l:IN2'], ['uno:10', 'l:IN3'], ['uno:11', 'l:IN4'],
      ['l:OUT1', 'st:A+'], ['l:OUT2', 'st:A-'], ['l:OUT3', 'st:B+'], ['l:OUT4', 'st:B-']],
    `const byte S[4][4]={{1,0,1,0},{0,1,1,0},{0,1,0,1},{1,0,0,1}};
     void go(int i){for(int k=0;k<4;k++)digitalWrite(8+k,S[i&3][k]);}
     void setup(){Serial.begin(9600);for(int k=8;k<12;k++)pinMode(k,OUTPUT);
       for(int i=0;i<=200;i++){go(i);delay(2);} Serial.println("fwd");delay(300);
       for(int i=200;i>100;i--){go(i);delay(2);} Serial.println("back");}
     void loop(){}`);
  const st = els.get('st'); let done1 = false;
  for (let i = 0; i < 100; i++) { sim.advance(20); st.chk = st.chk; if (/fwd/.test(sim.serial) && !done1) { done1 = true; ok(Math.abs(+st.value - 360.9) < 0.01, `stepper after 200 steps forward: ${st.value}° (200 x 1.8° + 0.9° from the first half-step)`); } }
  ok(/back/.test(sim.serial) && Math.abs(+st.value - 182.7) < 0.01, `then 99 steps back (i=199..101): ${st.value}° (expected 182.7°)`);
}
// 7. rotary dialer: digits 5, 0 (ten pulses) and 3 counted with a Wokwi-style sketch
{
  const { sim, els } = make([['dl', 'wokwi-rotary-dialer', ['GND', 'DIAL', 'PULSE']]], [['dl:GND', 'uno:GND.1'], ['dl:DIAL', 'uno:3'], ['dl:PULSE', 'uno:2']],
    `int counter=0,lastP=HIGH;bool dialing=false;
     void setup(){Serial.begin(9600);pinMode(3,INPUT_PULLUP);pinMode(2,INPUT_PULLUP);}
     void loop(){int d=digitalRead(3);
       if(d==LOW&&!dialing){dialing=true;counter=0;lastP=digitalRead(2);}
       if(dialing){int p=digitalRead(2);if(p!=lastP){if(lastP==LOW)counter++;lastP=p;} if(d==HIGH){dialing=false;Serial.println(counter%10);}}}`);
  const dl = els.get('dl'); sim.advance(100);
  for (const dg of [5, 0, 3]) { dl.fire('dial-start', { digit: dg }); sim.advance(250); dl.fire('dial', { digit: dg }); sim.advance((dg === 0 ? 10 : dg) * 100 + 100); dl.fire('dial-end', { digit: dg }); sim.advance(200); }
  ok(lines(sim).join(',') === '5,0,3', `dialer digits read back: ${lines(sim).join(',')}`);
}
// 8. IR receiver + remote: NEC frame decoded by a sketch, then repeat codes while held
{
  const { sim, els } = make([['ir', 'wokwi-ir-receiver', ['GND', 'VCC', 'DAT']], ['rem', 'wokwi-ir-remote', []]], [['ir:VCC', 'uno:5V'], ['ir:GND', 'uno:GND.1'], ['ir:DAT', 'uno:2']],
    `volatile unsigned long ts[80];volatile byte n=0;
     void isr(){if(n<80)ts[n++]=micros();}
     void setup(){Serial.begin(9600);pinMode(2,INPUT);attachInterrupt(digitalPinToInterrupt(2),isr,CHANGE);}
     void loop(){ if(n>0){noInterrupts();unsigned long last=ts[n-1];interrupts();
       if(micros()-last>30000){noInterrupts();byte m=n;n=0;interrupts();
         if(m>=67){unsigned long v=0;for(int j=0;j<32;j++){unsigned long dt=ts[2*(j+2)]-ts[2*(j+1)];if(dt>1700)v|=(1UL<<j);} Serial.println(v,HEX);} else Serial.println("R");}}}`);
  const rem = els.get('rem'); sim.advance(200);
  rem.fire('button-press', { key: '1', irCode: 0x30 }); sim.advance(400); rem.fire('button-release', { key: '1', irCode: 0x30 }); sim.advance(300);
  const L = lines(sim);
  ok(L[0] === 'CF30FF00', `NEC frame for key "1" decoded: ${L[0]} (expected CF30FF00 = addr 0x00, cmd 0x30)`);
  ok(L.filter((x) => x === 'R').length === 3, `3 repeat codes while held 400 ms: ${L.join(' ')}`);
  rem.fire('button-press', { key: 'power', irCode: 0xa2 }); sim.advance(150); rem.fire('button-release', { key: 'power', irCode: 0xa2 }); sim.advance(200);
  ok(lines(sim).includes('5DA2FF00'), `second key (power 0xA2) decoded: ${lines(sim).slice(-2).join(' ')}`);
}
// 9. heart-beat sensor: 90 BPM -> about 6 peaks in 4 s
{
  const { sim } = make([['hb', 'wokwi-heart-beat-sensor', ['GND', 'VCC', 'OUT'], {}, { bpm: 90 }]], [['hb:VCC', 'uno:5V'], ['hb:GND', 'uno:GND.1'], ['hb:OUT', 'uno:A0']],
    'void setup(){Serial.begin(115200);} void loop(){Serial.println(analogRead(A0));delay(5);}');
  sim.advance(4000);
  const v = lines(sim).map(Number); let peaks = 0, hi = false;
  for (const x of v) { if (!hi && x > 650) { peaks++; hi = true; } else if (hi && x < 550) hi = false; }
  ok(peaks >= 5 && peaks <= 7, `heart-beat peaks in 4 s at 90 BPM: ${peaks}`);
}
// 10. gauge (biaxial) stepper: 240 full steps of motor 1 = 120 deg of outer hand; motor 2 untouched; mechanical stop at 315 deg
{
  const P = ['A1-', 'A1+', 'B1+', 'B1-', 'A2-', 'A2+', 'B2+', 'B2-'];
  const { sim, els } = make([['g', 'wokwi-biaxial-stepper', P, { outerHandAngle: 0, innerHandAngle: 0 }]],
    [['uno:4', 'g:A1+'], ['uno:5', 'g:A1-'], ['uno:6', 'g:B1+'], ['uno:7', 'g:B1-']],
    `const byte S[4][4]={{1,0,1,0},{0,1,1,0},{0,1,0,1},{1,0,0,1}};
     void go(int i){for(int k=0;k<4;k++)digitalWrite(4+k,S[i&3][k]);}
     void setup(){for(int k=4;k<8;k++)pinMode(k,OUTPUT);for(int i=0;i<=240;i++){go(i);delay(1);} delay(400);
       for(int i=241;i<=2000;i++){go(i);delay(1);} }
     void loop(){}`);
  sim.advance(500);
  ok(Math.abs(els.get('g').outerHandAngle - 120.25) < 0.3 && els.get('g').innerHandAngle === 0, `gauge: 240 steps -> outer hand ${els.get('g').outerHandAngle.toFixed(2)}° (0.5° per full step), inner ${els.get('g').innerHandAngle}`);
  sim.advance(3000);
  ok(els.get('g').outerHandAngle === 315, `gauge stops at the mechanical end stop: ${els.get('g').outerHandAngle}°`);
}
// 11. the real IRremote library (v4, timer 2 sampling) decodes the remote's NEC frames
{
  const { sim, els } = make([['ir', 'wokwi-ir-receiver', ['GND', 'VCC', 'DAT']], ['rem', 'wokwi-ir-remote', []]], [['ir:VCC', 'uno:5V'], ['ir:GND', 'uno:GND.1'], ['ir:DAT', 'uno:2']],
    `#include <IRremote.hpp>
void setup(){ Serial.begin(115200); IrReceiver.begin(2, DISABLE_LED_FEEDBACK); }
void loop(){ if (IrReceiver.decode()) { if (!(IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT)) { Serial.print(getProtocolString(IrReceiver.decodedIRData.protocol)); Serial.print(" A="); Serial.print(IrReceiver.decodedIRData.address, HEX); Serial.print(" C="); Serial.println(IrReceiver.decodedIRData.command, HEX); } IrReceiver.resume(); } }`);
  const rem = els.get('rem');
  sim.advance(200); rem.fire('button-press', { key: '1', irCode: 0x30 }); sim.advance(150); rem.fire('button-release', { key: '1', irCode: 0x30 }); sim.advance(300);
  rem.fire('button-press', { key: 'power', irCode: 0xa2 }); sim.advance(150); rem.fire('button-release', { key: 'power', irCode: 0xa2 }); sim.advance(300);
  ok(lines(sim).join('|') === 'NEC A=0 C=30|NEC A=0 C=A2', `IRremote decodes: ${lines(sim).join(' | ')}`);
}
done();
