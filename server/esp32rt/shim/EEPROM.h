#pragma once
// ESP32 / ESP8266 EEPROM emulation (flash-backed in the real cores, browser storage here). Same API as the
// arduino-esp32 core: begin/commit/end, read/write/update, get/put, readX/writeX for every type, readString/writeString.
#include "Arduino.h"
class EEPROMClass {
public:
  EEPROMClass() {}
  EEPROMClass(uint32_t) {}
  bool begin(size_t size) {
    if (!size) return false;
    if (_d && size == _n) return true;
    uint8_t *n = (uint8_t *)malloc(size); if (!n) return false;
    memset(n, 0xff, size);
    if (_d) { memcpy(n, _d, _n < size ? _n : size); free(_d); }
    else { int have = h_nvs(0, "__eeprom", nullptr, 0); if (have > 0) { uint8_t *t = (uint8_t *)malloc(have); h_nvs(0, "__eeprom", t, have); memcpy(n, t, (size_t)have < size ? have : size); free(t); } }
    _d = n; _n = size; _dirty = false; return true;
  }
  uint8_t read(int a) { return (_d && a >= 0 && a < (int)_n) ? _d[a] : 0; }
  void write(int a, uint8_t v) { if (_d && a >= 0 && a < (int)_n && _d[a] != v) { _d[a] = v; _dirty = true; } }
  void update(int a, uint8_t v) { write(a, v); }
  bool commit() { if (!_d) return false; h_nvs(1, "__eeprom", _d, (int)_n); _dirty = false; return true; }
  void end() { if (_d) { commit(); free(_d); _d = nullptr; _n = 0; } }
  uint8_t &operator[](int a) { static uint8_t dummy; return (_d && a >= 0 && a < (int)_n) ? (_dirty = true, _d[a]) : dummy; }
  uint8_t *getDataPtr() { _dirty = true; return _d; }
  const uint8_t *getConstDataPtr() const { return _d; }
  size_t length() { return _n; }
  bool isDirty() { return _dirty; }

  template <typename T> T &get(int a, T &t) { if (_d && a >= 0 && a + sizeof(T) <= _n) memcpy((uint8_t *)&t, _d + a, sizeof(T)); return t; }
  template <typename T> const T &put(int a, const T &t) { if (_d && a >= 0 && a + sizeof(T) <= _n) { memcpy(_d + a, (const uint8_t *)&t, sizeof(T)); _dirty = true; } return t; }

  // ---- arduino-esp32 typed accessors
  uint8_t readByte(int a) { uint8_t v = 0; return get(a, v); }
  int8_t readChar(int a) { int8_t v = 0; return get(a, v); }
  uint8_t readUChar(int a) { uint8_t v = 0; return get(a, v); }
  int16_t readShort(int a) { int16_t v = 0; return get(a, v); }
  uint16_t readUShort(int a) { uint16_t v = 0; return get(a, v); }
  int32_t readInt(int a) { int32_t v = 0; return get(a, v); }
  uint32_t readUInt(int a) { uint32_t v = 0; return get(a, v); }
  int32_t readLong(int a) { int32_t v = 0; return get(a, v); }
  uint32_t readULong(int a) { uint32_t v = 0; return get(a, v); }
  int64_t readLong64(int a) { int64_t v = 0; return get(a, v); }
  uint64_t readULong64(int a) { uint64_t v = 0; return get(a, v); }
  float readFloat(int a) { float v = 0; return get(a, v); }
  double readDouble(int a) { double v = 0; return get(a, v); }
  bool readBool(int a) { uint8_t v = 0; return get(a, v) ? true : false; }
  size_t readString(int a, char *out, size_t maxLen) {
    if (!_d || !out || a < 0) return 0;
    size_t n = 0; while (n + 1 < maxLen && a + n < _n && _d[a + n]) { out[n] = _d[a + n]; n++; }
    if (maxLen) out[n] = 0; return n;
  }
  String readString(int a) { String s; if (!_d || a < 0) return s; for (size_t i = a; i < _n && _d[i]; i++) s += (char)_d[i]; return s; }
  size_t readBytes(int a, void *out, size_t len) { if (!_d || a < 0 || a + len > _n) return 0; memcpy(out, _d + a, len); return len; }
  template <class T> T readAll(int a, T &v) { return get(a, v); }

  size_t writeByte(int a, uint8_t v) { put(a, v); return 1; }
  size_t writeChar(int a, int8_t v) { put(a, v); return 1; }
  size_t writeUChar(int a, uint8_t v) { put(a, v); return 1; }
  size_t writeShort(int a, int16_t v) { put(a, v); return 2; }
  size_t writeUShort(int a, uint16_t v) { put(a, v); return 2; }
  size_t writeInt(int a, int32_t v) { put(a, v); return 4; }
  size_t writeUInt(int a, uint32_t v) { put(a, v); return 4; }
  size_t writeLong(int a, int32_t v) { put(a, v); return 4; }
  size_t writeULong(int a, uint32_t v) { put(a, v); return 4; }
  size_t writeLong64(int a, int64_t v) { put(a, v); return 8; }
  size_t writeULong64(int a, uint64_t v) { put(a, v); return 8; }
  size_t writeFloat(int a, float v) { put(a, v); return 4; }
  size_t writeDouble(int a, double v) { put(a, v); return 8; }
  size_t writeBool(int a, bool v) { uint8_t b = v; put(a, b); return 1; }
  size_t writeString(int a, const char *s) { if (!_d || !s || a < 0) return 0; size_t n = strlen(s); if (a + n + 1 > _n) return 0; memcpy(_d + a, s, n + 1); _dirty = true; return n; }
  size_t writeString(int a, const String &s) { return writeString(a, s.c_str()); }
  size_t writeBytes(int a, const void *v, size_t len) { if (!_d || a < 0 || a + len > _n) return 0; memcpy(_d + a, v, len); _dirty = true; return len; }
  template <class T> T writeAll(int a, const T &v) { put(a, v); return v; }
private:
  uint8_t *_d = nullptr; size_t _n = 0; bool _dirty = false;
};
extern EEPROMClass EEPROM;
