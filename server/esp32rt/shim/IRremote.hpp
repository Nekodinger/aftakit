#pragma once
// IRremote (v4 API + the classic v2 IRrecv / decode_results API) for the simulator's ESP32 / ESP8266 / RP2040 runtime.
// The browser decodes the NEC frames of the virtual remote; this header hands them to the sketch.
#include "Arduino.h"
#include "host.h"
#define DISABLE_LED_FEEDBACK false
#define ENABLE_LED_FEEDBACK true
#define USE_DEFAULT_FEEDBACK_LED_PIN 0
#define IRDATA_FLAGS_EMPTY 0x00
#define IRDATA_FLAGS_IS_REPEAT 0x01
#define IRDATA_FLAGS_IS_AUTO_REPEAT 0x02
#define IRDATA_FLAGS_PARITY_FAILED 0x04
#define IRDATA_FLAGS_IS_MSB_FIRST 0x08
#define IRDATA_FLAGS_IS_LSB_FIRST 0x00
#define IR_RECEIVE_PIN 15
#define IR_SEND_PIN 4
#define REPEAT 0xFFFFFFFF
typedef enum { UNKNOWN = 0, PULSE_WIDTH, PULSE_DISTANCE, APPLE, DENON, JVC, LG, LG2, NEC, NEC2, ONKYO, PANASONIC, KASEIKYO, KASEIKYO_DENON,
  KASEIKYO_SHARP, KASEIKYO_JVC, KASEIKYO_MITSUBISHI, RC5, RC6, SAMSUNG, SAMSUNG48, SAMSUNG_LG, SHARP, SONY } decode_type_t;
struct IRData {
  decode_type_t protocol = UNKNOWN; uint16_t address = 0; uint16_t command = 0; uint16_t extra = 0; uint16_t numberOfBits = 0;
  uint8_t flags = 0; uint32_t decodedRawData = 0;
};
struct decode_results { decode_type_t decode_type = UNKNOWN; uint32_t value = 0; uint8_t bits = 0; uint16_t address = 0; uint16_t command = 0; uint8_t overflow = 0; };
inline const char *getProtocolString(decode_type_t p) { return p == NEC ? "NEC" : "UNKNOWN"; }
inline uint8_t ir_rev8(uint8_t b) { b = (b & 0xF0) >> 4 | (b & 0x0F) << 4; b = (b & 0xCC) >> 2 | (b & 0x33) << 2; return (b & 0xAA) >> 1 | (b & 0x55) << 1; }
class IRrecv {
public:
  IRrecv(int pin = -1) : _pin(pin) {}
  IRrecv(int pin, int) : _pin(pin) {}
  void begin(uint8_t pin, bool = false, uint8_t = 0) { _pin = pin; }
  void enableIRIn() {}
  void start() {} void stop() {} void end() {} void disableIRIn() {}
  void resume() {}
  bool isIdle() { return true; }
  bool available() { return _have || fetch(); }
  bool decode() { if (!_have && !fetch()) return false; _have = false; return true; }
  // classic API: results->value = NEC code MSB first (e.g. 0xFF30CF), REPEAT (0xFFFFFFFF) while a key is held
  bool decode(decode_results *r) {
    if (!decode()) return false;
    const IRData &d = decodedIRData;
    r->decode_type = d.protocol; r->bits = 32; r->address = d.address; r->command = d.command;
    r->value = (d.flags & IRDATA_FLAGS_IS_REPEAT) ? REPEAT
      : ((uint32_t)ir_rev8(d.address) << 24) | ((uint32_t)ir_rev8(~d.address & 0xFF) << 16) | ((uint32_t)ir_rev8(d.command) << 8) | ir_rev8(~d.command & 0xFF);
    return true;
  }
  void printIRResultShort(Print *p, bool = true) {
    const IRData &d = decodedIRData;
    p->print("Protocol="); p->print(getProtocolString(d.protocol)); p->print(" Address=0x"); p->print(d.address, HEX); p->print(" Command=0x"); p->print(d.command, HEX);
    if (d.flags & IRDATA_FLAGS_IS_REPEAT) p->print(" Repeat"); else { p->print(" Raw-Data=0x"); p->print(d.decodedRawData, HEX); p->print(" 32 bits LSB first"); }
    p->println();
  }
  void printIRSendUsage(Print *p) { p->print("Send with: IrSender.sendNEC(0x"); p->print(decodedIRData.address, HEX); p->print(", 0x"); p->print(decodedIRData.command, HEX); p->println(", <numberOfRepeats>);"); }
  void printIRResultMinimal(Print *p) { printIRResultShort(p); }
  IRData decodedIRData;
private:
  bool fetch() {
    int32_t f[3];
    if (_pin < 0 || !h_ir_read(_pin, f)) return false;
    decodedIRData.protocol = NEC; decodedIRData.address = (uint16_t)f[0]; decodedIRData.command = (uint16_t)f[1]; decodedIRData.numberOfBits = 32;
    decodedIRData.flags = f[2] ? IRDATA_FLAGS_IS_REPEAT : 0;
    decodedIRData.decodedRawData = f[2] ? 0 : ((uint32_t)(~f[1] & 0xFF) << 24) | ((uint32_t)(f[1] & 0xFF) << 16) | ((uint32_t)(~f[0] & 0xFF) << 8) | (f[0] & 0xFF);
    _have = true; return true;
  }
  int _pin; bool _have = false;
};
class IRsend {
public:
  IRsend(int pin = -1) : _pin(pin) {}
  void begin(uint8_t pin, bool = false, uint8_t = 0) { _pin = pin; }
  void begin() {}
  void sendNEC(uint16_t a, uint8_t c, int_fast8_t = 0) { say("IR kirim NEC alamat 0x%X perintah 0x%X", a, c); }
  void sendNEC(uint32_t data, uint8_t nbits) { say("IR kirim NEC 0x%lX", (unsigned long)data, 0); }
  void sendNECRaw(uint32_t raw, int_fast8_t = 0) { say("IR kirim NEC raw 0x%lX", (unsigned long)raw, 0); }
private:
  template <class A, class B> static void say(const char *f, A a, B b) { char t[80]; int n = snprintf(t, sizeof t, f, a, b); h_log(0, t, n); }
  int _pin;
};
inline IRrecv IrReceiver;
inline IRsend IrSender;
