// ESP-NOW for the simulator (see esp_now.h). Peers are bookkeeping only: every packet goes to the simulator's
// virtual partner board, which acknowledges it (status SUCCESS), and the partner's packets arrive from the ESP-NOW tab.
#include "esp_now.h"
#include "host.h"

namespace {
bool g_init = false, g_recv_v2 = false, g_send_v3 = false;
void *g_recv = nullptr, *g_send = nullptr;
esp_now_peer_info_t g_peers[ESP_NOW_MAX_TOTAL_PEER_NUM];
int g_npeers = 0;
bool g_in_poll = false;
uint8_t g_own[6];
int find_peer(const uint8_t *mac) { for (int i = 0; i < g_npeers; i++) if (!memcmp(g_peers[i].peer_addr, mac, 6)) return i; return -1; }
bool is_bcast(const uint8_t *mac) { for (int i = 0; i < 6; i++) if (mac[i] != 0xFF) return false; return true; }
void report_sent(const uint8_t *mac, esp_now_send_status_t st) {
  if (!g_send) return;
  if (g_send_v3) { wifi_tx_info_t info = { const_cast<uint8_t *>(mac), g_own, WIFI_IF_STA, nullptr }; ((esp_now_send_cb_v3_t)g_send)(&info, st); }
  else ((esp_now_send_cb_t)g_send)(mac, st);
}
}  // namespace

extern "C" void __sim_espnow_poll(void) {
  if (!g_init || g_in_poll) return;
  g_in_poll = true;
  static uint8_t buf[ESP_NOW_MAX_DATA_LEN_V2];
  uint8_t mac[6];
  for (int guard = 0; guard < 32; guard++) {
    int n = h_espnow_recv(mac, buf, sizeof buf);
    if (n < 0) break;
    if (!g_recv) continue;
    if (g_recv_v2) ((esp_now_recv_cb_v2_t)g_recv)(mac, buf, n);
    else {
      esp_now_rx_ctrl_t ctrl = {}; ctrl.rssi = -48; ctrl.channel = 1;
      esp_now_recv_info_t info = { mac, g_own, &ctrl };
      ((esp_now_recv_cb_t)g_recv)(&info, buf, n);
    }
  }
  g_in_poll = false;
}

esp_err_t esp_now_init(void) { g_init = true; g_npeers = 0; esp_wifi_get_mac(WIFI_IF_STA, g_own); h_espnow_init(1); return ESP_OK; }
esp_err_t esp_now_deinit(void) { g_init = false; g_recv = g_send = nullptr; g_npeers = 0; h_espnow_init(0); return ESP_OK; }
esp_err_t esp_now_get_version(uint32_t *v) { if (v) *v = 1; return ESP_OK; }
esp_err_t esp_now_register_recv_cb(esp_now_recv_cb_t cb) { if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT; g_recv = (void *)cb; g_recv_v2 = false; return ESP_OK; }
esp_err_t esp_now_register_recv_cb(esp_now_recv_cb_v2_t cb) { if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT; g_recv = (void *)cb; g_recv_v2 = true; return ESP_OK; }
esp_err_t esp_now_unregister_recv_cb(void) { g_recv = nullptr; return ESP_OK; }
esp_err_t esp_now_register_send_cb(esp_now_send_cb_t cb) { if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT; g_send = (void *)cb; g_send_v3 = false; return ESP_OK; }
esp_err_t esp_now_register_send_cb(esp_now_send_cb_v3_t cb) { if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT; g_send = (void *)cb; g_send_v3 = true; return ESP_OK; }
esp_err_t esp_now_unregister_send_cb(void) { g_send = nullptr; return ESP_OK; }
esp_err_t esp_now_add_peer(const esp_now_peer_info_t *p) {
  if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT;
  if (!p) return ESP_ERR_ESPNOW_ARG;
  if (find_peer(p->peer_addr) >= 0) return ESP_ERR_ESPNOW_EXIST;
  if (g_npeers >= ESP_NOW_MAX_TOTAL_PEER_NUM) return ESP_ERR_ESPNOW_FULL;
  g_peers[g_npeers++] = *p; return ESP_OK;
}
esp_err_t esp_now_del_peer(const uint8_t *mac) {
  int i = mac ? find_peer(mac) : -1; if (i < 0) return ESP_ERR_ESPNOW_NOT_FOUND;
  g_peers[i] = g_peers[--g_npeers]; return ESP_OK;
}
esp_err_t esp_now_mod_peer(const esp_now_peer_info_t *p) { int i = p ? find_peer(p->peer_addr) : -1; if (i < 0) return ESP_ERR_ESPNOW_NOT_FOUND; g_peers[i] = *p; return ESP_OK; }
esp_err_t esp_now_get_peer(const uint8_t *mac, esp_now_peer_info_t *p) { int i = mac ? find_peer(mac) : -1; if (i < 0) return ESP_ERR_ESPNOW_NOT_FOUND; if (p) *p = g_peers[i]; return ESP_OK; }
esp_err_t esp_now_fetch_peer(bool from_head, esp_now_peer_info_t *p) {
  static int it = 0; if (from_head) it = 0; if (it >= g_npeers) return ESP_ERR_ESPNOW_NOT_FOUND; if (p) *p = g_peers[it]; it++; return ESP_OK;
}
bool esp_now_is_peer_exist(const uint8_t *mac) { return mac && find_peer(mac) >= 0; }
esp_err_t esp_now_get_peer_num(esp_now_peer_num_t *n) { if (n) { n->total_num = g_npeers; n->encrypt_num = 0; for (int i = 0; i < g_npeers; i++) n->encrypt_num += g_peers[i].encrypt; } return ESP_OK; }
esp_err_t esp_now_set_pmk(const uint8_t *) { return ESP_OK; }
esp_err_t esp_now_set_wake_window(uint16_t) { return ESP_OK; }
esp_err_t esp_now_send(const uint8_t *mac, const uint8_t *data, size_t len) {
  if (!g_init) return ESP_ERR_ESPNOW_NOT_INIT;
  if (!data || len == 0 || len > ESP_NOW_MAX_DATA_LEN_V2) return ESP_ERR_ESPNOW_ARG;
  static const uint8_t zero[6] = {0};
  if (mac && !is_bcast(mac) && find_peer(mac) < 0) {
    char m[96]; snprintf(m, sizeof m, "esp_now_send: %02X:%02X:%02X:%02X:%02X:%02X belum didaftarkan dengan esp_now_add_peer()", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    h_log(1, m, (int)strlen(m)); return ESP_ERR_ESPNOW_NOT_FOUND;
  }
  const uint8_t *to = mac ? mac : (g_npeers ? g_peers[0].peer_addr : zero);
  int r = h_espnow_send(to, data, (int)len);
  report_sent(to, r == 0 ? ESP_NOW_SEND_SUCCESS : ESP_NOW_SEND_FAIL);
  return ESP_OK;
}
