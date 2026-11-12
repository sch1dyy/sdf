// Generative ambient score, synthesised in the browser: plucked koto, a breathy shakuhachi,
// a low drone, wind and the occasional temple bell. Nothing is downloaded, and nothing
// sounds until the visitor asks for it.

/** Koto strings in hirajoshi tuning on D (MIDI notes), low to high. */
const STRINGS = [50, 55, 57, 58, 62, 63, 67, 69, 70, 74, 75, 79, 81];
/** The flute keeps to the same scale, one octave of it. */
const FLUTE = [62, 63, 67, 69, 70, 74, 75];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];
const clampIndex = (i: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, i));

/** A plucked string by Karplus-Strong synthesis, tuned with a fractional-delay allpass. */
function pluck(ctx: BaseAudioContext, freq: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = Math.min(5.5, Math.max(2.6, 520 / freq + 2.2));
  const n = Math.floor(sr * seconds);
  const buffer = ctx.createBuffer(1, n, sr);
  const out = buffer.getChannelData(0);

  // Loop filter: a two-tap average (delay `soft` samples) that damps the highs each pass.
  const soft = 0.28 + Math.min(0.2, freq / 3000);
  const decay = Math.pow(10, -3 / (freq * (freq < 200 ? 6 : freq < 500 ? 4.5 : 3)));
  const period = sr / freq;
  const N = Math.floor(period - soft - 0.1);
  const frac = period - soft - N;
  const allpass = (1 - frac) / (1 + frac);

  const line = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp += (Math.random() * 2 - 1 - lp) * 0.6;
    line[i] = lp;
  }
  // Plucking near the end of the string hollows out some harmonics.
  const burst = line.slice();
  const offset = Math.max(1, Math.round(N * 0.13));
  for (let i = 0; i < N; i++) line[i] = burst[i] - 0.85 * burst[(i + N - offset) % N];

  let p = 0;
  let prev = 0;
  let apIn = 0;
  let apOut = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const x = line[p];
    out[i] = x;
    peak = Math.max(peak, Math.abs(x));
    const filtered = decay * ((1 - soft) * x + soft * prev);
    prev = x;
    apOut = allpass * filtered + apIn - allpass * apOut;
    apIn = filtered;
    line[p] = apOut;
    p = p + 1 === N ? 0 : p + 1;
  }

  const attack = Math.floor(sr * 0.002);
  const release = Math.floor(sr * 0.12);
  for (let i = 0; i < n; i++) {
    let g = 0.9 / (peak || 1);
    if (i < attack) g *= i / attack;
    if (i > n - release) g *= (n - i) / release;
    out[i] *= g;
  }
  return buffer;
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A long, dark hall: decaying noise whose highs die away first. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      lp += ((Math.random() * 2 - 1) * Math.pow(1 - t, 2.4) - lp) * (0.55 - 0.45 * t);
      data[i] = lp;
    }
  }
  return buffer;
}

export class Music {
  enabled = false;

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private send!: GainNode;
  private analyser!: AnalyserNode;
  private readonly scope = new Float32Array(1024);
  private noise!: AudioBuffer;
  private strings: AudioBuffer[] = [];
  private timer = 0;
  private nextKoto = 0;
  private nextFlute = 0;
  private nextBell = 0;
  private walk = 6;

  constructor() {
    // Background tabs should fall silent.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx || !this.enabled) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  toggle(): boolean {
    return this.setEnabled(!this.enabled);
  }

  /** Must be called from a user gesture the first time it is switched on. */
  setEnabled(on: boolean): boolean {
    this.enabled = on;
    window.clearInterval(this.timer);
    if (on) {
      const ctx = this.ensure();
      void ctx.resume();
      const now = ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(1, now, 0.9);
      this.nextBell = now + 0.4;
      this.nextKoto = now + 2.4;
      this.nextFlute = now + 8;
      this.timer = window.setInterval(() => this.schedule(), 200);
      this.schedule();
    } else if (this.ctx) {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(0, now, 0.14);
      window.setTimeout(() => {
        if (!this.enabled) void ctx.suspend();
      }, 900);
    }
    return on;
  }

  /** A small bell, for when the blade is touched. */
  chime(): void {
    if (!this.ctx || !this.enabled) return;
    this.bell(mtof(pick([86, 89, 91, 93])), this.ctx.currentTime + 0.01, 0.5, 0.3);
  }

  /** Current output peak, 0..1. */
  level(): number {
    if (!this.ctx || this.ctx.state !== 'running') return 0;
    this.analyser.getFloatTimeDomainData(this.scope);
    let peak = 0;
    for (const v of this.scope) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  get state(): string {
    return this.ctx?.state ?? 'none';
  }

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'playback' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.3;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(limiter).connect(this.analyser).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.8;
    this.dry.connect(this.master);

    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx, 4.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.62;
    this.send = ctx.createGain();
    this.send.connect(reverb).connect(wet).connect(this.master);

    this.noise = whiteNoise(ctx, 3);
    this.strings = STRINGS.map((m) => pluck(ctx, mtof(m)));
    this.ambience(ctx);
    return ctx;
  }

  /** Routes a voice to the dry bus and the hall. */
  private out(node: AudioNode, dry: number, wet: number): void {
    const ctx = this.ctx!;
    const d = ctx.createGain();
    d.gain.value = dry;
    const w = ctx.createGain();
    w.gain.value = wet;
    node.connect(d).connect(this.dry);
    node.connect(w).connect(this.send);
  }

  private ambience(ctx: AudioContext): void {
    // Drone on D with a faint fifth.
    const drone = ctx.createGain();
    drone.gain.value = 1;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 420;
    for (const [midi, type, gain, detune] of [
      [38, 'sine', 0.085, -4],
      [38, 'sine', 0.085, 5],
      [45, 'sine', 0.04, 0],
      [50, 'triangle', 0.022, 3],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = mtof(midi);
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(tone);
      osc.start();
    }
    tone.connect(drone);
    this.lfo(ctx, 0.06, 0.3, drone.gain);
    this.out(drone, 0.9, 0.5);

    // Wind in the trees.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 520;
    band.Q.value = 0.7;
    const wind = ctx.createGain();
    wind.gain.value = 0.03;
    src.connect(band).connect(wind);
    this.lfo(ctx, 0.047, 260, band.frequency);
    this.lfo(ctx, 0.083, 0.018, wind.gain);
    this.out(wind, 0.8, 0.7);
    src.start();
  }

  private lfo(ctx: AudioContext, rate: number, depth: number, param: AudioParam): void {
    const osc = ctx.createOscillator();
    osc.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g).connect(param);
    osc.start();
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 1.2;
    while (this.nextKoto < horizon) this.nextKoto += this.kotoPhrase(this.nextKoto) + 1.6 + Math.random() * 3.6;
    while (this.nextFlute < horizon) this.nextFlute += this.flutePhrase(this.nextFlute) + 7 + Math.random() * 9;
    while (this.nextBell < horizon) {
      this.bell(mtof(pick([62, 69, 74])), this.nextBell, 0.8, 1);
      this.nextBell += 26 + Math.random() * 22;
    }
  }

  // ── Koto ─────────────────────────────────────────────────

  private koto(string: number, at: number, velocity: number, bend = 0): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.strings[clampIndex(string, 0, STRINGS.length - 1)];
    if (bend) {
      // Pressing the string behind the bridge after plucking bends the note upward.
      src.playbackRate.setValueAtTime(1, at + 0.14);
      src.playbackRate.linearRampToValueAtTime(Math.pow(2, bend / 12), at + 0.4);
      src.playbackRate.setTargetAtTime(1, at + 1.1, 0.12);
    }
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2400 + 3400 * velocity;
    const gain = ctx.createGain();
    gain.gain.value = 0.3 * velocity;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (string / (STRINGS.length - 1) - 0.5) * 0.7 + (Math.random() - 0.5) * 0.15;
    src.connect(tone).connect(gain).connect(pan);
    this.out(pan, 0.9, 0.55);
    src.start(at);
  }

  /** Plays one short figure and returns how long it lasts. */
  private kotoPhrase(at: number): number {
    const step = () => (this.walk = clampIndex(this.walk + pick([-2, -1, -1, 1, 1, 2]), 3, 11));
    const r = Math.random();
    if (r < 0.28) {
      // A note doubled at the octave below, sometimes answered.
      const i = step();
      this.koto(i, at, 0.9);
      this.koto(i >= 5 ? i - 5 : 0, at + 0.02, 0.7);
      if (Math.random() < 0.5) this.koto(step(), at + 1.4, 0.6);
      return 2.8;
    }
    if (r < 0.52) {
      // Three neighbouring strings falling quickly onto the last.
      const i = clampIndex(step() + 1, 4, 12);
      this.koto(i, at, 0.75);
      this.koto(i - 1, at + 0.2, 0.65);
      this.koto(i - 2, at + 0.42, 0.9);
      this.walk = i - 2;
      return 2.6;
    }
    if (r < 0.7) {
      this.koto(step(), at, 0.8);
      this.koto(step(), at + 1.1, 0.7);
      this.koto(step(), at + 2.3, 0.85, Math.random() < 0.5 ? 1 : 0);
      return 4.4;
    }
    if (r < 0.82) {
      // A soft run down the strings, landing low.
      const top = 12 - Math.floor(Math.random() * 2);
      const count = 6 + Math.floor(Math.random() * 3);
      for (let k = 0; k < count; k++) this.koto(top - k, at + k * 0.075, 0.3 + k * 0.03);
      this.koto(Math.max(0, top - count - 1), at + count * 0.075 + 0.12, 0.9);
      this.walk = clampIndex(top - count, 3, 11);
      return 3.2;
    }
    if (r < 0.92) {
      this.koto(pick([0, 1, 2, 4]), at, 1);
      return 3;
    }
    return 2; // silence is part of the phrase
  }

  // ── Shakuhachi ───────────────────────────────────────────

  private flute(freq: number, at: number, dur: number, velocity: number): void {
    const ctx = this.ctx!;
    const end = at + dur;
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = Math.min(freq * 4.5, 3800);
    body.Q.value = 0.4;

    // Vibrato that only arrives late in the breath.
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.6 + Math.random();
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, at);
    depth.gain.linearRampToValueAtTime(15, at + dur * 0.8);
    vibrato.connect(depth);

    const scoop = -(70 + Math.random() * 50);
    const rise = 0.2 + Math.random() * 0.15;
    const voices: AudioScheduledSourceNode[] = [vibrato];
    for (const [ratio, type, level] of [
      [1, 'sine', 1],
      [2, 'sine', 0.22],
      [1, 'triangle', 0.12],
      [3, 'sine', 0.07],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * ratio;
      // Each note is found from below and sinks away at the end.
      osc.detune.setValueAtTime(scoop, at);
      osc.detune.linearRampToValueAtTime(0, at + rise);
      osc.detune.setValueAtTime(0, end - 0.4);
      osc.detune.linearRampToValueAtTime(-45, end + 0.25);
      depth.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(body);
      voices.push(osc);
    }

    const breath = ctx.createBufferSource();
    breath.buffer = this.noise;
    breath.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq * 2;
    band.Q.value = 1.6;
    const air = ctx.createGain();
    air.gain.setValueAtTime(0, at);
    air.gain.linearRampToValueAtTime(0.5, at + 0.06);
    air.gain.linearRampToValueAtTime(0.13, at + 0.5);
    air.gain.setValueAtTime(0.13, end - 0.3);
    air.gain.linearRampToValueAtTime(0, end + 0.25);
    breath.connect(band).connect(air).connect(body);
    voices.push(breath);

    const peak = 0.1 * velocity;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(peak * 0.7, at + 0.14);
    amp.gain.linearRampToValueAtTime(peak, at + dur * 0.4);
    amp.gain.linearRampToValueAtTime(peak * 0.8, end - 0.45);
    amp.gain.linearRampToValueAtTime(0, end + 0.25);
    const pan = ctx.createStereoPanner();
    pan.pan.value = -0.18;
    body.connect(amp).connect(pan);
    this.out(pan, 0.55, 1);

    for (const v of voices) {
      v.start(at);
      v.stop(end + 0.4);
    }
  }

  private flutePhrase(at: number): number {
    let i = pick([2, 3, 5]);
    const count = 2 + Math.floor(Math.random() * 3);
    let t = at;
    for (let k = 0; k < count; k++) {
      const last = k === count - 1;
      if (last) i = pick([0, 3, 5]); // come to rest on D or A
      const dur = last ? 4 + Math.random() * 2.5 : 1.6 + Math.random() * 2.2;
      this.flute(mtof(FLUTE[i]), t, dur, last ? 0.9 : 0.75);
      t += dur * 0.94 + (Math.random() < 0.25 ? 0.9 : 0);
      i = clampIndex(i + pick([-2, -1, -1, 1, 1]), 0, FLUTE.length - 1);
    }
    return t - at;
  }

  // ── Bell ─────────────────────────────────────────────────

  private bell(freq: number, at: number, velocity: number, length: number): void {
    const ctx = this.ctx!;
    const mix = ctx.createGain();
    mix.gain.value = 0.11 * velocity;
    for (const [ratio, level, decay] of [
      [1, 1, 7],
      [1.003, 0.6, 7],
      [2.71, 0.45, 4.5],
      [5.15, 0.22, 2.6],
      [8.3, 0.1, 1.4],
    ]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(level, at + 0.008);
      g.gain.setTargetAtTime(0, at + 0.012, (decay * length) / 5);
      osc.connect(g).connect(mix);
      osc.start(at);
      osc.stop(at + decay * length * 1.4 + 0.2);
    }
    this.out(mix, 0.5, 1);
  }
}
