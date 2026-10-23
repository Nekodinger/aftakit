#pragma once
#include "Arduino.h"
class EEPROMClass {
public:
  bool begin(size_t size) { if (!_d) { _n = size; _d = (uint8_t *)malloc(size); memset(_d, 0xff, size); h_nvs(0, "__eeprom", nullptr, 0) == (int)size ? (void)h_nvs(0, "__eeprom", _d, size) : (void)0; } return true; }
  uint8_t read(int a) { return (_d && a < (int)_n) ? _d[a] : 0xff; }
  void write(int a, uint8_t v) { if (_d && a < (int)_n) _d[a] = v; }
  void update(int a, uint8_t v) { write(a, v); }
  bool commit() { if (_d) h_nvs(1, "__eeprom", _d, (int)_n); return true; }
  void end() { commit(); }
  uint8_t &operator[](int a) { static uint8_t dummy; return (_d && a < (int)_n) ? _d[a] : dummy; }
  template <typename T> T &get(int a, T &t) { if (_d && a + sizeof(T) <= _n) memcpy(&t, _d + a, sizeof(T)); return t; }
  template <typename T> const T &put(int a, const T &t) { if (_d && a + sizeof(T) <= _n) memcpy(_d + a, &t, sizeof(T)); return t; }
  size_t length() { return _n; }
private:
  uint8_t *_d = nullptr; size_t _n = 0;
};
extern EEPROMClass EEPROM;
