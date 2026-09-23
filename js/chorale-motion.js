// Melodic elaboration of a voiced chorale. Between one chord and the next, a voice that moves
// by a third takes the diatonic passing tone between; one that leaps a fourth to a sixth takes
// the chord tone it skips over; a soprano that would repeat its note takes its upper
// neighbour. Each added note falls on the second half of the chord, unaccented, and is kept
// only where it makes no parallel fifths or octaves (against the chord it leaves and the one
// it goes to), no crossing and no unison with a neighbouring voice. Over a chromatic chord
// (a secondary dominant, the borrowed iv) only chord tones are added, so no passing tone
// clashes with the altered note. The chords and the voice leading between them are not
// touched: the skeleton the engine chose is still what the ear follows. Deterministic.
import { KEYS } from './chorale-harmony.js?v=dev';
import { RANGES } from './chorale-voicing.js?v=dev';

const NAMES = ['B', 'T', 'A', 'S'];
const SCALE = [0, 2, 4, 5, 7, 9, 11];
const ORDER = [3, 0, 1, 2];          // soprano first, then bass, then the inner voices
export const MAX_MOVING = 2;         // at most two voices take an added note in the same half
export const KINDS = ['passing', 'skip', 'neighbour'];

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
function neighbourAbove(m, keyName) { return diatonic(m + 1, keyName) ? m + 1 : m + 2; }
function neighbourBelow(m, keyName) { return diatonic(m - 1, keyName) ? m - 1 : m - 2; }

/**
 * `voicings` are [b, t, a, s] per chord, `chords` the realized chords they voice. Returns
 * { cells, kinds }: cells[k] is [voicing] for a plain chord or [voicing, second] where
 * `second` is the voicing for the chord's second half; kinds[k] names what each voice took
 * ('passing' | 'skip' | 'neighbour' | null), or is null for a plain chord. Position 8 (the
 * half cadence, held) and the last chord are never elaborated.
 */
export function elaborate(voicings, chords, keyName) {
  const tonicPc = KEYS[keyName].tonic % 12;
  const leadingPc = (tonicPc + 11) % 12;
  const cells = [], kinds = [];
  let lastNeighbourAt = -2, lastNeighbourUp = false;   // neighbours skip a chord and alternate direction
  voicings.forEach((cur, k) => {
    const nxt = voicings[k + 1];
    if (!nxt || k === 7) { cells.push([cur]); kinds.push(null); return; }
    const chord = chords[k];
    const chromatic = chord.tones.some((t) => t.alt !== 0);
    const cell = cur.slice();
    const kind = [null, null, null, null];
    let moving = 0;
    for (const i of ORDER) {
      if (moving >= MAX_MOVING) break;
      const d = nxt[i] - cur[i], ad = Math.abs(d);
      let x = null, what = null;
      if ((ad === 3 || ad === 4) && !chromatic) {
        const mid = between(cur[i], nxt[i], keyName);
        if (mid.length === 1) { x = mid[0]; what = 'passing'; }
      } else if (ad >= 5 && ad <= 9) {
        const tones = [];
        for (let m = Math.min(cur[i], nxt[i]) + 1; m < Math.max(cur[i], nxt[i]); m++) {
          const t = chord.toneOf(m % 12);
          if (!t || t.alt !== 0 || m % 12 === leadingPc) continue;
          if (chord.seventh && m % 12 === chord.seventh.pc) continue;
          tones.push(m);
        }
        if (tones.length) { x = d > 0 ? tones[tones.length - 1] : tones[0]; what = 'skip'; }   // the tone nearest where it goes
      } else if (d === 0 && i === 3 && !chromatic && k !== lastNeighbourAt + 1) {
        const up = neighbourAbove(cur[i], keyName), down = neighbourBelow(cur[i], keyName);
        x = !lastNeighbourUp && up <= RANGES.S[1] ? up : down;
        what = 'neighbour';
      }
      if (x === null) continue;
      const [lo, hi] = RANGES[NAMES[i]];
      if (x < lo || x > hi) continue;
      if (i > 0 && x <= cell[i - 1]) continue;                    // no crossing, no unison below
      if (i < 3 && x >= cell[i + 1]) continue;                    // nor above
      const trial = cell.slice(); trial[i] = x;
      if (anyParallel(cur, trial) || anyParallel(trial, nxt)) continue;
      cell[i] = x; kind[i] = what; moving++;
      if (what === 'neighbour') { lastNeighbourAt = k; lastNeighbourUp = x > cur[i]; }
    }
    if (moving) { cells.push([cur, cell]); kinds.push(kind); } else { cells.push([cur]); kinds.push(null); }
  });
  return { cells, kinds };
}
