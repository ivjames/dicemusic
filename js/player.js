// Web Audio playback of a plan of rendered measure buffers.
// Steps are scheduled up front on one clock, each at its own start sample, so there are no gaps.
// Pause stops the scheduled sources and remembers the position; resume schedules from there.
import { stepStart, planSamples } from './synth.js?v=dev';

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
    this.createContext();
    if (old) { try { await old.close(); } catch { /* already closed */ } }
    // Reinstall only if the rendered audio is at this context's rate. Compare with the rate the
    // buffers were rendered at, not the previous context's: after a rate-changing swap that has
    // not been reloaded yet, a second swap back to the original rate must not clear needsReload.
    if (this.floatBuffers && this.ctx.sampleRate === this.floatRate) {
      this.installBuffers(this.plan, this.floatBuffers);
      this.needsReload = false;
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

  /** Install a plan (steps with key/at/dur) and its rendered buffers (Float32Arrays keyed by step.key). */
  load(plan, floatBuffers) {
    this.stop();
    this.installBuffers(plan, floatBuffers);
    this.needsReload = false;
  }

  installBuffers(plan, floatBuffers) {
    this.plan = plan;
    this.floatBuffers = floatBuffers;
    this.floatRate = this.sampleRate;
    this.buffers = new Map();
    const sr = this.sampleRate;
    for (const step of plan) {
      if (this.buffers.has(step.key)) continue;
      const data = floatBuffers.get(step.key);
      if (!data) throw new Error(`missing buffer ${step.key}`);
      const ab = this.ctx.createBuffer(1, data.length, sr);
      ab.getChannelData(0).set(data);
      this.buffers.set(step.key, ab);
    }
  }

  get totalSamples() { return this.plan.length ? planSamples(this.plan, this.floatBuffers, this.sampleRate) : 0; }
  get endSample() { const last = this.plan[this.plan.length - 1]; return last ? Math.round((last.at + last.dur) * this.sampleRate) : 0; }

  /** Current position in samples from the start of the plan. */
  positionSample() {
    // During the short pre-roll before the first scheduled sample the clock reads behind the
    // start point; never report a position earlier than where playback was scheduled from.
    if (this.state === 'playing' && this.ctx) return Math.max(this.scheduledFrom || 0, Math.round((this.ctx.currentTime - this.startedAt) * this.sampleRate));
    if (this.state === 'paused') return this.pausedAtSample;
    return 0;
  }

  /** Index of the step under the playhead, or -1. */
  currentIndex() {
    if (this.state === 'idle' || !this.plan.length) return -1;
    const pos = this.positionSample();
    const sr = this.sampleRate;
    let idx = -1;
    for (let k = 0; k < this.plan.length; k++) if (stepStart(this.plan[k], sr) <= pos) idx = k;
    if (idx >= 0 && pos >= Math.round((this.plan[idx].at + this.plan[idx].dur) * sr)) return -1;
    return idx;
  }

  play() {
    if (!this.ctx || !this.plan.length) return;
    if (this.state === 'playing') return;
    const from = this.state === 'paused' ? this.pausedAtSample : 0;
    this.scheduleFrom(from);
  }

  scheduleFrom(fromSample) {
    const sr = this.sampleRate;
    const gen = ++this.generation;
    const t0 = this.ctx.currentTime + 0.08;
    this.startedAt = t0 - fromSample / sr;
    this.scheduledFrom = fromSample;
    this.sources = [];
    // Every step whose buffer still has something to play from this position.
    for (let k = 0; k < this.plan.length; k++) {
      const step = this.plan[k];
      const buf = this.buffers.get(step.key);
      const start = stepStart(step, sr);
      if (start + buf.length <= fromSample) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      if (start >= fromSample) src.start(this.startedAt + start / sr);
      else src.start(t0, (fromSample - start) / sr);
      this.sources.push(src);
    }
    const last = this.sources[this.sources.length - 1];
    if (last) last.onended = () => { if (gen === this.generation && this.state === 'playing') this.finish(); };
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

