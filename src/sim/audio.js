// Tiny WebAudio square-wave voice per buzzer. Silent until the user presses Run (browser autoplay policy).
export class Audio {
  constructor() { this.ctx = null; this.voices = new Map(); this.enabled = true; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
  }
  tone(id, freq) {
    if (!this.ctx || !this.enabled) { this.off(id); return; }
    let v = this.voices.get(id);
    if (!v) {
      const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
      osc.type = 'square'; gain.gain.value = 0.04;
      osc.connect(gain).connect(this.ctx.destination); osc.start();
      v = { osc, gain }; this.voices.set(id, v);
    }
    v.osc.frequency.setTargetAtTime(Math.min(Math.max(freq, 20), 12000), this.ctx.currentTime, 0.005);
    v.gain.gain.setTargetAtTime(0.04, this.ctx.currentTime, 0.01);
  }
  off(id) {
    const v = this.voices.get(id);
    if (v && this.ctx) v.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
  }
  stopAll() { for (const id of this.voices.keys()) this.off(id); }
}
