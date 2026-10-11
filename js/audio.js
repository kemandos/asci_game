'use strict';
// ---------------------------------------------------------------------------
// Sound: tiny WebAudio synthesizer. Everything is generated on the fly, the
// context is created lazily on the first user gesture, and every call is
// wrapped so that a missing / blocked audio stack simply stays silent.
// ---------------------------------------------------------------------------

const Sound = {
  ctx: null,
  master: null,
  muted: false,
  _noise: null,
  _last: {},

  init() {
    try {
      if (!this._loaded) {
        this._loaded = true;
        try { this.muted = localStorage.getItem('bloodborne-ascii-muted') === '1'; } catch (e) { /* ignore */ }
      }
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 6;
        comp.attack.value = 0.003; comp.release.value = 0.2;
        comp.connect(this.ctx.destination);
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.55;
        this.master.connect(comp);
        const len = this.ctx.sampleRate;           // 1 second of white noise
        this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this._noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { this.ctx = null; }
  },

  toggle() {
    this.muted = !this.muted;
    try { localStorage.setItem('bloodborne-ascii-muted', this.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    try { if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.02); } catch (e) { /* ignore */ }
    return this.muted;
  },

  play(name) {
    try {
      if (this.muted || !this.ctx || !this.master) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const fn = SND_FX[name];
      if (!fn) return;
      // avoid machine-gun stacking of the same effect within a single frame or two
      const now = this.ctx.currentTime;
      if (this._last[name] !== undefined && now - this._last[name] < 0.035) return;
      this._last[name] = now;
      fn(this, now + 0.005);
    } catch (e) { /* stay silent */ }
  },

  // --- primitives --------------------------------------------------------
  // Oscillator with exponential decay envelope and optional pitch glide.
  tone(t, o) {
    const c = this.ctx;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f2), t + (o.glide || o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const v = o.vol === undefined ? 0.3 : o.vol, a = o.attack || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let out = g;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = o.lp;
      g.connect(f); out = f;
    }
    osc.connect(g);
    out.connect(o.dest || this.master);
    osc.start(t); osc.stop(t + o.dur + 0.05);
  },
  // Filtered noise burst with optional filter sweep.
  noise(t, o) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.filter || 'lowpass';
    f.frequency.setValueAtTime(o.f || 1000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + o.dur);
    f.Q.value = o.q || 0.8;
    const g = c.createGain();
    const v = o.vol === undefined ? 0.3 : o.vol, a = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random() * 0.5); src.stop(t + o.dur + 0.05);
  },
  // Plucked music-box note: sine fundamental + quiet bright partials, long decay.
  bell(t, f, dur, vol) {
    this.tone(t, { f, dur, vol, type: 'sine', attack: 0.003 });
    this.tone(t, { f: f * 2, dur: dur * 0.5, vol: vol * 0.35, type: 'sine', attack: 0.002 });
    this.tone(t, { f: f * 4.2, dur: dur * 0.18, vol: vol * 0.12, type: 'triangle', attack: 0.001 });
  },
};

const SND_NOTE = n => 440 * Math.pow(2, (n - 69) / 12);   // MIDI note -> Hz

// Individual effects: (sound, startTime) => void
const SND_FX = {
  swing(S, t) {
    S.noise(t, { filter: 'bandpass', f: 700, f2: 2600, q: 1.2, dur: 0.13, vol: 0.22, attack: 0.02 });
  },
  heavy(S, t) {
    S.noise(t, { filter: 'bandpass', f: 400, f2: 1600, q: 1, dur: 0.26, vol: 0.3, attack: 0.05 });
    S.tone(t, { f: 110, f2: 55, dur: 0.25, vol: 0.12, type: 'triangle' });
  },
  hit(S, t) {
    S.noise(t, { f: 1800, f2: 300, dur: 0.12, vol: 0.4 });
    S.tone(t, { f: 160, f2: 60, dur: 0.12, vol: 0.25, type: 'square', lp: 900 });
  },
  gun(S, t) {
    S.noise(t, { f: 5000, f2: 250, dur: 0.32, vol: 0.55, attack: 0.001 });
    S.tone(t, { f: 140, f2: 38, dur: 0.22, vol: 0.4, type: 'triangle' });
  },
  parry(S, t) {
    S.noise(t, { filter: 'highpass', f: 3000, dur: 0.08, vol: 0.25 });
    S.tone(t, { f: 1250, dur: 0.6, vol: 0.18, type: 'triangle' });
    S.tone(t, { f: 1873, dur: 0.45, vol: 0.12, type: 'sine' });
    S.tone(t + 0.02, { f: 2610, dur: 0.3, vol: 0.06, type: 'sine' });
  },
  visceral(S, t) {
    S.noise(t, { f: 900, f2: 120, dur: 0.5, vol: 0.5, attack: 0.01 });
    S.tone(t, { f: 90, f2: 30, dur: 0.5, vol: 0.4, type: 'sawtooth', lp: 400 });
    S.noise(t + 0.18, { filter: 'bandpass', f: 600, f2: 200, q: 3, dur: 0.35, vol: 0.3 });
  },
  hurt(S, t) {
    S.tone(t, { f: 240, f2: 90, dur: 0.22, vol: 0.28, type: 'sawtooth', lp: 1200 });
    S.noise(t, { f: 1200, f2: 300, dur: 0.15, vol: 0.25 });
  },
  dodge(S, t) {
    S.noise(t, { filter: 'bandpass', f: 1800, f2: 600, q: 0.9, dur: 0.16, vol: 0.14, attack: 0.03 });
  },
  heal(S, t) {
    S.noise(t, { filter: 'bandpass', f: 900, f2: 500, q: 4, dur: 0.12, vol: 0.12 });
    [57, 64, 69].forEach((n, i) => S.tone(t + 0.08 + i * 0.07, { f: SND_NOTE(n), dur: 0.5, vol: 0.1, type: 'sine', attack: 0.02 }));
  },
  lamp(S, t) {
    [69, 76, 81, 88].forEach((n, i) => S.bell(t + i * 0.09, SND_NOTE(n), 1.6, 0.11));
    S.noise(t, { f: 400, f2: 2000, dur: 0.6, vol: 0.08, attack: 0.2 });
  },
  death(S, t) {
    S.tone(t, { f: 110, f2: 41, glide: 1.6, dur: 2.2, vol: 0.3, type: 'sawtooth', lp: 500, attack: 0.05 });
    S.tone(t, { f: 131, f2: 49, glide: 1.6, dur: 2.2, vol: 0.2, type: 'sawtooth', lp: 450, attack: 0.05 });
    S.noise(t, { f: 300, f2: 60, dur: 1.8, vol: 0.2, attack: 0.1 });
    S.bell(t + 0.4, SND_NOTE(45), 2.5, 0.12);
  },
  boss(S, t) {
    // ominous brass swell and a low choir-like drone
    for (const [n, v] of [[33, 0.22], [40, 0.16], [45, 0.12], [48, 0.08]])
      S.tone(t, { f: SND_NOTE(n), dur: 2.6, vol: v, type: 'sawtooth', lp: 700, attack: 0.6 });
    S.tone(t + 0.9, { f: SND_NOTE(57), dur: 1.8, vol: 0.06, type: 'triangle', attack: 0.4 });
    S.noise(t, { f: 120, f2: 60, dur: 2.2, vol: 0.15, attack: 0.4 });
  },
  roar(S, t) {
    S.noise(t, { filter: 'bandpass', f: 500, f2: 180, q: 1.5, dur: 0.9, vol: 0.45, attack: 0.08 });
    S.tone(t, { f: 95, f2: 55, dur: 0.9, vol: 0.3, type: 'sawtooth', lp: 600, attack: 0.08 });
    S.tone(t, { f: 101, f2: 52, dur: 0.85, vol: 0.2, type: 'square', lp: 400, attack: 0.1 });
  },
  pickup(S, t) {
    S.tone(t, { f: SND_NOTE(81), dur: 0.12, vol: 0.12, type: 'triangle' });
    S.tone(t + 0.07, { f: SND_NOTE(88), dur: 0.25, vol: 0.1, type: 'sine' });
  },
  music(S, t) {
    // An original, slow, melancholic music-box tune in A minor (~7 s).
    const b = 0.32;   // beat length
    const mel = [
      [76, 1], [72, 1], [69, 1], [71, 2], [72, 1], [74, 1], [71, 3],
      [72, 1], [69, 1], [64, 1], [65, 2], [64, 1], [62, 1], [64, 4],
      [69, 1], [72, 1], [76, 1], [77, 2], [76, 1], [74, 1], [72, 2], [71, 1], [69, 5],
    ];
    const bass = [[45, 0], [52, 3], [41, 7], [48, 10], [40, 14], [45, 18], [41, 22], [40, 25], [45, 28]];
    let at = 0;
    for (const [n, len] of mel) {
      // tiny timing wobble like an old, tired mechanism
      S.bell(t + at * b + Math.random() * 0.012, SND_NOTE(n), Math.min(2.4, len * b * 2.2), 0.13);
      at += len;
    }
    for (const [n, beat] of bass) S.bell(t + beat * b, SND_NOTE(n + 12), 1.8, 0.05);
  },
  victory(S, t) {
    // A minor -> C major resolution, swelling
    const ch1 = [57, 60, 64, 69], ch2 = [60, 64, 67, 72];
    ch1.forEach(n => S.tone(t, { f: SND_NOTE(n), dur: 1.4, vol: 0.07, type: 'triangle', attack: 0.3 }));
    ch2.forEach(n => S.tone(t + 1.1, { f: SND_NOTE(n), dur: 2.6, vol: 0.08, type: 'triangle', attack: 0.4 }));
    S.tone(t, { f: SND_NOTE(36), dur: 3.6, vol: 0.12, type: 'sawtooth', lp: 300, attack: 0.4 });
    S.bell(t + 1.1, SND_NOTE(84), 2.2, 0.06);
  },
  menu(S, t) {
    S.tone(t, { f: 880, dur: 0.05, vol: 0.06, type: 'triangle' });
  },
  enemyAtk(S, t) {
    S.tone(t, { f: 330, f2: 220, dur: 0.12, vol: 0.08, type: 'square', lp: 1200 });
  },
  trick(S, t) {
    S.tone(t, { f: 320, dur: 0.06, vol: 0.18, type: 'square', lp: 2500 });
    S.tone(t + 0.07, { f: 950, dur: 0.18, vol: 0.12, type: 'triangle' });
    S.noise(t, { filter: 'highpass', f: 2500, dur: 0.1, vol: 0.15 });
    S.noise(t + 0.07, { filter: 'highpass', f: 3500, dur: 0.08, vol: 0.12 });
  },
  step(S, t) {
    S.noise(t, { f: 500, f2: 200, dur: 0.05, vol: 0.05 });
  },
};
