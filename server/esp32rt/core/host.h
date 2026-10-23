// Imports provided by the browser simulator (module "ard"). Pin numbers are GPIO numbers of the board.
#pragma once
#include <stdint.h>
#define ARD_IMPORT(n) __attribute__((import_module("ard"), import_name(#n)))
#ifdef __cplusplus
extern "C" {
#endif
ARD_IMPORT(pin_mode) void h_pin_mode(int pin, int mode);
ARD_IMPORT(digital_write) void h_digital_write(int pin, int val);
ARD_IMPORT(digital_read) int h_digital_read(int pin);
ARD_IMPORT(analog_mv) int h_analog_mv(int pin);                    // pin voltage in millivolts (-1 = not an ADC pin)
ARD_IMPORT(pwm_write) void h_pwm_write(int pin, double duty, double freq); // duty 0..1, duty<0 = detach
ARD_IMPORT(tone) void h_tone(int pin, double freq, double dur_ms);
ARD_IMPORT(now_us) double h_now_us();
ARD_IMPORT(delay_us) void h_delay_us(double us);                   // async: suspends the sketch
ARD_IMPORT(yield_) void h_yield(void);                             // async: lets the browser/simulation run
ARD_IMPORT(serial_write) void h_serial_write(int port, const uint8_t *p, int n);
ARD_IMPORT(serial_available) int h_serial_available(int port);
ARD_IMPORT(serial_read) int h_serial_read(int port);
ARD_IMPORT(serial_begin) void h_serial_begin(int port, int baud);
ARD_IMPORT(i2c_begin) void h_i2c_begin(int sda, int scl);
ARD_IMPORT(i2c_tx) int h_i2c_tx(int addr, const uint8_t *p, int n, int stop);
ARD_IMPORT(i2c_rx) int h_i2c_rx(int addr, uint8_t *p, int n);
ARD_IMPORT(dht_read) int h_dht_read(int pin, int type, float *out2);
ARD_IMPORT(pulse_in) double h_pulse_in(int pin, int state, double timeout_us);
ARD_IMPORT(servo_write) void h_servo_write(int pin, double us);
ARD_IMPORT(neopixel_show) void h_neopixel_show(int pin, const uint8_t *grb, int nbytes);
ARD_IMPORT(irq_attach) void h_irq_attach(int pin, int mode);
ARD_IMPORT(irq_poll) int h_irq_poll(int *pin_count_pairs, int max_pairs);
ARD_IMPORT(wifi_begin) void h_wifi_begin(const char *ssid, const char *pass);
ARD_IMPORT(wifi_status) int h_wifi_status(void);
ARD_IMPORT(wifi_info) int h_wifi_info(int what, char *out, int cap);
ARD_IMPORT(http) int h_http(const char *method, const char *url, const char *headers, const uint8_t *body, int blen, int timeout_ms); // async
ARD_IMPORT(http_resp) int h_http_resp(uint8_t *out, int cap);
ARD_IMPORT(bt_begin) void h_bt_begin(const char *name);
ARD_IMPORT(bt_write) void h_bt_write(const uint8_t *p, int n);
ARD_IMPORT(bt_available) int h_bt_available(void);
ARD_IMPORT(bt_read) int h_bt_read(void);
ARD_IMPORT(random32) uint32_t h_random32(void);
ARD_IMPORT(log) void h_log(int level, const char *p, int n);
ARD_IMPORT(cam_frame) int h_cam_frame(uint8_t *out, int cap, int *wh);    // latest camera JPEG from the browser; 0 = none
// IoT gateway sockets (real TCP / TLS / UDP through the compile server's WebSocket gateway)
ARD_IMPORT(net_open) int h_net_open(const char *host, int port, int tls);            // async; >0 socket id, <0 error
ARD_IMPORT(net_write) int h_net_write(int s, const uint8_t *p, int n);
ARD_IMPORT(net_avail) int h_net_avail(int s);                                         // -1 = closed and drained
ARD_IMPORT(net_read) int h_net_read(int s, uint8_t *p, int n);
ARD_IMPORT(net_close) void h_net_close(int s);
ARD_IMPORT(net_dns) int h_net_dns(const char *host, uint8_t *ip4);                    // async; 1 ok
ARD_IMPORT(udp_send) int h_udp_send(int s, const char *host, int port, const uint8_t *p, int n);
ARD_IMPORT(udp_recv) int h_udp_recv(int s, uint8_t *p, int cap, uint8_t *ip4, int *port);
ARD_IMPORT(wall_ms) double h_wall_ms(void);                                           // real clock (ms since 1970)
ARD_IMPORT(jpeg_decode) int h_jpeg_decode(const uint8_t *src, int len, uint8_t *out, int cap, int *wh, int bgr); // -> bytes written
ARD_IMPORT(jpeg_encode) int h_jpeg_encode(const uint8_t *rgb, int w, int h, int quality, int bgr, uint8_t *out, int cap); // cap 0 = size only
ARD_IMPORT(nvs) int h_nvs(int op, const char *key, uint8_t *buf, int len);  // op 0=get 1=put 2=remove 3=clear
#ifdef __cplusplus
}
#endif
