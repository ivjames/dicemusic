// A small additive keyboard voice and the timing model shared by playback and WAV export.
// Everything here is plain arithmetic on Float32Arrays, so the same code runs in the page,
// in an AudioContext of any sample rate, and in Node for tests.
import { MEASURES, UNITS_PER_BAR } from './score.js?v=dev';

export const EIGHTH_SECONDS = 60 / 116;          // ♪ = 116, a brisk 3/8 Schleifer
export const BAR_SECONDS = 3 * EIGHTH_SECONDS;   // 1.552 s
export const TAIL_SECONDS = 0.5;                 // room for the last note's release
export const UNIT_SECONDS = EIGHTH_SECONDS / 4;  // one 32nd note
export const MASTER_GAIN = 0.41;                 // chosen so the loudest measure peaks just under 0.9 (checked in test/run.mjs)

// C-major scale tones, for realising ornaments diatonically.
const SCALE = [0, 2, 4, 5, 7, 9, 11];
function upperNeighbour(midi) {
  for (let m = midi + 1; m <= midi + 2; m++) if (SCALE.includes(m % 12)) return m;
  return midi + 2;
}
function lowerNeighbour(midi) {
  for (let m = midi - 1; m >= midi - 2; m--) if (SCALE.includes(m % 12)) return m;
  return midi - 2;
}

/**
 * Turn the note list of one measure into timed events, realising the few written ornaments:
 * a trill alternates upper and main note in 32nds (starting on the upper note, ending on the
 * main); a turn is upper–main–lower–main. Returns [{ t, d, midi, vel }] in seconds.
 */
export function realize(notes) {
  const out = [];
  for (const [onset, dur, midi, staff, orn] of notes) {
    const vel = (staff === 0 ? 0.72 : 0.9) * (onset === 0 ? 1.1 : 1.0);
    if (orn === 'trill') {
      const up = upperNeighbour(midi);
      for (let k = 0; k < dur; k++) {
        out.push({ t: (onset + k) * UNIT_SECONDS, d: UNIT_SECONDS, midi: k % 2 === 0 ? up : midi, vel: vel * 0.85 });
      }
    } else if (orn === 'turn') {
      const seq = [upperNeighbour(midi), midi, lowerNeighbour(midi), midi];
      const step = dur / 4;
      seq.forEach((m, k) => out.push({ t: (onset + k * step) * UNIT_SECONDS, d: step * UNIT_SECONDS, midi: m, vel: vel * 0.85 }));
    } else {
      out.push({ t: onset * UNIT_SECONDS, d: dur * UNIT_SECONDS, midi, vel });
    }
  }
  return out;
}

function freqOf(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Add one struck-string note into `out` (in place). */
function addNote(out, { t, d, midi, vel }, sampleRate) {
  const f0 = freqOf(midi);
  const start = Math.round(t * sampleRate);
  const gap = Math.min(0.04, d * 0.15);              // a hair of daylight between notes
  const holdSamples = Math.max(1, Math.round((d - gap) * sampleRate));
  const releaseSamples = Math.round(0.28 * sampleRate);
  const n = Math.min(out.length - start, holdSamples + releaseSamples);
  if (n <= 0) return;
  // Decay gets quicker with pitch, like a real string.
  const tau = Math.min(1.8, Math.max(0.22, 1.8 * 2 ** (-(midi - 48) / 16)));
  const attackSamples = Math.max(1, Math.round(0.0025 * sampleRate));
  const releaseK = Math.exp(-1 / (0.03 * sampleRate));
  const nyq = sampleRate * 0.45;
  const B = 0.00012;                                   // slight inharmonicity
  // Partials as rotating phasors: no sin() in the inner loop.
  const P = [];
  for (let k = 1; k <= 8; k++) {
    const f = f0 * k * Math.sqrt(1 + B * k * k);
    if (f >= nyq) break;
    const lowpass = 1 / (1 + (f / 3200) ** 2);
    const amp = (1 / k ** 1.35) * lowpass * (k === 1 ? 1 : 0.75);
    if (amp < 1e-4) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    P.push({ c: Math.cos(w), s: Math.sin(w), x: 1, y: 0, a: amp, g: Math.exp(-1 / ((tau / (1 + 0.4 * (k - 1))) * sampleRate)) });
  }
  const scale = vel * 0.5;
  let rel = 1;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const p of P) {
      const nx = p.x * p.c - p.y * p.s;
      p.y = p.x * p.s + p.y * p.c;
      p.x = nx;
      v += p.y * p.a;
      p.a *= p.g;
    }
    if (i < attackSamples) v *= i / attackSamples;
    if (i >= holdSamples) {
      rel *= releaseK;
      v *= rel;
    }
    out[start + i] += v * scale;
  }
}

/** Sample count of one rendered measure buffer (bar plus tail). */
export function measureSamples(sampleRate) {
  return Math.round((BAR_SECONDS + TAIL_SECONDS) * sampleRate);
}
export function barSamples(sampleRate) {
  return Math.round(BAR_SECONDS * sampleRate);
}

/** Notes of a measure; `ending` picks the variant for the eleven bar-8 measures. */
export function notesOf(measureId, ending = 'second') {
  const m = MEASURES[measureId];
  if (!m) throw new RangeError(`no measure ${measureId}`);
  if (m.notes) return m.notes;
  return ending === 'first' ? m.first : m.second;
}
export function hasEndings(measureId) {
  return Boolean(MEASURES[measureId] && MEASURES[measureId].first);
}

/** Render one measure to mono samples at `sampleRate`. Deterministic. */
export function renderMeasure(measureId, sampleRate, ending = 'second') {
  const out = new Float32Array(measureSamples(sampleRate));
  for (const ev of realize(notesOf(measureId, ending))) addNote(out, ev, sampleRate);
  for (let i = 0; i < out.length; i++) out[i] *= MASTER_GAIN;
  return out;
}

/** Cache key for a rendered measure. */
export function bufferKey(measureId, ending) {
  return hasEndings(measureId) ? `${measureId}:${ending}` : String(measureId);
}

/**
 * The order in which bars are heard. Without repeats: bars 1–16 once, bar 8 with the
 * ending that leads on to bar 9. With repeats: ||: 1–8 :|| 9–16, as the print asks and as
 * the Humdrum edition expands it ([A,A1,A,A2,B]): the first half twice, bar 8 taking its
 * first ending the first time round, then the second half once.
 * `measures` is the 16 measure numbers. Returns steps [{ bar, measureId, ending, key, at, dur }]
 * where `at` and `dur` are seconds and `key` names the rendered buffer.
 */
export function playbackPlan(measures, repeats = false) {
  if (!Array.isArray(measures) || measures.length !== 16) throw new RangeError('need 16 measures');
  const order = [];
  if (!repeats) {
    for (let b = 0; b < 16; b++) order.push([b, 'second']);
  } else {
    for (let b = 0; b < 8; b++) order.push([b, 'first']);
    for (let b = 0; b < 8; b++) order.push([b, 'second']);
    for (let b = 8; b < 16; b++) order.push([b, 'second']);
  }
  return order.map(([bar, ending], k) => ({
    bar, measureId: measures[bar], ending, key: bufferKey(measures[bar], ending), at: k * BAR_SECONDS, dur: BAR_SECONDS,
  }));
}

/** Sample at which a step starts. */
export function stepStart(step, sampleRate) {
  return Math.round(step.at * sampleRate);
}

/** Total length in samples of a plan once its buffers are known (the last tail included). */
export function planSamples(plan, buffers, sampleRate) {
  let n = 0;
  for (const s of plan) {
    const buf = buffers.get(s.key);
    if (!buf) throw new Error(`step ${s.key} not rendered`);
    n = Math.max(n, stepStart(s, sampleRate) + buf.length);
  }
  return n;
}

/**
 * Mix a plan into one buffer: each step at its own start sample, tails overlapping the next
 * step exactly as the scheduled playback overlaps them. `buffers` maps step.key → Float32Array.
 * This is what the WAV export writes.
 */
export function mixdown(plan, buffers, sampleRate) {
  const out = new Float32Array(planSamples(plan, buffers, sampleRate));
  for (const s of plan) {
    const buf = buffers.get(s.key);
    const off = stepStart(s, sampleRate);
    for (let i = 0; i < buf.length; i++) out[off + i] += buf[i];
  }
  return out;
}

// ---------- a second instrument: sustained voices for the chorale ----------

/** Add one sustained, lightly chorused voice note into `out` (in place). */
function addSustained(out, { t, d, midi, vel }, sampleRate) {
  const f0 = freqOf(midi);
  const start = Math.round(t * sampleRate);
  const holdSamples = Math.max(1, Math.round(d * sampleRate));
  const attackSamples = Math.round(0.045 * sampleRate);
  const releaseSamples = Math.round(0.16 * sampleRate);
  const n = Math.min(out.length - start, holdSamples + releaseSamples);
  if (n <= 0) return;
  const nyq = sampleRate * 0.45;
  const P = [];
  // Two slightly detuned copies of each partial give a choir-like breadth.
  for (const cents of [-4, 4]) {
    const f1 = f0 * 2 ** (cents / 1200);
    for (let k = 1; k <= 7; k++) {
      const f = f1 * k;
      if (f >= nyq) break;
      const lowpass = 1 / (1 + (f / 1800) ** 2);
      const amp = (k === 1 ? 1 : 0.6 / k ** 1.3) * lowpass;
      if (amp < 1e-4) continue;
      const w = (2 * Math.PI * f) / sampleRate;
      P.push({ c: Math.cos(w), s: Math.sin(w), x: 1, y: 0, a: amp * 0.5 });
    }
  }
  const scale = vel * 0.27;
  const relK = Math.exp(-1 / (0.05 * sampleRate));
  let rel = 1;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const p of P) {
      const nx = p.x * p.c - p.y * p.s;
      p.y = p.x * p.s + p.y * p.c;
      p.x = nx;
      v += p.y * p.a;
    }
    if (i < attackSamples) v *= 0.5 - 0.5 * Math.cos(Math.PI * i / attackSamples);
    if (i >= holdSamples) { rel *= relK; v *= rel; }
    out[start + i] += v * scale;
  }
}

export const CHORALE_TAIL_SECONDS = 0.3;

/**
 * Render a chord for the sustained instrument: `notes` are [{ midi, vel }] all starting at 0
 * and holding for `seconds`; the buffer is `seconds` plus a short tail for the release.
 */
export function renderChord(notes, seconds, sampleRate) {
  return renderSustainedNotes(notes.map((nt) => ({ t: 0, d: Math.max(0.05, seconds - 0.07), midi: nt.midi, vel: nt.vel })), seconds, sampleRate);
}

/** Render timed notes [{ t, d, midi, vel }] (seconds) for the sustained instrument into a buffer of `seconds` plus its tail. */
export function renderSustainedNotes(events, seconds, sampleRate) {
  const out = new Float32Array(Math.round((seconds + CHORALE_TAIL_SECONDS) * sampleRate));
  for (const ev of events) addSustained(out, ev, sampleRate);
  return out;
}

/** Render timed notes [{ t, d, midi, vel }] (seconds) for the struck-string voice into a buffer of `seconds` plus its tail, at master gain. */
export function renderStruckNotes(events, seconds, sampleRate) {
  const out = new Float32Array(Math.round((seconds + TAIL_SECONDS) * sampleRate));
  for (const ev of events) addNote(out, ev, sampleRate);
  for (let i = 0; i < out.length; i++) out[i] *= MASTER_GAIN;
  return out;
}
