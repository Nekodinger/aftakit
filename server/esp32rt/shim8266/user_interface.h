#pragma once
// ESP8266 SDK header (simulator stub)
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#ifdef __cplusplus
extern "C" {
#endif
static inline uint32_t system_get_free_heap_size(void) { return 40000; }
static inline uint32_t system_get_chip_id(void) { return 0x5A1D17; }
static inline void system_restart(void) {}
static inline uint32_t system_get_time(void) { return 0; }
#ifdef __cplusplus
}
#endif
