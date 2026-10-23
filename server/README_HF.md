---
title: Arduino ESP32 Compile
emoji: 🔧
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
---
Compile API + IoT gateway for the browser circuit simulator (avr-circuit-sim).

Deploy free on Render: New → Web Service → this GitHub repo → Root Directory `server` → Language Docker →
Instance type Free. (Hugging Face Docker Spaces need a paid plan since July 2026.)

- `POST /build` `{"sketch": "..."}` → Arduino Uno / Nano (avr-gcc) → `{"hex", "stdout", "stderr"}`
- `POST /build-wasm` `{"sketch": "...", "board": "esp32" | "esp8266" | "rp2040"}` → WebAssembly module run by the simulator → `{"wasm", "stdout", "stderr"}`
- `PUT /lib/<sha256>` (zip) — user library such as an Edge Impulse "Arduino library" export; `GET /job/<id>` for long builds
- `WS /net` — IoT gateway: the simulated board's WiFiClient / WiFiClientSecure / WiFiUDP become real outgoing TCP / TLS / UDP
  connections (ports 80, 443, 1883, 8883, 8080, 8443, 9443; UDP 53, 123, 5683; public addresses only)
- `GET /health`

Any `#include` that is not built in is fetched from the Arduino Library Manager index (Blynk, PubSubClient,
UniversalTelegramBot, ThingSpeak, …) and compiled for the simulator.

Libraries: Wire, SPI, EEPROM, Servo / ESP32Servo, LiquidCrystal, LiquidCrystal_I2C, Adafruit SSD1306 + GFX, Adafruit NeoPixel,
DHT, RTClib, ArduinoJson, WiFi, HTTPClient, WiFiClientSecure, BluetoothSerial, Preferences, esp_camera.
