/**
 * AudioEngine — procedural sound effects using Web Audio API.
 * All sounds are generated synthetically; no external audio files required.
 */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._initialized = false;
  }

  /**
   * Lazily initialize AudioContext on first user gesture to comply with
   * browser autoplay policies.
   */
  _ensureContext() {
    if (this._initialized) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._initialized = true;
    } catch (e) {
      console.warn('AudioContext not available:', e);
      this.enabled = false;
    }
  }

  /** Play a short ascending blip when a cell is revealed. */
  playReveal() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, this.ctx.currentTime + 0.06);

    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.06);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.06);
  }

  /** Play a mechanical click when placing a flag. */
  playFlag() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    // Short noise burst
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.01);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    noise.connect(noiseGain);
    noiseGain.connect(this.ctx.destination);
    noise.start(this.ctx.currentTime);

    // Low tone
    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(200, this.ctx.currentTime);
    oscGain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);
    osc.connect(oscGain);
    oscGain.connect(this.ctx.destination);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.08);
  }

  /** Play an explosion sound — white noise with a falling lowpass filter. */
  playExplosion() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    const duration = 0.5;
    const bufferSize = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(100, this.ctx.currentTime + duration);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.8, this.ctx.currentTime);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }

  /** Play a short victory jingle: C4-E4-G4-C5. */
  playVictory() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    const notes = [261.63, 329.63, 392.00, 523.25];
    const noteDuration = 0.1;

    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime + i * noteDuration);
      gain.gain.setValueAtTime(0.0, this.ctx.currentTime + i * noteDuration);
      gain.gain.linearRampToValueAtTime(0.15, this.ctx.currentTime + i * noteDuration + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + (i + 1) * noteDuration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(this.ctx.currentTime + i * noteDuration);
      osc.stop(this.ctx.currentTime + (i + 1) * noteDuration);
    });
  }

  /** Play ascending tones during the boot sequence. */
  playBoot() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    const freqs = [220, 330, 440, 550, 660];
    freqs.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const t = this.ctx.currentTime + i * 0.12;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.1, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    });
  }

  /** Play a soft key-press tick (used during boot text animation). */
  playTick() {
    if (!this.enabled) return;
    this._ensureContext();
    if (!this.ctx) return;

    const bufferSize = Math.floor(this.ctx.sampleRate * 0.015);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize) * 0.3;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start();
  }

  /** Toggle mute/unmute. */
  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }
}
