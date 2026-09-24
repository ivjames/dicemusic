// Typesetting: turn the composed minuet into ABC notation for abcjs to engrave.
// The note data is the same MEASURES table the synthesiser plays from, so what is
// drawn is exactly what is heard.
import { MEASURES, UNITS_PER_BAR } from './score.js?v=dev';

const LETTERS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

/** ABC pitch for a MIDI note, spelled with sharps (the score uses only F# and C#). */
export function pitchName(midi) {
  const octave = Math.floor(midi / 12) - 1;          // MIDI 60 = C4
  const letter = LETTERS[midi % 12];
  let name = octave >= 5 ? letter.toLowerCase() : letter;
  if (octave >= 6) name += "'".repeat(octave - 5);
  if (octave <= 3) name += ','.repeat(4 - octave);
  return { name, letter: letter + octave, sharp: SHARP[midi % 12] };
}

/** Length suffix for a duration in 32nds when L:1/16. */
function len(units) {
  if (units === 2) return '';
  if (units === 1) return '/';
  if (units % 2 === 0) return String(units / 2);
  return `${units}/2`;
}

/**
 * One voice of one measure as ABC. Accidentals follow ABC's rule that a written
 * accidental holds for that letter and octave until the bar line, so a sharp is
 * written on first use and a natural when the same note returns unsharpened.
 */
export function voiceToAbc(notes, staff) {
  const own = notes.filter((n) => n[3] === staff);
  const byOnset = new Map();
  for (const n of own) {
    if (!byOnset.has(n[0])) byOnset.set(n[0], []);
    byOnset.get(n[0]).push(n);
  }
  const onsets = [...byOnset.keys()].sort((a, b) => a - b);
  const state = new Map();            // letter+octave -> currently sharp?
  const out = [];
  let t = 0;
  const emitRest = (units) => { while (units > 0) { const u = units >= 8 ? 8 : units >= 4 ? 4 : units >= 2 ? 2 : 1; out.push(`z${len(u)}`); units -= u; } };
  const noteText = (n) => {
    const p = pitchName(n[2]);
    const was = state.get(p.letter) || false;
    let acc = '';
    if (p.sharp && !was) acc = '^';
    if (!p.sharp && was) acc = '=';
    state.set(p.letter, p.sharp);
    const orn = n[4] === 'trill' ? '!trill!' : n[4] === 'turn' ? '!turn!' : '';
    return `${orn}${acc}${p.name}`;
  };
  for (const onset of onsets) {
    if (onset > t) { emitRest(onset - t); t = onset; }
    const chord = byOnset.get(onset);
    const dur = Math.max(...chord.map((n) => n[1]));
    if (chord.length === 1) {
      out.push(noteText(chord[0]) + len(dur));
    } else {
      const inner = chord.sort((a, b) => b[2] - a[2]).map((n) => noteText(n)).join('');
      out.push(`[${inner}]${len(dur)}`);
    }
    t = onset + dur;
  }
  if (t < UNITS_PER_BAR) emitRest(UNITS_PER_BAR - t);
  return out.join('');
}

function measureNotes(id, ending) {
  const m = MEASURES[id];
  if (!m) throw new RangeError(`no measure ${id}`);
  return m.notes || (ending === 'first' ? m.first : m.second);
}

/**
 * The whole minuet as an ABC tune: two staves, the printed repeat of the first half
 * with both endings of bar 8 under a volta bracket, and the second half once.
 * `measures` is the 16 measure numbers in bar order. The lines are cut every
 * `barsPerLine` bars (the print's own eight by default), bar 8 with both its endings
 * counting as one, so the page can lay its cards out to the same lines.
 */
export function minuetToAbc(measures, { title = '', barsPerLine = 8 } = {}) {
  if (!Array.isArray(measures) || measures.length !== 16) throw new RangeError('need 16 measures');
  if (!Number.isInteger(barsPerLine) || barsPerLine < 1) throw new RangeError('barsPerLine must be a positive integer');
  const bar = (staff, id, ending) => voiceToAbc(measureNotes(id, ending), staff);
  const segment = (staff, b) => {
    if (b === 7) return '[1 ' + bar(staff, measures[7], 'first') + ' :|[2 ' + bar(staff, measures[7], 'second') + ' |]';
    return bar(staff, measures[b]) + (b === 15 ? ' |]' : ' |');
  };
  const lines = [];
  for (let start = 0; start < 16; start += barsPerLine) {
    for (const staff of [1, 0]) {
      let s = staff === 1 ? '[V:1] ' : '[V:2] ';
      if (start === 0) s += '|: ';
      for (let b = start; b < Math.min(16, start + barsPerLine); b++) s += segment(staff, b) + ' ';
      lines.push(s.trimEnd());
    }
  }
  return [
    'X:1',
    `T:${title}`,
    'M:3/8',
    'L:1/16',
    'Q:1/8=116',
    '%%score {1 2}',
    'V:1 clef=treble',
    'V:2 clef=bass',
    'K:C',
    ...lines,
  ].join('\n') + '\n';
}

/**
 * Which measure of the engraved score (abcjs's absolute measure index, class abcjs-mm<n>)
 * a playback step falls in: bars 1–7 are measures 0–6, bar 8's two endings are 7 and 8,
 * bars 9–16 are 9–16.
 */
export function scoreMeasureIndex(step) {
  if (!step) return -1;
  if (step.bar < 7) return step.bar;
  if (step.bar === 7) return step.ending === 'first' ? 7 : 8;
  return step.bar + 1;
}
