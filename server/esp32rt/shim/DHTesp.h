#pragma once
// DHTesp (beegee-tokyo) API on the simulator: readings come from the DHT11 / DHT22 part wired to the pin.
#include "Arduino.h"
struct TempAndHumidity { float temperature; float humidity; };
struct ComfortState { int dummy; };
typedef enum { Comfort_OK = 0 } ComfortState_t;
class DHTesp {
public:
  typedef enum { AUTO_DETECT, DHT11, DHT22, AM2302, RHT03 } DHT_MODEL_t;
  typedef enum { ERROR_NONE = 0, ERROR_TIMEOUT, ERROR_CHECKSUM } DHT_ERROR_t;
  void setup(uint8_t pin, DHT_MODEL_t model = AUTO_DETECT) { _pin = pin; _model = model; pinMode(pin, INPUT_PULLUP); _last = 0; _first = true; }
  void setup(uint8_t pin) { setup(pin, AUTO_DETECT); }
  void resetTimer() { _first = true; }
  float getTemperature() { read(); return _t; }
  float getHumidity() { read(); return _h; }
  TempAndHumidity getTempAndHumidity() { read(); return { _t, _h }; }
  DHT_ERROR_t getStatus() { return _err; }
  const char *getStatusString() { return _err == ERROR_NONE ? "OK" : _err == ERROR_TIMEOUT ? "TIMEOUT" : "CHECKSUM"; }
  DHT_MODEL_t getModel() { return _model; }
  int getMinimumSamplingPeriod() { return _model == DHT11 ? 1000 : 2000; }
  int8_t getNumberOfDecimalsTemperature() { return _model == DHT11 ? 0 : 1; }
  int8_t getLowerBoundTemperature() { return _model == DHT11 ? 0 : -40; }
  int8_t getUpperBoundTemperature() { return _model == DHT11 ? 50 : 125; }
  int8_t getNumberOfDecimalsHumidity() { return 0; }
  int8_t getLowerBoundHumidity() { return _model == DHT11 ? 20 : 0; }
  int8_t getUpperBoundHumidity() { return _model == DHT11 ? 90 : 100; }
  static float toFahrenheit(float c) { return c * 1.8f + 32; }
  static float toCelsius(float f) { return (f - 32) / 1.8f; }
  float computeHeatIndex(float t, float h, bool isF = false) {
    float T = isF ? t : toFahrenheit(t);
    float hi = 0.5f * (T + 61.0f + ((T - 68.0f) * 1.2f) + (h * 0.094f));
    if (hi > 79) hi = -42.379f + 2.04901523f * T + 10.14333127f * h - 0.22475541f * T * h - 0.00683783f * T * T - 0.05481717f * h * h + 0.00122874f * T * T * h + 0.00085282f * T * h * h - 0.00000199f * T * T * h * h;
    return isF ? hi : toCelsius(hi);
  }
  float computeDewPoint(float t, float h, bool isF = false) {
    float c = isF ? toCelsius(t) : t; double a = 17.271, b = 237.7, g = (a * c) / (b + c) + log(h / 100.0); float dp = b * g / (a - g);
    return isF ? toFahrenheit(dp) : dp;
  }
  float computeAbsoluteHumidity(float t, float h, bool isF = false) { float c = isF ? toCelsius(t) : t; return (6.112f * expf((17.67f * c) / (c + 243.5f)) * h * 2.1674f) / (273.15f + c); }
  byte computePerception(float t, float h, bool isF = false) { float dp = computeDewPoint(t, h, isF); if (isF) dp = toCelsius(dp); return dp < 10 ? 0 : dp < 13 ? 1 : dp < 16 ? 2 : dp < 18 ? 3 : dp < 21 ? 4 : dp < 24 ? 5 : dp < 26 ? 6 : 7; }
private:
  void read() {
    unsigned long now = millis();
    if (!_first && now - _last < (unsigned long)getMinimumSamplingPeriod()) return;
    _first = false; _last = now;
    float v[2] = { NAN, NAN };
    int type = _model == DHT11 ? 11 : _model == AUTO_DETECT ? 0 : 22;
    if (h_dht_read(_pin, type, v)) { _t = (_model == DHT11) ? roundf(v[0]) : roundf(v[0] * 10) / 10.0f; _h = roundf(v[1] * 10) / 10.0f; _err = ERROR_NONE; }
    else { _t = _h = NAN; _err = ERROR_TIMEOUT; }
  }
  uint8_t _pin = 0; DHT_MODEL_t _model = AUTO_DETECT; DHT_ERROR_t _err = ERROR_NONE; float _t = NAN, _h = NAN; unsigned long _last = 0; bool _first = true;
};
