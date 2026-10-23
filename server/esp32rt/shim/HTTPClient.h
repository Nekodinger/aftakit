#pragma once
// HTTP(S) requests are performed by the browser (real internet through the laptop / iPad connection).
#include "Arduino.h"
#include "WiFi.h"
#define HTTP_CODE_OK 200
#define HTTP_CODE_MOVED_PERMANENTLY 301
#define HTTP_CODE_FOUND 302
#define HTTP_CODE_BAD_REQUEST 400
#define HTTP_CODE_NOT_FOUND 404
#define HTTPC_ERROR_CONNECTION_REFUSED (-1)
#define HTTPC_ERROR_SEND_HEADER_FAILED (-2)
#define HTTPC_ERROR_NOT_CONNECTED (-4)
#define HTTPC_ERROR_CONNECTION_LOST (-5)
#define HTTPC_ERROR_READ_TIMEOUT (-11)
typedef enum { HTTPC_DISABLE_FOLLOW_REDIRECTS, HTTPC_STRICT_FOLLOW_REDIRECTS, HTTPC_FORCE_FOLLOW_REDIRECTS } followRedirects_t;
class HTTPClient {
public:
  bool begin(const String &url) { _url = url; _headers = ""; _resp = ""; return url.length() > 0; }
  bool begin(const char *url) { return begin(String(url)); }
  bool begin(WiFiClient &, const String &url) { return begin(url); }
  bool begin(WiFiClient &, const char *url) { return begin(String(url)); }
  bool begin(const String &host, uint16_t port, const String &uri = "/", bool https = false) { return begin(String(https ? "https://" : "http://") + host + ":" + String(port) + uri); }
  void end() { _resp = ""; }
  void addHeader(const String &name, const String &value, bool = false, bool = true) { _headers += name + ": " + value + "\n"; }
  void setTimeout(uint16_t ms) { _timeout = ms; }
  void setConnectTimeout(int32_t) {}
  void setFollowRedirects(followRedirects_t) {}
  void setReuse(bool) {}
  void setUserAgent(const String &) {}   // browsers do not allow overriding User-Agent
  void setAuthorization(const char *user, const char *pass) {}
  void setAuthorization(const char *auth) { addHeader("Authorization", String("Basic ") + auth); }
  void collectHeaders(const char *[], size_t) {}
  int GET() { return sendRequest("GET", (const uint8_t *)nullptr, 0); }
  int POST(const String &p) { return sendRequest("POST", (const uint8_t *)p.c_str(), p.length()); }
  int POST(const uint8_t *p, size_t n) { return sendRequest("POST", p, n); }
  int PUT(const String &p) { return sendRequest("PUT", (const uint8_t *)p.c_str(), p.length()); }
  int PATCH(const String &p) { return sendRequest("PATCH", (const uint8_t *)p.c_str(), p.length()); }
  int sendRequest(const char *type, const String &p) { return sendRequest(type, (const uint8_t *)p.c_str(), p.length()); }
  int sendRequest(const char *type, const uint8_t *p = nullptr, size_t n = 0);
  String getString() { return _resp; }
  int getSize() { return _resp.length(); }
  bool connected() { return false; }
  String header(const char *) { return String(); }
  String getLocation() { return String(); }
  WiFiClient &getStream() { return _client; }
  WiFiClient *getStreamPtr() { return &_client; }
  static String errorToString(int error);
private:
  String _url, _headers, _resp; uint16_t _timeout = 5000; WiFiClient _client;
};
