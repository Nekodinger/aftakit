#pragma once
// Board-specific pin aliases (selected with -DSIM_BOARD_xxx by the compile server)
#if defined(SIM_BOARD_ESP8266)
#undef LED_BUILTIN
#define LED_BUILTIN 2
static const uint8_t D0 = 16, D1 = 5, D2 = 4, D3 = 0, D4 = 2, D5 = 14, D6 = 12, D7 = 13, D8 = 15, D9 = 3, D10 = 1, RX = 3, TX = 1;
static const uint8_t A0 = 17;
static const uint8_t SDA = 4, SCL = 5;
#elif defined(SIM_BOARD_RP2040)
#undef LED_BUILTIN
#define LED_BUILTIN 25
static const uint8_t A0 = 26, A1 = 27, A2 = 28;
static const uint8_t SDA = 4, SCL = 5;
#else // ESP32
static const uint8_t A0 = 36, A3 = 39, A4 = 32, A5 = 33, A6 = 34, A7 = 35, A10 = 4, A11 = 0, A12 = 2, A13 = 15, A14 = 13, A15 = 12, A16 = 14, A17 = 27, A18 = 25, A19 = 26;
static const uint8_t SDA = 21, SCL = 22, SS = 5, MOSI = 23, MISO = 19, SCK = 18, TX = 1, RX = 3;
static const uint8_t T0 = 4, T2 = 2, T3 = 15, T4 = 13, T5 = 12, T6 = 14, T7 = 27, T8 = 33, T9 = 32;
static const uint8_t DAC1 = 25, DAC2 = 26;
#endif
