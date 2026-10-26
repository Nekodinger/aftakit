#!/bin/bash
# Vercel build: web app + everything the compile function (api/compile.py) needs, downloaded at build time so the
# GitHub repo stays small. Toolchains are trimmed to what the simulator uses (function size limit).
set -uo pipefail
ROOT=$(pwd)
log() { echo "[vercel-build] $*"; }

# ---------------------------------------------------------------- 1. toolchains -> tc/
if [ ! -x tc/avr/bin/avr-gcc ]; then
  log "toolchains"
  rm -rf tc && mkdir -p tc && cd tc
  curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz | tar xz
  curl -fsSL https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | tar xz
  curl -fsSL http://downloads.arduino.cc/tools/avr-gcc-7.3.0-atmel3.6.1-arduino7-x86_64-pc-linux-gnu.tar.bz2 | tar xj
  W=wasi-sdk-25.0-x86_64-linux; S=$W/share/wasi-sysroot
  for d in wasm32-wasi wasm32-wasi-threads wasm32-wasip1-threads wasm32-wasip2; do rm -rf $S/lib/$d $S/include/$d; done
  touch $S/include/c++/v1/.keep  # Vercel drops empty dirs; clang needs include/c++/v1 to detect libc++
  rm -rf $S/lib/wasm32-wasip1/llvm-lto $S/share; find $S/lib -name '*.so' -delete
  find $W/bin \( -type f -o -type l \) ! -name clang-19 ! -name clang ! -name clang++ ! -name lld ! -name wasm-ld ! -name llvm-cxxfilt -delete
  find $W/lib -maxdepth 1 -type l -delete; rm -rf $W/share/cmake $W/share/misc
  mv binaryen-version_123/bin/wasm-opt . && rm -rf binaryen-version_123 && mkdir -p binaryen/bin && mv wasm-opt binaryen/bin/
  G=avr/lib/gcc/avr/7.3.0
  for d in $G/*/ avr/avr/lib/*/; do case "$(basename "$d")" in avr5|include|include-fixed|ldscripts|device-specs) ;; *) rm -rf "$d";; esac; done
  rm -rf avr/share
  cd "$ROOT"
fi

# ---------------------------------------------------------------- 2. Arduino sources + ArduinoJson
log "arduino sources"
mkdir -p server/arduino-src && cd server/arduino-src
for r in arduino/ArduinoCore-avr arduino-libraries/Servo arduino-libraries/LiquidCrystal adafruit/Adafruit_NeoPixel johnrickman/LiquidCrystal_I2C \
         adafruit/Adafruit-GFX-Library adafruit/Adafruit_SSD1306 adafruit/Adafruit_BusIO adafruit/DHT-sensor-library adafruit/Adafruit_Sensor adafruit/RTClib \
         PaulStoffregen/OneWire milesburton/Arduino-Temperature-Control-Library avishorp/TM1637 bogde/HX711 \
         adafruit/Adafruit_BMP280_Library adafruit/Adafruit_BME280_Library sparkfun/SparkFun_MAX3010x_Sensor_Library \
         wayoda/LedControl MajicDesigns/MD_MAX72XX MajicDesigns/MD_Parola adafruit/Adafruit_ILI9341 arduino-libraries/SD miguelbalboa/rfid SpenceKonde/ATTinyCore nRF24/RF24 sandeepmistry/arduino-LoRa mikalhart/TinyGPSPlus Arduino-IRremote/Arduino-IRremote \
         pololu/vl53l0x-arduino adafruit/Adafruit_VL53L0X budryerson/TFMini-Plus bmellink/IBusBM adafruit/Adafruit_MPU6050 rfetick/MPU6050_light GeorgK/MQ135 miguel5612/MQSensorsLib \
         olikraus/U8g2_Arduino arduino-libraries/Stepper waspinator/AccelStepper Chris--A/Keypad mathertel/RotaryEncoder beegee-tokyo/DHTesp \
         ElectronicCats/mpu6050 DFRobot/GravityTDS DFRobot/DFRobot_PH GreenPonik/DFRobot_ESP_PH_WITH_ADC_BY_GREENPONIK GreenPonik/DFRobot_ESP_EC_BY_GREENPONIK \
         AndreaLombardo/L298N vshymanskyy/TinyGSM RobTillaart/ACS712 blynkkk/blynk-library witnessmenow/Universal-Arduino-Telegram-Bot knolleary/pubsubclient \
         mathworks/thingspeak-arduino adafruit/Adafruit_ADS1X15 claws/BH1750; do
  [ -d "$(basename $r)" ] || git clone -q --depth 1 "https://github.com/$r.git"
done
# pinned / renamed: FastLED 3.6 (AVR; the WebAssembly build uses server/esp32rt/FastLED)
[ -d FastLED ] || git clone -q --depth 1 --branch 3.6.0 https://github.com/FastLED/FastLED.git
bash ../esp32rt/fastled_sim/make.sh FastLED   # FastLED + simulator platform for the WebAssembly boards -> server/esp32rt/FastLED
# keep only what is compiled: drop documents / pictures that some libraries ship (TFMini-Plus has 16 MB of PDFs)
find . \( -iname '*.pdf' -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.zip' \) -delete 2>/dev/null || true
rm -rf TFMini-Plus/documents FastLED/docs FastLED/ci U8g2_Arduino/extras
rm -rf */.git ATTinyCore/avr/bootloaders ATTinyCore/avr/extras
# examples / docs / host-side tools are never compiled: keep the packed sources small
find . -mindepth 2 -type d \( -name examples -o -name docs -o -name extras -o -name images -o -name datasheets -o -name examples_linux \
     -o -name examples_pico -o -name examples_uno_q -o -name pyRF24 -o -name test -o -name tests \) -prune -exec rm -rf {} + 2>/dev/null || true
cd "$ROOT/server/esp32rt"
if [ ! -f ArduinoJson/src/ArduinoJson.h ]; then
  rm -rf ArduinoJson && mkdir ArduinoJson && cd ArduinoJson && git init -q \
    && git fetch -q --depth 1 https://github.com/bblanchon/ArduinoJson.git 1cd478f48e7c4cd142a0bd26ee17d63d70d04e3f \
    && git checkout -q FETCH_HEAD && rm -rf .git extras examples
fi
cd "$ROOT"

# ---------------------------------------------------------------- 3. warm object cache -> server/_cache
PY=$(command -v python3 || command -v python || true)
if [ -n "$PY" ]; then
  log "prewarm with $PY"
  rm -rf /tmp/cache
  (cd server && BUILD_CACHE=/tmp/cache USER_LIBS=/tmp/cache/user-libs ARDUINO_SRC="$ROOT/server/arduino-src" \
     WASI_SDK="$ROOT/tc/wasi-sdk-25.0-x86_64-linux" WASM_OPT="$ROOT/tc/binaryen/bin/wasm-opt" PATH="$ROOT/tc/avr/bin:$PATH" \
     COMPILE_JOBS=4 "$PY" prewarm.py) || log "prewarm failed (functions will compile on first use)"
  rm -rf server/_cache && cp -r /tmp/cache server/_cache 2>/dev/null || true
else
  log "no python: skipping prewarm"
fi
du -sh tc server/arduino-src server/_cache 2>/dev/null

# ---------------------------------------------------------------- 3b. pack for the function bundle (size limit)
# The function bundle may not exceed ~250 MB unpacked, and tc/ + the warm cache are ~380 MB. They are packed into
# gzip archives here and unpacked into /tmp on first use by api/compile.py (see _unpack there).
log "pack"
rm -rf pack && mkdir -p pack
tar -czf pack/wasi.tgz -C tc wasi-sdk-25.0-x86_64-linux binaryen
tar -czf pack/avr.tgz -C tc avr
tar -czf pack/arduino-src.tgz -C server/arduino-src .
[ -d server/_cache ] && tar -czf pack/cache.tgz -C server/_cache .
rm -rf tc server/arduino-src server/_cache
du -sh pack/* pack

# ---------------------------------------------------------------- 4. web app
log "vite build"
npx vite build
