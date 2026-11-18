# Simulator Rangkaian & Arduino / ESP32 (untuk iPad)

Simulator rangkaian di browser: Arduino Uno/Nano, Mega 2560 dan Franzininho/ATtiny85 (emulator AVR), ESP32, ESP32-CAM,
NodeMCU/D1 mini (ESP8266), Raspberry Pi Pico dan Nano RP2040 Connect (runtime Arduino berbasis WebAssembly), 100+ komponen,
breadboard, pemeriksaan rangkaian, ramah layar sentuh. Semua komponen di katalog disimulasikan (tidak ada lagi yang hanya gambar).

- WiFi tersimulasi; `HTTPClient` memakai internet perangkat (fallback `api/proxy.js` untuk layanan IoT tanpa CORS).
- `BluetoothSerial` → tab Bluetooth; `esp_camera` → tab Kamera (kamera perangkat / foto / gambar contoh).
- Gateway IoT (WebSocket `/net` di server kompilasi): `WiFiClient`, `WiFiClientSecure`, `WiFiUDP` jadi koneksi TCP/TLS/UDP nyata,
  jadi library asli Blynk, UniversalTelegramBot, PubSubClient (MQTT), ThingSpeak bekerja dengan API key asli.
- Library Manager otomatis: `#include` yang belum ada diunduh dari indeks Arduino Library Manager (`server/libmgr.py`).
- Library .zip (mis. ekspor Edge Impulse "Arduino library") lewat panel Library; `img_converters.h` (`fmt2rgb888`) didukung.
- ESP-NOW (`esp_now.h` ESP32, callback 2.x dan 3.x; `espnow.h` ESP8266) → tab ESP-NOW: remote virtual (tombol arah / joystick struct / teks) dan log paket dari board.
- Sasis mobil robot 2WD (`mod-car-chassis`): dua motor TT, kinematika diferensial, arena 3D (dinding, rintangan, lintasan garis). Komponen di atas sasis ikut bergerak di 3D; HC-SR04 / VL53L0X / FC-51 / TCRT5000 di atasnya membaca arena (`src/sim/car.js`).
- 3D: benda di sekitar sensor (dinding yang bisa diseret untuk sensor jarak, tangki air, tanah, tetes hujan, lampu LDR, lilin sensor api) — `src/ui/scene3d.js`.
- Mode tampilan Laptop / iPad / HP (otomatis atau dipilih), termasuk pratinjau berbingkai — `src/ui/device.js`.
- Saran komponen tambahan setelah Auto wiring (popup, hanya ditambahkan bila disetujui): resistor 220 Ω LED, pembagi 1 kΩ + 2 kΩ untuk sinyal 5 V ke GPIO 3,3 V, pull-up DS18B20 4,7 kΩ / DHT22 10 kΩ, resistor 330 Ω + kapasitor 1000 µF NeoPixel, NPN + 1 kΩ + 1N4007 untuk relay, modul MOSFET untuk motor/pompa — `src/learn/extras.js`. Pemecah rangkaian menghitung pembagi resistor secara nodal (`src/sim/circuit.js`).
- Bahasa antarmuka Indonesia / English (tombol ID/EN atau menu mode tampilan). Kode program tidak diterjemahkan — `src/i18n.js`, kamus `src/i18n-en.js` (kunci = teks Indonesia, termasuk potongan pesan bertemplat).
- GPS u-blox NEO-M8N (`mod-gps-m8n`): NMEA multi-GNSS ($GNRMC/$GNGGA, GSV per konstelasi GPS/GLONASS/Galileo/BeiDou), LED fix berkedip 1 Hz; Auto wiring memakai Serial2 (ESP32), Serial1 (Mega/Pico), SoftwareSerial (Uno/Nano, ESP8266 D5/D6), Auto kode TinyGPS++ untuk NEO-6M dan NEO-M8N.
- Contoh program library seperti Arduino IDE (Berkas → Contoh dari library…): contoh bawaan Arduino + contoh semua library simulator (indeks statis `public/libex`, dibuat saat build oleh `scripts/collect_examples.mjs`) + contoh di dalam library .zip unggahan (dibaca langsung dari zip di peramban).
- Kompilasi panjang di Vercel dipecah per bagian ±200 detik dengan cache tiap tahap (objek library, sketch.o, hasil link, hasil wasm-opt); bagian yang terputus (HTTP 504) diulang otomatis, waktu berjalan tampil, dan ■ membatalkan kompilasi.
- Tombol Simpan (Ctrl+S): proyek disimpan di perangkat (localStorage), daftar di Berkas → Proyek tersimpan; titik oranye menandai perubahan yang belum disimpan.

## Komponen protokol (dimodelkan sampai level register / pin, diuji dengan library asli)
- 1-Wire: DS18B20 (OneWire + DallasTemperature, beberapa sensor satu jalur). Dua kabel: TM1637, HX711.
- I2C: BMP280 / BME280 (rumus kompensasi Bosch), MAX30102 (FIFO, heartRate & algoritma SpO2), LCD, OLED, MPU6050, RTC.
- SPI (hardware, bit-bang, ESP32): MAX7219 8x8 & 4-in-1 (LedControl, MD_Parola), SSD1306 SPI, ILI9341, microSD (FAT16, isi kartu bisa diunduh), RC522 + kartu MIFARE 1K.
- Radio: nRF24L01 (RF24) dan LoRa SX1278 (time-on-air nyata) pada "udara" bersama + lawan virtual (ACK / gema).
- UART: GPS NEO-6M (NMEA, TinyGPS++), HC-05 (ke tab Bluetooth, mode AT), SIM800L (AT, SMS), ESP-01 (firmware AT, HTTP nyata).
- Lainnya: kapasitor (τ = RC), dioda, relay KS2E, stepper & biaxial, rotary dialer, IR remote/receiver (IRremote), sensor detak.

## Struktur
- `src/` aplikasi web (Vite). `src/sim/avr.js` (Uno/Nano), `src/sim/wasmboard.js` (ESP32/ESP8266/Pico).
- `server/` server kompilasi (Docker, gratis di Hugging Face Spaces). `server/esp32rt/` runtime Arduino-ESP32 untuk WebAssembly.
- `api/proxy.js` relay CORS (Vercel Edge Function) dengan daftar host yang diizinkan.
- `public/wasm/` contoh ESP32 yang sudah dikompilasi (berjalan tanpa server).

## Perintah
- `npm run dev` / `npm run build`
- `node scripts/build_examples.mjs` — kompilasi ulang semua contoh (butuh avr-gcc + wasi-sdk); `--only id1,id2` hanya contoh ESP32/ESP8266 tertentu.
- Tes: `bash scripts/run_all.sh` (semua suite AVR + WebAssembly), atau satu per satu `node scripts/test_core.mjs`, `test_parts1..6`,
  `test_mega`, `test_attiny`, `test_espnow`, `test_car`, `test_nanorp2040`, `test_*_esp32`, `test_gateway` (butuh `amqtt`);
  browser: `scripts/e2e3.py`, `e2e4.py`, `e2e5.py`, `e2e6.py`.

## Variabel lingkungan (Vercel)
`VITE_COMPILE_URL` (URL Space kompilator), `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (kunci publik).
