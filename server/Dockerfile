# Free deployment: Hugging Face Spaces (Docker SDK) or any Docker host (Render/Fly/Railway free tiers).
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-avr avr-libc binutils-avr git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
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
COPY compiler.py server.py ./
RUN chown -R user:user /app
USER user
ENV PORT=7860 BUILD_CACHE=/app/.cache ARDUINO_SRC=/app/arduino-src
RUN python -c "from compiler import core_objs; core_objs()"
EXPOSE 7860
CMD ["python", "server.py"]
