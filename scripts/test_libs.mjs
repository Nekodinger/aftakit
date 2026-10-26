// Bundled libraries on the Uno (avr-gcc): they compile together without duplicate symbols and behave on the simulator.
import { make, ok, done, lines, compile } from './testkit.mjs';
const run = (sim, ms) => { sim.running = true; for (let t = 0; t < ms; t += 20) sim.advance(20); };
const builds = (src, board = 'uno') => { try { compile(src, board); return true; } catch (e) { console.log(String(e.message).slice(0, 600)); return false; } };

// 1. NewPing + HC-SR04
{
  const { sim } = make([['us', 'wokwi-hc-sr04', ['VCC', 'TRIG', 'ECHO', 'GND'], {}, { distance: '80' }]],
    [['us:VCC', 'uno:5V'], ['us:GND', 'uno:GND.1'], ['us:TRIG', 'uno:12'], ['us:ECHO', 'uno:11']],
    `#include <NewPing.h>
NewPing sonar(12, 11, 200);
void setup(){ Serial.begin(115200); } void loop(){ Serial.println(sonar.ping_cm()); delay(60); }`);
  run(sim, 300);
  const v = +lines(sim).at(-1), th = Math.floor((80 * 58.2 + 28) / 57);
  ok(Math.abs(v - th) <= 1, `NewPing on Uno: ${v} cm (theory ${th})`);
}
// 2. FastLED 3.6 (AVR clockless) drives a NeoPixel
{
  const { sim, els } = make([['px', 'wokwi-neopixel', ['VDD', 'DOUT', 'VSS', 'DIN'], { r: 0, g: 0, b: 0, setPixel() {} }]],
    [['px:DIN', 'uno:6'], ['px:VDD', 'uno:5V'], ['px:VSS', 'uno:GND.1']],
    `#include <FastLED.h>
CRGB leds[1];
void setup(){ FastLED.addLeds<WS2812B, 6, GRB>(leds, 1); leds[0] = CRGB(0, 255, 64); FastLED.show(); } void loop(){ delay(50); }`);
  run(sim, 200); const e = els.get('px');
  ok(e.g > 0.95 && e.r < 0.05 && Math.abs(e.b - 64 / 255) < 0.03, `FastLED on Uno -> r=${e.r} g=${e.g} b=${(+e.b).toFixed(2)}`);
}
// 3. libraries with several public headers link once (MPU6050 + I2Cdev, U8g2 + U8x8, AccelStepper + MultiStepper)
ok(builds(`#include <Wire.h>
#include <I2Cdev.h>
#include <MPU6050.h>
MPU6050 m; void setup(){ Wire.begin(); m.initialize(); } void loop(){}`), 'ElectronicCats MPU6050 + I2Cdev link once');
ok(builds(`#include <AccelStepper.h>
#include <MultiStepper.h>
AccelStepper a(AccelStepper::DRIVER, 2, 3); MultiStepper ms; void setup(){ ms.addStepper(a); } void loop(){ a.run(); }`), 'AccelStepper + MultiStepper');
ok(builds(`#include <U8g2lib.h>
#include <Wire.h>
U8G2_SSD1306_128X64_NONAME_1_HW_I2C u8g2(U8G2_R0); void setup(){ u8g2.begin(); } void loop(){ u8g2.firstPage(); do { u8g2.setFont(u8g2_font_ncenB08_tr); u8g2.drawStr(0, 20, "Halo"); } while (u8g2.nextPage()); }`), 'U8g2 page buffer + font on Uno');
// 4. sensor libraries students use: GravityTDS, DFRobot_PH, Keypad, Stepper, BH1750, ADS1X15, ACS712, L298N, RotaryEncoder, MQUnifiedsensor
ok(builds(`#include <EEPROM.h>
#include <GravityTDS.h>
#include <DFRobot_PH.h>
#include <Keypad.h>
#include <Stepper.h>
#include <L298N.h>
#include <RotaryEncoder.h>
GravityTDS tds; DFRobot_PH ph; char keys[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}}; byte rp[4] = {9,8,7,6}, cp[4] = {5,4,3,2};
Keypad kp = Keypad(makeKeymap(keys), rp, cp, 4, 4); Stepper st(200, 8, 9, 10, 11); L298N mot(5, 6, 7); RotaryEncoder enc(A2, A3);
void setup(){ tds.setPin(A1); tds.begin(); ph.begin(); } void loop(){ tds.update(); kp.getKey(); enc.tick(); }`), 'GravityTDS + DFRobot_PH + Keypad + Stepper + L298N + RotaryEncoder');
ok(builds(`#include <Wire.h>
#include <BH1750.h>
#include <Adafruit_ADS1X15.h>
#include <ACS712.h>
#include <MQUnifiedsensor.h>
BH1750 lm; Adafruit_ADS1115 ads; ACS712 acs(A0, 5.0, 1023, 185); MQUnifiedsensor mq("Arduino UNO", 5, 10, A1, "MQ-135");
void setup(){ Wire.begin(); lm.begin(); ads.begin(); mq.init(); } void loop(){ lm.readLightLevel(); ads.readADC_SingleEnded(0); acs.mA_DC(); mq.update(); }`), 'BH1750 + ADS1115 + ACS712 + MQUnifiedsensor');
ok(builds(`#define TINY_GSM_MODEM_SIM800
#include <TinyGsmClient.h>
#include <SoftwareSerial.h>
SoftwareSerial s(7, 8); TinyGsm modem(s); void setup(){ s.begin(9600); modem.restart(); } void loop(){}`), 'TinyGSM (SIM800) on Uno');
done();
