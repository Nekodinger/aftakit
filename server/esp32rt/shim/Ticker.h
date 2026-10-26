#pragma once
// arduino-esp32 / ESP8266 Ticker: periodic or one-shot callbacks driven by the simulator's software timers.
#include "Arduino.h"
class Ticker {
public:
  typedef void (*callback_t)();
  typedef void (*callback_with_arg_t)(void *);
  Ticker() {}
  ~Ticker() { detach(); }
  void attach(float seconds, callback_t cb) { _arm(seconds * 1e6, cb, true); }
  void attach_ms(uint32_t ms, callback_t cb) { _arm(ms * 1e3, cb, true); }
  void attach_us(uint32_t us, callback_t cb) { _arm(us, cb, true); }
  void once(float seconds, callback_t cb) { _arm(seconds * 1e6, cb, false); }
  void once_ms(uint32_t ms, callback_t cb) { _arm(ms * 1e3, cb, false); }
  void once_us(uint32_t us, callback_t cb) { _arm(us, cb, false); }
  template <typename T> void attach(float s, void (*cb)(T), T arg) { _armArg(s * 1e6, (callback_with_arg_t)cb, (void *)(intptr_t)arg, true); }
  template <typename T> void attach_ms(uint32_t ms, void (*cb)(T), T arg) { _armArg(ms * 1e3, (callback_with_arg_t)cb, (void *)(intptr_t)arg, true); }
  template <typename T> void once(float s, void (*cb)(T), T arg) { _armArg(s * 1e6, (callback_with_arg_t)cb, (void *)(intptr_t)arg, false); }
  template <typename T> void once_ms(uint32_t ms, void (*cb)(T), T arg) { _armArg(ms * 1e3, (callback_with_arg_t)cb, (void *)(intptr_t)arg, false); }
  void detach() { if (_id >= 0) __sim_timer_cancel(_id); _id = -1; }
  bool active() const { return _id >= 0; }
private:
  static void _call(void *self) { Ticker *t = (Ticker *)self; if (!t->_repeat) t->_id = -1; if (t->_cb) t->_cb(); else if (t->_cbArg) t->_cbArg(t->_arg); }
  void _arm(double us, callback_t cb, bool rep) { detach(); _cb = cb; _cbArg = nullptr; _repeat = rep; _id = __sim_timer_add(us, _call, this, rep); }
  void _armArg(double us, callback_with_arg_t cb, void *arg, bool rep) { detach(); _cb = nullptr; _cbArg = cb; _arg = arg; _repeat = rep; _id = __sim_timer_add(us, _call, this, rep); }
  int _id = -1; bool _repeat = false; callback_t _cb = nullptr; callback_with_arg_t _cbArg = nullptr; void *_arg = nullptr;
};
