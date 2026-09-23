// The chorale dice game's harmony: seven major keys, a chord vocabulary in scale degrees,
// and a 16-position table (dice total 2–12 × position) built so that whatever the dice do,
// the eight bars fall into two four-bar phrases, the first closing on a half cadence, the
// second on a perfect authentic cadence. Positions 8 and 16 are fixed, like bars 8 and 16
// of the minuet; elsewhere the likelier totals carry the plainer chords and the rare ones
// (2 and 12) the colour: a deceptive vi, a borrowed iv, a secondary dominant.

export const KEYS = {
  C:  { tonic: 60, letter: 'C', sig: 0 },
  G:  { tonic: 67, letter: 'G', sig: 1 },
  D:  { tonic: 62, letter: 'D', sig: 2 },
  A:  { tonic: 57, letter: 'A', sig: 3 },
  F:  { tonic: 65, letter: 'F', sig: -1 },
  Bb: { tonic: 58, letter: 'B', sig: -2 },
  Eb: { tonic: 63, letter: 'E', sig: -3 },
};
export const KEY_NAMES = Object.keys(KEYS);
export const DEGREE_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11 };
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Accidental (−1, 0, +1) the key signature puts on a letter. */
export function keyAccidental(keyName, letter) {
  const sig = KEYS[keyName].sig;
  if (sig > 0) return SHARP_ORDER.slice(0, sig).includes(letter) ? 1 : 0;
  if (sig < 0) return FLAT_ORDER.slice(0, -sig).includes(letter) ? -1 : 0;
  return 0;
}

/** Letter of a scale degree in a key. */
export function degreeLetter(keyName, degree) {
  const i = LETTERS.indexOf(KEYS[keyName].letter);
  return LETTERS[(i + degree - 1) % 7];
}

// tones: [degree, alteration]; the first tone is the root, a fourth tone is the seventh.
const T = (d, a = 0) => [d, a];
export const CHORDS = {
  I:     { tones: [T(1), T(3), T(5)], bass: 1, label: 'I',     html: 'I',                       fn: 'tonic' },
  I6:    { tones: [T(1), T(3), T(5)], bass: 3, label: 'I6',    html: 'I<sup>6</sup>',           fn: 'tonic' },
  I64:   { tones: [T(1), T(3), T(5)], bass: 5, label: 'I6/4',  html: 'I<sup>6</sup><sub>4</sub>', fn: 'cadential six-four', cadential64: true },
  ii:    { tones: [T(2), T(4), T(6)], bass: 2, label: 'ii',    html: 'ii',                      fn: 'predominant' },
  ii6:   { tones: [T(2), T(4), T(6)], bass: 4, label: 'ii6',   html: 'ii<sup>6</sup>',          fn: 'predominant' },
  ii7:   { tones: [T(2), T(4), T(6), T(1)], bass: 2, label: 'ii7', html: 'ii<sup>7</sup>',      fn: 'predominant' },
  ii65:  { tones: [T(2), T(4), T(6), T(1)], bass: 4, label: 'ii6/5', html: 'ii<sup>6</sup><sub>5</sub>', fn: 'predominant' },
  iii:   { tones: [T(3), T(5), T(7)], bass: 3, label: 'iii',   html: 'iii',                     fn: 'tonic' },
  IV:    { tones: [T(4), T(6), T(1)], bass: 4, label: 'IV',    html: 'IV',                      fn: 'predominant' },
  IV6:   { tones: [T(4), T(6), T(1)], bass: 6, label: 'IV6',   html: 'IV<sup>6</sup>',          fn: 'predominant' },
  iv:    { tones: [T(4), T(6, -1), T(1)], bass: 4, label: 'iv', html: 'iv',                     fn: 'borrowed predominant' },
  V:     { tones: [T(5), T(7), T(2)], bass: 5, label: 'V',     html: 'V',                       fn: 'dominant' },
  V6:    { tones: [T(5), T(7), T(2)], bass: 7, label: 'V6',    html: 'V<sup>6</sup>',           fn: 'dominant' },
  V7:    { tones: [T(5), T(7), T(2), T(4)], bass: 5, label: 'V7', html: 'V<sup>7</sup>',        fn: 'dominant' },
  V65:   { tones: [T(5), T(7), T(2), T(4)], bass: 7, label: 'V6/5', html: 'V<sup>6</sup><sub>5</sub>', fn: 'dominant' },
  V43:   { tones: [T(5), T(7), T(2), T(4)], bass: 2, label: 'V4/3', html: 'V<sup>4</sup><sub>3</sub>', fn: 'dominant' },
  vi:    { tones: [T(6), T(1), T(3)], bass: 6, label: 'vi',    html: 'vi',                      fn: 'tonic substitute' },
  viio6: { tones: [T(7), T(2), T(4)], bass: 2, label: 'vii°6', html: 'vii<sup>°6</sup>',        fn: 'dominant' },
  VofV:  { tones: [T(2), T(4, 1), T(6)], bass: 2, label: 'V/V', html: 'V/V',                    fn: 'secondary dominant' },
  V7ofV: { tones: [T(2), T(4, 1), T(6), T(1)], bass: 2, label: 'V7/V', html: 'V<sup>7</sup>/V', fn: 'secondary dominant' },
};

// Position (1–16) × dice total (2–12). Phrase 1 = positions 1–8, phrase 2 = 9–16.
// Each column keeps to one harmonic function, so any roll gives T–(D or PD)–T–(D or PD)–T–PD–PD–D
// in the first phrase and the same shape closing V(7)–I in the second.
export const CHORALE_TABLE = {
  1:  ['vi', 'I', 'I6', 'I', 'I', 'I', 'I', 'I6', 'I', 'I', 'I6'],
  2:  ['viio6', 'V43', 'ii6', 'V6', 'IV', 'V6', 'V43', 'IV', 'ii6', 'V65', 'viio6'],
  3:  ['iii', 'I6', 'vi', 'I', 'I', 'I', 'I6', 'I', 'vi', 'I6', 'iii'],
  4:  ['ii7', 'V43', 'IV', 'ii6', 'V6', 'IV', 'ii6', 'V6', 'ii', 'V43', 'IV6'],
  5:  ['vi', 'I6', 'I', 'I6', 'I', 'I', 'I', 'I6', 'I', 'vi', 'iii'],
  6:  ['iv', 'ii', 'IV6', 'IV', 'ii6', 'IV', 'IV', 'ii6', 'ii6', 'IV6', 'iv'],
  7:  ['V7ofV', 'I64', 'ii', 'ii6', 'IV', 'ii6', 'I64', 'IV', 'ii65', 'VofV', 'I64'],
  8:  ['V', 'V', 'V', 'V', 'V', 'V', 'V', 'V', 'V', 'V', 'V'],
  9:  ['vi', 'I', 'I6', 'I', 'I', 'I', 'I', 'I', 'I6', 'vi', 'I6'],
  10: ['viio6', 'V65', 'IV', 'ii6', 'V6', 'IV', 'V43', 'V6', 'ii6', 'V65', 'viio6'],
  11: ['iii', 'I6', 'vi', 'I', 'I', 'I', 'I6', 'I', 'I6', 'vi', 'iii'],
  12: ['ii7', 'IV6', 'ii6', 'V43', 'IV', 'ii6', 'V6', 'IV', 'ii', 'V43', 'IV6'],
  13: ['vi', 'I6', 'I', 'I', 'I6', 'I', 'I', 'I6', 'I', 'vi', 'I6'],
  14: ['iv', 'ii', 'IV6', 'ii6', 'IV', 'IV', 'ii6', 'IV', 'ii65', 'ii6', 'iv'],
  15: ['V7', 'V', 'V7', 'V', 'V7', 'V7', 'V7', 'V', 'V7', 'V', 'V7'],
  16: ['I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I', 'I'],
};

/** Chord symbol for a position (0-based) and a dice total (2..12). */
export function chordFor(position, sum) {
  const row = CHORALE_TABLE[position + 1];
  if (!row) throw new RangeError(`position out of range: ${position}`);
  if (!Number.isInteger(sum) || sum < 2 || sum > 12) throw new RangeError(`dice total out of range: ${sum}`);
  return row[sum - 2];
}

/** Pitch class (0–11) of a chord tone [degree, alt] in a key. */
export function tonePc(keyName, tone) {
  return (KEYS[keyName].tonic + DEGREE_SEMITONES[tone[0]] + tone[1] + 120) % 12;
}
