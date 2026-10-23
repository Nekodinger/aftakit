// Parts catalog. `sim: 'full'` = electrically + behaviourally simulated; 'visual' = drawn only.
const colors = ['red', 'green', 'blue', 'yellow', 'white', 'orange', 'purple', 'cyan'];
const slider = (key, label, min, max, step, def, unit = '') => ({ key, label, type: 'range', min, max, step, def, unit });

export const CATEGORIES = ['Board', 'Output', 'Input', 'Sensor', 'Pasif', 'Tampilan saja'];

export const CATALOG = [
  // ---- boards
  { tag: 'wokwi-arduino-uno', name: 'Arduino Uno R3', cat: 'Board', sim: 'full', board: 'uno', keywords: 'atmega328p uno r3' },
  { tag: 'wokwi-arduino-nano', name: 'Arduino Nano', cat: 'Board', sim: 'full', board: 'nano', keywords: 'atmega328p nano' },
  { tag: 'wokwi-arduino-mega', name: 'Arduino Mega 2560', cat: 'Tampilan saja', sim: 'visual', keywords: 'mega 2560' },
  { tag: 'wokwi-esp32-devkit-v1', name: 'ESP32 DevKit V1', cat: 'Tampilan saja', sim: 'visual', keywords: 'esp32 wifi' },
  { tag: 'wokwi-nano-rp2040-connect', name: 'Nano RP2040 Connect', cat: 'Tampilan saja', sim: 'visual', keywords: 'rp2040' },
  { tag: 'wokwi-franzininho', name: 'Franzininho (ATtiny85)', cat: 'Tampilan saja', sim: 'visual', keywords: 'attiny85' },
  // ---- output
  { tag: 'wokwi-led', name: 'LED', cat: 'Output', sim: 'full', keywords: 'lampu diode',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: colors, def: 'red' }, { key: 'label', label: 'Label', type: 'text', def: '' }] },
  { tag: 'wokwi-rgb-led', name: 'LED RGB', cat: 'Output', sim: 'full', keywords: 'rgb',
    props: [{ key: 'common', label: 'Common', type: 'select', options: ['cathode', 'anode'], def: 'cathode' }] },
  { tag: 'wokwi-7segment', name: '7-Segment', cat: 'Output', sim: 'full', keywords: 'seven segment display',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white'], def: 'red' },
      { key: 'common', label: 'Common', type: 'select', options: ['cathode', 'anode'], def: 'cathode' }] },
  { tag: 'wokwi-led-bar-graph', name: 'LED Bar Graph', cat: 'Output', sim: 'full', keywords: 'bar 10 segment',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['lime', 'red', 'orange', 'yellow', 'GYR'], def: 'lime' }] },
  { tag: 'wokwi-neopixel', name: 'NeoPixel (WS2812)', cat: 'Output', sim: 'full', keywords: 'ws2812 rgb addressable' },
  { tag: 'wokwi-led-ring', name: 'NeoPixel Ring', cat: 'Output', sim: 'full', keywords: 'ring ws2812',
    props: [{ key: 'pixels', label: 'Jumlah piksel', type: 'range', min: 4, max: 24, step: 1, def: 16 }] },
  { tag: 'wokwi-neopixel-matrix', name: 'NeoPixel Matrix 8x8', cat: 'Output', sim: 'full', keywords: 'matrix ws2812' },
  { tag: 'wokwi-lcd1602', name: 'LCD 16x2 (HD44780)', cat: 'Output', sim: 'full', keywords: 'lcd 1602 liquidcrystal',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'green' }] },
  { tag: 'wokwi-lcd2004', name: 'LCD 20x4 (HD44780)', cat: 'Output', sim: 'full', keywords: 'lcd 2004 liquidcrystal',
    props: [{ key: 'background', label: 'Latar', type: 'select', options: ['green', 'blue'], def: 'green' }] },
  { tag: 'wokwi-buzzer', name: 'Buzzer', cat: 'Output', sim: 'full', keywords: 'piezo speaker tone' },
  { tag: 'wokwi-servo', name: 'Servo Motor', cat: 'Output', sim: 'full', keywords: 'sg90 motor',
    props: [{ key: 'horn', label: 'Horn', type: 'select', options: ['single', 'double', 'cross'], def: 'single' }] },
  // ---- input
  { tag: 'wokwi-pushbutton', name: 'Pushbutton', cat: 'Input', sim: 'full', keywords: 'tombol button switch',
    props: [{ key: 'color', label: 'Warna', type: 'select', options: ['red', 'green', 'blue', 'yellow', 'white', 'black'], def: 'red' }] },
  { tag: 'wokwi-pushbutton-6mm', name: 'Pushbutton 6mm', cat: 'Input', sim: 'full', keywords: 'tactile' },
  { tag: 'wokwi-slide-switch', name: 'Slide Switch', cat: 'Input', sim: 'full', keywords: 'saklar' },
  { tag: 'wokwi-dip-switch-8', name: 'DIP Switch 8', cat: 'Input', sim: 'full', keywords: 'dip' },
  { tag: 'wokwi-potentiometer', name: 'Potensiometer', cat: 'Input', sim: 'full', keywords: 'pot analog knob',
    props: [slider('value', 'Posisi', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-slide-potentiometer', name: 'Slide Potensiometer', cat: 'Input', sim: 'full', keywords: 'slider',
    props: [slider('value', 'Posisi', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-analog-joystick', name: 'Analog Joystick', cat: 'Input', sim: 'full', keywords: 'joystick' },
  { tag: 'wokwi-membrane-keypad', name: 'Keypad 4x4', cat: 'Input', sim: 'full', keywords: 'keypad matrix' },
  { tag: 'wokwi-ky-040', name: 'Rotary Encoder KY-040', cat: 'Input', sim: 'full', keywords: 'encoder rotary' },
  { tag: 'wokwi-tilt-switch', name: 'Tilt Switch', cat: 'Input', sim: 'full', keywords: 'kemiringan',
    props: [{ key: 'tilted', label: 'Miring', type: 'bool', def: false }] },
  // ---- sensors
  { tag: 'wokwi-hc-sr04', name: 'Ultrasonik HC-SR04', cat: 'Sensor', sim: 'full', keywords: 'jarak ultrasonic distance',
    props: [slider('distance', 'Jarak', 2, 400, 1, 100, ' cm')] },
  { tag: 'wokwi-photoresistor-sensor', name: 'LDR (Photoresistor)', cat: 'Sensor', sim: 'full', keywords: 'ldr cahaya light',
    props: [slider('level', 'Intensitas cahaya', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-ntc-temperature-sensor', name: 'Sensor Suhu NTC', cat: 'Sensor', sim: 'full', keywords: 'thermistor temperature',
    props: [slider('level', 'Suhu', -24, 80, 1, 24, ' °C')] },
  { tag: 'wokwi-pir-motion-sensor', name: 'Sensor Gerak PIR', cat: 'Sensor', sim: 'full', keywords: 'pir motion gerak',
    props: [{ key: 'motion', label: 'Ada gerakan', type: 'bool', def: false }] },
  { tag: 'wokwi-gas-sensor', name: 'Sensor Gas MQ', cat: 'Sensor', sim: 'full', keywords: 'mq2 gas smoke',
    props: [slider('level', 'Kadar gas', 0, 100, 1, 20, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 60, '%')] },
  { tag: 'wokwi-flame-sensor', name: 'Sensor Api', cat: 'Sensor', sim: 'full', keywords: 'flame fire',
    props: [slider('level', 'Intensitas api', 0, 100, 1, 0, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-big-sound-sensor', name: 'Sensor Suara (besar)', cat: 'Sensor', sim: 'full', keywords: 'sound mic',
    props: [slider('level', 'Kebisingan', 0, 100, 1, 10, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  { tag: 'wokwi-small-sound-sensor', name: 'Sensor Suara (kecil)', cat: 'Sensor', sim: 'full', keywords: 'sound mic',
    props: [slider('level', 'Kebisingan', 0, 100, 1, 10, '%'), slider('threshold', 'Ambang DO', 0, 100, 1, 50, '%')] },
  // ---- passive
  { tag: 'wokwi-resistor', name: 'Resistor', cat: 'Pasif', sim: 'full', keywords: 'hambatan ohm',
    props: [{ key: 'value', label: 'Nilai (Ω)', type: 'select', options: ['100', '220', '330', '470', '1000', '2200', '4700', '10000', '47000', '100000'], def: '220' }] },
  // ---- visual only (drawn, not simulated)
  { tag: 'wokwi-ssd1306', name: 'OLED SSD1306', cat: 'Tampilan saja', sim: 'visual', keywords: 'oled i2c' },
  { tag: 'wokwi-ili9341', name: 'TFT ILI9341', cat: 'Tampilan saja', sim: 'visual', keywords: 'tft spi' },
  { tag: 'wokwi-dht22', name: 'DHT22', cat: 'Tampilan saja', sim: 'visual', keywords: 'suhu kelembapan' },
  { tag: 'wokwi-mpu6050', name: 'MPU6050', cat: 'Tampilan saja', sim: 'visual', keywords: 'imu gyro accelerometer' },
  { tag: 'wokwi-ds1307', name: 'RTC DS1307', cat: 'Tampilan saja', sim: 'visual', keywords: 'rtc clock' },
  { tag: 'wokwi-hx711', name: 'HX711 Load Cell Amp', cat: 'Tampilan saja', sim: 'visual', keywords: 'timbangan' },
  { tag: 'wokwi-heart-beat-sensor', name: 'Sensor Detak Jantung', cat: 'Tampilan saja', sim: 'visual', keywords: 'heart' },
  { tag: 'wokwi-ir-receiver', name: 'IR Receiver', cat: 'Tampilan saja', sim: 'visual', keywords: 'infrared' },
  { tag: 'wokwi-ir-remote', name: 'IR Remote', cat: 'Tampilan saja', sim: 'visual', keywords: 'infrared remote' },
  { tag: 'wokwi-microsd-card', name: 'MicroSD Card', cat: 'Tampilan saja', sim: 'visual', keywords: 'sd card' },
  { tag: 'wokwi-stepper-motor', name: 'Stepper Motor', cat: 'Tampilan saja', sim: 'visual', keywords: 'nema' },
  { tag: 'wokwi-biaxial-stepper', name: 'Stepper Biaxial', cat: 'Tampilan saja', sim: 'visual', keywords: 'gauge' },
  { tag: 'wokwi-rotary-dialer', name: 'Rotary Dialer', cat: 'Tampilan saja', sim: 'visual', keywords: 'telepon' },
  { tag: 'wokwi-ks2e-m-dc5', name: 'Relay KS2E', cat: 'Tampilan saja', sim: 'visual', keywords: 'relay' },
];

export const BY_TAG = Object.fromEntries(CATALOG.map((c) => [c.tag, c]));
export const propDefaults = (tag) => Object.fromEntries((BY_TAG[tag]?.props || []).map((p) => [p.key, p.def]));
