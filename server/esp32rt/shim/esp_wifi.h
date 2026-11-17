#pragma once
// The parts of the ESP-IDF WiFi driver API that Arduino sketches use around ESP-NOW (channel, MAC, power saving).
// The radio is simulated, so these only keep state or report the simulated board's values.
#include "Arduino.h"
#include "host.h"
#include "WiFi.h"

typedef enum { WIFI_IF_STA = 0, WIFI_IF_AP = 1, WIFI_IF_NAN = 2, WIFI_IF_MAX } wifi_interface_t;
#ifndef ESP_IF_WIFI_STA
#define ESP_IF_WIFI_STA WIFI_IF_STA
#define ESP_IF_WIFI_AP WIFI_IF_AP
#endif
typedef enum { WIFI_SECOND_CHAN_NONE = 0, WIFI_SECOND_CHAN_ABOVE, WIFI_SECOND_CHAN_BELOW } wifi_second_chan_t;
typedef enum { WIFI_PS_NONE = 0, WIFI_PS_MIN_MODEM, WIFI_PS_MAX_MODEM } wifi_ps_type_t;
typedef enum { WIFI_PHY_RATE_1M_L = 0, WIFI_PHY_RATE_2M_L, WIFI_PHY_RATE_11M_L = 3, WIFI_PHY_RATE_6M = 0x0B, WIFI_PHY_RATE_24M = 0x09, WIFI_PHY_RATE_54M = 0x0C, WIFI_PHY_RATE_LORA_250K = 0x29, WIFI_PHY_RATE_LORA_500K = 0x2A } wifi_phy_rate_t;
#define WIFI_PROTOCOL_11B 1
#define WIFI_PROTOCOL_11G 2
#define WIFI_PROTOCOL_11N 4
#define WIFI_PROTOCOL_LR 8

namespace simwifi { inline uint8_t &chan() { static uint8_t c = 1; return c; } }

static inline esp_err_t esp_wifi_set_channel(uint8_t primary, wifi_second_chan_t = WIFI_SECOND_CHAN_NONE) { if (primary < 1 || primary > 14) return -1; simwifi::chan() = primary; return ESP_OK; }
static inline esp_err_t esp_wifi_get_channel(uint8_t *primary, wifi_second_chan_t *second) { if (primary) *primary = simwifi::chan(); if (second) *second = WIFI_SECOND_CHAN_NONE; return ESP_OK; }
static inline esp_err_t esp_wifi_get_mac(wifi_interface_t ifx, uint8_t mac[6]) {
  char b[32] = {0}; h_wifi_info(2, b, sizeof b); unsigned v[6] = {0};
  if (sscanf(b, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return -1;
  for (int i = 0; i < 6; i++) mac[i] = (uint8_t)v[i];
  if (ifx == WIFI_IF_AP) mac[5] += 1;                       // the soft-AP MAC is the station MAC + 1, as on the chip
  return ESP_OK;
}
static inline esp_err_t esp_wifi_set_mac(wifi_interface_t, const uint8_t *) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_mode(wifi_mode_t m) { WiFi.mode(m); return ESP_OK; }
static inline esp_err_t esp_wifi_get_mode(wifi_mode_t *m) { if (m) *m = WiFi.getMode(); return ESP_OK; }
static inline esp_err_t esp_wifi_start(void) { return ESP_OK; }
static inline esp_err_t esp_wifi_stop(void) { return ESP_OK; }
static inline esp_err_t esp_wifi_disconnect(void) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_promiscuous(bool) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_ps(wifi_ps_type_t) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_protocol(wifi_interface_t, uint8_t) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_max_tx_power(int8_t) { return ESP_OK; }
static inline esp_err_t esp_wifi_config_espnow_rate(wifi_interface_t, wifi_phy_rate_t) { return ESP_OK; }
static inline esp_err_t esp_wifi_set_storage(int) { return ESP_OK; }
#ifndef WIFI_STORAGE_RAM
#define WIFI_STORAGE_RAM 1
#endif
