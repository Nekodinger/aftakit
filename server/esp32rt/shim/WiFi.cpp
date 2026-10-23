#include "WiFi.h"
WiFiClass WiFi;
wl_status_t WiFiClass::begin(const char *ssid, const char *pass, int32_t, const uint8_t *, bool) { _ssid = ssid ? ssid : ""; h_wifi_begin(ssid ? ssid : "", pass ? pass : ""); return status(); }
wl_status_t WiFiClass::status() { return (wl_status_t)h_wifi_status(); }
bool WiFiClass::disconnect(bool, bool) { h_wifi_begin("", ""); return true; }
static IPAddress info_ip(int what) { char b[32] = {0}; h_wifi_info(what, b, sizeof b); IPAddress ip; ip.fromString(b); return ip; }
IPAddress WiFiClass::localIP() { return info_ip(0); }
IPAddress WiFiClass::gatewayIP() { return info_ip(1); }
IPAddress WiFiClass::subnetMask() { return IPAddress(255, 255, 255, 0); }
IPAddress WiFiClass::dnsIP(uint8_t) { return info_ip(1); }
String WiFiClass::macAddress() { char b[32] = {0}; h_wifi_info(2, b, sizeof b); return String(b); }
int32_t WiFiClass::RSSI() { char b[16] = {0}; h_wifi_info(3, b, sizeof b); return atoi(b); }
int16_t WiFiClass::scanNetworks(bool, bool) { char b[8] = {0}; h_wifi_info(10, b, sizeof b); _scanned = true; return (int16_t)atoi(b); }
String WiFiClass::SSID(uint8_t i) { char b[40] = {0}; h_wifi_info(100 + i, b, sizeof b); return String(b); }
int32_t WiFiClass::RSSI(uint8_t i) { char b[16] = {0}; h_wifi_info(200 + i, b, sizeof b); return atoi(b); }
