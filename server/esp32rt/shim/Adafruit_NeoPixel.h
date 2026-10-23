#pragma once
#include "Arduino.h"
#define NEO_GRB 0x52
#define NEO_RGB 0x06
#define NEO_GRBW 0xD2
#define NEO_KHZ800 0x0000
#define NEO_KHZ400 0x0100
typedef uint16_t neoPixelType;
class Adafruit_NeoPixel {
public:
  Adafruit_NeoPixel(uint16_t n = 0, int16_t pin = 6, neoPixelType t = NEO_GRB + NEO_KHZ800) : _n(n), _pin(pin), _type(t) { _px = (uint8_t *)calloc(n ? n * 3 : 1, 1); }
  ~Adafruit_NeoPixel() { free(_px); }
  void begin() {}
  void show();
  void setPin(int16_t p) { _pin = p; }
  void updateLength(uint16_t n) { free(_px); _n = n; _px = (uint8_t *)calloc(n * 3, 1); }
  void setPixelColor(uint16_t i, uint8_t r, uint8_t g, uint8_t b) { if (i < _n) { _px[i * 3] = r; _px[i * 3 + 1] = g; _px[i * 3 + 2] = b; } }
  void setPixelColor(uint16_t i, uint8_t r, uint8_t g, uint8_t b, uint8_t) { setPixelColor(i, r, g, b); }
  void setPixelColor(uint16_t i, uint32_t c) { setPixelColor(i, (c >> 16) & 255, (c >> 8) & 255, c & 255); }
  void fill(uint32_t c = 0, uint16_t first = 0, uint16_t count = 0) { uint16_t end = count ? first + count : _n; for (uint16_t i = first; i < end && i < _n; i++) setPixelColor(i, c); }
  void setBrightness(uint8_t b) { _bright = b + 1; }
  uint8_t getBrightness() const { return _bright - 1; }
  void clear() { memset(_px, 0, _n * 3); }
  uint16_t numPixels() const { return _n; }
  uint32_t getPixelColor(uint16_t i) const { if (i >= _n) return 0; return ((uint32_t)_px[i * 3] << 16) | ((uint32_t)_px[i * 3 + 1] << 8) | _px[i * 3 + 2]; }
  bool canShow() { return true; }
  static uint32_t Color(uint8_t r, uint8_t g, uint8_t b) { return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b; }
  static uint32_t Color(uint8_t r, uint8_t g, uint8_t b, uint8_t w) { return Color(r, g, b); }
  static uint32_t ColorHSV(uint16_t hue, uint8_t sat = 255, uint8_t val = 255);
  static uint32_t gamma32(uint32_t x) { return x; }
  static uint8_t gamma8(uint8_t x) { return x; }
  static uint8_t sine8(uint8_t x) { return (uint8_t)(127.5 + 127.5 * sin(x * 2 * PI / 256 - PI / 2)); }
  void rainbow(uint16_t first_hue = 0, int8_t reps = 1, uint8_t saturation = 255, uint8_t brightness = 255, bool gammify = true) {
    for (uint16_t i = 0; i < _n; i++) setPixelColor(i, ColorHSV(first_hue + (i * reps * 65536) / _n, saturation, brightness));
  }
private:
  uint16_t _n; int16_t _pin; neoPixelType _type; uint8_t *_px; uint16_t _bright = 256;
};
