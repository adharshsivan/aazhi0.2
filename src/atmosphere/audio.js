// Procedural weather audio (Web Audio, no assets): rain hiss and patter that
// follow rain intensity, wind roar, and thunder whose delay, pitch and length
// depend on the strike distance. Starts on the first user gesture (browser
// autoplay rules) and can be muted from the dev panel.

export class WeatherAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.7;
    const start = () => { if (this.enabled) this.init(); };
    addEventListener('pointerdown', start, { once: false, passive: true });
    addEventListener('keydown', start, { once: false });
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(ctx.destination);
    // shared 4 s noise buffers (white + brown)
    const len = ctx.sampleRate * 4;
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.white.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1;
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    const loop = (buf, filters, gain) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      let node = src;
      for (const f of filters) { node.connect(f); node = f; }
      const g = ctx.createGain(); g.gain.value = 0;
      node.connect(g); g.connect(gain || this.master);
      src.start(0, Math.random() * 3);
      return g;
    };
    const bp = (type, freq, q) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
    this.rainHiss = loop(this.white, [bp('highpass', 900, 0.5), bp('lowpass', 7000, 0.4)]);
    this.rainBody = loop(this.brown, [bp('lowpass', 900, 0.6)]);
    this.windNoise = loop(this.brown, [this.windFilter = bp('bandpass', 380, 0.7)]);
    // tornado: a deep continuous roar with a breathy upper band
    this.roarLow = loop(this.brown, [bp('lowpass', 170, 0.8)]);
    this.roarHigh = loop(this.white, [this.roarFilter = bp('bandpass', 520, 0.9)]);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.init();
    if (this.master) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.2);
  }

  update(rain, wind, roar = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const rm = 0.85 + 0.15 * Math.sin(t * 1.3) * Math.sin(t * 0.41 + 2);
    this.roarLow.gain.setTargetAtTime(Math.min(0.9, roar * 0.9 * rm), t, 0.7);
    this.roarHigh.gain.setTargetAtTime(Math.min(0.12, roar * 0.1 * rm), t, 0.7);
    this.roarFilter.frequency.setTargetAtTime(380 + roar * 300 * rm, t, 0.5);
    this.rainHiss.gain.setTargetAtTime(Math.pow(rain, 0.85) * 0.28, t, 0.5);
    this.rainBody.gain.setTargetAtTime(Math.pow(rain, 1.6) * 0.5, t, 0.6);
    const gust = 0.75 + 0.25 * Math.sin(t * 0.37) * Math.sin(t * 0.13 + 1);
    this.windNoise.gain.setTargetAtTime(Math.min(0.45, Math.max(0, wind - 0.3) * 0.12 * gust), t, 0.8);
    this.windFilter.frequency.setTargetAtTime(260 + wind * 140 * gust, t, 0.8);
  }

  /** Thunder for a strike `dist` metres away (delay = dist / 343 m/s). */
  thunder(dist) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + dist / 343;
    const near = Math.max(0, 1 - dist / 2500);
    const loud = Math.min(1, 900 / (dist + 300));
    const dur = 3 + (1 - near) * 4 + Math.random() * 2;
    const src = ctx.createBufferSource();
    src.buffer = this.brown; src.playbackRate.value = 0.6 + near * 0.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140 + near * 500; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    // rolling rumble: several swells of decreasing strength
    g.gain.setValueAtTime(0, t0);
    let t = t0;
    const swells = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < swells; i++) {
      const a = loud * (1 - i / (swells + 1)) * (0.6 + Math.random() * 0.4) * 0.9;
      t += 0.12 + Math.random() * (dur / swells);
      g.gain.linearRampToValueAtTime(a, t);
      g.gain.linearRampToValueAtTime(a * 0.35, t + 0.4 + Math.random() * 0.5);
    }
    g.gain.linearRampToValueAtTime(0, t0 + dur + 1.2);
    lp.frequency.setValueAtTime(140 + near * 500, t0);
    lp.frequency.linearRampToValueAtTime(90 + near * 120, t0 + dur);
    src.start(t0, Math.random() * 2); src.stop(t0 + dur + 1.5);
    // a sharp crack for close strikes
    if (near > 0.55) {
      const c = ctx.createBufferSource(); c.buffer = this.white;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0, t0); cg.gain.linearRampToValueAtTime(0.5 * near, t0 + 0.01); cg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.35);
      c.connect(hp); hp.connect(cg); cg.connect(this.master);
      c.start(t0); c.stop(t0 + 0.4);
    }
  }
}
