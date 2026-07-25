/**
 * Procedural sound effects via the Web Audio API — no asset files. Every sound
 * is synthesized from oscillators / filtered noise, so the game stays
 * self-contained. The AudioContext is created lazily and resumed on the first
 * user gesture (browser autoplay policy).
 *
 * Purely cosmetic: never touches the sim, so it can't affect the tape/commitment.
 */
export class SoundManager {
  private ctx: AudioContext | null = null;
  muted = false;

  /** Create/resume the AudioContext (call from a user-gesture handler). */
  unlock(): void {
    const ctx = this.ac();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private ac(): AudioContext | null {
    if (this.muted) return null;
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Filtered white-noise burst (explosions, splashes, the fire whoosh). */
  private noise(duration: number, freq: number, gain: number, type: BiquadFilterType = 'lowpass'): void {
    const ctx = this.ac();
    if (!ctx) return;
    const len = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start();
  }

  /** An oscillator tone with an attack/decay envelope; optional pitch slide. */
  private tone(freq: number, duration: number, gain: number, type: OscillatorType = 'sine', when = 0, slideTo?: number): void {
    const ctx = this.ac();
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.03);
  }

  /** Big layered blast: low thump + bright crack. */
  explosion(): void {
    this.noise(0.5, 700, 0.5);
    this.noise(0.25, 180, 0.45);
  }

  /** Launch whoosh. */
  fire(): void {
    this.noise(0.2, 1100, 0.22, 'bandpass');
  }

  /** Rising blip. */
  jump(): void {
    this.tone(280, 0.16, 0.16, 'square', 0, 620);
  }

  /** Two-note chime. */
  pickup(): void {
    this.tone(660, 0.09, 0.18);
    this.tone(990, 0.14, 0.18, 'sine', 0.08);
  }

  /** Soft turn-start ping. */
  turn(): void {
    this.tone(520, 0.14, 0.1, 'triangle');
  }

  /** Water plop. */
  splash(): void {
    this.noise(0.28, 550, 0.22);
  }

  /** Ascending victory arpeggio. */
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.24, 0.18, 'triangle', i * 0.12));
  }
}
