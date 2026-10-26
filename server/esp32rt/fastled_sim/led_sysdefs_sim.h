#pragma once
// FastLED platform for the browser simulator (WebAssembly): generic pins, software SPI, clockless output handed
// to the simulator's NeoPixel model (same path as Adafruit_NeoPixel::show()).
#define FASTLED_SIM
#define FASTLED_FORCE_SOFTWARE_PINS
#define FASTLED_FORCE_SOFTWARE_SPI
#define FASTLED_HAS_MILLIS
#ifndef FASTLED_USE_PROGMEM
#define FASTLED_USE_PROGMEM 0
#endif
#ifndef FASTLED_ALLOW_INTERRUPTS
#define FASTLED_ALLOW_INTERRUPTS 1
#define INTERRUPT_THRESHOLD 0
#endif
#ifndef F_CPU
#define F_CPU 240000000L
#endif
typedef volatile uint32_t RoReg;
typedef volatile uint32_t RwReg;
#include <Arduino.h>   // prog_uint32_t etc. come from the core pgmspace.h
#ifndef cli
#define cli()
#endif
#ifndef sei
#define sei()
#endif
