// Melodic elaboration of a voiced chorale. The voice leading fixes one note per voice per
// chord; this pass adds movement inside the chord without touching those notes or the
// chords. Each voice's part in a chord becomes a line of [pitch, length] in quavers (four
// to a chord), the first note always the skeleton note on the first half.
//
// Level 'passing': a voice that moves by a third to the next chord takes the diatonic
// passing note between as a crotchet; one that leaps a fourth to a sixth takes the chord
// tone it skips over; a soprano that would repeat its note takes a neighbour.
// Level 'lively' adds quavers: a fourth or a fifth is filled as a run (a step or a chord
// tone, then the step below the goal), a repeating soprano takes both neighbours in turn,
// an inner voice that repeats its note dips to a neighbour and back, and three voices may
// move in one chord rather than two.
//
// Every added note falls on the second half of the chord, unaccented, and is kept only where
// it makes no parallel fifths or octaves (between any two successive states of the texture,
// including into the next chord), no crossing and no unison with a neighbouring voice. Over
// a chromatic chord (a secondary dominant, the borrowed iv) only chord tones are added, so
// no passing note clashes with the altered one. Position 8 (the half cadence, held) and the
// last chord are never elaborated. Deterministic.
import { KEYS } from './chorale-harmony.js?v=dev';
import { RANGES } from './chorale-voicing.js?v=dev';

const NAMES = ['B', 'T', 'A', 'S'];
const SCALE = [0, 2, 4, 5, 7, 9, 11];
const ORDER = [3, 0, 1, 2];          // soprano first, then bass, then the inner voices
export const UNITS = 4;              // quavers in a chord
export const MAX_MOVING = { plain: 0, passing: 2, lively: 3 };   // voices that may take added notes in one chord
export const LEVELS = ['plain', 'passing', 'lively'];
export const KINDS = ['passing', 'skip', 'neighbour', 'run', 'turn'];

function isPerfect(iv) { const m = ((iv % 12) + 12) % 12; return m === 0 || m === 7; }
function parallel(p, c, i, j) {
  if (p[i] === c[i] || p[j] === c[j]) return false;
  const iv1 = p[j] - p[i], iv2 = c[j] - c[i];
  return isPerfect(iv1) && isPerfect(iv2) && ((iv1 % 12) + 12) % 12 === ((iv2 % 12) + 12) % 12;
}
function anyParallel(p, c) {
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) if (parallel(p, c, i, j)) return true;
  return false;
}

/** Whether a pitch belongs to the key's major scale. */
export function diatonic(midi, keyName) {
  return SCALE.includes((((midi - KEYS[keyName].tonic) % 12) + 12) % 12);
}
function between(a, b, keyName) {
  const out = [];
  for (let m = Math.min(a, b) + 1; m < Math.max(a, b); m++) if (diatonic(m, keyName)) out.push(m);
  return out;
}
/** The next scale note from `m` in direction `dir` (+1 up, -1 down). */
function scaleStep(m, dir, keyName) { return diatonic(m + dir, keyName) ? m + dir : m + 2 * dir; }

/** The pitch a voice's line sounds at quaver `u` of the chord. */
export function noteAt(line, u) {
  let acc = 0;
  for (const [midi, units] of line) { acc += units; if (u < acc) return midi; }
  return line[line.length - 1][0];
}
/** The four voicings a chord's lines pass through, one per quaver. */
export function statesOf(lines) {
  const out = [];
  for (let u = 0; u < UNITS; u++) out.push(lines.map((line) => noteAt(line, u)));
  return out;
}
const plainLines = (v) => v.map((m) => [[m, UNITS]]);

/** The figure one voice could take between `cur` and `nxt`, or null. */
function figureFor(i, cur, nxt, chord, keyName, level, ctx) {
  const d = nxt - cur, ad = Math.abs(d), dir = Math.sign(d);
  const usable = (m) => { const t = chord.toneOf(m % 12); return t && t.alt === 0 && m % 12 !== ctx.leadingPc && !(chord.seventh && m % 12 === chord.seventh.pc); };
  if ((ad === 3 || ad === 4) && !ctx.chromatic) {
    const mid = between(cur, nxt, keyName);
    return mid.length === 1 ? { notes: [[cur, 2], [mid[0], 2]], kind: 'passing' } : null;
  }
  if (ad >= 5 && ad <= 9) {
    if (level === 'lively' && (ad === 5 || ad === 7) && !ctx.chromatic) {
      const x2 = scaleStep(nxt, -dir, keyName), x1 = scaleStep(x2, -dir, keyName);
      const inside = (m) => (m - cur) * dir > 0 && (nxt - m) * dir > 0;
      if (inside(x1) && inside(x2) && (Math.abs(x1 - cur) <= 2 || usable(x1))) return { notes: [[cur, 2], [x1, 1], [x2, 1]], kind: 'run' };
    }
    const tones = [];
    for (let m = Math.min(cur, nxt) + 1; m < Math.max(cur, nxt); m++) if (usable(m)) tones.push(m);
    return tones.length ? { notes: [[cur, 2], [d > 0 ? tones[tones.length - 1] : tones[0], 2]], kind: 'skip' } : null;   // the tone nearest where it goes
  }
  if (d === 0 && !ctx.chromatic && ctx.k !== ctx.lastNeighbourAt[i] + 1) {
    const up = scaleStep(cur, 1, keyName), down = scaleStep(cur, -1, keyName);
    if (i === 3) {
      const goUp = !ctx.lastNeighbourUp && up <= RANGES.S[1];
      if (level === 'lively') return { notes: [[cur, 2], [goUp ? up : down, 1], [goUp ? down : up, 1]], kind: 'turn' };
      return { notes: [[cur, 2], [goUp ? up : down, 2]], kind: 'neighbour' };
    }
    if (level === 'lively' && (i === 1 || i === 2)) return { notes: [[cur, 2], [down, 1], [cur, 1]], kind: 'neighbour' };   // an inner voice dips and returns
  }
  return null;
}

/** Whether the lines, as a whole, obey range, order, no-unison and no-parallel rules through to `nxt`. */
function acceptable(lines, skeleton, nxt) {
  const states = statesOf(lines);
  for (const st of states) {
    for (let v = 0; v < 4; v++) {
      const moved = st[v] !== skeleton[v];
      const [lo, hi] = RANGES[NAMES[v]];
      if (moved && (st[v] < lo || st[v] > hi)) return false;
      if (v < 3 && st[v] > st[v + 1]) return false;                                          // no crossing
      if (v < 3 && st[v] === st[v + 1] && (moved || st[v + 1] !== skeleton[v + 1])) return false;   // no unison with an added note
    }
  }
  const chain = [...states, nxt];
  for (let u = 1; u < chain.length; u++) if (anyParallel(chain[u - 1], chain[u])) return false;
  return true;
}

/**
 * `voicings` are [b, t, a, s] per chord, `chords` the realized chords they voice. Returns
 * { lines, kinds }: lines[k] holds four lines of [pitch, quavers], kinds[k] names what each
 * voice took ('passing' | 'skip' | 'neighbour' | 'run' | 'turn' | null) or is null when the
 * chord is plain.
 */
export function elaborate(voicings, chords, keyName, level = 'passing') {
  if (!LEVELS.includes(level)) throw new RangeError(`unknown motion level ${level}`);
  const tonicPc = KEYS[keyName].tonic % 12;
  const ctx = { leadingPc: (tonicPc + 11) % 12, lastNeighbourAt: [-2, -2, -2, -2], lastNeighbourUp: false, chromatic: false, k: 0 };
  const lines = [], kinds = [];
  voicings.forEach((cur, k) => {
    const nxt = voicings[k + 1];
    if (level === 'plain' || !nxt || k === 7) { lines.push(plainLines(cur)); kinds.push(null); return; }
    const chord = chords[k];
    ctx.k = k; ctx.chromatic = chord.tones.some((t) => t.alt !== 0);
    const trial = plainLines(cur);
    const kind = [null, null, null, null];
    let moving = 0;
    for (const i of ORDER) {
      if (moving >= MAX_MOVING[level]) break;
      const fig = figureFor(i, cur[i], nxt[i], chord, keyName, level, ctx);
      if (!fig) continue;
      const attempt = trial.map((l, v) => (v === i ? fig.notes : l));
      if (!acceptable(attempt, cur, nxt)) continue;
      trial[i] = fig.notes; kind[i] = fig.kind; moving++;
      if (fig.kind === 'neighbour' || fig.kind === 'turn') { ctx.lastNeighbourAt[i] = k; if (i === 3) ctx.lastNeighbourUp = fig.notes[1][0] > cur[i]; }
    }
    lines.push(trial); kinds.push(moving ? kind : null);
  });
  return { lines, kinds };
}
