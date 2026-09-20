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
    this.floatBuffers = null;       // last Float32Array map given to load(), to rebuild after a context swap
    this.floatRate = 0;
    this.stale = false;             // context judged dead (iOS after backgrounding): swap it on the next gesture
    this.needsReload = false;       // a swapped context runs at another sample rate; buffers must be re-rendered
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(reason) { for (const fn of this.listeners) fn(this.state, reason); }

  get supported() { return Boolean(AC); }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }

  /** Create (and, on iOS, unlock) the context. Must be called from a user gesture. */
  async ensureContext() {
    if (!AC) throw new Error('This browser has no Web Audio support.');
    if (this.ctx && (this.stale || this.ctx.state === 'closed')) await this.replaceContext();
    if (!this.ctx) this.createContext();
    const wasRunning = this.ctx.state === 'running';
    await this.wake();
    // Only a context we had to wake gets the clock test, so a normal Play does not wait for it.
    if (this.ctx.state !== 'running' || (!wasRunning && !(await this.clockAdvances()))) {
      // iOS Safari after a trip through the background: resume() may "succeed" on a context
      // whose clock never moves again. A fresh context on this same gesture does work.
      await this.replaceContext();
      await this.wake();
    }
    if (this.ctx.state !== 'running') throw new Error('Audio could not be started. Try tapping Play again, or check the silent switch.');
    return this.ctx;
  }

  createContext() {
    try { this.ctx = new AC({ latencyHint: 'playback' }); } catch { this.ctx = new AC(); }
    this.ctx.addEventListener('statechange', () => this.handleStateChange());
    this.stale = false;
  }

  /** Resume the context, with the silent-buffer nudge iOS needs inside a gesture. */
  async wake() {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* checked below */ }
    }
    if (this.ctx.state !== 'running') {
      try {
        const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start();
        await this.ctx.resume();
      } catch { /* checked by the caller */ }
    }
  }

  /** True when the context's clock moves within a short wait. A frozen clock means a dead context. */
  async clockAdvances(waitMs = 120) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const t0 = this.ctx.currentTime;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.ctx.currentTime > t0;
  }

  /** Throw the current context away and build a new one, keeping the position and the rendered audio. */
  async replaceContext() {
    const old = this.ctx;
    if (this.state === 'playing') { this.pausedAtSample = this.positionSample(); this.state = 'paused'; }
    this.stopSources();
    const oldRate = old ? old.sampleRate : 0;
    this.createContext();
    if (old) { try { await old.close(); } catch { /* already closed */ } }
    if (this.floatBuffers && this.ctx.sampleRate === oldRate) {
      this.installBuffers(this.plan, this.floatBuffers, this.keyOf);
    } else if (this.floatBuffers) {
      this.needsReload = true;      // different rate: the app must re-render at the new rate and load again
    }
    this.emit('context-replaced');
  }

  /** Called by the page when it comes back to the foreground: decide whether the context survived. */
  async checkAfterReturn() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running' || !(await this.clockAdvances(250))) {
      this.stale = true;
      if (this.state === 'playing') {
        this.pausedAtSample = this.positionSample();
        this.stopSources();
        this.state = 'paused';
        this.emit('interrupted');
      }
    }
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
    this.installBuffers(plan, floatBuffers, keyOf);
    this.needsReload = false;
  }

  installBuffers(plan, floatBuffers, keyOf) {
    this.plan = plan;
    this.floatBuffers = floatBuffers;
    this.floatRate = this.sampleRate;
    this.keyOf = keyOf;
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
  }

  get totalSamples() { return this.plan.length ? planSamples(this.plan, this.sampleRate) : 0; }
  get endSample() { return this.plan.length ? (this.plan.length - 1) * barSamples(this.sampleRate) + barSamples(this.sampleRate) : 0; }

  /** Current position in samples from the start of the plan. */
  positionSample() {
    // During the short pre-roll before the first scheduled sample the clock reads behind the
    // start point; never report a position earlier than where playback was scheduled from.
    if (this.state === 'playing' && this.ctx) return Math.max(this.scheduledFrom || 0, Math.round((this.ctx.currentTime - this.startedAt) * this.sampleRate));
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
    this.scheduledFrom = fromSample;
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
