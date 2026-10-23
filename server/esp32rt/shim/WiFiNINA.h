#pragma once
// WiFiNINA (Arduino Nano RP2040 Connect / Nano 33 IoT / MKR WiFi 1010) on the simulator's WiFi stack
#include "WiFi.h"
#include "WiFiClient.h"
#include "WiFiClientSecure.h"
#include "WiFiServer.h"
#include "WiFiUDP.h"
#ifndef WL_NO_MODULE
#define WL_NO_MODULE WL_NO_SHIELD
#endif
#define WIFI_FIRMWARE_LATEST_VERSION "1.5.0"
typedef WiFiClientSecure WiFiSSLClient;
