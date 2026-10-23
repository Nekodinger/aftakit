// Core Arduino API implemented on top of the simulator's host imports.
#include "Arduino.h"
#include "host.h"

HardwareSerial Serial(0), Serial1(1), Serial2(2);
EspClass ESP;

static uint32_t g_calls = 0;
static double g_frame_start = 0;
// Every so often give control back to the browser so busy loops (while(!digitalRead(x)){}) cannot freeze the page.
static void tick() { if (++g_calls >= 400) { g_calls = 0; h_yield(); extern void __sim_run_irqs(); __sim_run_irqs(); } }

// ---------------------------------------------------------------- interrupts (polled at safe points)
struct Irq { voidFuncPtr fn; void (*fnArg)(void *); void *arg; };
static Irq g_irq[64];
void __sim_run_irqs() {
  int pairs[32];
  int n = h_irq_poll(pairs, 16);
  for (int i = 0; i < n; i++) {
    int pin = pairs[2 * i], count = pairs[2 * i + 1];
    if (pin < 0 || pin >= 64) continue;
    for (int k = 0; k < count && k < 5000; k++) { if (g_irq[pin].fn) g_irq[pin].fn(); else if (g_irq[pin].fnArg) g_irq[pin].fnArg(g_irq[pin].arg); }
  }
}
extern "C" void attachInterrupt(uint8_t pin, voidFuncPtr fn, int mode) { if (pin < 64) { g_irq[pin] = { fn, nullptr, nullptr }; h_irq_attach(pin, mode); } }
extern "C" void attachInterruptArg(uint8_t pin, void (*fn)(void *), void *arg, int mode) { if (pin < 64) { g_irq[pin] = { nullptr, fn, arg }; h_irq_attach(pin, mode); } }
extern "C" void detachInterrupt(uint8_t pin) { if (pin < 64) { g_irq[pin] = { nullptr, nullptr, nullptr }; h_irq_attach(pin, 0); } }

// ---------------------------------------------------------------- GPIO / ADC
static uint8_t g_adc_bits = 12, g_pwm_bits = 8;
static uint32_t g_pwm_freq = 1000;
extern "C" void pinMode(uint8_t pin, uint8_t mode) { h_pin_mode(pin, mode); }
extern "C" void digitalWrite(uint8_t pin, uint8_t val) { h_digital_write(pin, val ? 1 : 0); tick(); }
extern "C" int digitalRead(uint8_t pin) { tick(); return h_digital_read(pin); }
extern "C" uint32_t analogReadMilliVolts(uint8_t pin) { tick(); int mv = h_analog_mv(pin); return mv < 0 ? 0 : (uint32_t)mv; }
extern "C" int analogRead(uint8_t pin) {
  tick();
  int mv = h_analog_mv(pin); if (mv < 0) return 0;
#if defined(SIM_BOARD_ESP8266)
  double full = 3300.0;           // NodeMCU / D1 mini: on-board divider -> 0..3.3 V maps to 0..1023
  int maxv = 1023;
#elif defined(SIM_BOARD_RP2040)
  double full = 3300.0; int maxv = (1 << g_adc_bits) - 1;
#else
  double full = 3300.0;           // ESP32, 11 dB attenuation (default): ~0..3.3 V (ideal, linear)
  int maxv = (1 << g_adc_bits) - 1;
#endif
  long v = lround(mv / full * maxv);
  return (int)constrain(v, 0L, (long)maxv);
}
extern "C" void analogReadResolution(uint8_t bits) { g_adc_bits = constrain(bits, (uint8_t)9, (uint8_t)16); }
extern "C" void analogSetAttenuation(int) {}
extern "C" void analogSetPinAttenuation(uint8_t, int) {}
extern "C" void analogWriteResolution(uint8_t bits) { g_pwm_bits = constrain(bits, (uint8_t)1, (uint8_t)16); }
extern "C" void analogWriteFrequency(uint32_t f) { g_pwm_freq = f; }
void analogWrite(uint8_t pin, int value) {
#if defined(SIM_BOARD_ESP8266)
  int maxv = 1023;               // ESP8266 core: analogWriteRange default 255 (core 3.x) — accept both
  if (value <= 255) maxv = 255;
#else
  int maxv = (1 << g_pwm_bits) - 1;
#endif
  h_pwm_write(pin, constrain((double)value / maxv, 0.0, 1.0), g_pwm_freq); tick();
}

// ---------------------------------------------------------------- LEDC (both ESP32 core 2.x and 3.x styles)
struct LedcCh { int pin = -1; uint32_t freq = 5000; uint8_t bits = 8; uint32_t duty = 0; };
static LedcCh g_ch[16];
static int g_pin_bits[64];  // core 3.x: per-pin resolution
static uint32_t g_pin_freq[64], g_pin_duty[64];
uint32_t ledcSetup(uint8_t ch, uint32_t freq, uint8_t bits) { if (ch < 16) { g_ch[ch].freq = freq; g_ch[ch].bits = bits; } return freq; }
void ledcAttachPin(uint8_t pin, uint8_t ch) { if (ch < 16) { g_ch[ch].pin = pin; h_pwm_write(pin, 0, g_ch[ch].freq); } }
void ledcDetachPin(uint8_t pin) { for (auto &c : g_ch) if (c.pin == pin) c.pin = -1; h_pwm_write(pin, -1, 0); }
bool ledcAttach(uint8_t pin, uint32_t freq, uint8_t bits) { if (pin >= 64) return false; g_pin_bits[pin] = bits; g_pin_freq[pin] = freq; h_pwm_write(pin, 0, freq); return true; }
bool ledcAttachChannel(uint8_t pin, uint32_t freq, uint8_t bits, uint8_t ch) { ledcSetup(ch, freq, bits); ledcAttachPin(pin, ch); return ledcAttach(pin, freq, bits); }
bool ledcDetach(uint8_t pin) { ledcDetachPin(pin); if (pin < 64) g_pin_bits[pin] = 0; return true; }
// ledcWrite(x, duty): x is a channel when a channel with that number was set up with ledcAttachPin (core 2.x), otherwise a pin (core 3.x)
bool ledcWrite(uint8_t x, uint32_t duty) {
  tick();
  if (x < 16 && g_ch[x].pin >= 0) { g_ch[x].duty = duty; h_pwm_write(g_ch[x].pin, (double)duty / ((1u << g_ch[x].bits) - 1), g_ch[x].freq); return true; }
  if (x < 64 && g_pin_bits[x]) { g_pin_duty[x] = duty; h_pwm_write(x, (double)duty / ((1u << g_pin_bits[x]) - 1), g_pin_freq[x]); return true; }
  return false;
}
uint32_t ledcRead(uint8_t x) { if (x < 16 && g_ch[x].pin >= 0) return g_ch[x].duty; if (x < 64) return g_pin_duty[x]; return 0; }
uint32_t ledcWriteTone(uint8_t x, uint32_t freq) {
  int pin = (x < 16 && g_ch[x].pin >= 0) ? g_ch[x].pin : x;
  if (freq == 0) h_pwm_write(pin, 0, 1000); else h_tone(pin, freq, 0);
  return freq;
}
void tone(uint8_t pin, unsigned int frequency, unsigned long duration) { h_tone(pin, frequency, duration); }
extern "C" void noTone(uint8_t pin) { h_tone(pin, 0, 0); }

// ---------------------------------------------------------------- time
extern "C" unsigned long millis(void) { tick(); return (unsigned long)(h_now_us() / 1000.0); }
extern "C" unsigned long micros(void) { tick(); return (unsigned long)h_now_us(); }
extern "C" void delay(uint32_t ms) { h_delay_us(ms * 1000.0); __sim_run_irqs(); }
extern "C" void delayMicroseconds(uint32_t us) { h_delay_us(us); }
extern "C" void yield(void) { h_yield(); __sim_run_irqs(); }
extern "C" uint32_t pulseIn(uint8_t pin, uint8_t state, uint32_t timeout) { return (uint32_t)h_pulse_in(pin, state, timeout ? timeout : 1000000); }
extern "C" uint32_t pulseInLong(uint8_t pin, uint8_t state, uint32_t timeout) { return pulseIn(pin, state, timeout); }
extern "C" void shiftOut(uint8_t d, uint8_t c, uint8_t order, uint8_t val) {
  for (int i = 0; i < 8; i++) { digitalWrite(d, order == LSBFIRST ? (val >> i) & 1 : (val >> (7 - i)) & 1); digitalWrite(c, HIGH); digitalWrite(c, LOW); }
}
extern "C" uint8_t shiftIn(uint8_t d, uint8_t c, uint8_t order) {
  uint8_t v = 0; for (int i = 0; i < 8; i++) { digitalWrite(c, HIGH); if (order == LSBFIRST) v |= digitalRead(d) << i; else v |= digitalRead(d) << (7 - i); digitalWrite(c, LOW); } return v;
}

// ---------------------------------------------------------------- misc
static uint32_t g_seed = 0;
void randomSeed(unsigned long seed) { if (seed) { g_seed = seed; srand(seed); } }
long random(long howbig) { if (howbig <= 0) return 0; return (g_seed ? (long)(rand() % howbig) : (long)(h_random32() % (uint32_t)howbig)); }
long random(long lo, long hi) { if (lo >= hi) return lo; return random(hi - lo) + lo; }
long map(long x, long in_min, long in_max, long out_min, long out_max) { if (in_max == in_min) return out_min; return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min; }
extern "C" uint32_t esp_random(void) { return h_random32(); }
extern "C" uint32_t getCpuFrequencyMhz(void) { return 240; }
extern "C" float temperatureRead(void) { return 45.0f; }
uint16_t makeWord(uint16_t w) { return w; }
uint16_t makeWord(uint8_t h, uint8_t l) { return (h << 8) | l; }
void EspClass::restart() { h_log(1, "ESP.restart()", 13); h_delay_us(1e12); }
void EspClass::deepSleep(uint64_t) { h_log(1, "deep sleep", 10); h_delay_us(1e12); }
void esp_deep_sleep(uint64_t us) { ESP.deepSleep(us); }
void esp_restart(void) { ESP.restart(); }

// itoa family (not in wasi-libc)
static char *ultoa_impl(unsigned long v, char *s, int radix) {
  char tmp[34]; int i = 0; if (radix < 2 || radix > 36) radix = 10;
  do { int d = v % radix; tmp[i++] = d < 10 ? '0' + d : 'a' + d - 10; v /= radix; } while (v);
  int j = 0; while (i) s[j++] = tmp[--i]; s[j] = 0; return s;
}
extern "C" char *ultoa(unsigned long v, char *s, int radix) { return ultoa_impl(v, s, radix); }
extern "C" char *utoa(unsigned v, char *s, int radix) { return ultoa_impl(v, s, radix); }
extern "C" char *ltoa(long v, char *s, int radix) { if (v < 0 && radix == 10) { s[0] = '-'; ultoa_impl(-(unsigned long)v, s + 1, radix); return s; } return ultoa_impl((unsigned long)v, s, radix); }
extern "C" char *itoa(int v, char *s, int radix) { return ltoa(v, s, radix); }
extern "C" char *dtostrf(double val, signed char width, unsigned char prec, char *sout) { char fmt[20]; snprintf(fmt, sizeof fmt, "%%%d.%df", width, prec); sprintf(sout, fmt, val); return sout; }

// ---------------------------------------------------------------- Serial
void HardwareSerial::begin(unsigned long baud, uint32_t, int8_t, int8_t, bool, unsigned long) { _baud = baud; h_serial_begin(_port, (int)baud); }
int HardwareSerial::available() { tick(); return (_peeked >= 0 ? 1 : 0) + h_serial_available(_port); }
int HardwareSerial::peek() { if (_peeked < 0) _peeked = h_serial_read(_port); return _peeked; }
int HardwareSerial::read() { tick(); if (_peeked >= 0) { int c = _peeked; _peeked = -1; return c; } return h_serial_read(_port); }
size_t HardwareSerial::write(uint8_t c) { h_serial_write(_port, &c, 1); return 1; }
size_t HardwareSerial::write(const uint8_t *b, size_t n) { h_serial_write(_port, b, (int)n); return n; }

// ---------------------------------------------------------------- entry points + asyncify scratch buffer
void setup();
void loop();
static uint8_t g_async_buf[256 * 1024] __attribute__((aligned(16)));
extern "C" __attribute__((export_name("sim_async_buf"))) void *sim_async_buf() { return g_async_buf; }
extern "C" __attribute__((export_name("sim_async_size"))) int sim_async_size() { return sizeof g_async_buf; }
extern "C" __attribute__((export_name("sim_setup"))) void sim_setup() { setup(); }
extern "C" __attribute__((export_name("sim_loop"))) void sim_loop() { loop(); __sim_run_irqs(); }
extern "C" __attribute__((export_name("sim_malloc"))) void *sim_malloc(int n) { return malloc(n); }
extern "C" __attribute__((weak)) int main() { return 0; }

volatile uint32_t __sim_portreg[4];

// ---------------------------------------------------------------- time / NTP (configTime, getLocalTime)
static long g_tz_off = 0;   // seconds east of UTC
void configTime(long gmt, int dst, const char *, const char *, const char *) { g_tz_off = gmt + dst; }
static long parse_tz(const char *tz) {   // POSIX TZ such as "WIB-7" or "<+07>-7": offset is the negated number
  if (!tz) return 0;
  const char *p = tz; if (*p == '<') { while (*p && *p != '>') p++; if (*p) p++; } else while (*p && (isalpha((unsigned char)*p))) p++;
  if (!*p) return 0;
  int sign = 1; if (*p == '-') { sign = -1; p++; } else if (*p == '+') p++;
  long h = strtol(p, (char **)&p, 10), m = 0; if (*p == ':') m = strtol(p + 1, nullptr, 10);
  return -sign * (h * 3600 + m * 60);
}
void configTzTime(const char *tz, const char *, const char *, const char *) { g_tz_off = parse_tz(tz); }
void configTime(const char *tz, const char *a, const char *b, const char *c) { configTzTime(tz, a, b, c); }
// local time = UTC + offset from configTime / configTzTime / setenv("TZ", ...) + tzset()
extern "C" void tzset(void) { const char *tz = getenv("TZ"); if (tz) g_tz_off = parse_tz(tz); }
extern "C" struct tm *localtime_r(const time_t *t, struct tm *r) { time_t x = *t + g_tz_off; return gmtime_r(&x, r); }
extern "C" struct tm *localtime(const time_t *t) { static struct tm r; return localtime_r(t, &r); }
static long long days_from_civil(long long y, unsigned m, unsigned d) { y -= m <= 2; long long era = (y >= 0 ? y : y - 399) / 400; unsigned yoe = (unsigned)(y - era * 400); unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1; unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; return era * 146097 + (long long)doe - 719468; }
extern "C" time_t mktime(struct tm *tm) {
  long long y = tm->tm_year + 1900LL, mo = tm->tm_mon; y += mo / 12; mo %= 12; if (mo < 0) { mo += 12; y--; }
  long long secs = days_from_civil(y, (unsigned)mo + 1, 1) * 86400LL + (tm->tm_mday - 1) * 86400LL + tm->tm_hour * 3600LL + tm->tm_min * 60LL + tm->tm_sec - g_tz_off;
  time_t t = (time_t)secs; localtime_r(&t, tm); return t;
}
bool getLocalTime(struct tm *info, uint32_t) { time_t t = time(nullptr); localtime_r(&t, info); return info->tm_year > 100; }
