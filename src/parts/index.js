// Registers all custom part elements that are not shipped by @wokwi/elements.
import { registerModules } from './modules.js';
import { registerBreadboards } from './breadboard.js';

export function registerParts() {
  registerModules();
  registerBreadboards();
  // LCD with PCF8574 I2C backpack: the Wokwi LCD element supports an "i2c" pin layout (GND, VCC, SDA, SCL)
  for (const [tag, baseTag] of [['x-lcd1602-i2c', 'wokwi-lcd1602'], ['x-lcd2004-i2c', 'wokwi-lcd2004']]) {
    const Base = customElements.get(baseTag);
    if (!Base || customElements.get(tag)) continue;
    customElements.define(tag, class extends Base { constructor() { super(); this.pins = 'i2c'; } });
  }
}
