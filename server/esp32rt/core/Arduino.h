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
using namespace arduino;
#ifndef abs
template <typename T> static inline auto abs(T x) -> decltype(x < 0 ? -x : x) { return x < 0 ? -x : x; }
#endif
#endif
#include "boards.h"
#include "itoa.h"   // itoa / ltoa / utoa / ultoa (stdlib_noniso on ESP32)
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
