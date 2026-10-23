#pragma once
// Classic Bluetooth SPP: the simulator shows a "phone" terminal; text sent from it arrives here.
#include "Arduino.h"
typedef void (*BTDataCb)(const uint8_t *, size_t);
class BluetoothSerial : public arduino::Stream {
public:
  bool begin(const String &name = "ESP32", bool isMaster = false) { h_bt_begin(name.c_str()); return true; }
  bool begin(const char *name, bool isMaster = false) { h_bt_begin(name); return true; }
  int available() override { return h_bt_available() + (_pk >= 0); }
  int peek() override { if (_pk < 0) _pk = h_bt_read(); return _pk; }
  int read() override { if (_pk >= 0) { int c = _pk; _pk = -1; return c; } return h_bt_read(); }
  size_t write(uint8_t c) override { h_bt_write(&c, 1); return 1; }
  size_t write(const uint8_t *b, size_t n) override { h_bt_write(b, (int)n); return n; }
  using arduino::Print::write;
  void flush() override {}
  void end() {}
  bool hasClient() { return true; }
  bool connected(int = 0) { return true; }
  bool setPin(const char *) { return true; }
  void enableSSP() {}
  void register_callback(void *) {}
private:
  int _pk = -1;
};
