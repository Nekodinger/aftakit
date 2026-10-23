# Free deployment: Render (free web service, Docker) or any Docker host. Render: Root Directory = server.
# Compiles Arduino Uno/Nano sketches (avr-gcc) and ESP32 / ESP8266 / Pico sketches (WebAssembly, wasi-sdk),
# downloads Arduino libraries on demand, and runs the IoT network gateway (WebSocket /net) for WiFiClient.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-avr avr-libc binutils-avr git ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# WebAssembly toolchain: wasi-sdk 25 (clang) + binaryen 123 (wasm-opt, Asyncify)
RUN mkdir -p /opt/wasi && cd /opt/wasi \
 && curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz | tar xz \
 && curl -fsSL https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz | tar xz \
 && rm -rf wasi-sdk-25.0-x86_64-linux/share/wasi-sysroot/lib/wasm32-wasip2 wasi-sdk-25.0-x86_64-linux/share/wasi-sysroot/lib/wasm32-wasip1-threads
RUN pip install --no-cache-dir aiohttp==3.14.5
RUN useradd -m -u 1000 user
WORKDIR /app
RUN mkdir -p arduino-src && cd arduino-src \
 && git clone --depth 1 https://github.com/arduino/ArduinoCore-avr.git \
 && git clone --depth 1 https://github.com/arduino-libraries/Servo.git \
 && git clone --depth 1 https://github.com/arduino-libraries/LiquidCrystal.git \
 && git clone --depth 1 https://github.com/adafruit/Adafruit_NeoPixel.git \
 && git clone --depth 1 https://github.com/johnrickman/LiquidCrystal_I2C.git \
 && git clone --depth 1 https://github.com/adafruit/Adafruit-GFX-Library.git \
 && git clone --depth 1 https://github.com/adafruit/Adafruit_SSD1306.git \
 && git clone --depth 1 https://github.com/adafruit/Adafruit_BusIO.git \
 && git clone --depth 1 https://github.com/adafruit/DHT-sensor-library.git \
 && git clone --depth 1 https://github.com/adafruit/Adafruit_Sensor.git \
 && git clone --depth 1 https://github.com/adafruit/RTClib.git \
 && rm -rf */.git
COPY compiler.py compiler_wasm.py libmgr.py server.py prewarm.py ./
COPY esp32rt ./esp32rt
# ArduinoJson 7.x at the exact commit the simulator runtime was tested with
RUN mkdir -p esp32rt/ArduinoJson && cd esp32rt/ArduinoJson && git init -q \
 && git fetch -q --depth 1 https://github.com/bblanchon/ArduinoJson.git 1cd478f48e7c4cd142a0bd26ee17d63d70d04e3f \
 && git checkout -q FETCH_HEAD && rm -rf .git extras examples
RUN chown -R user:user /app
USER user
ENV PORT=7860 BUILD_CACHE=/app/.cache ARDUINO_SRC=/app/arduino-src \
    WASI_SDK=/opt/wasi/wasi-sdk-25.0-x86_64-linux WASM_OPT=/opt/wasi/binaryen-version_123/bin/wasm-opt
# bake the compiled cores + popular libraries (Blynk, MQTT, Telegram, ThingSpeak, LCD, OLED, DHT…) into the image
RUN COMPILE_JOBS=4 python prewarm.py
# small free instances (512 MB): one clang at a time, one compile at a time (others wait in a queue)
ENV COMPILE_JOBS=1 COMPILE_CONCURRENCY=1
EXPOSE 7860
CMD ["python", "server.py"]
