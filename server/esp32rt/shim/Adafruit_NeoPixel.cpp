#include "Adafruit_NeoPixel.h"
void Adafruit_NeoPixel::show() {
  uint8_t *out = (uint8_t *)malloc(_n * 3 + 1); if (!out) return;
  for (uint16_t i = 0; i < _n; i++) {   // wire order GRB, brightness applied like the real library
    uint8_t r = (_px[i * 3] * _bright) >> 8, g = (_px[i * 3 + 1] * _bright) >> 8, b = (_px[i * 3 + 2] * _bright) >> 8;
    if ((_type & 0xff) == NEO_RGB) { out[i * 3] = r; out[i * 3 + 1] = g; } else { out[i * 3] = g; out[i * 3 + 1] = r; }
    out[i * 3 + 2] = b;
  }
  h_neopixel_show(_pin, out, _n * 3); free(out); yield();
}
uint32_t Adafruit_NeoPixel::ColorHSV(uint16_t hue, uint8_t sat, uint8_t val) {
  uint8_t r, g, b; hue = (hue * 1530L + 32768) / 65536;
  if (hue < 510) { b = 0; if (hue < 255) { r = 255; g = hue; } else { r = 510 - hue; g = 255; } }
  else if (hue < 1020) { r = 0; if (hue < 765) { g = 255; b = hue - 510; } else { g = 1020 - hue; b = 255; } }
  else if (hue < 1530) { g = 0; if (hue < 1275) { r = hue - 1020; b = 255; } else { r = 255; b = 1530 - hue; } }
  else { r = 255; g = b = 0; }
  uint32_t v1 = 1 + val; uint16_t s1 = 1 + sat; uint8_t s2 = 255 - sat;
  return ((((((r * s1) >> 8) + s2) * v1) & 0xff00) << 8) | (((((g * s1) >> 8) + s2) * v1) & 0xff00) | (((((b * s1) >> 8) + s2) * v1) >> 8);
}
