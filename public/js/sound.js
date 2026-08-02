// Sound engine: everything synthesized with Web Audio — zero audio assets.
// Lazy-initialized on first user gesture (autoplay policy).

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('scorch_sound') !== 'off';
    this.musicOn = localStorage.getItem('scorch_music') !== 'off';
    this._noiseBuf = null;
    this._musicTimer = null;
    this._windGain = null;
    this._whistle = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(this.ctx.destination);
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.music = this.ctx.createGain();
    this.music.gain.value = 0.11;
    this.music.connect(this.master);
    // gentle master compressor to tame explosion stacks
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    this.master.disconnect();
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.startWind();
    if (this.musicOn) this.startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  noiseBuffer() {
    if (this._noiseBuf) return this._noiseBuf;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;
    return buf;
  }

  env(gainNode, t0, peak, attack, decay, curve = 'exp') {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    if (curve === 'exp') g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    else g.linearRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  // ---- SFX ----
  thump(t, f0, f1, vol, dur = 0.22) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.8);
    const g = this.ctx.createGain();
    this.env(g, t, vol, 0.005, dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.08);
  }

  whoosh(t, f0, f1, vol, dur = 0.3, q = 1.2) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.85);
    f.Q.value = q;
    const ng = this.ctx.createGain();
    this.env(ng, t, vol, 0.02, dur);
    n.connect(f); f.connect(ng); ng.connect(this.sfx);
    n.start(t); n.stop(t + dur + 0.1);
  }

  // every weapon family launches with its own voice
  fire(weapon = 'missile', power = 50) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    switch (weapon) {
      case 'baby_missile':
        this.thump(t, 240, 70, 0.4, 0.14);
        this.whoosh(t, 1300, 2600 + power * 10, 0.16, 0.22);
        break;
      case 'baby_nuke': case 'nuke': case 'deaths_head': {
        // ominous heavy launch with a low horn
        this.thump(t, 85, 30, 0.85, 0.35);
        this.whoosh(t, 500, 1400, 0.3, 0.5, 0.8);
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(55, t);
        o.frequency.linearRampToValueAtTime(48, t + 0.6);
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 240;
        const g = this.ctx.createGain();
        this.env(g, t, 0.22, 0.05, 0.65, 'lin');
        o.connect(f); f.connect(g); g.connect(this.sfx);
        o.start(t); o.stop(t + 0.8);
        break;
      }
      case 'mirv':
        // double kick — one bird, many warheads
        this.thump(t, 150, 45, 0.55, 0.18);
        this.thump(t + 0.09, 200, 60, 0.4, 0.14);
        this.whoosh(t, 900, 2600, 0.22, 0.3);
        break;
      case 'homing_missile': {
        this.thump(t, 160, 50, 0.5, 0.18);
        // electronic lock-on chirp
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(900, t + 0.05);
        o.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
        const g = this.ctx.createGain();
        this.env(g, t + 0.05, 0.06, 0.01, 0.32);
        o.connect(g); g.connect(this.sfx);
        o.start(t + 0.05); o.stop(t + 0.45);
        break;
      }
      case 'roller': case 'heavy_roller':
        // mortar clunk, no scream
        this.thump(t, 95, 40, weapon === 'roller' ? 0.55 : 0.75, 0.3);
        this.whoosh(t, 300, 700, 0.12, 0.25, 0.7);
        break;
      case 'dirt_clod': case 'ton_of_dirt': case 'digger': case 'sandhog':
        // fat muffled thoomp
        this.thump(t, 70, 34, 0.7, 0.32);
        this.whoosh(t, 220, 420, 0.14, 0.3, 0.6);
        break;
      case 'napalm': case 'hot_napalm':
        // sloshing heavy whoosh
        this.thump(t, 110, 40, 0.5, 0.22);
        this.whoosh(t, 420, 1100, 0.32, 0.5, 0.5);
        break;
      case 'funky_bomb': {
        this.thump(t, 140, 50, 0.45, 0.18);
        // party spring
        const o = this.ctx.createOscillator();
        o.type = 'square';
        o.frequency.setValueAtTime(300, t);
        o.frequency.exponentialRampToValueAtTime(900, t + 0.22);
        const g = this.ctx.createGain();
        this.env(g, t, 0.08, 0.01, 0.24);
        o.connect(g); g.connect(this.sfx);
        o.start(t); o.stop(t + 0.3);
        break;
      }
      case 'leapfrog': {
        this.thump(t, 130, 45, 0.5, 0.2);
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(520, t + 0.18);
        const g = this.ctx.createGain();
        this.env(g, t, 0.12, 0.01, 0.2);
        o.connect(g); g.connect(this.sfx);
        o.start(t); o.stop(t + 0.26);
        break;
      }
      default:
        this.thump(t, 130, 38, 0.7, 0.22);
        this.whoosh(t, 900, 2400 + power * 12, 0.25, 0.3);
    }
  }

  explosion(size = 1, nuke = false, flavor = null) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    if (flavor === 'dust') {
      // muffled earthen thud — no fire crack
      this.thump(t, 75, 26, 0.7 * Math.min(size, 1.3), 0.5);
      const n = this.ctx.createBufferSource();
      n.buffer = this.noiseBuffer();
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(500, t);
      f.frequency.exponentialRampToValueAtTime(80, t + 0.6);
      const ng = this.ctx.createGain();
      this.env(ng, t, 0.4 * Math.min(size, 1.3), 0.01, 0.6);
      n.connect(f); f.connect(ng); ng.connect(this.sfx);
      n.start(t); n.stop(t + 0.7);
      return;
    }
    if (flavor === 'funky') {
      // boom plus a strobing little arpeggio
      [660, 880, 1108, 1320].forEach((fq, i) => this.blip(fq, 0.1, 'square', 0.1, fq * 1.4, t + 0.1 + i * 0.07));
    }
    const dur = 0.5 + size * 0.5 + (nuke ? 0.8 : 0);
    // low boom
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90 + size * 20, t);
    o.frequency.exponentialRampToValueAtTime(24, t + dur * 0.8);
    const og = this.ctx.createGain();
    this.env(og, t, 0.8 * Math.min(size, 1.4), 0.008, dur * 0.9);
    o.connect(og); og.connect(this.sfx);
    o.start(t); o.stop(t + dur);
    // rumble noise through falling lowpass
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    n.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(nuke ? 60 : 140, t + dur);
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.65 * Math.min(size, 1.5), 0.005, dur);
    n.connect(f); f.connect(ng); ng.connect(this.sfx);
    n.start(t); n.stop(t + dur + 0.1);
    // crack transient
    const c = this.ctx.createBufferSource();
    c.buffer = this.noiseBuffer();
    const cf = this.ctx.createBiquadFilter();
    cf.type = 'highpass';
    cf.frequency.value = 1800;
    const cg = this.ctx.createGain();
    this.env(cg, t, 0.4 * Math.min(size, 1.2), 0.001, 0.09);
    c.connect(cf); cf.connect(cg); cg.connect(this.sfx);
    c.start(t); c.stop(t + 0.15);
  }

  whistleStart() {
    if (!this.ctx || !this.enabled || this._whistle) return;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 1400;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.026, this.ctx.currentTime + 0.3);
    o.connect(g); g.connect(this.sfx);
    o.start();
    this._whistle = { o, g };
  }

  whistleUpdate(fallSpeed) {
    if (!this._whistle) return;
    const f = 1700 - Math.min(fallSpeed, 700) * 1.1;
    this._whistle.o.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08);
  }

  whistleStop() {
    if (!this._whistle) return;
    const { o, g } = this._whistle;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    o.stop(this.ctx.currentTime + 0.3);
    this._whistle = null;
  }

  // anime death buildup: rising whine that cuts off right at the boom
  buildupWhine(duration) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(1050, t + duration);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + duration * 0.7);
    g.gain.exponentialRampToValueAtTime(0.11, t + duration);
    g.gain.linearRampToValueAtTime(0, t + duration + 0.02);
    o.connect(f); f.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + duration + 0.05);
  }

  // the dud: a wet, disappointing sputter
  pffrt() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.35);
    const lfo = this.ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 28;
    const lg = this.ctx.createGain();
    lg.gain.value = 60;
    lfo.connect(lg); lg.connect(o.frequency);
    const g = this.ctx.createGain();
    this.env(g, t, 0.3, 0.005, 0.4);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + 0.45);
    lfo.start(t); lfo.stop(t + 0.45);
  }

  cookPop() { this.blip(500 + Math.random() * 500, 0.08, 'square', 0.1, 120); }

  zap() { this.blip(320, 0.14, 'sawtooth', 0.15, 90); }
  shieldDown() { this.blip(600, 0.5, 'sawtooth', 0.18, 60); }
  battery() { this.blip(520, 0.12, 'sine', 0.25, 880); }
  click() { this.blip(900, 0.03, 'square', 0.12, 900); }
  hover() { this.blip(1400, 0.02, 'sine', 0.05, 1400); }
  turn() { this.blip(520, 0.07, 'sine', 0.06, 600); }
  dirt() { this.blip(90, 0.25, 'sine', 0.3, 40); }
  parachute() { this.blip(300, 0.2, 'sine', 0.15, 420); }

  blip(f0, dur, type, vol, f1, at = null) {
    if (!this.ctx || !this.enabled) return;
    const t = at ?? this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, vol, 0.004, dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.05);
  }

  cash() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    [1568, 2093].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this.env(g, t + i * 0.07, 0.09, 0.003, 0.12);
      o.connect(g); g.connect(this.sfx);
      o.start(t + i * 0.07); o.stop(t + i * 0.07 + 0.2);
    });
  }

  fanfare() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      this.env(g, t + i * 0.12, 0.2, 0.01, 0.5);
      o.connect(g); g.connect(this.sfx);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.6);
    });
  }

  napalmLoop(on) {
    if (!this.ctx || !this.enabled) return;
    if (on && !this._napalm) {
      const n = this.ctx.createBufferSource();
      n.buffer = this.noiseBuffer();
      n.loop = true;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 800;
      f.Q.value = 0.6;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(0.16, this.ctx.currentTime, 0.2);
      // crackle via LFO on gain
      const lfo = this.ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = 13;
      const lg = this.ctx.createGain();
      lg.gain.value = 0.06;
      lfo.connect(lg); lg.connect(g.gain);
      n.connect(f); f.connect(g); g.connect(this.sfx);
      n.start(); lfo.start();
      this._napalm = { n, g, lfo };
    } else if (!on && this._napalm) {
      const { n, g, lfo } = this._napalm;
      g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      n.stop(this.ctx.currentTime + 1);
      lfo.stop(this.ctx.currentTime + 1);
      this._napalm = null;
    }
  }

  startWind() {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    n.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 400;
    const g = this.ctx.createGain();
    g.gain.value = 0.02;
    n.connect(f); f.connect(g); g.connect(this.master);
    n.start();
    this._windGain = g;
    this._windFilter = f;
  }

  setWind(w) {
    if (!this._windGain) return;
    const s = Math.abs(w) / 60;
    this._windGain.gain.setTargetAtTime(0.012 + s * 0.05, this.ctx.currentTime, 1.2);
    this._windFilter.frequency.setTargetAtTime(300 + s * 500, this.ctx.currentTime, 1.2);
  }

  // ---- Music: upbeat chiptune march — drums, walking bass, cheery lead ----
  kickAt(t) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const g = this.ctx.createGain();
    this.env(g, t, 0.34, 0.003, 0.12);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + 0.16);
  }

  snareAt(t) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 0.9;
    const g = this.ctx.createGain();
    this.env(g, t, 0.12, 0.002, 0.1);
    n.connect(f); f.connect(g); g.connect(this.music);
    n.start(t); n.stop(t + 0.15);
  }

  hatAt(t, open) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer();
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 7500;
    const g = this.ctx.createGain();
    this.env(g, t, open ? 0.04 : 0.022, 0.001, open ? 0.08 : 0.03);
    n.connect(f); f.connect(g); g.connect(this.music);
    n.start(t); n.stop(t + 0.12);
  }

  bassAt(t, freq) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const o2 = this.ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = freq;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.1;
    const g = this.ctx.createGain();
    this.env(g, t, 0.2, 0.004, 0.24);
    o.connect(g); o2.connect(g2); g2.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + 0.26);
    o2.start(t); o2.stop(t + 0.26);
  }

  leadAt(t, freq, dur) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2200;
    const g = this.ctx.createGain();
    this.env(g, t, 0.055, 0.01, dur * 1.3);
    o.connect(f); f.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + dur + 0.08);
  }

  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const bpm = 108;
    const eighth = 60 / bpm / 2;
    // I–V–vi–IV in C major, roots as semitones from C3
    const chordRoots = [0, 7, 9, 5];
    const chordIsMinor = [false, false, true, false];
    const C3 = 130.81;
    this._mStep = 0;
    this._mNext = this.ctx.currentTime + 0.15;
    this._leadPrev = 7;
    const tick = () => {
      if (!this.musicOn || !this.ctx) return;
      while (this._mNext < this.ctx.currentTime + 0.45) {
        const s = this._mStep;
        const step = s & 7;               // 8 eighths per bar
        const bar = (s >> 3) & 3;         // 4-bar loop
        const phrase = (s >> 5) & 3;      // vary every 4 bars
        const swing = (step & 1) ? eighth * 0.16 : 0;
        const t = this._mNext + swing;
        const root = chordRoots[bar];
        // drums
        if (step === 0 || step === 4 || (step === 7 && bar === 3)) this.kickAt(t);
        if (step === 2 || step === 6) this.snareAt(t);
        if ((step & 1) === 0) this.hatAt(t, step === 4 && (bar & 1));
        // bouncing bass: root, root, fifth, octave
        if (step % 2 === 0) {
          const pick = [0, 0, 7, 12][(step >> 1)];
          this.bassAt(t, (C3 / 2) * Math.pow(2, (root + pick) / 12));
        }
        // cheery lead: chord tones + passing notes, resting sometimes
        const chordTones = chordIsMinor[bar] ? [0, 3, 7, 12] : [0, 4, 7, 12];
        const density = phrase === 2 ? 0.3 : 0.5;    // breathe often — background, not a solo
        if (Math.random() < density && !(phrase === 1 && step === 7)) {
          let iv;
          if (Math.random() < 0.7) {
            iv = chordTones[Math.floor(Math.random() * chordTones.length)];
          } else {
            iv = [2, 9, 14][Math.floor(Math.random() * 3)]; // color notes
          }
          // gentle voice-leading: drift toward previous note
          if (Math.abs(iv - this._leadPrev) > 9) iv = this._leadPrev + Math.sign(iv - this._leadPrev) * 5;
          this._leadPrev = iv;
          const dur = (step & 1) ? eighth * 0.8 : eighth * 1.5;
          this.leadAt(t, C3 * 2 * Math.pow(2, (root + iv) / 12), dur);
        }
        this._mStep++;
        this._mNext += eighth;
      }
    };
    tick();
    this._musicTimer = setInterval(tick, 160);
  }

  stopMusic() {
    if (this._musicTimer) { clearInterval(this._musicTimer); this._musicTimer = null; }
  }

  toggleMusic() {
    this.musicOn = !this.musicOn;
    if (this.musicOn) this.startMusic(); else this.stopMusic();
    return this.musicOn;
  }

  // route match events to sounds
  handleEvents(events, match) {
    if (!this.ctx || !this.enabled) return;
    for (const e of events) {
      switch (e.type) {
        case 'fire': this.fire(e.weapon, e.power); break;
        case 'explosion': {
          const dustyW = ['dirt_clod', 'ton_of_dirt', 'digger', 'sandhog'];
          const flavor = dustyW.includes(e.weapon) ? 'dust' : e.weapon === 'funky_bomb' ? 'funky' : null;
          this.explosion(Math.min(e.r / 50, 2.2), e.nuke, flavor);
          break;
        }
        case 'shieldHit': this.zap(); break;
        case 'shieldDown': this.shieldDown(); break;
        case 'battery': this.battery(); break;
        case 'dirt': this.dirt(); break;
        case 'parachute': this.parachute(); break;
        case 'turnStart': this.turn(); break;
        case 'deathBuildup': this.buildupWhine(e.duration); break;
        case 'deathDud': this.pffrt(); break;
        case 'cookoffPop': this.cookPop(); break;
        case 'tankExplode': this.explosion(e.dtype === 'nuke' ? 2.2 : 1.6, e.dtype === 'nuke'); break;
        case 'napalmStart': this.napalmLoop(true); break;
        case 'napalmEnd': this.napalmLoop(false); break;
        case 'roundEnd': case 'gameEnd': this.fanfare(); this.napalmLoop(false); this.whistleStop(); break;
      }
    }
    // whistle tracking: only true shells scream — never dirt, drills,
    // canisters, rollers, or flying debris
    const WHISTLERS = new Set(['shell', 'mirv', 'homing', 'leapfrog', 'funky', 'airstrike', 'buster']);
    let falling = null;
    for (const p of match.projectiles) {
      if (WHISTLERS.has(p.kind) && !p.rolling && !p.digging && p.vy > 160) { falling = p; break; }
    }
    if (falling) { this.whistleStart(); this.whistleUpdate(falling.vy); }
    else this.whistleStop();
    this.setWind(match.wind);
  }
}
