#pragma once
// WiFi for the simulator: connecting is simulated; HTTPClient uses the device's own connection and WiFiClient /
// WiFiUDP use the IoT gateway of the compile server (real TCP / TLS / UDP).
#include "Arduino.h"
#include "WiFiType.h"
#include "WiFiClient.h"
#include "WiFiServer.h"
class WiFiClass {
public:
  wl_status_t begin(const char *ssid, const char *pass = nullptr, int32_t channel = 0, const uint8_t *bssid = nullptr, bool connect = true);
  wl_status_t begin(const String &ssid, const String &pass) { return begin(ssid.c_str(), pass.c_str()); }
  wl_status_t begin() { return begin("SIM-WiFi", ""); }
  wl_status_t status();
  bool isConnected() { return status() == WL_CONNECTED; }
  bool mode(wifi_mode_t m) { _mode = m; return true; }
  wifi_mode_t getMode() { return _mode; }
  bool disconnect(bool wifioff = false, bool eraseap = false);
  bool reconnect() { return begin(_ssid.c_str(), "") != WL_CONNECT_FAILED; }
  bool setAutoReconnect(bool) { return true; }
  bool setAutoConnect(bool) { return true; }
  bool setSleep(bool) { return true; }
  bool setHostname(const char *n) { _host = n; return true; }
  const char *getHostname() { return _host.c_str(); }
  void persistent(bool) {}
  bool setTxPower(int) { return true; }
  IPAddress localIP(); IPAddress gatewayIP(); IPAddress subnetMask(); IPAddress dnsIP(uint8_t = 0);
  String macAddress(); String SSID() { return _ssid; } int32_t RSSI();
  String BSSIDstr() { return "24:A1:60:00:00:01"; }
  int32_t channel() { return 6; }
  bool config(IPAddress, IPAddress, IPAddress, IPAddress = IPAddress(), IPAddress = IPAddress()) { return true; }
  int16_t scanNetworks(bool async = false, bool hidden = false);
  String SSID(uint8_t i); int32_t RSSI(uint8_t i); uint8_t encryptionType(uint8_t i) { return i ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN; }
  void scanDelete() {}
  bool softAP(const char *ssid, const char *pass = nullptr, int ch = 1, int hidden = 0, int maxc = 4) { _ap = ssid; return true; }
  IPAddress softAPIP() { return IPAddress(192, 168, 4, 1); }
  bool softAPdisconnect(bool = false) { return true; }
  uint8_t softAPgetStationNum() { return 0; }
  int hostByName(const char *host, IPAddress &ip) { uint8_t b[4]; if (ip.fromString(host)) return 1; if (h_net_dns(host, b) != 1) return 0; ip = IPAddress(b[0], b[1], b[2], b[3]); return 1; }
private:
  String _ssid, _host = "esp32-sim", _ap; wifi_mode_t _mode = WIFI_STA; bool _scanned = false;
};
extern WiFiClass WiFi;
