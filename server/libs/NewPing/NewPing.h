#pragma once
// NewPing 1.9 API (Tim Eckel) for the simulator: ping / ping_cm / ping_in / ping_median / convert_*, measured with
// pulseIn() on every board. The timer-driven pinging (timer_us / timer_ms) is available on the ESP32 / RP2040 runtime.
#include "Arduino.h"
#define MAX_SENSOR_DISTANCE 500
#define US_ROUNDTRIP_CM 57
#define US_ROUNDTRIP_IN 146
#define NO_ECHO 0
#define NewPingConvert(echoTime, conversionFactor) ((((unsigned int)(echoTime) + (conversionFactor) / 2) / (conversionFactor)) > ((echoTime) ? 1u : 0u) ? (((unsigned int)(echoTime) + (conversionFactor) / 2) / (conversionFactor)) : ((echoTime) ? 1u : 0u))
class NewPing {
public:
  NewPing(uint8_t trigger_pin, uint8_t echo_pin, unsigned int max_cm_distance = MAX_SENSOR_DISTANCE) : _trig(trigger_pin), _echo(echo_pin) { set_max_distance(max_cm_distance); pinMode(_trig, OUTPUT); pinMode(_echo, INPUT); }
  unsigned int ping(unsigned int max_cm_distance = 0) {
    if (max_cm_distance) set_max_distance(max_cm_distance);
    digitalWrite(_trig, LOW); delayMicroseconds(4); digitalWrite(_trig, HIGH); delayMicroseconds(10); digitalWrite(_trig, LOW);
    unsigned long us = pulseIn(_echo, HIGH, _maxEchoTime + 1000);
    return us > _maxEchoTime ? NO_ECHO : (unsigned int)us;
  }
  unsigned long ping_cm(unsigned int max_cm_distance = 0) { return NewPingConvert(ping(max_cm_distance), US_ROUNDTRIP_CM); }
  unsigned long ping_in(unsigned int max_cm_distance = 0) { return NewPingConvert(ping(max_cm_distance), US_ROUNDTRIP_IN); }
  unsigned long ping_median(uint8_t it = 5, unsigned int max_cm_distance = 0) {
    unsigned int v[15]; uint8_t n = 0; if (it > 15) it = 15; if (it < 1) it = 1;
    for (uint8_t i = 0; i < it; i++) { unsigned int t = ping(max_cm_distance); if (t) { uint8_t j = n++; while (j > 0 && v[j - 1] < t) { v[j] = v[j - 1]; j--; } v[j] = t; } if (i + 1 < it) delay(30); }
    return n ? v[n >> 1] : NO_ECHO;
  }
  static unsigned int convert_cm(unsigned int echoTime) { return NewPingConvert(echoTime, US_ROUNDTRIP_CM); }
  static unsigned int convert_in(unsigned int echoTime) { return NewPingConvert(echoTime, US_ROUNDTRIP_IN); }
  // timer-based pinging (ping_timer + check_timer from a timer interrupt)
  void ping_timer(void (*userFunc)(void)) { ping_result = ping(); _done = true; userFunc(); }
  boolean check_timer() { if (_done) { _done = false; return ping_result != NO_ECHO; } return false; }
  unsigned long ping_result = 0;
#ifdef SIM_WASM
  static void timer_us(unsigned int frequency, void (*userFunc)(void)) { _tick(frequency, userFunc); }
  static void timer_ms(unsigned long frequency, void (*userFunc)(void)) { _tick(frequency * 1000UL, userFunc); }
  static void timer_stop() { if (_tid >= 0) __sim_timer_cancel(_tid); _tid = -1; }
#endif
private:
#ifdef SIM_WASM
  static void _tick(unsigned long us, void (*fn)(void)) { timer_stop(); _fn = fn; _tid = __sim_timer_add(us, [](void *) { if (_fn) _fn(); }, nullptr, true); }
  static inline void (*_fn)(void) = nullptr; static inline int _tid = -1;
#endif
  void set_max_distance(unsigned int cm) { _maxEchoTime = ((cm + 1) < (unsigned int)(MAX_SENSOR_DISTANCE + 1) ? (cm + 1) : (unsigned int)(MAX_SENSOR_DISTANCE + 1)) * US_ROUNDTRIP_CM + US_ROUNDTRIP_CM / 2; }
  uint8_t _trig, _echo; unsigned int _maxEchoTime = 0; bool _done = false;
};
