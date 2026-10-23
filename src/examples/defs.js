// Example circuits. Pin names follow @wokwi/elements. Coordinates are in CSS px (world space).
const P = (id, type, left, top, attrs = {}) => ({ id, type, left, top, attrs });
const U = (x = 0, y = 0) => P('uno', 'wokwi-arduino-uno', x, y);
const R = (id, x, y, v = '220') => P(id, 'wokwi-resistor', x, y, { value: v });
const W = (a, b) => [a, b];
const G = 'uno:GND.1', V5 = 'uno:5V';

export const EXAMPLES = [
  { id: 'blink', group: 'Dasar', title: 'Blink LED', desc: 'LED eksternal + LED bawaan (pin 13) berkedip tiap 0,5 detik.',
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

  { id: 'button', group: 'Dasar', title: 'Tombol + LED', desc: 'Tombol dengan INPUT_PULLUP menyalakan LED. Klik tombol saat simulasi berjalan.',
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

  { id: 'pot-pwm', group: 'Dasar', title: 'Potensiometer → kecerahan LED', desc: 'analogRead dari potensiometer mengatur PWM LED. Geser nilai di panel Properti.',
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

  { id: 'traffic', group: 'Dasar', title: 'Lampu Lalu Lintas', desc: 'Tiga LED merah-kuning-hijau dengan siklus waktu nyata.',
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

  { id: 'rgb', group: 'Dasar', title: 'LED RGB Fade', desc: 'Tiga kanal PWM menghasilkan pelangi pada LED RGB.',
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

  { id: 'servo', group: 'Aktuator & motor', title: 'Servo dikendalikan Potensiometer', desc: 'Library Servo asli; sudut horn mengikuti posisi potensiometer.',
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

  { id: 'lcd', group: 'Tampilan', title: 'LCD 16x2 – Penghitung', desc: 'LiquidCrystal asli (mode 4-bit): teks dan penghitung detik.',
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

  { id: 'sonar', group: 'Sensor & IoT', title: 'Sensor Parkir (HC-SR04 + Buzzer)', desc: 'Ukur jarak dengan pulseIn; makin dekat makin cepat bunyinya. Ubah jarak di Properti.',
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

  { id: 'neopixel', group: 'Tampilan', title: 'NeoPixel Ring', desc: 'Adafruit_NeoPixel asli: 16 piksel berputar warna-warni.',
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

  { id: '7seg', group: 'Dasar', title: '7-Segment Penghitung 0–9', desc: 'Menggambar angka lewat pola segmen A–G.',
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

  { id: 'keypad', group: 'Sensor & IoT', title: 'Keypad 4x4 → Serial', desc: 'Pemindaian matriks tombol; klik tombol keypad dan lihat di tab Serial.',
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

  { id: 'ntc-lcd', group: 'Sensor & IoT', title: 'Termometer NTC → LCD', desc: 'Sensor NTC dibaca ADC, dikonversi ke °C (persamaan Beta) lalu ditampilkan di LCD.',
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

  { id: 'melody', group: 'Dasar', title: 'Melodi Buzzer', desc: 'tone() memainkan nada Do-Re-Mi (aktifkan suara browser lewat tombol Jalankan).',
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

  // ======================================================================= IoT & sensor modules (new)
  { id: 'relay-lamp', group: 'Aktuator & motor', title: 'Relay: lampu dengan tombol', tags: ['relay', 'baterai'], desc: 'Tombol menyalakan relay (aktif LOW). Lampu (LED) dicatu baterai 9V lewat COM–NO.',
    code: `// Relay aktif LOW: digitalWrite(RELAY, LOW) = relay ON
const int TOMBOL = 2;
const int RELAY = 7;
bool lampu = false, sebelumnya = HIGH;

void setup() {
  pinMode(TOMBOL, INPUT_PULLUP);
  pinMode(RELAY, OUTPUT);
  digitalWrite(RELAY, HIGH);      // relay mati saat awal
  Serial.begin(9600);
}

void loop() {
  bool sekarang = digitalRead(TOMBOL);
  if (sebelumnya == HIGH && sekarang == LOW) {   // tombol baru ditekan
    lampu = !lampu;
    digitalWrite(RELAY, lampu ? LOW : HIGH);
    Serial.println(lampu ? "Lampu ON" : "Lampu OFF");
    delay(50);
  }
  sebelumnya = sekarang;
}
`,
    parts: [U(), P('btn1', 'wokwi-pushbutton', 330, 70, { color: 'green' }), P('relay1', 'mod-relay1', 330, -150, { trigger: 'LOW' }), P('bat1', 'mod-battery9v', 520, -330, { voltage: 9 }), R('r1', 500, -110, '470'), P('led1', 'wokwi-led', 590, -150, { color: 'yellow' })],
    wires: [W('uno:2', 'btn1:1.l'), W('btn1:2.l', 'uno:GND.2'), W('relay1:VCC', V5), W('relay1:GND', 'uno:GND.3'), W('relay1:IN', 'uno:7'), W('bat1:+', 'relay1:COM'), W('relay1:NO', 'r1:1'), W('r1:2', 'led1:A'), W('led1:C', 'bat1:-')] },

  { id: 'dht-lcd-i2c', group: 'Sensor & IoT', title: 'Stasiun cuaca: DHT22 + LCD I2C', tags: ['DHT22', 'LCD I2C', 'library'], desc: 'Suhu & kelembapan dari DHT22 tampil di LCD 16x2 I2C. Ubah suhu/kelembapan di panel Properti.',
    code: `#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>

#define PIN_DHT 2
DHT dht(PIN_DHT, DHT22);
LiquidCrystal_I2C lcd(0x27, 16, 2);   // SDA = A4, SCL = A5

void setup() {
  Serial.begin(9600);
  dht.begin();
  lcd.init();
  lcd.backlight();
  lcd.print("Stasiun Cuaca");
}

void loop() {
  delay(2000);                        // DHT22 dibaca paling cepat tiap 2 detik
  float suhu = dht.readTemperature();
  float rh = dht.readHumidity();
  if (isnan(suhu) || isnan(rh)) {
    Serial.println("Gagal membaca DHT22!");
    return;
  }
  lcd.setCursor(0, 0); lcd.print("Suhu: "); lcd.print(suhu, 1); lcd.print((char)223); lcd.print("C   ");
  lcd.setCursor(0, 1); lcd.print("RH  : "); lcd.print(rh, 1); lcd.print(" %   ");
  Serial.print("Suhu="); Serial.print(suhu); Serial.print(" C  RH="); Serial.print(rh); Serial.println(" %");
}
`,
    parts: [U(), P('dht1', 'wokwi-dht22', 340, 60, { temperature: 29.5, humidity: 70 }), P('lcd1', 'x-lcd1602-i2c', 300, -170, { address: '0x27', background: 'blue' })],
    wires: [W('dht1:VCC', V5), W('dht1:GND', 'uno:GND.2'), W('dht1:SDA', 'uno:2'), W('lcd1:GND', 'uno:GND.3'), W('lcd1:VCC', V5), W('lcd1:SDA', 'uno:A4'), W('lcd1:SCL', 'uno:A5')] },

  { id: 'oled', group: 'Tampilan', title: 'OLED 0.96" I2C: grafik potensiometer', tags: ['OLED', 'SSD1306', 'I2C'], desc: 'Adafruit_SSD1306 menampilkan teks dan grafik batang nilai potensiometer.',
    code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 layar(128, 64, &Wire, -1);

void setup() {
  Serial.begin(9600);
  if (!layar.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED tidak ditemukan");
    while (true) {}
  }
}

void loop() {
  int nilai = analogRead(A0);
  int lebar = map(nilai, 0, 1023, 0, 120);
  layar.clearDisplay();
  layar.setTextSize(1);
  layar.setTextColor(SSD1306_WHITE);
  layar.setCursor(0, 0);
  layar.println("STEAM KBS - OLED");
  layar.setTextSize(2);
  layar.setCursor(0, 18);
  layar.print("ADC ");
  layar.print(nilai);
  layar.drawRect(0, 46, 124, 14, SSD1306_WHITE);
  layar.fillRect(2, 48, lebar, 10, SSD1306_WHITE);
  layar.display();
  delay(100);
}
`,
    parts: [U(), P('oled1', 'mod-oled-i2c', 330, -170), P('pot1', 'wokwi-potentiometer', 340, 220, { value: 60 })],
    wires: [W('oled1:GND', 'uno:GND.2'), W('oled1:VCC', V5), W('oled1:SDA', 'uno:A4'), W('oled1:SCL', 'uno:A5'), W('pot1:SIG', 'uno:A0'), W('pot1:VCC', V5), W('pot1:GND', 'uno:GND.3')] },

  { id: 'irrigation', group: 'Sensor & IoT', title: 'Penyiraman otomatis (soil + relay + pompa)', tags: ['soil moisture', 'relay', 'pompa', 'SDGs'], desc: 'Tanah kering → relay menyalakan pompa (dicatu baterai). Atur kelembapan tanah di Properti.',
    code: `// Penyiraman otomatis
const int SENSOR = A0;     // AO sensor kelembapan tanah
const int RELAY = 7;       // modul relay aktif LOW
const int BATAS_KERING = 600;   // nilai ADC: makin besar = makin kering

void setup() {
  pinMode(RELAY, OUTPUT);
  digitalWrite(RELAY, HIGH);
  Serial.begin(9600);
}

void loop() {
  int nilai = analogRead(SENSOR);
  int persen = map(nilai, 1023, 255, 0, 100);   // perkiraan % kelembapan
  bool kering = nilai > BATAS_KERING;
  digitalWrite(RELAY, kering ? LOW : HIGH);
  Serial.print("ADC=");
  Serial.print(nilai);
  Serial.print("  kelembapan~");
  Serial.print(constrain(persen, 0, 100));
  Serial.print("%  pompa ");
  Serial.println(kering ? "ON" : "OFF");
  delay(500);
}
`,
    parts: [U(), P('soil1', 'mod-soil', 340, 40, { level: 20, threshold: 50 }), P('relay1', 'mod-relay1', 330, -160, { trigger: 'LOW' }), P('bat1', 'mod-battery9v', 520, -340, { voltage: 6 }), P('pump1', 'mod-pump', 560, -160)],
    wires: [W('soil1:VCC', V5), W('soil1:GND', 'uno:GND.2'), W('soil1:AO', 'uno:A0'), W('relay1:VCC', V5), W('relay1:GND', 'uno:GND.3'), W('relay1:IN', 'uno:7'), W('bat1:+', 'relay1:COM'), W('relay1:NO', 'pump1:+'), W('pump1:-', 'bat1:-')] },

  { id: 'water-alarm', group: 'Sensor & IoT', title: 'Peringatan banjir (water level)', tags: ['water level', 'buzzer', 'LED'], desc: 'Tiga tingkat status (aman/siaga/bahaya) dengan LED dan buzzer dari sensor ketinggian air.',
    code: `const int SENSOR = A0;
const int HIJAU = 8, KUNING = 9, MERAH = 10, BUZZER = 6;

void setup() {
  pinMode(HIJAU, OUTPUT); pinMode(KUNING, OUTPUT); pinMode(MERAH, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int level = analogRead(SENSOR);   // 0 = kering
  digitalWrite(HIJAU, level < 250);
  digitalWrite(KUNING, level >= 250 && level < 500);
  digitalWrite(MERAH, level >= 500);
  if (level >= 500) tone(BUZZER, 1800, 150); 
  Serial.print("Level air: "); Serial.print(level);
  Serial.println(level >= 500 ? "  BAHAYA" : level >= 250 ? "  SIAGA" : "  AMAN");
  delay(300);
}
`,
    parts: [U(), P('wl1', 'mod-water-level', 360, 30, { level: 55 }), P('tl1', 'mod-traffic', 200, -170), P('bz1', 'wokwi-buzzer', 20, -150)],
    wires: [W('wl1:+', V5), W('wl1:-', 'uno:GND.2'), W('wl1:S', 'uno:A0'), W('tl1:G', 'uno:8'), W('tl1:Y', 'uno:9'), W('tl1:R', 'uno:10'), W('tl1:GND', G), W('bz1:1', 'uno:6'), W('bz1:2', G)] },

  { id: 'mpu6050', group: 'Sensor & IoT', title: 'Kemiringan dengan MPU6050 (Wire)', tags: ['MPU6050', 'I2C', 'gyro'], desc: 'Baca akselerometer lewat Wire tanpa library tambahan, hitung sudut pitch/roll. Geser nilai aksel di Properti.',
    code: `#include <Wire.h>
const int MPU = 0x68;

int16_t baca16() { return (Wire.read() << 8) | Wire.read(); }

void setup() {
  Serial.begin(9600);
  Wire.begin();
  Wire.beginTransmission(MPU); Wire.write(0x6B); Wire.write(0); Wire.endTransmission();  // bangunkan sensor
}

void loop() {
  Wire.beginTransmission(MPU); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom(MPU, 14);
  float ax = baca16() / 16384.0, ay = baca16() / 16384.0, az = baca16() / 16384.0;
  float suhu = baca16() / 340.0 + 36.53;
  float gx = baca16() / 131.0, gy = baca16() / 131.0, gz = baca16() / 131.0;
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * 180 / PI;
  float roll  = atan2(ay, az) * 180 / PI;
  Serial.print("Pitch="); Serial.print(pitch, 1);
  Serial.print("  Roll="); Serial.print(roll, 1);
  Serial.print("  Gz="); Serial.print(gz, 0);
  Serial.print("  T="); Serial.println(suhu, 1);
  delay(300);
}
`,
    parts: [U(), P('mpu1', 'wokwi-mpu6050', 340, -120, { ax: 0.5, ay: 0, az: 0.87, gx: 0, gy: 0, gz: 30, temp: 29 })],
    wires: [W('mpu1:VCC', V5), W('mpu1:GND', 'uno:GND.2'), W('mpu1:SDA', 'uno:A4'), W('mpu1:SCL', 'uno:A5')] },

  { id: 'flow', group: 'Sensor & IoT', title: 'Debit air YF-S201 (interrupt)', tags: ['flow sensor', 'interrupt'], desc: 'Hitung pulsa dengan attachInterrupt dan ubah ke L/menit (f = 7,5 × Q).',
    code: `volatile unsigned long pulsa = 0;
void hitung() { pulsa++; }

void setup() {
  Serial.begin(9600);
  pinMode(2, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(2), hitung, RISING);
}

void loop() {
  delay(1000);
  noInterrupts(); unsigned long n = pulsa; pulsa = 0; interrupts();
  float debit = n / 7.5;   // L/menit
  Serial.print("Pulsa/detik="); Serial.print(n);
  Serial.print("  Debit="); Serial.print(debit, 1); Serial.println(" L/menit");
}
`,
    parts: [U(), P('flow1', 'mod-flow', 340, -120, { flow: 6 })],
    wires: [W('flow1:VCC', V5), W('flow1:GND', 'uno:GND.2'), W('flow1:SIG', 'uno:2')] },

  { id: 'motor-l298n', group: 'Aktuator & motor', title: 'Motor DC dengan L298N', tags: ['L298N', 'PWM', 'robot'], desc: 'Maju, berhenti, mundur dengan kecepatan PWM. Motor dicatu baterai 9V; GND disatukan.',
    code: `const int ENA = 9, IN1 = 8, IN2 = 7;

void gerak(int kecepatan, bool maju) {
  digitalWrite(IN1, maju ? HIGH : LOW);
  digitalWrite(IN2, maju ? LOW : HIGH);
  analogWrite(ENA, kecepatan);
}

void setup() {
  pinMode(ENA, OUTPUT); pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  Serial.println("Maju pelan");  gerak(120, true);  delay(2000);
  Serial.println("Maju cepat");  gerak(255, true);  delay(2000);
  Serial.println("Berhenti");    gerak(0, true);    delay(1000);
  Serial.println("Mundur");      gerak(200, false); delay(2000);
}
`,
    parts: [U(), P('drv1', 'mod-l298n', 330, -60), P('bat1', 'mod-battery9v', 540, -230, { voltage: 9 }), P('m1', 'mod-dc-motor', 540, -40)],
    wires: [W('bat1:+', 'drv1:12V'), W('bat1:-', 'drv1:GND'), W('drv1:GND', 'uno:GND.2'), W('drv1:ENA', 'uno:9'), W('drv1:IN1', 'uno:8'), W('drv1:IN2', 'uno:7'), W('drv1:OUT1', 'm1:M+'), W('drv1:OUT2', 'm1:M-')] },

  { id: 'rtc-clock', group: 'Tampilan', title: 'Jam digital RTC DS1307 + LCD I2C', tags: ['RTC', 'RTClib', 'LCD I2C'], desc: 'RTClib membaca jam dari DS1307 dan menampilkannya di LCD I2C.',
    code: `#include <Wire.h>
#include <RTClib.h>
#include <LiquidCrystal_I2C.h>

RTC_DS1307 rtc;
LiquidCrystal_I2C lcd(0x27, 16, 2);
const char* HARI[7] = {"Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"};

void dua(int n) { if (n < 10) lcd.print('0'); lcd.print(n); }

void setup() {
  lcd.init(); lcd.backlight();
  if (!rtc.begin()) { lcd.print("RTC tidak ada"); while (true) {} }
}

void loop() {
  DateTime t = rtc.now();
  lcd.setCursor(0, 0); lcd.print(HARI[t.dayOfTheWeek()]); lcd.print("      ");
  lcd.setCursor(0, 1); dua(t.hour()); lcd.print(':'); dua(t.minute()); lcd.print(':'); dua(t.second());
  lcd.print("  "); dua(t.day()); lcd.print('/'); dua(t.month());
  delay(250);
}
`,
    parts: [U(), P('rtc1', 'wokwi-ds1307', 360, 60), P('lcd1', 'x-lcd1602-i2c', 300, -170, { address: '0x27', background: 'green' })],
    wires: [W('rtc1:5V', V5), W('rtc1:GND', 'uno:GND.2'), W('rtc1:SDA', 'uno:A4'), W('rtc1:SCL', 'uno:A5'), W('lcd1:GND', 'uno:GND.3'), W('lcd1:VCC', V5), W('lcd1:SDA', 'uno:A4'), W('lcd1:SCL', 'uno:A5')] },

  { id: 'breadboard-led', group: 'Breadboard', title: 'LED di breadboard', tags: ['breadboard', 'rangkaian'], desc: 'Resistor dan LED tertancap di breadboard (kaki menempel otomatis). Kolom a–e satu jalur.',
    code: `void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH); delay(400);
  digitalWrite(13, LOW);  delay(400);
}
`,
    parts: [U(0, 40), P('bb1', 'x-breadboard-half', -20, -250), R('r1', -20 + 89.4, -250 + 34), P('led1', 'wokwi-led', -20 + 123.8, -250 + 17.2, { color: 'green' })],
    wires: [W('uno:13', 'bb1:T9.e'), W('bb1:T14.e', 'uno:GND.1')] },

  // ======================================================================= ESP32 family: design + wiring check (code is for Arduino IDE)
  { id: 'esp32-iot', group: 'ESP32 (mode desain)', board: 'design', title: 'ESP32: monitoring tanaman (DHT22, soil, relay, LCD)', tags: ['ESP32', 'WiFi', 'IoT'], desc: 'Rangkaian IoT ESP32 lengkap. Daya & sensor disimulasikan; wiring diperiksa (3.3 V, ADC1, strapping). Kode untuk Arduino IDE.',
    code: `// ESP32 DevKit V1 - monitoring tanaman (unggah dengan Arduino IDE, board "DOIT ESP32 DEVKIT V1")
#include <WiFi.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>

const char* WIFI_SSID = "NAMA_WIFI";
const char* WIFI_PASS = "PASSWORD_WIFI";

#define PIN_DHT   4      // data DHT22
#define PIN_SOIL  34     // AOUT sensor tanah (ADC1, aman dipakai bersama WiFi)
#define PIN_RELAY 26     // IN relay (aktif LOW)
DHT dht(PIN_DHT, DHT22);
LiquidCrystal_I2C lcd(0x27, 16, 2);   // SDA = GPIO21, SCL = GPIO22

void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, HIGH);
  dht.begin();
  lcd.init(); lcd.backlight();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lcd.print("Hubungkan WiFi");
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  lcd.clear();
  lcd.print(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : String("WiFi gagal"));
}

void loop() {
  float suhu = dht.readTemperature();
  float rh = dht.readHumidity();
  int tanah = analogRead(PIN_SOIL);           // 0..4095 (12 bit)
  bool kering = tanah > 2600;
  digitalWrite(PIN_RELAY, kering ? LOW : HIGH);
  lcd.setCursor(0, 1);
  lcd.printf("%.1fC %2.0f%% %s ", suhu, rh, kering ? "SIRAM" : "OK");
  Serial.printf("Suhu=%.1f RH=%.0f Tanah=%d Pompa=%s\\n", suhu, rh, tanah, kering ? "ON" : "OFF");
  delay(2000);
}
`,
    parts: [P('esp32', 'wokwi-esp32-devkit-v1', 0, 0), P('dht1', 'wokwi-dht22', 200, 40, { temperature: 30, humidity: 68 }), P('soil1', 'mod-soil-cap', -170, 10, { level: 25 }),
      P('relay1', 'mod-relay1', 200, -110, { trigger: 'LOW' }), P('lcd1', 'x-lcd1602-i2c', -40, -240, { address: '0x27', background: 'blue' })],
    wires: [W('dht1:VCC', 'esp32:3V3'), W('dht1:GND', 'esp32:GND.1'), W('dht1:SDA', 'esp32:D4'), W('soil1:VCC', 'esp32:3V3'), W('soil1:GND', 'esp32:GND.2'), W('soil1:AOUT', 'esp32:D34'),
      W('relay1:VCC', 'esp32:VIN'), W('relay1:GND', 'esp32:GND.1'), W('relay1:IN', 'esp32:D26'), W('lcd1:VCC', 'esp32:VIN'), W('lcd1:GND', 'esp32:GND.2'), W('lcd1:SDA', 'esp32:D21'), W('lcd1:SCL', 'esp32:D22')] },

  { id: 'esp32cam-pir', group: 'ESP32 (mode desain)', board: 'design', title: 'ESP32-CAM: kamera dipicu sensor gerak', tags: ['ESP32-CAM', 'PIR', 'Edge Impulse'], desc: 'Rangkaian kamera keamanan: PIR di IO13 memicu pengambilan foto. Dasar untuk proyek klasifikasi gambar (Edge Impulse).',
    code: `// ESP32-CAM (AI-Thinker) - ambil foto saat PIR mendeteksi gerakan
// Arduino IDE: board "AI Thinker ESP32-CAM", PSRAM Enabled. Upload: IO0 ke GND, tekan RESET.
#include "esp_camera.h"

#define PIN_PIR 13
// pin kamera AI-Thinker
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PIR, INPUT);
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM; c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG; c.frame_size = FRAMESIZE_QVGA; c.jpeg_quality = 12; c.fb_count = 1;
  if (esp_camera_init(&c) != ESP_OK) { Serial.println("Kamera gagal"); while (true) delay(1000); }
  Serial.println("Kamera siap");
}

void loop() {
  if (digitalRead(PIN_PIR) == HIGH) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) {
      Serial.printf("Gerakan! Foto %ux%u, %u byte\\n", fb->width, fb->height, fb->len);
      // di sini: kirim foto (HTTP/Telegram) atau jalankan model Edge Impulse
      esp_camera_fb_return(fb);
    }
    delay(3000);
  }
  delay(100);
}
`,
    parts: [P('cam', 'mod-esp32-cam', 0, 0), P('pir1', 'wokwi-pir-motion-sensor', -190, 40, { motion: false })],
    wires: [W('pir1:VCC', 'cam:5V'), W('pir1:GND', 'cam:GND'), W('pir1:OUT', 'cam:IO13')] },
];

export const EXAMPLE_GROUPS = ['Dasar', 'Sensor & IoT', 'Tampilan', 'Aktuator & motor', 'Breadboard', 'ESP32 (mode desain)'];

export function exampleModel(ex) {
  return { version: 1, parts: ex.parts, connections: ex.wires };
}
