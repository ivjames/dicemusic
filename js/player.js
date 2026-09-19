// Web Audio playback of a plan of rendered measure buffers.
// Bars are scheduled up front on one clock, each at exactly k × barSamples, so there are no gaps.
// Pause stops the scheduled sources and remembers the position; resume schedules from there.
import { barSamples, measureSamples, planSamples } from './synth.js';

const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;

export class Player {
  constructor() {
    this.ctx = null;
    this.state = 'idle';            // idle | playing | paused
    this.plan = [];
    this.buffers = new Map();       // bufferKey -> AudioBuffer
    this.sources = [];
    this.startedAt = 0;             // ctx time at which sample 0 of the plan would have played
    this.pausedAtSample = 0;
    this.generation = 0;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(reason) { for (const fn of this.listeners) fn(this.state, reason); }

  get supported() { return Boolean(AC); }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }

  /** Create (and, on iOS, unlock) the context. Must be called from a user gesture. */
  async ensureContext() {
    if (!AC) throw new Error('This browser has no Web Audio support.');
    if (!this.ctx) {
      try { this.ctx = new AC({ latencyHint: 'playback' }); } catch { this.ctx = new AC(); }
      this.ctx.addEventListener('statechange', () => this.handleStateChange());
    }
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* fall through to the check below */ }
    }
    if (this.ctx.state !== 'running') {
      // iOS needs a sound started inside the gesture before it will run the clock.
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start();
      await this.ctx.resume();
    }
    if (this.ctx.state !== 'running') throw new Error('Audio could not be started. Try tapping Play again, or check the silent switch.');
    return this.ctx;
  }

  handleStateChange() {
    // A phone call, another app grabbing audio, or a sleeping tab suspends the context
    // underneath us; treat that as a pause so the UI stays truthful.
    if (!this.ctx) return;
    if (this.state === 'playing' && (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted')) {
      this.pausedAtSample = this.positionSample();
      this.stopSources();
      this.state = 'paused';
      this.emit('interrupted');
    }
  }

  /** Install a plan and its rendered buffers (Float32Arrays keyed by bufferKey). */
  load(plan, floatBuffers, keyOf) {
    this.stop();
    this.plan = plan;
    this.buffers = new Map();
    const sr = this.sampleRate;
    for (const step of plan) {
      const key = keyOf(step);
      if (this.buffers.has(key)) continue;
      const data = floatBuffers.get(key);
      if (!data) throw new Error(`missing buffer ${key}`);
      const ab = this.ctx.createBuffer(1, data.length, sr);
      ab.getChannelData(0).set(data);
      this.buffers.set(key, ab);
    }
    this.keyOf = keyOf;
  }

  get totalSamples() { return this.plan.length ? planSamples(this.plan, this.sampleRate) : 0; }
  get endSample() { return this.plan.length ? (this.plan.length - 1) * barSamples(this.sampleRate) + barSamples(this.sampleRate) : 0; }

  /** Current position in samples from the start of the plan. */
  positionSample() {
    if (this.state === 'playing' && this.ctx) return Math.max(0, Math.round((this.ctx.currentTime - this.startedAt) * this.sampleRate));
    if (this.state === 'paused') return this.pausedAtSample;
    return 0;
  }

  /** Index of the bar under the playhead, or -1. */
  currentIndex() {
    if (this.state === 'idle' || !this.plan.length) return -1;
    const i = Math.floor(this.positionSample() / barSamples(this.sampleRate));
    return i < this.plan.length ? i : -1;
  }

  play() {
    if (!this.ctx || !this.plan.length) return;
    if (this.state === 'playing') return;
    const from = this.state === 'paused' ? this.pausedAtSample : 0;
    this.scheduleFrom(from);
  }

  scheduleFrom(fromSample) {
    const sr = this.sampleRate;
    const stride = barSamples(sr);
    const gen = ++this.generation;
    const t0 = this.ctx.currentTime + 0.08;
    this.startedAt = t0 - fromSample / sr;
    this.sources = [];
    const firstBar = Math.min(this.plan.length - 1, Math.floor(fromSample / stride));
    for (let k = firstBar; k < this.plan.length; k++) {
      const key = this.keyOf(this.plan[k]);
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(key);
      src.connect(this.ctx.destination);
      const barStart = k * stride;
      if (barStart >= fromSample) src.start(this.startedAt + barStart / sr);
      else src.start(t0, (fromSample - barStart) / sr);
      this.sources.push(src);
    }
    const last = this.sources[this.sources.length - 1];
    last.onended = () => { if (gen === this.generation && this.state === 'playing') this.finish(); };
    this.state = 'playing';
    this.emit('play');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.pausedAtSample = Math.min(this.positionSample(), this.endSample);
    this.stopSources();
    this.state = 'paused';
    this.emit('pause');
  }

  stop() {
    const was = this.state;
    this.stopSources();
    this.pausedAtSample = 0;
    this.state = 'idle';
    if (was !== 'idle') this.emit('stop');
  }

  finish() {
    this.stopSources();
    this.pausedAtSample = 0;
    this.state = 'idle';
    this.emit('ended');
  }

  stopSources() {
    this.generation++;
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* already stopped */ } }
    this.sources = [];
  }

  /** Whether the playhead has run past everything, the last bar's tail included. */
  get finished() { return this.state === 'playing' && this.positionSample() >= this.totalSamples; }
}

export { measureSamples };
