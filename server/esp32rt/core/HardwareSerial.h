#pragma once
#include "Stream.h"
#include "host.h"
#define SERIAL_8N1 0x800001c
#define SERIAL_8E1 0x800001e
class HardwareSerial : public Stream {
public:
  explicit HardwareSerial(int port) : _port(port) {}
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rx = -1, int8_t tx = -1, bool invert = false, unsigned long timeout = 20000UL);
  void end() {}
  int available() override;
  int peek() override;
  int read() override;
  int availableForWrite() override { return 128; }
  void flush() override {}
  size_t write(uint8_t c) override;
  size_t write(const uint8_t *buf, size_t n) override;
  using Print::write;
  operator bool() const { return true; }
  void setDebugOutput(bool) {}
  void setRxBufferSize(size_t) {}
  void setPins(int8_t rx, int8_t tx, int8_t = -1, int8_t = -1);
  void updateBaudRate(unsigned long) {}
  unsigned long baudRate() { return _baud; }
protected:
  int _port; int _peeked = -1; unsigned long _baud = 115200;
};
extern HardwareSerial Serial;
extern HardwareSerial Serial1;
extern HardwareSerial Serial2;
