# Simulator Rangkaian & Arduino / ESP32 (untuk iPad)

Simulator rangkaian di browser: Arduino Uno/Nano (emulator AVR), ESP32, ESP32-CAM, NodeMCU/D1 mini (ESP8266) dan
Raspberry Pi Pico (runtime Arduino berbasis WebAssembly), 100+ komponen, breadboard, pemeriksaan rangkaian, ramah layar sentuh.

- WiFi tersimulasi; `HTTPClient` memakai internet perangkat (fallback `api/proxy.js` untuk layanan IoT tanpa CORS).
- `BluetoothSerial` → tab Bluetooth; `esp_camera` → tab Kamera (kamera perangkat / foto / gambar contoh).
- Gateway IoT (WebSocket `/net` di server kompilasi): `WiFiClient`, `WiFiClientSecure`, `WiFiUDP` jadi koneksi TCP/TLS/UDP nyata,
  jadi library asli Blynk, UniversalTelegramBot, PubSubClient (MQTT), ThingSpeak bekerja dengan API key asli.
- Library Manager otomatis: `#include` yang belum ada diunduh dari indeks Arduino Library Manager (`server/libmgr.py`).
- Library .zip (mis. ekspor Edge Impulse "Arduino library") lewat panel Library; `img_converters.h` (`fmt2rgb888`) didukung.

## Struktur
- `src/` aplikasi web (Vite). `src/sim/avr.js` (Uno/Nano), `src/sim/wasmboard.js` (ESP32/ESP8266/Pico).
- `server/` server kompilasi (Docker, gratis di Hugging Face Spaces). `server/esp32rt/` runtime Arduino-ESP32 untuk WebAssembly.
- `api/proxy.js` relay CORS (Vercel Edge Function) dengan daftar host yang diizinkan.
- `public/wasm/` contoh ESP32 yang sudah dikompilasi (berjalan tanpa server).

## Perintah
- `npm run dev` / `npm run build`
- `node scripts/build_examples.mjs` — kompilasi ulang semua contoh (butuh avr-gcc + wasi-sdk).
- Tes: `node scripts/test_core.mjs`, `test_circuit`, `test_drc`, `test_sim`, `test_iot`, `test_esp32`, `test_gateway` (butuh `amqtt`);
  browser: `scripts/e2e3.py`, `e2e4.py`, `e2e5.py`, `e2e6.py`.

## Variabel lingkungan (Vercel)
`VITE_COMPILE_URL` (URL Space kompilator), `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (kunci publik).
