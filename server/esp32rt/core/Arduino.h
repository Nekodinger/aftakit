// Arduino.h for the browser ESP32 / ESP8266 / RP2040 simulator (sketch runs as WebAssembly).
#pragma once
#include "Common.h"
#include "Binary.h"
#include <stdio.h>
#include <stdarg.h>
#include <ctype.h>
#ifdef __cplusplus
#include <algorithm>
#include "WString.h"
#include "Print.h"
#include "Stream.h"
#include "Printable.h"
#include "IPAddress.h"
#include "HardwareSerial.h"
#include "pgmspace.h"
namespace arduino { using ::String; using ::Stream; using ::Print; using ::Printable; using ::IPAddress; using ::__FlashStringHelper; }
using namespace arduino;
#ifndef abs
template <typename T> static inline auto abs(T x) -> decltype(x < 0 ? -x : x) { return x < 0 ? -x : x; }
#endif
#endif
#include "boards.h"
#include "itoa.h"   // itoa / ltoa / utoa / ultoa (stdlib_noniso on ESP32)
#include <string.h>
#include <strings.h>
// newlib extensions available on the ESP32 / ESP8266 cores
static inline char *strupr(char *s) { for (char *p = s; p && *p; p++) *p = (char)toupper((unsigned char)*p); return s; }
static inline char *strlwr(char *s) { for (char *p = s; p && *p; p++) *p = (char)tolower((unsigned char)*p); return s; }
#define ESP_PLATFORM_SIM 1
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define IRAM_ATTR
#define ICACHE_RAM_ATTR
#define DRAM_ATTR
#define RTC_DATA_ATTR
#define ARDUINO_ISR_ATTR
#define portMAX_DELAY 0xffffffff
#define portTICK_PERIOD_MS 1
#define pdMS_TO_TICKS(ms) (ms)
#define vTaskDelay(t) delay(t)
#ifdef __cplusplus
class EspClass {
public:
  void restart();
  uint32_t getFreeHeap() { return 280000; }
  uint32_t getHeapSize() { return 327680; }
  uint32_t getChipId() { return 0x5A1D17; }
  uint64_t getEfuseMac() { return 0x24A1609E3C10ULL; }
  const char *getChipModel() { return "ESP32-D0WD (simulator)"; }
  uint8_t getChipRevision() { return 3; }
  uint32_t getCpuFreqMHz() { return 240; }
  uint32_t getFlashChipSize() { return 4 * 1024 * 1024; }
  const char *getSdkVersion() { return "sim"; }
  void deepSleep(uint64_t us);
};
extern EspClass ESP;
inline bool psramFound() { return true; }
// time: the simulator's clock is the real clock of the device (as if NTP already synchronised)
#include <time.h>
void configTime(long gmtOffset_sec, int daylightOffset_sec, const char *server1, const char *server2 = nullptr, const char *server3 = nullptr);
void configTzTime(const char *tz, const char *server1, const char *server2 = nullptr, const char *server3 = nullptr);
void configTime(const char *tz, const char *server1, const char *server2 = nullptr, const char *server3 = nullptr);
bool getLocalTime(struct tm *info, uint32_t ms = 5000);
void esp_deep_sleep(uint64_t us);
void esp_restart(void);
#endif

#ifdef __cplusplus
// ---- software timers used by Ticker and the ESP32 hardware-timer API
extern "C" int __sim_timer_add(double period_us, void (*fn)(void *), void *arg, bool repeat);
extern "C" void __sim_timer_cancel(int id);
extern "C" double __sim_timer_next();
struct hw_timer_s { int id; double tick_us; double alarm_ticks; bool reload, enabled; void (*fn)(); void (*fnArg)(void *); void *arg; double t0; uint64_t base; bool running; };
typedef struct hw_timer_s hw_timer_t;
static inline void __hwt_fire(void *p) { hw_timer_t *t = (hw_timer_t *)p; if (t->fn) t->fn(); else if (t->fnArg) t->fnArg(t->arg); }
static inline void __hwt_arm(hw_timer_t *t) { if (t->id >= 0) __sim_timer_cancel(t->id); t->id = -1; if (t->enabled && t->alarm_ticks > 0 && (t->fn || t->fnArg)) t->id = __sim_timer_add(t->alarm_ticks * t->tick_us, __hwt_fire, t, t->reload); }
// arduino-esp32 2.x
static inline hw_timer_t *timerBegin(uint8_t num, uint16_t divider, bool countUp) { (void)num; (void)countUp; hw_timer_t *t = new hw_timer_t(); t->id = -1; t->tick_us = (divider ? divider : 1) / 80.0; t->running = true; t->t0 = micros(); return t; }
static inline void timerAttachInterrupt(hw_timer_t *t, void (*fn)(), bool edge) { (void)edge; if (t) { t->fn = fn; __hwt_arm(t); } }
static inline void timerAlarmWrite(hw_timer_t *t, uint64_t alarm, bool reload) { if (t) { t->alarm_ticks = (double)alarm; t->reload = reload; __hwt_arm(t); } }
static inline void timerAlarmEnable(hw_timer_t *t) { if (t) { t->enabled = true; __hwt_arm(t); } }
static inline void timerAlarmDisable(hw_timer_t *t) { if (t) { t->enabled = false; __hwt_arm(t); } }
static inline bool timerAlarmEnabled(hw_timer_t *t) { return t && t->enabled; }
// arduino-esp32 3.x
static inline hw_timer_t *timerBegin(uint32_t frequency) { hw_timer_t *t = new hw_timer_t(); t->id = -1; t->tick_us = 1e6 / (frequency ? frequency : 1000000); t->running = true; t->t0 = micros(); return t; }
static inline void timerAttachInterrupt(hw_timer_t *t, void (*fn)()) { if (t) { t->fn = fn; __hwt_arm(t); } }
static inline void timerAttachInterruptArg(hw_timer_t *t, void (*fn)(void *), void *arg) { if (t) { t->fnArg = fn; t->arg = arg; __hwt_arm(t); } }
static inline void timerAlarm(hw_timer_t *t, uint64_t alarm, bool reload, uint64_t count) { (void)count; if (t) { t->alarm_ticks = (double)alarm; t->reload = reload; t->enabled = true; __hwt_arm(t); } }
// both
static inline void timerDetachInterrupt(hw_timer_t *t) { if (t) { t->fn = nullptr; t->fnArg = nullptr; __hwt_arm(t); } }
static inline void timerEnd(hw_timer_t *t) { if (t) { t->enabled = false; __hwt_arm(t); delete t; } }
static inline uint64_t timerRead(hw_timer_t *t) { return t ? (uint64_t)((micros() - t->t0) / t->tick_us) : 0; }
static inline uint64_t timerReadMicros(hw_timer_t *t) { return t ? (uint64_t)(micros() - t->t0) : 0; }
static inline double timerReadSeconds(hw_timer_t *t) { return t ? (micros() - t->t0) / 1e6 : 0; }
static inline void timerWrite(hw_timer_t *t, uint64_t v) { if (t) t->t0 = micros() - v * t->tick_us; }
static inline void timerRestart(hw_timer_t *t) { if (t) { t->t0 = micros(); __hwt_arm(t); } }
static inline void timerStart(hw_timer_t *t) { if (t) { t->enabled = true; __hwt_arm(t); } }
static inline void timerStop(hw_timer_t *t) { if (t) { t->enabled = false; __hwt_arm(t); } }

// ---- WCharacter.h (Arduino character classification)
static inline bool isAlphaNumeric(int c) { return isalnum(c); }
static inline bool isAlpha(int c) { return isalpha(c); }
static inline bool isAscii(int c) { return (unsigned)c < 128; }
static inline bool isWhitespace(int c) { return c == ' ' || c == '\t'; }
static inline bool isControl(int c) { return iscntrl(c); }
static inline bool isDigit(int c) { return isdigit(c); }
static inline bool isGraph(int c) { return isgraph(c); }
static inline bool isLowerCase(int c) { return islower(c); }
static inline bool isPrintable(int c) { return isprint(c); }
static inline bool isPunct(int c) { return ispunct(c); }
static inline bool isSpace(int c) { return isspace(c); }
static inline bool isUpperCase(int c) { return isupper(c); }
static inline bool isHexadecimalDigit(int c) { return isxdigit(c); }
static inline int toAscii(int c) { return c & 0x7f; }
static inline int toLowerCase(int c) { return tolower(c); }
static inline int toUpperCase(int c) { return toupper(c); }
#endif
