#pragma once
// Adafruit DHT_Unified (Adafruit_Sensor interface) on top of the simulator's DHT shim.
#include "DHT.h"
#include <Adafruit_Sensor.h>
class DHT_Unified {
public:
  DHT_Unified(uint8_t pin, uint8_t type, uint8_t count = 6, int32_t tempSensorId = -1, int32_t humiditySensorId = -1)
    : _dht(pin, type, count), _type(type), _temp(this, tempSensorId), _hum(this, humiditySensorId) {}
  void begin() { _dht.begin(); }
  class Temperature : public Adafruit_Sensor {
  public:
    Temperature(DHT_Unified *p, int32_t id) : _p(p), _id(id) {}
    bool getEvent(sensors_event_t *e) { memset(e, 0, sizeof(*e)); e->version = sizeof(*e); e->sensor_id = _id; e->type = SENSOR_TYPE_AMBIENT_TEMPERATURE; e->timestamp = millis(); e->temperature = _p->_dht.readTemperature(); return true; }
    void getSensor(sensor_t *s) { memset(s, 0, sizeof(*s)); strncpy(s->name, _p->_type == DHT11 ? "DHT11" : "DHT22", sizeof(s->name) - 1); s->version = 1; s->sensor_id = _id; s->type = SENSOR_TYPE_AMBIENT_TEMPERATURE;
      if (_p->_type == DHT11) { s->max_value = 50; s->min_value = 0; s->resolution = 2; } else { s->max_value = 125; s->min_value = -40; s->resolution = 0.1; } s->min_delay = _p->_type == DHT11 ? 1000000L : 2000000L; }
  private: DHT_Unified *_p; int32_t _id;
  };
  class Humidity : public Adafruit_Sensor {
  public:
    Humidity(DHT_Unified *p, int32_t id) : _p(p), _id(id) {}
    bool getEvent(sensors_event_t *e) { memset(e, 0, sizeof(*e)); e->version = sizeof(*e); e->sensor_id = _id; e->type = SENSOR_TYPE_RELATIVE_HUMIDITY; e->timestamp = millis(); e->relative_humidity = _p->_dht.readHumidity(); return true; }
    void getSensor(sensor_t *s) { memset(s, 0, sizeof(*s)); strncpy(s->name, _p->_type == DHT11 ? "DHT11" : "DHT22", sizeof(s->name) - 1); s->version = 1; s->sensor_id = _id; s->type = SENSOR_TYPE_RELATIVE_HUMIDITY;
      if (_p->_type == DHT11) { s->max_value = 80; s->min_value = 20; s->resolution = 5; } else { s->max_value = 100; s->min_value = 0; s->resolution = 0.1; } s->min_delay = _p->_type == DHT11 ? 1000000L : 2000000L; }
  private: DHT_Unified *_p; int32_t _id;
  };
  Temperature temperature() { return _temp; }
  Humidity humidity() { return _hum; }
private:
  DHT _dht; uint8_t _type; Temperature _temp; Humidity _hum;
  friend class Temperature; friend class Humidity;
};
