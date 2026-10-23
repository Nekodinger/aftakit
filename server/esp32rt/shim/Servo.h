#pragma once
#include "Arduino.h"
#define MIN_PULSE_WIDTH 544
#define MAX_PULSE_WIDTH 2400
#define DEFAULT_PULSE_WIDTH 1500
class Servo {
public:
  int attach(int pin) { return attach(pin, MIN_PULSE_WIDTH, MAX_PULSE_WIDTH); }
  int attach(int pin, int mn, int mx) { _pin = pin; _min = mn; _max = mx; writeMicroseconds(_us); return 1; }
  void detach() { if (_pin >= 0) h_servo_write(_pin, -1); _pin = -1; }
  void write(int v) { if (v < 200) { v = constrain(v, 0, 180); _us = _min + (long)(_max - _min) * v / 180; } else _us = v; writeMicroseconds(_us); }
  void writeMicroseconds(int us) { _us = us; if (_pin >= 0) h_servo_write(_pin, us); }
  int read() { return (int)lround((double)(_us - _min) * 180 / (_max - _min)); }
  int readMicroseconds() { return _us; }
  bool attached() { return _pin >= 0; }
  void setPeriodHertz(int) {}
private:
  int _pin = -1, _min = MIN_PULSE_WIDTH, _max = MAX_PULSE_WIDTH, _us = DEFAULT_PULSE_WIDTH;
};
class ESP32PWM { public: static void allocateTimer(int) {} };
