// Knowledge base for "Sambung otomatis", "Kode otomatis" and the Newbie guide:
// what each pin of a component does, how to code the component with the bundled libraries, and how to test it.
// Pure data / string builders (no DOM), so the generated sketches can be compile-tested headlessly.

const base = (n) => (/^\d+\.\d+V$/.test(n) ? n : String(n).split('.')[0]).toUpperCase();

// ------------------------------------------------------------------ pin explanations
const PIN_NOTE = {
  TRIG: 'TRIG menerima pulsa 10 µs dari mikrokontroler untuk memulai pengukuran → dipasang ke pin yang diatur OUTPUT.',
  ECHO: 'ECHO mengirim pulsa balik; lebarnya sebanding dengan jarak → dipasang ke pin INPUT dan dibaca dengan pulseIn().',
  SDA: 'SDA adalah jalur data I²C. Semua modul I²C memakai pin SDA yang sama (bus bersama, dibedakan alamat).',
  SCL: 'SCL adalah jalur clock I²C, dipakai bersama oleh semua modul I²C.',
  DATA: 'DATA adalah jalur data satu kabel (single-wire) → pin digital apa saja.',
  SDA_DHT: 'SDA pada DHT22 adalah jalur data satu kabel (bukan I²C) → pin digital apa saja.',
  DQ: 'DQ adalah jalur 1-Wire; wajib diberi resistor pull-up 4,7 kΩ ke VCC.',
  OUT: 'OUT adalah keluaran sensor → dibaca mikrokontroler sebagai INPUT.',
  DO: 'DO (digital out) bernilai HIGH/LOW sesuai ambang yang diatur trimpot modul → pin INPUT digital.',
  DOUT: 'DOUT adalah keluaran digital sensor → pin INPUT digital.',
  AO: 'AO (analog out) memberi tegangan 0–VCC sesuai besaran yang diukur → harus ke pin ADC (analog).',
  AOUT: 'AOUT memberi tegangan analog → harus ke pin ADC (analog).',
  SIG: 'SIG adalah pin sinyal utama komponen.',
  IN: 'IN adalah masukan kendali modul → dipasang ke pin OUTPUT mikrokontroler.',
  IN1: 'IN1 adalah masukan kendali kanal 1 → pin OUTPUT mikrokontroler.',
  PWM: 'PWM membutuhkan pin yang mendukung PWM (bertanda ~ pada Arduino).',
  VCC: 'VCC adalah catu daya positif modul.', VDD: 'VDD adalah catu daya positif.', GND: 'GND adalah ground; semua GND harus disatukan agar tegangan punya acuan yang sama.',
  A: 'Kaki A (anoda, kaki panjang) LED ke pin OUTPUT melalui resistor 220 Ω.', C: 'Kaki C (katoda, kaki pendek, sisi datar) LED ke GND.',
  SEL: 'SEL adalah tombol tekan joystick → pin INPUT_PULLUP.', HORZ: 'HORZ = sumbu X joystick → pin ADC.', VERT: 'VERT = sumbu Y joystick → pin ADC.',
  CLK: 'CLK adalah sinyal clock.', DT: 'DT adalah sinyal data/arah encoder.', SW: 'SW adalah tombol tekan → pin INPUT_PULLUP.',
  DIN: 'DIN adalah masukan data LED (NeoPixel) → pin digital OUTPUT.', TX: 'TX modul ke RX mikrokontroler (bersilang).', RX: 'RX modul ke TX mikrokontroler (bersilang).',
};
const ROLE_NOTE = {
  gnd: 'GND ke GND mikrokontroler.', power: 'catu daya modul.', i2c: 'jalur I²C bawaan board.', spi: 'jalur SPI bawaan board.', uart: 'jalur serial (UART), TX↔RX bersilang.',
  analog: 'keluaran analog → pin ADC.', digital: 'sinyal digital → pin GPIO bebas.',
};
/** one sentence explaining why compPin goes to mcuPin */
export function pinReason(type, compPin, step, board) {
  const B = base(compPin);
  let s = (type === 'wokwi-dht22' && B === 'SDA' ? PIN_NOTE.SDA_DHT : PIN_NOTE[B]) || `${compPin}: ${ROLE_NOTE[step.role] || 'sinyal.'}`;
  if (step.role === 'power') s += ` Modul ini bekerja di ${step.v >= 5 ? '5 V' : '3,3 V'}, jadi disambung ke ${step.mcuPin}.`;
  if (step.role === 'analog' && /esp32/.test(board)) s += ' Di ESP32 dipilih ADC1 (GPIO32–39) karena ADC2 tidak bisa dibaca saat WiFi aktif.';
  if (step.role === 'i2c') s += ` Pada board ini ${B} ada di pin ${step.mcuPin}.`;
  if (step.pwm && /^(uno|nano|mega)$/.test(board)) s += ` Pin ${step.mcuPin} mendukung PWM (~).`;
  if (B === 'ECHO' && /esp32|esp8266|rp2040/.test(board)) s += ' Catatan: HC-SR04 bertegangan 5 V; pada board 3,3 V beri pembagi tegangan (1 kΩ + 2 kΩ) di jalur ECHO.';
  return s;
}
/** wire colour convention for the guide */
export const wireColorTip = (role) => (role === 'power' ? 'Pakai kabel merah untuk daya (VCC).' : role === 'gnd' ? 'Pakai kabel hitam untuk GND.' : role === 'i2c' ? 'Biasanya SDA kuning/biru, SCL hijau/putih.' : 'Pakai warna lain (kuning, hijau, oranye, biru) untuk sinyal, satu warna per fungsi.');

// ------------------------------------------------------------------ code templates
/**
 * @typedef {{ id: string, type: string, attrs: object, pins: Record<string,string>, board: string, adcMax: number }} Ctx
 * pins: component pin (base name, upper case) -> Arduino pin expression (e.g. "5", "A0", "D5" -> 5)
 */
const V = (id) => id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
const vn = (id) => id.replace(/[^A-Za-z0-9]/g, '_');
const pinConst = (c, name, expr) => `const int PIN_${V(c.id)}_${name} = ${expr};`;
const P = (c, name) => `PIN_${V(c.id)}_${name}`;
const need = (c, ...names) => names.every((n) => c.pins[n] != null);
const missing = (c, ...names) => names.filter((n) => c.pins[n] == null);
const isEsp32 = (c) => /esp32/.test(c.board);

const analogSensor = (label, pin, unitNote, testTip) => (c) => {
  if (!need(c, pin)) return null;
  return {
    glob: [pinConst(c, pin, c.pins[pin])],
    loop: [`int ${vn(c.id)}Raw = analogRead(${P(c, pin)});`, `Serial.print("${label} ${c.id}: "); Serial.println(${vn(c.id)}Raw);`],
    explain: `analogRead() membaca tegangan pin ${pin} sebagai angka 0–${c.adcMax}${unitNote ? ' ' + unitNote : ''}.`,
    test: testTip,
  };
};
const digitalSensor = (label, pin, activeLow, testTip) => (c) => {
  if (!need(c, pin)) return null;
  return {
    glob: [pinConst(c, pin, c.pins[pin])],
    setup: [`pinMode(${P(c, pin)}, INPUT);`],
    loop: [`bool ${vn(c.id)}On = digitalRead(${P(c, pin)}) == ${activeLow ? 'LOW' : 'HIGH'};`, `Serial.print("${label} ${c.id}: "); Serial.println(${vn(c.id)}On ? "YA" : "tidak");`],
    explain: `digitalRead() membaca pin ${pin}: ${activeLow ? 'LOW' : 'HIGH'} berarti ${label.toLowerCase()} terdeteksi.`,
    test: testTip,
  };
};
const TEST_DRAG = 'Jalankan simulasi, lalu ubah nilai sensor di panel Properti (atau seret sensor naik-turun di tampilan 3D); angka di Serial Monitor harus ikut berubah.';
const TEST_TOGGLE = 'Jalankan simulasi, lalu ketuk sensor di tampilan 3D (atau ubah di panel Properti) untuk memicu; Serial Monitor menampilkan YA / tidak.';

export const TEMPLATES = [
  [/^wokwi-led$/, (c) => need(c, 'A') && {
    glob: [pinConst(c, 'A', c.pins.A)], setup: [`pinMode(${P(c, 'A')}, OUTPUT);`],
    loop: [`digitalWrite(${P(c, 'A')}, (millis() / 500) % 2);   // kedip tiap 0,5 detik`],
    explain: 'pinMode(OUTPUT) menjadikan pin sebagai keluaran; digitalWrite HIGH menyalakan LED, LOW mematikan.',
    test: 'Jalankan simulasi: LED berkedip. Ukur pin A dengan multimeter 3D: bergantian HIGH/LOW. Jangan lupa resistor 220 Ω seri dengan LED.' }],
  [/^wokwi-rgb-led$/, (c) => need(c, 'R', 'G', 'B') && {
    glob: [pinConst(c, 'R', c.pins.R), pinConst(c, 'G', c.pins.G), pinConst(c, 'B', c.pins.B)],
    setup: [`pinMode(${P(c, 'R')}, OUTPUT); pinMode(${P(c, 'G')}, OUTPUT); pinMode(${P(c, 'B')}, OUTPUT);`],
    loop: [`int ${vn(c.id)}Step = (millis() / 700) % 3;`, `digitalWrite(${P(c, 'R')}, ${vn(c.id)}Step == 0); digitalWrite(${P(c, 'G')}, ${vn(c.id)}Step == 1); digitalWrite(${P(c, 'B')}, ${vn(c.id)}Step == 2);`],
    explain: 'Tiga pin mengatur warna merah, hijau, biru. Kombinasi HIGH menghasilkan warna campuran.', test: 'Jalankan simulasi: warna berganti merah → hijau → biru.' }],
  [/^wokwi-buzzer$/, (c) => need(c, '1') && {
    glob: [pinConst(c, 'SIG', c.pins['1'])], setup: [`pinMode(${P(c, 'SIG')}, OUTPUT);`],
    loop: [`if ((millis() / 1000) % 2) tone(${P(c, 'SIG')}, 1000); else noTone(${P(c, 'SIG')});`],
    explain: 'tone(pin, frekuensi) membunyikan buzzer; noTone() mematikannya.', test: 'Jalankan simulasi dan nyalakan suara browser: terdengar bunyi 1 kHz tiap 1 detik.' }],
  [/pushbutton/, (c) => need(c, '1') && {
    glob: [pinConst(c, 'BTN', c.pins['1'])], setup: [`pinMode(${P(c, 'BTN')}, INPUT_PULLUP);   // tombol ke GND, tidak perlu resistor`],
    loop: [`if (digitalRead(${P(c, 'BTN')}) == LOW) Serial.println("Tombol ${c.id} ditekan");`],
    explain: 'INPUT_PULLUP mengaktifkan resistor pull-up internal: pin HIGH saat dilepas, LOW saat ditekan (karena kaki lain ke GND).',
    test: 'Jalankan simulasi lalu tekan tombol (di 2D atau di model 3D): Serial Monitor menulis "ditekan".' }],
  [/^wokwi-slide-switch$/, (c) => need(c, '2') && {
    glob: [pinConst(c, 'SW', c.pins['2'])], setup: [`pinMode(${P(c, 'SW')}, INPUT_PULLUP);`],
    loop: [`Serial.print("Saklar ${c.id}: "); Serial.println(digitalRead(${P(c, 'SW')}) ? "posisi 1" : "posisi 2");`],
    explain: 'Kaki tengah saklar dibaca sebagai input; posisi saklar menentukan HIGH/LOW.', test: 'Geser saklar (ketuk di 3D): tulisan posisi di Serial Monitor berubah.' }],
  [/^wokwi-(potentiometer|slide-potentiometer)$/, analogSensor('Potensio', 'SIG', '(posisi kenop)', 'Jalankan simulasi lalu putar kenop (seret di 2D/3D): angka berubah 0 sampai nilai maksimum.')],
  [/^wokwi-analog-joystick$/, (c) => need(c, 'HORZ', 'VERT') && {
    glob: [pinConst(c, 'X', c.pins.HORZ), pinConst(c, 'Y', c.pins.VERT), ...(c.pins.SEL ? [pinConst(c, 'SEL', c.pins.SEL)] : [])],
    setup: c.pins.SEL ? [`pinMode(${P(c, 'SEL')}, INPUT_PULLUP);`] : [],
    loop: [`Serial.print("Joystick ${c.id} X="); Serial.print(analogRead(${P(c, 'X')})); Serial.print(" Y="); Serial.print(analogRead(${P(c, 'Y')}));`, c.pins.SEL ? `Serial.println(digitalRead(${P(c, 'SEL')}) == LOW ? " [ditekan]" : "");` : 'Serial.println();'],
    explain: 'Dua potensiometer di dalam joystick dibaca dengan analogRead; posisi tengah ≈ setengah nilai maksimum.', test: 'Seret tuas joystick di 3D: nilai X/Y berubah, ketuk untuk "ditekan".' }],
  [/^wokwi-servo$/, (c) => need(c, 'PWM') && {
    inc: [isEsp32(c) ? '#include <ESP32Servo.h>' : '#include <Servo.h>'], glob: [pinConst(c, 'PWM', c.pins.PWM), `Servo ${vn(c.id)};`],
    setup: [`${vn(c.id)}.attach(${P(c, 'PWM')});`],
    loop: [`${vn(c.id)}.write((millis() / 20) % 180);   // sapuan 0–180°`],
    explain: `Library ${isEsp32(c) ? 'ESP32Servo' : 'Servo'}: attach(pin) lalu write(sudut 0–180).`, test: 'Jalankan simulasi: tanduk servo berputar (lihat juga di 3D). Servo butuh 5 V dan GND bersama.' }],
  [/^(wokwi-hc-sr04|mod-jsn-sr04t)$/, (c) => need(c, 'TRIG', 'ECHO') && {
    glob: [pinConst(c, 'TRIG', c.pins.TRIG), pinConst(c, 'ECHO', c.pins.ECHO)],
    setup: [`pinMode(${P(c, 'TRIG')}, OUTPUT);`, `pinMode(${P(c, 'ECHO')}, INPUT);`],
    loop: [`digitalWrite(${P(c, 'TRIG')}, LOW); delayMicroseconds(2);`, `digitalWrite(${P(c, 'TRIG')}, HIGH); delayMicroseconds(10); digitalWrite(${P(c, 'TRIG')}, LOW);`,
      `long ${vn(c.id)}Us = pulseIn(${P(c, 'ECHO')}, HIGH, 30000);`, `float ${vn(c.id)}Cm = ${vn(c.id)}Us / 58.0;   // kecepatan suara: 1 cm ≈ 58 µs pulang-pergi`,
      `Serial.print("Jarak ${c.id}: "); Serial.print(${vn(c.id)}Cm); Serial.println(" cm");`],
    explain: 'Kirim pulsa 10 µs ke TRIG, lalu ukur lama pulsa ECHO dengan pulseIn(). Jarak (cm) = waktu (µs) / 58.', test: 'Jalankan simulasi lalu ubah jarak objek (seret sensor di 3D atau slider Properti): angka cm ikut berubah.' }],
  [/^(wokwi-dht22|mod-dht11)$/, (c) => { const pin = c.pins.SDA ?? c.pins.DATA ?? c.pins.OUT ?? c.pins.S; if (pin == null) return null; const t = c.type === 'mod-dht11' ? 'DHT11' : 'DHT22'; return {
    inc: ['#include <DHT.h>'], glob: [pinConst(c, 'DATA', pin), `DHT ${vn(c.id)}(${P(c, 'DATA')}, ${t});`], setup: [`${vn(c.id)}.begin();`],
    loop: [`float ${vn(c.id)}T = ${vn(c.id)}.readTemperature(), ${vn(c.id)}H = ${vn(c.id)}.readHumidity();`, `if (isnan(${vn(c.id)}T)) Serial.println("${c.id}: gagal membaca, cek kabel DATA & daya");`, `else { Serial.print("Suhu ${c.id}: "); Serial.print(${vn(c.id)}T); Serial.print(" C, kelembapan: "); Serial.print(${vn(c.id)}H); Serial.println(" %"); }`],
    explain: `Library DHT: buat objek DHT(pin, ${t}), panggil begin() di setup, lalu readTemperature() dan readHumidity(). Baca paling cepat tiap 2 detik.`, test: TEST_DRAG }; }],
  [/^(wokwi-photoresistor-sensor)$/, analogSensor('Cahaya', 'AO', '(makin terang makin besar)', TEST_DRAG)],
  [/^wokwi-ntc-temperature-sensor$/, analogSensor('NTC', 'OUT', '(ubah ke °C dengan persamaan Beta 3950)', TEST_DRAG)],
  [/^wokwi-(gas-sensor|flame-sensor|big-sound-sensor|small-sound-sensor)$/, analogSensor('Sensor', 'AOUT', '', TEST_DRAG)],
  [/^mod-soil$|^mod-rain$/, analogSensor('Kelembapan/air', 'AO', '(kering = besar pada modul resistif)', TEST_DRAG)],
  [/^mod-soil-cap$/, analogSensor('Kelembapan tanah', 'AOUT', '(basah = kecil)', TEST_DRAG)],
  [/^mod-water-level$/, analogSensor('Level air', 'S', '', TEST_DRAG)],
  [/^mod-mq135$/, analogSensor('Kualitas udara', 'AO', '(makin kotor makin besar)', TEST_DRAG)],
  [/^mod-tds$/, analogSensor('TDS', 'A', '(ubah ke ppm dengan GravityTDS)', TEST_DRAG)],
  [/^mod-ph$/, analogSensor('pH', 'PO', '(kalibrasi: pH 7 ≈ 2,5 V)', TEST_DRAG)],
  [/^mod-acs712$/, analogSensor('Arus', 'OUT', '(0 A ≈ setengah VCC)', TEST_DRAG)],
  [/^mod-voltage$/, analogSensor('Tegangan', 'S', '(×5 untuk tegangan asli)', TEST_DRAG)],
  [/^wokwi-pir-motion-sensor$/, digitalSensor('Gerakan', 'OUT', false, TEST_TOGGLE)],
  [/^mod-ir-obstacle$/, digitalSensor('Halangan', 'OUT', true, TEST_TOGGLE)],
  [/^mod-tcrt5000$/, digitalSensor('Garis hitam', 'DO', false, TEST_TOGGLE)],
  [/^mod-hall$/, digitalSensor('Magnet', 'S', true, TEST_TOGGLE)],
  [/^mod-vibration$/, digitalSensor('Getaran', 'DO', false, TEST_TOGGLE)],
  [/^mod-touch$/, digitalSensor('Sentuhan', 'SIG', false, TEST_TOGGLE)],
  [/^wokwi-tilt-switch$/, digitalSensor('Miring', 'OUT', false, TEST_TOGGLE)],
  [/^mod-gps(-m8n)?$/, (c) => {
    if (!need(c, 'TX')) return null;                     // module TX -> microcontroller RX is the line that matters
    const m8 = c.type === 'mod-gps-m8n', v = vn(c.id), baud = +(c.attrs?.baud || 9600), rx = c.pins.TX, tx = c.pins.RX ?? -1;
    const esp = /esp32/.test(c.board), mega = /mega/.test(c.board), rp = /rp2040|pico/.test(c.board);
    const hw = esp ? 'Serial2' : mega && ['19', '17', '15'].includes(rx) ? { 19: 'Serial1', 17: 'Serial2', 15: 'Serial3' }[rx] : rp && rx === '1' ? 'Serial1' : null;
    const port = hw || `${v}Serial`;
    return {
      inc: ['#include <TinyGPS++.h>', ...(hw ? [] : ['#include <SoftwareSerial.h>'])],
      glob: [pinConst(c, 'RX', rx), pinConst(c, 'TX', tx), `TinyGPSPlus ${v}Gps;`, ...(hw ? [] : [`SoftwareSerial ${port}(${P(c, 'RX')}, ${P(c, 'TX')});   // RX mikrokontroler <- TX GPS`])],
      setup: [esp ? `${port}.begin(${baud}, SERIAL_8N1, ${P(c, 'RX')}, ${P(c, 'TX')});   // TX GPS -> GPIO${rx}` : hw && rp ? `${port}.begin(${baud});   // Serial1 Pico: RX = GP1, TX = GP0` : `${port}.begin(${baud});`],
      idle: [`while (${port}.available()) ${v}Gps.encode(${port}.read());   // NMEA dibaca terus, juga selama jeda`],
      loop: [`if (${v}Gps.location.isValid()) {`,
        `  Serial.print("${c.id} lat: "); Serial.print(${v}Gps.location.lat(), 6); Serial.print("  lng: "); Serial.print(${v}Gps.location.lng(), 6);`,
        `  Serial.print("  alt: "); Serial.print(${v}Gps.altitude.meters()); Serial.print(" m  satelit: "); Serial.print(${v}Gps.satellites.value());`,
        `  Serial.print("  kecepatan: "); Serial.print(${v}Gps.speed.kmph()); Serial.println(" km/j");`,
        `} else if (millis() > 5000 && ${v}Gps.charsProcessed() < 10) Serial.println("${c.id}: tidak ada data NMEA, cek kabel TX GPS -> RX dan baud ${baud}");`,
        `else Serial.println("${c.id}: menunggu fix satelit...");`],
      explain: `${m8 ? 'NEO-M8N mengirim kalimat NMEA ($GNRMC, $GNGGA, gabungan GPS + GLONASS/Galileo/BeiDou)' : 'NEO-6M mengirim kalimat NMEA ($GPRMC, $GPGGA)'} lewat UART ${baud} baud. TinyGPS++ menguraikannya: encode() tiap byte, lalu location.lat()/lng(), altitude, satellites, speed. ${hw ? `${port} memakai UART hardware.` : 'SoftwareSerial membuat port serial di pin digital biasa.'}`,
      test: 'Jalankan simulasi: dalam ±1 detik muncul lintang/bujur. Ubah lintang, bujur, kecepatan atau fix di panel Properti dan lihat Serial Monitor ikut berubah.' };
  }],
  [/^mod-mosfet$/, (c) => need(c, 'SIG') && {
    glob: [pinConst(c, 'SIG', c.pins.SIG)], setup: [`pinMode(${P(c, 'SIG')}, OUTPUT);`],
    loop: [`analogWrite(${P(c, 'SIG')}, (millis() / 20) % 256);   // kecepatan beban naik 0 → 255 lalu ulang`],
    explain: 'Modul MOSFET menjadi saklar beban (motor, pompa, kipas) yang arusnya terlalu besar untuk pin GPIO. analogWrite (PWM) di pin SIG mengatur daya rata-rata ke beban.',
    test: 'Jalankan simulasi: putaran motor/pompa di beban naik perlahan lalu berulang dari nol.' }],
  [/^mod-npn$/, (c) => need(c, 'B') && {
    glob: [pinConst(c, 'B', c.pins.B)], setup: [`pinMode(${P(c, 'B')}, OUTPUT);`],
    loop: [`digitalWrite(${P(c, 'B')}, (millis() / 2000) % 2);   // transistor ON/OFF tiap 2 detik`],
    explain: 'Transistor NPN (2N2222) sebagai saklar: HIGH di basis (lewat resistor 1 kΩ) membuat arus mengalir dari C ke E, sehingga beban seperti koil relay menyala.',
    test: 'Jalankan simulasi: relay/beban di kolektor menyala dan mati tiap 2 detik.' }],
  [/^mod-relay[124]$/, (c) => need(c, 'IN1') || need(c, 'IN') ? {
    glob: [pinConst(c, 'IN', c.pins.IN1 ?? c.pins.IN)], setup: [`pinMode(${P(c, 'IN')}, OUTPUT);`],
    loop: [`digitalWrite(${P(c, 'IN')}, (millis() / 2000) % 2 ? ${c.attrs?.trigger === 'HIGH' ? 'HIGH' : 'LOW'} : ${c.attrs?.trigger === 'HIGH' ? 'LOW' : 'HIGH'});   // relay aktif-${c.attrs?.trigger === 'HIGH' ? 'HIGH' : 'LOW'}`],
    explain: 'Relay dikendalikan pin OUTPUT. Kebanyakan modul relay aktif-LOW: LOW = relay ON.', test: 'Jalankan simulasi: relay klik ON/OFF tiap 2 detik (LED modul menyala).' } : null],
  [/^(x-lcd1602-i2c|x-lcd2004-i2c)$/, (c) => { const big = /2004/.test(c.type), addr = c.attrs?.address || '0x27'; return {
    inc: ['#include <Wire.h>', '#include <LiquidCrystal_I2C.h>'], glob: [`LiquidCrystal_I2C ${vn(c.id)}(${addr}, ${big ? '20, 4' : '16, 2'});`],
    setup: [`${vn(c.id)}.init();`, `${vn(c.id)}.backlight();`, `${vn(c.id)}.print("Halo aftakit!");`],
    loop: [`${vn(c.id)}.setCursor(0, 1); ${vn(c.id)}.print("Detik: "); ${vn(c.id)}.print(millis() / 1000); ${vn(c.id)}.print("   ");`],
    explain: `LCD I²C alamat ${addr}: init(), backlight(), setCursor(kolom, baris), print().`, test: 'Jalankan simulasi: baris 1 "Halo aftakit!", baris 2 menghitung detik. Layar kosong? Cek SDA/SCL dan alamat.' }; }],
  [/^(wokwi-ssd1306|mod-oled-i2c)$/, (c) => ({
    inc: ['#include <Wire.h>', '#include <Adafruit_GFX.h>', '#include <Adafruit_SSD1306.h>'], glob: [`Adafruit_SSD1306 ${vn(c.id)}(128, 64, &Wire, -1);`],
    setup: [`${vn(c.id)}.begin(SSD1306_SWITCHCAPVCC, 0x3C);`, `${vn(c.id)}.setTextColor(SSD1306_WHITE);`],
    loop: [`${vn(c.id)}.clearDisplay(); ${vn(c.id)}.setTextSize(2); ${vn(c.id)}.setCursor(0, 0); ${vn(c.id)}.print("aftakit");`, `${vn(c.id)}.setTextSize(1); ${vn(c.id)}.setCursor(0, 30); ${vn(c.id)}.print("Detik: "); ${vn(c.id)}.print(millis() / 1000); ${vn(c.id)}.display();`],
    explain: 'Adafruit_SSD1306: begin(alamat 0x3C), gambar ke buffer (print, drawLine …), lalu display() untuk menampilkan.', test: 'Jalankan simulasi: OLED menampilkan teks dan hitungan detik.' })],
  [/^wokwi-mpu6050$/, (c) => ({
    inc: ['#include <Wire.h>', '#include <Adafruit_MPU6050.h>', '#include <Adafruit_Sensor.h>'], glob: [`Adafruit_MPU6050 ${vn(c.id)};`],
    setup: [`if (!${vn(c.id)}.begin()) Serial.println("${c.id} tidak ditemukan, cek SDA/SCL");`],
    loop: [`sensors_event_t ${vn(c.id)}A, ${vn(c.id)}G, ${vn(c.id)}T; ${vn(c.id)}.getEvent(&${vn(c.id)}A, &${vn(c.id)}G, &${vn(c.id)}T);`, `Serial.print("Akselerasi Z ${c.id}: "); Serial.println(${vn(c.id)}A.acceleration.z);`],
    explain: 'MPU6050 lewat I²C: getEvent() mengisi akselerasi (m/s²), giroskop (rad/s), suhu.', test: TEST_DRAG })],
  [/^(wokwi-ds1307|mod-ds3231)$/, (c) => ({
    inc: ['#include <Wire.h>', '#include <RTClib.h>'], glob: [`RTC_${c.type === 'mod-ds3231' ? 'DS3231' : 'DS1307'} ${vn(c.id)};`],
    setup: [`${vn(c.id)}.begin();`, `${vn(c.id)}.adjust(DateTime(F(__DATE__), F(__TIME__)));`],
    loop: [`DateTime ${vn(c.id)}Now = ${vn(c.id)}.now();`, `Serial.print("Jam ${c.id}: "); Serial.print(${vn(c.id)}Now.hour()); Serial.print(':'); Serial.print(${vn(c.id)}Now.minute()); Serial.print(':'); Serial.println(${vn(c.id)}Now.second());`],
    explain: 'RTClib: begin(), adjust() mengatur jam sekali, now() membaca tanggal & jam.', test: 'Jalankan simulasi: jam di Serial Monitor bertambah tiap detik.' })],
  [/^(mod-bmp280|mod-bme280)$/, (c) => { const e = c.type === 'mod-bme280'; return {
    inc: ['#include <Wire.h>', `#include <Adafruit_${e ? 'BME' : 'BMP'}280.h>`], glob: [`Adafruit_${e ? 'BME' : 'BMP'}280 ${vn(c.id)};`],
    setup: [`if (!${vn(c.id)}.begin(${c.attrs?.address || '0x76'})) Serial.println("${c.id} tidak ditemukan");`],
    loop: [`Serial.print("Suhu ${c.id}: "); Serial.print(${vn(c.id)}.readTemperature()); Serial.print(" C, tekanan: "); Serial.print(${vn(c.id)}.readPressure() / 100.0); Serial.println(" hPa");`],
    explain: `Adafruit_${e ? 'BME' : 'BMP'}280 lewat I²C: readTemperature(), readPressure()${e ? ', readHumidity()' : ''}.`, test: TEST_DRAG }; }],
  [/^mod-ds18b20$/, (c) => { const pin = c.pins.DQ ?? c.pins.DATA; if (pin == null) return null; return {
    inc: ['#include <OneWire.h>', '#include <DallasTemperature.h>'], glob: [pinConst(c, 'DQ', pin), `OneWire ${vn(c.id)}Bus(${P(c, 'DQ')});`, `DallasTemperature ${vn(c.id)}(&${vn(c.id)}Bus);`],
    setup: [`${vn(c.id)}.begin();`], loop: [`${vn(c.id)}.requestTemperatures();`, `Serial.print("Suhu ${c.id}: "); Serial.println(${vn(c.id)}.getTempCByIndex(0));`],
    explain: 'OneWire + DallasTemperature: requestTemperatures() lalu getTempCByIndex(0). DQ butuh pull-up 4,7 kΩ.', test: TEST_DRAG }; }],
  [/^(wokwi-neopixel|wokwi-led-ring)$/, (c) => {
    if (!need(c, 'DIN')) return null; const n = c.type === 'wokwi-led-ring' ? +(c.attrs?.pixels || 16) : 1;
    return {
      inc: ['#include <Adafruit_NeoPixel.h>'], glob: [pinConst(c, 'DIN', c.pins.DIN), `Adafruit_NeoPixel ${vn(c.id)}(${n}, ${P(c, 'DIN')}, NEO_GRB + NEO_KHZ800);`],
      setup: [`${vn(c.id)}.begin();`],
      loop: [`for (int i = 0; i < ${n}; i++) ${vn(c.id)}.setPixelColor(i, ${vn(c.id)}.ColorHSV((millis() * 20 + i * 4096) % 65536));`, `${vn(c.id)}.show();`],
      explain: 'Adafruit_NeoPixel: setPixelColor(i, warna) lalu show() mengirim data ke LED.', test: 'Jalankan simulasi: warna LED berputar seperti pelangi.',
    };
  }],
  [/^mod-tm1637$/, (c) => need(c, 'CLK', 'DIO') && {
    inc: ['#include <TM1637Display.h>'], glob: [`TM1637Display ${vn(c.id)}(${c.pins.CLK}, ${c.pins.DIO});`], setup: [`${vn(c.id)}.setBrightness(5);`],
    loop: [`${vn(c.id)}.showNumberDec(millis() / 1000);`], explain: 'TM1637Display(CLK, DIO): showNumberDec() menampilkan angka.', test: 'Jalankan simulasi: display menghitung detik.' }],
  [/^wokwi-membrane-keypad$/, (c) => need(c, 'R1', 'R2', 'R3', 'R4', 'C1', 'C2', 'C3', 'C4') && {
    inc: ['#include <Keypad.h>'],
    glob: [`char ${vn(c.id)}Keys[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};`, `byte ${vn(c.id)}Rows[4] = {${['R1', 'R2', 'R3', 'R4'].map((k) => c.pins[k]).join(', ')}};`, `byte ${vn(c.id)}Cols[4] = {${['C1', 'C2', 'C3', 'C4'].map((k) => c.pins[k]).join(', ')}};`, `Keypad ${vn(c.id)} = Keypad(makeKeymap(${vn(c.id)}Keys), ${vn(c.id)}Rows, ${vn(c.id)}Cols, 4, 4);`],
    loop: [`char ${vn(c.id)}K = ${vn(c.id)}.getKey();`, `if (${vn(c.id)}K) { Serial.print("Tombol: "); Serial.println(${vn(c.id)}K); }`],
    explain: 'Library Keypad memindai baris & kolom; getKey() mengembalikan tombol yang ditekan.', test: 'Ketuk tuts keypad (2D/3D): Serial Monitor menulis tombolnya.' }],
  [/^wokwi-hx711$/, (c) => need(c, 'DT', 'SCK') && {
    inc: ['#include <HX711.h>'], glob: [`HX711 ${vn(c.id)};`], setup: [`${vn(c.id)}.begin(${c.pins.DT}, ${c.pins.SCK});`, `${vn(c.id)}.set_scale(420.0); ${vn(c.id)}.tare();`],
    loop: [`Serial.print("Berat ${c.id}: "); Serial.println(${vn(c.id)}.get_units(3));`], explain: 'HX711: begin(DT, SCK), set_scale(faktor kalibrasi), tare(), get_units().', test: TEST_DRAG }],
  [/^wokwi-ir-receiver$/, (c) => need(c, 'DAT') && {
    inc: ['#include <IRremote.hpp>'], glob: [pinConst(c, 'DAT', c.pins.DAT)], setup: [`IrReceiver.begin(${P(c, 'DAT')});`],
    loop: [`if (IrReceiver.decode()) { Serial.print("Kode IR: 0x"); Serial.println(IrReceiver.decodedIRData.command, HEX); IrReceiver.resume(); }`],
    explain: 'IRremote: IrReceiver.begin(pin), decode() lalu baca decodedIRData.command, resume() untuk kode berikutnya.', test: 'Tambahkan remote IR, tekan tombolnya: kode muncul di Serial Monitor.' }],
  [/^wokwi-ky-040$/, (c) => need(c, 'CLK', 'DT') && {
    glob: [pinConst(c, 'CLK', c.pins.CLK), pinConst(c, 'DT', c.pins.DT), `int ${vn(c.id)}Pos = 0, ${vn(c.id)}Last = HIGH;`],
    setup: [`pinMode(${P(c, 'CLK')}, INPUT_PULLUP); pinMode(${P(c, 'DT')}, INPUT_PULLUP);`],
    loop: [`int ${vn(c.id)}Clk = digitalRead(${P(c, 'CLK')});`, `if (${vn(c.id)}Clk != ${vn(c.id)}Last && ${vn(c.id)}Clk == LOW) { ${vn(c.id)}Pos += digitalRead(${P(c, 'DT')}) == HIGH ? 1 : -1; Serial.print("Encoder: "); Serial.println(${vn(c.id)}Pos); }`, `${vn(c.id)}Last = ${vn(c.id)}Clk;`],
    explain: 'Saat CLK turun, nilai DT menentukan arah putar (searah/berlawanan jarum jam).', test: 'Seret encoder ke kanan/kiri di 3D: posisi naik/turun.' }],
];

/** code pieces for one component, or a hint when it is not (fully) connected / unknown */
export function codeFor(c) {
  for (const [re, fn] of TEMPLATES) if (re.test(c.type)) {
    const r = fn(c);
    if (r) return { inc: [], glob: [], setup: [], loop: [], ...r };
    return { todo: `// ${c.id}: hubungkan dulu pin ${missing(c, ...['TRIG', 'ECHO', 'A', 'SIG', 'AO', 'AOUT', 'OUT', 'DO', 'IN', 'IN1', 'PWM', 'DIN', 'DATA', 'DQ', 'S', 'R', 'G', 'B', 'HORZ', 'VERT', 'CLK', 'DT', 'DIO', 'DAT', '1'].filter((n) => (c.allPins || []).includes(n))).join(', ') || 'sinyal'} ke mikrokontroler.` };
  }
  return null;
}
