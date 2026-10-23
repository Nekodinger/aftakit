#pragma once
// ESP32 core FS facade over the simulator SD library (SD.open / mkdir / remove / exists ...)
#include <SD.h>
namespace fs { using FS = SDLib::SDClass; }
