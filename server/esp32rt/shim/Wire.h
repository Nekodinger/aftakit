#pragma once
#include "Arduino.h"
#define I2C_BUFFER_LENGTH 128
class TwoWire : public Stream {
public:
  TwoWire(int bus) : _bus(bus) {}
  bool begin(int sda = -1, int scl = -1, uint32_t freq = 0);
  bool begin(uint8_t addr) { return begin(); }   // slave mode is not simulated
  bool end() { return true; }
  bool setPins(int sda, int scl) { _sda = sda; _scl = scl; return true; }
  bool setClock(uint32_t) { return true; }
  void setTimeOut(uint16_t) {}
  void setTimeout(uint16_t) {}
  void beginTransmission(uint16_t addr) { _addr = addr; _txLen = 0; _tx = true; }
  void beginTransmission(int addr) { beginTransmission((uint16_t)addr); }
  void beginTransmission(uint8_t addr) { beginTransmission((uint16_t)addr); }
  uint8_t endTransmission(bool sendStop = true);
  uint8_t endTransmission(uint8_t s) { return endTransmission((bool)s); }
  size_t requestFrom(uint16_t addr, size_t len, bool sendStop = true);
  uint8_t requestFrom(uint8_t addr, uint8_t len) { return (uint8_t)requestFrom((uint16_t)addr, (size_t)len, true); }
  uint8_t requestFrom(uint8_t addr, uint8_t len, uint8_t stop) { return (uint8_t)requestFrom((uint16_t)addr, (size_t)len, (bool)stop); }
  uint8_t requestFrom(int addr, int len) { return (uint8_t)requestFrom((uint16_t)addr, (size_t)len, true); }
  uint8_t requestFrom(int addr, int len, int stop) { return (uint8_t)requestFrom((uint16_t)addr, (size_t)len, (bool)stop); }
  size_t write(uint8_t b) override { if (_txLen < I2C_BUFFER_LENGTH) { _txBuf[_txLen++] = b; return 1; } return 0; }
  size_t write(const uint8_t *d, size_t n) override { size_t k = 0; while (k < n && write(d[k])) k++; return k; }
  using Print::write;
  int available() override { return _rxLen - _rxPos; }
  int read() override { return _rxPos < _rxLen ? _rxBuf[_rxPos++] : -1; }
  int peek() override { return _rxPos < _rxLen ? _rxBuf[_rxPos] : -1; }
  void flush() override {}
  void onReceive(void (*)(int)) {}
  void onRequest(void (*)(void)) {}
private:
  int _bus, _sda = -1, _scl = -1; uint16_t _addr = 0; bool _tx = false;
  uint8_t _txBuf[I2C_BUFFER_LENGTH]; size_t _txLen = 0;
  uint8_t _rxBuf[I2C_BUFFER_LENGTH]; size_t _rxLen = 0, _rxPos = 0;
};
extern TwoWire Wire;
extern TwoWire Wire1;
