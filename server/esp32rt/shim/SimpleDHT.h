#pragma once
// SimpleDHT (winlinvip) API for the WebAssembly boards: readings come from the DHT11 / DHT22 part on the pin
// (the original bit-bangs the one-wire DHT protocol, which these boards model at the transaction level).
#include "Arduino.h"
#define SimpleDHTErrDuration(err) ((err & 0xff00) >> 8)
#define SimpleDHTErrCode(err) (err & 0x00ff)
#define SimpleDHTErrSuccess 0
#define SimpleDHTErrStartLow 16
#define SimpleDHTErrStartHigh 17
#define SimpleDHTErrDataLow 18
#define SimpleDHTErrDataRead 19
#define SimpleDHTErrDataEOF 20
#define SimpleDHTErrDataChecksum 21
#define SimpleDHTErrZeroSamples 22
#define SimpleDHTErrNoPin 23
#define SimpleDHTErrPinMode 24
class SimpleDHT {
public:
  SimpleDHT() {}
  SimpleDHT(int pin) : _pin(pin) {}
  virtual ~SimpleDHT() {}
  virtual int setPinInputMode(uint8_t mode) { (void)mode; return SimpleDHTErrSuccess; }
  virtual int read(byte *t, byte *h, byte pdata[40]) { return read(_pin, t, h, pdata); }
  virtual int read(int pin, byte *t, byte *h, byte pdata[40]) {
    float ft, fh; int r = read2(pin, &ft, &fh, pdata); if (r) return r;
    if (t) *t = (byte)ft; if (h) *h = (byte)fh; return SimpleDHTErrSuccess;
  }
  virtual int read2(float *t, float *h, byte pdata[40]) { return read2(_pin, t, h, pdata); }
  virtual int read2(int pin, float *t, float *h, byte pdata[40]) {
    if (pin < 0) return SimpleDHTErrNoPin;
    float v[2] = { NAN, NAN };
    if (!h_dht_read(pin, _type(), v)) return SimpleDHTErrStartHigh;
    if (_type() == 11) { v[0] = (int)v[0]; v[1] = (int)v[1]; }
    if (t) *t = v[0]; if (h) *h = v[1];
    if (pdata) memset(pdata, 0, 40);
    return SimpleDHTErrSuccess;
  }
protected:
  virtual int _type() = 0;
  int _pin = -1;
};
class SimpleDHT11 : public SimpleDHT { public: SimpleDHT11() {} SimpleDHT11(int pin) : SimpleDHT(pin) {} protected: int _type() { return 11; } };
class SimpleDHT22 : public SimpleDHT { public: SimpleDHT22() {} SimpleDHT22(int pin) : SimpleDHT(pin) {} protected: int _type() { return 22; } };
