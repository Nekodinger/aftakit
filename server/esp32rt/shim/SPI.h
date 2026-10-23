#pragma once
#include "Arduino.h"
#define SPI_MODE0 0
#define SPI_MODE1 1
#define SPI_MODE2 2
#define SPI_MODE3 3
#define SPI_CLOCK_DIV2 2
#define SPI_CLOCK_DIV4 4
typedef int BitOrder;
#define SPI_MSBFIRST 1
#define SPI_LSBFIRST 0
class SPISettings { public: SPISettings(uint32_t c = 1000000, uint8_t o = MSBFIRST, uint8_t m = SPI_MODE0) {} };
class SPIClass {
public:
  SPIClass(int bus = 0) {}
  void begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1) {}
  void end() {}
  void beginTransaction(SPISettings) {}
  void endTransaction() {}
  uint8_t transfer(uint8_t) { return 0xff; }
  uint16_t transfer16(uint16_t) { return 0xffff; }
  void transfer(void *buf, size_t n) { memset(buf, 0xff, n); }
  void transferBytes(const uint8_t *, uint8_t *out, uint32_t n) { if (out) memset(out, 0xff, n); }
  void writeBytes(const uint8_t *, uint32_t) {}
  void write(uint8_t) {}
  void write16(uint16_t) {} void write32(uint32_t) {}
  void writePixels(const void *, uint32_t) {} void writePattern(const uint8_t *, uint8_t, uint32_t) {}
  void transfer(const void *, void *out, size_t n) { if (out) memset(out, 0xff, n); }
  void setFrequency(uint32_t) {} void setDataMode(uint8_t) {} void setBitOrder(uint8_t) {} void setClockDivider(uint32_t) {}
  void setHwCs(bool) {}
  int pinSS() { return 5; }
};
extern SPIClass SPI;
#define HSPI 2
#define VSPI 3
#define FSPI 1
