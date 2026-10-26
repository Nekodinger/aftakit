#!/bin/bash
# Builds server/esp32rt/FastLED: FastLED 3.6 sources + a simulator platform (platforms/sim) for the WebAssembly runtime.
# Usage: bash server/esp32rt/fastled_sim/make.sh <path to FastLED repo (3.6.0)>
set -e
HERE=$(cd "$(dirname "$0")" && pwd); RT=$(dirname "$HERE"); REPO=$(cd "$1" && pwd); SRC="$REPO/src"
[ -f "$SRC/FastLED.h" ] || { echo "FastLED sources not found in $SRC"; exit 1; }
rm -rf "$RT/FastLED" && cp -r "$SRC" "$RT/FastLED" && cd "$RT/FastLED"
rm -rf platforms/arm platforms/apollo3; cp "$REPO/LICENSE" LICENSE 2>/dev/null || true
mkdir -p platforms/sim && cp "$HERE/led_sysdefs_sim.h" "$HERE/fastled_sim.h" platforms/sim/
# platform selection: the simulator first
sed -i '0,/#if defined(NRF51)/s//#if defined(SIM_WASM)\n#include "platforms\/sim\/led_sysdefs_sim.h"\n#elif defined(NRF51)/' led_sysdefs.h
sed -i '0,/#if defined(NRF51)/s//#if defined(SIM_WASM)\n#include "platforms\/sim\/fastled_sim.h"\n#elif defined(NRF51)/' platforms.h
# software SPI: no cycle-counted delays
sed -i '0,/#if defined(FASTLED_TEENSY4)/s//#if defined(FASTLED_SIM)\n\t#define CLOCK_HI_DELAY do { } while(0);\n\t#define CLOCK_LO_DELAY do { } while(0);\n#elif defined(FASTLED_TEENSY4)/' fastspi_bitbang.h
# atexit() comes from the WASI libc
sed -i 's|^extern "C" int atexit(void (\* /\*func\*/ )()) { return 0; }|#ifndef FASTLED_SIM\nextern "C" int atexit(void (* /*func*/ )()) { return 0; }\n#endif|' FastLED.cpp
grep -q SIM_WASM led_sysdefs.h && grep -q SIM_WASM platforms.h && grep -q FASTLED_SIM fastspi_bitbang.h && grep -q FASTLED_SIM FastLED.cpp && echo "FastLED simulator platform ready"
