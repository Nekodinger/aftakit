#pragma once
// TCP / TLS client for the simulator. Connections are real: they go through the IoT gateway of the compile
// server (like Wokwi's public gateway), so libraries such as Blynk, PubSubClient (MQTT), UniversalTelegramBot,
// ThingSpeak or Firebase work unchanged. TLS is terminated by the gateway (certificates are verified there).
#include "Arduino.h"
#include "Client.h"
#include "IPAddress.h"
class WiFiClient : public arduino::Client {
public:
  WiFiClient() {}
  ~WiFiClient() {}
  int connect(IPAddress ip, uint16_t port) override { char b[20]; snprintf(b, sizeof b, "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]); return connect(b, port); }
  int connect(const char *host, uint16_t port) override {
    stop();
    int s = h_net_open(host, port, _tls ? 1 : 0);
    if (s <= 0) return 0;
    _s = s; _pk = -1; return 1;
  }
  int connect(const char *host, uint16_t port, int32_t /*timeout*/) { return connect(host, port); }
  int connect(IPAddress ip, uint16_t port, int32_t) { return connect(ip, port); }
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t *b, size_t n) override { if (_s <= 0) return 0; int r = h_net_write(_s, b, (int)n); return r < 0 ? 0 : (size_t)r; }
  using Print::write;
  int available() override {
    if (_s <= 0) return 0;
    int a = h_net_avail(_s);
    if (a <= 0) { yield(); a = h_net_avail(_s); }   // let the network deliver data (time advances in real time while waiting)
    return (a < 0 ? 0 : a) + (_pk >= 0);
  }
  int read() override { if (_pk >= 0) { int c = _pk; _pk = -1; return c; } uint8_t c; return (_s > 0 && h_net_read(_s, &c, 1) == 1) ? c : -1; }
  int read(uint8_t *b, size_t n) override {
    if (!n) return 0;
    size_t k = 0;
    if (_pk >= 0) { b[k++] = (uint8_t)_pk; _pk = -1; }
    if (_s > 0 && k < n) { int r = h_net_read(_s, b + k, (int)(n - k)); if (r > 0) k += r; }
    return k ? (int)k : -1;
  }
  int peek() override { if (_pk < 0 && _s > 0) { uint8_t c; if (h_net_read(_s, &c, 1) == 1) _pk = c; } return _pk; }
  void flush() override {}
  void stop() override { if (_s > 0) h_net_close(_s); _s = 0; _pk = -1; }
  uint8_t connected() override { if (_s <= 0) return 0; if (_pk >= 0) return 1; int a = h_net_avail(_s); if (a < 0) { _s = 0; return 0; } return 1; }
  operator bool() override { return connected(); }
  bool operator==(const WiFiClient &o) const { return _s == o._s; }
  void setTimeout(uint32_t ms) { Stream::setTimeout(ms); }
  int setNoDelay(bool) { return 0; }
  IPAddress remoteIP() { return IPAddress(0, 0, 0, 0); }
  uint16_t remotePort() { return 0; }
  int fd() const { return _s; }
protected:
  int _s = 0, _pk = -1; bool _tls = false;
};
class WiFiClientSecure : public WiFiClient {
public:
  WiFiClientSecure() { _tls = true; }
  void setInsecure() {}
  void setCACert(const char *) {}
  void setCACertBundle(const uint8_t *) {}
  void setCertificate(const char *) {}
  void setPrivateKey(const char *) {}
  void setFingerprint(const char *) {}
  void setTrustAnchors(const void *) {}
  void setBufferSizes(int, int) {}
  void setHandshakeTimeout(unsigned long) {}
  bool verify(const char *, const char *) { return true; }
  int lastError(char *buf, int n) { if (n) buf[0] = 0; return 0; }
};
typedef WiFiClient NetworkClient;
typedef WiFiClientSecure NetworkClientSecure;
namespace BearSSL { typedef WiFiClientSecure WiFiClientSecure; class X509List { public: X509List(const char *) {} }; }

// ---------------------------------------------------------------- UDP (NTP, DNS, CoAP through the gateway)
#include "Udp.h"
class WiFiUDP : public arduino::UDP {
public:
  uint8_t begin(uint16_t port) override { _local = port; if (!_s) _s = ++_next; return 1; }
  uint8_t begin(IPAddress, uint16_t port) { return begin(port); }
  void stop() override { _s = 0; }
  int beginPacket(IPAddress ip, uint16_t port) override { snprintf(_host, sizeof _host, "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]); _port = port; _olen = 0; return 1; }
  int beginPacket(const char *host, uint16_t port) override { snprintf(_host, sizeof _host, "%s", host); _port = port; _olen = 0; return 1; }
  int endPacket() override { if (!_s) begin(0); return h_udp_send(_s, _host, _port, _obuf, _olen) >= 0; }
  size_t write(uint8_t c) override { if (_olen < sizeof _obuf) _obuf[_olen++] = c; return 1; }
  size_t write(const uint8_t *b, size_t n) override { for (size_t i = 0; i < n; i++) write(b[i]); return n; }
  using Print::write;
  int parsePacket() override {
    if (!_s) return 0;
    uint8_t ip[4]; int port = 0;
    int n = h_udp_recv(_s, _ibuf, sizeof _ibuf, ip, &port);
    if (n <= 0) { yield(); n = h_udp_recv(_s, _ibuf, sizeof _ibuf, ip, &port); }
    if (n <= 0) { _ilen = _ipos = 0; return 0; }
    _ilen = n; _ipos = 0; _rip = IPAddress(ip[0], ip[1], ip[2], ip[3]); _rport = port; return n;
  }
  int available() override { return _ilen - _ipos; }
  int read() override { return _ipos < _ilen ? _ibuf[_ipos++] : -1; }
  int read(unsigned char *b, size_t n) override { size_t k = 0; while (k < n && _ipos < _ilen) b[k++] = _ibuf[_ipos++]; return (int)k; }
  int read(char *b, size_t n) override { return read((unsigned char *)b, n); }
  int peek() override { return _ipos < _ilen ? _ibuf[_ipos] : -1; }
  void flush() override {}
  IPAddress remoteIP() override { return _rip; }
  uint16_t remotePort() override { return _rport; }
private:
  int _s = 0; uint16_t _local = 0, _port = 0, _rport = 0; char _host[64] = {0};
  uint8_t _obuf[1472]; size_t _olen = 0;
  uint8_t _ibuf[1472]; int _ilen = 0, _ipos = 0; IPAddress _rip;
  static inline int _next = 1000;
};
