#pragma once
// SoftwareSerial for the simulator's ESP32 / ESP8266 / RP2040 runtime: each instance is a virtual UART port whose
// RX / TX GPIOs decide which serial module (GPS, HC-05, SIM800L ...) it talks to. API of EspSoftwareSerial.
#include "Arduino.h"
#define SWSERIAL_8N1 0
#define SWSERIAL_8N2 1
#define SWSERIAL_7N1 2
class SoftwareSerial : public HardwareSerial {
public:
  SoftwareSerial() : HardwareSerial(next()) {}
  SoftwareSerial(int8_t rx, int8_t tx, bool invert = false, int buf = 64) : HardwareSerial(next()), _rx(rx), _tx(tx) {}
  void begin(unsigned long baud) { h_serial_pins(_port, _rx, _tx); HardwareSerial::begin(baud); }
  void begin(unsigned long baud, int config, int8_t rx = -1, int8_t tx = -1, bool invert = false, int buf = 64, int isrBuf = 0) {
    if (rx >= 0) _rx = rx; if (tx >= 0) _tx = tx; begin(baud);
  }
  bool listen() { return true; }
  bool isListening() { return true; }
  bool stopListening() { return true; }
  bool overflow() { return false; }
  void enableIntTx(bool) {}
  void enableRx(bool) {}
  bool isValidGPIOpin(int8_t) { return true; }
  operator bool() const { return true; }
private:
  static int next() { static int n = 10; return n++; }
  int8_t _rx = -1, _tx = -1;
};
