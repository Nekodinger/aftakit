#include "Wire.h"
TwoWire Wire(0), Wire1(1);
bool TwoWire::begin(int sda, int scl, uint32_t) {
  if (sda >= 0) _sda = sda; if (scl >= 0) _scl = scl;
  if (_sda < 0) _sda = SDA; if (_scl < 0) _scl = SCL;
  h_i2c_begin(_sda, _scl); return true;
}
uint8_t TwoWire::endTransmission(bool stop) {
  if (_sda < 0) begin();
  int r = h_i2c_tx(_addr, _txBuf, (int)_txLen, stop ? 1 : 0); _txLen = 0; _tx = false; return (uint8_t)r;
}
size_t TwoWire::requestFrom(uint16_t addr, size_t len, bool) {
  if (_sda < 0) begin();
  if (len > I2C_BUFFER_LENGTH) len = I2C_BUFFER_LENGTH;
  int n = h_i2c_rx(addr, _rxBuf, (int)len); _rxLen = n < 0 ? 0 : n; _rxPos = 0; return _rxLen;
}
