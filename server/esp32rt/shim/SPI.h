#pragma once
#include "Arduino.h"
#define SPI_MODE0 0
#define SPI_MODE1 1
#define SPI_MODE2 2
#define SPI_MODE3 3
#define SPI_CLOCK_DIV2 2
#define SPI_CLOCK_DIV4 4
#define SPI_CLOCK_DIV8 8
#define SPI_CLOCK_DIV16 16
#define SPI_CLOCK_DIV32 32
#define SPI_CLOCK_DIV64 64
#define SPI_CLOCK_DIV128 128
typedef int BitOrder;
#define SPI_MSBFIRST 1
#define SPI_LSBFIRST 0
class SPISettings { public: SPISettings(uint32_t c = 1000000, uint8_t o = MSBFIRST, uint8_t m = SPI_MODE0) {} };
#include "host.h"
class SPIClass {
  bool _lsb = false;
  static uint8_t rev(uint8_t b) { b = (b & 0xF0) >> 4 | (b & 0x0F) << 4; b = (b & 0xCC) >> 2 | (b & 0x33) << 2; return (b & 0xAA) >> 1 | (b & 0x55) << 1; }
  void x(uint8_t *p, size_t n) { if (_lsb) for (size_t i = 0; i < n; i++) p[i] = rev(p[i]); h_spi_xfer(p, (int)n); if (_lsb) for (size_t i = 0; i < n; i++) p[i] = rev(p[i]); }
public:
  SPIClass(int bus = 0) {}
  void begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1) { h_spi_begin(sck, miso, mosi); }
  void end() {}
  void beginTransaction(SPISettings) {}
  void endTransaction() {}
  uint8_t transfer(uint8_t b) { x(&b, 1); return b; }
  uint16_t transfer16(uint16_t v) { uint8_t b[2] = {(uint8_t)(v >> 8), (uint8_t)v}; x(b, 2); return (uint16_t)(b[0] << 8 | b[1]); }
  uint32_t transfer32(uint32_t v) { uint8_t b[4] = {(uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v}; x(b, 4); return (uint32_t)b[0] << 24 | (uint32_t)b[1] << 16 | b[2] << 8 | b[3]; }
  void transfer(void *buf, size_t n) { x((uint8_t *)buf, n); }
  void transferBytes(const uint8_t *in, uint8_t *out, uint32_t n) { uint8_t t[64]; while (n) { uint32_t k = n > 64 ? 64 : n; if (in) memcpy(t, in, k); else memset(t, 0xff, k); x(t, k); if (out) { memcpy(out, t, k); out += k; } if (in) in += k; n -= k; } }
  void writeBytes(const uint8_t *in, uint32_t n) { transferBytes(in, nullptr, n); }
  void write(uint8_t b) { transfer(b); }
  void write16(uint16_t v) { transfer16(v); } void write32(uint32_t v) { transfer32(v); }
  // like the ESP32 core: 16-bit pixels are sent most significant byte first
  void writePixels(const void *d, uint32_t n) { const uint16_t *p = (const uint16_t *)d; uint8_t t[64]; while (n >= 2) { uint32_t k = 0; while (k < 64 && n >= 2) { t[k++] = *p >> 8; t[k++] = *p & 255; p++; n -= 2; } x(t, k); } }
  void writePattern(const uint8_t *d, uint8_t sz, uint32_t rep) { while (rep--) writeBytes(d, sz); }
  void transfer(const void *in, void *out, size_t n) { transferBytes((const uint8_t *)in, (uint8_t *)out, n); }
  void setFrequency(uint32_t) {} void setDataMode(uint8_t) {} void setBitOrder(uint8_t o) { _lsb = (o == 0); } void setClockDivider(uint32_t) {}
  void setHwCs(bool) {}
  int pinSS() { return 5; }
};
extern SPIClass SPI;
#define HSPI 2
#define VSPI 3
#define FSPI 1
