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
- `node scripts/build_examples.mjs` — kompilasi ulang semua contoh (butuh avr-gcc + wasi-sdk).
- Tes: `bash scripts/run_all.sh` (semua suite AVR + WebAssembly), atau satu per satu `node scripts/test_core.mjs`, `test_parts1..6`,
  `test_mega`, `test_attiny`, `test_nanorp2040`, `test_*_esp32`, `test_gateway` (butuh `amqtt`);
  browser: `scripts/e2e3.py`, `e2e4.py`, `e2e5.py`, `e2e6.py`.

## Variabel lingkungan (Vercel)
`VITE_COMPILE_URL` (URL Space kompilator), `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (kunci publik).
