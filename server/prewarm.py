"""Build-time warm-up: compile the Arduino cores and the libraries students use most, so the object cache is
baked into the Docker image (free instances restart often and are slow; this keeps first compiles fast)."""
import sys, time
from compiler import compile_sketch, core_objs
from compiler_wasm import compile_sketch_wasm, runtime_objs

ESP32 = {
    "iot-blynk": '''#define BLYNK_TEMPLATE_ID "T"
#define BLYNK_TEMPLATE_NAME "K"
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
void setup(){ Blynk.begin("x", "s", "p"); } void loop(){ Blynk.run(); }''',
    "iot-telegram-mqtt-thingspeak": '''#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <UniversalTelegramBot.h>
#include <PubSubClient.h>
#include <ThingSpeak.h>
WiFiClientSecure s; WiFiClient c; UniversalTelegramBot bot("1:A", s); PubSubClient m(c);
void setup(){ ThingSpeak.begin(c); m.setServer("h", 1883); } void loop(){ m.loop(); bot.getUpdates(0); }''',
    "displays-sensors": '''#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <LiquidCrystal.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <RTClib.h>
#include <ESP32Servo.h>
LiquidCrystal_I2C l(0x27,16,2); Adafruit_SSD1306 d(128,64,&Wire,-1); DHT h(4, DHT22); RTC_DS3231 r; Servo sv;
void setup(){ l.init(); d.begin(SSD1306_SWITCHCAPVCC, 0x3C); h.begin(); r.begin(); sv.attach(18); } void loop(){}''',
}
ESP32["heavy-libs"] = '''#include <U8g2lib.h>
#include <Wire.h>
#include <FastLED.h>
#include <Ticker.h>
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE); CRGB leds[8];
void setup(){ u8g2.begin(); FastLED.addLeds<WS2812B, 5, GRB>(leds, 8); } void loop(){ FastLED.show(); }'''
AVR = {
    "u8g2-fastled": '''#include <U8g2lib.h>
#include <Wire.h>
#include <FastLED.h>
U8G2_SSD1306_128X64_NONAME_1_HW_I2C u8g2(U8G2_R0); CRGB leds[8];
void setup(){ u8g2.begin(); FastLED.addLeds<WS2812B, 6, GRB>(leds, 8); } void loop(){ FastLED.show(); }''',
    "displays-sensors": '''#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <Servo.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Keypad.h>
LiquidCrystal_I2C l(0x27,16,2); Adafruit_SSD1306 d(128,64,&Wire,-1); DHT h(2, DHT22); Servo s; OneWire o(3); DallasTemperature t(&o);
void setup(){ l.init(); d.begin(SSD1306_SWITCHCAPVCC, 0x3C); h.begin(); s.attach(9); t.begin(); } void loop(){}''',
}
ESP8266 = {"esp8266-blynk": '''#define BLYNK_TEMPLATE_ID "T"
#define BLYNK_TEMPLATE_NAME "K"
#include <ESP8266WiFi.h>
#include <BlynkSimpleEsp8266.h>
void setup(){ Blynk.begin("x", "s", "p"); } void loop(){ Blynk.run(); }'''}

if __name__ == "__main__":
    t = time.time(); core_objs()
    for b in ("esp32", "esp8266", "rp2040", "nanorp2040"):
        runtime_objs(b)
    bad = 0
    for board, group in (("esp32", ESP32), ("esp8266", ESP8266)):
        for name, code in group.items():
            r = compile_sketch_wasm(code, board)
            ok = bool(r["wasm"]); bad += not ok
            print(("ok  " if ok else "FAIL"), board, name, (r["stdout"] or "").replace("\n", " | ")[:200], "" if ok else r["stderr"][:600], flush=True)
    print("AVR", "ok" if compile_sketch("void setup(){} void loop(){}")["hex"] else "FAIL")
    for name, code in AVR.items():
        r = compile_sketch(code)
        print(("ok  " if r["hex"] else "FAIL"), "uno", name, "" if r["hex"] else (r.get("stderr") or "")[:600], flush=True)
    print("AVR Mega", "ok" if compile_sketch("void setup(){} void loop(){}", "mega")["hex"] else "FAIL")
    print("ATtiny85", "ok" if compile_sketch("void setup(){} void loop(){}", "attiny85")["hex"] else "FAIL")
    print("prewarm done in %.0f s" % (time.time() - t))
    sys.exit(0)   # never fail the image build because a library index/download was unreachable
