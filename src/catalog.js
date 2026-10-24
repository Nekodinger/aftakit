// Parts catalog.
//   sim: 'full'   -> drawn, wired and simulated electrically/behaviourally
//        'design' -> microcontroller board for circuit design + wiring check (code is not executed)
//        'visual' -> drawn and wireable, no behaviour
import { MODULE_SPECS } from './parts/modules.js';

const colors = ['red', 'green', 'blue', 'yellow', 'white', 'orange', 'purple', 'cyan'];
const slider = (key, label, min, max, step, def, unit = '') => ({ key, label, type: 'range', min, max, step, def, unit });

export const CATEGORIES = ['Mikrokontroler', 'Breadboard', 'Sensor', 'Input', 'Tampilan', 'Output', 'Aktuator', 'Drone', 'Komunikasi', 'Daya', 'Pasif & Dasar'];

const ESP32_DEVKIT_GPIO = {
  D13: 13, D12: 12, D14: 14, D27: 27, D26: 26, D25: 25, D33: 33, D32: 32, D35: 35, D34: 34, VN: 39, VP: 36,
  D15: 15, D2: 2, D4: 4, RX2: 16, TX2: 17, D5: 5, D18: 18, D19: 19, D21: 21, RX0: 3, TX0: 1, D22: 22, D23: 23,
};

const WOKWI = [
  // ---- boards
  { tag: 'wokwi-arduino-uno', name: 'Arduino Uno R3', cat: 'Mikrokontroler', sim: 'full', board: 'uno', mcu: 'ATmega328P', keywords: 'atmega328p uno r3 arduino', power: { '5V': 5, '3.3V': 3.3 } },
  { tag: 'wokwi-arduino-nano', name: 'Arduino Nano', cat: 'Mikrokontroler', sim: 'full', board: 'nano', mcu: 'ATmega328P', keywords: 'atmega328p nano arduino', power: { '5V': 5, '3.3V': 3.3 } },
  { tag: 'wokwi-esp32-devkit-v1', name: 'ESP32 DevKit V1 (DOIT, 30 pin)', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'esp32', board: 'esp32', mcu: 'ESP32', keywords: 'esp32 wifi bluetooth doit devkit iot', gpio: ESP32_DEVKIT_GPIO, power: { VIN: 5, '3V3': 3.3 } },
  { tag: 'wokwi-arduino-mega', name: 'Arduino Mega 2560', cat: 'Mikrokontroler', sim: 'full', board: 'mega', mcu: 'ATmega2560', keywords: 'mega 2560 arduino', power: { '5V': 5, '3.3V': 3.3 } },
  { tag: 'wokwi-nano-rp2040-connect', name: 'Arduino Nano RP2040 Connect', cat: 'Mikrokontroler', sim: 'full', runtime: 'wasm', wasm: 'nanorp2040', board: 'nanorp2040', mcu: 'RP2040', keywords: 'rp2040 nano wifi wifinina connect',
    gpio: { RX: 0, TX: 1, ...Object.fromEntries([...Array(12).keys()].map((i) => ['D' + (i + 2), i + 2])), ...Object.fromEntries([...Array(8).keys()].map((i) => ['A' + i, 14 + i])) }, power: { '3.3V': 3.3, '5V': 5, VIN: 5 } },
  { tag: 'wokwi-franzininho', name: 'Franzininho (ATtiny85)', cat: 'Mikrokontroler', sim: 'full', board: 'attiny85', mcu: 'ATtiny85', keywords: 'attiny85 digispark tiny', power: { VCC: 5 } },
  // ---- breadboards
  { tag: 'x-breadboard-half', name: 'Breadboard Half (400 lubang)', cat: 'Breadboard', sim: 'full', breadboard: true, keywords: 'breadboard projectboard protoboard' },
  { tag: 'x-breadboard-mini', name: 'Breadboard Mini (170 lubang)', cat: 'Breadboard', sim: 'full', breadboard: true, keywords: 'breadboard mini projectboard' },
  // ---- output
  { tag: 'wokwi-led', name: 'LED', cat: 'Output', sim: 'full', keywords: 'lampu diode',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: colors, def: 'red' }, { key: 'label', label: 'Label', type: 'text', def: '' }] },
  { tag: 'wokwi-rgb-led', name: 'LED RGB', cat: 'Output', sim: 'full', keywords: 'rgb',
    props: [{ key: 'common', label: 'Common', type: 'select', options: ['cathode', 'anode'], def: 'cathode' }] },
  { tag: 'wokwi-7segment', name: '7-Segment', cat: 'Tampilan', sim: 'full', keywords: 'seven segment display',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white'], def: 'red' },
      { key: 'common', label: 'Common', type: 'select', options: ['cathode', 'anode'], def: 'cathode' }] },
  { tag: 'wokwi-led-bar-graph', name: 'LED Bar Graph', cat: 'Output', sim: 'full', keywords: 'bar 10 segment',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['lime', 'red', 'orange', 'yellow', 'GYR'], def: 'lime' }] },
  { tag: 'wokwi-neopixel', name: 'NeoPixel (WS2812)', cat: 'Output', sim: 'full', keywords: 'ws2812 rgb addressable' },
  { tag: 'wokwi-led-ring', name: 'NeoPixel Ring', cat: 'Output', sim: 'full', keywords: 'ring ws2812',
    props: [{ key: 'pixels', label: 'Jumlah piksel', type: 'range', min: 4, max: 24, step: 1, def: 16 }] },
  { tag: 'wokwi-neopixel-matrix', name: 'NeoPixel Matrix 8x8', cat: 'Output', sim: 'full', keywords: 'matrix ws2812' },
  { tag: 'wokwi-buzzer', name: 'Buzzer', cat: 'Output', sim: 'full', keywords: 'piezo speaker tone alarm' },
  // ---- displays
  { tag: 'wokwi-lcd1602', name: 'LCD 16x2 (paralel)', cat: 'Tampilan', sim: 'full', keywords: 'lcd 1602 liquidcrystal',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'green' }] },
  { tag: 'x-lcd1602-i2c', name: 'LCD 16x2 I2C (PCF8574)', cat: 'Tampilan', sim: 'full', i2c: true, keywords: 'lcd i2c 1602 liquidcrystal_i2c 0x27',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'blue' }, { key: 'address', label: 'Alamat I2C', type: 'select', options: ['0x27', '0x3F'], def: '0x27' }] },
  { tag: 'wokwi-lcd2004', name: 'LCD 20x4 (paralel)', cat: 'Tampilan', sim: 'full', keywords: 'lcd 2004 liquidcrystal',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'green' }] },
  { tag: 'x-lcd2004-i2c', name: 'LCD 20x4 I2C (PCF8574)', cat: 'Tampilan', sim: 'full', i2c: true, keywords: 'lcd i2c 2004 liquidcrystal_i2c',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'blue' }, { key: 'address', label: 'Alamat I2C', type: 'select', options: ['0x27', '0x3F'], def: '0x27' }] },
  { tag: 'wokwi-ili9341', name: 'TFT ILI9341 (SPI)', cat: 'Tampilan', sim: 'full', keywords: 'tft spi lcd warna' },
  { tag: 'wokwi-ssd1306', name: 'OLED SSD1306 (SPI 7 pin)', cat: 'Tampilan', sim: 'full', keywords: 'oled spi' },
  // ---- actuators
  { tag: 'wokwi-servo', name: 'Servo Motor SG90', cat: 'Aktuator', sim: 'full', keywords: 'sg90 motor servo palang pintu',
    props: [{ key: 'horn', label: 'Horn', type: 'select', options: ['single', 'double', 'cross'], def: 'single' }] },
  { tag: 'wokwi-stepper-motor', name: 'Motor Stepper (bipolar)', cat: 'Aktuator', sim: 'full', keywords: 'nema stepper a4988 drv8825 motor langkah',
    props: [{ key: 'stepDeg', label: 'Sudut per langkah (°)', type: 'select', options: ['1.8', '0.9', '7.5', '15'], def: '1.8' }] },
  { tag: 'wokwi-ks2e-m-dc5', name: 'Relay KS2E (bare)', cat: 'Aktuator', sim: 'full', keywords: 'relay dpdt koil 5v' },
  // ---- input
  { tag: 'wokwi-pushbutton', name: 'Pushbutton', cat: 'Input', sim: 'full', keywords: 'tombol button switch',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white', 'black'], def: 'red' }] },
  { tag: 'wokwi-pushbutton-6mm', name: 'Pushbutton 6mm', cat: 'Input', sim: 'full', keywords: 'tactile tombol' },
  { tag: 'wokwi-slide-switch', name: 'Slide Switch', cat: 'Input', sim: 'full', keywords: 'saklar' },
  { tag: 'wokwi-dip-switch-8', name: 'DIP Switch 8', cat: 'Input', sim: 'full', keywords: 'dip' },
  { tag: 'wokwi-potentiometer', name: 'Potensiometer', cat: 'Input', sim: 'full', keywords: 'pot analog knob', props: [slider('value', 'Posisi', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-slide-potentiometer', name: 'Slide Potensiometer', cat: 'Input', sim: 'full', keywords: 'slider', props: [slider('value', 'Posisi', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-analog-joystick', name: 'Analog Joystick', cat: 'Input', sim: 'full', keywords: 'joystick' },
  { tag: 'wokwi-membrane-keypad', name: 'Keypad 4x4', cat: 'Input', sim: 'full', keywords: 'keypad matrix password' },
  { tag: 'wokwi-ky-040', name: 'Rotary Encoder KY-040', cat: 'Input', sim: 'full', keywords: 'encoder rotary' },
  { tag: 'wokwi-tilt-switch', name: 'Tilt Switch', cat: 'Input', sim: 'full', keywords: 'kemiringan', props: [{ key: 'tilted', label: 'Miring', type: 'bool', def: false }] },
  { tag: 'wokwi-ir-remote', name: 'IR Remote', cat: 'Input', sim: 'full', keywords: 'infrared remote nec inframerah' },
  { tag: 'wokwi-rotary-dialer', name: 'Rotary Dialer', cat: 'Input', sim: 'full', keywords: 'telepon dial pulsa' },
  // ---- sensors
  { tag: 'wokwi-hc-sr04', name: 'Ultrasonik HC-SR04', cat: 'Sensor', sim: 'full', keywords: 'jarak ultrasonic distance', outs: ['ECHO'], logic: 'vcc', props: [slider('distance', 'Jarak', 2, 400, 1, 100, ' cm')] },
  { tag: 'wokwi-dht22', name: 'DHT22 (AM2302)', cat: 'Sensor', sim: 'full', keywords: 'suhu kelembapan temperature humidity', outs: ['SDA'], logic: 'vcc',
    props: [slider('temperature', 'Suhu', -40, 80, 0.5, 28, ' °C'), slider('humidity', 'Kelembapan', 0, 100, 0.5, 65, ' %')] },
  { tag: 'wokwi-mpu6050', name: 'MPU6050 (gyro + akselerometer)', cat: 'Sensor', sim: 'full', i2c: true, keywords: 'imu gyro accelerometer gy-521 kemiringan',
    props: [slider('ax', 'Akselerasi X', -2, 2, 0.05, 0, ' g'), slider('ay', 'Akselerasi Y', -2, 2, 0.05, 0, ' g'), slider('az', 'Akselerasi Z', -2, 2, 0.05, 1, ' g'),
      slider('gx', 'Rotasi X', -250, 250, 5, 0, ' °/s'), slider('gy', 'Rotasi Y', -250, 250, 5, 0, ' °/s'), slider('gz', 'Rotasi Z', -250, 250, 5, 0, ' °/s'), slider('temp', 'Suhu chip', -10, 60, 1, 30, ' °C'),
      { key: 'drone', label: 'Bila ada frame drone', type: 'select', options: ['ikut drone', 'tidak (nilai manual)'], def: 'ikut drone' },
      { key: 'orient', label: 'Arah sumbu X chip di drone', type: 'select', options: ['ke depan', 'ke kanan', 'ke belakang', 'ke kiri'], def: 'ke depan' }] },
  { tag: 'wokwi-ds1307', name: 'RTC DS1307', cat: 'Sensor', sim: 'full', i2c: true, keywords: 'rtc clock jam waktu' },
  { tag: 'wokwi-photoresistor-sensor', name: 'LDR (modul)', cat: 'Sensor', sim: 'full', keywords: 'ldr cahaya light', outs: ['AO', 'DO'], logic: 'vcc', props: [slider('level', 'Intensitas cahaya', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-ntc-temperature-sensor', name: 'Sensor Suhu NTC', cat: 'Sensor', sim: 'full', keywords: 'thermistor temperature', outs: ['OUT'], logic: 'vcc', props: [slider('level', 'Suhu', -24, 80, 1, 24, ' °C')] },
  { tag: 'wokwi-pir-motion-sensor', name: 'Sensor Gerak PIR', cat: 'Sensor', sim: 'full', keywords: 'pir motion gerak keamanan hc-sr501', outs: ['OUT'], logic: '3.3', // HC-SR501 output is 3.3 V even on 5 V supply
    props: [{ key: 'motion', label: 'Ada gerakan', type: 'bool', def: false }] },
  { tag: 'wokwi-gas-sensor', name: 'Sensor Gas MQ-2', cat: 'Sensor', sim: 'full', keywords: 'mq2 gas smoke asap lpg', outs: ['AOUT', 'DOUT'], logic: 'vcc', props: [slider('level', 'Kadar gas', 0, 100, 1, 20, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 60, '%')] },
  { tag: 'wokwi-flame-sensor', name: 'Sensor Api', cat: 'Sensor', sim: 'full', keywords: 'flame fire kebakaran', outs: ['AOUT', 'DOUT'], logic: 'vcc', props: [slider('level', 'Intensitas api', 0, 100, 1, 0, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-big-sound-sensor', name: 'Sensor Suara (besar)', cat: 'Sensor', sim: 'full', keywords: 'sound mic suara', outs: ['AOUT', 'DOUT'], logic: 'vcc', props: [slider('level', 'Kebisingan', 0, 100, 1, 10, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-small-sound-sensor', name: 'Sensor Suara (kecil)', cat: 'Sensor', sim: 'full', keywords: 'sound mic suara', outs: ['AOUT', 'DOUT'], logic: 'vcc', props: [slider('level', 'Kebisingan', 0, 100, 1, 10, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-hx711', name: 'HX711 Load Cell Amp', cat: 'Sensor', sim: 'full', keywords: 'timbangan berat load cell', outs: ['DT'],
    props: [{ key: 'type', label: 'Kapasitas load cell', type: 'select', options: ['5kg', '50kg'], def: '5kg' }, slider('weight', 'Beban (gram)', 0, 50000, 5, 0, ' g')] },
  { tag: 'wokwi-heart-beat-sensor', name: 'Sensor Detak (KY-039)', cat: 'Sensor', sim: 'full', keywords: 'heart detak jantung pulse bpm', outs: ['OUT'], logic: 'vcc',
    props: [slider('bpm', 'Detak jantung', 40, 180, 1, 75, ' BPM')] },
  { tag: 'wokwi-ir-receiver', name: 'IR Receiver', cat: 'Sensor', sim: 'full', keywords: 'infrared remote vs1838 tsop inframerah', outs: ['DAT'], logic: 'vcc' },
  // ---- storage / comm
  { tag: 'wokwi-microsd-card', name: 'Modul MicroSD', cat: 'Komunikasi', sim: 'full', keywords: 'sd card datalogger spi kartu memori',
    props: [{ key: 'inserted', label: 'Kartu terpasang', type: 'select', options: ['ya', 'tidak'], def: 'ya' }] },
  // ---- passive
  { tag: 'wokwi-resistor', name: 'Resistor', cat: 'Pasif & Dasar', sim: 'full', keywords: 'hambatan ohm',
    props: [{ key: 'value', label: 'Nilai (Ω)', type: 'select', options: ['100', '220', '330', '470', '1000', '2200', '4700', '10000', '47000', '100000'], def: '220' }] },
  { tag: 'wokwi-biaxial-stepper', name: 'Stepper Biaxial (gauge)', cat: 'Aktuator', sim: 'full', keywords: 'gauge x27 168 jarum speedometer' },
];

const MODULES = MODULE_SPECS.map((s) => ({ tag: s.tag, name: s.name, cat: s.cat, sim: s.sim, board: s.board, mcu: s.mcu, keywords: s.keywords || '', runtime: s.runtime, wasm: s.wasm,
  props: s.props, gpio: s.gpio, power: s.power, outs: s.outs, logic: s.logic, module: true }));

export const CATALOG = [...WOKWI, ...MODULES];
export const BY_TAG = Object.fromEntries(CATALOG.map((c) => [c.tag, c]));
export const propDefaults = (tag) => Object.fromEntries((BY_TAG[tag]?.props || []).map((p) => [p.key, p.def]));
export const isRunnableBoard = (tag) => BY_TAG[tag]?.board && BY_TAG[tag].sim === 'full';
