#pragma once
// A web server running ON the simulated board cannot accept connections from the internet (the gateway is
// outgoing only, like Wokwi's public gateway). The class exists so sketches compile; it never gets clients.
#include "WiFiClient.h"
class WiFiServer {
public:
  WiFiServer(uint16_t port = 80, uint8_t = 4) : _port(port) {}
  void begin(uint16_t = 0) { const char m[] = "WiFiServer: server di ESP32 tidak bisa diakses dari internet di simulator (gateway hanya koneksi keluar)."; h_log(1, m, sizeof m - 1); }
  void begin(uint16_t, int) { begin(); }
  WiFiClient available() { return WiFiClient(); }
  WiFiClient accept() { return WiFiClient(); }
  bool hasClient() { return false; }
  void setNoDelay(bool) {}
  void end() {} void close() {} void stop() {}
  operator bool() { return true; }
private:
  uint16_t _port;
};
