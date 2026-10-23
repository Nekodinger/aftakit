#pragma once
// API-compatible with the Adafruit DHT library; values come from the DHT part in the circuit.
#include "Arduino.h"
#define DHT11 11
#define DHT12 12
#define DHT21 21
#define DHT22 22
#define AM2301 21
class DHT {
public:
  DHT(uint8_t pin, uint8_t type, uint8_t count = 6) : _pin(pin), _type(type) {}
  void begin(uint8_t usec = 55) { pinMode(_pin, INPUT_PULLUP); }
  float readTemperature(bool S = false, bool force = false) { if (!read(force)) return NAN; return S ? _t * 1.8f + 32 : _t; }
  float readHumidity(bool force = false) { if (!read(force)) return NAN; return _h; }
  float convertCtoF(float c) { return c * 1.8f + 32; }
  float convertFtoC(float f) { return (f - 32) * 0.55555f; }
  float computeHeatIndex(bool isF = true) { float t = readTemperature(isF), h = readHumidity(); return computeHeatIndex(t, h, isF); }
  float computeHeatIndex(float temperature, float percentHumidity, bool isFahrenheit = true);
  bool read(bool force = false);
private:
  uint8_t _pin, _type; float _t = NAN, _h = NAN; unsigned long _last = 0; bool _ok = false, _first = true;
};
