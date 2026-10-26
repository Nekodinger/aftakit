#pragma once
#define FASTLED_HAS_CLOCKLESS 1
#include "fastpin.h"
#include "fastspi.h"
#include "host.h"
FASTLED_NAMESPACE_BEGIN
// Clockless chipsets (WS2812/NeoPixel, SK6812, WS2811, ...): the bytes are sent in wire order (after colour-order
// reordering, brightness scaling and dithering), exactly what the data line would carry.
template <int DATA_PIN, int T1, int T2, int T3, EOrder RGB_ORDER = RGB, int XTRA0 = 0, bool FLIP = false, int WAIT_TIME = 5>
class ClocklessController : public CPixelLEDController<RGB_ORDER> {
public:
  virtual void init() { pinMode(DATA_PIN, OUTPUT); }
  virtual uint16_t getMaxRefreshRate() const { return 400; }
protected:
  virtual void showPixels(PixelController<RGB_ORDER> &pixels) {
    int n = pixels.size();
    uint8_t *buf = (uint8_t *)malloc(n > 0 ? n * 3 : 1), *p = buf;
    pixels.preStepFirstByteDithering();
    while (pixels.has(1)) {
      pixels.stepDithering();
      *p++ = pixels.loadAndScale0(); *p++ = pixels.loadAndScale1(); *p++ = pixels.loadAndScale2();
      pixels.advanceData();
    }
    h_neopixel_show(DATA_PIN, buf, (int)(p - buf));
    free(buf);
    delayMicroseconds(n * 30 + 50);                    // 30 µs per LED on the wire + latch
  }
};
FASTLED_NAMESPACE_END
