// esp32-camera image converters for the simulator. JPEG decoding/encoding is done by the host (jpeg-js) and,
// like the real driver, fmt2rgb888() writes pixels in B,G,R order (see espressif/esp32-camera issue 379).
#pragma once
#include "esp_camera.h"
#include <stdlib.h>
typedef enum { JPG_SCALE_NONE, JPG_SCALE_2X, JPG_SCALE_4X, JPG_SCALE_8X } jpg_scale_t;
static inline bool fmt2rgb888(const uint8_t *src, size_t len, pixformat_t format, uint8_t *rgb) {
  if (format == PIXFORMAT_JPEG) { int wh[2]; return h_jpeg_decode(src, (int)len, rgb, 1 << 24, wh, 1) > 0; }
  if (format == PIXFORMAT_RGB888) { memcpy(rgb, src, len); return true; }
  if (format == PIXFORMAT_GRAYSCALE) { for (size_t i = 0; i < len; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = src[i]; return true; }
  if (format == PIXFORMAT_RGB565) { for (size_t i = 0; i < len / 2; i++) { uint16_t p = (src[i * 2] << 8) | src[i * 2 + 1]; rgb[i * 3] = (p & 31) << 3; rgb[i * 3 + 1] = ((p >> 5) & 63) << 2; rgb[i * 3 + 2] = (p >> 11) << 3; } return true; }
  return false;
}
static inline bool jpg2rgb565(const uint8_t *src, size_t len, uint8_t *out, jpg_scale_t) {
  int wh[2]; uint8_t *tmp = (uint8_t *)malloc(1 << 20); if (!tmp) return false;
  int n = h_jpeg_decode(src, (int)len, tmp, 1 << 20, wh, 0);
  for (int i = 0; i < n / 3; i++) { uint16_t p = ((tmp[i * 3] >> 3) << 11) | ((tmp[i * 3 + 1] >> 2) << 5) | (tmp[i * 3 + 2] >> 3); out[i * 2] = p >> 8; out[i * 2 + 1] = p & 255; }
  free(tmp); return n > 0;
}
static inline bool fmt2jpg(uint8_t *src, size_t len, uint16_t w, uint16_t h, pixformat_t format, uint8_t quality, uint8_t **out, size_t *out_len) {
  if (format == PIXFORMAT_JPEG) { *out = (uint8_t *)malloc(len); memcpy(*out, src, len); *out_len = len; return true; }
  uint8_t *rgb = (uint8_t *)malloc((size_t)w * h * 3); if (!rgb) return false;
  if (!fmt2rgb888(src, len, format, rgb)) { free(rgb); return false; }
  int n = h_jpeg_encode(rgb, w, h, quality, 1, nullptr, 0);
  *out = (uint8_t *)malloc(n); *out_len = h_jpeg_encode(rgb, w, h, quality, 1, *out, n);
  free(rgb); return *out_len > 0;
}
static inline bool frame2jpg(camera_fb_t *fb, uint8_t quality, uint8_t **out, size_t *out_len) { return fmt2jpg(fb->buf, fb->len, fb->width, fb->height, fb->format, quality, out, out_len); }
static inline bool fmt2bmp(uint8_t *, size_t, uint16_t, uint16_t, pixformat_t, uint8_t **, size_t *) { return false; }
static inline bool frame2bmp(camera_fb_t *, uint8_t **, size_t *) { return false; }
