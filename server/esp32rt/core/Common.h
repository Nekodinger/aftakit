// Arduino core API (ESP32 flavour) for the browser simulator.
#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdbool.h>

#define HIGH 0x1
#define LOW  0x0
#define INPUT          0x01
#define OUTPUT         0x03
#define PULLUP         0x04
#define INPUT_PULLUP   0x05
#define PULLDOWN       0x08
#define INPUT_PULLDOWN 0x09
#define OPEN_DRAIN     0x10
#define OUTPUT_OPEN_DRAIN 0x13
#define ANALOG         0xC0
#define DISABLED 0x00
#define RISING   0x01
#define FALLING  0x02
#define CHANGE   0x03
#define ONLOW    0x04
#define ONHIGH   0x05
#define LSBFIRST 0
#define MSBFIRST 1
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2

#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
#define HALF_PI 1.5707963267948966192313216916398
#define TWO_PI 6.283185307179586476925286766559
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105
#define EULER 2.718281828459045235360287471352
#define SERIAL  0x0
#define DISPLAY 0x1

#define radians(deg) ((deg)*DEG_TO_RAD)
#define degrees(rad) ((rad)*RAD_TO_DEG)
#define sq(x) ((x)*(x))
#define constrain(amt,low,high) ((amt)<(low)?(low):((amt)>(high)?(high):(amt)))
#define lowByte(w) ((uint8_t) ((w) & 0xff))
#define highByte(w) ((uint8_t) ((w) >> 8))
#define bitRead(value, bit) (((value) >> (bit)) & 0x01)
#define bitSet(value, bit) ((value) |= (1UL << (bit)))
#define bitClear(value, bit) ((value) &= ~(1UL << (bit)))
#define bitToggle(value, bit) ((value) ^= (1UL << (bit)))
#define bitWrite(value, bit, bitvalue) ((bitvalue) ? bitSet(value, bit) : bitClear(value, bit))
#ifndef bit
#define bit(b) (1UL << (b))
#endif
#define _BV(b) (1UL << (b))
#define clockCyclesPerMicrosecond() (240)
#define digitalPinToInterrupt(p) (p)
// direct port-register access (used by some libraries for fast software SPI): harmless dummies here
extern volatile uint32_t __sim_portreg[4];
#define digitalPinToPort(p) (0)
#define digitalPinToBitMask(p) (1UL << ((p) & 31))
#define portOutputRegister(port) (&__sim_portreg[0])
#define portInputRegister(port) (&__sim_portreg[1])
#define portModeRegister(port) (&__sim_portreg[2])
#define NOT_AN_INTERRUPT -1
#define interrupts()
// FreeRTOS critical sections used by real libraries (HX711 ...): the simulator runs a single task
typedef int portMUX_TYPE;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(m) ((void)(m))
#define portEXIT_CRITICAL(m) ((void)(m))
#define portENTER_CRITICAL_ISR(m) ((void)(m))
#define portEXIT_CRITICAL_ISR(m) ((void)(m))
#define noInterrupts()
#define sei()
#define cli()
#define F_CPU 240000000L
#define LED_BUILTIN 2

typedef bool boolean;
typedef uint8_t byte;
typedef uint16_t word;
typedef unsigned int uint;

#ifdef __cplusplus
extern "C" {
#endif
typedef void (*voidFuncPtr)(void);
void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
uint32_t analogReadMilliVolts(uint8_t pin);
void analogReadResolution(uint8_t bits);
void analogSetAttenuation(int attenuation);
void analogSetPinAttenuation(uint8_t pin, int attenuation);
void analogWriteResolution(uint8_t bits);
void analogWriteFrequency(uint32_t freq);
unsigned long millis(void);
unsigned long micros(void);
void delay(uint32_t ms);
void delayMicroseconds(uint32_t us);
void yield(void);
uint32_t pulseIn(uint8_t pin, uint8_t state, uint32_t timeout);
uint32_t pulseInLong(uint8_t pin, uint8_t state, uint32_t timeout);
void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val);
uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder);
void attachInterrupt(uint8_t pin, voidFuncPtr fn, int mode);
void attachInterruptArg(uint8_t pin, void (*fn)(void *), void *arg, int mode);
void detachInterrupt(uint8_t pin);
void noTone(uint8_t pin);
char *dtostrf(double val, signed char width, unsigned char prec, char *sout);
uint32_t esp_random(void);
uint32_t getCpuFrequencyMhz(void);
float temperatureRead(void);
void ledcWriteTone_c(uint8_t pin, uint32_t freq);
#ifdef __cplusplus
}
template <class T, class L> auto min(const T &a, const L &b) -> decltype((b < a) ? b : a) { return (b < a) ? b : a; }
template <class T, class L> auto max(const T &a, const L &b) -> decltype((b < a) ? b : a) { return (a < b) ? b : a; }
#define _min(a, b) ((a) < (b) ? (a) : (b))
#define _max(a, b) ((a) > (b) ? (a) : (b))
long random(long howbig);
long random(long howsmall, long howbig);
void randomSeed(unsigned long seed);
long map(long x, long in_min, long in_max, long out_min, long out_max);
void analogWrite(uint8_t pin, int value);
void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0);
// LEDC (ESP32 Arduino core 2.x)
uint32_t ledcSetup(uint8_t channel, uint32_t freq, uint8_t resolution_bits);
void ledcAttachPin(uint8_t pin, uint8_t channel);
void ledcDetachPin(uint8_t pin);
uint32_t ledcWriteTone(uint8_t chan_or_pin, uint32_t freq);
// LEDC (ESP32 Arduino core 3.x): ledcAttach(pin, freq, bits); ledcWrite(pin, duty)
bool ledcAttach(uint8_t pin, uint32_t freq, uint8_t resolution);
bool ledcAttachChannel(uint8_t pin, uint32_t freq, uint8_t resolution, uint8_t channel);
bool ledcWrite(uint8_t chan_or_pin, uint32_t duty);
bool ledcDetach(uint8_t pin);
uint32_t ledcRead(uint8_t chan_or_pin);
uint16_t makeWord(uint16_t w);
uint16_t makeWord(uint8_t h, uint8_t l);
#define word(...) makeWord(__VA_ARGS__)
#endif
