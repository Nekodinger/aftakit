// Example circuits. Pin names follow @wokwi/elements. Coordinates are in CSS px (world space).
const P = (id, type, left, top, attrs = {}) => ({ id, type, left, top, attrs });
const U = (x = 0, y = 0) => P('uno', 'wokwi-arduino-uno', x, y);
const R = (id, x, y, v = '220') => P(id, 'wokwi-resistor', x, y, { value: v });
const W = (a, b) => [a, b];
const G = 'uno:GND.1', V5 = 'uno:5V';

export const EXAMPLES = [
  { id: 'blink', title: 'Blink LED', desc: 'LED eksternal + LED bawaan (pin 13) berkedip tiap 0,5 detik.',
    code: `// Blink: LED di pin 13 (LED bawaan board + LED eksternal)
void setup() {
  pinMode(13, OUTPUT);
  Serial.begin(9600);
  Serial.println("Blink mulai");
}

void loop() {
  digitalWrite(13, HIGH);
  Serial.println("LED ON");
  delay(500);
  digitalWrite(13, LOW);
  Serial.println("LED OFF");
  delay(500);
}
`,
    parts: [U(), R('r1', 20, -90), P('led1', 'wokwi-led', 130, -110, { color: 'red' })],
    wires: [W('uno:13', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', G)] },

  { id: 'button', title: 'Tombol + LED', desc: 'Tombol dengan INPUT_PULLUP menyalakan LED. Klik tombol saat simulasi berjalan.',
    code: `const int BUTTON = 2;
const int LED = 9;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);  // tombol aktif LOW
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  bool ditekan = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, ditekan ? HIGH : LOW);
  static bool last = false;
  if (ditekan != last) {
    Serial.println(ditekan ? "Tombol ditekan" : "Tombol dilepas");
    last = ditekan;
  }
}
`,
    parts: [U(), P('btn1', 'wokwi-pushbutton', 330, 60, { color: 'green' }), R('r1', 20, -90), P('led1', 'wokwi-led', 130, -110, { color: 'yellow' })],
    wires: [W('uno:2', 'btn1:1.l'), W('btn1:2.l', 'uno:GND.2'), W('uno:9', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', G)] },

  { id: 'pot-pwm', title: 'Potensiometer → kecerahan LED', desc: 'analogRead dari potensiometer mengatur PWM LED. Geser nilai di panel Properti.',
    code: `const int POT = A0;
const int LED = 9;  // pin PWM

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int nilai = analogRead(POT);          // 0..1023
  int duty = map(nilai, 0, 1023, 0, 255);
  analogWrite(LED, duty);
  Serial.print("ADC=");
  Serial.print(nilai);
  Serial.print("  PWM=");
  Serial.println(duty);
  delay(200);
}
`,
    parts: [U(), P('pot1', 'wokwi-potentiometer', 330, 230, { value: 50 }), R('r1', 20, -90), P('led1', 'wokwi-led', 130, -110, { color: 'blue' })],
    wires: [W('pot1:SIG', 'uno:A0'), W('pot1:VCC', V5), W('pot1:GND', 'uno:GND.3'), W('uno:9', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', G)] },

  { id: 'traffic', title: 'Lampu Lalu Lintas', desc: 'Tiga LED merah-kuning-hijau dengan siklus waktu nyata.',
    code: `const int MERAH = 8, KUNING = 9, HIJAU = 10;

void set(bool m, bool k, bool h) {
  digitalWrite(MERAH, m);
  digitalWrite(KUNING, k);
  digitalWrite(HIJAU, h);
}

void setup() {
  pinMode(MERAH, OUTPUT);
  pinMode(KUNING, OUTPUT);
  pinMode(HIJAU, OUTPUT);
}

void loop() {
  set(true, false, false);  delay(3000);
  set(true, true, false);   delay(1000);
  set(false, false, true);  delay(3000);
  set(false, true, false);  delay(1000);
}
`,
    parts: [U(), R('r1', 20, -80), R('r2', 20, -110), R('r3', 20, -140),
      P('ledR', 'wokwi-led', 140, -80, { color: 'red' }), P('ledY', 'wokwi-led', 190, -80, { color: 'yellow' }), P('ledG', 'wokwi-led', 240, -80, { color: 'green' })],
    wires: [W('uno:8', 'r1:1'), W('r1:2', 'ledR:A'), W('uno:9', 'r2:1'), W('r2:2', 'ledY:A'), W('uno:10', 'r3:1'), W('r3:2', 'ledG:A'),
      W('ledR:C', G), W('ledY:C', G), W('ledG:C', G)] },

  { id: 'rgb', title: 'LED RGB Fade', desc: 'Tiga kanal PWM menghasilkan pelangi pada LED RGB.',
    code: `const int PR = 9, PG = 10, PB = 11;

void warna(int h, int &r, int &g, int &b) {   // h: 0..255 (roda warna)
  if (h < 85)       { r = 255 - h * 3; g = h * 3;       b = 0; }
  else if (h < 170) { h -= 85;  r = 0;         g = 255 - h * 3; b = h * 3; }
  else              { h -= 170; r = h * 3;     g = 0;           b = 255 - h * 3; }
}

void setup() {
  pinMode(PR, OUTPUT); pinMode(PG, OUTPUT); pinMode(PB, OUTPUT);
}

void loop() {
  for (int h = 0; h < 256; h++) {
    int r, g, b;
    warna(h, r, g, b);
    analogWrite(PR, r); analogWrite(PG, g); analogWrite(PB, b);
    delay(20);
  }
}
`,
    parts: [U(), P('rgb1', 'wokwi-rgb-led', 330, -110, { common: 'cathode' }), R('r1', 120, -30), R('r2', 120, -60), R('r3', 120, -90)],
    wires: [W('uno:9', 'r1:1'), W('r1:2', 'rgb1:R'), W('uno:10', 'r2:1'), W('r2:2', 'rgb1:G'), W('uno:11', 'r3:1'), W('r3:2', 'rgb1:B'), W('rgb1:COM', G)] },

  { id: 'servo', title: 'Servo dikendalikan Potensiometer', desc: 'Library Servo asli; sudut horn mengikuti posisi potensiometer.',
    code: `#include <Servo.h>

Servo servo;

void setup() {
  servo.attach(9);
  Serial.begin(9600);
}

void loop() {
  int nilai = analogRead(A0);
  int sudut = map(nilai, 0, 1023, 0, 180);
  servo.write(sudut);
  Serial.print("Sudut: ");
  Serial.println(sudut);
  delay(100);
}
`,
    parts: [U(), P('servo1', 'wokwi-servo', 330, -190, { horn: 'single' }), P('pot1', 'wokwi-potentiometer', 330, 230, { value: 25 })],
    wires: [W('uno:9', 'servo1:PWM'), W('servo1:V+', V5), W('servo1:GND', G), W('pot1:SIG', 'uno:A0'), W('pot1:VCC', V5), W('pot1:GND', 'uno:GND.3')] },

  { id: 'lcd', title: 'LCD 16x2 – Penghitung', desc: 'LiquidCrystal asli (mode 4-bit): teks dan penghitung detik.',
    code: `#include <LiquidCrystal.h>

LiquidCrystal lcd(12, 11, 5, 4, 3, 2);  // RS, E, D4, D5, D6, D7

void setup() {
  lcd.begin(16, 2);
  lcd.print("Halo, Dunia!");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Detik: ");
  lcd.print(millis() / 1000);
  lcd.print("   ");
  delay(200);
}
`,
    parts: [U(0, 0), P('lcd1', 'wokwi-lcd1602', 330, -240, { background: 'green' })],
    wires: [W('uno:12', 'lcd1:RS'), W('uno:11', 'lcd1:E'), W('uno:5', 'lcd1:D4'), W('uno:4', 'lcd1:D5'), W('uno:3', 'lcd1:D6'), W('uno:2', 'lcd1:D7'),
      W('lcd1:VSS', G), W('lcd1:VDD', V5), W('lcd1:V0', 'uno:GND.2'), W('lcd1:RW', 'uno:GND.2'), W('lcd1:A', V5), W('lcd1:K', 'uno:GND.2')] },

  { id: 'sonar', title: 'Sensor Parkir (HC-SR04 + Buzzer)', desc: 'Ukur jarak dengan pulseIn; makin dekat makin cepat bunyinya. Ubah jarak di Properti.',
    code: `const int TRIG = 7, ECHO = 6, BUZZER = 8;

long jarakCm() {
  digitalWrite(TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long durasi = pulseIn(ECHO, HIGH, 30000);
  return durasi / 58;
}

void setup() {
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  Serial.begin(9600);
}

void loop() {
  long cm = jarakCm();
  Serial.print("Jarak: ");
  Serial.print(cm);
  Serial.println(" cm");
  if (cm > 0 && cm < 100) {
    tone(BUZZER, 1000, 60);
    delay(cm * 5 + 40);
  } else {
    delay(200);
  }
}
`,
    parts: [U(), P('sonar1', 'wokwi-hc-sr04', 330, -170, { distance: 80 }), P('bz1', 'wokwi-buzzer', 20, -150)],
    wires: [W('uno:7', 'sonar1:TRIG'), W('uno:6', 'sonar1:ECHO'), W('sonar1:VCC', V5), W('sonar1:GND', G), W('uno:8', 'bz1:1'), W('bz1:2', 'uno:GND.2')] },

  { id: 'neopixel', title: 'NeoPixel Ring', desc: 'Adafruit_NeoPixel asli: 16 piksel berputar warna-warni.',
    code: `#include <Adafruit_NeoPixel.h>

#define PIN 6
#define N 16
Adafruit_NeoPixel ring(N, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  ring.begin();
  ring.setBrightness(60);
}

void loop() {
  static int pos = 0;
  ring.clear();
  for (int i = 0; i < 5; i++) {
    int idx = (pos + i) % N;
    ring.setPixelColor(idx, ring.Color(20 + i * 50, 255 - i * 50, 80 + i * 30));
  }
  ring.show();
  pos = (pos + 1) % N;
  delay(80);
}
`,
    parts: [U(), P('ring1', 'wokwi-led-ring', 330, -190, { pixels: 16 })],
    wires: [W('uno:6', 'ring1:DIN'), W('ring1:VCC', V5), W('ring1:GND', G)] },

  { id: '7seg', title: '7-Segment Penghitung 0–9', desc: 'Menggambar angka lewat pola segmen A–G.',
    code: `// pin segmen A..G -> 2..8
const int SEG[7] = {2, 3, 4, 5, 6, 7, 8};
const byte POLA[10] = {            // bit0 = A ... bit6 = G
  0b0111111, 0b0000110, 0b1011011, 0b1001111, 0b1100110,
  0b1101101, 0b1111101, 0b0000111, 0b1111111, 0b1101111
};

void tampil(int angka) {
  for (int i = 0; i < 7; i++) digitalWrite(SEG[i], (POLA[angka] >> i) & 1);
}

void setup() {
  for (int i = 0; i < 7; i++) pinMode(SEG[i], OUTPUT);
}

void loop() {
  for (int n = 0; n < 10; n++) { tampil(n); delay(800); }
}
`,
    parts: [U(), P('seg1', 'wokwi-7segment', 340, -170, { common: 'cathode', color: 'red' }), R('r1', 190, -40)],
    wires: [W('uno:2', 'seg1:A'), W('uno:3', 'seg1:B'), W('uno:4', 'seg1:C'), W('uno:5', 'seg1:D'), W('uno:6', 'seg1:E'), W('uno:7', 'seg1:F'), W('uno:8', 'seg1:G'),
      W('seg1:COM.1', 'r1:1'), W('r1:2', G)] },

  { id: 'keypad', title: 'Keypad 4x4 → Serial', desc: 'Pemindaian matriks tombol; klik tombol keypad dan lihat di tab Serial.',
    code: `const int BARIS[4] = {9, 8, 7, 6};
const int KOLOM[4] = {5, 4, 3, 2};
const char TOMBOL[4][4] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};

void setup() {
  Serial.begin(9600);
  for (int r = 0; r < 4; r++) pinMode(BARIS[r], INPUT_PULLUP);
  for (int c = 0; c < 4; c++) { pinMode(KOLOM[c], OUTPUT); digitalWrite(KOLOM[c], HIGH); }
  Serial.println("Tekan tombol keypad...");
}

char baca() {
  for (int c = 0; c < 4; c++) {
    digitalWrite(KOLOM[c], LOW);
    for (int r = 0; r < 4; r++) {
      if (digitalRead(BARIS[r]) == LOW) {
        digitalWrite(KOLOM[c], HIGH);
        return TOMBOL[r][c];
      }
    }
    digitalWrite(KOLOM[c], HIGH);
  }
  return 0;
}

void loop() {
  static char terakhir = 0;
  char k = baca();
  if (k && k != terakhir) { Serial.print("Tombol: "); Serial.println(k); }
  terakhir = k;
  delay(20);
}
`,
    parts: [U(), P('kp1', 'wokwi-membrane-keypad', 330, -330)],
    wires: [W('uno:9', 'kp1:R1'), W('uno:8', 'kp1:R2'), W('uno:7', 'kp1:R3'), W('uno:6', 'kp1:R4'), W('uno:5', 'kp1:C1'), W('uno:4', 'kp1:C2'), W('uno:3', 'kp1:C3'), W('uno:2', 'kp1:C4')] },

  { id: 'ntc-lcd', title: 'Termometer NTC → LCD', desc: 'Sensor NTC dibaca ADC, dikonversi ke °C (persamaan Beta) lalu ditampilkan di LCD.',
    code: `#include <LiquidCrystal.h>

LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
const float BETA = 3950.0;

void setup() {
  lcd.begin(16, 2);
  lcd.print("Suhu ruangan:");
  Serial.begin(9600);
}

void loop() {
  int adc = analogRead(A0);
  float celsius = 1 / (log(1 / (1023. / adc - 1)) / BETA + 1.0 / 298.15) - 273.15;
  lcd.setCursor(0, 1);
  lcd.print(celsius, 1);
  lcd.print(" C    ");
  Serial.print("ADC=");
  Serial.print(adc);
  Serial.print("  T=");
  Serial.println(celsius);
  delay(500);
}
`,
    parts: [U(), P('lcd1', 'wokwi-lcd1602', 330, -240, { background: 'blue' }), P('ntc1', 'wokwi-ntc-temperature-sensor', 330, 230, { level: 24 })],
    wires: [W('uno:12', 'lcd1:RS'), W('uno:11', 'lcd1:E'), W('uno:5', 'lcd1:D4'), W('uno:4', 'lcd1:D5'), W('uno:3', 'lcd1:D6'), W('uno:2', 'lcd1:D7'),
      W('lcd1:VSS', G), W('lcd1:VDD', V5), W('lcd1:V0', 'uno:GND.2'), W('lcd1:RW', 'uno:GND.2'), W('lcd1:A', V5), W('lcd1:K', 'uno:GND.2'),
      W('ntc1:OUT', 'uno:A0'), W('ntc1:VCC', V5), W('ntc1:GND', 'uno:GND.3')] },

  { id: 'melody', title: 'Melodi Buzzer', desc: 'tone() memainkan nada Do-Re-Mi (aktifkan suara browser lewat tombol Jalankan).',
    code: `const int BUZZER = 8;
const int NADA[8]  = {262, 294, 330, 349, 392, 440, 494, 523};  // C4..C5
const char* NAMA[8] = {"Do", "Re", "Mi", "Fa", "Sol", "La", "Si", "Do'"};

void setup() {
  Serial.begin(9600);
}

void loop() {
  for (int i = 0; i < 8; i++) {
    Serial.println(NAMA[i]);
    tone(BUZZER, NADA[i], 300);
    delay(400);
  }
  noTone(BUZZER);
  delay(1500);
}
`,
    parts: [U(), P('bz1', 'wokwi-buzzer', 330, -150)],
    wires: [W('uno:8', 'bz1:1'), W('bz1:2', G)] },
];

export function exampleModel(ex) {
  return { version: 1, parts: ex.parts, connections: ex.wires };
}
