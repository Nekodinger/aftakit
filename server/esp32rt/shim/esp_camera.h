// ESP32-CAM camera driver (esp32-camera) for the simulator. esp_camera_fb_get() returns a real JPEG frame:
// the device camera / an uploaded photo when the simulator provides one, otherwise a built-in sample picture.
#pragma once
#include "Arduino.h"
#include "host.h"
#include "sim_cam_jpeg.h"
#include <stdlib.h>
#include <string.h>
typedef enum { PIXFORMAT_RGB565, PIXFORMAT_YUV422, PIXFORMAT_YUV420, PIXFORMAT_GRAYSCALE, PIXFORMAT_JPEG, PIXFORMAT_RGB888, PIXFORMAT_RAW, PIXFORMAT_RGB444, PIXFORMAT_RGB555 } pixformat_t;
typedef enum { FRAMESIZE_96X96, FRAMESIZE_QQVGA, FRAMESIZE_QCIF, FRAMESIZE_HQVGA, FRAMESIZE_240X240, FRAMESIZE_QVGA, FRAMESIZE_CIF, FRAMESIZE_HVGA, FRAMESIZE_VGA, FRAMESIZE_SVGA, FRAMESIZE_XGA, FRAMESIZE_HD, FRAMESIZE_SXGA, FRAMESIZE_UXGA, FRAMESIZE_INVALID } framesize_t;
typedef enum { CAMERA_GRAB_WHEN_EMPTY, CAMERA_GRAB_LATEST } camera_grab_mode_t;
typedef enum { CAMERA_FB_IN_PSRAM, CAMERA_FB_IN_DRAM } camera_fb_location_t;
#ifndef LEDC_CHANNEL_0
typedef enum { LEDC_CHANNEL_0, LEDC_CHANNEL_1, LEDC_CHANNEL_2, LEDC_CHANNEL_3, LEDC_CHANNEL_4, LEDC_CHANNEL_5, LEDC_CHANNEL_6, LEDC_CHANNEL_7 } ledc_channel_t;
typedef enum { LEDC_TIMER_0, LEDC_TIMER_1, LEDC_TIMER_2, LEDC_TIMER_3 } ledc_timer_t;
#endif
typedef struct {
  int pin_pwdn, pin_reset, pin_xclk;
  union { int pin_sccb_sda; int pin_sscb_sda; };
  union { int pin_sccb_scl; int pin_sscb_scl; };
  int pin_d7, pin_d6, pin_d5, pin_d4, pin_d3, pin_d2, pin_d1, pin_d0, pin_vsync, pin_href, pin_pclk;
  int xclk_freq_hz; ledc_timer_t ledc_timer; ledc_channel_t ledc_channel;
  pixformat_t pixel_format; framesize_t frame_size; int jpeg_quality; size_t fb_count;
  camera_fb_location_t fb_location; camera_grab_mode_t grab_mode; int sccb_i2c_port;
} camera_config_t;
typedef struct { uint8_t *buf; size_t len; size_t width; size_t height; pixformat_t format; struct { long tv_sec, tv_usec; } timestamp; } camera_fb_t;
typedef struct _sensor sensor_t;
typedef struct { framesize_t framesize; int quality, brightness, contrast, saturation; } camera_status_t;
struct _sensor {
  struct { uint8_t MIDH, MIDL, PID, VER; } id; camera_status_t status; pixformat_t pixformat;
  int (*set_pixformat)(sensor_t *, pixformat_t); int (*set_framesize)(sensor_t *, framesize_t);
  int (*set_contrast)(sensor_t *, int); int (*set_brightness)(sensor_t *, int); int (*set_saturation)(sensor_t *, int);
  int (*set_quality)(sensor_t *, int); int (*set_hmirror)(sensor_t *, int); int (*set_vflip)(sensor_t *, int);
  int (*set_special_effect)(sensor_t *, int); int (*set_whitebal)(sensor_t *, int); int (*set_awb_gain)(sensor_t *, int);
  int (*set_wb_mode)(sensor_t *, int); int (*set_exposure_ctrl)(sensor_t *, int); int (*set_aec2)(sensor_t *, int);
  int (*set_ae_level)(sensor_t *, int); int (*set_aec_value)(sensor_t *, int); int (*set_gain_ctrl)(sensor_t *, int);
  int (*set_agc_gain)(sensor_t *, int); int (*set_gainceiling)(sensor_t *, int); int (*set_bpc)(sensor_t *, int);
  int (*set_wpc)(sensor_t *, int); int (*set_raw_gma)(sensor_t *, int); int (*set_lenc)(sensor_t *, int);
  int (*set_dcw)(sensor_t *, int); int (*set_colorbar)(sensor_t *, int);
};
#define OV2640_PID 0x26
#define OV3660_PID 0x3660
#define OV5640_PID 0x5640
typedef int gainceiling_t;
#define GAINCEILING_2X 0
namespace simcam {
static int ok_i(sensor_t *s, int v) { (void)s; (void)v; return 0; }
static int ok_fs(sensor_t *s, framesize_t f) { s->status.framesize = f; return 0; }
static int ok_pf(sensor_t *s, pixformat_t f) { s->pixformat = f; return 0; }
static bool inited = false;
static sensor_t sensor;
static camera_fb_t fb;
static uint8_t *dyn = nullptr;
}
static inline esp_err_t esp_camera_init(const camera_config_t *c) {
  using namespace simcam;
  sensor_t &s = sensor; memset(&s, 0, sizeof s);
  s.id.PID = OV2640_PID; s.status.framesize = c->frame_size; s.pixformat = c->pixel_format;
  s.set_pixformat = ok_pf; s.set_framesize = ok_fs;
  int (**f)(sensor_t *, int) = &s.set_contrast;
  for (int i = 0; i < 23; i++) f[i] = ok_i;
  inited = true;
  const char m[] = "ESP32-CAM: kamera OV2640 tersimulasi (gambar dari kamera perangkat / foto unggahan / gambar contoh)";
  h_log(0, m, sizeof m - 1);
  return ESP_OK;
}
static inline esp_err_t esp_camera_deinit() { simcam::inited = false; return ESP_OK; }
static inline sensor_t *esp_camera_sensor_get() { return simcam::inited ? &simcam::sensor : nullptr; }
static inline camera_fb_t *esp_camera_fb_get() {
  using namespace simcam;
  if (!inited) return nullptr;
  int wh[2] = {320, 240};
  int n = h_cam_frame(nullptr, 0, wh);
  if (dyn) { free(dyn); dyn = nullptr; }
  if (n > 0 && (dyn = (uint8_t *)malloc(n)) && h_cam_frame(dyn, n, wh) == n) { fb.buf = dyn; fb.len = n; fb.width = wh[0]; fb.height = wh[1]; }
  else { fb.buf = (uint8_t *)SIM_CAM_JPEG; fb.len = sizeof SIM_CAM_JPEG; fb.width = 320; fb.height = 240; }
  fb.format = PIXFORMAT_JPEG; unsigned long us = micros(); fb.timestamp.tv_sec = us / 1000000; fb.timestamp.tv_usec = us % 1000000;
  return &fb;
}
static inline void esp_camera_fb_return(camera_fb_t *) {}
