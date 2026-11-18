// sdkconfig.h of the simulated ESP32 (Arduino-ESP32 ships the ESP-IDF build configuration as this header).
// Only the options libraries usually test are given; the values match a classic ESP32 (ESP32-CAM has PSRAM).
#pragma once
#define CONFIG_IDF_TARGET "esp32"
#define CONFIG_IDF_TARGET_ESP32 1
#define CONFIG_IDF_FIRMWARE_CHIP_ID 0x0000
#define CONFIG_FREERTOS_HZ 1000
#define CONFIG_FREERTOS_UNICORE 0
#define CONFIG_ESP32_DEFAULT_CPU_FREQ_MHZ 240
#define CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ 240
#define CONFIG_ARDUINO_RUNNING_CORE 1
#define CONFIG_ARDUINO_EVENT_RUNNING_CORE 1
#define CONFIG_ARDUINO_LOOP_STACK_SIZE 8192
#define CONFIG_SPIRAM 1
#define CONFIG_SPIRAM_SUPPORT 1
#define CONFIG_ESP32_SPIRAM_SUPPORT 1
#define CONFIG_BT_ENABLED 1
#define CONFIG_LOG_DEFAULT_LEVEL 3
