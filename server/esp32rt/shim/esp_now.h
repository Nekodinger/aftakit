#pragma once
// ESP-NOW for the simulator. Packets go to / come from a virtual partner board shown in the simulator's ESP-NOW tab
// (a remote control with buttons / joystick, a packet log). Both callback styles are accepted:
//   Arduino-ESP32 2.x  void onRecv(const uint8_t *mac, const uint8_t *data, int len)
//   Arduino-ESP32 3.x  void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
//   send callback      void onSent(const uint8_t *mac, esp_now_send_status_t status)   (or const wifi_tx_info_t *)
// Callbacks run from the sketch's own thread at safe points (delay, yield, loop), like interrupts in this runtime.
#include "Arduino.h"
#include "WiFi.h"
#include "esp_wifi.h"

#define ESP_NOW_ETH_ALEN 6
#define ESP_NOW_KEY_LEN 16
#define ESP_NOW_MAX_TOTAL_PEER_NUM 20
#define ESP_NOW_MAX_ENCRYPT_PEER_NUM 6
#define ESP_NOW_MAX_DATA_LEN 250
#define ESP_NOW_MAX_DATA_LEN_V2 1470
#ifndef ESP_FAIL
#define ESP_FAIL -1
#endif
#define ESP_ERR_ESPNOW_BASE 0x3066
#define ESP_ERR_ESPNOW_NOT_INIT (ESP_ERR_ESPNOW_BASE + 1)
#define ESP_ERR_ESPNOW_ARG (ESP_ERR_ESPNOW_BASE + 2)
#define ESP_ERR_ESPNOW_NO_MEM (ESP_ERR_ESPNOW_BASE + 3)
#define ESP_ERR_ESPNOW_FULL (ESP_ERR_ESPNOW_BASE + 4)
#define ESP_ERR_ESPNOW_NOT_FOUND (ESP_ERR_ESPNOW_BASE + 5)
#define ESP_ERR_ESPNOW_INTERNAL (ESP_ERR_ESPNOW_BASE + 6)
#define ESP_ERR_ESPNOW_EXIST (ESP_ERR_ESPNOW_BASE + 7)
#define ESP_ERR_ESPNOW_IF (ESP_ERR_ESPNOW_BASE + 8)

typedef enum { ESP_NOW_SEND_SUCCESS = 0, ESP_NOW_SEND_FAIL } esp_now_send_status_t;

typedef struct esp_now_peer_info {
  uint8_t peer_addr[ESP_NOW_ETH_ALEN];
  uint8_t lmk[ESP_NOW_KEY_LEN];
  uint8_t channel;
  wifi_interface_t ifidx;
  bool encrypt;
  void *priv;
} esp_now_peer_info_t;

typedef struct esp_now_peer_num { int total_num; int encrypt_num; } esp_now_peer_num_t;

typedef struct { signed rssi : 8; unsigned rate : 5; unsigned : 1; unsigned sig_mode : 2; unsigned : 16; unsigned channel : 4; } esp_now_rx_ctrl_t;
typedef struct esp_now_recv_info {
  uint8_t *src_addr;
  uint8_t *des_addr;
  esp_now_rx_ctrl_t *rx_ctrl;
} esp_now_recv_info_t;

typedef struct wifi_tx_info { uint8_t *des_addr; uint8_t *src_addr; wifi_interface_t ifidx; void *tx_status; } wifi_tx_info_t;
typedef wifi_tx_info_t esp_now_send_info_t;

typedef void (*esp_now_recv_cb_t)(const esp_now_recv_info_t *esp_now_info, const uint8_t *data, int data_len);
typedef void (*esp_now_send_cb_t)(const uint8_t *mac_addr, esp_now_send_status_t status);
typedef void (*esp_now_recv_cb_v2_t)(const uint8_t *mac_addr, const uint8_t *data, int data_len);
typedef void (*esp_now_send_cb_v3_t)(const wifi_tx_info_t *tx_info, esp_now_send_status_t status);

esp_err_t esp_now_init(void);
esp_err_t esp_now_deinit(void);
esp_err_t esp_now_get_version(uint32_t *version);
esp_err_t esp_now_register_recv_cb(esp_now_recv_cb_t cb);
esp_err_t esp_now_register_recv_cb(esp_now_recv_cb_v2_t cb);
esp_err_t esp_now_unregister_recv_cb(void);
esp_err_t esp_now_register_send_cb(esp_now_send_cb_t cb);
esp_err_t esp_now_register_send_cb(esp_now_send_cb_v3_t cb);
esp_err_t esp_now_unregister_send_cb(void);
esp_err_t esp_now_send(const uint8_t *peer_addr, const uint8_t *data, size_t len);
esp_err_t esp_now_add_peer(const esp_now_peer_info_t *peer);
esp_err_t esp_now_del_peer(const uint8_t *peer_addr);
esp_err_t esp_now_mod_peer(const esp_now_peer_info_t *peer);
esp_err_t esp_now_get_peer(const uint8_t *peer_addr, esp_now_peer_info_t *peer);
esp_err_t esp_now_fetch_peer(bool from_head, esp_now_peer_info_t *peer);
bool esp_now_is_peer_exist(const uint8_t *peer_addr);
esp_err_t esp_now_get_peer_num(esp_now_peer_num_t *num);
esp_err_t esp_now_set_pmk(const uint8_t *pmk);
esp_err_t esp_now_set_wake_window(uint16_t window);
