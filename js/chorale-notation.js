// Spelling for the chorale's notation: a pitch is written from the scale degree it stands
// for in the key (so the raised fourth of V/V is a sharp, the lowered sixth of iv a flat),
// with accidentals carried through the bar as engraving does.
import { keyAccidental, degreeLetter, KEYS, DEGREE_SEMITONES } from './chorale-harmony.js?v=dev';

const ACC = { '-2': '__', '-1': '_', 0: '=', 1: '^', 2: '^^' };

/** The chord tone a pitch stands for, or for an added diatonic note its scale degree. */
export function toneFor(midi, chord, keyName) {
  const t = chord.toneOf(midi % 12);
  if (t) return t;
  const rel = (((midi - KEYS[keyName].tonic) % 12) + 12) % 12;
  for (const [deg, semi] of Object.entries(DEGREE_SEMITONES)) if (semi === rel) return { deg: Number(deg), alt: 0 };
  throw new RangeError(`pitch ${midi} is neither a chord tone nor diatonic in ${keyName}`);
}

/** Spell one note as ABC given its (degree, alteration) and the key; `state` holds the bar's accidentals. */
export function spell(midi, tone, keyName, state) {
  const letter = degreeLetter(keyName, tone.deg);
  const total = keyAccidental(keyName, letter) + tone.alt;           // the note's actual accidental
  const natural = midi - total;                                       // the unaltered letter's pitch
  const octave = Math.floor(natural / 12) - 1;
  let name = octave >= 5 ? letter.toLowerCase() : letter;
  if (octave >= 6) name += "'".repeat(octave - 5);
  if (octave <= 3) name += ','.repeat(4 - octave);
  const slot = `${letter}${octave}`;
  const current = state.has(slot) ? state.get(slot) : keyAccidental(keyName, letter);
  let acc = '';
  if (total !== current) { acc = ACC[total]; state.set(slot, total); }
  return acc + name;
}

/** Interleave per-voice ABC lines: every voice's first line, then every voice's second, and so on. */
export function interleave(voiceLines) {
  const out = [];
  const n = Math.max(...voiceLines.map((l) => l.length));
  for (let i = 0; i < n; i++) for (const lines of voiceLines) if (lines[i]) out.push(lines[i]);
  return out;
}
