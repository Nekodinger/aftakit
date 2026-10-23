// AVR microcontroller profiles for the avr8js emulator: ATmega328P (Uno, Nano) and ATmega2560 (Mega).
// avr8js ships ATmega328P peripheral configs; the ATmega2560 needs its own interrupt vectors (avr8js uses word
// addresses = vector number x 2), the extra ports, timers 3/4/5 and USART1..3 (datasheet ATmega640/1280/2560 ch. 14).
import {
  timer0Config, timer1Config, timer2Config, portAConfig, portBConfig, portCConfig, portDConfig, portEConfig, portFConfig,
  portGConfig, portHConfig, portJConfig, portKConfig, portLConfig, usart0Config, adcConfig, atmega328Channels, twiConfig,
  spiConfig, eepromConfig, watchdogConfig, ADCMuxInputType, ADCReference, clockConfig, attinyTimer1Config,
} from 'avr8js';

// ------------------------------------------------------------------ ATmega328P (Arduino Uno / Nano)
const UNO_PINS = {};
for (let i = 0; i < 8; i++) UNO_PINS[String(i)] = { port: 'D', bit: i };
for (let i = 8; i <= 13; i++) UNO_PINS[String(i)] = { port: 'B', bit: i - 8 };
for (let i = 0; i < 6; i++) UNO_PINS['A' + i] = { port: 'C', bit: i, adc: i };
UNO_PINS.A6 = { port: null, bit: -1, adc: 6 };
UNO_PINS.A7 = { port: null, bit: -1, adc: 7 };

export const M328P = {
  name: 'ATmega328P', flash: 32 * 1024, sram: 2048, ext: 0, eeprom: 1024,
  pinMap: UNO_PINS,
  ports: { B: portBConfig, C: portCConfig, D: portDConfig },
  timers: [timer0Config, timer1Config, timer2Config],
  usarts: [{ config: usart0Config, rx: '0', tx: '1' }],
  adc: adcConfig, twi: twiConfig, spi: spiConfig, eepromCfg: eepromConfig, wdt: watchdogConfig,
  i2c: ['A4', 'A5'], spiPins: ['13', '11', '12'],
  // pin -> [TCCRnA, COMnx mask]: analogWrite() is active on the pin
  pwm: { 6: [0x44, 0xc0], 5: [0x44, 0x30], 9: [0x80, 0xc0], 10: [0x80, 0x30], 11: [0xb0, 0xc0], 3: [0xb0, 0x30] },
};

// ------------------------------------------------------------------ ATmega2560 (Arduino Mega 2560)
const V = (n) => n * 2;                                   // vector number -> avr8js interrupt address
const MEGA_PORTS_BY_PIN = [
  'E0', 'E1', 'E4', 'E5', 'G5', 'E3', 'H3', 'H4', 'H5', 'H6', 'B4', 'B5', 'B6', 'B7', 'J1', 'J0', 'H1', 'H0', 'D3', 'D2', 'D1', 'D0',
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'C0', 'D7', 'G2', 'G1', 'G0',
  'L7', 'L6', 'L5', 'L4', 'L3', 'L2', 'L1', 'L0', 'B3', 'B2', 'B1', 'B0',
];
const MEGA_PINS = {};
MEGA_PORTS_BY_PIN.forEach((pb, i) => { MEGA_PINS[String(i)] = { port: pb[0], bit: +pb[1] }; });
for (let i = 0; i < 8; i++) MEGA_PINS['A' + i] = { port: 'F', bit: i, adc: i };
for (let i = 0; i < 8; i++) MEGA_PINS['A' + (i + 8)] = { port: 'K', bit: i, adc: i + 8 };

const ext = (index, EICR, iscOffset, vector) => ({ EICR, EIMSK: 0x3d, EIFR: 0x3c, index, iscOffset, interrupt: V(vector) });
const pc = (PCIE, PCMSK, vector, mask, offset) => ({ PCIE, PCICR: 0x68, PCIFR: 0x3b, PCMSK, pinChangeInterrupt: V(vector), mask, offset });
const megaPorts = {
  A: { ...portAConfig, externalInterrupts: [] },
  B: { ...portBConfig, pinChange: pc(0, 0x6b, 9, 0xff, 0), externalInterrupts: [] },
  C: { ...portCConfig, pinChange: undefined, externalInterrupts: [] },
  D: { ...portDConfig, pinChange: undefined, externalInterrupts: [ext(0, 0x69, 0, 1), ext(1, 0x69, 2, 2), ext(2, 0x69, 4, 3), ext(3, 0x69, 6, 4)] },
  E: { ...portEConfig, pinChange: pc(1, 0x6c, 10, 0x01, 0), externalInterrupts: [null, null, null, null, ext(4, 0x6a, 0, 5), ext(5, 0x6a, 2, 6), ext(6, 0x6a, 4, 7), ext(7, 0x6a, 6, 8)] },
  F: { ...portFConfig, externalInterrupts: [] },
  G: { ...portGConfig, externalInterrupts: [] },
  H: { ...portHConfig, externalInterrupts: [] },
  J: { ...portJConfig, pinChange: pc(1, 0x6c, 10, 0x7f, 1), externalInterrupts: [] },
  K: { ...portKConfig, pinChange: pc(2, 0x6d, 11, 0xff, 0), externalInterrupts: [] },
  L: { ...portLConfig, externalInterrupts: [] },
};
const P = (letter) => megaPorts[letter].PORT;
const t16 = (base, TIFR, TIMSK, vCapt, oc, extClk) => ({
  ...timer1Config, captureInterrupt: V(vCapt), compAInterrupt: V(vCapt + 1), compBInterrupt: V(vCapt + 2), compCInterrupt: V(vCapt + 3), ovfInterrupt: V(vCapt + 4),
  TIFR, TIMSK, TCCRA: base, TCCRB: base + 1, TCCRC: base + 2, TCNT: base + 4, ICR: base + 6, OCRA: base + 8, OCRB: base + 10, OCRC: base + 12,
  OCFC: 8, OCIEC: 8,
  compPortA: P(oc[0][0]), compPinA: oc[0][1], compPortB: P(oc[1][0]), compPinB: oc[1][1], compPortC: P(oc[2][0]), compPinC: oc[2][1],
  externalClockPort: extClk ? P(extClk[0]) : 0, externalClockPin: extClk ? extClk[1] : 0,
});
const megaChannels = {};
for (let i = 0; i < 8; i++) { megaChannels[i] = { type: ADCMuxInputType.SingleEnded, channel: i }; megaChannels[0x20 + i] = { type: ADCMuxInputType.SingleEnded, channel: 8 + i }; }
megaChannels[0x1e] = { type: ADCMuxInputType.Constant, voltage: 1.1 };
megaChannels[0x1f] = { type: ADCMuxInputType.Constant, voltage: 0 };
const usart = (base, v) => ({ ...usart0Config, rxCompleteInterrupt: V(v), dataRegisterEmptyInterrupt: V(v + 1), txCompleteInterrupt: V(v + 2), UCSRA: base, UCSRB: base + 1, UCSRC: base + 2, UBRRL: base + 4, UBRRH: base + 5, UDR: base + 6 });

export const M2560 = {
  name: 'ATmega2560', flash: 256 * 1024, sram: 8192, ext: 0x100, eeprom: 4096,
  pinMap: MEGA_PINS,
  ports: megaPorts,
  timers: [
    { ...timer0Config, compAInterrupt: V(21), compBInterrupt: V(22), ovfInterrupt: V(23), compPortA: P('B'), compPinA: 7, compPortB: P('G'), compPinB: 5, externalClockPort: P('D'), externalClockPin: 7 },
    t16(0x80, 0x36, 0x6f, 16, [['B', 5], ['B', 6], ['B', 7]], ['D', 6]),
    { ...timer2Config, compAInterrupt: V(13), compBInterrupt: V(14), ovfInterrupt: V(15), compPortA: P('B'), compPinA: 4, compPortB: P('H'), compPinB: 6 },
    t16(0x90, 0x38, 0x71, 31, [['E', 3], ['E', 4], ['E', 5]], ['E', 6]),
    t16(0xa0, 0x39, 0x72, 41, [['H', 3], ['H', 4], ['H', 5]], ['H', 7]),
    t16(0x120, 0x3a, 0x73, 46, [['L', 3], ['L', 4], ['L', 5]], ['L', 2]),
  ],
  usarts: [
    { config: usart(0xc0, 25), rx: '0', tx: '1' }, { config: usart(0xc8, 36), rx: '19', tx: '18' },
    { config: usart(0xd0, 51), rx: '17', tx: '16' }, { config: usart(0x130, 54), rx: '15', tx: '14' },
  ],
  adc: { ...adcConfig, adcInterrupt: V(29), numChannels: 16, muxInputMask: 0x3f, muxChannels: megaChannels },
  twi: { ...twiConfig, twiInterrupt: V(39) },
  spi: { ...spiConfig, spiInterrupt: V(24) },
  eepromCfg: { ...eepromConfig, eepromReadyInterrupt: V(30) },
  wdt: { ...watchdogConfig, watchdogInterrupt: V(12) },
  i2c: ['20', '21'], spiPins: ['52', '51', '50'],
  pwm: { 13: [0x44, 0xc0], 4: [0x44, 0x30], 11: [0x80, 0xc0], 12: [0x80, 0x30], 10: [0xb0, 0xc0], 9: [0xb0, 0x30], 5: [0x90, 0xc0], 2: [0x90, 0x30], 3: [0x90, 0x0c],
    6: [0xa0, 0xc0], 7: [0xa0, 0x30], 8: [0xa0, 0x0c], 46: [0x120, 0xc0], 45: [0x120, 0x30], 44: [0x120, 0x0c] },
  links: [['SDA', '20'], ['SCL', '21']],                   // header pins that are the same signal
};

// ------------------------------------------------------------------ ATtiny85 (Franzininho / Digispark-style boards, ATTinyCore)
// 2-byte vector table (RJMP): avr8js address = vector number. PORTB only; Timer0, the special Timer1, ADC0-3, USI.
const TINY_PB = { PIN: 0x36, DDR: 0x37, PORT: 0x38,
  pinChange: { PCIE: 5, PCICR: 0x5b, PCIFR: 0x5a, PCMSK: 0x35, pinChangeInterrupt: 2, mask: 0x3f, offset: 0 },
  externalInterrupts: [null, null, { EICR: 0x55, EIMSK: 0x5b, EIFR: 0x5a, index: 6, iscOffset: 0, interrupt: 1 }] };
const TINY_PINS = {};
for (let i = 0; i < 6; i++) TINY_PINS['PB' + i] = { port: 'B', bit: i };
Object.assign(TINY_PINS.PB5, { adc: 0 }); Object.assign(TINY_PINS.PB2, { adc: 1 }); Object.assign(TINY_PINS.PB4, { adc: 2 }); Object.assign(TINY_PINS.PB3, { adc: 3 });
export const T85 = {
  name: 'ATtiny85', flash: 8192, sram: 512, ext: 0, eeprom: 512,
  pinMap: TINY_PINS,
  ports: { B: TINY_PB },
  timers: [{ ...timer0Config, compAInterrupt: 10, compBInterrupt: 11, ovfInterrupt: 5, TIFR: 0x58, OCRA: 0x49, OCRB: 0x48, TCNT: 0x52, TCCRA: 0x4a, TCCRB: 0x53, TIMSK: 0x59,
    TOV: 2, OCFA: 16, OCFB: 8, TOIE: 2, OCIEA: 16, OCIEB: 8, compPortA: 0x38, compPinA: 0, compPortB: 0x38, compPinB: 1, externalClockPort: 0x38, externalClockPin: 2 }],
  attinyTimer1: attinyTimer1Config,
  usarts: [],
  adc: { ...adcConfig, ADMUX: 0x27, ADCSRA: 0x26, ADCSRB: 0x23, ADCL: 0x24, ADCH: 0x25, DIDR0: 0x34, adcInterrupt: 8, numChannels: 4, muxInputMask: 0xf,
    muxChannels: { 0: { type: ADCMuxInputType.SingleEnded, channel: 0 }, 1: { type: ADCMuxInputType.SingleEnded, channel: 1 }, 2: { type: ADCMuxInputType.SingleEnded, channel: 2 },
      3: { type: ADCMuxInputType.SingleEnded, channel: 3 }, 12: { type: ADCMuxInputType.Constant, voltage: 1.1 }, 13: { type: ADCMuxInputType.Constant, voltage: 0 }, 15: { type: ADCMuxInputType.Temperature } },
    adcReferences: [ADCReference.AVCC, ADCReference.AREF, ADCReference.Internal1V1, ADCReference.Internal2V56] },
  twi: null, spi: null, usi: { pin: 0x36, data: 0, clock: 2 },
  eepromCfg: { ...eepromConfig, eepromReadyInterrupt: 6, EECR: 0x3c, EEDR: 0x3d, EEARL: 0x3e, EEARH: 0x3f },
  wdt: { ...watchdogConfig, watchdogInterrupt: 12, WDTCSR: 0x41 },
  clock: { ...clockConfig, CLKPR: 0x46 },
  i2c: ['PB0', 'PB2'], spiPins: ['PB2', 'PB1', 'PB0'],
  softSerialTx: 'PB0',                                        // ATTinyCore Serial: software TX on PB0 (AIN0)
  pwm: { PB0: [0x4a, 0xc0], PB1: [[0x4a, 0x30], [0x50, 0x30]], PB4: [0x4c, 0x30] },
};

export const AVR_PROFILES = { uno: M328P, nano: M328P, mega: M2560, attiny85: T85 };
