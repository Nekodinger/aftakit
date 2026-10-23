#include "DHT.h"
bool DHT::read(bool force) {
  unsigned long now = millis();
  if (!force && !_first && now - _last < 2000) return _ok;   // like the real library: at most one reading every 2 s
  _first = false; _last = now;
  float v[2] = { NAN, NAN };
  _ok = h_dht_read(_pin, _type, v) != 0;
  if (_ok) {
    if (_type == DHT11) { _t = roundf(v[0] * 10) / 10.0f; _h = roundf(v[1]); } else { _t = roundf(v[0] * 10) / 10.0f; _h = roundf(v[1] * 10) / 10.0f; }
  }
  return _ok;
}
float DHT::computeHeatIndex(float temperature, float percentHumidity, bool isFahrenheit) {
  float hi; if (!isFahrenheit) temperature = convertCtoF(temperature);
  hi = 0.5 * (temperature + 61.0 + ((temperature - 68.0) * 1.2) + (percentHumidity * 0.094));
  if (hi > 79) {
    hi = -42.379 + 2.04901523 * temperature + 10.14333127 * percentHumidity + -0.22475541 * temperature * percentHumidity + -0.00683783 * pow(temperature, 2) + -0.05481717 * pow(percentHumidity, 2) + 0.00122874 * pow(temperature, 2) * percentHumidity + 0.00085282 * temperature * pow(percentHumidity, 2) + -0.00000199 * pow(temperature, 2) * pow(percentHumidity, 2);
    if ((percentHumidity < 13) && (temperature >= 80.0) && (temperature <= 112.0)) hi -= ((13.0 - percentHumidity) * 0.25) * sqrt((17.0 - abs(temperature - 95.0)) * 0.05882);
    else if ((percentHumidity > 85.0) && (temperature >= 80.0) && (temperature <= 87.0)) hi += ((percentHumidity - 85.0) * 0.1) * ((87.0 - temperature) * 0.2);
  }
  return isFahrenheit ? hi : convertFtoC(hi);
}
