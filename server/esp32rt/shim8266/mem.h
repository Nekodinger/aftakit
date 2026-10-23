#pragma once
// ESP8266 SDK header (simulator stub)
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#define os_malloc malloc
#define os_free free
#define os_zalloc(n) calloc(1, n)
