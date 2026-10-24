// Flight controller quadcopter ESP32 (mode angle) — MPU6050 + receiver iBUS + 4 ESC
// Susunan motor (props-in, tampak atas, depan di atas):
//   M4 Depan-Kiri (CW)      M1 Depan-Kanan (CCW)
//   M3 Belakang-Kiri (CCW)  M2 Belakang-Kanan (CW)
// Receiver FS-iA6B: iBUS -> RX2 (GPIO16). CH1 roll, CH2 pitch, CH3 throttle, CH4 yaw, CH5 arm (SWA).
// Remote: tab "Drone" di konsol. Turunkan throttle, nyalakan ARM, lalu naikkan throttle pelan-pelan.
#include <Wire.h>
#include <ESP32Servo.h>

const int ESC_PIN[4] = {13, 12, 14, 27};       // M1..M4
Servo esc[4];
struct Pid { float kp, ki, kd, i, prev; };      // pengendali PID (dipakai di bawah)

// ---------- receiver iBUS (32 byte: 0x20 0x40, 14 kanal little-endian, checksum)
uint16_t rc[14] = {1500, 1500, 1000, 1500, 1000, 1000};
uint8_t ib[32]; int ibn = 0; unsigned long rcTime = 0;
void readIbus() {
  while (Serial2.available()) {
    uint8_t b = Serial2.read();
    if (ibn == 0 && b != 0x20) continue;
    if (ibn == 1 && b != 0x40) { ibn = 0; continue; }
    ib[ibn++] = b;
    if (ibn == 32) {
      uint16_t sum = 0xFFFF; for (int i = 0; i < 30; i++) sum -= ib[i];
      if (sum == (ib[30] | (ib[31] << 8))) { for (int i = 0; i < 14; i++) rc[i] = ib[2 + i * 2] | (ib[3 + i * 2] << 8); rcTime = millis(); }
      ibn = 0;
    }
  }
}

// ---------- MPU6050
float gyroBias[3];
float ax, ay, az, gx, gy, gz;
void mpuWrite(uint8_t r, uint8_t v) { Wire.beginTransmission(0x68); Wire.write(r); Wire.write(v); Wire.endTransmission(); }
void mpuRead() {
  Wire.beginTransmission(0x68); Wire.write(0x3B); Wire.endTransmission(false);
  Wire.requestFrom(0x68, 14);
  int16_t v[7]; for (int i = 0; i < 7; i++) v[i] = (Wire.read() << 8) | Wire.read();
  ax = v[0] / 4096.0; ay = v[1] / 4096.0; az = v[2] / 4096.0;          // ±8 g
  gx = v[4] / 65.5 - gyroBias[0]; gy = v[5] / 65.5 - gyroBias[1]; gz = v[6] / 65.5 - gyroBias[2];   // ±500 °/s
}

// ---------- PID
float pid(Pid &p, float err, float dt, float lim) {
  p.i = constrain(p.i + p.ki * err * dt, -lim, lim);
  float d = p.kd * (err - p.prev) / dt; p.prev = err;
  return constrain(p.kp * err + p.i + d, -lim, lim);
}
Pid rateRoll = {0.6, 3.5, 0.03, 0, 0}, ratePitch = {0.6, 3.5, 0.03, 0, 0}, rateYaw = {2.0, 12, 0, 0, 0};
const float ANGLE_P = 2.0;
float roll = 0, pitch = 0;
bool armed = false;
unsigned long tLoop;

void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, 16, 17);
  for (int i = 0; i < 4; i++) { esc[i].attach(ESC_PIN[i], 1000, 2000); esc[i].writeMicroseconds(1000); }   // ESC arm: throttle minimum
  Wire.begin(); Wire.setClock(400000);
  mpuWrite(0x6B, 0x00);           // bangunkan
  mpuWrite(0x1A, 0x03);           // DLPF ~44 Hz
  mpuWrite(0x1B, 0x08);           // gyro ±500 °/s
  mpuWrite(0x1C, 0x10);           // accel ±8 g
  Serial.println("Kalibrasi gyro, jangan gerakkan drone...");
  for (int n = 0; n < 500; n++) { mpuRead(); gyroBias[0] += gx / 500; gyroBias[1] += gy / 500; gyroBias[2] += gz / 500; delay(2); }
  Serial.printf("Bias gyro: %.2f %.2f %.2f\n", gyroBias[0], gyroBias[1], gyroBias[2]);
  delay(1500);
  Serial.println("Siap. ARM dengan saklar CH5, throttle harus minimum.");
  tLoop = micros();
}

void loop() {
  const float dt = 0.004;                       // 250 Hz
  readIbus();
  mpuRead();
  // sudut dari akselerometer + gyro (complementary filter)
  float accRoll = atan2(ay, sqrt(ax * ax + az * az)) * 57.3;
  float accPitch = -atan2(ax, sqrt(ay * ay + az * az)) * 57.3;
  roll = 0.98 * (roll + gx * dt) + 0.02 * accRoll;
  pitch = 0.98 * (pitch + gy * dt) + 0.02 * accPitch;

  bool link = millis() - rcTime < 500;
  int thr = link ? rc[2] : 1000;
  if (!armed && link && rc[4] > 1500 && rc[2] < 1050) { armed = true; Serial.println("ARMED"); }
  if (armed && (!link || rc[4] < 1500)) { armed = false; Serial.println("DISARMED"); }

  // setpoint dari stick: sudut ±30°, laju yaw ±120 °/s
  float wantRoll = 0.06 * (rc[0] - 1500), wantPitch = 0.06 * (rc[1] - 1500), wantYawRate = -0.24 * (rc[3] - 1500);   // yaw kanan = searah jarum jam = gz negatif
  float rRoll = ANGLE_P * (wantRoll - roll), rPitch = ANGLE_P * (wantPitch - pitch);
  float uRoll = pid(rateRoll, rRoll - gx, dt, 400), uPitch = pid(ratePitch, rPitch - gy, dt, 400), uYaw = pid(rateYaw, wantYawRate - gz, dt, 400);

  int m[4];
  if (armed && thr > 1050) {
    thr = min(thr, 1800);
    m[0] = thr - uRoll - uPitch - uYaw;        // M1 depan-kanan  CCW
    m[1] = thr - uRoll + uPitch + uYaw;        // M2 belakang-kanan CW
    m[2] = thr + uRoll + uPitch - uYaw;        // M3 belakang-kiri CCW
    m[3] = thr + uRoll - uPitch + uYaw;        // M4 depan-kiri  CW
    for (int i = 0; i < 4; i++) m[i] = constrain(m[i], 1100, 2000);
  } else {
    for (int i = 0; i < 4; i++) m[i] = armed ? 1100 : 1000;      // idle saat armed, mati saat disarm
    rateRoll.i = ratePitch.i = rateYaw.i = 0;
  }
  for (int i = 0; i < 4; i++) esc[i].writeMicroseconds(m[i]);

  static int k = 0;
  if (++k >= 50) { k = 0; Serial.printf("R %.1f P %.1f thr %d M %d %d %d %d\n", roll, pitch, thr, m[0], m[1], m[2], m[3]); }
  while (micros() - tLoop < 4000) {}
  tLoop = micros();
}
