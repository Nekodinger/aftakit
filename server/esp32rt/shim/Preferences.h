#pragma once
// Non-volatile storage: kept in the browser (localStorage), per project.
#include "Arduino.h"
class Preferences {
public:
  bool begin(const char *ns, bool readOnly = false) { _ns = ns; return true; }
  void end() {}
  bool clear() { h_nvs(3, _ns.c_str(), nullptr, 0); return true; }
  bool remove(const char *key) { return h_nvs(2, k(key).c_str(), nullptr, 0) >= 0; }
  bool isKey(const char *key) { return h_nvs(0, k(key).c_str(), nullptr, 0) >= 0; }
  size_t putInt(const char *key, int32_t v) { return put(key, &v, 4); }
  size_t putUInt(const char *key, uint32_t v) { return put(key, &v, 4); }
  size_t putLong(const char *key, int32_t v) { return put(key, &v, 4); }
  size_t putULong(const char *key, uint32_t v) { return put(key, &v, 4); }
  size_t putFloat(const char *key, float v) { return put(key, &v, 4); }
  size_t putDouble(const char *key, double v) { return put(key, &v, 8); }
  size_t putBool(const char *key, bool v) { uint8_t b = v; return put(key, &b, 1); }
  size_t putUChar(const char *key, uint8_t v) { return put(key, &v, 1); }
  size_t putString(const char *key, const String &v) { return put(key, v.c_str(), v.length()); }
  size_t putBytes(const char *key, const void *v, size_t n) { return put(key, v, n); }
  int32_t getInt(const char *key, int32_t d = 0) { get(key, &d, 4); return d; }
  uint32_t getUInt(const char *key, uint32_t d = 0) { get(key, &d, 4); return d; }
  int32_t getLong(const char *key, int32_t d = 0) { get(key, &d, 4); return d; }
  uint32_t getULong(const char *key, uint32_t d = 0) { get(key, &d, 4); return d; }
  float getFloat(const char *key, float d = NAN) { get(key, &d, 4); return d; }
  double getDouble(const char *key, double d = NAN) { get(key, &d, 8); return d; }
  bool getBool(const char *key, bool d = false) { uint8_t b = d; get(key, &b, 1); return b; }
  uint8_t getUChar(const char *key, uint8_t d = 0) { get(key, &d, 1); return d; }
  String getString(const char *key, const String &d = String()) { int n = h_nvs(0, k(key).c_str(), nullptr, 0); if (n < 0) return d; char *b = (char *)calloc(n + 1, 1); h_nvs(0, k(key).c_str(), (uint8_t *)b, n); String s(b); free(b); return s; }
  size_t getBytes(const char *key, void *buf, size_t n) { int m = h_nvs(0, k(key).c_str(), nullptr, 0); if (m < 0) return 0; uint8_t *t = (uint8_t *)malloc(m); h_nvs(0, k(key).c_str(), t, m); memcpy(buf, t, min((size_t)m, n)); free(t); return min((size_t)m, n); }
  size_t getBytesLength(const char *key) { int m = h_nvs(0, k(key).c_str(), nullptr, 0); return m < 0 ? 0 : m; }
private:
  String _ns;
  String k(const char *key) { return _ns + "/" + key; }
  size_t put(const char *key, const void *v, size_t n) { h_nvs(1, k(key).c_str(), (uint8_t *)v, (int)n); return n; }
  void get(const char *key, void *out, size_t n) { int m = h_nvs(0, k(key).c_str(), nullptr, 0); if (m == (int)n) h_nvs(0, k(key).c_str(), (uint8_t *)out, (int)n); }
};
