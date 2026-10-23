#pragma once
// byte-order helpers from lwIP (used by Blynk and other network libraries); WebAssembly is little-endian
#include <stdint.h>
#ifndef htons
#define htons(x) ((uint16_t)((((x) & 0xffu) << 8) | (((x) >> 8) & 0xffu)))
#define ntohs(x) htons(x)
#define htonl(x) ((uint32_t)((((x) & 0xffUL) << 24) | (((x) & 0xff00UL) << 8) | (((x) >> 8) & 0xff00UL) | (((x) >> 24) & 0xffUL)))
#define ntohl(x) htonl(x)
#define PP_HTONS(x) htons(x)
#define PP_HTONL(x) htonl(x)
#endif
#ifndef LWIP_MIN
#define LWIP_MIN(x, y) (((x) < (y)) ? (x) : (y))
#define LWIP_MAX(x, y) (((x) > (y)) ? (x) : (y))
#endif
