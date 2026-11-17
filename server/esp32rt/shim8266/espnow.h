#pragma once
// ESP8266 ESP-NOW API (espnow.h of the ESP8266 Arduino core) on top of the simulator's ESP-NOW (../shim/esp_now.cpp).
#include "Arduino.h"
#include "../shim/esp_now.h"
#ifndef u8
typedef uint8_t u8;
#endif
#define ESP_NOW_ROLE_IDLE 0
#define ESP_NOW_ROLE_CONTROLLER 1
#define ESP_NOW_ROLE_SLAVE 2
#define ESP_NOW_ROLE_COMBO 3
#define ESP_NOW_ROLE_MAX 4
typedef void (*esp8266_now_recv_cb_t)(u8 *mac_addr, u8 *data, u8 len);
typedef void (*esp8266_now_send_cb_t)(u8 *mac_addr, u8 status);
static inline int esp_now_set_self_role(u8) { return 0; }
static inline u8 esp_now_get_self_role(void) { return ESP_NOW_ROLE_COMBO; }
static inline int esp_now_register_recv_cb(esp8266_now_recv_cb_t cb) { return esp_now_register_recv_cb((esp_now_recv_cb_v2_t)(void *)cb); }
static inline int esp_now_register_send_cb(esp8266_now_send_cb_t cb) { return esp_now_register_send_cb((esp_now_send_cb_t)(void *)cb); }
static inline int esp_now_add_peer(u8 *mac, u8 role, u8 channel, u8 *key, u8 key_len) {
  esp_now_peer_info_t p = {}; memcpy(p.peer_addr, mac, 6); p.channel = channel; p.encrypt = key && key_len; return esp_now_add_peer(&p) == ESP_OK || esp_now_is_peer_exist(mac) ? 0 : -1;
}
static inline int esp_now_send(u8 *da, u8 *data, int len) {
  static u8 bc[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  if (!da) da = bc;                                           // NULL = every peer in the list (the virtual partner here)
  if (!esp_now_is_peer_exist(da) && memcmp(da, bc, 6)) { esp_now_peer_info_t p = {}; memcpy(p.peer_addr, da, 6); esp_now_add_peer(&p); }
  return esp_now_send((const uint8_t *)da, (const uint8_t *)data, (size_t)len) == ESP_OK ? 0 : -1;
}
static inline int esp_now_del_peer(u8 *mac) { return esp_now_del_peer((const uint8_t *)mac) == ESP_OK ? 0 : -1; }
static inline int esp_now_is_peer_exist(u8 *mac) { return esp_now_is_peer_exist((const uint8_t *)mac) ? 1 : 0; }
static inline int esp_now_set_peer_role(u8 *, u8) { return 0; }
static inline int esp_now_set_peer_channel(u8 *, u8) { return 0; }
static inline int esp_now_set_kok(u8 *, u8) { return 0; }
