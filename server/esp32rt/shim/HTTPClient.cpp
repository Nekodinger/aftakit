#include "HTTPClient.h"
int HTTPClient::sendRequest(const char *type, const uint8_t *p, size_t n) {
  if (WiFi.status() != WL_CONNECTED) return HTTPC_ERROR_NOT_CONNECTED;
  int code = h_http(type, _url.c_str(), _headers.c_str(), p, (int)n, _timeout);
  int len = h_http_resp(nullptr, 0);
  _resp = "";
  if (len > 0) {
    char *buf = (char *)malloc(len + 1);
    if (buf) { h_http_resp((uint8_t *)buf, len); buf[len] = 0; _resp = String(buf); free(buf); }
  }
  return code;
}
String HTTPClient::errorToString(int e) {
  switch (e) {
    case HTTPC_ERROR_CONNECTION_REFUSED: return "connection refused";
    case HTTPC_ERROR_NOT_CONNECTED: return "not connected";
    case HTTPC_ERROR_CONNECTION_LOST: return "connection lost";
    case HTTPC_ERROR_READ_TIMEOUT: return "read Timeout";
    default: return "unknown error";
  }
}
